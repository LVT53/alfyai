# Database Layer

SQLite persistence with Drizzle ORM. Schema definitions and connection bootstrap only.

## Structure

| File | Purpose |
|------|---------|
| `schema.ts` | Table definitions: users, sessions, conversations, messages, artifacts, chunks, projects, task states, memory events, semantic embeddings |
| `index.ts` | Connection bootstrap - exports `db` instance |
| `write-lock.ts` | Connection policy: every transaction takes SQLite's write lock at BEGIN, so a read-then-write transaction waits for a second writer of the file (a script, a backup) instead of failing `database is locked`. Applied once in `index.ts`; a service passes no `behavior` |
| `compat.ts` | Narrow compatibility helpers for bounded DB repair/cleanup cases |

## Schema Overview

**Core Tables:**
- `users` - Accounts
- `sessions` - Cookie session storage
- `conversations` - Chat threads with optional project linking and durable sidebar pin/order state
- `messages` - Chat turns with thinking/tool call metadata

**Knowledge Tables:**
- `artifacts` - Files, generated outputs, work capsules with retrieval class
- `artifact_chunks` - Text chunks for semantic search
- `semantic_embeddings` - TEI embeddings for artifacts, task states, and legacy persona-cluster rows during migration cleanup

**Memory Tables:**
- `task_states` - Project continuity, checkpoints, evidence links
- `memory_events` - State change log (deadlines, preferences, supersession)
- `memory_projects` / `memory_project_task_links` - Continuity buckets and task associations
- `projects` - Project folders with durable sidebar order state; use direct project fields rather than a separate sidebar preferences table for first-party sidebar organization

**Config Tables:**
- `runtime_config` - Admin UI overrides for env vars
- `user_preferences` - Account-level settings

## Conventions

- **Primary keys**: `text('id')` with UUIDs
- **Timestamps**: `integer('...', { mode: 'timestamp' })` with unixepoch defaults
- **Foreign keys**: Always use `onDelete: 'cascade'` for user-owned data
- **JSON columns**: `text('metadata_json')` for flexible metadata
- **Indexes**: Define in table callback for query patterns
- **Soft deletes**: Use `retrieval_class` ('durable' | 'superseded' | 'historical') not boolean flags

## Anti-Patterns

- Do NOT add runtime schema mutation here - use `scripts/prepare-db.ts`
- Do NOT create mini repository wrappers - use services + schema directly.
  (Exception, [ADR-0059](../../../../docs/adr/0059-db-execution-seam.md): ONE query-*execution*
  seam is permitted and is being introduced. Services still compose their own queries against
  the schema; only how a query runs is owned centrally. Per-table wrappers remain forbidden.)
- Do NOT read `DATABASE_PATH` directly - use `getDatabasePath()` from `env.ts`
- Do NOT bypass foreign keys - pragma is enabled

## Connection Bootstrap

- `src/lib/server/db/index.ts` is connection/bootstrap only. Do not reintroduce runtime schema mutation there.

## Database And Persistence

- DB bootstrap and Drizzle binding:
  - [`src/lib/server/db/index.ts`](index.ts)
- Schema:
  - [`src/lib/server/db/schema.ts`](schema.ts)
- Shared semantic embedding store:
  - [`src/lib/server/services/semantic-embeddings.ts`](../services/semantic-embeddings.ts)
- Explicit DB prep:
  - [`scripts/prepare-db.ts`](../../../../scripts/prepare-db.ts)


Legacy/avoidance notes:

`src/lib/server/db/compat.ts` is a narrow compatibility shim. Do not add new DB wrapper modules unless there is a verified compatibility need; new persistence logic should normally live in the relevant service and use `db` plus `schema.ts` directly.


Do not:

- put schema mutation back into `db/index.ts`
- create new mini repository layers for each table without a strong reason
- spread one feature's persistence logic across route handlers, DB wrapper modules, and service files at the same time
- add a table to `schema.ts` without a corresponding migration in `drizzle/` — every new `sqliteTable()` MUST have a matching `CREATE TABLE` migration file and a `_journal.json` entry. Run `npm run check:migrations` to verify this before committing.
