# Memory Maintenance & Fact Quality — Roadmap

## Problem Statement

The AlfyAI memory system has three long-term maintenance faults:

1. **Memory events grow unbounded** — `pruneOldMemoryEvents` only prunes events >90 days old, keeping 5 per subject. There is no count-based cap. A heavy user accumulates thousands of events within the 90-day window.

2. **Contradicting facts in the Memory Overview** — The system confuses temporal facts (e.g., exam credits from 2023 vs 2024), mixes document-sourced facts with persona facts, and strips timestamps from the overview bullets, making contradictions impossible to resolve.

3. **Maintenance scheduler reliability** — The scheduler uses `unref()` which may allow the process to exit before the interval fires. Also, `MEMORY_MAINTENANCE_INTERVAL_MINUTES` is not in `ADMIN_CONFIG_KEYS`, so it cannot be set via the admin UI.

## Current State Analysis

### Event Accumulation

| Event Type | Creation Site | Frequency | Key Pattern |
|------------|--------------|-----------|-------------|
| `document_refined` | `chat-turn/finalize.ts:633` | Per turn | `document_refined:${family}:${msgId}` |
| `document_superseded` | `chat-files.ts:683` | Per file version | `document_superseded:${prev}:${current}` |
| `document_opened` | `behavior/+server.ts:42` | Per 30-min bucket | `document_opened:${subject}:${bucket}` |
| `project_started` | `task-state/continuity.ts:1408` | Per task-project link | `project_started:${project}:${task}:${hash}` |
| `project_paused` | `task-state/continuity.ts:1923` | Per user signal | `project_paused:${project}:${task}:${hash}` |
| `project_paused` (auto) | `task-state/continuity.ts:1996` | Per stale check | `project_paused:${project}:${updatedAt}:${status}` |

**Unused event types** (defined but no emitters): `persona_fact_updated`, `deadline_extended`, `deadline_completed`, `preference_updated`, `conversation_fork_created`

### Memory Overview Assembly

1. `memory.ts` loads raw Honcho peer context via `getPeerContext()` (line 145)
2. `knowledge/memory-overview.ts` shapes it:
   - Strips markdown headers, timestamps, section labels
   - Softens sensitive values (emails, phones, API keys)
   - Splits by newline or timestamp boundaries
   - **Exact-string deduplicates** bullets via `Set<string>` (no semantic comparison)
   - Caps at 40 bullets
   - Falls back to raw persona conclusion texts if Honcho overview is unavailable

### Maintenance Tasks (15 existing)

1. Repair generated-output retrieval classes (Jaccard 0.82)
2. Repair generated-output family statuses (active/historical)
3. Semantic embedding backfill (24h cooldown)
4. Prune task checkpoints (6 micro + 3 stable per task)
5. Archive stale task memory (30 days)
6. Update project memory statuses
7. Prune orphan project memory
8. **Prune old memory events** (90 days, 5 per subject) ← **The weak link**
9. Delete orphan semantic embeddings
10. Prune orphan conversation summaries
11. Prune orphan artifact chunks
12. Prune orphan memory projects
13. Delete orphan chat files (global, once per process)
14. Prune orphan Honcho sessions (global, once per process)
15. Disk reconciliation report (global, once per process)

### Missing Maintenance Tasks

- Task-state evidence link pruning (no cap)
- Archived task deletion (archived but never deleted)
- Semantic embedding pruning for task states
- Artifact link pruning
- Conversation context status pruning
- Memory event compaction / summarization
- Count-based safety caps
- Document fact expiration
- Honcho peer version reconciliation

## Roadmap

### Phase 1 — Immediate Stability (Implementable Now)

| # | Fix | File | Rationale |
|---|-----|------|-----------|
| 1.1 | Add count-based cap to `pruneOldMemoryEvents` | `memory-events.ts` | Prevents unbounded growth within 90-day window |
| 1.2 | Remove `schedulerHandle.unref()` or make it configurable | `memory-maintenance.ts` | Ensures scheduler keeps process alive |
| 1.3 | Add `MEMORY_MAINTENANCE_INTERVAL_MINUTES` to `ADMIN_CONFIG_KEYS` | `config-store.ts` | Allows admin UI visibility and control |
| 1.4 | Add per-domain event caps | `memory-events.ts` | Limits `document_refined`/`document_opened` accumulation |
| 1.5 | Add task-state evidence link pruning | `memory-maintenance.ts` | Cap at 128 links per task |
| 1.6 | Add archived task deletion (after 180 days) | `memory-maintenance.ts` | Clean up long-term archival |
| 1.7 | Add orphan semantic embedding cleanup for task states | `memory-maintenance.ts` | Currently only checks `artifact` subject type |

### Phase 2 — Fact Quality (Implementable Now)

| # | Fix | File | Rationale |
|---|-----|------|-----------|
| 2.1 | Preserve or re-add temporal context to memory bullets | `memory-overview.ts` | Distinguish "2023: 85 credits" from "2024: 90 credits" |
| 2.2 | Add source attribution to Honcho conclusions | `honcho.ts` | Tag `source: "document"` vs `source: "user"` |
| 2.3 | Filter document-sourced facts from memory overview | `memory-overview.ts` | Or show in a separate section |
| 2.4 | Add temporal contradiction detection | `memory-overview.ts` | When two facts share subject but differ value, prefer newer or show both |
| 2.5 | Add `observedAt` to memory overview bullets | `memory-overview.ts` | e.g., "User got 85 credits (2023-05-15)" |
| 2.6 | Add `factType` to `MemoryEvent` and `PersonaMemoryItem` | `types.ts` | Enable fact categorization |

### Phase 3 — Architectural Decisions (Needs Clarification)

| # | Topic | Open Questions | Decision Needed |
|---|-------|---------------|---------------|
| 3.1 | **Separate document facts from persona facts** | How do we represent a "document fact"? Is it a `MemoryEvent` with `factType: "document_reference"`, or is it a property of the `Artifact` itself? | Fact modeling strategy |
| 3.2 | **Event compaction / summarization** | Should we summarize events in-place (replace N rows with 1 row), or create a new `memory_event_summaries` table? How do we know which events are safe to summarize? | Compaction strategy |
| 3.3 | **Maintenance health monitoring** | What metrics do we track? Where do we store them? Do we need a new `maintenance_logs` table or just structured logging? | Monitoring strategy |
| 3.4 | **Manual maintenance trigger** | Should the admin UI expose a "Run Maintenance Now" button? What permissions does it need? | Admin UI design |
| 3.5 | **Document fact expiration** | When a document is deleted, should its facts be immediately removed, or should they expire after a grace period? What about historical documents? | Expiration policy |
| 3.6 | **Honcho peer version reconciliation** | Should maintenance verify that the local `users.honcho_peer_version` matches the Honcho peer state? If they drift, how do we repair? | Reconciliation strategy |
| 3.7 | **Memory event eventKey redesign** | Current keys are arbitrary strings. Should we use a structured key format (e.g., `domain:type:subject:version`) for better queryability? | Key design |

## Next Steps

1. **Phase 1** can be implemented immediately without further discussion.
2. **Phase 2** can be implemented once we decide on the exact format for temporal context in bullets.
3. **Phase 3** requires the **grill-with-docs session** below to resolve architectural decisions.

---

## Grill-With-Docs Session

**Purpose**: Resolve Phase 3 architectural decisions through structured questioning.

**Status**: Ready to begin. The session will walk through each Phase 3 topic and ask the user to clarify the desired approach.
