# Database Layer

SQLite persistence with Drizzle ORM. Schema definitions and connection bootstrap only.

## Structure

| File | Purpose |
|------|---------|
| `schema.ts` | Table definitions: users, sessions, conversations, messages, artifacts, chunks, projects, task states, memory events, semantic embeddings |
| `index.ts` | Connection bootstrap - exports `db` instance |
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
- Do NOT create mini repository wrappers - use services + schema directly
- Do NOT read `DATABASE_PATH` directly - use `getDatabasePath()` from `env.ts`
- Do NOT bypass foreign keys - pragma is enabled
