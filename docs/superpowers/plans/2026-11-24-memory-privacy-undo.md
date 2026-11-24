# Memory follow-ups B and G Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recall shows a card Hindsight re-rendered as soon as the Memory page does (B), and a refused changed resend excludes what the person's edit took away instead of putting it back (G, the owner's privacy-first choice).

**Architecture:** B is a read-side change: recall maps a ranked observation to the published row whose complete, unique support it carries, when Hindsight's live list confirms the observation and every fact under the row is unchanged. G replaces the undo of a refused changed resend (`restoreRefusedSourceEdit`) with an exclusion: the touched facts are revoked at once (any wording), left out of every publication by id, and invalidated in Hindsight so its cards are rebuilt without them; the rejection is final.

**Tech Stack:** SvelteKit server code (TypeScript), SQLite with Drizzle, Vitest; Hindsight at pin `9fb28dbd` for the real-engine reruns.

**Spec:** `docs/superpowers/specs/2026-11-22-memory-redesign-design.md` (anti-goals: nothing removed or edited comes back, in recall, on the page or in the Overview); follow-ups B and G in `docs/plans/hindsight-memory/regression-2026-11-24.md` ("Found on the way") and the shared note `memory-bugs-build-2026-11-24.md`.

## Global Constraints

- Recall never offers a row the page does not show: it only orders rows `readPublishedMemory` returns.
- Nothing the person removed or edited away comes back in recall, on the page, in search or in the Overview.
- Out of scope: `contracts.ts` bank config, `fact-classifier.ts`, `label-migration*`, `bank-configuration.ts`, `bank-config-restore.ts`, `overview.ts`.
- No migration, no new setting, no new model call. Synthetic data only. Every new user-facing string in English and Hungarian (none planned).
- Gates: `npm run check` 0/0, build zero warnings, Fallow no new finding (1 cycle, ceiling 1).
- Commits carry `Memory-Privacy-Undo-Task: N` and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push or merge.

## Review Focus

