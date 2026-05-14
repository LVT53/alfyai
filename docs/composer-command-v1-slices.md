# Composer Command V1 Implementation Slices

This is a local `$to-issues` slice document for Composer Command V1. It is not a published issue list. The goal is to make the agreed Composer Command Registry, Skills, Skill Sessions, Linked Context Sources, Skill Notes, and Skill Draft Cards ready for delegation to sub-agents as independently verifiable production slices.

## Evidence And Scope

Read first for this plan: [AGENTS.md](../AGENTS.md), [CONTEXT.md](../CONTEXT.md), and [ADR 0009](./adr/0009-app-owned-composer-commands-and-skills.md).

Docs checked through Context7 before drafting:

- Svelte 5: callback props, `$props()`, modern `onclick`/`onkeydown`, and event migration guidance.
- SvelteKit: `+server` endpoint conventions, JSON responses, and server load data flow.
- Drizzle ORM SQLite: `sqliteTable`, integer timestamp modes, text/JSON column patterns, indexes, and migration generation expectations.

Current repository findings to preserve:

- There is no existing `src/lib/server/services/skills/`, `src/lib/client/api/skills.ts`, or skill table set.
- Skill persistence should follow the existing Drizzle SQLite style in `src/lib/server/db/schema.ts`: text UUID primary keys, integer timestamps, explicit indexes, JSON-as-text metadata columns where local style requires them, and cascades for user-owned data.
- Any new schema table needs a matching SQL migration and Drizzle journal update, verified with `npm run check:migrations`.
- User-owned skill, session, source, and note APIs must use `requireAuth`, pass `user.id` into services, and validate optional `conversationId` with `getConversation(user.id, conversationId)`.
- Admin System Skill management must use `requireAdmin`, but v1 admin APIs must not expose private User Skill or Skill Note bodies.
- Feature flags must flow through env defaults, `ADMIN_CONFIG_KEYS`, `config-store` overrides, app layout exposure, UI gating, and server-side enforcement.
- V1 scope is Normal Chat only. `/research` only toggles the existing Deep Research Mode control and does not start a Deep Research skill runtime.
- All new labels, errors, confirmations, empty states, and accessibility strings need English and Hungarian localization.

## Orchestration Contract

Every slice starts as `planned` and `owner: unassigned`. Assign one worker per slice unless a slice explicitly asks for a review worker. Workers are not alone in the codebase, must not revert unrelated edits, and should keep writes inside the stated scope. Code-writing workers should use `$tdd` and report the red-green-refactor loop, or explain why a strict test-first loop was not feasible and what focused regression check was added instead.

The Composer Command Registry remains behind a runtime admin-configurable feature flag until the v1 surface is coherent. Slices may ship disabled behavior under that flag, but they must not leak half-enabled command, skill, or note behavior when the flag is off. Server routes must enforce the flag, not only hide UI.

Normal Chat is the only runtime target. Deep Research remains its own subsystem. `/research` may select the existing Deep Research Mode/depth control when Deep Research is enabled, but Skill Sessions, Skill Notes, Skill Control Envelopes, and Linked Context Sources do not alter the Deep Research job lifecycle.

Suggested worker boundaries are disjoint where practical. The most likely overlap points are `MessageInput.svelte`, shared types, i18n, `config-store`, schema/migrations, and chat-turn parsing. Later workers should rebase mentally on earlier slice outputs rather than recreate parallel state shapes.

Baseline verification for implementation workers:

- Run focused unit/component tests for the touched boundary.
- Run `npm run check:migrations` for schema or migration changes.
- Run `npm run check` after TypeScript/Svelte changes.
- Run targeted Playwright checks for keyboard, mobile, accessibility, and end-to-end composer behavior.
- Confirm feature-flag-off behavior blocks UI and server-side effects.

## Slice Table

