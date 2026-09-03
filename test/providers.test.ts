import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  BUILTIN_ZEN,
  LOCAL_FLAVOR_LABELS,
  assembleModels,
  catalogEntries,
  formatModelRef,
  isLocalCatalogEntry,
  isUsable,
  knownLocalServers,
  parseModelRef,
  pickModelRef,
  searchCatalog,
  slugifyProviderId,
  unusableReason,
  type LocalModelShape,
  type ProviderConnection,
  type ProviderShape,
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

test('catalogEntries carries the published base URL through', () => {
  const entries = catalogEntries({
    lmstudio: { id: 'lmstudio', name: 'LMStudio', api: 'http://127.0.0.1:1234/v1', models: {} },
  });
  assert.equal(entries[0].api, 'http://127.0.0.1:1234/v1');
});

// The real catalog ships four loopback "providers" (lmstudio, atomic-chat,
// lynkr, privatemode-ai). Each is a local server, and offering it an API-key
// prompt asks for a credential that does not exist and gives no way to say
// where the server actually lives.
test('isLocalCatalogEntry spots a loopback provider in any of its forms', () => {
  assert.equal(isLocalCatalogEntry({ api: 'http://127.0.0.1:1234/v1' }), true); // LMStudio
  assert.equal(isLocalCatalogEntry({ api: 'http://localhost:8080/v1' }), true); // Privatemode AI
  assert.equal(isLocalCatalogEntry({ api: 'http://127.0.0.2:9000' }), true); // all of 127/8
  assert.equal(isLocalCatalogEntry({ api: 'http://[::1]:1234/v1' }), true);
  assert.equal(isLocalCatalogEntry({ api: 'http://0.0.0.0:1234/v1' }), true);
});

test('isLocalCatalogEntry leaves genuine hosted providers alone', () => {
  // Ollama Cloud is a real metered API that shares a brand with a local
  // runtime — it must keep its key prompt.
  assert.equal(isLocalCatalogEntry({ api: 'https://ollama.com/v1' }), false);
  assert.equal(isLocalCatalogEntry({ api: 'https://api.anthropic.com/v1' }), false);
  // A hostname merely containing "localhost" is not loopback.
  assert.equal(isLocalCatalogEntry({ api: 'https://notlocalhost.com/v1' }), false);
  assert.equal(isLocalCatalogEntry({ api: 'not a url' }), false);
  assert.equal(isLocalCatalogEntry({ api: '' }), false);
  assert.equal(isLocalCatalogEntry({}), false);
  assert.equal(isLocalCatalogEntry(undefined), false);
});

const LOCAL_RAW = {
  lmstudio: { id: 'lmstudio', name: 'LMStudio', api: 'http://127.0.0.1:1234/v1', models: {} },
  lynkr: { id: 'lynkr', name: 'Lynkr', api: 'http://127.0.0.1:8081/v1', models: {} },
  'ollama-cloud': { id: 'ollama-cloud', name: 'Ollama Cloud', api: 'https://ollama.com/v1', models: {} },
};

// An empty query is the panel's default view, and it shares a bounded list with
// the keyed providers — so it stays a curated head rather than every runtime
// models.dev happens to carry.
test('knownLocalServers offers only the probe targets by default', () => {
  const opts = knownLocalServers(catalogEntries(LOCAL_RAW));
  assert.deepEqual(opts.map((o) => o.name), ['LM Studio', 'Ollama', 'vLLM']);
  // Ollama exists ONLY as a probe target — the catalog's only Ollama entry is
  // the hosted API, which must never leak into the local list.
  assert.equal(opts.find((o) => o.name === 'Ollama')!.url, 'http://127.0.0.1:11434/v1');
  assert.deepEqual(knownLocalServers([]).map((o) => o.name), ['LM Studio', 'Ollama', 'vLLM']);
});

test('a query reaches the catalog runtimes behind the curated head', () => {
  const entries = catalogEntries(LOCAL_RAW);
  assert.deepEqual(knownLocalServers(entries, 'lynkr').map((o) => o.name), ['Lynkr']);
  assert.equal(knownLocalServers(entries, 'lynkr')[0].url, 'http://127.0.0.1:8081/v1');
  assert.deepEqual(knownLocalServers(entries, 'anthropic'), []);
});

