import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeNewApiKey, resolveApiKeyEdit } from '../src/core/servers';

test('resolveApiKeyEdit keeps the stored key when the edit is undefined or blank', () => {
  assert.deepEqual(resolveApiKeyEdit(undefined), { kind: 'keep' });
  assert.deepEqual(resolveApiKeyEdit(''), { kind: 'keep' });
  assert.deepEqual(resolveApiKeyEdit('   '), { kind: 'keep' });
});

test('resolveApiKeyEdit removes only on an explicit null', () => {
  assert.deepEqual(resolveApiKeyEdit(null), { kind: 'remove' });
});

test('resolveApiKeyEdit sets a trimmed replacement key', () => {
  assert.deepEqual(resolveApiKeyEdit('sk-abc'), { kind: 'set', value: 'sk-abc' });
  assert.deepEqual(resolveApiKeyEdit('  sk-abc  '), { kind: 'set', value: 'sk-abc' });
});

test('normalizeNewApiKey treats blank input as no key', () => {
  assert.equal(normalizeNewApiKey(undefined), undefined);
  assert.equal(normalizeNewApiKey(''), undefined);
  assert.equal(normalizeNewApiKey('   '), undefined);
  assert.equal(normalizeNewApiKey(' sk-x '), 'sk-x');
});