| ID | Title | Status | Owner | Type | Blocked by | Suggested write scope | Verification |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CCV1-01 | Feature flag and dormant registry shell | planned | unassigned | AFK | None | Runtime config, layout data, registry skeleton, minimal gated UI/API tests | Flag off/on tests, `npm run check` |
| CCV1-02 | Static Command Tray and slash command parser | planned | unassigned | AFK | CCV1-01 | Composer UI, command parser helpers, static slash command registry, i18n | Component keyboard tests, focused e2e |
| CCV1-03 | User Skill Definition CRUD and Skills Settings Surface | planned | unassigned | AFK | CCV1-01 | Skill schema/service/API, user settings UI, client API, i18n | Service/API/component tests, migrations |
| CCV1-04 | Admin System Skills and privacy-safe admin boundary | planned | unassigned | AFK | CCV1-03 | Admin skill APIs/settings pane, built-in System Skill seed path, privacy tests | Admin route tests, privacy regression tests |
| CCV1-05 | `$` skill discovery and Pending Skill Chip | planned | unassigned | AFK | CCV1-02, CCV1-04 | Skill search API, tray rows, pending chip, draft payload extension | Component/API tests, disabled-skill preflight |
| CCV1-06 | `/document` picker and persistent Linked Context Sources | planned | unassigned | AFK | CCV1-02 | Document picker/list extraction, linked-source API/state, draft extension | Picker tests, route validation tests |
| CCV1-07 | `/source` manager and Context Sources validation | planned | unassigned | AFK | CCV1-06 | Linked Sources Popover, `ContextSourcesState` extension, preflight validation | Component tests, send/stream invalid-source tests |
| CCV1-08 | Durable Skill Sessions and Skill Session Panel | planned | unassigned | AFK | CCV1-05 | Skill session schema/service/API, chat page state, session panel | Session lifecycle tests, refresh persistence |
| CCV1-09 | Skill prompt integration through send and stream | planned | unassigned | AFK | CCV1-07, CCV1-08 | Chat-turn request/preflight, Langflow/context assembly, send/stream tests | Dual-path prompt tests, Deep Research exclusion |
| CCV1-10 | Skill Control Envelope parsing and state transitions | planned | unassigned | AFK | CCV1-08, CCV1-09 | Stream-protocol/normalizer helpers, messages metadata, session transitions | Parser tests, stopped-stream tests |
| CCV1-11 | Skill Notes as living `skill_note` artifacts | planned | unassigned | AFK | CCV1-10 | Knowledge service note boundary, note ops/checkpoints, embeddings refresh | Note operation tests, artifact/retrieval tests |
| CCV1-12 | AI-created Skill Draft Cards | planned | unassigned | AFK | CCV1-04, CCV1-10 | Assistant metadata, chat card UI, save/publish/dismiss APIs | Metadata/card tests, admin publish tests |
| CCV1-13 | Mobile, accessibility, animation, localization, and e2e pass | planned | unassigned | HITL | CCV1-02 through CCV1-12 | Cross-surface UI polish, EN/HU audit, Playwright acceptance | Desktop/mobile e2e, a11y keyboard checks |

## CCV1-01. Feature Flag And Dormant Registry Shell

**Type:** AFK
**Status:** planned
**Owner:** unassigned
**Blocked by:** None
**User stories covered:** As an operator, I can keep Composer Command V1 disabled until the full surface is coherent. As a user, I should not see half-built command or skill behavior when the feature is off.

### What to build

Add the runtime admin-configurable feature flag and a dormant app-owned Composer Command Registry shell. The slice should prove end-to-end gating through env defaults, runtime config overrides, server-side enforcement, layout/page exposure, and a tiny hidden-by-default UI/API path that later slices can extend.

The shell should not implement Skill runtime behavior yet. It should establish the registry boundary, feature flag naming, and server/client gating pattern used by all later slices.

### Acceptance criteria

- [ ] A named Composer Command Registry feature flag defaults off from env/config.
- [ ] The flag appears in `ADMIN_CONFIG_KEYS`, config normalization, admin settings, and app layout data.
- [ ] Feature-flag-off users cannot access registry APIs or UI affordances.
- [ ] Feature-flag-on exposes only a dormant registry shell with no incomplete Skill execution path.
- [ ] The registry shell is Normal Chat scoped and does not change Deep Research behavior.
- [ ] English and Hungarian labels/errors exist for the new admin flag and any gated empty state.

### Suggested worker scope / do not change

Write scope: runtime config files, settings admin System pane, layout data exposure, a minimal registry service/API shell, focused tests.

Do not change: AGENTS.md, ADRs, chat runtime behavior beyond flag enforcement, Deep Research job logic.

### Verification commands/checks

- `npm run check`
- Focused config-store/admin settings tests.
- Feature-flag-off route/API test proving server-side enforcement.

### Residual risks

- The exact config key name should be settled here and reused by every later worker.
- Later slices must not bypass this gate in client-only code.

## CCV1-02. Static Command Tray And Slash Command Parser