test('knownLocalServers matches a query across the spelling difference', () => {
  const entries = catalogEntries(LOCAL_RAW);
  // "lmstudio" typed with no space still finds "LM Studio", and vice versa —
  // punctuation is stripped from both sides before comparing. One row, not two:
  // the probe target absorbs the catalog's "LMStudio" and keeps its own port.
  const oneWord = knownLocalServers(entries, 'lmstudio');
  assert.deepEqual(oneWord.map((o) => o.name), ['LM Studio']);
  assert.equal(oneWord[0].url, 'http://127.0.0.1:1234/v1');
  assert.deepEqual(knownLocalServers(entries, 'lm studio').map((o) => o.name), ['LM Studio']);
  assert.deepEqual(knownLocalServers(entries, 'oll').map((o) => o.name), ['Ollama']);
  // Substring semantics, matching how searchCatalog treats the cloud list: a
  // bare "lm" is inside "vllm" too. Harmless on a list this short, and the
  // alternative — dropping vLLM for someone typing "llm" — is worse.
  assert.deepEqual(knownLocalServers(entries, 'lm').map((o) => o.name), ['LM Studio', 'vLLM']);
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

// ---- assembleModels --------------------------------------------------------
// The merge from a server response + local metadata into picker rows. The
// fixture is a REAL `GET /config/providers` response captured from OpenCode
// 1.18.4 (one catalog model, one local model), so the shape being parsed is the
// shape the server actually sends rather than one inferred from docs.

// Read from the repo root (where `npm test` runs) rather than the bundle's
// location: the suite is bundled to out-test/, the fixture stays with the test.
const REAL: ProviderShape[] = JSON.parse(
  readFileSync('test/fixtures-providers.json', 'utf8'),
);

const CONNS: ProviderConnection[] = [
  { id: 'c1', kind: 'catalog', providerID: 'anthropic', name: 'Anthropic', hasApiKey: true },
  { id: 'l1', kind: 'local', providerID: 'lm-studio', name: 'My LM Studio', flavor: 'lmstudio' },
];

test('a catalog model maps its capabilities, price, limit and declared variants', () => {
  const [model] = assembleModels([REAL[0]], CONNS);
  assert.equal(model.id, 'anthropic/claude-sonnet-4-6');
  assert.equal(model.modelID, 'claude-sonnet-4-6');
  assert.equal(model.name, 'Claude Sonnet 4.6');
  assert.equal(model.providerName, 'Anthropic'); // the user's own label for it
  assert.equal(model.maxContextLength, 1_000_000);
  assert.deepEqual(model.cost, { input: 3, output: 15 });
  assert.equal(model.toolUse, true);
  assert.equal(model.vision, true);
  // The model's own variant names, marked declared so the picker offers them
  // verbatim instead of the table we inject for local endpoints.
  assert.deepEqual(model.reasoning, {
    allowedOptions: ['low', 'medium', 'high', 'max'],
    declared: true,
  });
  // A cloud model has no load lifecycle and no in-memory state to report.
  assert.equal(model.lifecycle, false);
  assert.equal(model.loaded, undefined);
});

test('a local model takes its live metadata from the endpoint, not the config', () => {
  const local: LocalModelShape = {
    id: 'qwen/qwen3-coder-30b',
    displayName: 'qwen3-coder-30b',
    state: 'loaded',
    loadedContextLength: 32768,
    maxContextLength: 262144,
    publisher: 'qwen',
    format: 'MLX',
    quantization: '8bit',
    reasoning: { allowedOptions: ['off', 'on'] },
  };
  const [model] = assembleModels(
    [REAL[1]],
    CONNS,
    new Map([['lm-studio/qwen/qwen3-coder-30b', local]]),
  );
  assert.equal(model.loaded, true);
  assert.equal(model.lifecycle, true, 'an LM Studio model can be loaded/ejected');
  assert.equal(model.contextLength, 32768, 'the window it is loaded with');
  assert.equal(model.maxContextLength, 262144, 'the endpoint knows the real max');
  assert.equal(model.quantization, '8bit');
  assert.equal(model.format, 'MLX');
  // NOT declared: the local variant table is ours, so granularity comes from
  // the endpoint's capability report.
  assert.deepEqual(model.reasoning, { allowedOptions: ['off', 'on'] });
  assert.equal(model.cost, undefined, 'a local model costs nothing per token');
});

test('a local model with no live metadata still lists, from the config alone', () => {
  // The endpoint was unreachable when the list was built: the model is still
  // offered (the config declared it), just without in-memory state.
  const [model] = assembleModels([REAL[1]], CONNS);
  assert.equal(model.id, 'lm-studio/qwen/qwen3-coder-30b');
  assert.equal(model.loaded, undefined);
  assert.equal(model.maxContextLength, 32768, 'falls back to the declared limit');
});

test('providers the registry does not know are dropped', () => {
  // OpenCode also picks providers up from ambient env vars (a stray
  // OPENAI_API_KEY). Those were never configured here, so offering their models
  // would put rows in the picker with no matching row in the Providers panel.
  assert.deepEqual(assembleModels(REAL, [CONNS[0]]).map((m) => m.providerID), ['anthropic']);
});

test('a disabled provider contributes nothing', () => {
  const off = CONNS.map((c) => (c.providerID === 'anthropic' ? { ...c, disabled: true } : c));
  assert.deepEqual(assembleModels(REAL, off).map((m) => m.providerID), ['lm-studio']);
});

test('rows are grouped by registry order, then by name', () => {
  const reversed = [REAL[1], REAL[0]]; // server order is not our order
  assert.deepEqual(assembleModels(reversed, CONNS).map((m) => m.providerID), [
    'anthropic',
    'lm-studio',
  ]);
});

// A local endpoint that reports real metadata (LM Studio's native catalog,
// oMLX's /v1/models/status) is the only source for vision and the served
// context window — the OpenAI-compatible /v1/models surface carries neither.
// These cover the path that made an oMLX-hosted VLM look text-only: the
// endpoint reported nothing, so `attachment` came out false and the picker
// showed the minContextLength fallback instead of the server's real limit.
test('a local model takes vision and context window from what the endpoint reported', () => {
  const local = new Map<string, LocalModelShape>([
    [
      'lm-studio/qwen/qwen3-coder-30b',
      { id: 'qwen/qwen3-coder-30b', displayName: 'qwen3-coder-30b', maxContextLength: 131_072, vision: true },
    ],
  ]);
  const [model] = assembleModels([REAL[1]], CONNS, local);
  assert.equal(model.vision, true);
  assert.equal(model.maxContextLength, 131_072);
});

// The load-bearing half of the fix. What a local endpoint reports must beat the
// declared capabilities, because those are *our own* synthesized config: we
// write `attachment: !!vision`, so an endpoint that reported nothing lands in
// the config as an explicit `false` (and `input.image: false`) rather than as
// unknown. Reading the config first would make that false permanent and no
// amount of endpoint metadata could correct it.
test('what the endpoint reports overrides a declared attachment:false', () => {
  assert.equal(REAL[1].models['qwen/qwen3-coder-30b'].capabilities?.attachment, false);
  const local = new Map<string, LocalModelShape>([
    [
      'lm-studio/qwen/qwen3-coder-30b',
      { id: 'qwen/qwen3-coder-30b', displayName: 'qwen3-coder-30b', vision: true },
    ],
  ]);
  assert.equal(assembleModels([REAL[1]], CONNS, local)[0].vision, true);
  // Without that override the config's own false stands, which is the bug an
  // oMLX-hosted VLM hit: multimodal model, image stripped before the request.
  assert.equal(assembleModels([REAL[1]], CONNS)[0].vision, false);
});

test('LOCAL_FLAVOR_LABELS names each real runtime and omits the generic flavor', () => {
  assert.equal(LOCAL_FLAVOR_LABELS.omlx, 'oMLX');
  assert.equal(LOCAL_FLAVOR_LABELS.vllm, 'vLLM');
  // Absent on purpose, so a known port whose fingerprint probe failed keeps the
  // probe row's own product name instead of being relabelled generically.
  assert.equal(LOCAL_FLAVOR_LABELS['openai-compatible'], undefined);
});
