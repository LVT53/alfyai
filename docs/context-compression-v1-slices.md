# Context Compression v1 Slices

These are local `$to-issues` slices for **Context Compression**. They are not published tracker issues. The ordering keeps configured model-window budgeting and raw chat history safety stable before enabling automatic overflow handling.

## Scope

Context Compression v1 replaces silent deterministic overflow loss with on-demand LLM-produced **Context Compression Snapshots**. It preserves **Context Selection** as the source of truth for choosing candidate **Prompt Context**, uses the user's selected response model for compression, keeps raw messages and source records untouched, and makes manual or automatic compression visible in the chat timeline.

The production target is not background summarization. Compression should happen only when the user explicitly runs `/compact` or when a model-call boundary would otherwise exceed the active model's configured **Context Budget**.

## User Stories

- As a user, long chats should remain faster and more stable without lowering model reasoning quality.
- As a user, I should know when context was manually or automatically compacted.
- As a user, I should be able to run `/compact` to reduce conversation drift.
- As an operator, configured model context settings should control the budget; hardcoded low caps should not override them.
- As a user, raw chat history, files, tool records, Message Evidence, memory, exports, and retries should keep using raw source records rather than compressed snapshots.
- As a maintainer, the feature should be verifiable locally and then against live inference after deployment.

## Slice 1: Preserve Per-Model Context Budget Authority

**Type**: AFK

**Blocked by**: None

**User stories covered**: configured model limits control prompt sizing; long chats avoid arbitrary low caps.

### What to build

Make the configured model settings the authority for **Max Model Context**, **Target Constructed Context**, and **Compaction Threshold** throughout Normal Chat and Deep Research prompt budgeting. Remove any recent arbitrary low default caps from the implementation and add regression coverage so future compression work cannot reintroduce them accidentally.

### Acceptance criteria

- [ ] Unset target/threshold values derive from the selected model's usable context capacity, not from a small fixed cap.
- [ ] Explicit admin/provider target and threshold values override derived defaults.
- [ ] Local model names such as GPT-OSS are not hardcoded when configured admin fields already provide the limit.
- [ ] Working-set and document budgets are not silently lowered below the model-scaled policy.
- [ ] Tests cover global, model-specific, and provider-specific budget resolution.

### Blocked by

None - can start immediately.

## Slice 2: Persist Context Compression Snapshots With Lifecycle Cleanup

**Type**: AFK

**Blocked by**: Slice 1

**User stories covered**: raw history remains intact; compressed state is linked and not database noise.

### What to build

Add conversation-owned **Context Compression Snapshot** records with source coverage metadata and status. Snapshots should be linked to the raw messages, source ranges, and source groups they summarize. Conversation deletion and message edit/delete flows must hard-delete affected snapshots through the same cleanup boundaries used for normal chat-turn storage.

### Acceptance criteria

- [ ] Snapshots are stored separately from chat messages and assistant-message metadata.
- [ ] Snapshot records include conversation ownership, trigger, status, selected model, source coverage, token estimates, and structured snapshot JSON.
- [ ] Deleting a conversation deletes its snapshots.
- [ ] Deleting or editing a covered or earlier message hard-deletes affected snapshots.
- [ ] Orphaned snapshot rows cannot survive normal conversation/message cleanup.

### Blocked by

- Slice 1

## Slice 3: Build The Selected-Model Compression Service And Validator

**Type**: AFK

**Blocked by**: Slice 2

**User stories covered**: compression uses the user's selected model; invalid summaries do not become Prompt Context.

### What to build

Create the app-owned compression service that asks the user's selected response model to produce a structured **Context Compression Snapshot**. The service should validate the result before it is marked valid. V1 should not introduce a separate admin-configured compressor model.

### Acceptance criteria