**Type:** AFK
**Status:** planned
**Owner:** unassigned
**Blocked by:** CCV1-01
**User stories covered:** As a user, typing `/` should open the Command Tray, show available Composer Commands, and let Enter select the highlighted row before sending. Shift+Enter should still add a newline, and IME composition should not send or select.

### What to build

Implement the command-token parser and Command Tray shell with the exact v1 static slash command catalog: `/model`, `/style`, `/thinking`, `/attach`, `/document`, `/source`, `/skill`, `/settings`, `/clear`, and `/research`. Commands that depend on later storage can open disabled or placeholder flows behind the feature flag, but existing attach, model, style, thinking, settings, and Deep Research Mode controls should mutate the same composer state or open the same existing surfaces used today.

The Command Tray should reuse ComposerToolsMenu interaction patterns: composer-attached popover, outside close, Escape close, roles, restrained animation, and reduced-motion handling. It should ship with the agreed base visual behavior in this slice rather than as a placeholder: a darker elevated surface, about 90% of the composer width on desktop, visually attached behind/above the composer, smooth slide/fade open and close, capped visible results, and restrained accent color on active or selected states. Selecting a command consumes only the active command token and preserves surrounding message text.

### Acceptance criteria

- [ ] `$` and `/` prefixes are recognized only for active cursor tokens at the start of the composer or after whitespace.
- [ ] Literal URLs, prices, paths, and prose containing `$` or `/` are not treated as commands unless they satisfy the active command-token rule.
- [ ] Enter selects the highlighted Command Suggestion Row before send or queue when the tray has an active selection.
- [ ] Shift+Enter inserts a newline while the tray is open.
- [ ] `event.isComposing` prevents row selection and message send.
- [ ] The static v1 slash catalog includes `/model`, `/style`, `/thinking`, `/attach`, `/document`, `/source`, `/skill`, `/settings`, `/clear`, and `/research`.
- [ ] `/model`, `/style`, and `/thinking` update existing composer setting state rather than creating a parallel override system.
- [ ] `/attach` opens the existing attachment flow, and `/settings` opens the existing settings surface rather than introducing duplicate routes or state.
- [ ] `/research` toggles only existing Deep Research Mode/depth behavior when Deep Research is enabled.
- [ ] Desktop Command Tray uses a darker elevated surface, around 90% of the composer width, and reads as visually attached behind/above the composer.
- [ ] Command Tray open and close use smooth slide/fade motion, with reduced-motion support.
- [ ] Command Tray visible results are capped for scanning and performance.
- [ ] Active and selected rows use restrained accent color without making the whole tray visually loud.
- [ ] All tray labels, errors, empty states, and a11y strings exist in EN/HU.

### Suggested worker scope / do not change

Write scope: `MessageInput.svelte`, related chat command components/helpers, localized strings, component tests.

Do not change: skill persistence, chat-turn request payload, Deep Research job APIs, Knowledge Library internals.

### Verification commands/checks

- Focused `MessageInput` component tests for command token parsing and Enter precedence.
- Focused Playwright path for keyboard selection and ordinary send behavior.
- `npm run check`

### Residual risks

- This slice touches the most contested composer file. Keep helper extraction small and aligned with existing Svelte 5 `$props()` and callback prop style.
- Placeholder commands must be visibly unavailable rather than silently executing incomplete flows.

## CCV1-03. User Skill Definition CRUD And Skills Settings Surface

**Type:** AFK
**Status:** planned
**Owner:** unassigned
**Blocked by:** CCV1-01
**User stories covered:** As a user, I can create, edit, enable, disable, and delete private User Skills that only I can see.

### What to build

Add the first vertical Skill Definition path for private User Skills: durable schema, migration, user-owned server service, authenticated API, client API helper, and a Skills Settings Surface under user settings. A saved User Skill remains declarative configuration, not executable code or a Langflow tool.

This slice should not implement `$` activation yet. It should be demoable by creating a User Skill in settings, reloading, editing it, disabling it, and confirming another user cannot see it.

### Acceptance criteria

- [ ] User Skill Definitions persist display name, description, instructions, activation examples, ownership, enabled state, duration policy, question policy, notes policy, source scope, creation source, version, and timestamps.
- [ ] User-owned APIs use `requireAuth` and never trust a browser-supplied user id.
- [ ] Users can list, create, update, enable/disable, and delete only their own User Skills.
- [ ] The settings UI includes empty, loading, validation, save, delete, and error states in EN/HU.
- [ ] Duplicate display names warn but do not block saving.
- [ ] V1 does not offer sharing, copying, duplicating, import/export, marketplace, clone, or personalize-from-system flows.
- [ ] Migrations and Drizzle schema are in sync.

