# Memory bugs from the 2026-11-24 regression run: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three native Memory bugs the regression run found: an unchanged resend that unpublishes a chat's facts (follow-up 2), a duplicate row after a document deletion (follow-up 5), and a refused Remove or a held changed resend that holds the bank's later learning (follow-up 1).

**Architecture:** All three live in `src/lib/server/services/memory-profile/`. Publication (`publication.ts`) stays the one place a generation is written; the fixes add one exclusion read there (`excludedNativeEvidence`) and one way to settle a resend without a new generation (`keepPublishedGeneration`). Curation (`curation-runner.ts`) and delivery (`delivery-runner.ts`) only call them.

**Tech Stack:** TypeScript, SvelteKit server, SQLite through Drizzle, Vitest with the job-engine harness (`../jobs/testing/harness`), a fake Hindsight fetcher (`nativeFixture` in `curation.integration.test.ts`).

**Spec:** `docs/superpowers/specs/2026-11-22-memory-redesign-design.md` (anti-goal: "Anything the person removed or edited coming back, in recall, on the page or in the Overview"), the evidence in `docs/plans/hindsight-memory/regression-2026-11-24.md`, and the owner's decision of 2026-11-24: "Yes fix both + fix the 'refused remove pauses later learning'".

## Global Constraints

- Never relax a check that protects a removal or an edit.
- A refused item stays safe: what the person asked to remove never comes back in recall, on the page or in the Overview.
- `tester@tester.com` stays excluded from every Memory migration (no migration is planned).
- Any new user-facing string ships in English and Hungarian (none is planned).
- `npm run check` 0 errors and 0 warnings, a build with zero warnings, no new Fallow finding (baseline: one cycle).
- Synthetic data only; no box, no production data.

## Review Focus

1. A Remove that is still queued or running keeps holding the bank: its own native writes may be half done (existing tests `delivery-job.integration.test.ts` "does not resubmit while a removal still has to clean up the bank" and `dependency-repair.test.ts` hold this; a Remove with no job row holds too).
2. A Remove refused after its native PATCH (Hindsight already rebuilt observations around it, and the checker refused them): the observations that shared a row with the removed facts stay out, not only those built on the removed facts (Task 3 test "after its native write").
3. A refused Remove that the person retries: the job is queued again, the hold returns while it runs, and the exclusion was never lifted in between (Task 3 test asserts the hold on reopen).
4. An unchanged resend whose Hindsight display drifted in a way that is not only a re-render (an extra unverified observation, a changed date): nothing new is published, nothing published is taken away (Task 1 updates the two existing drift modes to assert exactly that).
5. A later Edit on a card that shares a chat with the refused Remove's facts: out of scope; recorded as a known limit in the regression record (it may fail its readback; it cannot publish the excluded facts).

---

## Design for bug 3: a Remove that does not complete keeps its exclusion and releases the bank

Today a Remove's exclusion is written at once (fact revocations by id and text hash, `exclusionAcknowledged`, `cleanupPending`), and every publication of the bank fails `memory_curation_publication_held` until the Remove completes; a refused Remove never completes. A held changed resend leaves its facts in Hindsight unaccepted, and every later publication fails `memory_candidate_unaccepted`.

1. **Hold only while it runs.** `assertCurationPublication` holds the bank for an acknowledged Remove only while its job has not ended: no job row of the action is `failed` or `cancelled`. A refused Remove's job is `failed`; from then on later publications go ahead. A retried or reopened Remove is `queued` again and holds again while it runs.
2. **The exclusion is permanent and exact.** A Remove that ended without applying keeps its revocations (they already hide its card on every read: page, recall, Overview, search, because every read goes through `readPublishedMemory`/`admittedNativeFacts`). Publication then leaves out exactly what it excluded instead of failing: every Hindsight observation whose support includes a fact the Remove excluded. Excluded facts:
   - the facts it revoked (`memory_revocations.action_id`), by id whatever their text now (a refused partial removal may have rewritten them);
   - when its proposal was saved (its native PATCH may have run before the final check refused it): also every fact that shared a published row with a targeted fact when the person asked (`intent.familyFactIds`, recorded at submission), and every proposal fact whose text it changed. Hindsight rebuilt the observations around those facts and the checker refused them, so none of them is published unreviewed. A legacy Remove without `familyFactIds` falls back to all its `intent.facts`.
