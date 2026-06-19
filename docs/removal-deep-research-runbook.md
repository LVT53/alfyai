# Deep Research Removal Runbook

**Status:** Removal checklist and execution record for the current Deep Research deletion.
**Purpose:** Provide the operational compass and verification record for deleting the current Deep Research subsystem and purging its data without damaging Normal Chat, web research, generated files, artifacts, file production, document workspace, context compression, or unrelated privacy/account data.
**Audience:** Future Codex sessions and maintainers implementing the removal.

This document is intentionally detailed. Use it as a checklist, not as background reading. If a future implementation step cannot be mapped to a section below, pause and classify it before changing code.

## 1. Decision Summary

The current Deep Research subsystem should be removed rather than repaired in place.

The preferred data decision is:

- Purge all Deep Research operational data.
- Purge historical Deep Research report artifacts and their direct derived rows.
- Purge stale `DEEP_RESEARCH_*` admin configuration rows.
- Drop Deep Research tables with a forward migration.
- Keep all unrelated systems intact, including generic generated files and artifacts that were not produced by Deep Research.

The purge must be surgical. It must use positive selection of rows proven to belong to Deep Research. Never delete a broad category such as all `generated_output` artifacts, all semantic embeddings, all generated files, or all memory records.

## 2. Non-Negotiable Safety Invariants

These invariants are more important than speed.

1. Normal Chat must keep working.
2. `research_web`, `web-research`, `web-grounding`, and Normal Chat web citation paths must remain.
3. Normal Chat `/depth` and `ReasoningDepth` must remain.
4. File production must remain.
5. Generic generated files must remain.
6. Generic artifact storage must remain.
7. Document workspace and document preview must remain.
8. Context compression must remain.
9. Account archive and privacy controls must remain, but Deep Research wording and Deep Research cleanup branches should be removed or rewritten.
10. No row should be deleted unless it is explicitly selected as Deep Research-owned.
11. No historical migration file should be rewritten unless the team has deliberately chosen a migration squash. The default is a forward migration.
12. The final tree must have no live references to `DeepResearch`, `deepResearch`, `deep_research`, `DEEP_RESEARCH`, `/api/deep-research`, `ResearchCard`, or `deepResearchDepth`, except in this runbook or any intentionally retained historical notes.

## 3. Original Audit Findings

The audited subsystem was not migrated to the Normal Chat Vercel AI SDK model execution path.

Migration baseline at the time of the removal audit:

- `drizzle/meta/_journal.json` latest entry is
  `1777140000061_memory_rework_foundation` at index 74.
- Deep Research historical migrations are already in the migration journal range
  `1777140000012_deep_research_jobs` through
  `1777140000027_deep_research_drop_active_conversation_unique`.
- A pre-removal database prepared at the current baseline is expected to contain
  the `deep_research_%` tables. A post-removal database must keep the historical
  migration files in place, apply one new forward drop/purge migration after the
  current latest migration, and end with no `deep_research_%` tables.
- The removal is implemented as the later forward migration
  `1777140000062_remove_deep_research.sql`, leaving the historical Deep
  Research migrations intact for already-deployed databases.

The original Deep Research subsystem had:

- Dedicated server services under `src/lib/server/services/deep-research/**`.
- Dedicated API routes under `src/routes/api/deep-research/**`.
- A dedicated client API wrapper under `src/lib/client/api/deep-research.ts`.
- A dedicated chat UI card under `src/lib/components/chat/ResearchCard.svelte`.
- Dedicated model role/depth configuration under `src/lib/deep-research-models.ts`.
- Database tables named `deep_research_*`.
- Runtime/admin config keys named `DEEP_RESEARCH_*`.
- Chat payload fields named `deepResearchDepth` and `deepResearchJobs`.
- Conversation detail hydration of Deep Research jobs.
- Composer command `/research`.
- Background worker startup in `hooks.server.ts`.
- Privacy and cleanup branches to cancel running Deep Research work.
- Memory-context enrichment from completed Deep Research reports.
- Prompt text advertising Deep Research report recall.

Approximate footprint from the current audit:

- 72 files and 48,437 lines in the two dedicated implementation trees:
  `src/lib/server/services/deep-research/**` and
  `src/routes/api/deep-research/**`.
- 22,458 lines of dedicated Deep Research tests in those two trees.
- 162 tracked files and 107,591 whole-file lines contain direct Deep Research
  keywords outside this runbook. This is an upper bound because large shared
  files are counted whole even when only a small branch needs removal.
- The tracked source-like repository baseline is about 398,891 lines, excluding
  generated build trees and `node_modules`.
- The dedicated implementation trees are about 12% of that baseline. The broad
  keyword-hit upper bound is about 27%.

Deletion difficulty is medium-high. The dedicated service and route trees can
be deleted whole after their imports are severed, but the subsystem is woven
through chat request parsing, streaming payloads, conversation detail hydration,
admin config, privacy cleanup, memory context, prompts, i18n, settings UI,
database schema, migrations, and documentation. The risky part is not deleting
the dedicated code; it is deleting only Deep Research-owned data and branches
without damaging Normal Chat web research, generic artifacts, generated files,
file production, document workspace, context compression, or account/privacy
flows.

Concrete shared-code anchors identified by the audit:

- Public type surface: `src/lib/types.ts`, especially the `DeepResearch*`
  blocks and `ConversationDetail.deepResearchJobs`.
- Conversation detail read model:
  `src/lib/server/services/conversation-detail/read-model.ts` imports
  `listConversationDeepResearchJobs`, returns `deepResearchJobs: []` for
  bootstrap, and fetches Deep Research jobs for first-render/full detail.
- Memory context:
  `src/lib/server/services/memory-context/project.ts` imports
  `deepResearchJobs`, joins completed report artifacts, exposes
  `deepResearchResults`, and builds `deep-research-report:*` evidence
  candidates.
- Privacy and cleanup:
  `src/lib/server/services/privacy-controls/index.ts` and
  `src/lib/server/services/cleanup/conversation-cleanup.ts` cancel active Deep
  Research jobs before destructive user/conversation actions.
- Startup:
  `src/hooks.server.ts` imports `ensureDeepResearchWorkerScheduler` and starts
  the Deep Research worker from runtime config.
- Chat input and display:
  `src/lib/components/chat/MessageInput.svelte`,
  `src/lib/components/chat/MessageArea.svelte`, and
  `src/routes/(app)/chat/[conversationId]/+page.svelte` contain the visible
  `/research` control, `deepResearchDepth` launch state, `ResearchCard`
  rendering, job polling/advance/cancel handlers, and report action handlers.
- App shell, config, and i18n:
  `src/lib/server/services/app-shell.ts`, `src/lib/server/env.ts`,
  `src/lib/server/config-store.ts`, `src/lib/i18n/chat.ts`, and
  `src/lib/i18n/settings.ts` surface Deep Research feature flags, model-role
  selectors, worker/concurrency settings, labels, and user-facing strings.

## 4. What Must Be Deleted Whole

Delete these only after shared imports and references have been removed.

### 4.1 Server Services

Delete the entire directory:

```text
src/lib/server/services/deep-research/**
```

Exception before deletion:

- Move `parseModelJsonObject` out of `src/lib/server/services/deep-research/llm-json.ts`.
- `src/lib/server/services/context-compression.ts` imports this parser and must keep its behavior.

Suggested destination:

```text
src/lib/server/services/model-json.ts
```

or another existing shared JSON/model-output utility if one is a better local fit.