### Suggested worker scope / do not change

Write scope: new skill schema/migration, `src/lib/server/services/skills/`, authenticated skill APIs, `src/lib/client/api/skills.ts`, settings user skill UI, i18n, tests.

Do not change: System Skill admin publishing, `$` discovery, chat prompt integration, Skill Sessions, Skill Notes.

### Verification commands/checks

- `npm run check:migrations`
- User skill service/API tests for owner isolation.
- Settings component tests for create/edit/delete and EN/HU labels.
- `npm run check`

### Residual risks

- The Skill Definition shape becomes a long-lived contract. Keep fields explicit and versioned rather than hiding policy in raw JSON.
- Do not let settings UI imply that saving a User Skill activates it for the current chat.

## CCV1-04. Admin System Skills And Privacy-Safe Admin Boundary

**Type:** AFK
**Status:** planned
**Owner:** unassigned
**Blocked by:** CCV1-03
**User stories covered:** As an admin, I can manage System Skills and global skill settings. As a normal user, my private User Skill instructions and Skill Note content are not exposed to admins in v1.

### What to build

Extend Skill Definition management for admin-owned System Skills, including a small initial System Skill set: Interview, Grill With Docs, Code Review, and Writing Coach. Add admin-only create/edit/publish/disable controls for System Skills while preserving private User Skill and Skill Note content boundaries.

Admin APIs may expose System Skill bodies and safe aggregate metadata/counts when explicitly designed, but v1 must not return private User Skill instructions, bodies, or Skill Note content to admin management views.

### Acceptance criteria

- [ ] Admin System Skill APIs use `requireAdmin`.
- [ ] Admins can create, edit, enable, disable, and publish System Skills.
- [ ] Built-in System Skills seed or bootstrap idempotently without overwriting admin edits.
- [ ] Normal users can see enabled System Skill summaries but cannot edit System Skill definitions.
- [ ] Admin APIs do not expose private User Skill bodies or Skill Note content.
- [ ] Privacy regression tests prove an admin user cannot inspect another user's private User Skill instructions through v1 admin APIs.
- [ ] Built-in System Skill display names, descriptions, and defaults support EN/HU where practical.

### Suggested worker scope / do not change

Write scope: admin skill services/APIs, settings admin System pane, built-in System Skill seed path, privacy tests, i18n.

Do not change: user-owned User Skill CRUD semantics from CCV1-03, Skill Note runtime, chat prompt integration, ADRs unless a direct contradiction is found.

### Verification commands/checks

- Admin route tests for System Skill CRUD.
- Privacy tests for admin access to other users' User Skills and Skill Notes.
- `npm run check:migrations` if schema changes.
- `npm run check`

### Residual risks

- Aggregate metadata/count surfaces should remain future-safe and content-free unless this slice explicitly implements them.
- Built-in seed behavior must be idempotent and avoid clobbering admin-managed content.

## CCV1-05. `$` Skill Discovery And Pending Skill Chip

**Type:** AFK
**Status:** planned
**Owner:** unassigned
**Blocked by:** CCV1-02, CCV1-04
**User stories covered:** As a user, typing `$` should discover available enabled Skills, let me select one, and show a Pending Skill Chip for the next Normal Chat message.

### What to build

Add `$` discovery over enabled User Skills and enabled System Skills, ranked for tray use. Selecting a skill converts the command token into structured composer state, not transcript text. The selected one-turn skill appears as a Pending Skill Chip and is included in draft state so refresh/navigation preserves the pending next turn.

This slice should only prepare a pending skill payload and block invalid sends. Prompt integration arrives in CCV1-09.

### Acceptance criteria

- [ ] Empty `$` discovery shows pinned, recent, or recommended skills first, then User Skills, then remaining System Skills.
- [ ] Typed `$` discovery ranks name matches before activation examples and descriptions.
- [ ] Equal match quality ranks User Skills above System Skills.
- [ ] Disabled, hidden, deleted, and unsaved Skill Drafts do not appear in discovery.
- [ ] Selecting a skill removes only the command token and preserves surrounding composer text.
- [ ] V1 allows at most one pending or active Skill; selecting another requires replace, finish, or dismiss handling.
- [ ] Pending Skill Chip has specific accessible remove labels and EN/HU copy.
- [ ] Draft persistence includes pending skill state and does not restore transient tray state.
- [ ] Send preflight blocks if the pending skill became unavailable before submission.