1. A re-rendered observation whose support adds a fact not yet published (a merge in flight): recall must not map it. (Task 1 test "superset support".)
2. A re-render while the row's fact was rewritten in Hindsight (an in-flight or refused rewrite): recall must not map it. (Task 1 test "changed raw".)
3. A touched fact Hindsight merged into one card with an untouched fact: the card leaves the page at once; the untouched fact comes back in its own card at the next publication. (Task 2 test "merged card".)
4. A retry of a refused resend (job retry or an operator's reattach): no proposal write, the exclusion holds. (Task 2, the existing retry step, expectation changed.)
5. The native part of the exclusion failing (Hindsight down): the page, recall and the Overview already hide the old wording, and the delivery stays retryable. (Task 2 test "native failure".)

---

### Task 1: Recall reaches a re-rendered card through its support (B)

**Files:**
- Modify: `src/lib/server/services/memory-profile/publication.ts` (new `rerenderedNativeRankKeys`)
- Modify: `src/lib/server/services/memory-context/native.ts` (snapshot condition, `verifiedOrder`)
- Test: `src/lib/server/services/memory-context/native.test.ts`, `src/lib/server/services/memory-profile/curation.integration.test.ts`

**Interfaces:**
- Produces: `rerenderedNativeRankKeys(tx: Tx, bank: typeof memoryBanks.$inferSelect): Map<string, string>`: for the bank's current generation, `nativeRankSupportKey(fact ids) -> nativeId` of every row whose facts no other row of that generation holds (`uniquePublishedSupport` over `publishedRowsForGeneration`, hidden rows counted).

- [ ] **Step 1: Failing unit tests** in `native.test.ts`, `it.each` over modes, a plain (not edited) published row `"My sewing box is blue."` on fact `f-b1`, recall ranking `{ id: "rebuilt", text: "The user's sewing box is blue.", source_memory_ids: ["f-b1"] }`, `list` holding that observation and the raw fact:
  - `"re-rendered"` → recall returns the published row (`rowId: "n-b1"`, `text: "My sewing box is blue."`), never Hindsight's wording; tool and turn paths alike.
  - `"re-rendered in place"` (same id `n-b1`, new text) → the published row.
  - `"superset support"` (`["f-b1", "unpublished"]`), `"changed raw"` (raw text differs), `"second live observation"` (another live observation rests on `f-b1`), `"snapshot disagrees"` (list text differs from the rank's), `"snapshot fails"`, `"revoked"` (fact revocation of `f-b1`), `"shared support"` (a second published row holds `f-b1`) → `[]`.
- [ ] **Step 2:** `npx vitest run src/lib/server/services/memory-context/native.test.ts` → the two positive modes FAIL (`[]`).
- [ ] **Step 3: Implement.** In the search phase take the snapshot also when a rank's support key is in `rerenderedNativeRankKeys` and the rank is not a direct match (same id, text and support as a visible row). In `verifiedOrder`, after the direct match, map `bridge.get(key) ?? rerendered.get(key)` through the existing evidence checks (live observation with the rank's text and support, each fact under exactly one live observation, `exactRankEvidence(row)`).
- [ ] **Step 4: Integration repro** in `curation.integration.test.ts`: a refused correction (Edit with a staged draft, checker refuses) after which the fixture's Hindsight re-renders the kayak observation under a new id and wording; assert the page (`listMemory`) and recall (`recallMemory`) both give the published card and nothing else. Run: FAIL before Step 3, PASS after.
- [ ] **Step 5:** run both files → PASS; commit `Recall a card Hindsight re-rendered after a refused correction` (`Memory-Privacy-Undo-Task: 1`).

### Task 2: A refused changed resend excludes what the edit took away (G)

**Files:**
- Modify: `src/lib/server/services/memory-profile/curation-runner.ts` (`restoreRefusedSourceEdit` becomes `excludeRefusedSourceEdit`; `undoSourceEditWrites` removed; `prepareSourceCuration` ends a rejected edit at once)
- Modify: `src/lib/server/services/memory-profile/curation-intent.ts` (new exported `refusedSourceEditFacts`)
- Modify: `src/lib/server/services/memory-profile/publication.ts` (`excludedNativeEvidence`)
- Modify: `src/lib/server/services/memory-profile/delivery-runner.ts` (the call and its comment)
- Modify: `src/lib/server/services/memory-profile/AGENTS.md` ("Refused items ...")
- Test: `curation.integration.test.ts` (modes "refused changed resend after exact carry", "changed resend refused at publication after exact carry"; new mode with an untouched fact in the carried chat), `publication.integration.test.ts`

**Interfaces:**
- Produces: `refusedSourceEditFacts(intent: ActionIntentRecord): Array<{ id: string; text: string; sourceId: string }>` (in `curation-intent.ts`, read by publication and the runner): the facts of `intent.facts` whose `intent.proposal` text differs (rewritten or invalidated).
- Produces: `excludeRefusedSourceEdit(ctx, client, native, source): Promise<void>` (same parameters as the function it replaces).

- [ ] **Step 1: Change the expectations, test first** (the owner's decision G; stricter, never looser). In both refused modes: after the refusal `listMemory` is `[]` (was `[drink]`), the native `decaf` fact is gone (invalidated, not put back), a fact revocation of `decaf` with the source edit's action id exists, recall returns nothing about decaf, the stored Overview for the bank is gone; the retry ends `memory_edit_rejected` with no new PATCH; the later message publishes and the list is `[laterMessage]`. New mode "refused changed resend keeps the untouched fact": the carried chat also holds `tyres` (untouched by the proposal), which stays on the page and in recall throughout.
- [ ] **Step 2:** `publication.integration.test.ts`: `excludedNativeEvidence` holds exactly the touched facts of a `rejected` source edit, whatever its job's state (queued, running, failed), and nothing of an `accepted` one; publication of a snapshot with an observation on a touched fact drops that observation and publishes the rest.
- [ ] **Step 3:** run → FAIL.
- [ ] **Step 4: Implement.** `excludeRefusedSourceEdit`: return for an accepted edit; one fenced write records `outcome: "rejected"` and inserts, for each touched fact without one, a revocation `{ nativeFactId: id, nativeTextHash: null, actionId: action.id }`; then each touched fact still live under its owner's document is invalidated in Hindsight (`editFact(id, { state: "invalidated", reason: "Refused memory edit" })`, fenced), and one consolidation is settled when anything was written. `prepareSourceCuration` throws `NativeMemoryError("memory_edit_rejected", false)` for a `rejected` intent before any write. `excludedNativeEvidence` adds `refusedSourceEditFacts` of every `rejected` source edit of the bank and epoch to `factIds`.
- [ ] **Step 5:** run the touched files → PASS; commit `Exclude what a refused changed resend's edit took away` (`Memory-Privacy-Undo-Task: 2`), with AGENTS.md and this plan's design section.

### Task 3: Gates, review, real engine, records

- [ ] `npm run check` once; the agent gate once at the end (`scripts/gates.sh agent "$TMPDIR/alfyai-gates-pu" --port 5200 tests/e2e/chat.spec.ts tests/e2e/memory-subjects.spec.ts tests/e2e/memory-replacement.spec.ts`), after `pgrep -fl 'gates.sh|node_modules/.bin/playwright test'`.
- [ ] One Opus privacy review of the branch; fix its findings test first.
- [ ] Rerun on the final tip: `carry-hu`, the refused Remove (`er-hu-regression`), the held changed resend (`er-remove`, cats), lifecycle `en` and `hu`; record before and after in a dated section of `regression-2026-11-24.md`.
- [ ] Shared note `memory-privacy-undo-2026-11-24.md`.

## Design (G)

A changed resend whose source edit is refused for good keeps nothing the person's edit took away:

- **Which facts.** The facts of the chats the resend carried (`intent.facts`) whose text its proposal changed: rewritten or invalidated. Facts the proposal left as they were stay published. The resend's own retained facts stay left out as before.
- **At once, everywhere.** One fenced write records the source edit `rejected` and revokes each such fact by id, whatever its wording (`nativeTextHash: null`, `actionId` = the source edit): the page, recall, Workspace Search and the Overview (its revocation trigger drops the stored one) stop showing any card resting on it, and its chat is no longer context for later retains.
- **Publication.** `excludedNativeEvidence` leaves those facts, and every observation resting on one of them, out of every publication, the final checker, the accepted-edit guard and the unchanged resend's verification, whatever the resend's job is doing.
- **Hindsight.** Each such fact still live under its chat's document is invalidated (no longer put back), and Hindsight consolidates, so its cards are rebuilt without it; an untouched fact merged into the same card comes back in a card of its own at the next publication.
- **Final.** A retry of the refused resend ends at once with `memory_edit_rejected` and only repeats the exclusion; it never writes the proposal again. The person can edit the message again.
- **Why not put it back.** Putting the accepted wording back (2026-11-24 afternoon) kept the detail the person deleted from their message in Memory.