### 4.2 API Routes

Delete the entire route tree:

```text
src/routes/api/deep-research/**
```

This removes these public contracts:

- Plan approve.
- Plan edit.
- Cancel.
- Workflow advance.
- Worker advance.
- Discuss report.
- Research further.
- Dev-control tests.

### 4.3 Client API

Delete:

```text
src/lib/client/api/deep-research.ts
src/lib/client/api/deep-research.test.ts
```

### 4.4 Chat UI Card

Delete:

```text
src/lib/components/chat/ResearchCard.svelte
src/lib/components/chat/ResearchCard.test.ts
```

### 4.5 Deep Research Model Config Module

Delete after all imports are removed:

```text
src/lib/deep-research-models.ts
```

### 4.6 Dedicated Tests And Helpers

Delete all Deep Research-only tests and helpers under:

```text
src/lib/server/services/deep-research/**
src/routes/api/deep-research/**
```

This includes `*.test.ts`, `test-helpers.ts`, and `test-read-model.ts`.

## 5. Shared Code That Must Be Rewritten

Do not delete the following shared files. Remove only the Deep Research branches, fields, types, or strings.

### 5.1 Database Schema

File:

```text
src/lib/server/db/schema.ts
```

Remove the Deep Research table block:

- `deepResearchJobs`
- `deepResearchPlanVersions`
- `deepResearchTimelineEvents`
- `deepResearchUsageRecords`
- `deepResearchSources`
- `deepResearchTasks`
- `deepResearchPassCheckpoints`
- `deepResearchCoverageGaps`
- `deepResearchResumePoints`
- `deepResearchEvidenceNotes`
- `deepResearchSynthesisClaims`
- `deepResearchClaimEvidenceLinks`
- `deepResearchCitationAuditVerdicts`

Do not remove:

- `conversations.status`
- `conversations.sealed_at`
- `artifacts`
- `artifact_chunks`
- `artifact_links`
- `generated_files`
- `semantic_embeddings`
- generic account/admin/config tables

### 5.2 Public Types

File:

```text
src/lib/types.ts
```

Remove:

- All `DeepResearch*` public types.
- `DeepResearchDepth`.
- `DeepResearchJob`.
- `DeepResearchReport*`.
- `ConversationDetail.deepResearchJobs`.

Keep:

- Generic conversation types.
- Generated file/artifact/document workspace types.
- Normal Chat reasoning depth types.

### 5.3 Chat Send Route

File:

```text
src/routes/api/chat/send/+server.ts
```

Remove:

- Imports from `$lib/server/services/deep-research`.
- Import of `buildDeepResearchPlanningContext`.
- Branch that checks `turn.deepResearchDepth`.
- Deep Research-specific error handling.
- `runDeepResearchTurn`.
- Response shape containing `deepResearchJob`.

After removal, `/api/chat/send` should only execute the normal chat send behavior and existing non-Deep-Research paths.

### 5.4 Chat Request Parsing

Files:

```text
src/lib/server/services/chat-turn/request.ts
src/lib/server/services/chat-turn/types.ts
src/lib/server/services/chat-turn/preflight.ts
src/lib/server/services/chat-turn/depth-selection.ts
```

Remove:

- `deepResearchDepth` from parsed request shape.
- `deepResearch` request body parsing.
- `parseDeepResearchDepth`.
- Pending-skill suppression caused by Deep Research.
- Linked-source/preflight bypasses caused by Deep Research.
- Depth-classifier bypass with `constraintNote: "deep_research_bypass"`.

Keep:

- Normal Chat request parsing.
- Pending skill support for Normal Chat.
- Linked-source handling for Normal Chat.
- Reasoning depth and depth clarification.

### 5.5 Streaming Client Contract

Files:

```text
src/lib/services/streaming.ts
src/lib/services/streaming.test-helpers.ts
src/lib/services/streaming.test.ts
src/routes/api/chat/stream/stream.test.ts
```

Remove:

- `StreamChatOptions.deepResearchDepth`.
- Request body `deepResearch: { depth }`.
- `pendingSkill: deepResearchDepth ? null : pendingSkill`.
- Test helper `deepResearch` request-body field.
- Fixture `deepResearchDepth: undefined`.

Keep:

- Streaming transport.
- Stop/detach behavior.
- Normal Chat stream request fields.

### 5.6 Conversation Session And Landing Handoff

Files:

```text
src/lib/client/conversation-session.ts
src/lib/client/conversation-session.test.ts
src/routes/(app)/+page.svelte
```

Remove:

- Pending-message `deepResearchDepth`.
- Serialization/deserialization of `deepResearchDepth`.
- Landing-page linked-source/pending-skill suppression caused by Deep Research.
- `deepResearchEnabled` prop passed to `MessageInput`.

Keep:

- Landing-to-chat handoff.
- Pending first message.
- Linked sources for Normal Chat.
- Pending skills for Normal Chat.

### 5.7 Normal Chat Client Turn Runtime

Files:

```text
src/lib/client/normal-chat-client-turn-runtime.ts
src/lib/client/normal-chat-client-turn-runtime.test.ts
```

Remove:

- `deepResearchDepth` payload field.
- `DeepResearchTurnParams`.
- `shouldStartDeepResearchJob`.
- `startDeepResearchTurn`.
- Deep Research branch before normal send/stream.
- Deep Research pending-skill suppression.

Keep:

- Normal Chat send/stream/retry/reconnect behavior.
- Queued follow-up behavior.
- Stop/detach semantics.

### 5.8 Composer Command Registry

Files:

```text
src/lib/composer-commands.ts
src/routes/api/composer-commands/composer-commands.test.ts
src/lib/components/chat/composer-command-parser.test.ts
```

Remove:

- `/research` command entry.
- `/research` API test expectation.
- Parser tests that use `/research` as the command token, or rewrite them to use another command token.

Keep:

- `/model`
- `/style`
- `/depth`
- `/attach`
- `/document`
- `/source`
- `/skill`
- `/settings`
- `/clear`

### 5.9 Message Input

Files:

```text
src/lib/components/chat/MessageInput.svelte
src/lib/components/chat/MessageInput.test.ts
```

Remove:

- Deep Research props.
- Deep Research depth state.
- Deep Research button/menu.
- Deep Research `/research` command handling.
- Deep Research payload field.
- Deep Research CSS classes.
- Deep Research i18n references.

Keep:

- Normal send.
- Attachments.
- Linked sources.
- Skill command behavior.
- Reasoning depth.
- Model/style controls.

### 5.10 Message Area And Chat Page

Files:

```text
src/lib/components/chat/MessageArea.svelte
src/lib/components/chat/MessageArea.test.ts
src/routes/(app)/chat/[conversationId]/+page.svelte
src/routes/(app)/chat/[conversationId]/+page.ts
src/routes/(app)/chat/[conversationId]/_helpers.ts
src/routes/(app)/chat/[conversationId]/_helpers.test.ts
src/routes/(app)/chat/[conversationId]/_components/ChatComposerPanel.svelte
src/routes/(app)/chat/[conversationId]/_components/ChatComposerPanel.test.ts
src/routes/(app)/chat/[conversationId]/_components/ChatMessagePane.svelte
src/routes/(app)/chat/[conversationId]/page-load.test.ts
src/routes/(app)/chat/[conversationId]/page-runtime.test.ts
```

Remove:

- `deepResearchJobs` props and state.
- ResearchCard rendering.
- Deep Research hydration/merge helpers.
- Deep Research cancellation helpers.
- Deep Research report action handlers.
- Deep Research polling/advance handlers.
- `deepResearchEnabled` page data/props.
- Deep Research read-only coupling.
- Deep Research optimistic job state.

Keep:

- Normal message rendering.
- File-production cards.
- Document workspace.
- Generated file refresh.
- Conversation read-only behavior if used by non-Deep-Research paths.

### 5.11 App Shell And Config

Files:

```text
src/lib/server/services/app-shell.ts
src/routes/(app)/layout.server.test.ts
src/lib/server/env.ts
src/lib/server/config-store.ts
src/lib/server/services/config-store.test.ts
```

Remove:

- `deepResearchEnabled`.
- Worker interval/stale/concurrency config.
- Active job limits.
- Reasoning concurrency limits specific to Deep Research.
- Deep Research model role config.
- Deep Research depth budget config.
- `DEEP_RESEARCH_*` admin keys.
- Deep Research resolved admin config values.

Keep:

- Provider/model config.
- Normal Chat config.
- File-production config.
- Other admin settings.

### 5.12 Admin Settings UI

Files:

```text
src/routes/(app)/settings/_components/SettingsAdminSystemPane.svelte
src/routes/(app)/settings/_components/SettingsAdminSystemPane.test.ts
src/routes/(app)/settings/_components/SettingsAdminSystemPane.model-fallback.test.ts
tests/e2e/settings-admin.spec.ts
src/lib/i18n/settings.ts
```

Remove:

- Deep Research feature flag controls.
- Deep Research worker controls.
- Deep Research active limit controls.
- Deep Research reasoning concurrency controls.
- Deep Research depth budget JSON control.
- Deep Research role model controls.
- English and Hungarian labels for those controls.
- E2E block for Deep Research admin settings.

Important:

- `deepResearchModelOptions()` may be a badly named generic model-options helper in this file. Do not delete blindly if non-Deep-Research selectors still use it. Rename or replace it with a generic helper.

### 5.13 Hooks And Worker Startup

Files:

```text
src/hooks.server.ts
src/hooks.server.test.ts
```

Remove:

- Import of `ensureDeepResearchWorkerScheduler`.
- Worker scheduler startup block.
- Test mock for scheduler.
- Test config fields for Deep Research worker config.
- Assertion that scheduler starts.

Keep:

- Session handling.
- Runtime config refresh.
- Maintenance work unrelated to Deep Research.

### 5.14 Conversation Detail Read Model

Files:

```text
src/lib/server/services/conversation-detail/read-model.ts
src/lib/server/services/conversation-detail/read-model.test.ts
src/routes/api/conversations/[id]/conversation-detail.test.ts
```

Remove:

- `listConversationDeepResearchJobs` import.
- Fetch of Deep Research jobs.
- `deepResearchJobs` field in bootstrap/full detail payloads.
- Tests expecting `deepResearchJobs: []` or populated job arrays.

Keep:

- Messages.
- Artifacts.
- Working set.
- Context sources.
- Task state.
- Drafts.
- Generated files.
- File production jobs.
- Context compression.
- Costs.
- Skill sessions.

### 5.15 Cleanup And Privacy Controls

Files:

```text
src/lib/server/services/cleanup/conversation-cleanup.ts
src/lib/server/services/cleanup/conversation-cleanup.test.ts
src/lib/server/services/privacy-controls/index.ts
src/lib/server/services/privacy-controls/privacy-controls.test.ts
src/lib/server/services/account-data-archive/index.ts
src/lib/server/services/account-data-archive/index.test.ts
docs/privacy-controls-and-account-data-archive.md
docs/privacy-controls-implementation-issues.md
docs/prototypes/account-data-archive.html
```

Remove or rewrite:

- Active Deep Research cancellation before conversation deletion.
- Active Deep Research cancellation before account erasure.
- Deep Research archive exclusion note.
- Tests asserting the exclusion note.
- Docs/prototype wording that says Deep Research is excluded.

Keep:

- Account erasure.
- Clear workspace data.
- Clear memory and knowledge.
- File-production quiescence.
- Live chat stream quiescence.
- Memory maintenance behavior.
- Archive generation for in-scope data.

### 5.16 Memory Context And Prompt Wording

Files:

```text
src/lib/server/services/memory-context/project.ts
src/lib/server/services/memory-context/project.test.ts
src/lib/server/services/normal-chat-context.ts
src/lib/server/services/normal-chat-context.test.ts
src/lib/server/prompts.ts
src/lib/server/prompts.test.ts
src/lib/server/services/messages.ts
```

Remove:

- Deep Research report enrichment in project memory context.
- `deepResearchResults`.
- `omittedDeepResearchResultCount`.
- `deep-research-report:*` evidence candidate IDs.
- Prompt text that advertises Deep Research report recall.
- Message metadata field `deepResearchReportContext`, unless intentionally tolerated only for historical reads. Prefer removing it after artifact purge.

Keep:

- Generic `memory_context`.
- Project context.
- Sibling conversation summaries.
- Normal Chat prompt assembly.
- Message metadata unrelated to Deep Research.

### 5.17 Skill Prompt Context

Files:

```text
src/lib/server/services/skills/prompt-context.ts
src/lib/server/services/skills/prompt-context.test.ts
```

Remove:

- `if (turn.deepResearchDepth) return null`.
- Test case asserting that skill context is omitted for Deep Research.

Keep:

- Skill session prompt context for Normal Chat.

### 5.18 i18n

Files:

```text
src/lib/i18n/chat.ts
src/lib/i18n/settings.ts
src/lib/i18n.test-helpers.ts
```

Remove:

- `composerCommands.deepResearchUnavailable`.
- `composerTools.deepResearch*`.
- `deepResearch.*` English strings.
- Hungarian counterparts.
- `deepResearch.` audited prefix in `i18n.test-helpers.ts`.

Do not misclassify these as generic research labels. They are Deep Research UI strings.

### 5.19 Fallow Tooling

File:

```text
.fallowrc.json
```

Remove:

- Ignore entry for `src/lib/deep-research-models.ts`.
- Ignore entries for Deep Research service exports.

This matters because stale Fallow ignores can hide dead exports after the subsystem is removed.

## 6. Documentation Cleanup

Do not leave source-of-truth docs claiming that Deep Research exists.

### 6.1 Delete Or Archive Dedicated Deep Research Docs

Delete, archive, or clearly mark obsolete:

```text
docs/deep-research-quality-slices.md
docs/deep-research-revival-analysis.md
docs/deep-research-roadmap.md
docs/deep-research-stabilization-review.md
docs/deep-research-stabilization-slices.md
docs/adr/0001-deep-research-bounded-subsystem.md
docs/adr/0007-structured-deep-research-report-rendering.md
docs/adr/0014-deep-research-three-evidence-outcomes.md
```

Do not delete this runbook until after the removal has shipped and been verified:

```text
docs/removal-deep-research-runbook.md
```

### 6.2 Rewrite Source-Of-Truth Docs

Files:

```text
AGENTS.md
CONTEXT.md
```

Remove:

- Conversation detail references to Deep Research payloads.
- Composer command `/research`.
- Deep Research domain glossary.
- Deep Research report boundary/action language.
- Deep Research-specific table names and lifecycle rules.

Keep:

- Normal Chat reasoning depth.
- Generic web research language.
- Context compression language around generic `web/research excerpts`.

### 6.3 Rewrite Cross-Cutting Planning Docs

Search and rewrite Deep Research references in:

```text
docs/chat-surface-visual-baseline.md
docs/composer-command-v1-slices.md
docs/context-access-v1-slices.md
docs/context-compression-v1-slices.md
docs/deepen-normal-chat-client-turn-runtime-slices.md
docs/deepen-conversation-detail-read-model-slices.md
docs/normal-chat-depth-clarification-deliberation-refactor-slices.md
docs/normal-chat-reasoning-depth-implementation-issues.md
docs/normal-chat-stability-architecture-slices.md
docs/privacy-controls-and-account-data-archive.md
docs/privacy-controls-implementation-issues.md
docs/prototypes/account-data-archive.html
docs/vercel-ai-sdk-migration-slices.md
docs/web-research-markdown-extraction-slices.md
docs/adr/0019-normal-chat-client-turn-runtime-boundary.md
docs/adr/0022-conversation-detail-read-model-boundary.md
docs/adr/0028-normal-chat-reasoning-depth.md
docs/adr/0030-account-erasure-quiesces-user-work.md
```

Some references may be historical. If kept, mark them as historical and make clear the feature was removed.

## 7. Data Purge Design

Use a forward migration. Do not remove historical migrations unless the team explicitly chooses a migration squash.

### 7.1 Why A Forward Migration

Existing deployments may already have Deep Research migrations recorded in `__drizzle_migrations`.

Fresh databases may still need to apply historical migrations before the new drop migration.

Therefore, the safe default is:

1. Keep historical Deep Research migrations in the migration history.
2. Remove Deep Research schema from current application schema.
3. Add a new forward migration that drops the Deep Research tables and purges Deep Research rows.
4. Update Drizzle metadata through the normal project migration workflow.

### 7.2 Tables To Drop

Drop child tables first:

```text
deep_research_citation_audit_verdicts
deep_research_claim_evidence_links
deep_research_synthesis_claims
deep_research_evidence_notes
deep_research_coverage_gaps
deep_research_resume_points
deep_research_pass_checkpoints
deep_research_tasks
deep_research_sources
deep_research_usage_records
deep_research_timeline_events
deep_research_plan_versions
deep_research_jobs
```

Also remove now-unused Deep Research indexes if any remain after table drops.

### 7.3 Admin Config Purge

Delete stale admin overrides:

```sql
DELETE FROM admin_config
WHERE key IN (
  'DEEP_RESEARCH_ENABLED',
  'DEEP_RESEARCH_WORKER_ENABLED',
  'DEEP_RESEARCH_WORKER_INTERVAL_MS',
  'DEEP_RESEARCH_WORKER_STALE_TIMEOUT_MS',
  'DEEP_RESEARCH_JOB_RUNTIME_LIMIT_MS',
  'DEEP_RESEARCH_WORKER_GLOBAL_CONCURRENCY',
  'DEEP_RESEARCH_WORKER_USER_CONCURRENCY',
  'DEEP_RESEARCH_ACTIVE_CONVERSATION_LIMIT',
  'DEEP_RESEARCH_ACTIVE_USER_LIMIT',
  'DEEP_RESEARCH_ACTIVE_GLOBAL_LIMIT',
  'DEEP_RESEARCH_GLOBAL_REASONING_CONCURRENCY',
  'DEEP_RESEARCH_USER_REASONING_CONCURRENCY',
  'DEEP_RESEARCH_DEPTH_BUDGETS_JSON',
  'DEEP_RESEARCH_PLAN_MODEL',
  'DEEP_RESEARCH_PLAN_REVISION_MODEL',
  'DEEP_RESEARCH_SOURCE_REVIEW_MODEL',
  'DEEP_RESEARCH_RESEARCH_TASK_MODEL',
  'DEEP_RESEARCH_SYNTHESIS_MODEL',
  'DEEP_RESEARCH_CITATION_AUDIT_MODEL',
  'DEEP_RESEARCH_REPORT_MODEL'
);
```

### 7.4 Artifact Purge Policy

The selected product decision is to purge everything related to Deep Research.

That means deleting Deep Research report artifacts, but only when they are proven Deep Research artifacts.

Allowed selectors:

- `deep_research_jobs.report_artifact_id`.
- Artifact metadata containing explicit Deep Research markers such as `deepResearchJobId`.
- Artifact document roles known to have been written only by Deep Research, if confirmed from current code and tests.

Forbidden selectors:

```sql
-- Too broad, do not do this.
DELETE FROM artifacts WHERE type = 'generated_output';

-- Too broad, do not do this.
DELETE FROM generated_files;

-- Too broad, do not do this.
DELETE FROM semantic_embeddings WHERE subject_type = 'artifact';
```

### 7.5 Recommended Artifact Purge Shape

Use temporary tables or CTEs to create a positive target set before deleting.

Conceptual shape:

```sql
CREATE TEMP TABLE deep_research_artifact_purge_targets AS
SELECT DISTINCT report_artifact_id AS artifact_id
FROM deep_research_jobs
WHERE report_artifact_id IS NOT NULL;

INSERT INTO deep_research_artifact_purge_targets (artifact_id)
SELECT id
FROM artifacts
WHERE metadata_json LIKE '%"deepResearchJobId"%';
```

If the migration uses JSON functions, prefer an exact JSON-key selector such as
`json_extract(metadata_json, '$.deepResearchJobId') IS NOT NULL`. If it uses
plain SQL string matching, match the quoted key (`%"deepResearchJobId"%`), not
generic words such as `research`, `deepResearch`, `generated_output`, or
`report`.

Then delete only rows connected to this target table.

The current schema has these artifact-linked tables. Re-check them only if the
schema changes before implementation:

- `artifact_chunks.artifact_id`
- `artifact_links.artifact_id`
- `artifact_links.related_artifact_id`
- `task_state_evidence_links.artifact_id`
- `conversation_working_set_items.artifact_id`
- `semantic_embeddings.subject_type = 'artifact'` and `subject_id`
- `skill_note_operations.artifact_id`
- `skill_note_checkpoints.note_artifact_id`

Most direct artifact FKs use `ON DELETE CASCADE`, but the migration should not
silently rely on broad cascading as proof of correctness. Capture before/after
row counts for each linked table and prove that only rows connected to the
positive Deep Research artifact target set changed.

The deletion pattern should be:

1. Delete semantic embeddings where `subject_type = 'artifact'` and `subject_id` is in the target set.
2. Delete or allow cascade for artifact-linked rows only when their artifact IDs
   are in the target set.
3. Do not delete `chat_generated_files` or file-production rows unless a future
   audit proves a direct Deep Research-owned relationship. The current purge
   decision targets Deep Research report artifacts, not generic generated files.
4. Delete targeted artifacts.
5. Delete stale `DEEP_RESEARCH_*` admin config rows.
6. Drop Deep Research operational tables.

### 7.6 Executable Purge Order

The final migration can vary mechanically, but it must preserve this logical
order. Create the positive artifact target set before dropping
`deep_research_jobs`.

```sql
CREATE TEMP TABLE deep_research_artifact_purge_targets (
  artifact_id text PRIMARY KEY
);

INSERT OR IGNORE INTO deep_research_artifact_purge_targets (artifact_id)
SELECT report_artifact_id
FROM deep_research_jobs
WHERE report_artifact_id IS NOT NULL;

INSERT OR IGNORE INTO deep_research_artifact_purge_targets (artifact_id)
SELECT id
FROM artifacts
WHERE metadata_json LIKE '%"deepResearchJobId"%';
```

Delete artifact-derived rows from narrowest positive targets:

```sql
DELETE FROM semantic_embeddings
WHERE subject_type = 'artifact'
  AND subject_id IN (
    SELECT artifact_id FROM deep_research_artifact_purge_targets
  );

DELETE FROM artifact_links
WHERE artifact_id IN (
    SELECT artifact_id FROM deep_research_artifact_purge_targets
  )
  OR related_artifact_id IN (
    SELECT artifact_id FROM deep_research_artifact_purge_targets
  );

DELETE FROM artifact_chunks
WHERE artifact_id IN (
  SELECT artifact_id FROM deep_research_artifact_purge_targets
);

DELETE FROM task_state_evidence_links
WHERE artifact_id IN (
  SELECT artifact_id FROM deep_research_artifact_purge_targets
);

DELETE FROM conversation_working_set_items
WHERE artifact_id IN (
  SELECT artifact_id FROM deep_research_artifact_purge_targets
);

DELETE FROM skill_note_operations
WHERE artifact_id IN (
  SELECT artifact_id FROM deep_research_artifact_purge_targets
);

DELETE FROM skill_note_checkpoints
WHERE note_artifact_id IN (
  SELECT artifact_id FROM deep_research_artifact_purge_targets
);

DELETE FROM artifacts
WHERE id IN (
  SELECT artifact_id FROM deep_research_artifact_purge_targets
);
```

Do not delete from these tables as part of the Deep Research purge unless a
separate audit proves a direct Deep Research-owned row relationship:

```text
chat_generated_files
file_production_jobs
file_production_job_attempts
file_production_requests
messages
conversations
users
```

Then delete retired admin configuration:

```sql
DELETE FROM admin_config
WHERE key LIKE 'DEEP_RESEARCH_%';
```

Finally drop Deep Research operational tables child-first:

```sql
DROP TABLE IF EXISTS deep_research_citation_audit_verdicts;
DROP TABLE IF EXISTS deep_research_claim_evidence_links;
DROP TABLE IF EXISTS deep_research_synthesis_claims;
DROP TABLE IF EXISTS deep_research_evidence_notes;
DROP TABLE IF EXISTS deep_research_coverage_gaps;
DROP TABLE IF EXISTS deep_research_resume_points;
DROP TABLE IF EXISTS deep_research_pass_checkpoints;
DROP TABLE IF EXISTS deep_research_tasks;
DROP TABLE IF EXISTS deep_research_sources;
DROP TABLE IF EXISTS deep_research_usage_records;
DROP TABLE IF EXISTS deep_research_timeline_events;
DROP TABLE IF EXISTS deep_research_plan_versions;
DROP TABLE IF EXISTS deep_research_jobs;
```

After the migration, run:

```sql
DROP TABLE IF EXISTS deep_research_artifact_purge_targets;
PRAGMA foreign_key_check;
```

`PRAGMA foreign_key_check` must return no rows.

### 7.7 Semantic Embeddings

`semantic_embeddings` does not have an FK to `artifacts`.

If Deep Research report artifacts are purged, explicitly delete embeddings for those artifact IDs only.

Expected safe shape:

```sql
DELETE FROM semantic_embeddings
WHERE subject_type = 'artifact'
  AND subject_id IN (
    SELECT artifact_id FROM deep_research_artifact_purge_targets
  );
```

Do not delete all artifact embeddings.

### 7.8 Source Text And Evidence Notes

The Deep Research tables contain source text, evidence notes, source review state, citation audit state, and synthesis claims.

Dropping the `deep_research_*` tables is the main privacy purge for this data.

### 7.9 Conversation Sealing

Do not remove shared conversation columns casually:

- `conversations.status`
- `conversations.sealed_at`

They were introduced near Deep Research work, but may now be used by archive/settings/chat behavior. Only remove them if a separate audit proves they are unused and the product decision includes retiring sealed conversation state.

## 8. Implementation Order

Follow this order to keep the tree compiling as much as possible and to avoid deleting shared data accidentally.

### Phase 0: Branch And Baseline

1. Create a branch.
2. Confirm clean or understood worktree.
3. Run baseline checks:

```sh
npm run check
npm run check:migrations
npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow-before-deep-research-removal.json
```

4. Save a full keyword inventory:

```sh
rg -n -i --hidden -S \
  -e 'deep[ _-]?research' \
  -e 'deepResearch' \
  -e 'DeepResearch' \
  -e 'DEEP_RESEARCH' \
  -e 'ResearchCard' \
  -e 'researchDepth' \
  -e '/api/deep-research' \
  -e '/research' \
  --glob '!node_modules/**' \
  --glob '!.git/**' \
  --glob '!.svelte-kit/**' \
  --glob '!build/**' \
  --glob '!dist/**'
```

### Phase 1: Move Shared Parser

1. Move `parseModelJsonObject` out of `deep-research/llm-json.ts`.
2. Update `context-compression.ts` to import the new shared utility.
3. Add or retain focused tests for context compression JSON parsing.
4. Verify no non-Deep-Research code imports from `deep-research/**`.

Required search:

```sh
rg -n 'deep-research/llm-json|parseModelJsonObject' src tests scripts
```

### Phase 2: Remove Runtime Entry Points

1. Delete `/api/deep-research/**`.
2. Remove Deep Research branch from `/api/chat/send`.
3. Remove worker startup from `hooks.server.ts`.
4. Remove conversation detail hydration.
5. Remove client API wrapper.

At the end of this phase, no server route should be able to start, advance, approve, cancel, or discuss a Deep Research job.

### Phase 3: Remove Client And UI Plumbing

1. Remove `deepResearchDepth` from session storage.
2. Remove landing-page handoff support.
3. Remove runtime adapter hooks.
4. Remove `/research` command.
5. Remove Deep Research controls from `MessageInput`.
6. Remove ResearchCard rendering from `MessageArea`.
7. Remove Deep Research state from chat page and helper files.
8. Delete `ResearchCard.svelte`.

At the end of this phase, no UI should expose Deep Research controls or show Deep Research cards.

### Phase 4: Remove Config And Admin UI

1. Remove `DEEP_RESEARCH_*` from env parsing.
2. Remove `DEEP_RESEARCH_*` from config store.
3. Remove Deep Research settings UI.
4. Remove Deep Research settings i18n.
5. Remove Deep Research Fallow suppressions.

At the end of this phase, runtime config should have no Deep Research keys.

### Phase 5: Remove Memory/Prompt/Privacy Coupling

1. Remove Deep Research result enrichment from project memory context.
2. Remove Deep Research report mentions from Normal Chat prompts.
3. Remove `deepResearchReportContext` message metadata if no longer needed after purge.
4. Remove Deep Research cancellation branches from privacy and conversation cleanup.
5. Remove Deep Research exclusion note from account archive.
6. Rewrite privacy docs/prototype.

At the end of this phase, Normal Chat should not know Deep Research reports exist.

### Phase 6: Add Data Purge Migration

1. Add the forward migration.
2. Positively select Deep Research artifact targets.
3. Delete targeted embeddings/derived rows.
4. Delete targeted report artifacts.
5. Delete `DEEP_RESEARCH_*` admin config rows.
6. Drop Deep Research tables child-first.
7. Update prepare-db required table/column lists.
8. Update migration metadata according to the project Drizzle workflow.

At the end of this phase, migrated DBs should have no `deep_research_%` tables and no `DEEP_RESEARCH_%` admin rows.

### Phase 7: Delete Dedicated Files

Delete:

- Deep Research services.
- Deep Research routes.
- Deep Research client API.
- ResearchCard.
- Deep Research model config module.
- Dedicated tests.
- Dedicated docs or ADRs that should not remain.

### Phase 8: Rewrite Tests

Rewrite or delete affected tests in the same commit or PR. Do not leave skipped tests unless there is an explicit follow-up issue and a strong reason.

Minimum test families:

- `scripts/prepare-db.test.ts`
- `src/hooks.server.test.ts`
- `src/routes/api/chat/send/send.test.ts`
- `src/lib/services/streaming.test.ts`
- `src/routes/api/chat/stream/stream.test.ts`
- `src/routes/api/conversations/[id]/conversation-detail.test.ts`
- `src/lib/server/services/conversation-detail/read-model.test.ts`
- `src/routes/(app)/layout.server.test.ts`
- `src/routes/(app)/chat/[conversationId]/page-load.test.ts`
- `src/routes/(app)/chat/[conversationId]/page-runtime.test.ts`
- `src/routes/(app)/chat/[conversationId]/_helpers.test.ts`
- `src/lib/components/chat/MessageInput.test.ts`
- `src/lib/components/chat/MessageArea.test.ts`
- `src/lib/server/services/config-store.test.ts`
- `src/lib/server/services/privacy-controls/privacy-controls.test.ts`
- `src/lib/server/services/cleanup/conversation-cleanup.test.ts`
- `src/lib/server/services/account-data-archive/index.test.ts`
- `src/lib/server/services/memory-context/project.test.ts`
- `src/lib/server/services/skills/prompt-context.test.ts`
- `src/lib/client/conversation-session.test.ts`
- `src/lib/server/services/chat-turn/depth-selection.test.ts`
- `src/lib/server/services/normal-chat-context.test.ts`
- `src/lib/server/prompts.test.ts`
- `src/lib/i18n.test-helpers.ts`
- settings pane tests and settings E2E

### Phase 9: Rewrite Docs

Update source-of-truth docs after the code shape is known.

Do not leave AGENTS.md or CONTEXT.md describing Deep Research as an active subsystem.

## 9. Verification Matrix

The removal is not complete until every row below has evidence.

| Area | Proof command or inspection | Required result |
| --- | --- | --- |
| Typecheck | `npm run check` | 0 errors, 0 warnings |
| Fallow | `npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json` | No new unclassified dead exports; Deep Research ignores removed |
| Migration metadata | `npm run check:migrations` | Clean |
| Migration verifier | `npx tsx scripts/verify-migrations.ts` if present/used | Clean |
| Fresh DB | `DATABASE_PATH=/tmp/alfyai-dr-fresh.db npm run db:prepare` | DB prepares; no `deep_research_%` tables after latest migration |
| Upgrade DB | DB migrated through current latest before removal, then new migration | No `deep_research_%` tables; no FK failures |
| Admin rows | SQL query against `admin_config` | No `DEEP_RESEARCH_%` keys |
| Artifact purge | SQL query using seeded DR and non-DR artifacts | DR artifacts gone; non-DR artifacts remain |
| Embeddings purge | SQL query using seeded artifact embeddings | DR artifact embeddings gone; non-DR artifact embeddings remain |
| Normal Chat | targeted chat send/stream tests | Still pass |
| Web research | normal `research_web` tests or smoke | Still pass |
| File production | file production targeted tests | Still pass |
| Document workspace | document workspace tests or smoke | Still pass |
| Account archive | archive tests | No Deep Research exclusion note; unrelated generated files still export |
| Privacy erasure | privacy controls tests | No Deep Research branch; unrelated cleanup still works |
| Residual search | keyword search | No live Deep Research references outside this runbook, the removal migration/test fixtures, and intentionally retained historical Atlas docs |

### 9.1 Required Command Batches

Run focused tests first, then broaden if failures or touched files warrant it.
Split these commands if the shell or Vitest output becomes hard to read.

Core gates:

```sh
npm run check
npm run check:migrations
npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json
```

Migration and DB preparation:

```sh
npx vitest run scripts/prepare-db.test.ts
DATABASE_PATH=/tmp/alfyai-dr-fresh.db npm run db:prepare
```

Normal Chat send, stream, request parsing, and runtime:

```sh
npx vitest run \
  src/routes/api/chat/send/send.test.ts \
  src/routes/api/chat/stream/stream.test.ts \
  src/lib/client/normal-chat-client-turn-runtime.test.ts \
  src/lib/server/services/chat-turn/request.test.ts \
  src/lib/server/services/chat-turn/preflight.test.ts \
  src/lib/server/services/chat-turn/depth-selection.test.ts \
  src/lib/server/services/chat-turn/plain-normal-chat-model-run.test.ts \
  src/lib/server/services/chat-turn/streaming-normal-chat-model-run.test.ts \
  src/lib/server/services/chat-turn/stream-runtime.test.ts \
  src/lib/server/services/chat-turn/stream-completion.test.ts
```

Chat page, composer, conversation detail, and streaming client contract:

```sh
npx vitest run \
  src/lib/services/streaming.test.ts \
  src/lib/client/conversation-session.test.ts \
  src/lib/components/chat/MessageInput.test.ts \
  src/lib/components/chat/MessageArea.test.ts \
  src/lib/components/chat/composer-command-parser.test.ts \
  src/routes/api/composer-commands/composer-commands.test.ts \
  src/lib/server/services/conversation-detail/read-model.test.ts \
  'src/routes/api/conversations/[id]/conversation-detail.test.ts' \
  'src/routes/(app)/chat/[conversationId]/page-load.test.ts' \
  'src/routes/(app)/chat/[conversationId]/page-runtime.test.ts' \
  'src/routes/(app)/chat/[conversationId]/_helpers.test.ts'
```

Web research and citation paths that must remain:

```sh
npx vitest run \
  src/lib/server/services/web-grounding.test.ts \
  src/lib/server/services/web-research/index.test.ts \
  src/lib/server/services/web-research/extraction.test.ts \
  src/lib/server/services/normal-chat-tools/index.test.ts
```

File production, generated files, and document workspace:

```sh
npx vitest run \
  src/lib/server/services/file-production/index.test.ts \
  src/lib/server/services/file-production/output-validation.test.ts \
  src/lib/server/services/generated-file-serving.test.ts \
  src/routes/api/chat/files/produce/produce.test.ts \
  'src/routes/api/chat/files/jobs/[id]/retry/retry.test.ts' \
  'src/routes/api/chat/files/jobs/[id]/cancel/cancel.test.ts' \
  src/lib/client/api/file-production.test.ts \
  src/lib/components/document-workspace/DocumentWorkspace.test.ts \
  src/lib/components/document-workspace/DocumentPreviewRenderer.test.ts \
  src/lib/components/document-workspace/preview-runtime/preview-runtime.test.ts \
  src/lib/components/document-workspace/preview-runtime/text/text-preview.test.ts \
  src/lib/components/document-workspace/preview-runtime/image/ImagePreview.test.ts \
  src/lib/components/document-workspace/preview-runtime/pdf/PdfPreview.test.ts \
  src/lib/components/document-workspace/preview-runtime/office/office-preview.test.ts
```

Context compression, memory context, prompts, privacy, and account archive:

```sh
npx vitest run \
  src/lib/server/services/context-compression.test.ts \
  'src/routes/api/conversations/[id]/context-compression/context-compression.test.ts' \
  src/lib/server/services/memory-context/project.test.ts \
  src/lib/server/services/normal-chat-context.test.ts \
  src/lib/server/prompts.test.ts \
  src/lib/server/services/messages.test.ts \
  src/lib/server/services/skills/prompt-context.test.ts \
  src/lib/server/services/cleanup/conversation-cleanup.test.ts \
  src/lib/server/services/privacy-controls/privacy-controls.test.ts \
  src/lib/server/services/account-data-archive/index.test.ts \
  src/routes/api/settings/account/archive/archive.test.ts \
  src/routes/api/settings/account/clear-memory/clear-memory.test.ts
```

Config, startup, settings UI, and i18n:

```sh
npx vitest run \
  src/hooks.server.test.ts \
  'src/routes/(app)/layout.server.test.ts' \
  src/lib/server/services/config-store.test.ts \
  'src/routes/(app)/settings/_components/SettingsAdminSystemPane.test.ts' \
  'src/routes/(app)/settings/_components/SettingsAdminSystemPane.model-fallback.test.ts' \
  src/lib/i18n.test.ts
```

Focused browser smoke after unit/integration tests pass:

```sh
npm run test:e2e -- tests/e2e/core-user-flows-smoke.spec.ts tests/e2e/conversation.spec.ts tests/e2e/settings-admin.spec.ts tests/e2e/knowledge.spec.ts
```

Route contract smoke:

```sh
rg -n '/api/deep-research' src tests
```

After removal this command should return no active source or test references.
If a dev server is running, manually verify that representative
`/api/deep-research/**` URLs return the app's normal missing-route response and
do not reach Deep Research handlers.

The data-purge migration and its focused upgrade tests are allowed to retain the
retired table/key/payload strings they are explicitly proving. These are not
live product references.

### 9.2 Required SQL Assertions

Run these assertions against both the fresh DB and seeded upgrade DBs after the
new migration has applied.

```sql
SELECT name
FROM sqlite_master
WHERE type = 'table'
  AND name LIKE 'deep_research_%';
```

Expected: no rows.

```sql
SELECT key
FROM admin_config
WHERE key LIKE 'DEEP_RESEARCH_%';
```

Expected: no rows.

```sql
PRAGMA foreign_key_check;
```

Expected: no rows.

For seeded upgrade DBs, also record row counts before and after migration for:

```text
users
conversations
messages
artifacts
artifact_chunks
artifact_links
task_state_evidence_links
conversation_working_set_items
semantic_embeddings
chat_generated_files
file_production_jobs
file_production_job_attempts
file_production_requests
skill_note_operations
skill_note_checkpoints
admin_config
```

Expected result:

- Deep Research tables are gone.
- Positive Deep Research artifact targets are gone.
- Rows linked only to positive Deep Research artifact targets are gone.
- `DEEP_RESEARCH_*` admin config rows are gone.
- Non-Deep-Research users, conversations, messages, artifacts, artifact chunks,
  artifact links, semantic embeddings, generated files, file-production rows,
  working-set rows, and skill-note rows remain unchanged.

Fresh DB proof and upgrade DB proof are different and both are required:

- Fresh DB proof starts from no application database file, runs the full current
  migration stack including the new removal migration, and proves the resulting
  schema never requires live application code to define `deep_research_%`
  tables.
- Upgrade DB proof starts from a database migrated through the current
  pre-removal baseline, with Deep Research tables and seeded Deep Research data
  present, then applies only the new removal migration and proves the old state
  is purged without breaking unrelated rows.
- A fresh DB passing does not prove purge safety. An upgrade DB passing does not
  prove new installs work. Keep both results in the PR or deployment notes.

## 10. Required Seeded DB Scenarios

Build local smoke databases that prove both deletion and non-deletion.

Before each seeded migration test, capture row counts for every table listed in
Section 9.2. After migration, compare counts against explicit expected deltas.
Do not accept "migration completed" as proof of data safety.

Implemented coverage:

- `scripts/prepare-db.test.ts` creates a pre-removal database at
  `1777140000061_memory_rework_foundation`, seeds Deep Research-owned report
  artifacts, an unrelated generated artifact, dependent rows, and admin config,
  then runs `prepareDatabase`.
- The test asserts the Deep Research artifacts, dependent rows, retired tables,
  and `DEEP_RESEARCH_*` config are gone while the unrelated generated artifact
  and its dependent rows remain.
- A separate fresh-DB preparation was run against
  `/tmp/alfyai-remove-deep-research-check.db`; the resulting DB has no
  `deep_research_%` tables and `PRAGMA foreign_key_check` returns no rows.

### 10.1 Fresh DB

Purpose:

- Prove a new install can prepare and run without Deep Research tables.

Assertions:

- No `deep_research_%` tables.
- No `DEEP_RESEARCH_%` admin config rows.
- Normal bootstrap tables exist.
- `PRAGMA foreign_key_check` returns no rows.
- The latest migration recorded in `__drizzle_migrations` is the new
  post-removal migration, not the pre-removal
  `1777140000061_memory_rework_foundation` baseline.

### 10.2 Current DB With Deep Research Data

Purpose:

- Prove an existing deployment can upgrade and purge old Deep Research state.

Seed:

- One user.
- One conversation.
- One Deep Research job.
- Plan version.
- Timeline event.
- Source.
- Task.
- Pass checkpoint.
- Evidence note.
- Synthesis claim.
- Claim evidence link.
- Citation audit verdict.
- Report artifact.
- Artifact chunk for the report artifact.
- Artifact link involving the report artifact.
- Task-state evidence link for the report artifact.
- Working-set item for the report artifact.
- Optional skill-note operation/checkpoint rows pointing at a non-Deep-Research
  artifact to prove unrelated artifact cascades are not triggered.
- Semantic embedding for the report artifact.
- `DEEP_RESEARCH_*` admin config rows.

Assertions:

- All `deep_research_%` tables are gone after migration.
- Report artifact is gone.
- Report artifact embedding is gone.
- Report artifact chunks, links, task-state evidence links, and working-set rows
  are gone only for the targeted report artifact.
- `DEEP_RESEARCH_*` admin rows are gone.
- User, conversation, non-DR messages, and non-DR artifacts remain.
- `PRAGMA foreign_key_check` returns no rows.
- Before/after counts change only for:
  `artifacts`, artifact-linked rows connected to the targeted report artifact,
  `semantic_embeddings` rows for the targeted report artifact,
  `admin_config` rows with `DEEP_RESEARCH_%` keys, and dropped
  `deep_research_%` tables.

### 10.3 Current DB With Non-Deep-Research Generated Files

Purpose:

- Prove the purge does not delete unrelated generated files or artifacts.

Seed:

- A normal generated output artifact.
- A file-production job and produced file.
- Artifact chunks/links for that generated output.
- Semantic embedding for that artifact.
- Working-set or document workspace link if applicable.
- Task-state evidence link for that artifact if current schema permits it.
- Skill-note operation and checkpoint rows pointing at a non-Deep-Research note
  artifact.
- Artifact metadata with generic lookalike words that must not match the purge,
  such as `research`, `webResearch`, `research_web`, `generated_output`,
  `report`, and `deepResearchMention`, but no exact `deepResearchJobId` key.

Assertions:

- Non-DR artifact remains.
- Non-DR generated file remains.
- Non-DR semantic embedding remains.
- File-production job remains.
- Non-DR artifact chunks, links, working-set rows, task evidence links, and
  skill-note rows remain.
- Document preview/workspace can still load the artifact.
- The lookalike artifact metadata remains untouched. This proves the purge uses
  the exact positive Deep Research marker, not broad text matching.

