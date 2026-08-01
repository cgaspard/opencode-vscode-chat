import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clampContext,
  computeWindow,
  contextPresets,
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

test('computeWindow falls back to the configured window without model metadata', () => {
  assert.equal(computeWindow(undefined, 32768), 32768);
  assert.equal(computeWindow({}, 32768), 32768);
  assert.equal(computeWindow(undefined, 0), 0);
});