### Suggested worker scope / do not change

Write scope: skill discovery API, tray row rendering, Pending Skill Chip UI, draft payload extension, preflight validation, tests.

Do not change: skill prompt assembly, durable Skill Sessions, Skill Notes, Skill Control Envelope handling.

### Verification commands/checks

- Skill discovery API tests for ranking and visibility.
- Component tests for chip selection/removal and Enter precedence with `$`.
- Draft persistence tests for pending skill restore.
- Send/stream preflight tests for unavailable skill blocking.

### Residual risks

- Draft payload changes overlap with linked-source draft work. Coordinate data shape with CCV1-06 if both are active.
- Skill discovery should not reveal full System Skill instructions in tray rows.

## CCV1-06. `/document` Picker And Persistent Linked Context Sources

**Type:** AFK
**Status:** planned
**Owner:** unassigned
**Blocked by:** CCV1-02
**User stories covered:** As a user, I can type `/document`, choose existing Library Documents, and carry them as Linked Context Sources without re-uploading files.

### What to build

Implement `/document` as a Composer Command that opens a Document Picker Modal or mobile sheet for existing Library Documents. Reuse the logical document model with `displayArtifactId` versus `promptArtifactId`, and extract shared picker/list behavior rather than importing Knowledge page-private UI directly.

Selected documents become pending Linked Source Chips in the composer and persist as draft next-turn state. On submit, they become conversation-scoped Linked Context Sources eligible for Context Selection.

### Acceptance criteria

- [ ] `/document` opens a picker initialized from the typed command query when present.
- [ ] The picker lists existing logical Library Documents using the correct display/prompt artifact model.
- [ ] Selecting documents creates Linked Source Chips, not upload attachments or copied files.
- [ ] The same source selected as both an upload attachment and a Linked Context Source is deduplicated with the attachment winning.
- [ ] Linked source draft state restores across navigation/refresh; open picker/tray state does not.
- [ ] Optional `conversationId` is validated with `getConversation(user.id, conversationId)` before any conversation-scoped source write.
- [ ] Picker, chip, error, empty, focus, and a11y strings exist in EN/HU.

### Suggested worker scope / do not change

Write scope: shared document picker/list component, linked-source client/server APIs, composer chip state, draft extension, tests.

Do not change: Knowledge page-private UI ownership, file upload behavior, in-app editing of Library Documents, AI note-writing behavior.

### Verification commands/checks

- Picker component tests for search, select, remove, and focus restoration.
- API tests for ownership and conversation validation.
- Draft persistence tests for Linked Source Chips.
- `npm run check`

### Residual risks

- Logical document identity must be preserved so preview and prompt extraction use the intended artifacts.
- This slice should not make all Library Documents active context by default.

## CCV1-07. `/source` Manager And Context Sources Validation

**Type:** AFK
**Status:** planned
**Owner:** unassigned
**Blocked by:** CCV1-06
**User stories covered:** As a user, I can inspect, remove, clear, and add Linked Context Sources before sending, and AlfyAI blocks sends when a selected source is no longer accessible.

### What to build

Implement `/source` as a compact Linked Sources Popover for current Linked Context Sources. Extend the typed Context Sources state with a `linked_source` group so the active conversation source surface can render linked sources distinctly from attachments, memory, and inferred sources.

Chat-turn preflight should validate pending linked sources for both send and stream paths before prompt assembly.

### Acceptance criteria

- [ ] `/source` opens a compact popover listing linked sources with title, type, remove, clear-all, and add-document actions.
- [ ] The popover remains composer-adjacent on desktop and usable as a mobile sheet when needed.
- [ ] `ContextSourcesState` can represent a linked-source group without confusing it with upload attachments.
- [ ] Send and stream preflight validate linked sources using the authenticated user and conversation.
- [ ] Deleted or inaccessible linked sources block send with a local, actionable error that identifies the invalid source.
- [ ] Removing invalid linked sources lets ordinary message sending continue.
- [ ] EN/HU strings cover manager labels, errors, confirmations, empty states, and a11y controls.

### Suggested worker scope / do not change

Write scope: Linked Sources Popover, context source types/rendering, chat-turn preflight validation, source manager tests.

Do not change: prompt integration details beyond validation, Knowledge retrieval ranking, Skill runtime behavior.

### Verification commands/checks

- Component tests for remove, clear, add, Escape, outside close, and focus restore.
- Send and stream route/preflight tests for inaccessible linked sources.
- Context Sources rendering/data tests for the new group.