3. **A held source is left out, not waited for.** A source whose delivery ended without acceptance (its `source` job `failed` or `cancelled`, the source still `pending` or `staged`) never published; its facts sit in Hindsight unaccepted. Publication leaves out every observation built on them. A source still queued or running is still waited for (as today).
4. **One read, used where Hindsight's snapshot is judged.** `excludedNativeEvidence(tx, bank)` returns the excluded fact ids and source ids; `withoutExcludedEvidence(memories, excluded)` drops those raw facts and every observation that touches them. `publishNativeSnapshot` applies it before every check, so its checks and its rows see the same snapshot. `checkCandidate` applies it so the final checker judges exactly what would be published, and the unchanged resend's verification applies it so a known, excluded fact under the resent chat's document does not fail the resend.
5. **What it cannot do.** An observation is the smallest unit published: an observation that merges an excluded fact with an unrelated one is left out whole (the unrelated fact shows again once Hindsight builds it alone, as Luca's card does after the original chat's cleanup). A shared raw fact ("the user and Luca are gluten-free") is excluded whole, as the Remove already hid it.

## Design for bug 1: an unchanged resend never takes away what was published

`verifyUnchangedDisplay` stays the gate for publishing Hindsight's display after an unchanged resend; nothing relaxes it. When it cannot verify the display and no dependency changed (Hindsight re-rendered or renumbered an observation, added an unverified one, or moved a date), the resend no longer fails and leaves the chat's source revoked: it settles without a new generation. The predecessor's accepted facts are admitted again exactly as `replayed.apply` admits them on success, the resend is recorded as its logical receipt, and the bank's current generation, the rows the person saw before the resend, stays as it is (`keepPublishedGeneration`). A fact that is actually missing from Hindsight still fails, as today.

---

### Task 1: An unchanged resend keeps the published generation when it cannot verify Hindsight's display

**Files:**
- Modify: `src/lib/server/services/memory-profile/curation-runner.ts` (`prepareUnchangedSourceCuration`: `verifyUnchangedDisplay`, `verifyDependencies`)
- Modify: `src/lib/server/services/memory-profile/delivery-runner.ts` (the unchanged branch, `ctx.succeed`)
- Modify: `src/lib/server/services/memory-profile/publication.ts` (new `keepPublishedGeneration`)
- Test: `src/lib/server/services/memory-profile/curation.integration.test.ts` ("identical resend treats predecessor admission truthfully")

**Interfaces:**
- Produces: `keepPublishedGeneration(tx: Tx, input: { userId: string; bankId: string; epoch: number; expectedRevision: number; sourceIds: string[] }): string` (fences like `publishNativeSnapshot`, holds like it through `assertCurationPublication`, accepts the listed staged sources into `bank.generation`, returns it; throws `memory_publication_stale` on a revision change and `memory_generation_missing` with no generation).
- Produces: `verifyDependencies(result): Promise<{ keepGeneration: boolean }>` on the object `prepareUnchangedSourceCuration` returns.

