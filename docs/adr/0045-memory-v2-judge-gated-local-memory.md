# Memory v2: judge-gated local memory replaces the Honcho substrate

Accepted. AlfyAI memory is now a single app-owned store gated by an LLM **Memory Judge** and maintained by a nightly **Consolidation** pass. Honcho is removed entirely: there is no memory authority substrate behind the app, no message mirroring, and no asynchronous reconcile-later path. This ADR **supersedes ADR-0011 (Honcho-led Memory Context)** and **ADR-0039 (Deferred Memory Extraction restores Honcho as substrate)**, and **amends ADR-0033 (Guided Memory Review)** by removing every clause that treats Honcho as a background substrate. The design intent is recorded in `docs/superpowers/specs/2026-07-06-memory-v2-design.md`.

> **Recorded 2026-07-10, retroactively.** The work landed across 2026-07-06…08 (merge "Memory v2: judge-gated local memory, Honcho removal") without an ADR at the time. This document records the decision after the fact so the reversal of ADR-0011/0039 is not silently re-litigated.

## Why the reversal

ADR-0011 made Honcho the persona/memory authority and forbade "a parallel local persona-memory system." ADR-0039 doubled down: restore Honcho as the **Memory Authority Substrate**, keep the local projection as a read model, and have Honcho "catch up later." A 2026-07-06 production audit against the live database made the cost of that architecture concrete: 145 of 294 items (half the store) stuck in a `review_needed` queue; ~60–70% of derived facts were junk (frozen transient project state, pasted terminal output, hedged non-facts, near-duplicates); temporal metadata entirely unused (0/294 expiries); and a ~1,650-line dual-authority sync layer (identity rotation, orphan pruning, dirty-ledger reconciliation, reset generations) plus up to 3s of per-turn Honcho polling — all to keep two brains consistent for a ~5-user deployment. Honcho's beliefs formed outside our control and could not be individually corrected. At this scale Honcho's advantages are scale advantages we do not need; maintainability and auditability dominate. The ADR-0039 reconcile-later path was never realized in practice, and the accidental "local store as primary authority" state that ADR-0039 tried to fix is now the **deliberate** design.

## Definitions

**Memory Profile Projection** is the sole authority for durable memory. It is app-owned, revision-based, and auditable end to end (provenance to source messages, revision history, one-click undo). Nothing sits behind it.

**Memory Judge** (`src/lib/server/services/memory-judge/`) is the write gate. It replaces the regex intake parser. It sends a conversation's **unjudged segment** to a small configurable control model with structured output, and each candidate must pass a five-gate rubric — **stability** (still true in ~3 months, or time-bound with a mandatory expiry), **ownership** (about the user, in the user's own voice; rejects pasted logs, quoted/translated/edited text, role-play, hypotheticals), **usefulness**, **confidence** (`stated` or `inferred`; hedged statements are dropped, never hedged into the store), and **non-redundancy** (the judge sees nearest existing facts and returns `new` / `strengthens` / `updates` / `nothing`; updates create a revision, not a sibling). Admission is confidence-banded: high → `active`; uncertain → `review_needed` (hard cap ~10/user, auto-expiring ~30 days); low → a diagnostics stream that is never injected. Intake never blocks a chat turn.

**Three-tier judge triggers** are wired at the chat-turn finalize boundary (`chat-turn/finalize.ts`):
- **Explicit** — a "remember that…" / "jegyezd meg…" request judges that exchange immediately.
- **Marathon** — a hard cap forces a judge run every ~25 unjudged messages.
- **Idle** — a debounced (~`memoryJudgeIdleMinutes`) inactivity job judges the conversation's unjudged segment; opening another conversation opportunistically flushes a dirty one.
Plus **sweep** (nightly consolidation judges any dirty conversation the idle trigger missed — crash-safety) and **re-curation** (a one-time admin job). All funnel through `runMemoryJudgeOnSegment`.

**Conversation Memory Watermark** (`conversationMemoryWatermarks.lastJudgedSequence`, advanced monotonically in `memory-judge/segment.ts`) bounds each judge pass to messages not yet judged, so triggers are idempotent and cheap.

**Consolidation** (`memory-consolidation/`, "night shift") runs per user, only when something changed since the last run, on a `setInterval` scheduler (`ensureMemoryConsolidationScheduler`, period `memoryConsolidationIntervalMinutes`). Ordered revision-based steps: **expire** (retire past-expiry facts; renew time-bound facts with recent supporting activity), **reconcile** (contradiction pass; newer supersedes older with a link), **merge** (collapse near-duplicate clusters, union provenance), **summarize** (regenerate the persona summary). Each run appends a human-readable `memoryConsolidationReports` row rendered as the Memory-page night-shift timeline; failure of any step leaves that user's memory untouched and surfaces in the report.

