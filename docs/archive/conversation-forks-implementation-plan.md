# Conversation Forks Implementation Plan

This local issue breakdown turns ADR 0010 into production-ready tracer-bullet slices. Do not create GitHub issues from this document unless explicitly asked.

Primary references:

- `CONTEXT.md` language: Conversation Fork, Fork Boundary Marker, Fork Origin Marker, Conversation Fork Indicator.
- `docs/adr/0010-conversation-forks-are-snapshot-conversations.md`
- `AGENTS.md` chat, conversation, artifact, memory, and localization boundaries.
- Context7 docs were checked for current SvelteKit endpoint patterns and Drizzle SQLite schema/migration patterns before drafting this plan.

## V1 Workflow Bar

Conversation Fork v1 is done only when a user can:

- fork from a completed assistant response;
- land in the new fork with copied history, a visible Fork Boundary Marker, empty composer state, and usable inherited context;
- see a compact Conversation Fork Indicator in conversation lists;
- return to the source and see a Fork Origin Marker plus on-demand fork details;
- continue chatting in the fork with copied history, documents, and generated work available to Context Selection;
- refresh source and fork without losing lineage markers, artifacts, or indicators;
- delete either source or fork without corrupting the other branch;
- trust that copied history was not replayed into memory, analytics, Honcho, task checkpoints, summaries, or generated-work side effects.

## User Stories

- **US1 - Fork from here**: As a user, I can fork from a completed assistant response and continue in a new conversation.
- **US2 - Understand lineage**: As a user, I can tell which conversations are forks and where a fork came from.
- **US3 - Keep working context**: As a user, I can keep using documents, attachments, and generated work that were visible before the fork point.
- **US4 - Avoid duplicate memory/cost**: As a user/admin, I do not want copied history to create duplicate usage, memory, or external mirror records.
- **US5 - Survive source changes**: As a user, I can edit, regenerate, delete, or seal source conversations without silently changing existing forks.
- **US6 - Production UX**: As a user, fork UI is localized, accessible, refresh-safe, and visually clear enough to notice while scanning.

## Slice 1: Text-Only Conversation Fork Tracer Bullet

**Type**: AFK
**Blocked by**: None
**User stories covered**: US1, US2, US4, US6

### What to build

Implement the smallest production path for creating a Conversation Fork from a completed assistant response in a text-only conversation. The fork creates a new open conversation, copies messages through the selected assistant response with new message identities and copy-lineage metadata, persists fork lineage, opens the fork, and renders a refresh-safe Fork Boundary Marker. The action must be unavailable for in-progress, failed, stopped, or client-only assistant responses.

The lineage store should support lookup by fork conversation and by source assistant response. It should record the fork conversation, source conversation, source assistant response, copied fork-point response, source title snapshot, fork sequence number, owner, and creation time.

### Acceptance Criteria

- [x] A completed assistant response can be forked into a new open conversation.
- [x] Source messages after the selected assistant response are excluded.
- [x] Copied messages have new identities and compact source-message lineage metadata.
- [x] The fork opens immediately with empty fork-local composer state and no automatic Normal Chat turn.
- [x] The Fork Boundary Marker persists across refresh and is not stored as a chat message.
- [x] Ineligible assistant responses do not expose or complete the fork action.
- [x] The route is a thin conversation-lifecycle adapter that delegates durable copy behavior to a server service.
- [x] The first fork title uses the predictable source-title fork naming rule.
- [x] English and Hungarian strings exist for the initial action, boundary marker, loading state, and failure state.

### Verification

- Service tests for text-only fork creation, source truncation, new message ids, per-message lineage, and fork-lineage lookup.
- Route tests for auth, missing source conversation, invalid source assistant response, and successful creation response.
- Component or page tests for action eligibility, navigation intent, empty composer state, and persisted Fork Boundary Marker rendering.
- Migration checks for the fork-lineage table and indexes.

## Slice 2: Source-Side And Sidebar Fork Awareness

**Type**: AFK
**Blocked by**: Slice 1
**User stories covered**: US2, US5, US6

### What to build

Expose fork metadata in conversation detail and conversation list payloads. Source messages with child forks show a visually scannable Fork Origin Marker and compact fork awareness with on-demand details. Forked conversations show a compact Conversation Fork Indicator in the conversation list with accessible hover/focus text. Multiple forks from the same source conversation receive lineage-based title suffixes, independent of user-edited fork titles.

### Acceptance Criteria

