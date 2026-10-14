# Profile Memory

Task/document continuity and profile memory are separate subsystems. Continuity lives on `task-state.ts`; durable profile memory (facts about the user) is owned by the local Memory Profile Projection plus the LLM intake judge and nightly consolidation. There is no external memory service.

- Continuity boundary:
  - [`src/lib/server/services/task-state.ts`](../task-state.ts) plus its internal modules under `task-state/` (control-model, continuity, artifacts, chunk-sync, mappers)
- Profile memory judge (intake):
  - [`src/lib/server/services/memory-judge/`](../memory-judge/) — `index.ts` (per-segment run), `runner.ts` (idle/dirty sweep), `segment.ts` (watermarks), `prompt.ts`, `schema.ts`
- Consolidation (nightly rework):
  - [`src/lib/server/services/memory-consolidation/`](../memory-consolidation/) — `index.ts` (runner + scheduler), `steps.ts` (expire/renew, reconcile/merge), `summary.ts` (persona summary)
- Recuration (one-time cleanup):
  - [`src/lib/server/services/memory-recuration.ts`](../memory-recuration.ts)
- Fact store authority:
  - [`src/lib/server/services/memory-profile/`](./) — see its narrow seams (`projection-store.ts`, `read-model.ts`, `active-context.ts`, `telemetry.ts`, `review.ts`, `dirty-ledger.ts`, `types.ts`)
- Recall into prompts:
  - [`src/lib/server/services/memory-context/`](../memory-context/)
- Public read facade + maintenance/orchestration:
  - [`src/lib/server/services/memory.ts`](../memory.ts), [`src/lib/server/services/memory-maintenance.ts`](../memory-maintenance.ts)
- Event log:
  - [`src/lib/server/services/memory-behavior-log.ts`](../memory-behavior-log.ts)


Rules:

- `memory-judge/` is the only intake path from conversation into profile memory. It runs on three tiers of triggers — idle (deferred after a turn), explicit (user asks to remember), and marathon/sweep (long or backlogged conversations) — over the unjudged segment tracked by per-conversation watermarks in `segment.ts`. Advance the watermark only after a real run; never re-judge already-judged messages.
- The judge admits candidates through five gates in `schema.ts` (hedge, evidence-trail, third-person, missing-expiry for time_bound, missing-target for update/strengthen). Keep the gate order and reasons stable; post-filter rejects must stay measurable via the `judge_candidate_rejected` intake telemetry rather than being dropped silently.
- Honour the dry-run switch (`MEMORY_JUDGE_DRY_RUN`): in dry-run the judge records `judge_dry_run_decision` telemetry and advances the watermark but writes no profile items. Do not add a second dry-run flag or bypass it in routes.
- `memory-consolidation/` is revision-based and per-user isolated: expire/renew then reconcile/merge steps run against the current projection revision, write a report row per non-skipped run, and refresh the persona summary. Change detection may skip a user with nothing new. Never let one user's consolidation read or write another user's items.
- `memory-recuration.ts` is a one-time, admin-triggered rewrite/cleanup of the existing fact store; it is not part of the per-turn path. Do not wire it into chat routes or the scheduler.
- `memory-profile/` is the authority on fact state: item `status` (including `retired`), provenance, and projection revisions. User-protected items — `user_authored` items and facts the user accepted in Guided Memory Review (true `origin` kept, `endorsement: "user_accepted"` added) — must never be rewritten, retired, merged, superseded, or deleted by the judge, consolidation, or recuration; the user can still edit or remove them. The one exception is consolidation's renew step: an accepted (not `user_authored`) time-bound fact is renewed on the same recent-evidence rule as any other time-bound fact, and only its `expiresAt`/`updatedAt` change, because its expiry was inferred; a `user_authored` fact's end date is the user's own and is never auto-extended. Automated writers gate on the single predicate `isUserProtectedMemoryMetadata` (or `readMemoryItemUserProtection` when the reason matters, as renew does) in `memory-profile/types.ts`; read item metadata through `parseMemoryItemMetadata`. Do not re-implement origin or endorsement checks locally.
- Recall belongs to `memory-context/`: the prompt gets the persona summary plus active facts, each fact carrying its own evidence. Do not build a second lexical/semantic persona search surface beside this boundary, and do not invent "today/now" timing for undated facts.
- `memory.ts` is the public read facade for the Knowledge Base Memory Profile and keeps `/api/knowledge/memory/overview` as a projection-backed wrapper. It must not depend on a live external overview service, raw markdown cleanup, or task-memory tables.
- `memory-behavior-log.ts` owns the persisted normalized event log (recorded via `recordMemoryBehaviorEvent`, backed by the `memory_events` table) for important state changes (deadlines, preference updates, fact replacement, project continuity transitions, document supersession). Add new event types there; do not create ad hoc side logs or route-local event tables.
- `memory-maintenance.ts` owns per-user maintenance scheduling and lazy semantic-embedding backfill. Chat-triggered maintenance stays serialized/debounced there; generated-output duplicate repair and dormant-family (`historical`) downgrades reuse `evidence-family.ts` from there rather than a separate sweep. Historical families are soft-deprioritized, not hidden.

Do not:

- create a new top-level continuity service when `task-state.ts` can own the behavior
- add a second intake path, regex persona pipeline, or temporal-truth/salience/supersession subsystem outside `memory-judge`/`memory-consolidation`/`memory-profile`
- copy the `user_authored`/metadata parse helpers, `clip`, token estimation, or prompt-compaction helpers into another service
- create or restore `project-memory.ts`, `persona-memory.ts`, or any external memory adapter (e.g. the removed Honcho dual-brain — memory is local-only, see ADR-0045)
