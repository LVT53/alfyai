# Conversation forks are snapshot conversations with lineage

AlfyAI will implement Conversation Forks as new conversations that snapshot visible history through a selected completed assistant response, preserve direct lineage to the source conversation and source response, and continue independently from that point. Forks are not inline alternate branches inside one transcript, and creating a fork is not a Normal Chat turn.

Fork creation copies messages with new identities and preserves usable documents, attachments, generated work, and artifact relationships without replaying copied turns into analytics, Honcho, summaries, task checkpoints, memory events, or generated-work side effects. Durable document artifacts are linked into the fork, while conversation-owned generated work is snapshotted into fork-local generated-document families so later refinements in one branch do not supersede the other.

Fork lineage will be persisted in a dedicated lineage table keyed by the fork conversation, rather than hidden in message metadata or overloaded onto every conversation row. The lineage record stores the source conversation, source assistant response, copied fork-point response, title snapshot, fork sequence, owner, and creation time so source-message fork awareness and fork-origin rendering can be queried directly.

Each copied message will also carry compact copy-lineage metadata pointing to its source conversation and source message. The fork-level lineage table owns navigation and counts; per-message metadata exists for provenance, audits, and distinguishing inherited turns from fork-local turns without introducing a second message table.

The database portion of fork creation will be transactional. Required generated-file binary copies must be available before the fork becomes visible, with staging or cleanup around filesystem work so committed fork records do not point to missing files.

The fork API belongs to conversation lifecycle rather than chat-turn execution: route handlers should expose conversation-scoped fork endpoints and delegate durable copy logic to a server-side conversation-forks service. Browser calls should live with the existing conversation client API surface.

Conversation detail responses should include compact fork metadata for the current conversation's origin and for source messages that have child forks. That metadata should be sufficient to render the Fork Boundary Marker, Fork Origin Marker, and source-side fork awareness without ad hoc follow-up fetches in page code. Conversation list items should carry only a minimal fork summary for a compact accessible fork indicator.

All user-facing fork labels, tooltips, empty/degraded states, warnings, and errors should be localized in English and Hungarian in the first implementation slice.

Conversation Fork v1 should be a production slice, not a demo prototype: users must be able to create, recognize, open, continue, refresh, delete, and audit forks with artifact continuity and memory-safety guarantees intact.

**Considered Options**

- Keep one conversation and show inline alternate branches.
- Create a new conversation that live-references source transcript history.
- Create a new conversation that snapshots transcript history and stores lineage metadata.
- Replay copied history into memory, analytics, and external mirrors as if it happened again.
- Keep copied history local to the fork and mirror only future fork-local turns.

We chose snapshot conversations because the existing app treats conversations, messages, generated outputs, working sets, and memory side effects as durable boundaries. Inline branches would force the chat renderer, retry/edit paths, context selection, and sidebar to understand transcript trees. Live references would make forks fragile when the source conversation is edited, regenerated, deleted, or sealed. Replaying copied history would duplicate memories and usage records.

**Acceptance Scenarios**

- Forking a completed assistant response creates a new open conversation with copied visible history through that response.
- Source conversation messages after the fork-point response are excluded.
- Forking from an in-progress, failed, stopped, or client-only assistant response is not allowed.
- Inherited assistant responses inside a fork can become fork points for a new immediate child fork.
- Fork creation does not implicitly stop or detach an active stream.
- Copied messages have new message ids and retain source-message lineage.
- Copied message lineage is available per copied message without treating the copied row as a new model/user event.
- The fork starts in the same Project Folder as the source conversation by default and may be moved afterward.
- A sealed source conversation may produce an open fork because the source is not mutated.
- The fork shows a persisted Fork Boundary Marker after the copied fork-point response with enough visual weight to be noticed while scanning.
- The source assistant response persists a visually scannable Fork Origin Marker for auditability.
- The source assistant response shows compact fork awareness, with fork details available on demand.
- Forked conversations are identifiable in conversation lists with a compact icon and accessible hover/focus text.
- Fork UI strings, warnings, and errors are localized in English and Hungarian.
- Multiple forks from the same source conversation receive lineage-based title suffixes.
- Conversation Fork v1 is usable end to end, with refresh-safe UI state, artifact continuity, cleanup behavior, and regression coverage.
- A v1 user can fork, land in the fork, see copied history and fork boundary, continue with inherited context, refresh both source and fork, and still see correct lineage, artifacts, sidebar indicators, and source-side fork awareness.
- A new fork opens with empty fork-local composer state rather than inherited draft, queued, pending skill, or selected source chip state.
- Creating a fork opens the new fork for continued work without automatically sending a turn.
- Editing or regenerating source history that already has forks warns that existing forks remain unchanged.
- Deleting a source conversation does not delete its forks; fork origin navigation degrades to stored source-title lineage.
- Deleting a fork updates source-side fork awareness without mutating the source transcript.
- Durable uploaded or Library document artifacts are linked into the fork rather than duplicated.
- Generated outputs copied into the fork become fork-local generated-document families with origin lineage.
- Fork creation is atomic; failed fork creation does not leave partial copied history or partial artifact continuity.
- Committed fork records do not reference missing generated-file binary storage.
- Fork creation fails clearly rather than silently omitting copied visible documents, attachments, generated work, or required artifact relationships.
- Fork API routes stay thin and delegate durable copy behavior to the conversation-forks service boundary.
- Conversation detail includes compact fork origin and source-message fork metadata for rendering fork cues.
- Inherited assistant responses preserve their original Message Evidence as snapshot evidence.
- Inherited copied history does not create new usage events or count toward fork-local cost totals.
- Copied history is available for future Prompt Context but remains distinguishable from fork-local turns.
- Honcho and other external memory mirrors receive only fork-local future turns, not a replay of copied history.
- Fork creation records one compact local lineage event, not one event per copied turn.
- Fork lineage can be queried by fork conversation and by source assistant response without scanning message metadata.
