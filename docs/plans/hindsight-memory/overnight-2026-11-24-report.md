# Memory redesign: the overnight build (23–24 November 2026)

On 23 November at 22:05 GMT the owner granted: "fully complete the plan so it's ready by the morning for full rollout. And I mean all parts of the plan."

This is where it stands. Nothing is pushed, nothing is deployed, and nothing was written on the box. Everything below waits for the owner's word.

## What is on local `main`

Local `main` is 132 commits ahead of `origin/main` (`652f7f3f0`), plus this report. Every part below was built test-first, gated, and reviewed by Opus, with its Important findings fixed.

| Part | What it does | Notes |
|---|---|---|
| 1. Fair recall | Message-aware recall with a fair split between banks; "said N ago" times plus a note on what they mean | Age probe 20/20; 5,000-row size check p95 190 ms |
| Video fix | A ten-second take is one 241-frame render; the e2e test is tightened | Was blocking any push |
| 2. Labels | Kind and subject for every new fact; Earlier decided at read time; bank config 2 | Acceptance below |
| Search Stage A | Workspace Search finds Memory and every artifact and file kind, with true counts | Stage B (the FTS index) waits for a count-only size check |
| 4. Waiting | Over-budget model calls queue instead of a 429; jobs wait on Hindsight's own state without using up attempts; four operator tools; the permanent tester flag (migration 141) | Gateway's Python tests are in the gate |
| 3. Memory page | Subject index, opened subject, Earlier folds, Overview sheet; existing accounts keep today's page until their labels are verified (migrations 143, 144) | Overview wording not yet tried on the real model |
| Label migration | Labels every existing fact per account and verifies before switching the page; Earlier entries only when the message mentions them | The production run needs its own go-ahead |
| Release fixes | Search placeholder that fits a phone; four stale or racy tests | `9b23eedca`..`2cbe89126` |

Part 5 (retiring legacy code) is on its own branch, `claude/memory-part-5-retire-legacy` (`05f79fa4f`). It is held until 22 December, when sales' rollback window closes.

## Acceptance numbers

All runs used Flash-Next with synthetic data only, half Hungarian.

**Part 2: what is remembered**

| Target | Result | Target value |
|---|---|---|
| Question-only chats leave nothing | 20/20 | ≥ 18/20 |
| Lasting facts kept | 20/20, same as today | ≥ today |
| Kind right | 96% | ≥ 85% |
| Subject right | 83% | ≥ 80% |
| Lasting facts labelled temporary or ongoing | 1 in 34 | ≤ 1 in 20 |
| A real change: new state current, old kept | 18/20 (today 5/20) | ≥ 16/20 |
| Corrections | 18/20 (today 17/20) | still pass |
| **A settled brainstorm leaves only its outcome** | **10/20** (today about 1/20) | 16/20: **missed** |

**Earlier entries come back only when the message mentions them.** This was measured once, on a blind set written by an agent that never saw the rule, assuming the worst case that every Earlier entry ranks in the top three:

| Messages | Bring an Earlier entry | Target |
|---|---|---|
| About that entry | 52% (EN 26/43, HU 19/43) | ≥ 80%: **missed** |
| Unrelated | 25% (EN 9/20, HU 1/20) | ≤ 10%: **missed** |
| Hungarian message about an English entry | 0/10 | reported |

- The misses are paraphrases that share no word with the entry.
- The false matches are everyday words, or words used in another sense ("cold", "book", "report").
- Without the rule, a small bank brought an Earlier entry into about 9 of every 10 unrelated messages. The model's own `memory_context` tool still finds Earlier entries wherever they rank.

**Label migration (synthetic accounts, with a stand-in Hindsight that only lists):**
- 70 facts were labelled in 5 calls and every account verified.
- Every other table stayed unchanged, and the tester was never read.
- A resumed run made 0 calls.
- After the review fixes, an account fails when more than 1 fact in 20 has no label, or when under 15% of its labels are lasting.

**Not run:** the lifecycle, current-list and integrated-benchmark suites. They need a non-production Hindsight on the box.

