import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BUILTIN_ZEN,
  catalogEntries,
  formatModelRef,
  isUsable,
  parseModelRef,
  pickModelRef,
  searchCatalog,
  slugifyProviderId,
  unusableReason,
  type ProviderConnection,
} from '../src/core/providers';

const catalogConn = (over: Partial<ProviderConnection> = {}): ProviderConnection => ({
  id: 'c1',
  kind: 'catalog',
  providerID: 'anthropic',
  name: 'Anthropic',
  ...over,
});

const localConn = (over: Partial<ProviderConnection> = {}): ProviderConnection => ({
  id: 'l1',
  kind: 'local',
  providerID: 'lm-studio',
  name: 'LM Studio',
  baseUrl: 'http://127.0.0.1:1234/v1',
  flavor: 'lmstudio',
  ...over,
});

// ---- usability -------------------------------------------------------------

test('a catalog provider is unusable until it has a key', () => {
  assert.equal(isUsable(catalogConn()), false);
  assert.equal(unusableReason(catalogConn()), 'No API key');
  assert.equal(isUsable(catalogConn({ hasApiKey: true })), true);
  assert.equal(unusableReason(catalogConn({ hasApiKey: true })), null);
});

test('a local endpoint needs no key, and the builtin needs nothing at all', () => {
  // Reachability is polled separately — being unreachable does not make a
  // configured endpoint "unusable", it makes it offline.
  assert.equal(isUsable(localConn()), true);
  assert.equal(isUsable(BUILTIN_ZEN), true);
});

test('disabling beats every other reason', () => {
  assert.equal(isUsable(catalogConn({ hasApiKey: true, disabled: true })), false);
  assert.equal(unusableReason(localConn({ disabled: true })), 'Disabled');
});

// ---- local provider ids ----------------------------------------------------

test('slugifyProviderId makes a config-safe key from a display name', () => {
  assert.equal(slugifyProviderId('My Workstation'), 'my-workstation');
  assert.equal(slugifyProviderId('  vLLM (GPU box)!  '), 'vllm-gpu-box');
  assert.equal(slugifyProviderId(''), 'local');
});

test('slugifyProviderId never collides with a catalog provider', () => {
  // The load-bearing case: a local server named "OpenAI" must not become
  // provider.openai and silently overwrite the real provider's config.
  assert.equal(slugifyProviderId('OpenAI', ['openai', 'anthropic']), 'openai-local');
  assert.equal(slugifyProviderId('OpenAI', ['openai', 'openai-local']), 'openai-local-2');
});

// ---- catalog ---------------------------------------------------------------

