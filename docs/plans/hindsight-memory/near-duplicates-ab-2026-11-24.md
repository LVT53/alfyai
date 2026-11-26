# Near-duplicate rows after a document deletion: does config 2's mission cause them? (2026-11-24)

Task 3 of the Memory config 3 work (`Memory-Config3-Task: 3`), branch `claude/memory-config3-ab` from `ce8e26f68` (production, bank config 2). Synthetic data only. **Nothing in `src/` changed**: this measures and reports, and the main session decides. Script and raw per-run rows: [near-duplicates-ab/](near-duplicates-ab/) (`run.ts`, `results/`).

**Question** (follow-up C of [regression-2026-11-24.md](regression-2026-11-24.md)): after a document deletion Hindsight's consolidator sometimes leaves a "green bicycle" row beside a "green bicycle and white kayak" row over the same facts, and config 2's two added observation-mission sentences were "the likely trigger (not A/B tested)". The last two sentences of `observations_mission` in `nativeBankConfig`:

- **S1**: "When a later statement settles an earlier wish or plan about the same thing, keep only the settled state."
- **S2**: "When something really changes in the world, such as a move or a new job, state the new value as current and keep the old value only as earlier history in the same observation; never write an end date or any date the person did not state."

## Verdict

**Leave config 2 as it is: neither sentence is shown to cause the near-duplicate, and no variant measurably reduces it.** The run was cut short by the session's usage limit (141 runs, none failed); the counts below are what finished.