- [ ] Compression calls use the selected response model and its configured model-window limits.
- [ ] Snapshot output is structured and preserves current goal, active decisions, open questions, relevant user preferences, working artifacts, tool state, source coverage, and limitations.
- [ ] Validation rejects invalid schema, oversized output, missing source coverage, split tool call/result coverage, raw oversized blobs, and internal reasoning tags.
- [ ] Validation failure can retry once with stricter instructions.
- [ ] Failed compression records a failed status or failure reason without mutating raw chat messages.

### Blocked by

- Slice 2

## Slice 4: Manual `/compact` Command With Timeline Marker

**Type**: AFK

**Blocked by**: Slices 2 and 3

**User stories covered**: users can manually compact; users see visible compacting/compacted state.

### What to build

Add manual `/compact` as a Composer command that creates a visible compression marker, runs compression against the completed conversation state, and marks the snapshot valid or failed. If an assistant turn is active, queue manual compaction behind that turn instead of interrupting or compressing partial streaming state.

### Acceptance criteria

- [ ] `/compact` appears in the slash-command flow with localized English and Hungarian copy.
- [ ] Running `/compact` while idle shows an in-progress timeline marker and then a completed "Compacted context" marker.
- [ ] Running `/compact` during an active assistant turn queues compaction behind the active turn.
- [ ] Manual compaction can run even when current context already fits, unless no relevant raw/source state changed since the last valid snapshot.
- [ ] Compression markers are timeline events backed by snapshot status, not normal user, assistant, or system messages.

### Blocked by

- Slice 2
- Slice 3

## Slice 5: Prompt Assembly Prefers Snapshot Plus Recent Raw Turns

**Type**: AFK

**Blocked by**: Slice 4

**User stories covered**: manual compaction actually affects future prompts; recent conversation remains precise.

### What to build

Update Normal Chat prompt assembly so future turns prefer the latest valid **Context Compression Snapshot** for its covered older range while preserving raw recent turns after the snapshot and the current user message. Raw messages remain the source of truth for all non-prompt consumers.

### Acceptance criteria

- [ ] Prompt assembly can include the latest valid snapshot as readable model-facing context.
- [ ] Raw turns after the snapshot remain in Prompt Context as recent conversation context.
- [ ] Older covered raw history is not duplicated into the same prompt by default.
- [ ] Appended messages do not invalidate the snapshot.
- [ ] Snapshot invalidation happens only when covered source history changes.

### Blocked by

- Slice 4

## Slice 6: Hierarchical And Incremental Compression For Over-Window Inputs

**Type**: AFK

**Blocked by**: Slices 3 and 5

**User stories covered**: oversized conversations compress automatically without asking the user to rethink the request.

### What to build

Support compression inputs that are too large for the selected model in one pass. Chunk by source-aware natural boundaries, compress bounded chunks, and merge them into a final valid snapshot. Repeated compression should be incremental by default: latest valid snapshot plus raw turns after it, current selected source context, and current user intent.

### Acceptance criteria

- [ ] The compressor never sends more than the selected model's configured window to the selected model.
- [ ] Hierarchical chunks respect message pairs, tool call/result pairs, document sections, web/research excerpts, and log sections where possible.
- [ ] Snapshot chaining has no generation cap in v1.
- [ ] Automatic compression does not reopen older raw history merely because a snapshot exists.
- [ ] Exact older-content requests continue to flow through the existing Memory Context Tool or retrieval path as new selected Prompt Context.

### Blocked by

- Slice 3
- Slice 5

## Slice 7: Automatic Overflow Compression Before Initial Model Calls

**Type**: AFK

**Blocked by**: Slice 6

**User stories covered**: the app handles oversized selected context without silent deterministic loss.

### What to build

At the first model-call boundary of a user turn, check whether selected **Prompt Context** fits the active model's configured **Context Budget**. If it does not fit, automatically create or update a **Context Compression Snapshot**, show an automatic compression marker, then continue the same user turn without requiring intervention.

### Acceptance criteria

- [ ] The app checks model-window fit before sending the initial model call.
- [ ] If the selected prompt fits, no automatic compression runs.
- [ ] If it does not fit, automatic compression runs on demand and the turn continues after completion.
- [ ] The completed marker uses automatic wording such as "Automatically compacted context."
- [ ] The arbitrary deterministic truncation fallback is no longer the primary production path for useful selected context.