### Residual risks

- This slice must keep Context Sources product state distinct from per-message Message Evidence.
- Invalid linked-source errors should stay local to composer UI, not become assistant prose.

## CCV1-08. Durable Skill Sessions And Skill Session Panel

**Type:** AFK
**Status:** planned
**Owner:** unassigned
**Blocked by:** CCV1-05
**User stories covered:** As a user, a multi-turn Skill remains visible and controllable while it can affect future Normal Chat turns, and it survives refresh.

### What to build

Add durable Skill Session storage, service APIs, and a Skill Session Panel. Starting a multi-turn skill snapshots its Skill Definition instructions, policies, source scope, display name, and version. The active panel shows status, expected next action, note target when present, and finish/dismiss controls.

This slice should not yet add prompt integration. It should be demoable by starting, refreshing, finishing, and dismissing a session.

### Acceptance criteria

- [ ] At most one active Skill Session exists per conversation composer in v1.
- [ ] Starting another session requires replace, finish, or dismiss handling.
- [ ] Skill Sessions are scoped to a conversation and owned by `user.id`.
- [ ] Session snapshots are stable when the underlying Skill Definition changes later.
- [ ] Active sessions survive refresh and reappear in the Skill Session Panel.
- [ ] Sparse Skill Session Milestones persist important started/finished/dismissed events without becoming synthetic chat turns.
- [ ] If the underlying Skill becomes unavailable, the active session pauses or ends visibly.
- [ ] Panel labels, controls, empty/error states, and a11y strings exist in EN/HU.

### Suggested worker scope / do not change

Write scope: skill session schema/migration, session service/API, chat page session state, Skill Session Panel UI, tests.

Do not change: Langflow prompt integration, Skill Control Envelope parsing, Skill Notes.

### Verification commands/checks

- `npm run check:migrations`
- Session service/API tests for lifecycle, ownership, and snapshot immutability.
- Component tests for panel controls and refresh restore.
- `npm run check`

### Residual risks

- Session state will become the coordination point for prompt integration and envelopes, so status names should be explicit and conservative.
- Avoid transcript noise from routine internal state transitions.

## CCV1-09. Skill Prompt Integration Through Send And Stream

**Type:** AFK
**Status:** planned
**Owner:** unassigned
**Blocked by:** CCV1-07, CCV1-08
**User stories covered:** As a user, an activated Skill shapes the next Normal Chat turn while preserving my visible message text and working through both non-stream and stream paths.

### What to build

Thread pending Skill and active Skill Session context through `parseChatTurnRequest` and `preflightChatTurn`, then into Langflow/context assembly. Prompt integration belongs in the shared chat-turn and Langflow/context boundaries, not route-local string concatenation.

This slice should cover one-turn skills and active sessions for both `/api/chat/send` and `/api/chat/stream`. It should explicitly exclude Skill runtime when the same turn starts Deep Research through `/research`.

### Acceptance criteria

- [ ] Skill activation enters the chat turn as structured request state, not hidden text inserted into the user message.
- [ ] The visible user transcript preserves exactly the user's message text after command-token consumption.
- [ ] Send and stream paths both receive the same Skill context shape through shared parsing/preflight.
- [ ] Langflow/context assembly receives Skill instructions, Skill Session state, source scope, and relevant linked sources through the established boundary.
- [ ] Deep Research turns do not receive Normal Chat Skill Session prompt integration.
- [ ] Active Skill Sessions affect queued future turns, not in-flight responses.
- [ ] Feature-flag-off server paths reject skill payloads even if a client sends them.

### Suggested worker scope / do not change

Write scope: chat-turn request/preflight/types, Langflow/context assembly, send/stream tests, minimal client payload plumbing.

Do not change: Skill Control Envelope parsing, Skill Note operation commits, Deep Research job lifecycle.

### Verification commands/checks

- Unit tests for request parsing and preflight skill validation.
- Send and stream route/orchestrator tests proving identical prompt context.
- Regression test proving `/research` bypasses Skill Session runtime.
- `npm run check`

### Residual risks

- Prompt text must remain bounded and auditable; avoid route-local prompt guards or duplicated send/stream logic.
- Source scope is intent guidance, while Context Selection remains the authority for actual Prompt Context.

## CCV1-10. Skill Control Envelope Parsing And State Transitions

**Type:** AFK
**Status:** planned
**Owner:** unassigned
**Blocked by:** CCV1-08, CCV1-09
**User stories covered:** As a user, Skill state changes happen through validated structured assistant output that is not shown as visible answer text, and interrupted streams do not commit partial operations.