**Persona Summary** (`memory-consolidation/summary.ts`) is a control-model synthesis of the user's top active facts into fact-linked sentences (`{ sentences: [{ text, factIds }] }`), stored on `memoryProjectionState` per user + reset generation. ADR-0011 listed a "local persona summary" as an explicit anti-goal; it is now a first-class artifact.

**One-time re-curation** (`memory-recuration.ts`, admin endpoint `api/admin/memory-recuration`) re-judges existing items in batches of 10 with a split-retry safety net so a failing half never silently drops the other half.

**Memory master toggle + incognito** (`memory-controls.ts`) is a dual gate: `users.memoryEnabled` (per user) and `conversations.memoryIncognito` (per conversation). `isMemoryActiveForConversation` is the single source of truth. It is enforced on the **read** side at both read call sites — the baseline profile injection (`chat-turn/context-selection.ts` `buildActiveMemoryProfilePromptSection`, covering the shallow and deep tiers) injects no memory section, and the `memory_context` recall tool is withheld from the model (`chat-turn/normal-chat-tool-gating.ts`) with the read seam (`getMemoryContext`) returning an inert empty result as a backstop — and on the **write** side (judge, consolidation, re-curation); it fails open on error so a controls outage never wipes recall.

## Operational decisions worth keeping

- **Chain-of-thought is off on every memory model call.** Judge, persona-summary, re-curation, and consolidation calls set `thinkingMode: "off"` (measured ~7× faster at equal quality on Qwen; see the self-hosted-vLLM thinking-off caveat). This is deliberate, not an oversight.
- **Reasoning-aware token budgeting.** `reasoningAwareMaxTokens` scales `max_tokens` with input size so a reasoning-capable model cannot exhaust its budget on reasoning and truncate the actual JSON output. Pairs with the chain-of-thought-off decision above.
- **Cache-aware memory cost.** Every memory model call is priced into telemetry with a provider cache hit/miss breakdown (`memory-cost.ts`), rolled up per feature (`judge | consolidation | summary | recuration`) for the admin cost view — not billed at the flat input rate.

## Considered Options

- **Keep ADR-0039's Honcho substrate + Tier-1/Tier-2 split.** Rejected: the reconcile-later path never materialized, the sync layer was the primary maintainability cost, and Honcho beliefs could not be individually corrected.
- **Real-time LLM extraction on every turn.** Rejected: latency and token cost on the hot path; intake must stay deferred/post-turn.
- **Regex-only intake (the accidental 2026-06 state).** Rejected: admitted the exact junk classes the audit found and missed nuanced statements.
- **Judge-gated local-only memory with nightly consolidation (chosen).** At ~5 users an LLM judge per conversation and a nightly consolidation per user cost pennies, and every memory becomes auditable and correctable in-repo.

## Consequences

- **Honcho is gone and stays gone.** `honcho.ts`, `mirrorMessage`, the context-selection polling wait, the dirty-ledger reconciliation, the legacy-curation modules, and the admin Honcho endpoint are deleted. `src/lib/server/services/no-honcho.test.ts` is a guard test asserting no Honcho references remain in `src`; treat a reintroduction as a regression. The chatgpt-import summarizer feeds imported-conversation summaries through the judge instead of mirroring.
- **We consciously lose Honcho's theory-of-mind synthesis and its free future improvements**, in exchange for a smaller, owned, auditable memory codebase. Accepted at this scale.
- **User-authored facts win.** Facts created via Correct or summary edits carry `origin: user_authored` and are never auto-retired or rewritten by consolidation without an explicit report entry.
- **ADR-0011 and ADR-0039 are historical.** Their "no parallel local persona-memory system" and "Honcho as Memory Authority Substrate" rules no longer apply. ADR-0033's intake-gate philosophy, confidence bands, Guided Memory Review, reset generations, and user-authored precedence **still hold**; only its Honcho-substrate framing is retired.
- **CONTEXT.md is stale on memory and must be corrected** — the "Honcho Authority Fallback", "Memory Authority Substrate", and Honcho-reconciliation terms describe an architecture that no longer exists. New product-language terms are needed for Memory Judge, three-tier triggers, Conversation Memory Watermark, Persona Summary, Consolidation / night shift, memory master toggle + incognito, and memory cost tracking. Internal contract terms (watermark, reasoning-aware token budget) need CONTEXT entries only if they become user-facing.
