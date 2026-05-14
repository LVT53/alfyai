# Composer Command V1 Implementation Record

This is the current implementation record for Composer Command V1. It replaces the original delegation slice plan; the feature is no longer a wholly planned/unassigned effort, and the core skill, command, linked-source, session, note, and draft paths now have production code and focused tests.

## Evidence And Scope

Read first: [AGENTS.md](../AGENTS.md), [CONTEXT.md](../CONTEXT.md), and [ADR 0009](./adr/0009-app-owned-composer-commands-and-skills.md).

Docs checked during the 2026-05-14 schema-docs audit:

- Context7 Drizzle ORM SQLite docs: `integer({ mode: "boolean" })` maps to SQLite `integer`; nullable text columns remain plain `text`; schema definitions should be reflected by migrations and generated metadata.

Implemented boundaries observed in this repo:

- Composer UI and parser: `src/lib/components/chat/MessageInput.svelte`, `src/lib/components/chat/composer-command-parser.ts`, and related component tests.
- Browser skill API: `src/lib/client/api/skills.ts`.
- Durable skill/session/note services: `src/lib/server/services/skills/`.
- Chat-turn skill and source integration: `src/lib/server/services/chat-turn/`, `src/lib/server/services/skills/prompt-context.ts`, and linked context source services.
- Schema and migrations: `src/lib/server/db/schema.ts`, `drizzle/1777140000030_user_skill_definitions.sql` through `drizzle/1777140000035_skill_notes.sql`, and `drizzle/meta/0008_snapshot.json`.
- Localization: `src/lib/i18n.ts`, now audited by `src/lib/i18n.test.ts` for Composer/Skills namespace parity.
- E2E smoke coverage: `tests/e2e/composer-command-v1.spec.ts`.

## Current Status

| ID | Area | Status | Evidence | Remaining gap |
| --- | --- | --- | --- | --- |
| CCV1-01 | Feature flag and dormant registry shell | Implemented | Config/env tests, admin config route, `/api/composer-commands`, e2e flag-off check | `npm run check:migrations` still warns about unrelated tables not listed in `prepare-db.ts`; not a Composer blocker. |
| CCV1-02 | Static Command Tray and slash parser | Implemented | Parser tests, `MessageInput.test.ts`, e2e keyboard/mobile smoke | Broader visual/a11y audit remains useful after UI churn. |
| CCV1-03 | User Skill Definition CRUD and settings surface | Implemented | `src/lib/server/services/skills/user-skills.test.ts`, skill API tests, settings component tests | No sharing/import/export by design for V1. |
| CCV1-04 | Admin System Skills and privacy-safe admin boundary | Implemented | Admin skill route tests and service privacy behavior | Continue to avoid exposing private user instructions or Skill Note bodies in admin surfaces. |
| CCV1-05 | `$` skill discovery and Pending Skill Chip | Implemented | Client API discovery tests, service ranking tests, `MessageInput.test.ts`, e2e mixed-command turn | Replacement/finish UX should keep the one-active-skill invariant visible. |
| CCV1-06 | `/document` picker and persistent Linked Context Sources | Implemented | Linked picker component tests, draft fields, e2e mixed linked-source turn | Keep generated/uploaded prompt artifact resolution aligned with document workspace changes. |
| CCV1-07 | `/source` manager and Context Sources validation | Implemented | Linked context source service tests, MessageInput source manager tests | Add more negative e2e coverage for inaccessible/deleted sources when a stable fixture exists. |
| CCV1-08 | Durable Skill Sessions and Skill Session Panel | Implemented | `src/lib/server/services/skills/sessions.test.ts`, conversation skill-session routes, panel component coverage | E2E currently smokes active-session display through mocked routes rather than full persisted lifecycle. |
| CCV1-09 | Skill prompt integration through send and stream | Implemented | Skill prompt context tests, chat-turn request/preflight integration, e2e request payload assertion | Continue to guard Deep Research exclusion as chat-turn code evolves. |
| CCV1-10 | Skill Control Envelope parsing and state transitions | Implemented | Stream protocol/normalizer tests and skill session transition tests | Partial/stopped stream behavior should stay covered when stream finalization changes. |
| CCV1-11 | Skill Notes as living `skill_note` artifacts | Implemented with audit fixes | `src/lib/server/services/skills/notes.test.ts`, `drizzle/1777140000035_skill_notes.sql`, fixed `drizzle/meta/0008_snapshot.json` | Snapshot metadata was stale before this audit; continue running migration checks on schema edits. |
| CCV1-12 | AI-created Skill Draft Cards | Implemented | `SkillDraftCard.test.ts`, message metadata publish/dismiss/save route tests | Card e2e is not exhaustive; current coverage is route/component focused. |
| CCV1-13 | Mobile, accessibility, animation, localization, and e2e pass | Partially implemented | `tests/e2e/composer-command-v1.spec.ts` covers flag-off, mixed-command turn, and mobile tray placement; `src/lib/i18n.test.ts` audits EN/HU key parity | Full a11y matrix, invalid-source e2e, and persisted Skill Session lifecycle e2e remain follow-up gaps. |

## Schema Audit Notes

The schema, migrations, and Drizzle metadata now agree for the Composer Command V1 tables and columns covered by this audit:

- `conversation_drafts.selected_linked_sources_json`
- `conversation_drafts.pending_skill_json`
- `user_skill_definitions.published`
- `skill_note_operations`
- `skill_note_checkpoints`

`scripts/prepare-db.ts` now validates the three Composer Command V1 columns above in existing runtime databases. A focused regression test corrupts a journaled database by removing `conversation_drafts.pending_skill_json` and expects `prepareDatabase()` to reject it.

## Localization Audit Notes

Composer/Skills localization keys are expected to stay in parity across English and Hungarian for these namespaces:

- `admin.composerCommandRegistry`
- `admin.systemSkills.`
- `composerCommandRegistry.`
- `composerCommands.`
- `linkedSources.`
- `pendingSkill.`
- `skillDrafts.`
- `skillSessions.`
- `skills.`
- `sourceManager.`

The parity test intentionally reads the source dictionary instead of exporting new runtime metadata from `src/lib/i18n.ts`.

## E2E Gaps

No new e2e test was added in this audit because the accepted fixes are schema metadata, prepare-db validation, documentation, and i18n key parity. The existing `tests/e2e/composer-command-v1.spec.ts` already covers the highest-value integrated path: one pending skill, multiple linked sources, an uploaded attachment, and a composer setting in one Normal Chat turn.

Remaining low-risk e2e follow-ups:

- Deleted or inaccessible linked source blocks send and becomes recoverable after removal.
- Persisted active Skill Session survives a real refresh without route mocks.
- Skill Draft Card save/dismiss/publish survives chat history reload.
- Keyboard and screen-reader audit across tray, document picker, source manager, chips, session panel, and draft cards.