- [ ] **Step 1: Write the failing test.** New mode `"re-rendered observation on exact resend"` in the `it.each` of "identical resend treats predecessor admission truthfully": after the withdrawal, the fake list replaces `observation-decaf` with `observation-decaf-rebuilt` whose text differs ("I prefer decaf in the afternoon, it says."), same `source_memory_ids`. Expect the delivery `succeeded`, the page texts `[drink]`, the bank generation unchanged, no retains. Change the two drift modes (`extra observation on exact resend`, `changed native date on exact resend`) to the same expectations (they asserted the bug: the chat's facts gone, `texts` `[]`), and additionally assert "The user dislikes decaf." is not on the page.
- [ ] **Step 2: Run** `npx vitest run src/lib/server/services/memory-profile/curation.integration.test.ts -t "identical resend"`; expect the three modes to fail (delivery `queued`, `memory_unchanged_source_fact_missing`, texts `[]`).
- [ ] **Step 3: Implement.** `verifyUnchangedDisplay` returns `false` instead of throwing when `!dependencyChanged` and a row or an extra observation does not match (the date mismatch too); with `dependencyChanged` it throws as today. `verifyDependencies` returns `{ keepGeneration: !verified }`. The delivery runner's unchanged branch calls `keepPublishedGeneration` instead of `publishNativeSnapshot` when told to keep.
- [ ] **Step 4: Run** the same command plus `-t "unchanged"`; expect every mode to pass, the `missing` fact case still failing as before.
- [ ] **Step 5: Commit** (`Memory-Bugs-Task: 1`).

### Task 2: One row after a document deletion (follow-up 5)

**Files:** decided by the root cause (a background investigation of the current-list Hungarian evidence and `publication.ts`/`delivery-runner.ts` is running); this task is filled in with the mechanism, its failing test and the fix before it is built, and recorded here.

- [ ] **Step 1: Reproduce** the duplicate in a unit or integration test from a synthetic native snapshot shaped like the evidence.
- [ ] **Step 2: Run** it; expect two rows.
- [ ] **Step 3: Fix** where the mechanism says, never publishing a removed or edited fact and never hiding a row that is not a duplicate.
- [ ] **Step 4: Run**; expect one row, no rebuild.
- [ ] **Step 5: Commit** (`Memory-Bugs-Task: 2`).

### Task 3: A Remove that does not complete keeps its exclusion and releases the bank

**Files:**
- Modify: `src/lib/server/services/memory-profile/publication.ts` (`assertCurationPublication`, new `excludedNativeEvidence` and `withoutExcludedEvidence`, `publishNativeSnapshot`)
- Modify: `src/lib/server/services/memory-profile/curation-actions.ts` (record `familyFactIds` on a Remove)
- Modify: `src/lib/server/services/memory-profile/curation-intent.ts` (`familyFactIds?: string[]`, validated)
- Modify: `src/lib/server/services/memory-profile/curation-runner.ts` (`checkCandidate`, the unchanged resend's `verify`)
- Modify: `src/lib/server/services/memory-profile/AGENTS.md` (the rule, in one paragraph)
- Test: `src/lib/server/services/memory-profile/curation.integration.test.ts`, `publication.integration.test.ts`

**Interfaces:**
- Produces: `excludedNativeEvidence(tx: Tx, bank: { id: string; userId: string; epoch: number }): { factIds: Set<string>; sourceIds: Set<string> }`
- Produces: `withoutExcludedEvidence(memories: NativeMemory[], excluded: { factIds: ReadonlySet<string>; sourceIds: ReadonlySet<string> }): NativeMemory[]`

- [ ] **Step 1: Write the failing tests** (curation.integration.test.ts, through the real job engine and the fake Hindsight):
  - "a refused Remove keeps its card out and later learning publishes": the planner plans the kayak removal, the edit review refuses every round (`memory_edit_rejected`), the job fails; Hindsight still holds the kayak fact and its observation. A new chat ("I collect maps.") delivers: `succeeded`; the page shows sister and maps, never "green kayak"; no published row of any generation that is current or previous is built on the kayak fact; the Overview's model input holds no "green kayak"; a second Remove can be submitted (no `memory_action_pending`).
  - "a Remove refused after its native write keeps its family out": a row supported by `kayak` and `canoe`; the PATCH invalidates `kayak` and Hindsight rebuilds `canoe`'s observation alone with the removed colour in its text; the final check refuses until the job fails. A new chat delivers: `succeeded`; the rebuilt canoe observation is not published; the new chat's is.
  - "a retried refused Remove holds again while it runs": reopening the failed job makes a source delivery fail `memory_curation_publication_held` again; the kayak card stays hidden throughout.
  - "a held changed resend does not hold later learning": a pending source whose `source` job failed `memory_dependency_check_rejected`, its fact and observation in Hindsight; a new chat delivers `succeeded`, the held fact's observation is not published.
  - publication.integration.test.ts "publication leaves out an ended Remove's facts and waits for a running one": the same snapshot publishes without the excluded observation when the Remove's job is `failed`, and throws `memory_curation_publication_held` when it is `queued`.
- [ ] **Step 2: Run** `npx vitest run src/lib/server/services/memory-profile/curation.integration.test.ts src/lib/server/services/memory-profile/publication.integration.test.ts -t "refused Remove|held changed resend|ended Remove"`; expect the held and unaccepted failures.
- [ ] **Step 3: Implement** the design above, in the files listed.
- [ ] **Step 4: Run** the same command, then the memory-profile and memory-context folders; expect all green.
- [ ] **Step 5: Commit** (`Memory-Bugs-Task: 3`).

### Task 4: Rerun the regression suites' affected cases and record them

- [ ] Restart the scratch stack per `regression-2026-11-24.md` "Reproduce" (bridge at most 3 calls in flight, the key never printed).
- [ ] Rerun lifecycle `en` and `hu`, `carry-hu`, the current-list Hungarian holdout, and the edit/remove holdout (`er-hu-regression`, `er-remove` first).
- [ ] Record before and after in `docs/plans/hindsight-memory/regression-2026-11-24.md` under a new dated section; commit (`Memory-Bugs-Task: 4`).

### Task 5: Gates, review, hand-over

- [ ] `npm run check` once after the code; the agent gate once at the end (`scripts/gates.sh agent "$TMPDIR/alfyai-gates-mb" --port 5200 tests/e2e/chat.spec.ts tests/e2e/memory-subjects.spec.ts tests/e2e/memory-replacement.spec.ts`, after `pgrep -fl 'gates.sh|node_modules/.bin/playwright test'`).
- [ ] One Opus whole-branch review focused on privacy; fix its Important findings test first.
- [ ] Hand-over `memory-bugs-build-2026-11-24.md` in the shared notes folder.