### What to build

Add Skill Control Envelope parsing, validation, stripping, and conservative Skill Session state transitions. Reuse the `stream-protocol` and normalizer pattern so send, stream, retry, and persistence share the same visible-text cleanup. Extend assistant-message metadata and the shared `ChatMessage` type for Skill Questions and future Skill Draft Cards.

Note operations should be parsed and recorded as pending intent here, but actual Skill Note writes land in CCV1-11.

### Acceptance criteria

- [ ] Complete valid Skill Control Envelopes are stripped from visible assistant text before persistence and display.
- [ ] Invalid or missing envelopes keep the Skill Session in a conservative active state rather than guessing from prose.
- [ ] Skill Session transitions support active, awaiting user, finished, failed-note, and dismissed states where relevant.
- [ ] Skill Questions are normal assistant messages marked in metadata, not a separate question transport.
- [ ] Stopped or incomplete streams do not apply partial envelope operations.
- [ ] Envelope handling is idempotent by session turn and operation id.
- [ ] Retry/reconnect/finalization paths do not duplicate state transitions.

### Suggested worker scope / do not change

Write scope: stream-protocol/normalizer helpers, chat-turn finalization/orchestrator integration, messages metadata, shared types, session transition tests.

Do not change: Knowledge artifact note mutation, settings UI, skill definition CRUD.

### Verification commands/checks

- Parser unit tests for complete, partial, malformed, and repeated envelopes.
- Send/stream/retry tests proving visible text stripping is shared.
- Stopped-stream test proving no partial operation commit.
- Message metadata tests for Skill Question markers.

### Residual risks

- Envelope syntax should be strict enough to avoid prose guessing but small enough for model reliability.
- Idempotency keys must survive reconnect/finalization retries.

## CCV1-11. Skill Notes As Living `skill_note` Artifacts

**Type:** AFK
**Status:** planned
**Owner:** unassigned
**Blocked by:** CCV1-10
**User stories covered:** As a user, note-capable Skills can create or update living Skill Notes, but they cannot silently edit uploaded Library Documents or arbitrary files.

### What to build

Implement Skill Notes through the Knowledge artifact backbone with a distinct `skill_note` artifact type and explicit mutation rules. Skill Note Operations are limited to create, replace body, and append dated or session-scoped entries. Replacing creates a bounded Skill Note Checkpoint before mutation.

Operations commit only after a complete valid Skill Control Envelope and after the assistant message exists. Updating a note refreshes chunks, embeddings, timestamps, retrieval metadata, and any open or linked note view.

### Acceptance criteria

- [ ] `skill_note` is distinct from uploaded Library Documents and `generated_output`.
- [ ] Note-capable skills can create, replace, and append only through validated Skill Note Operations.
- [ ] Uploaded Library Documents remain immutable to AI note operations.
- [ ] Replace creates a bounded Skill Note Checkpoint before changing the current body.
- [ ] Failed note operations do not partially mutate the Skill Note.
- [ ] If assistant text succeeds but note operation fails, the Skill Session Panel surfaces the note failure while preserving the assistant response.
- [ ] Note operations are idempotent by session turn and operation id.
- [ ] Updating a Skill Note refreshes chunks, embeddings, timestamps, and retrieval metadata.
- [ ] Skill Notes appear in the Knowledge Library under a distinct category/source and can be reused only through explicit selection or strong context signals.

### Suggested worker scope / do not change

Write scope: Knowledge service note boundary, artifact schema/migration if needed, Skill Note operation service, embedding refresh integration, Skill Session note status UI, tests.

Do not change: file upload immutability, generated-document version-family behavior, route-local note writes, arbitrary filesystem access.

### Verification commands/checks

- `npm run check:migrations` if schema changes.
- Service tests for create/replace/append/checkpoint/idempotency/failure rollback.
- Knowledge retrieval tests for `skill_note` category and context authority.
- Send/stream finalization tests proving note ops commit after assistant message exists.

### Residual risks

- Skill Notes can duplicate chat decisions; default context authority should stay low outside the originating session.
- Embedding refresh should use existing async refresh boundaries, not route-local TEI calls.

## CCV1-12. AI-Created Skill Draft Cards

**Type:** AFK
**Status:** planned
**Owner:** unassigned
**Blocked by:** CCV1-04, CCV1-10
**User stories covered:** As a user, AlfyAI can propose a Skill Draft from a conversation, but it does not silently save, enable, or publish it.