### 10.4 DB With Old Admin Overrides Only

Purpose:

- Prove stale config rows are purged even if no Deep Research job rows exist.

Seed:

- `DEEP_RESEARCH_*` rows in `admin_config`.
- Other unrelated admin config rows.

Assertions:

- Deep Research rows gone.
- Other admin rows remain.

### 10.5 Current DB With Deep Research-Labeled But Non-Target Rows

Purpose:

- Prove the migration does not delete rows just because user-authored text or
  metadata mentions Deep Research.

Seed:

- A normal conversation message whose content mentions "Deep Research".
- A non-Deep-Research artifact whose `name`, `summary`, `content_text`, or
  `metadata_json` mentions Deep Research in prose but does not include an exact
  `deepResearchJobId` metadata key and is not referenced by
  `deep_research_jobs.report_artifact_id`.
- Semantic embedding and artifact chunk rows for that artifact.

Assertions:

- Message remains.
- Artifact remains.
- Artifact chunk remains.
- Semantic embedding remains.
- Only rows connected to `deep_research_jobs.report_artifact_id` or the exact
  `deepResearchJobId` metadata key are removed.

## 11. Residual Search Commands

Run these near the end and classify every hit.

```sh
rg -n -i --hidden -S \
  -e 'deep[ _-]?research' \
  -e 'deepResearch' \
  -e 'DeepResearch' \
  -e 'DEEP_RESEARCH' \
  -e 'ResearchCard' \
  -e 'researchDepth' \
  -e '/api/deep-research' \
  -e '/research' \
  --glob '!node_modules/**' \
  --glob '!.git/**' \
  --glob '!.svelte-kit/**' \
  --glob '!build/**' \
  --glob '!dist/**'
```

Expected allowed hits after implementation:

- This runbook.
- Historical docs intentionally marked obsolete.
- Replacement-design docs that explicitly say the old subsystem was deleted or
  replaced.
- The forward removal migration and focused seeded migration tests that must
  name retired tables, keys, and metadata fields to prove the purge.

Unexpected hits:

- Any `src/**` hit.
- Any `tests/**` hit that is not an explicit removal-proof fixture.
- Any `scripts/**` hit that is not an explicit removal-proof fixture.
- Any `.fallowrc.json` hit.
- Any active docs claiming Deep Research exists.

## 12. Package Dependencies

No package dependency was proven removable solely because of Deep Research.

Do not remove these just because Deep Research used them:

- `marked` and `@types/marked`: shared markdown rendering uses `marked`.
- `drizzle-orm`: database layer.
- `ai`: Normal Chat model integration.
- `zod`: shared validation.
- `jsdom`, `turndown`, `turndown-plugin-gfm`, `@mozilla/readability`: generic web extraction/research paths.
- `docx`, `pdf-lib`: document/file production paths.
- `dockerode`: sandbox/file production paths.
- `better-sqlite3`: database runtime.

If a future pass wants to remove dependencies, it must run a separate dependency audit after Deep Research code is gone.

## 13. Keep Boundary

These systems must survive and should have explicit tests or smoke checks:

```text
src/lib/server/services/web-research/**
src/lib/server/services/web-grounding.ts
src/lib/server/services/normal-chat-tools/research-web.ts
src/lib/server/services/normal-chat-tools/index.ts
src/lib/server/services/file-production/**
src/lib/components/document-workspace/**
src/lib/server/services/context-compression.ts
src/lib/server/services/knowledge/**
src/lib/server/services/messages.ts, minus Deep Research metadata
```

Be careful with names:

- Generic "research" is not always Deep Research.
- `research_web` is Normal Chat web grounding.
- `ReasoningDepth` is Normal Chat depth.
- `deepResearchDepth` is Deep Research launch plumbing and must go.
- `Research Pack` in tests may be a skill label and not Deep Research.

## 14. Deployment Plan

Do not deploy this directly after it compiles.

### 14.1 Local Gates

Required before remote deployment:

```sh
npm run check
npm run check:migrations
npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json
```

Run targeted tests for all touched areas, then a broader test suite if runtime allows.

### 14.2 Local Migration Dry Run

Run the seeded DB scenarios in Section 10.

Save before/after row counts for:

- users
- conversations
- messages
- artifacts
- artifact chunks
- artifact links
- generated files
- semantic embeddings
- admin_config
- every `deep_research_%` table before the drop

The expected result is not "fewer rows everywhere". The expected result is:

- Deep Research rows gone.
- Explicitly targeted Deep Research artifacts gone.
- Unrelated rows unchanged.

### 14.3 Remote Deployment

Before remote deployment:

1. Back up the remote DB.
2. Run the migration on a remote DB copy if possible.
3. Verify the same row-count diff on the copy.
4. Deploy code and migration together.
5. Watch logs for missing table errors, stale config errors, and artifact lookup errors.
6. Smoke test:
   - Login.
   - Normal Chat send.
   - Normal Chat stream.
   - `research_web`.
   - File production.
   - Generated file preview/download.
   - Account archive.
   - Settings admin page.

## 15. Rollback Plan

Code rollback alone will not restore purged data.

Before deployment, create a DB backup that can be restored.

If the migration deletes wrong data:

1. Stop the service.
2. Restore DB backup.
3. Revert code deployment.
4. Restart service.
5. Re-run smoke tests.

If code fails but data purge was correct:

1. Prefer forward-fix if the failure is small.
2. If rollback is needed, restore both code and DB backup because old code expects Deep Research tables.

## 16. Completion Criteria

The removal is complete only when all of these are true:

- No active UI can start Deep Research.
- No API route can start, advance, approve, cancel, discuss, or research further from Deep Research.
- No background Deep Research worker starts.
- No `DEEP_RESEARCH_*` config key is parsed, surfaced, or stored.
- No `deepResearchDepth` payload field remains.
- No `deepResearchJobs` conversation detail field remains.
- No `ResearchCard` component remains.
- No `deep_research_%` table remains after migration.
- No Deep Research report artifact remains if the purge policy is to delete all related data.
- No unrelated generated files or artifacts are deleted.
- Normal Chat, web research, file production, document workspace, and context compression still pass tests/smokes.
- `npm run check` is clean.
- `npm run check:migrations` is clean.
- Fallow has no stale Deep Research suppressions.
- Residual keyword search is fully classified.
- AGENTS.md and CONTEXT.md no longer describe Deep Research as active.

## 17. If A Future Agent Gets Lost

Use this recovery loop:

1. Stop editing.
2. Run the residual search in Section 11.
3. Categorize every hit as:
   - delete whole file
   - surgical rewrite
   - data migration
   - test rewrite
   - docs rewrite
   - keep shared
   - historical doc intentionally retained
4. If a hit does not fit one category, do not delete it yet.
5. Re-read the keep boundary in Section 13.
6. Re-run the seeded DB checks before claiming success.

## 18. Short Version For Commit Review

Reject the removal PR if any of these are true:

- It deletes broad artifact or generated-file categories.
- It rewrites historical migrations without an explicit migration-squash decision.
- It removes `research_web` or web-grounding infrastructure.
- It removes Normal Chat `/depth` or `ReasoningDepth`.
- It leaves `DEEP_RESEARCH_*` config keys.
- It leaves `deepResearchDepth` in request/session payloads.
- It leaves `.fallowrc.json` Deep Research ignores.
- It has no seeded DB proof that unrelated artifacts survive.
- It has no fresh DB and upgrade DB migration proof.
- It has no post-removal residual keyword audit.
