# Memory v2 internal hardening: one write door, one read seam, one dispatch, one control-model adapter, one scheduler

Accepted. A hardening loop over the Memory v2 store landed two watermark-correctness defect fixes and six module-boundary deepenings (D1, D2, C1–C6). This is an **internal architecture change with no user-facing product change**: memory still behaves as **ADR-0045 (Memory v2: judge-gated local memory)** describes it. This ADR **amends ADR-0045** by recording the module boundaries the product design now rests on, so a later change does not silently re-collapse them. ADR-0045 remains the authority for *what* Memory v2 is and why Honcho was removed; this ADR records *how* the implementation is now factored. Do not re-explain the product design here.

> **Recorded 2026-07-11.** The work merged the same day as `5cee9e59` ("Merge Memory v2 hardening: 2 defect fixes + 6 deepenings"), on top of the retroactively-recorded ADR-0045. The read-side deliberation gate that completes C6 landed in a follow-up merge (`memory-gate-deliberation`).

## What changed

Two correctness defects and six deepenings, each a TDD'd module-boundary move rather than a behavior change:

- **D1 — judge never marks unseen messages as judged.** `memory-judge/segment.ts` drains a conversation's unjudged backlog **oldest-first**, capped at `maxMessages`, and advances `conversationMemoryWatermarks.lastJudgedSequence` only to the highest sequence in the batch it actually judged. Surplus below the cap stays unjudged (the segment reports a positive residual so the caller re-drains in a later pass), instead of jumping the watermark to the top of the full set and silently skipping messages the judge never saw.
- **D2 — the explicit "remember" path advances the watermark only when no backlog exists below the exchange.** An explicit request judges its own exchange immediately, but it moves the watermark forward only if there is nothing older still unjudged; otherwise the watermark stays put so the marathon/idle/sweep triggers still drain the backlog.
- **C1 — one write door.** `memory-profile/projection-store.ts` is the sole write authority for `memoryProfileItems` and the projection revision. The `bumpProjectionRevision` escape hatch is deleted (a seam guard test asserts it exists nowhere), and the review↔store dependency cycle is broken by extracting `memory-profile/review-resolution.ts`.
- **C2 — one dispatch.** `judgeFinishedTurn` (`memory-judge/dispatch.ts`) owns the three-tier trigger decision (explicit / marathon / idle); `chat-turn/finalize.ts` calls that one entry rather than branching over triggers itself.
- **C3 — one read seam.** `getMemoryForTurn` (`memory-context/read.ts`, surfaced via `memory-context.ts`) owns the turn read path — single-source persona and uniform sanitization for both baseline injection and the recall tool.
- **C4 — one control-model adapter.** `callMemoryControlModel` (`memory-control-model.ts`) owns the structured control-model call for every memory feature (judge, consolidation, summary, re-curation), including the chain-of-thought-off and reasoning-aware-budget decisions from ADR-0045.
- **C5 — one scheduler.** A single night-shift spine runs on the generic `interval-job.ts` scheduler (`createIntervalJob`), driven by `memory-maintenance.ts` (`ensureMemoryMaintenanceScheduler`), instead of a bespoke `setInterval` per maintenance concern.
- **C6 + deliberation gate — one master gate, enforced everywhere memory is read.** `isMemoryActiveForConversation` (`memory-controls.ts`) is enforced on **both** read paths: baseline profile injection (`chat-turn/context-selection.ts`) and the `memory_context` recall tool (`chat-turn/normal-chat-tool-gating.ts`), **and** on the deliberation runner (`chat-turn/deliberation-runner.ts` `createDeliberationTools`), which withholds `memory_context` from the deliberation sub-model when memory is inactive. All read call sites fail open (treat memory as active on a controls-lookup error) so a controls outage never silently drops recall.

## Considered Options

- **Leave the store as-is.** Rejected: the two watermark defects were latent correctness bugs, and the diffuse write/read/dispatch surface made the ADR-0045 invariants (auditability, single authority, read/write master gate) impossible to enforce locally.
- **One large refactor.** Rejected in favor of independently TDD'd defect fixes and deepenings, each with its own seam guard test, so a regression points at one boundary.
- **Fix defects, skip the deepenings.** Rejected: the defects were symptoms of the missing boundaries (e.g. multiple write paths, watermark advanced by whichever trigger ran first); the deepenings are what keep them fixed.

## Consequences

- **The module boundaries are load-bearing, not incidental.** The single write door (C1), read seam (C3), dispatch (C2), control-model adapter (C4), and scheduler (C5) each have a seam/guard test. Reintroducing a second write path, a parallel read assembly, or a bespoke memory scheduler is a regression against this ADR, not a stylistic choice.
- **The read master gate is now symmetric.** Every place memory is read — baseline injection, the recall tool on the main path, and the deliberation runner — checks `isMemoryActiveForConversation`. A new memory read site must go through the same gate. ADR-0045's read-gate description and CONTEXT.md are updated to name the deliberation runner as a gated read site.
- **No product-visible change.** Users see the same Memory v2 behavior as ADR-0045; this loop bought correctness and enforceable boundaries, not features. ADR-0045 stays the product-design authority.
