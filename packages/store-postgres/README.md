# agent-runtime-postgres

Postgres `ConversationStore` for `agent-runtime-core`, layered over **your**
Prisma client — the adapter never owns a `PrismaClient`, a connection pool, or
a migration pipeline.

## Setup

1. Copy the two models from [`prisma/schema.prisma`](prisma/schema.prisma) into
   your application's schema (`simple_agent_messages` + `simple_agent_messages_llm`).
2. Run your usual migration (`prisma migrate dev` / your deploy flow).
3. Hand the adapter your generated client:

```ts
import { PrismaClient } from '@prisma/client';
import { createPostgresStore } from 'agent-runtime-postgres';

const prisma = new PrismaClient();
const store = createPostgresStore(prisma);
```

`SimpleAgentDb` is a structural interface over the two model delegates, so any
client generated from the reference models satisfies it.

## Guarantees

- `appendMessage` is idempotent on `(conversation_id, external_message_id)` —
  the unique index + a P2002 catch make concurrent duplicate deliveries
  converge on one row (race-tested).
- The trace table is append-only; only the `interrupted` flag is ever updated.

## Integration test

```bash
docker compose up -d
DATABASE_URL=postgresql://postgres:postgres@localhost:5439/simple_agent pnpm exec prisma db push
DATABASE_URL=postgresql://postgres:postgres@localhost:5439/simple_agent pnpm test
```

Without `DATABASE_URL` the integration test skips; a fake-delegate conformance
test (no DB) always runs.
