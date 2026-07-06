# Memory v2: Judge-Gated Local Memory (Honcho Replacement)

**Date:** 2026-07-06
**Status:** Approved design, pending implementation plan
**Owner decision trail:** full Honcho replacement; auto re-curation of existing data; full UI package; single-pass cutover (no Honcho grace period), gated on Phase-0 dry-run results.

## 1. Problem

Memory "feels off" and requires periodic manual pruning. A production audit (2026-07-06, live DB) made the causes concrete:

- **294 memory items total; only 104 active; 145 (half the store) stuck in a `review_needed` queue** from the June 2026 legacy curation — the manual burden made visible.
- **Legacy derived memories (~40 of the owner's 48 active) are majority junk**: transient project state frozen as permanent identity facts (~60–70%), extraction accidents from pasted terminal output ("is working on a server running AlmaLinux, as indicated by the filesystem device name…"), hedged non-facts ("has a bike or has a bike to which insurance might be applicable"), vacuous statements ("is working with a client"), and ~6 near-duplicates about a single project. Statements are third-person with peer tokens (`U_86dc59…`).
- **Current intake (`memory-profile/intake.ts`) is pure regex/heuristic parsing** — no LLM judgment. It admits pattern-matches (hypotheticals, quoted/translated text) and misses most nuanced statements. Post-regex-era items are clean but sparse (8 items in ~2 weeks).
- **Temporal metadata is entirely unused: 0 of 294 items have an expiry.** One-time events ("I filled the Erasmus Grant form") read as current state forever. Nothing ever revises anything.
- **Dual authority (local profile + Honcho)**: every message is mirrored to Honcho (`mirrorMessage`), a ~1,650-line sync layer (identity rotation, orphan pruning, dirty-ledger reconciliation, reset generations) keeps two brains consistent, the turn path budgets up to 3s of Honcho polling, and recall has a fallback that resurrects "historical honcho evidence" after local deletion. Honcho's beliefs form outside our control and cannot be individually corrected.

Prior art justifies the redesign direction: background consolidation is the convergent industry fix (ChatGPT "Dreaming", Claude "Auto Dream", Letta sleep-time compute); segment-level extraction beats turn-level (SeCom); judge-gated promotion materially improves memory quality; irrelevant injected memories measurably degrade answers.

**Scale constraint:** ~5 users, 2–3 active. Honcho's advantages are scale advantages; at this scale the "luxury" architecture (LLM judge per conversation, nightly consolidation per user) costs pennies. Maintainability and auditability dominate.

## 2. Goals / Non-goals

**Goals**

1. New memories are overwhelmingly correct without manual review (junk classes from the audit are explicitly rejected).
2. No scheduled manual pruning, ever: a nightly consolidation pass merges, retires, and refreshes.
3. Every memory is auditable: provenance to source messages, revision history, visible night-shift reports, one-click undo.
4. One authority: Honcho and its sync layer are removed; the memory codebase gets smaller.
5. Memory is visible at the moment it acts (recall provenance in chat).

**Non-goals**

- Theory-of-mind inference beyond curated facts + generated summary (accepted capability loss vs Honcho).
- Per-sentence "the model used this memory" attribution in v1 (we show "in context", not "used"; Atlas-style explicit memory citations are a v2 refinement).
- Multi-user shared/family memories, memory export/import, connector-derived memories (future work).

## 3. Architecture

Four components; lifecycle: **conversation → judge → fact store → nightly consolidation → persona summary → injected with provenance → user corrections feed back as top-priority facts.**

### 3.1 Fact store (source of truth)

Existing tables extended, no new storage system:

- `memory_profile_items`: continue using `statement` (first-person, single sentence), `category`, `scopeType`/`scopeId` (global or project), `status`, `revision`, `expiresAt` (now actually used). Add to `metadata_json` (no schema migration where avoidable): `confidence` (`stated` | `inferred`), `expiryClass` (`durable` | `time_bound` | `ephemeral`), `origin` (`judge_v1` | `user_authored` | `recuration`), `supersedesItemId`.
- Statuses: `active`, `review_needed` (capped, auto-expiring), `retired` (expired/superseded/merged — replaces ad-hoc `inactive`), `suppressed`, `deleted`. Retirement always links its cause (superseding item id or expiry) — nothing is silently destroyed.
- `memory_profile_item_provenance`: one row per source (conversation id, message ids, short quote label). Populated for every admitted fact.
- **Persona summary**: stored per user in `memory_projection_state` (keyed by user + reset generation): summary text (~150–250 words), per-sentence supporting fact ids (structured JSON), `updatedAt`.
- **Consolidation reports**: append-only log per run (what merged/retired/renewed/summary-diff), rendered as the Memory page timeline; each action references revisions so Undo = restore prior revision.
- User-authored facts (created via Correct action or summary edits) are marked `origin: user_authored` and are never auto-retired or rewritten by consolidation without an explicit report entry.

### 3.2 Intake judge (write gate)

Replaces the regex parser in `memory-profile/intake.ts`.

**Trigger policy (three tiers):**

- **Tier 0 — per turn, no LLM.** Normal turns only mark the conversation `memory-dirty` (simple flag; replaces dirty-ledger reconciliation). One deterministic exception: explicit memory requests ("remember that…", "jegyezd meg…") trigger an immediate judge call on that exchange only.
- **Tier 1 — per conversation, on idle.** Debounced ~30 min inactivity job (existing background-job queue; delayed job reset on each new message) runs the judge once over the conversation's **unjudged segment** plus the running conversation summary. Hard cap: force a run every ~25 unjudged messages for marathon conversations. Opportunistic flush: opening a new conversation while another of the user's conversations is dirty judges the dirty one immediately.
- **Tier 2 — nightly sweep.** Consolidation first judges any dirty conversations the idle trigger missed (crash-safety; self-healing).

**Rubric — a candidate must pass all five gates** (each is a named audit failure mode):

1. **Stability**: still true in ~3 months, OR time-bound-but-real → admitted with mandatory expiry.
2. **Ownership**: about the user, in the user's own voice. Rejects pasted logs/terminal output, quoted text, translations, text-being-edited, role-play, hypotheticals.
3. **Usefulness**: a future conversation goes better knowing this. Rejects vacuous facts.
4. **Confidence**: `stated` (direct) or `inferred` (behavioral); hedged statements are rejected — the judge commits or drops.
5. **Non-redundancy**: judge sees nearest existing facts (embedding match) and returns `new` / `strengthens` / `updates` / `nothing`. Updates create a revision, not a sibling.

**Output handling**: statements written first-person, one sentence, no evidence-trail prose, in the language the user spoke; category, scope (project-context facts default to project scope), confidence, expiry class, provenance. Admission: high confidence → `active`; uncertain → `review_needed` (**hard cap ~10/user, auto-expire ~30 days** — ignoring the queue is a valid choice); low → logged to a diagnostics stream (never injected) for rubric tuning.

Intake never blocks a chat turn (remains post-turn/deferred). Judge model: small/cheap configurable model via existing provider abstraction with structured output.

### 3.3 Nightly consolidation ("night shift")

Per user, only when anything changed since last run, on existing job infrastructure. Ordered steps, all revision-based:

1. **Expire**: retire facts past expiry; time-bound facts near expiry with recent supporting activity are *renewed* instead.
2. **Reconcile**: contradiction pass over active facts (embedding pairs + LLM check); newer supersedes older with link.
3. **Merge**: collapse near-duplicate clusters into one richer statement; provenance union preserved.
4. **Summarize**: regenerate the persona summary from active facts only; each sentence records supporting fact ids; rendered in the user's preferred language.

Ends with a report ("Merged 3 facts about the swap-site project, retired 2 expired goals, updated your summary."). Failure of any step leaves that user's memory untouched and surfaces in the report. Consolidation model: the stronger configured model; both model assignments configurable like reasoning-depth profiles.

### 3.4 Recall & injection

`memory-context.ts` keeps its facade shape; persona mode returns: persona summary + top-K query-relevant active facts (embedding match) within the existing 8k persona token budget, plus the fact IDs used → emitted as evidence candidates (mechanism already exists). All Honcho paths (`recallPersonaMemory`, `historical_honcho_evidence` fallback, `loadHonchoPromptContext` waits in `context-selection.ts`) are removed. History and project modes unchanged.

## 4. UI (full package)

1. **In chat — recall provenance.** `MessageEvidenceDetails` gains a **Memory group**: the persona summary + each fact in context this turn. Fact popover: statement, confidence, expiry, provenance link (jump to source conversation), and in-place actions **Correct** (edit → user-authored revision), **Don't use** (suppress/Forget), **Retire**. `ContextUsageRing`'s memory figure links to the same detail. Copy says "in context", not "used" (honest attribution).
2. **Memory page rebuilt** (Knowledge → Memory Profile tab), top-down: **persona summary card** (last-updated stamp; tap sentence → supporting facts; edits captured as user-authored facts) → **facts list** grouped by category (statement, scope chip, confidence dot, expiry, provenance count; Edit + unified Remove modal reusing Forget/Delete semantics) → **night-shift timeline** (consolidation reports, expandable diffs, one-click Undo per action) → **review queue card** only when non-empty (keep/discard, visible auto-expiry countdown).
3. **Removed surfaces**: legacy curation flows, peer-token statements, separate Honcho persona listing. One surface: summary on top, facts beneath, night-shift log proving nothing happens behind the user's back.

## 5. Migration & rollout — single-pass cutover

**Phase 0 — prove the judge (the confidence gate).**
- Fixture suite from the audit: log-scrape, hedge, frozen-project-state, vacuous, near-duplicate-cluster, hypothetical/quoted/translated cases — plus Hungarian-language variants (the judge must be language-agnostic; the regex parser's hard-coded Hungarian patterns are retired).
- **Dry-run week** on production: judge logs would-be admissions without writing; owner reviews the log. Cutover proceeds only if the dry-run beats the audit baseline.

**Phase 1 — single cutover release** (after Phase-0 gate passes):
- Judge intake replaces regex intake.
- **One-time re-curation**: all active, `review_needed`, and `inactive` items (283 of 294) pass through the judge — `suppressed`/`deleted` items are user decisions and stay untouched → keep-and-rewrite (first-person, expiry set) / retire (visible, recoverable). Review queue drains. First consolidation run builds initial persona summaries. Owner spot-checks per user in the new UI.
- `HONCHO_ENABLED=false`; Honcho code deleted in the same release: `honcho.ts`, mirroring in `finalize.ts`, polling in `context-selection.ts`, dirty-ledger reconciliation, legacy-curation modules, admin honcho endpoint. `chatgpt-import` summarizer rewired to feed imported-conversation summaries through the judge.
- Rollback: Honcho's local data is not destroyed by disabling it; code removal is a git revert; the fact store is revision-based (nothing destructive). No grace period needed.

## 6. Testing & guardrails

- **Judge fixtures**: every audit junk class is a named must-reject test; positive cases for each category and both languages; explicit-"remember" immediate path.
- **Consolidation units**: expire/renew, supersede-with-link, merge-with-provenance-union, summary generation with fact links, idempotency, failure-leaves-untouched.
- **Integration**: turn → dirty flag → idle job → facts; marathon-cap trigger; opportunistic flush; nightly sweep of missed conversations.
- **Diagnostics**: rejected-candidate log retained for rubric tuning.
- **Success criteria (blunt, at this scale)**: owner stops encountering wrong memories in replies; review queue stays < 10; no manual memory-cleanup sessions ever again; per-turn memory cost ≈ 0 (a few judge calls/day total).

## 7. What we consciously lose (vs Honcho)

1. Theory-of-mind engine (open-ended "what do you believe about this user?" synthesis) — replaced by curated facts + summary; accepted at this scale.
2. Free future Honcho improvements — all memory improvements are now owned in-repo.
3. Scale hardening — irrelevant at ~5 users.
