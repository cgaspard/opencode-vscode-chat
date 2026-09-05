import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clampContext,
  computeWindow,
  contextFromModelRow,
  contextPresets,
  declaredContext,
  formatTokens,
  isWindowManaged,
} from '../src/core/context';

test('clampContext never exceeds the model maximum', () => {
  assert.equal(clampContext(131072, 32768), 32768); // user asked for more than the model allows
  assert.equal(clampContext(8192, 32768), 8192); // under the max stays as-is
  assert.equal(clampContext(32768, 32768), 32768); // exactly the max
});

test('clampContext degrades gracefully when a value is missing/invalid', () => {
  assert.equal(clampContext(32768, undefined), 32768); // unknown max -> trust request
  assert.equal(clampContext(32768, 0), 32768); // zero max -> trust request
  assert.equal(clampContext(0, 32768), 32768); // no request -> use the cap
  assert.equal(clampContext(-5, 100), 100); // negative request -> use the cap
});

// The bug: a llama.cpp server started with `--ctx-size 262144` reported 32K,
// because it publishes neither of the two fields this ever read — its window
// lives under `meta.n_ctx`, and undefined let the minContextLength default
// stand in as if it had been detected.
test('contextFromModelRow reads each runtime\'s own spelling of the window', () => {
  assert.equal(contextFromModelRow({ max_model_len: 131072 }), 131072); // vLLM
  assert.equal(contextFromModelRow({ max_context_length: 65536 }), 65536); // oMLX
  assert.equal(
    contextFromModelRow({ id: 'qwen3.8-flash-next', meta: { n_ctx: 262144, n_ctx_train: 262144 } }),
    262144, // llama.cpp
  );
});

// n_ctx_train is the checkpoint's ceiling; n_ctx is what this process accepts.
// A server started well under the checkpoint's max must report the smaller one.
test('contextFromModelRow never reads n_ctx_train', () => {
  assert.equal(contextFromModelRow({ meta: { n_ctx: 32768, n_ctx_train: 262144 } }), 32768);
  assert.equal(contextFromModelRow({ meta: { n_ctx_train: 262144 } }), undefined);
});

test('contextFromModelRow reports undefined rather than inventing a window', () => {
  assert.equal(contextFromModelRow({ id: 'a' }), undefined);
  assert.equal(contextFromModelRow(undefined), undefined);
  assert.equal(contextFromModelRow({ max_model_len: 0 }), undefined);
  assert.equal(contextFromModelRow({ max_model_len: 'lots' as unknown as number }), undefined);
});

// llama.cpp slices n_ctx across --parallel N slots, so the process window
// overstates what one request gets. /props already divides it; prefer it.
test('contextFromModelRow prefers the per-slot window over the process window', () => {
  assert.equal(contextFromModelRow({ meta: { n_ctx: 262144 } }, 65536), 65536);
  // A slot value larger than the process window is nonsense — never inflate.
  assert.equal(contextFromModelRow({ meta: { n_ctx: 262144 } }, 1048576), 262144);
  // /props unavailable: the process window stands.
  assert.equal(contextFromModelRow({ meta: { n_ctx: 262144 } }, undefined), 262144);
  // A directly reported window is authoritative; no /props guesswork applies.
  assert.equal(contextFromModelRow({ max_model_len: 131072, meta: { n_ctx: 8192 } }, 4096), 131072);
});

// The other half of the 32K bug: reading meta.n_ctx is useless if the declared
// limit is then clamped back down to a global setting the user never touched.
test('declaredContext uses a fixed server window verbatim', () => {
  assert.equal(declaredContext(32768, 262144, false), 262144); // llama.cpp at 256K
  assert.equal(declaredContext(131072, 32768, false), 32768); // a genuinely small server
  // Nothing reported: the setting is the only estimate there is.
  assert.equal(declaredContext(32768, undefined, false), 32768);
});

test('declaredContext still honors the setting where the window is ours to name', () => {
  // LM Studio loads at what we ask, capped by the model.
  assert.equal(declaredContext(32768, 262144, true), 32768);
  assert.equal(declaredContext(262144, 32768, true), 32768);
});

