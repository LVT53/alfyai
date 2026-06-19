# Conversation detail payload assembly belongs to the read model

AlfyAI will treat refreshable `/api/conversations/[id]` GET payload assembly as a Conversation Detail Read Model boundary in `src/lib/server/services/conversation-detail/read-model.ts`. The route remains an auth/HTTP adapter: authenticate the request, choose the requested view, call `getConversationDetail(...)`, map missing conversations to 404, and return JSON.

The read model assembles the stable `ConversationDetail` payload consumed by chat page load and browser hydration. It owns bootstrap versus full detail selection, payload defaults, child-fork message decoration, Context Sources projection, task-state continuity attachment, draft state, generated files, File Production cards jobs, context-compression snapshots, cost fields, and active Skill Session public serialization.

Normal Chat Turn Completion remains owned by chat-turn. Completion decides the durable result of an assistant turn, including message persistence, response-facing Context Sources, evidence, skill side effects, and continuity work. The Conversation Detail Read Model may read and project those durable results for refresh, but it must not become a second completion pipeline.

The read model may compose File Production Read Model for conversation-visible File Production Card projection. It must not own job ledger transitions, worker execution, retrieval authority, preview/download authorization, AI SDK UI stream terminal framing, or browser page state.

**Considered Options**

- Keep full conversation detail assembly in `src/routes/api/conversations/[id]/+server.ts`.
- Move only the message list and leave Context Sources, file production, and skill-session serialization in the route.
- Fold refreshable detail assembly into Normal Chat Turn Completion.
- Own refreshable conversation detail assembly in a dedicated read model.

We chose a dedicated read model because the route payload is a broad projection over durable chat, knowledge, continuity, file-production, research, compression, and cost state. Keeping that recipe behind one server boundary preserves the existing browser contract while preventing the GET adapter from becoming a route-local hydration recipe again.

**Consequences**

- New fields for chat page load or browser hydration should be added through `src/lib/server/services/conversation-detail/read-model.ts`.
- `src/routes/api/conversations/[id]/+server.ts` GET tests should mock only auth and the Conversation Detail Read Model, then verify adapter behavior.
- Read-model tests should cover payload defaults, bootstrap/full selection, child-fork message decoration, Context Sources projection, task-state continuity attachment, active Skill Session public serialization, and composed projection fields.
- File Production job transitions stay in File Production Job Ledger and worker modules; the Conversation Detail Read Model may only compose the File Production Read Model projection.
- Preview and download authorization stays in the relevant file-serving routes and services, not in conversation detail payload assembly.