### What to build

Add assistant-message metadata support and UI for Skill Draft Cards. A card shows proposed name, description, run-policy summary, notes behavior, source scope, and review/save/dismiss actions. Saving creates a User Skill for the owner. Publishing as a System Skill is available only to admins.

V1 Skill Drafts attached to chat live in assistant-message metadata until saved, not a separate drafts table.

### Acceptance criteria

- [ ] Assistant metadata can carry one or more Skill Draft proposals without exposing them in visible assistant prose.
- [ ] Skill Draft Cards render in chat history after refresh.
- [ ] Review/save/dismiss actions are explicit and reversible where appropriate.
- [ ] Saving creates a User Skill owned by the current user; it does not enter `$` discovery until saved and enabled.
- [ ] Admin-only publish creates or updates a System Skill through the System Skill boundary.
- [ ] Ambiguous drafts default to next-message duration, no questions, no notes, and selected-sources-only source scope.
- [ ] Draft review visibly calls out broader capabilities such as note writing or Knowledge Library search before save.
- [ ] No model-facing Langflow `create_skill` tool is introduced.
- [ ] EN/HU strings cover card labels, confirmations, errors, and a11y actions.

### Suggested worker scope / do not change

Write scope: message metadata types, chat message rendering, Skill Draft Card component, save/dismiss/publish APIs, tests.

Do not change: Skill Definition base schema except via existing services, Langflow tools, Skill Note operations.

### Verification commands/checks

- Metadata mapping tests in messages service.
- Component tests for card rendering and actions.
- API tests for save owner isolation and admin-only publish.
- Refresh regression proving cards survive conversation reload.

### Residual risks

- Draft cards are a privilege boundary because publish can create System Skills. Keep admin checks server-side.
- Avoid treating rejected or dismissed drafts as active User Skills.

## CCV1-13. Mobile, Accessibility, Animation, Localization, And E2E Pass

**Type:** HITL
**Status:** planned
**Owner:** unassigned
**Blocked by:** CCV1-02 through CCV1-12
**User stories covered:** As a desktop, keyboard, mobile, screen-reader, English, or Hungarian user, Composer Command V1 should feel coherent rather than like independent feature fragments.

### What to build

Run the final acceptance pass across the full Composer Command V1 surface. This slice should tighten mobile behavior around the bottom-docked composer, visual viewport, and safe-area patterns; verify roles and keyboard affordances; ensure animations are restrained and respect reduced motion; and complete EN/HU localization coverage.

This is marked HITL because it should include human product/design review of the integrated command tray, chips, picker, source manager, Skill Session Panel, Skill Note status, and Skill Draft Cards before the feature flag is considered ready to enable.

### Acceptance criteria

- [ ] Desktop Command Tray is visually attached to the composer and supports keyboard, pointer, Escape, outside close, and focus restoration.
- [ ] Mobile Command Tray, Document Picker Modal, Linked Sources Popover, and Skill Session Panel use bottom-sheet or collapsed patterns that do not push the composer/latest message off-screen.
- [ ] Tray, picker, popover, chips, panels, and cards expose coherent roles, labels, active-row announcements, and remove labels.
- [ ] Reduced-motion preferences disable or simplify command/skill animations.
- [ ] All new user-facing text, errors, confirmations, empty states, and a11y strings are localized in English and Hungarian.
- [ ] `/clear` clears pending composer state with confirmation when attachments, linked sources, or a pending skill would be removed, without dismissing a durable active Skill Session unless explicitly requested.
- [ ] End-to-end tests cover command mixing: one pending or active Skill, multiple Linked Context Sources, uploaded attachments, and composer settings in one Normal Chat turn.
- [ ] Feature flag can be enabled only after the integrated surface passes the agreed smoke path.

### Suggested worker scope / do not change

Write scope: cross-surface UI polish, localization audit, component/e2e tests, visual acceptance notes.

Do not change: schema or core service contracts unless this slice finds a blocking integration bug that is delegated back to the responsible slice.

### Verification commands/checks

- `npm run check`
- Targeted component tests for a11y and localization.
- Targeted Playwright desktop and mobile flows for tray, picker, source manager, session panel, and draft card.
- Manual/HITL review of the feature-flag-on integrated experience.

### Residual risks

- Cross-surface polish can uncover earlier contract gaps. Assign those back to the smallest responsible slice instead of patching around them here.
- E2E flake risk is high around mobile viewport behavior; prefer stable assertions over brittle animation timing.
