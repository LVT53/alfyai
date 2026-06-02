# Routes

Route organization for the SvelteKit app.

## Overview

Routes are thin adapters. Page routes render UI; API routes expose endpoints. Durable logic lives in services, stores, and client API modules.

## Structure

```
(app)/                 # Authenticated app group
  +layout.server.ts    # Preloads conversations, projects, models, user prefs
  +layout.svelte       # App shell with sidebar
  +page.svelte         # Landing page (draft prep, first-message handoff)
  chat/[conversationId]/
    +page.svelte       # Chat detail (stream lifecycle, draft restore)
  knowledge/
    +page.svelte       # Knowledge base (library, memory)
    _components/       # Page-local UI components
    _helpers.ts        # Page-only helpers
  settings/
    +page.svelte       # Settings/admin UI

api/                   # API endpoints
  auth/                # Login, logout
  avatar/              # User avatar
  chat/                # Send, stream, retry, stop, file production
  conversations/       # CRUD, title, draft, messages, evidence, context-status, task-steering
  knowledge/           # Upload, search, documents, memory, actions
  admin/               # Config, users, sessions, honcho
  models/              # Available model list
  projects/            # Project CRUD
  settings/            # Account, profile, password, avatar
  analytics/           # Analytics ingestion
  health/              # Health check

login/                 # Login page
logout/                # Logout page
```

## Where to Look

| Route | Purpose |
|-------|---------|
| `(app)/+layout.server.ts` | Auth guard, data preload |
| `(app)/+page.svelte` | Landing draft prep, pending message storage |
| `chat/[conversationId]/+page.svelte` | Stream lifecycle, queued turns, workspace state |
| `api/chat/send/+server.ts` | Non-streaming chat endpoint |
| `api/chat/stream/+server.ts` | SSE streaming endpoint |
| `api/chat/stream/buffer/+server.ts` | Stream buffer replay for reconnection |
| `api/chat/stream/status/+server.ts` | Stream capacity/status check |
| `api/chat/retry/+server.ts` | Retry failed turns |
| `api/chat/stream/stop/+server.ts` | Explicit user stop |
| `api/chat/files/produce/+server.ts` | File-production intake |
| `api/chat/files/jobs/[id]/retry/+server.ts` | Retry file-production job |
| `api/chat/files/jobs/[id]/cancel/+server.ts` | Cancel file-production job |
| `api/chat/files/[id]/preview/+server.ts` | Generated file preview |
| `api/chat/files/[id]/download/+server.ts` | Generated file download |
| `api/conversations/[id]/+server.ts` | Conversation detail CRUD adapter; GET delegates to `conversation-detail/read-model` |
| `api/conversations/[id]/context-status/+server.ts` | Conversation context status |
| `api/conversations/[id]/task-steering/+server.ts` | Task steering |
| `api/knowledge/upload/+server.ts` | File upload handler |
| `api/knowledge/[id]/+server.ts` | Artifact CRUD |
| `api/knowledge/[id]/attach/+server.ts` | Attachment linking |
| `api/knowledge/[id]/download/+server.ts` | Artifact download |
| `api/knowledge/[id]/preview/+server.ts` | Artifact preview |
| `api/knowledge/actions/+server.ts` | Bulk knowledge actions |
| `api/knowledge/memory/+server.ts` | Memory profile data |
| `api/knowledge/memory/actions/+server.ts` | Memory actions |
| `api/knowledge/memory/overview/+server.ts` | Memory overview |
| `api/knowledge/documents/behavior/+server.ts` | Document behavior |
| `api/admin/config/+server.ts` | Runtime config overrides |
| `api/admin/users/+server.ts` | User management |
| `api/admin/honcho/+server.ts` | Honcho admin |
| `api/auth/login/+server.ts` | Login endpoint |
| `api/auth/logout/+server.ts` | Logout endpoint |
| `api/models/+server.ts` | Available models |
| `api/projects/+server.ts` | Project list |
| `api/projects/[id]/+server.ts` | Project CRUD |
| `api/avatar/[userId]/+server.ts` | Avatar endpoint |
| `api/analytics/+server.ts` | Analytics ingestion |
| `api/health/+server.ts` | Health check |
| `(app)/chat/+page.server.ts` | Chat page server data |

## Conventions

- **Layout loading**: `(app)/+layout.server.ts` preloads all sidebar data; child routes avoid refetching
- **Page-local components**: Use `_components/` and `_helpers.ts` for page-only UI logic
- **API organization**: Group by domain (`chat/`, `knowledge/`, `admin/`, `settings/`)
- **Route params**: Dynamic segments use `[param]`; access via `event.params`
- **Auth**: `hooks.server.ts` attaches user to `locals`; routes use `requireAuth()` or redirect
- **Thin routes**: Parse request, call service, return response; no business logic inline
- **Conversation detail**: Refreshable `/api/conversations/[id]` GET payload assembly belongs in `src/lib/server/services/conversation-detail/read-model.ts`, not in the route adapter

## Anti-Patterns

- Duplicating turn logic between `send` and `stream` routes
- Adding business logic directly in `+server.ts` files instead of services
- Rebuilding conversation detail hydration, Context Sources projection, or active Skill Session serialization inside `api/conversations/[id]/+server.ts`
- Fetching layout data again in child pages
- Creating new `sessionStorage` keys outside `conversation-session.ts`
- Adding route-local AI SDK UI stream part shapes without updating the browser parser
- Putting raw `fetch` boilerplate in pages instead of `src/lib/client/api/`