### Blocked by

- Slice 6

## Slice 8: Automatic Overflow Compression After Tool Calls And In-Generation Expansion

**Type**: AFK

**Blocked by**: Slice 7

**User stories covered**: post-tool GPT-OSS turns stay stable; all model-call boundaries are protected.

### What to build

Apply the same model-window fit check at every model-call boundary inside a user turn, including after tool calls. When a post-tool prompt would overflow, compact older selected context while keeping the just-returned tool result raw for the current turn.

### Acceptance criteria

- [ ] Post-tool prompts are checked before final generation continues.
- [ ] Active or in-flight tool calls are never compressed.
- [ ] The just-finished tool result remains raw selected context for the current turn.
- [ ] Completed older tool outputs can be summarized as structured tool state.
- [ ] Large raw JSON, logs, and page text are not replayed in full when summarized context is sufficient.

### Blocked by

- Slice 7

## Slice 9: Compression Failure, Context Limitation, And Raw-Content Boundaries

**Type**: AFK

**Blocked by**: Slices 5, 7, and 8

**User stories covered**: users are informed when compression cannot safely preserve enough context; dependent systems keep raw content semantics.

### What to build

Harden failure behavior and raw-content boundaries. Failed or timed-out compression should not silently continue with arbitrary truncation. Raw messages, files, tool records, Message Evidence, Honcho mirroring, memory extraction, file production, search indexing, exact retry/regenerate reconstruction, and conversation export must keep using raw records unless explicitly designed otherwise.

### Acceptance criteria

- [ ] Compression failure or timeout shows a failed or limited marker.
- [ ] If retry also fails, the system preserves the current user message, current tool result when present, and highest-priority protected context.
- [ ] The assistant continues only with a visible Context Limitation when the reduced context is likely useful.
- [ ] If no useful reduced context can fit, the turn stops with a clear recoverable error.
- [ ] Regression tests prove snapshots do not feed Honcho mirroring, durable memory extraction, Message Evidence, source audit, file-production source material, tool-call replay, exact retry/regenerate reconstruction, search indexing, or conversation export.

### Blocked by

- Slice 5
- Slice 7
- Slice 8

## Slice 10: Full Verification And Live Deployment Test

**Type**: AFK

**Blocked by**: Slices 1 through 9

**User stories covered**: the feature is verified locally and on the live deployment with real inference.

### What to build

Run the complete verification flow after implementation is merged. Verify local tests first, then deploy from git to the live service, restart the service, monitor logs, and run browser-level tests against the deployed app with the provided tester admin account. Do not store live credentials in code, docs, test files, screenshots, or logs. Langflow custom-node updates are no longer part of the active path; Normal Chat LLM behavior should be verified through the AI SDK model/tool services instead.

### Acceptance criteria

- [ ] Local unit, integration, type/check, and focused e2e tests pass.
- [ ] Database migrations and metadata checks pass.
- [ ] The deployed app starts cleanly after applying changes from git and restarting the service.
- [ ] Server logs show no compression-related errors during live manual `/compact`, automatic overflow, post-tool overflow, failure-free normal chat, and exact-history retrieval smoke tests.
- [ ] Live UI shows in-progress and completed manual/automatic compression markers.
- [ ] Live prompts preserve selected-model reasoning settings and per-model context budgets.
- [ ] Tester account settings are not changed except for intentional test setup that is restored before finishing.

### Blocked by

- Slice 1
- Slice 2
- Slice 3
- Slice 4
- Slice 5
- Slice 6
- Slice 7
- Slice 8
- Slice 9

## Review Questions

- Does the granularity feel right, or should the manual `/compact` path be split further?
- Are the dependency relationships correct?
- Should any automatic-overflow slices be merged or split further?
- Are all slices correctly marked AFK given the deployment permission and the Langflow-node manual-update caveat?