const RAW = {
  anthropic: { id: 'anthropic', name: 'Anthropic', env: ['ANTHROPIC_API_KEY'], doc: 'https://x', models: { a: {}, b: {} } },
  cerebras: { id: 'cerebras', name: 'Cerebras (instant)', env: [], models: { c: {} } },
  antler: { id: 'antler', name: 'Antler', env: [], models: {} },
  openai: { id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'], models: { d: {} } },
};

test('catalogEntries normalizes and sorts by display name', () => {
  const entries = catalogEntries(RAW);
  assert.deepEqual(entries.map((e) => e.id), ['anthropic', 'antler', 'cerebras', 'openai']);
  const anthropic = entries.find((e) => e.id === 'anthropic')!;
  assert.equal(anthropic.modelCount, 2);
  assert.deepEqual(anthropic.env, ['ANTHROPIC_API_KEY']);
  assert.equal(anthropic.doc, 'https://x');
});

test('catalogEntries survives junk without throwing', () => {
  assert.deepEqual(catalogEntries(null), []);
  assert.deepEqual(catalogEntries({ bad: null as never, worse: 3 as never }), []);
  // A provider keyed without an inner id still resolves from its key.
  assert.equal(catalogEntries({ groq: { name: 'Groq' } })[0].id, 'groq');
});

test('an empty search returns the featured providers first', () => {
  const entries = catalogEntries(RAW);
  const ids = searchCatalog(entries, '').map((e) => e.id);
  assert.deepEqual(ids.slice(0, 2), ['anthropic', 'openai']); // featured order
  assert.ok(ids.includes('cerebras')); // the rest still follow
});

test('search ranks prefix matches above substring matches', () => {
  const entries = catalogEntries(RAW);
  const ids = searchCatalog(entries, 'ant').map((e) => e.id);
  // "Anthropic"/"Antler" start with the query; "Cerebras (instant)" merely
  // contains it, so it must come last.
  assert.deepEqual(ids, ['anthropic', 'antler', 'cerebras']);
});

test('search matches on id as well as name, and misses cleanly', () => {
  const entries = catalogEntries(RAW);
  assert.deepEqual(searchCatalog(entries, 'openai').map((e) => e.id), ['openai']);
  assert.deepEqual(searchCatalog(entries, 'zzz'), []);
});

// ---- model references ------------------------------------------------------

test('a model ref splits on the FIRST slash only', () => {
  // Model ids contain slashes ("qwen/qwen3-coder-30b"), so a naive split would
  // lose most of the id.
  assert.deepEqual(parseModelRef('lm-studio/qwen/qwen3-coder-30b'), {
    providerID: 'lm-studio',
    modelID: 'qwen/qwen3-coder-30b',
  });
  assert.deepEqual(parseModelRef('anthropic/claude-sonnet-4-6'), {
    providerID: 'anthropic',
    modelID: 'claude-sonnet-4-6',
  });
});

test('a bare model id parses as provider-less, so a hand-written setting still matches', () => {
  assert.deepEqual(parseModelRef('claude-sonnet-4-6'), { modelID: 'claude-sonnet-4-6' });
  assert.equal(parseModelRef(''), null);
  assert.equal(parseModelRef(null), null);
  // Degenerate forms are treated as bare ids rather than half a reference.
  assert.deepEqual(parseModelRef('/leading'), { modelID: '/leading' });
  assert.deepEqual(parseModelRef('trailing/'), { modelID: 'trailing/' });
});

test('formatModelRef round-trips through parseModelRef', () => {
  const ref = formatModelRef('lm-studio', 'qwen/qwen3-coder-30b');
  assert.equal(ref, 'lm-studio/qwen/qwen3-coder-30b');
  assert.deepEqual(parseModelRef(ref), { providerID: 'lm-studio', modelID: 'qwen/qwen3-coder-30b' });
});

// ---- model selection -------------------------------------------------------

const MODELS = [
  { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
  { providerID: 'openrouter', modelID: 'claude-sonnet-4-6' },
  { providerID: 'lm-studio', modelID: 'qwen3-coder-30b', loaded: false },
  { providerID: 'lm-studio', modelID: 'llama-3.3-70b', loaded: true },
];

test('a qualified preference picks that provider’s copy of a shared model', () => {
  assert.deepEqual(pickModelRef(['openrouter/claude-sonnet-4-6'], MODELS), {
    providerID: 'openrouter',
    modelID: 'claude-sonnet-4-6',
  });
});

test('an unqualified preference matches under whichever provider has it', () => {
  assert.deepEqual(pickModelRef(['claude-sonnet-4-6'], MODELS), {
    providerID: 'anthropic',
    modelID: 'claude-sonnet-4-6',
  });
});

test('preferences are tried in order and blanks are skipped', () => {
  assert.deepEqual(pickModelRef([null, '', 'nope/gone', 'lm-studio/qwen3-coder-30b'], MODELS), {
    providerID: 'lm-studio',
    modelID: 'qwen3-coder-30b',
  });
});

test('with no usable preference, a model already in memory beats cold-loading one', () => {
  assert.deepEqual(pickModelRef(['missing/model'], MODELS), {
    providerID: 'lm-studio',
    modelID: 'llama-3.3-70b',
  });
});

test('with nothing loaded it falls back to the first model, and to undefined when empty', () => {
  const cold = MODELS.map((m) => ({ ...m, loaded: false }));
  assert.deepEqual(pickModelRef([], cold), { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' });
  assert.equal(pickModelRef(['anything'], []), undefined);
});
