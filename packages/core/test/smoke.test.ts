import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAgent, createInMemoryStore, createMockProvider } from '../dist/index.js';

test('package exports the public surface', () => {
  assert.equal(typeof createAgent, 'function');
  assert.equal(typeof createInMemoryStore, 'function');
  assert.equal(typeof createMockProvider, 'function');
});
