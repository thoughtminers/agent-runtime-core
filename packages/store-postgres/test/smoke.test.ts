import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresStore } from '../dist/index.js';

test('package exports the adapter', () => {
  assert.equal(typeof createPostgresStore, 'function');
});
