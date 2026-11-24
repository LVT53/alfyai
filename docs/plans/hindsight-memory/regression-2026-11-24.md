# Memory regression run, 2026-11-24

The Memory redesign's last acceptance bar (spec "Testing and acceptance", **Regression gate**): the native lifecycle acceptance, the current-list and edit/remove holdouts and the integrated benchmark stay at or above their recorded results. They ran today against local `main` at `67e70edfe` (the release on production since this morning plus the deferred minors and the Earlier reranker rule). Synthetic data only; no production access.

**Verdict.** The lifecycle suite and the integrated benchmark are at or above their records. The benchmark found one real regression, and it is fixed: an entry took its kind from its newest fact, so a lasting entry (where you live, the device you own) turned temporary as soon as a newer plan or event mentioned it, and left every turn's recall three weeks later. The fix is `79b27f80c` (`Memory-Regression-Task: 1`): app only, read time, no migration. The current-list holdout passes in English and in its temporal holdout. Hungarian falls short twice: part 2's retain mission drops an answer-length preference phrased as a request, by design, and a row is duplicated after a document deletion (follow-up 5). The edit/remove holdout was a prototype test until today. Run through the product for the first time, it falls short of the prototype's 4/4. The causes are older than today's release (the curation checker's rejections, and a failed Remove holding the bank), listed under follow-ups. They are not regressions of this release.

| Suite | Recorded | Today |
| --- | --- | --- |
| Lifecycle, English | Partial removal honestly rejected; the rest passed | **All 37 archived checks pass**; partial removal now applied |
| Lifecycle, Hungarian | Whole Remove failed and held the bank (a later retest passed) | **All 37 checks pass**, as the later retest |
| Lifecycle, dirty cancellation | Stranded the dependent reply; recovered only after later fixes and a manual `recover` | **Recovers in one fresh run**: seed library and maps back, no schedule, later turn and Add admitted |
| Lifecycle, privacy | Passed; zero rows in 26 PostgreSQL tables | **Same**: 14/14 checks, zero rows in 26 tables |
| Lifecycle, faults | Passed, with a raw annotation leak ("from lilac to burgundy") | Passed where exercised, **no annotation leak**; the persistent fault went unexercised (see below) |
| Exact resend retest | Hungarian and metronome passed; lamp held its changed append; tea resurrected Earl Grey | Metronome and lamp the same or better, **tea defect gone**; Hungarian held after a rejected correction (see follow-up 2) |
| Current-list holdout | 2 languages and the holdout passed | English and the holdout pass; Hungarian mixed (the answer-length preference dropped by part 2's mission; a duplicate row after a document deletion) |
| Edit/remove holdout | Prototype editor: 4/4 | Through the product: 1 clean, 2 partial, 1 held (see follow-up 1) |
| Integrated benchmark | 50/72, 47/60 | **54/72, 51/60** (strict grading, as recorded) |

## How it ran

- **Hindsight** at the pin `9fb28dbd` (`deploy/hindsight/engine-commit`), installed fresh on this Mac (`hindsight-api-slim[local-onnx,embedded-db]` and `flashrank` in a Python 3.12 venv), with the suites' stand-in embedder and reranker (ONNX, FlashRank `ms-marco-MultiBERT-L-12`), the app's tenant and admission extensions from `deploy/hindsight/`, and today's `compose.yaml` model settings (12 retries, 800-second model timeout, retain's 1-second admission wait). Two instances, each with its own embedded PostgreSQL: 18890 for the lifecycle suite (stopped and restarted with its PostgreSQL mid-suite, API 11670→13183, PostgreSQL 11722→13219) and 18895 for the benchmark and the holdouts. Start script: [regression-2026-11-24/start.py](regression-2026-11-24/start.py).
- **The model**: Flash-Next (`qwen3-6-27b`) at `inference.alfycomms.com`. The recorded bridge reached it through an ssh tunnel into the production box; this run used a local bridge with the same request rules ([regression-2026-11-24/bridge.cjs](regression-2026-11-24/bridge.cjs): that alias only, `stream: false`, thinking only when asked for) and at most **3 calls in flight** (the recorded runs allowed 6). All 1,177 model calls returned HTTP 200 from the same serving build as the 2026-11-18 trace (`vllm-0.34.0-a3da6d34`); the synthetic trace is [regression-2026-11-24/model-calls.jsonl.gz](regression-2026-11-24/model-calls.jsonl.gz).
- **The admission service's activity reading**: a stand-in ([regression-2026-11-24/activity.cjs](regression-2026-11-24/activity.cjs)) answering what the recorded scratch app answered (healthy, idle, inactive), so the gateway's budget was six as recorded and the bridge held the model to three.
- **Harness changes** (all in `docs/plans`, recorded in the commits): the benchmark runner takes its Hindsight URL and scratch folder from the environment; the lifecycle runner targets the typewriter's colour card when consolidation keeps colour and desk as two cards, phrases the colour edit for that card, and gains `er-*` modes for the edit/remove holdout; `verify-reset.py` takes the PostgreSQL instance name from the environment; [verify-2026-11-24.py](native-lifecycle-acceptance/verify-2026-11-24.py) applies the archived checks to today's records and reports each one instead of stopping at the first.
- **Not exercised by any of the three suites**: the TEI reranker half of the Earlier rule. All three read Memory through the `memory_context` tool, which returns Earlier entries marked and never calls the reranker; the per-turn gate is measured separately (`label-migration-acceptance.md`, "The reranker check").

## 1. Native lifecycle acceptance

Records: [evidence-2026-11-24/](native-lifecycle-acceptance/evidence-2026-11-24/) (one gzipped record per case), checks: [results-2026-11-24.json](native-lifecycle-acceptance/results-2026-11-24.json). Runner: [run.ts](native-lifecycle-acceptance/run.ts) with `ALFYAI_LIFECYCLE_RUN=regression-20261124`.

| Step | Recorded, English | Today, English | Recorded, Hungarian | Today, Hungarian |
| --- | --- | --- | --- | --- |
| Manual Add | Applied | Applied | Applied | Applied |
| Original chat | Distinct, attributed, exact quotes | Same | Same | Same |
| Edit | Applied (walnut) | Applied | Applied (aluminium) | Applied |
| History after Edit | Gap: origin unknown, no quote, no previous version | Original chat quoted as the card's source; no previous version | Same gap | Quote **and** the previous version |
| Partial removal | **Rejected**; walnut kept on the page, missing from recall | **Applied**: "The user owns a metronome.", walnut gone from every layer | Applied | Applied |
| Unchanged resend | Passed | Passed | Passed | Passed |
| Forced re-extraction | Stamps on Aug 11, other dates kept | Same | Same | Same |
| API and PostgreSQL restart | Identical | Identical raw, observations, publication, details; recall the same entries | Identical | Identical |
| Remove acknowledged | 409, hidden at once | Same | Same | Same |
| Remove settled | Applied | Applied | **Failed and held** | **Applied** (as the later retest) |
| Resend after Remove | Passed | Passed | Blocked | Passed |
| New assertion | Maple on Aug 19 | Same, every fact on its own date | Blocked | Titanium on Aug 19, dates kept |

The one check that first failed, "restart keeps admitted recall", compares recall text: today's recall line ends in the entry's kind and age (`(lasting, said 8 days ago)`), and the restart step runs four synthetic days later, so only the ages differ. The entries are identical; the check now compares them without the age.

- **Dirty cancellation** (the relay turns Memory off right after the edit's native PATCH answers 200). The PATCH reached Hindsight, the job ended retryable with cleanup pending, the original message was deleted while Memory was off, and turning Memory on settled the action as `memory_edit_cancelled` with cleanup complete. The seed library and paper maps came back in recall; neither Monday nor Friday was shown at any step; the wind-chime turn and the brass-thimble Add were admitted. The recorded run reached this only in its fifth retest, after two fixes and a manual `recover`.
- **Privacy**: own facts only in each scope and project, 404 for the other account, Memory off and reset fences held, the late and stale facts never learned, the other account's recall kept, and an independent read-only count found **zero rows in all 26 PostgreSQL tables** for the three retired banks ([postgres-reset.json](native-lifecycle-acceptance/evidence-2026-11-24/postgres-reset.json)).
- **Faults**: a curation outage failed retryably and kept every fact; the retry with a slow response applied teal (recorded: rejected; both safe); a malformed planner answer requeued once and applied lilac; a malformed final check after a real PATCH requeued once and applied burgundy, **without the recorded run's "from lilac to burgundy" note in the raw fact**; a later unrelated turn was admitted. Two harness adaptations, both from today's consolidation keeping colour and desk as separate cards after the teal edit: the first attempt stopped on the runner's one-card assumption ([faults-first-attempt](native-lifecycle-acceptance/evidence-2026-11-24/faults-first-attempt.json.gz)), and the fixture's "I keep a burgundy typewriter on my desk" on the colour card was refused before any write (the planner listed the desk as a replacement), so the colour edits are phrased for the card ("My typewriter is burgundy."). **The persistent post-PATCH fault went unexercised**: its mint edit was refused before any write, twice, by the curation checker ("the new fact presupposes ownership ... duplicated at the new date"), so the fault never fired.
- **Exact resend retest** ([exact-carry.md](native-lifecycle-acceptance/exact-carry.md)): the English metronome correction now applies (recorded: rejected) and every later step passes; the lamp case is identical to the record (its changed append held, `memory_dependency_check_rejected`); the tea case's recorded false acceptance is gone (jasmine holds through the changed append, the deletion, the stale pointer and the first retain, and Earl Grey never returns). The Hungarian case held, see follow-up 2.

## 2. Current-list and edit/remove holdouts

Their scripts were never committed (`part-2-acceptance.md`, "Regression gate"), so both were rebuilt from their records.

### Current-list holdout

Rebuilt from its records by a subagent (Sonnet): the inputs from the recorded model trace, the stage operations and their order from `serial-api.jsonl`, the `visible` rule recovered from the recorded stages. It ran with today's bank config (`nativeBankConfig("personal")`) instead of the 2026-11-18 overrides, through the same tenant extension and gateway. Runner [regression-2026-11-24.ts](current-list-followup/regression-2026-11-24.ts), results [results-2026-11-24.json](current-list-followup/results-2026-11-24.json), grades [grades-2026-11-24.json](current-list-followup/grades-2026-11-24.json).

| Case | Recorded | Today |
| --- | --- | --- |
| English, 11 stages | Passed | **Passed, 10/10 criteria**: green backpack from the correction on (teal never again; amber only inside Hindsight's dated note from the old-source replay, as recorded), espresso, the canoe and the sister's tea through replay, pending removal and rebuild; Leuchtturm edited to Rhodia; the single fact's removal |
| Hungarian, 11 stages | Passed | **Mixed, 9/11**: green bicycle, kayak, sister in Győr, the edit and the removal pass. **The answer-length preference is never kept**: part 2's retain sentence ("requests to the assistant ... are not memories") drops "Rövid válaszokat kérek" and "Most részletes válaszokat kérek", and the extraction model's own reasoning quotes it. **The bicycle row appears twice** from the pending document's removal until the full rebuild; the recorded run never duplicated a row. |
| Holdout: Cork, Galway in 2020, an undecided Belfast move, no drill, Nora's drill | Passed | **Passed, 6/6**, the same after the rebuild |

Four more runs of the same script, made only to tell noise from systematic effects, back both Hungarian findings. English passed all five. The answer-length preference was never current in any run (in three of five a stale "short answers" row stayed). The duplicate appeared in four of five. One run lacked a current Cork row until its rebuild. Not rebuilt: the 11 deterministic presentation checks (prototype logic, now product code under its own unit tests) and the API restart comparison (the instance was shared).

### Edit/remove holdout, through the product

The recorded holdout tested the prototype editor that later became the product's curation. Today the same four frozen cases ran through the product: the original message and the restating message as chats (August 2 and 3), the operator's card edits through the real Edit and Remove actions (each the frozen after-text applied to the card that shows the detail; [edits](native-lifecycle-acceptance/evidence-2026-11-24/)), an unchanged resend of the original message (the replay), a changed resend (a forced re-extraction) and the later statement (August 23). Runner modes `er-hu-regression`, `er-en-fresh`, `er-hu-fresh`, `er-remove`.

| Case | Recorded, prototype | Today, product |
| --- | --- | --- |
| English bicycle and kayak | Passed | **Passed in outcome**: bicycle colour gone, kayak yellow, storage and brother kept, nothing returned through the replay or the re-extraction, purple bicycle admitted. One of three card edits was refused (the storage card); the other two covered it. |
| Hungarian cats and diet | Passed | **Held**: the cats edit was refused; the Remove of the user's own gluten-free card was refused by the checker (twice, arguing whether Luca's half of a shared fact had to go), so its exclusion stayed with cleanup pending, Luca's card was hidden with it (one shared raw fact), and every later turn failed `memory_curation_publication_held`, the brown-fur statement included. |
| Hungarian instruments and diet | Passed | **Partial**: guitar colour gone, piano brown, instruments, Márton's diet and Szeged kept, white guitar admitted; but the Márton edit was refused, and before the Remove ran the user's own diet card had merged into "the user and Márton don't eat meat", so the user's diet stays. |
| Whole telescope removal | Passed | **Removal passed** (every layer; the sister's telescope and birdwatching kept, the replay clean), but the forced re-extraction was held (`memory_dependency_check_rejected`) and the later "bought a blue telescope" then failed publication (`memory_candidate_unaccepted`): the held re-extraction's facts sit in Hindsight unaccepted and taint the observation. |

None of this comes from today's release: the curation prompts are unchanged since 2026-11-19 (today's commits only touched their admission plumbing), and the recorded runs already show the same holds: the original Hungarian lifecycle's failed Remove held the bank for every later turn (2026-11-18), and exact-carry's English amber correction, refused at its final check, held the bank for the steps after it. It is the first product-level run of these cases. Follow-up 1.

## 3. Integrated benchmark

Records: [results-2026-11-24/](integrated-native-benchmark/results-2026-11-24/), grades: [manual-grades-2026-11-24.json](integrated-native-benchmark/manual-grades-2026-11-24.json), summary: [results-2026-11-24.json](integrated-native-benchmark/results-2026-11-24.json). All 102 deliveries succeeded on their first attempt (as recorded); 915 admitted rows, every one a current published row in scope; median recall 210 ms. Graded by hand with the recorded grader's strictness ([compare-2026-11-24.py](integrated-native-benchmark/compare-2026-11-24.py) prints each recorded answer and grade beside today's).

| Family | Recorded | Today |
| --- | ---: | ---: |
| Future itinerary | 4/6 | **6/6** |
| Current itinerary | 1/6 | **5/6** |
| Completed itinerary | 4/6 | 4/6 |
| Updated device ownership | 5/6 | **2/6** |
| Fiction and quotation attribution | 5/6 | 6/6 |
| Conditional relocation | 6/6 | 5/6 |
| Project response style | 5/6 | 6/6 |
| Project continuity | 5/6 | 6/6 |
| Updated general response format | 6/6 | 5/6 |
| Dietary personalization | 3/6 | 3/6 |
| Personal allergy mentioned in Atlas | 0/6 | 0/6 |
| Codename and hobby | 6/6 | 6/6 |
| **All 72 / scope-compatible 60** | **50 / 47** | **54 / 51** |

- **Itineraries** gained most: consolidation now keeps the outbound and return dates explicit ("traveling on Friday, September 4 and returning home on Monday, September 7") where it used to write a range, so the answers stopped inventing workshop dates. p05 still wrote a range, and its two answers dated the course by it, as recorded.
- **Device ownership** dropped by grading strictness: in p01 to p04 consolidation folded the sold device and its replacement into one entry ("owns a Nikon Z5 and uses it as their everyday device; earlier they owned a Canon EOS R8"), carrying "everyday device" over to the replacement. The recorded grader failed exactly this in p03, so today's p01, p02 and p04 fail too. The rubric's own details are right in all six, and replacing your everyday device arguably makes the new one your everyday device: counted that way, today is 57/72 and 54/60. The fold comes from part 2's mission ("keep the old value only as earlier history in the same observation").
- **Conditional relocation**: p03 said "You live in Chester, though this status is marked as temporary": the regression below.
- **Format** p05/08 and **completed itinerary** p03/02 are answer errors with the right evidence in recall (three sentences against a recalled two-sentence rule; "you are not back home" two days after the recalled return).
- **Allergy**: all six Atlas allergy statements were kept and stayed in Atlas, as recorded; every direct answer fails the rubric by design of the scope.

## The regression found and fixed

**An entry took its kind from its newest fact** (`entryLabels`, part 2), so a lasting entry became temporary whenever a newer plan or event mentioned it, and Earlier three weeks later. In the benchmark, 11 of the 124 published entries mixed a lasting fact with a temporary or ongoing one: the current device in every profile but p06, and the home city in p03 ("The user lives in Chester" gained "I might relocate next year ... my home has not changed") and p04 (Szeged). The spec says the opposite ("the current situation ... is lasting: replaced, never aged by silence"; "when unsure, the label leans toward lasting: ... a wrongly temporary one silently drops out of recall"). Part 2's plan only considered the other order (temporary, then a newer lasting fact).

The fix (`79b27f80c`): an entry takes the most lasting kind among its facts (lasting, then ongoing, then temporary); its subject still comes from its newest labelled fact. Tests: `entry-view.test.ts` ("a lasting entry stays current when a newer temporary fact joins it", the Chester case) and `fact-labels.test.ts` (the kind table), both seen failing first. Recall and the Memory page read entries in one place (`memoryEntryView`), so one change covers both; it decides at read time, so production's labelled accounts need no migration. The memory-profile and memory-context tests pass (965), and the agent gate passed at that commit with the harness changes in the tree: `npm run check` 0 errors and 0 warnings, Biome, migrations, 38 Python tests, vitest 30,090 tests, the build, chunks, Fallow with no new finding, and `chat.spec.ts`, `memory-subjects.spec.ts` and every other file's `@smoke` tests, 54 of 54.

**Measured in isolation** ([recheck-2026-11-24.ts](integrated-native-benchmark/recheck-2026-11-24.ts)): every check from October 1 on comes after its profile's last message, so the run's final state is exactly what those 54 checks read. Rerunning the real tool on the same clock with the fix changed only the mixed entries' annotations (`earlier, temporary` → `lasting`, `temporary` → `ongoing`); no entry's text or order moved. p03/05 no longer hedges (fail → pass). Re-asking the other answers moved them in both directions on unchanged evidence lines (p04/09, p05/04 worse; p05/08 better), which is answer variance at temperature 0, not the fix. p06/03 read the PocketBook purchase, still labelled temporary by extraction (follow-up 3), as a temporary device.

## Differences the stand-ins or the new design explain

- **Labels.** Every recall line now carries the entry's kind and age (`(lasting, said 3 weeks ago)`), and an Earlier entry is marked. The answer model read "temporary" once as a fact about the user (p03/05, now fixed at the source) and once about a device (p06/03, follow-up 3).
- **The Earlier rule.** The suites read Memory through the `memory_context` tool, which returns Earlier entries marked and never calls the reranker, so the reranker floors were not exercised; on this scratch stack (no TEI) the per-turn gate would fall back to the word rule alone. Earlier entries appeared where expected: past trips from three weeks after their return.
- **Extraction keeps less, by design.** 133 raw facts against 144 recorded; 10 sources left none against 3 (requests and quotations: rewriting a fictional line, summarising a review, comparing a product and asking its accessory prices). No answer lost a fact it needed.
- **Recall's fair split.** These banks hold far fewer entries than the tool's 8,000-token budget, so the split never had to cut: 915 rows were admitted against 1,020 recorded, following the smaller number of published entries (124 against 141). The project lanes held: project style and continuity 12/12, no row out of scope, the Atlas allergy never in a personal chat. The budget and the core share are measured on a 5,000-entry bank separately (part 1).
- **The model's path and concurrency.** At most 3 calls in flight against the recorded 6, through a direct bridge: slower, not different. Median settlement 28.8 seconds against 11.7.

## Follow-ups (not fixed today, the owner's call)

1. **A refused Remove, or a held changed resend, holds the bank's later learning.** A Remove's exclusion is acknowledged at once; when the checker then refuses it, cleanup stays pending and every later publication of the bank fails `memory_curation_publication_held` (hu-regression); a held re-extraction leaves unaccepted facts in Hindsight that make later publications fail `memory_candidate_unaccepted` (the telescope case). Both holds are in the recorded runs: the original Hungarian lifecycle's Remove (2026-11-18) and exact-carry's English amber correction. Today's runs had the checker refuse a Remove over a shared fact, and objections to re-dated ownership. Deciding how a refused removal settles (stronger removal, or a permanent filter that releases the rest of the bank) is a design call.
2. **An unchanged resend after a refused correction can unpublish the chat's facts.** The refused correction's staged draft was deleted, Hindsight rebuilt the sewing-box observation with slightly different text ("varródooboza"), and the unchanged-resend check (`verifyUnchangedDisplay`, since 2026-11-19) requires the exact published text, so the resend failed three times (`memory_unchanged_source_fact_missing`) while the original source stayed revoked.
3. **Extraction labels a purchase or sale as temporary** ("bought a PocketBook Era on September 9"): the kind wording calls any dated event temporary. Today's fix covers the entries where a lasting fact sits beside such an event; an entry made only of the event still ages. Rewording the kind label is a bank config change (config 3) and needs part 2's label targets measured again.
4. **The replacement inherits the sold device's habit** (p01 to p04, above). Defensible, but the recorded grader counted it as unsupported.
5. **A duplicate row after a document deletion** (current-list Hungarian, four of five runs): Hindsight's rebuild after the pending document's removal wrote the green-bicycle observation twice, so the page would show two identical cards until a full rebuild merges them. Not seen with the 2026-11-18 mission.
6. **An answer-length preference phrased as a request is not remembered** ("Rövid válaszokat kérek", "Most részletes válaszokat kérek"): part 2's retain mission treats it as a request to the assistant. An explicitly standing rule ("from September 15, answer in two short sentences unless I ask otherwise") is kept, in every benchmark profile. Whether "answer briefly" alone should be remembered is the owner's call.

## Reproduce

From the repository root, with `/tmp/alfyai-hindsight-eval` holding the pinned source and venv (part 2's install steps), the bridge, the activity stand-in and the two Hindsight instances started as in the start script's header. Then:

```sh
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
# Lifecycle (18890): en and hu first, restart 18890 with its PostgreSQL, then after-restart; the rest once
ALFYAI_LIFECYCLE_RUN=regression-20261124 node --import tsx docs/plans/hindsight-memory/native-lifecycle-acceptance/run.ts en
# ... hu; en after-restart; hu after-restart; cancel; privacy; faults; carry-hu; carry-en (METRONOME, NO_CORRECTION, TEA+TRIM_REPLY variants, each its own run name)
# Edit/remove holdout: er-<case> first, write the operator's edits, then er-<case> continue with ALFYAI_LIFECYCLE_ER_EDITS=<edits.json>
python3 docs/plans/hindsight-memory/native-lifecycle-acceptance/verify-2026-11-24.py <records folder> <out.json>
# Benchmark (18895)
ALFYAI_BENCH_SCRATCH=<folder> ALFYAI_BENCH_HINDSIGHT_URL=http://127.0.0.1:18895 node --import tsx docs/plans/hindsight-memory/integrated-native-benchmark/run.ts p01   # ... p06
python3 docs/plans/hindsight-memory/integrated-native-benchmark/compare-2026-11-24.py <folder> [p01 ...] [--evidence]
```
