# Deepen Conversation Detail Read Model

Source: `/private/var/folders/6c/llmb9__97ngcxtc26hvg8jzh0000gn/T/architecture-review-20260529-195600.html`, section `Deepen Conversation Detail Read Model`.

## Context

The current conversation detail route assembles the full chat hydration payload directly in `src/routes/api/conversations/[id]/+server.ts`. That route currently knows the bootstrap payload, full payload shape, messages plus child-fork hydration, attached artifacts, working set, context status/debug, Context Sources, task state continuity, draft, legacy generated files, File Production jobs, Deep Research jobs, context compression snapshots, cost totals, project reference fallback behavior, and active Skill Session serialization.

The architecture target is to move that recipe behind one server read-model module so route adapters stay thin and payload evolution has one owner. The chat page load and browser hydration should keep consuming the same stable `ConversationDetail` contract.

Docs checked before planning:

- Context7 SvelteKit docs for `+server.ts` request handlers, `json(...)` responses, route params, and `+page.ts` `PageLoad` fetch behavior.
- Context7 Vitest 4.1.6 docs for ESM module mocks, `vi.mock`, `vi.fn`, and `vi.mocked`.
- Context7 Drizzle ORM docs for typed select/read service patterns. The first implementation slice should not require schema changes, but conversation read-model code may compose Drizzle-backed services.
- The dedicated Svelte MCP docs tool is not exposed in this session, so Context7's official SvelteKit docs are the fallback docs source.

## Done Criteria

- `src/routes/api/conversations/[id]/+server.ts` remains a thin adapter for GET/PATCH/DELETE; GET authenticates, delegates conversation detail assembly to a read-model module, maps not-found to 404, and returns JSON.
- A Conversation Detail Read Model deep module owns bootstrap and full conversation detail assembly, including defaults, fallbacks, child-fork message decoration, task-state continuity attachment, Context Sources construction, snapshot serialization, and active Skill Session public serialization.
- The module returns the existing `ConversationDetail` shape, so `src/routes/(app)/chat/[conversationId]/+page.ts`, `fetchConversationDetail`, and chat hydration behavior do not need a contract migration.
- Bootstrap detail stays cheap and does not load messages, knowledge state, task state, generated files, File Production jobs, Deep Research jobs, cost summaries, or context compression snapshots.
- Full detail keeps current best-effort behavior for project reference lookup and active skill session lookup, without broad catch-all failure masking inside the route.
- Focused tests exercise the read-model module directly, while route tests verify only adapter concerns and the delegated payload.
- Stale route-local mocks/tests that only asserted the old inline recipe are removed or moved so test coverage stays useful.
- The architecture review HTML, `CONTEXT.md`, and ADRs record that Conversation Detail Read Model is the deep module owner for refreshable chat detail payloads.

## Slice 1: Extract The Read Model

Type: AFK

Blocked by: None

What to build:

Move bootstrap and full conversation detail assembly from the GET route into a dedicated Conversation Detail Read Model service. The route should call the read model with `userId`, `conversationId`, and `view`, then return its payload or a 404. The read model should preserve the existing `ConversationDetail` contract and all current fallback/default behavior.

Acceptance criteria:

- GET imports one read-model function instead of directly importing messages, knowledge, task-state, file-production read-model, deep-research, drafts, analytics, context-compression, skill-session, and context-source builders.
- Bootstrap view returns the same cheap payload shape and only calls conversation, draft, active skill session, and fork-origin lookups.
- Full view returns the same messages, fork origin, artifacts, working set, context status, Context Sources, task state, draft, generated files, File Production jobs, Deep Research jobs, context compression snapshots, active Skill Session, and cost totals.
- Child forks still attach only to assistant messages.
- Project reference lookup failure still leaves conversation detail available with empty/fallback Context Sources.
- Active Skill Session serialization still strips hidden instruction fields.
- Focused read-model tests cover bootstrap, full detail, child forks, context sources, project-reference fallback, cost totals, and active skill session serialization.

Suggested verification:

- `npm run test:unit -- 'src/lib/server/services/conversation-detail/read-model.test.ts' 'src/routes/api/conversations/[id]/conversation-detail.test.ts'`

## Slice 2: Thin The Route Tests And Guard The Page Contract

Type: AFK

Blocked by: Slice 1

What to build:

Update the route and page tests so they reflect the new boundary. Route tests should no longer duplicate the full read-model dependency graph through mocks. Page-load and client API tests should keep guarding the stable `ConversationDetail` payload contract from the browser side.

Acceptance criteria:

- Route GET tests mock only auth and the Conversation Detail Read Model, then verify unauthorized, not found, bootstrap/full delegation parameters, success JSON, and failure logging behavior.
- Existing PATCH behavior tests for title/project/sidebar pin remain intact and are not entangled with detail assembly mocks.
- Page-load tests still prove `depends("app:conversation-detail:<id>")`, bootstrap view selection, parent data preservation, and defaulting of optional detail fields.
- Client API tests continue to cover `fetchConversationDetail(id, { view: "bootstrap" })` URL construction.
- Any old route test fixtures that only existed to mirror inline assembly are deleted or moved to the read-model test.

Suggested verification:

- `npm run test:unit -- 'src/routes/api/conversations/[id]/conversation-detail.test.ts' 'src/routes/(app)/chat/[conversationId]/page-load.test.ts' src/lib/client/api/conversations.test.ts`

## Slice 3: Document The Boundary And Clean Obsolete Surfaces

Type: AFK

Blocked by: Slice 2

What to build:

Record Conversation Detail Read Model as a first-class deep module in project docs and remove stale code/test leftovers from the old route-local implementation. Update the architecture review HTML section from `in-process` to finished only after implementation and verification pass.

Acceptance criteria:

- `CONTEXT.md` defines **Conversation Detail Read Model** in the Normal Chat Context language, including what it owns and what it should not own.
- A new ADR, or a precise update to an existing compatible ADR, states that refreshable conversation detail payload assembly belongs to the read-model module while durable Normal Chat Turn Completion remains in chat-turn.
- `AGENTS.md` and/or `src/routes/AGENTS.md` route guidance identifies the read model as the owner of conversation detail GET assembly.
- Repo search shows the GET route no longer imports read-model internals such as `buildContextSourcesState`, `listMessages`, `getConversationTaskState`, or `listConversationFileProductionJobs`.
- No duplicate context-source construction, child-fork decoration, active skill public serialization, or conversation detail payload defaulting remains in route tests.
- The architecture review HTML section includes an implementation status, verification summary, and finished marker.

Suggested verification:

- `rg "buildContextSourcesState|listConversationFileProductionJobs|getConversationTaskState|listMessages|serializePublicSkillSession" 'src/routes/api/conversations/[id]/+server.ts'`
- `rg "Conversation Detail Read Model|conversation-detail/read-model" CONTEXT.md docs/adr AGENTS.md src/routes/AGENTS.md`

## Final Verification

Run after all slices are integrated:

- `npm run check`
- `npm run test:unit`
- `npm run build`
- `git status --short --branch`

Remote live verification after local checks:

- Commit and push `dev`, fast-forward `main`, and push `main`.
- Deploy on `alfydesign` with `./scripts/deploy.sh`.
- Restart `langflow-chat.service`, confirm `systemctl is-active` is `active`, and confirm `/api/health` returns `{"status":"OK"}`.
- Inspect recent journal logs for startup and conversation-detail errors.
- Exercise a live authenticated chat detail flow with the test account: load a chat, send one harmless prompt, confirm the app shell stays functional, and inspect logs during the smoke test.