- **The near-duplicate itself is too rare here to measure a drop.** It appeared in 3 of about 70 end-state runs: twice in the 13 `short` baseline runs and once in a `fullflag` run of the variant *minus S2* (rows quoted below); never in the 2 real-path baseline runs. Baseline 2 of 13 against 0 of 5 for each variant (`short`), and 0 of 4, 0 of 4, 1 of 4 and 0 of 4 (`fullflag`) cannot separate anything.
- **Its precursor is measurable, and points nowhere clear.** Everything starts when the first call after the deletion rewrites the surviving kayak row into "bicycle and kayak" (the recorded runs did it in 4 of 5 such calls). With the recorded fact stamps (`miniflag`, the faithful 7-call cut) 10 of 17 baseline runs end with a rewritten or lost row. *Minus S2* (keeping S1) ends so in 2 of 14 (Fisher p = 0.024; 0.017 against only the baseline runs that ran at the same time). *Minus S1* ends so in 5 of 10 (p = 0.71) and *minus both* (config 1's mission) in 7 of 10 (p = 0.69). **Minus both also lacks S2 and shows no drop, so the drop cannot be put down to S2's absence**; it is an S1-without-S2 interaction or chance (three comparisons: Bonferroni p about 0.07).
- **A worse shape than a duplicate row turned up on the way: "kayak lost"** (the compound row is merged into the bicycle row and the white kayak is in no observation any more; its two source facts remain). 4 of 17 baseline `miniflag` runs, 2 of 14 minus S2, 2 of 10 minus S1, 5 of 10 minus both. It has the same root (the first-call rewrite) and the opposite merge direction, and the unmarked scenarios never showed it.
- **If the main session wants one candidate for its 40-scenario check, it is *minus S2*** (the only variant with any drop): the mission ends after S1, i.e. config 2's text without the S2 sentence. It is not a recommendation to adopt it: the evidence above does not show S2 is the cause.


## How the near-duplicate forms (read from the recorded trace)

[regression-2026-11-24/model-calls.jsonl.gz](regression-2026-11-24/model-calls.jsonl.gz) holds the consolidator's own prompts and answers for the regression day's Hungarian current-list runs (calls 743 to 746 are one run's deletion). Deleting the `pending` document removes the bicycle row (it rests on the pending fact) and requeues that row's four other source facts: the compound fact "red bicycle and white kayak", its replay, the blue fact and the green correction. The kayak row rests only on the two compound facts and survives. Hindsight then consolidates the four facts one per model call, in arrival order (`consolidation_llm_batch_size` 1, `ORDER BY created_at`), each call seeing the rows the one before wrote.

1. The first call reads the compound fact against the surviving **kayak-only row**. In the recorded trace there are five such calls (the compound fact, a kayak-only row in the pool, no bicycle row; calls 743, 926, 951, 1108, 1124). The model said `repeats` once (the clean path: the kayak row stays, a new bicycle row is added) and `changes` four times: it rewrote the kayak row to "red bicycle and white kayak" (the engine's own prompt says never to add a facet to an observation) and, in two of the four, also added a separate bicycle row.
2. The next facts (blue, green) change **both** rows that now carry the bicycle. The model also asks to delete one into the other (`deletes` with `merged_into`), and the engine drops that delete because the same answer updates the row (`consolidator.py`: "dropped delete of observation … the same response updates it").
3. Both rows stay: **twins** (the same wording twice, which the app now publishes as one row), or the **near-duplicate** (a compound row beside the bicycle row, over the same four facts), or, when the separate bicycle row was never added, a single **compound row**.

Nothing in that path reads the mission except as one block of the user message. Whether S1 or S2 tips the model's choice at step 1 is what the A/B below measures.

## What was run

- **Instance.** Its own Hindsight at the pin (`9fb28dbd`, `deploy/hindsight/engine-commit`) on 127.0.0.1:18992 with its own embedded PostgreSQL, started with the config-3 `start.py` (`CONFIG3_LLM_CONCURRENCY=1`: **one** model call in flight at most from this task). Flash-Next (`qwen3-6-27b`) through the shared bridge on 127.0.0.1:18891, retain thinking on as in production. A fresh bank per run, deleted afterwards; the instance is stopped at the end.
- **Variants.** `base` is `nativeBankConfig("personal")` as shipped. `no-s1`, `no-s2` and `no-both` cut exactly those sentences out of its `observations_mission` string (the script asserts the mission is config 1's plus S1 and S2, and that `no-both` equals config 1's mission byte for byte). Each bank is made with the same `PATCH /config {updates: <config>}` the app sends, and every key is read back by value. Nothing else of the config differs between variants.
- **Scenario.** The Hungarian current-list case (`current-list-followup/regression-2026-11-24.ts`, stage `pending-removed`), cut down. The facts are the raw facts the recorded runs' extraction produced (`fixes-2026-11-24-tip/current-list-hu-*.json.gz`), stored **verbatim** in arrival order (`retain_extraction_mode: "chunks"` set after the app's PATCH, and `observation_scopes: "shared"` on each item, which is what the bank's `default_observation_scopes: "shared"` stamps in the app's own extraction path), so extraction variance is out of the comparison and the only model calls are the consolidator's. Auto-consolidation is off while loading; the consolidations are explicit, so each fact is consolidated against the rows the earlier ones made, as in the app.
  - `short`: the five bicycle facts (compound, blue, green correction, replay of the compound, pending orange), consolidated, then `DELETE /documents/pending`, then consolidated again: **9 consolidator calls, about a minute alone** (the recorded 11-stage run is about five minutes of model time, most of it extraction with thinking).
  - `full`: the same plus the sister's two facts and the short-answers fact, the recorded pool of three other rows: 12 calls. `mini`: only what the recorded first call after the deletion needs (compound fact, its replay, sister, short answers, pending; the deletion requeues the compound fact and its replay): 7 calls.
  - **`fullflag` and `miniflag`: the same facts with the stamps the app's own extraction gives them.** One retain's facts are stamped 10 ms apart (`SECONDS_PER_FACT = 0.01` in `fact_extraction.py`), so at the recorded first call the sister's and the short-answers rows are "stated after this fact" in the prompt. Facts loaded one per retain with equal stamps carry no such mark. The unmarked scenarios (`mini`, `full`, `short`) took the clean path far more often than the recorded runs (below), so the marked ones are the faithful pair; the unmarked ones are kept as a second, independent set of runs.
  - `real`: the recorded stages as the app sends them (the model extracts, the engine consolidates after each retain), to the same deletion: two baseline runs, to see that the shapes are the real path's.
- **Near-duplicate, mechanically.** Two valid observations whose supporting facts overlap and where one's statement (its words without the engine's bracketed `(date: earlier state)` notes) is contained in the other's: content words reduced to 5-letter prefixes (Hungarian is agglutinative), "the user" and filler words dropped, at least two content words in the contained one. A **twin** when each contains the other, a **near-duplicate** otherwise. A **compound row** is any row whose statement names the bicycle and the kayak together (the precursor: the near-duplicate needs a compound row and a bicycle row to survive together). The rule was checked on the recorded runs: it flags the tip run's near-duplicate (`fixes-2026-11-24-tip/current-list-hu-1`), the morning run's twins, finds the compound-only rows of two other runs, and calls the clean run clean. Every flagged run below was also read row by row.
- **Side checks** on each final row set: the white kayak still there, the green bicycle current, the deleted document's value (orange) nowhere, a replaced colour (red, blue) presented as current, a year the person never stated, earlier history kept.

## Results

Counts are end states after the deletion, read by the rule above and then row by row. "Not clean" is any of: a compound row alone, the kayak lost, a twin, a near-duplicate. No run failed.

### `miniflag` (recorded stamps, 7 calls): the first re-consolidation call

| Variant | Runs | Clean | Compound only | Kayak lost | Twin / near | Not clean | p against base |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| config 2 as shipped (base) | 17 | 7 | 6 | 4 | 0 / 0 | 10 | |
| minus S1 | 10 | 5 | 3 | 2 | 0 / 0 | 5 | 0.71 |
| minus S2 | 14 | 12 | 0 | 2 | 0 / 0 | 2 | 0.024 |
| minus S1 and S2 (config 1's mission) | 10 | 3 | 2 | 5 | 0 / 0 | 7 | 0.69 |

Against only the baseline runs that ran alongside all four variants (started at or after 17:56 GMT): base 7 of 11 not clean, minus S2 2 of 14 (p = 0.017), the others unchanged. Pooled over the 2x2 design, S2 present against absent: not clean 15 of 27 against 9 of 24 (p = 0.26), compound row 9 against 2 (p = 0.042); S1 present against absent: not clean 12 of 31 against 12 of 20 (p = 0.16).

### `fullflag` (recorded stamps, the whole case, 12 calls): the end state

| Variant | Runs | Clean | Compound only | Kayak lost | Twin / near | Not clean |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| base | 4 | 3 | 1 | 0 | 0 / 0 | 1 |
| minus S1 | 4 | 1 | 3 | 0 | 0 / 0 | 3 |
| minus S2 | 4 | 2 | 1 | 0 | 0 / 1 | 2 |
| minus both | 4 | 4 | 0 | 0 | 0 / 0 | 0 |

### The unmarked scenarios (equal stamps) and the real path

| Scenario | Base | Minus S1 | Minus S2 | Minus both |
| --- | --- | --- | --- | --- |
| `short` (9 calls) | 13 runs: 9 clean, 2 compound only, **2 near-duplicate** | 5 clean of 5 | 5 clean of 5 | 5 clean of 5 |
| `full` (12 calls) | 7 runs: 6 clean, 1 compound only | 7 of 7 clean | 7 of 7 clean | 7 of 7 clean |
| `mini` (7 calls) | 4 of 4 clean | 4 of 4 | 4 of 4 | 4 of 4 |
| `real` (model extraction, the recorded stages) | 2 runs, both clean (4 rows, kayak kept) | | | |

`short` and `full` together, only the runs that ran side by side (started at or after 17:33 GMT): base 2 not clean of 11 (one compound row, one near-duplicate), each variant 0 of 11 (p = 0.48). The unmarked scenarios took the clean path far more often than the recorded runs did (`mini`: 16 of 16 clean, where the recorded trace shows the rewrite in 4 of 5 such calls); giving the same facts the app's own 10 ms stamps (`miniflag`) brought the rewrite back (10 of 17). That is an association, not a proven cause: the order of the old message's facts changed with the stamps too.

### Rows read

Near-duplicate (`fullflag-no-s2-02`; the same four facts under both rows; the compound row was the kayak row, rewritten at the first call after the deletion, as its change log in the record shows):

- "A felhasználó kerékpárja zöld. (2026-11-01 12:00: A felhasználónak van egy piros kerékpárja és egy fehér kajakja.)" [old, newer, correction, replay]
- "A felhasználónak van egy zöld kerékpárja és egy fehér kajakja. (2026-11-01 12:00: A felhasználónak van egy piros kerékpárja és egy fehér kajakja.)" [old, replay, newer, correction]

The same shape twice in `short` baseline (`short-base-08`). Compound row alone (`miniflag-base-05`): "A felhasználónak van egy piros kerékpárja és egy fehér kajakja." [old, replay], with no kayak row. Kayak lost (`miniflag-base-01`): "A felhasználónak van egy piros kerékpárja." [old, replay], sister and short-answers rows kept, no kayak row. Clean (`fullflag-base-01`): the green bicycle row with the engine's dated earlier-state note, "A felhasználónak van egy fehér kajakja." and the other two rows.

### Side checks (do the variants lose something else?)

In every run of every variant: the deleted document's orange appears in no row, no year the person never stated is written, a replaced colour (red, blue) is never current, and the green bicycle is current wherever the correction was loaded (`short`, `full`, `fullflag`). The earlier state is kept as the engine's own bracketed, dated note ("(2026-11-01 12:00: ...)"; the code writes it, not the model) in the clean rows of every variant, minus S2 and minus both included, so S2 is not what keeps history in this scenario. The only side difference is the kayak-lost shape above, which is no more frequent without S2 (2 of 14) than with it (4 of 17). What S1 and S2 do on the 40-scenario suite's other targets (settled plans, a real change keeping the old value, no invented dates) was not measured here.

### Limits

Facts are stored verbatim (the recorded extraction's output), so extraction variance is out and so is the real extraction path (2 baseline runs only). One model at temperature 0: the outcomes are bimodal and move with details of the prompt, not only with the mission. Small counts (the usage limit ended the run at 141 results: `miniflag` 17/10/14/10, `fullflag` 4 each, `short` 13/5/5/5, `full` 7 each, `mini` 4 each, `real` 2) and three uncorrected comparisons. The A/B shows no sign that either sentence causes the near-duplicate; it cannot show that removing one cures it. What this points at, without proving it, is the engine's consolidation prompt and merge rules rather than the mission (follow-up C: a merge is dropped when the same answer updates the row; a merge can also be applied in the wrong direction, which is the kayak-lost shape).

## Reproduce

From the repository root, with `/tmp/alfyai-hindsight-eval` (pinned source and venv), the shared bridge on 18891 and a Hindsight started with `docs/plans/hindsight-memory/part-2-acceptance/config-3/start.py <port> <pg0-name>` (`CONFIG3_LLM_CONCURRENCY=1`); `svelte-kit sync` once so `$lib` resolves:

```sh
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
AB_HINDSIGHT_URL=http://127.0.0.1:18992 node --import tsx docs/plans/hindsight-memory/near-duplicates-ab/run.ts run <base|no-s1|no-s2|no-both> <runs> --scenario <miniflag|fullflag|short|full|mini|real>
node --import tsx docs/plans/hindsight-memory/near-duplicates-ab/run.ts summary --scenario miniflag [--since <ISO time>]   # counts, Fisher tests, 2x2 pooling
node --import tsx docs/plans/hindsight-memory/near-duplicates-ab/run.ts show <variant> --scenario miniflag                  # every run's rows with their source documents
node --import tsx docs/plans/hindsight-memory/near-duplicates-ab/run.ts plan                                                 # the four mission texts
```

`results/` holds one JSON per run (rows before and after the deletion, each surviving row's change log where it was recorded, the shape).