## Decisions for the owner

1. **Push and deploy** this `main`: yes or no.
2. **Earlier entries:**
   - keep the mention rule (the default);
   - drop it and let ranking alone decide;
   - or first measure a meaning-based check on a non-production Hindsight with production's embedder and reranker.
   It only matters once the label migration runs.
3. **Brainstorms at 10/20:** accept the improvement, or ask for another wording round.
4. **The label migration's production run:** after the deploy and the gateway image, follow its runbook.
5. **The Feature Guide** already shows the new Memory page. Existing accounts see it only after their labels are verified.
6. **The search placeholder** is "Search everything" in English and "Keresés mindenben" in Hungarian. Screen readers still hear "Search chats, memory, documents and more".
7. **Part 5, in December:**
   - an imported ChatGPT message that a removal or edit touches now stays out of Memory, because no replay tool is left;
   - one e2e case went with the legacy code ("picture-only reply shows no Sources row");
   - its Opus review is due on merge day, after the rebase.
8. **Still open from before:**
   - the dead video chain helpers (`concatClips` and others);
   - part 1's live check. I recommend skipping it and verifying after the deploy instead.

## Deploy runbook, in order

0. **Before deploying** (production reads, owner's OK):
   - grep the box's rollout scripts for comparisons of `native_config_version` with the engine commit; banks will now read `alfyai-bank-config-2`;
   - look at TEI's container logs for query text.
1. **Push** the exact commit: `git push origin <full sha>:refs/heads/main`, read it back with `git ls-remote`, and push `dev` the same way if it should match.
2. **Hindsight on the box** (`deploy/hindsight/README.md`):
   - rebuild the image, which now includes `alfyai_admission_queue.py`; Compose sets the model timeout to 800 s;
   - run the whole Python suite inside the image;
   - confirm the engine reads `HINDSIGHT_API_LLM_TIMEOUT` (`test_effective_config` fails if the name is wrong);
   - restart.
3. **The app**, ai.dev first, then production: the deploy backs up the database and `db:prepare` applies migrations 140, 141, 143 and 144. There is no 142; that gap is harmless.
4. **Re-pin the Memory workers** and confirm they run.
5. **Watch:**
   - sales' `rollout-recall.mts`;
   - a day of `[KNOWLEDGE_MEMORY] Recall` timings;
   - the gateway's queue status: no 429s, and "waited" counts instead.
6. **Bank config 2 is one-way.** To roll the app back:
   - stop the Memory workers;
   - run `scripts/memory-bank-config-restore.ts --execute restore-bank-config-1`, which also returns accounts to today's page;
   - then roll back the code.
   After rolling forward again, run the label migration again.
7. **The label migration** is a separate go-ahead. It is in `docs/plans/hindsight-memory/migration-runbook.md`, "Label migration":
   1. a dry run;
   2. Memory workers paused;
   3. a paired backup no more than 4 h old;
   4. one account, then check it verified;
   5. `--all`;
   6. resume the workers.

## Where things are

- **Specs and plans:** `docs/superpowers/specs/2026-11-22-memory-redesign-design.md`, `docs/superpowers/plans/2026-11-2[34]-*`.
- **Acceptance:** `docs/plans/hindsight-memory/recall-part-1-acceptance.md`, `part-2-acceptance.md`, `label-migration-acceptance.md`.
- **Build notes for every part:** each part's interfaces, calls and deferred minors (`memory-part-*-build-2026-11-24.md`, `memory-label-migration-build-2026-11-24.md`, `workspace-search-stage-a-handover-2026-11-23.md`) are in the orchestrating session's shared notes folder.
- **Branches kept:**
  - `claude/memory-part-5-retire-legacy` (held);
  - `backup/memory-part-5-before-rebase-2026-11-24`;
  - each part's build branch, already on `main` by fast-forward.

## Budget

- The weekly limit went from 22% at 22:00 to about 43%.
- The 5-hour limit ran out once, at about 02:00 GMT, and work resumed after its 02:20 reset.
- From then on, Opus did reviews and the riskiest build only, and Sonnet did the rest.