test('contextPresets is filtered to the model max and always includes it', () => {
  assert.deepEqual(contextPresets(32768), [8192, 16384, 32768]);
  assert.deepEqual(contextPresets(131072), [8192, 16384, 32768, 65536, 131072]);
  assert.deepEqual(contextPresets(262144), [8192, 16384, 32768, 65536, 131072, 262144]);
});

test('contextPresets appends a non-standard max and de-dupes/sorts', () => {
  assert.deepEqual(contextPresets(40000), [8192, 16384, 32768, 40000]);
  assert.deepEqual(contextPresets(4096), [4096]); // smaller than every base preset
});

test('contextPresets assumes a generous default when the max is unknown', () => {
  assert.deepEqual(contextPresets(undefined), [8192, 16384, 32768, 65536, 131072]);
  assert.deepEqual(contextPresets(0), [8192, 16384, 32768, 65536, 131072]);
});

test('formatTokens uses 1024-base so 32768 reads as 32K (the old 33K bug)', () => {
  assert.equal(formatTokens(32768), '32K');
  assert.equal(formatTokens(65536), '64K');
  assert.equal(formatTokens(131072), '128K');
  assert.equal(formatTokens(262144), '256K');
  assert.equal(formatTokens(1048576), '1M');
  assert.equal(formatTokens(1572864), '1.5M');
  assert.equal(formatTokens(512), '512');
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(-5), '0');
});

// Only a local endpoint takes our window: minContextLength reaches a model
// solely via the declaration serverManager builds for a local provider (and LM
// Studio's load). Builtin/catalog models run the provider's own window.
test('isWindowManaged is true only for a local endpoint', () => {
  assert.equal(isWindowManaged({ providerKind: 'local' }), true);
  assert.equal(isWindowManaged({ providerKind: 'catalog' }), false);
  assert.equal(isWindowManaged({ providerKind: 'builtin' }), false);
  assert.equal(isWindowManaged({}), false); // unknown kind: assume not ours
  assert.equal(isWindowManaged(undefined), false);
});

// A llama.cpp/vLLM/oMLX process was started with its window and will not
// renegotiate: the setting is as inert there as it is for a cloud provider.
test('isWindowManaged is false for a local server that fixed its own window', () => {
  assert.equal(isWindowManaged({ providerKind: 'local', windowFixed: true }), false);
  // Reported nothing, so the setting is still the only window anyone named.
  assert.equal(isWindowManaged({ providerKind: 'local', windowFixed: false }), true);
});

test('computeWindow shows the loaded window when a model is loaded', () => {
  assert.equal(
    computeWindow({ contextLength: 8192, maxContextLength: 32768, providerKind: 'local' }, 131072),
    8192,
  );
});

test('computeWindow uses min(configured, model max) for a local model', () => {
  const local = 'local' as const;
  // capped by the model
  assert.equal(computeWindow({ maxContextLength: 32768, providerKind: local }, 131072), 32768);
  // capped by the setting
  assert.equal(computeWindow({ maxContextLength: 131072, providerKind: local }, 32768), 32768);
});

// The bug this guards: a 195K Zen model metered against a 32K setting we never
// send would show the bar full at 13k tokens.
test('computeWindow ignores the setting for a provider-managed model', () => {
  assert.equal(computeWindow({ maxContextLength: 199680, providerKind: 'builtin' }, 32768), 199680);
  assert.equal(computeWindow({ maxContextLength: 131072, providerKind: 'catalog' }, 8192), 131072);
  // Unknown kind is treated as provider-managed, not ours to shrink.
  assert.equal(computeWindow({ maxContextLength: 131072 }, 32768), 131072);
});

// The reported bug end to end: a llama.cpp server at 256K metered against the
// 32K minContextLength default showed "32K" and had OpenCode compact at 12%.
test('computeWindow ignores the setting for a local server with a fixed window', () => {
  assert.equal(
    computeWindow({ maxContextLength: 262144, providerKind: 'local', windowFixed: true }, 32768),
    262144,
  );
});

test('computeWindow falls back to the configured window without model metadata', () => {
  assert.equal(computeWindow(undefined, 32768), 32768);
  assert.equal(computeWindow({}, 32768), 32768);
  assert.equal(computeWindow(undefined, 0), 0);
});