- [x] Conversation detail includes fork origin metadata for the current fork when applicable.
- [x] Conversation detail includes compact source-message fork metadata for messages with child forks.
- [x] Conversation list items include only the minimal fork summary needed for the sidebar indicator.
- [x] A source assistant response with one fork can open or reveal that fork from the message context.
- [x] A source assistant response with multiple forks shows count-first awareness and on-demand fork titles/links.
- [x] The sidebar indicator is a compact icon with accessible hover/focus text, not a nested branch tree.
- [x] Fork title suffixes are lineage-based and keep incrementing even if older forks were renamed.
- [x] Fork metadata remains correct after refresh.
- [x] English and Hungarian strings cover the source marker, fork count, sidebar tooltip, and source navigation labels.

### Verification

- API tests for detail and list payloads with zero, one, and multiple forks.
- Service tests for lineage-based fork sequence and title generation.
- Component tests for Fork Origin Marker, fork details disclosure, and sidebar indicator accessibility.
- Refresh-state tests proving markers survive a full conversation reload.

## Slice 3: Memory, Analytics, Evidence, And Context Safety

**Type**: AFK
**Blocked by**: Slice 1
**User stories covered**: US3, US4, US6

### What to build

Make inherited copied history usable as Available Context while keeping it distinguishable from fork-local turns. Preserve inherited assistant Message Evidence as snapshot evidence. Ensure copied history does not create new usage events, cost totals, Honcho messages, task checkpoints, conversation summaries, generated-output side effects, or one-event-per-turn memory records. Fork creation records one compact local lineage event.

### Acceptance Criteria

- [x] Copied messages can contribute to future Prompt Context as conversation history.
- [x] Context/debug surfaces can distinguish inherited copied turns from fork-local turns.
- [x] Inherited assistant responses preserve original Message Evidence as snapshot evidence.
- [x] Copied history does not create new usage events or count toward fork-local cost totals.
- [x] Copied history is not replayed to Honcho or other external memory mirrors.
- [x] Fork creation records one compact local lineage event.
- [x] Future fork-local turns behave normally for memory, analytics, evidence, summaries, and Honcho.
- [x] Conversation summaries and task-state updates are not triggered by fork creation itself.

### Verification

- Service tests proving fork creation does not call or create analytics, Honcho mirror, task checkpoint, conversation summary, or generated-output side-effect records for copied turns.
- Conversation-detail tests proving inherited Message Evidence is present as snapshot evidence.
- Chat-turn/context tests proving copied history is available for prompt history while inherited provenance remains available.
- Cost-summary tests proving copied history does not affect fork-local totals.

## Slice 4: Durable Document And Attachment Continuity

**Type**: AFK
**Blocked by**: Slice 1, Slice 3
**User stories covered**: US3, US6

### What to build

Preserve uploaded documents, normalized documents, message attachments, and durable Library document relationships that are visible in copied history. Durable document artifacts should be linked into the fork rather than duplicated. Missing or unauthorized documents that are required by copied visible history should fail fork creation clearly rather than silently creating a degraded fork.

### Acceptance Criteria

- [x] Message-level attachments from copied turns appear on copied messages in the fork.
- [x] Durable source and normalized document artifacts remain usable in the fork through links, not duplicate artifacts.
- [x] Linked documents used by copied history are available as Available Context for future fork-local turns.
- [x] Fork creation fails clearly if a required visible durable document or attachment cannot be linked.
- [x] Failure does not leave partial fork conversations, partial copied messages, or partial artifact links.
- [x] No new Honcho artifact sync or duplicate upload event is created for linked copied documents.

### Verification

- Service tests for copying message attachment links to new message ids.
- Artifact-link tests for durable source and normalized document continuity.
- Failure tests for missing, unauthorized, and partially linked artifact scenarios.
- Prompt-context tests proving linked copied documents remain usable in future fork-local turns.

## Slice 5: Generated Work Snapshot And Fork-Local Document Families

**Type**: AFK
**Blocked by**: Slice 1, Slice 3
**User stories covered**: US3, US5, US6

### What to build

Snapshot conversation-owned generated work that appears in copied history. Generated-output artifacts copied into the fork should become fork-local generated-document families while retaining origin lineage to the source generated work. Required generated-file binary storage must be staged or copied before committed fork records can point at it. A fork should fail clearly instead of silently omitting generated work.

### Acceptance Criteria

