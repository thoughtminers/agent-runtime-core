import { test } from 'node:test';
import { createInMemoryStore, runStoreConformance } from '../dist/index.js';

test('in-memory store passes the ConversationStore conformance suite', async () => {
  await runStoreConformance(createInMemoryStore());
});