- [x] Generated outputs visible in copied history appear in the fork.
- [x] Copied generated outputs belong to the fork conversation and do not rely on the source conversation for retrieval authority.
- [x] Copied generated outputs start fork-local generated-document families.
- [x] Origin lineage to the source generated work is preserved.
- [x] Later refinements in the source do not mark fork-local generated work as superseded or historical, and vice versa.
- [x] Generated-file binary storage exists before committed fork records reference it.
- [x] Fork creation fails clearly if required generated work or binary storage cannot be copied.
- [x] Failure cleanup removes staged binary copies or partial records.

### Verification

- Service tests for generated-output snapshot creation, metadata, origin lineage, and fork-local family identity.
- File-storage tests for successful binary copy, missing binary failure, and cleanup after failure.
- Document-workspace tests proving fork-local generated families do not cross-supersede source families.
- Conversation-detail tests proving generated work cards survive fork refresh.

## Slice 6: Lifecycle Guards For Streaming, Edits, Regeneration, And Deletion

**Type**: AFK
**Blocked by**: Slice 2, Slice 4, Slice 5
**User stories covered**: US5, US6

### What to build

Harden fork behavior around active streams and destructive source lifecycle actions. Fork creation must not implicitly stop or detach an active stream. Editing or regenerating source history that has forks warns that existing forks remain unchanged. Deleting a source conversation does not delete forks; fork origin navigation degrades to stored source-title lineage. Deleting a fork updates source-side fork awareness without mutating the source transcript.

### Acceptance Criteria

- [x] Fork action is unavailable for the active streaming response.
- [x] Forking older completed responses does not implicitly stop or detach the active stream; if safe navigation is not possible, the user must wait or stop explicitly.
- [x] Editing or regenerating source history with forks warns that existing forks remain unchanged.
- [x] Deleting a source conversation leaves fork conversations intact.
- [x] Fork origin UI degrades gracefully when the source conversation is unavailable.
- [x] Deleting a fork removes that fork and updates source-side fork awareness when the source remains available.
- [x] Deleting a fork does not mutate the source transcript.
- [x] English and Hungarian strings cover the warnings and degraded-source states.

### Verification

- Route/service tests for deleting source and deleting fork.
- Component tests for edit/regenerate warning when forked source history is affected.
- Stream-state tests for fork action eligibility and no implicit stream stop/detach.
- Refresh tests for source-unavailable origin banner behavior.

## Slice 7: Production UX, Accessibility, Localization, And E2E Flow

**Type**: AFK
**Blocked by**: Slice 2, Slice 4, Slice 5, Slice 6
**User stories covered**: US1, US2, US3, US5, US6

### What to build

Complete the production v1 UX pass. Opening a fork should feel visually continuous rather than flashing abruptly. Fork Boundary Marker and Fork Origin Marker should have enough accent treatment and vertical presence to be noticed while scanning, without becoming cards inside cards or a branch explorer. All fork UI must be accessible, localized in English and Hungarian, responsive, and covered by an end-to-end smoke flow.

### Acceptance Criteria

- [x] Opening a fork uses a smooth reduced-motion-aware transition.
- [x] Fork Boundary Marker and Fork Origin Marker are visually scannable and persist after refresh.
- [x] Sidebar Conversation Fork Indicator remains compact and accessible.
- [x] Keyboard and screen-reader users can create a fork, navigate to it, understand the fork boundary, and return to source/fork details.
- [x] All visible fork strings, warnings, errors, and tooltips are localized in English and Hungarian.
- [x] Desktop and mobile layouts avoid overlapping text, hidden controls, or clipped lineage markers.
- [x] Playwright smoke covers fork creation, navigation, refresh, sidebar indicator, source marker, continued fork-local send, and deletion/degraded source behavior.
- [x] The V1 Workflow Bar at the top of this document passes end to end.

### Verification

- Component accessibility tests for fork action, indicators, markers, and details disclosure.
- i18n coverage check for fork keys in English and Hungarian.
- Playwright tests for the complete v1 workflow across refresh.
- Manual browser verification for desktop and mobile viewports after implementation.

## Out Of Scope For V1

- Full lineage tree explorer.
- Inline alternate branches inside a single conversation transcript.
- Background "create fork but stay here" action.
- Fork comparison UI.
- Fork merge.
- Fork analytics dashboards.
- Replaying copied history into Honcho or external memory.
- Treating Fork Boundary Markers or Fork Origin Markers as chat messages.

## Review Questions

- Does the slice granularity feel right for independently grabbable work?
- Are any dependencies too strict or too loose?
- Should artifact continuity and generated-work snapshotting be split further after implementation discovery?
- Are all slices correctly marked AFK now that the product decisions are recorded in ADR 0010?
