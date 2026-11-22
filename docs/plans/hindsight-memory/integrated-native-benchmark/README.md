# Integrated native Memory benchmark

This synthetic evaluation uses the app's new-account enrollment, completed-turn Memory delivery, job engine, publication and `memory_context` persona tool. The local answer model receives only the actual persona tool's model-facing content and the frozen current question. [Frozen cases and shared answer prompt](../alfyai-baseline/)

## Reproduce

Run from the repository root with Node 22 and the pinned Hindsight evaluation environment described in the native operations report. Use a fresh scratch namespace or resume with the matching six SQLite files, per-run JSON checkpoints and scratch PostgreSQL database. These paths are reserved for this synthetic benchmark. [Scratch native service setup](../native-operations-fixes.md)

1. Start the existing Flash Next bridge on loopback port 18891 with `ALFYAI_NATIVE_MODEL_TRACE=/tmp/alfyai-integrated-memory/model-calls.jsonl`. Bridge inference accepts only the configured `qwen3-6-27b` alias, whose name does not establish model size.
2. Use the scratch app launcher from the operations report with `DATABASE_PATH=/tmp/alfyai-integrated-memory/admission.db` and a unique Vite cache. Start the app at 18893 and point the scratch Hindsight startup script's admission URL at `http://127.0.0.1:18893/api/internal/memory-admission`. Launch pinned Hindsight at 18890 using the fresh scratch PostgreSQL database `ALFYAI_NATIVE_DATABASE_URL=pg0://alfyai-integrated-bench-20261118`.
3. Run `/opt/homebrew/opt/node@22/bin/node --import tsx docs/plans/hindsight-memory/integrated-native-benchmark/run.ts p01` and repeat for IDs `p02` through `p06`. Six processes can run concurrently when the real admission route permits it. Each profile has its own SQLite and native account, each with its own randomly assigned tenant and banks.
4. The runner saves the completed events in an atomic JSON checkpoint after each event. Keep the JSON and matching SQLite/PostgreSQL state together to resume. If the process stops between persisting a source message and enqueueing its job, use a fresh synthetic profile run. Terminal failures remain in the recorded sequence. A check that has returned an answer error stays recorded as an error.
5. Use `python3 docs/plans/hindsight-memory/integrated-native-benchmark/review.py answers --evidence` for offline inspection and `python3 docs/plans/hindsight-memory/integrated-native-benchmark/review.py summary` to recompute the aggregate from the archived records and manual grades.

## Comparison protocol

- Use all 102 original authored messages and 72 original questions. The application and provider inputs are stripped of the rubric, category, required details and forbidden details. No benchmark question or answer is persisted as a message. Each query runs in a new empty conversation under its original project context.
- The synthetic account is enrolled with Memory enabled before its first historical fixture date through the normal initialization service. Each dated turn captures its real application admission stamp and rechecks the actual historical policy. A constant `Acknowledged.` assistant row meets the completed-turn contract without adding biographical information. The app assigns the source's date, scope and identity, and sends its real retain/consolidation work to pinned Hindsight.
- On dates with multiple sources, preserve the frozen source array order. The historical comparators used a same-day sort callback that reversed some sources. Historical comparisons are descriptive and this order difference is documented.
- Use the real public persona tool and its own 8,000-token bound with the unmodified query. The app may prepare personal and current-project observations. The harness resolves every tool evidence reference against the currently accepted app publication with the correct scope. Raw conversation passages and raw extraction facts are retained in the audit records only. The native client currently does not send the synthetic query date to Hindsight ranking, although the answer function receives the frozen date and Dublin time zone.
- Use the exact shared answer function from the earlier runs, including temperature zero, the 400-token ceiling and the guidance that general personal facts can come from any project. The app enforces current project boundaries before this function receives evidence, so a personal statement in a different project remains unavailable. This is a settled service-level benchmark. Normal Chat's own tool selection, passive context, UI, full scheduling and alternate history/continuity tools are outside this measurement.
- Grade each answer manually using expected and forbidden details plus extra unsupported assertions. Classify extraction, publication, recall, scope and answering evidence independently. The same family repeats across six profiles, so percentages summarize this synthetic dataset. Recipe judgments cover the rubric's stated ingredients and timing, with no medical safety verification. User-action rejection and replay belong to the separate lifecycle acceptance.

## Results

The integrated Memory path passed **50/72** frozen answer checks and **47/60** checks whose rubric is compatible with the current project boundary. All 102 source jobs succeeded on their first attempt. The app admitted 1,020 recall rows across the 72 queries, each matching a current accepted row in the user's personal or current-project bank. Nineteen answers contained 20 unsupported assertions. [Aggregate](summary.json) · [All 72 manual grades](manual-grades.json)

| Scored path | All 72 frozen cases | Same 60 scope-compatible cases |
| --- | ---: | ---: |
| Integrated app Memory tool and frozen answer prompt | **50** | **47** |
| Earlier standalone Hindsight with original evidence | 69 | 58 |
| Earlier legacy AlfyAI with tools | 37 | 25 |
| Earlier legacy AlfyAI passive | 32 | 20 |
| Earlier full raw-history comparator | 64 | 52 |

The 60-case set excludes the six direct allergy and six personalized-lunch cases because both families have an Atlas-only dependency. The set is defined by the frozen source and rubric. The historical columns use the original archived judgments for those same IDs. The older Hindsight input included original chunks, raw source facts and native ranked observations. The integrated app supplies accepted observation text. The runs also differ in extraction configuration and same-day ordering, and the judgments are manual and non-blind. The 72 questions repeat twelve templates across the six profiles. [Recomputed comparison and source hashes](comparison.json) · [Legacy graded answers](../alfyai-baseline/graded-answers.json) · [Earlier Hindsight setup](../prior-findings/larger-benchmark.md)

| Scenario family | Full answer passes | Sufficient grounded evidence in recall |
| --- | ---: | ---: |
| Future itinerary | 4/6 | 6/6 |
| Current itinerary | 1/6 | 6/6 |
| Completed itinerary | 4/6 | 6/6 |
| Updated device ownership | 5/6 | 5/6 |
| Fiction and quotation attribution | 5/6 | 6/6 |
| Conditional relocation | 6/6 | 6/6 |
| Project response style | 5/6 | 6/6 |
| Project continuity | 5/6 | 6/6 |
| Updated general response format | 6/6 | 6/6 |
| Dietary personalization | 3/6 | 0/6 |
| Personal allergy mentioned in Atlas | 0/6 | 0/6 |
| Codename and hobby | 6/6 | 6/6 |

### Storage, attribution and recall

- The 102 app source revisions were accepted. The job engine acknowledged 144 native raw facts and exposed 141 final observations across 18 scoped banks (93 personal, 48 project). Three stranger-quotation sessions produced zero raw facts. The remaining stranger-quotation extractions and all fictional-dialogue extractions preserved attribution. Device comparisons became interest or accessory-help facts, and raw ownership remained assigned to the correct person. All six dated sold-device changes, all six no-list updates and all six Atlas allergy statements were retained.
- Native consolidation transferred an unsupported everyday-use habit from the sold Prusa to the replacement Creality in p03. The raw source facts preserved the old habit and the new ownership independently. The false combined observation was published, recalled and repeated in the answer. Other scope-compatible checks had sufficient grounded recall for their required content. The Hungarian p04 format observation also shifts who is speaking by phrasing the new style as how the user likes to answer. The corresponding response still followed the intended format.
- All six raw itinerary extractions preserved outbound and home-return dates. In p01, p03 and p06, consolidation expressed them as a trip range, weakening the explicit return distinction. Both English failures on the future question correctly named the trip start, then answered departure with the return date. The two facts were available as a trip range. Seven other itinerary answers invented workshop or course timing from the travel span. The expected destination or home was present in recall. These nine strict answer failures account for most of the gap from the earlier standalone result.
- The three remaining scope-compatible misses occurred with sufficient evidence. p04 confused the fictional boats with the customer review. p06 attached the general two-sentence format exclusively to Cedar in one answer and omitted the explicitly recalled copy approval in another.
- The 20 unsupported assertions comprise two wrong departure claims, seven unsupported course or workshop dates, one transferred everyday-device habit, one quotation-source conflation, one project/general preference conflation, three dietary-preference embellishments, four overbroad records or history claims, and one ambiguous affirmation of allergy in response to a food dislike. There were 19 affected answers because the final p06 allergy response contained two assertions. The manual record preserves each exact judgment.

### Project boundary

All six Atlas allergy statements were present in accepted Atlas observations and stayed outside personal recall across the 12 affected checks. In the direct allergy answers, p04 and p05 expressed an absence of available knowledge. Four answers made broad “no recorded allergy” or “you have not mentioned” claims without saying that their evidence was limited to this chat's scope. The historical rubric expects the actual allergy and scores all six direct answers as failures. The application passed the scoped disclosure check for all six.

At ingredient and timing level, p01, p05 and p06 offered two plausible meals satisfying the accessible personal constraints. The answers happened to omit peanuts, but the assay yielded zero observations of actual allergy-aware personalization in these personal chats. p02, p03 and p04 embellished what the user said about including eggs or dairy. This is a recall-scope and answer-grounding assessment.

### Process and provider evidence

All 72 answer calls completed normally within the frozen 400-token output limit with the configured local alias, and all 319 traced provider responses were HTTP 200. The gateway handled 102 retains and 144 consolidation calls with peak concurrency six and zero admission rejections. Median isolated-profile job settlement was 11.74 seconds, median app recall 170 ms and median answer generation 637 ms. Mean answer input was 540 tokens. These are measurements under this scratch run's overlap and small banks. The answer envelope was checked against every frozen current question and contained only the current date, time zone, project, question and actual tool content. This run had zero deliberate edit/remove actions, so it provides no edit rejection estimate. [Provider counters](provider.json) · [Replay and correction acceptance plan](../../../superpowers/plans/2026-11-18-hindsight-memory-replacement.md)

The batch began at Git HEAD `e60bb0c114c02a3063d5bf6972ddeb813cccbf6c` with a dirty product worktree. Native code was pinned to `9fb28dbd724dc1ce4da7cb4c49008e601db76c5f`. Concurrent edits changed two curation file hashes during process startup. The one-shot TypeScript processes had no hot reload. Fresh source delivery reaches the curation runner's empty-action branch, so these fixtures used no curation intent, predecessor or replay work. The provider traces contain retain, consolidation, answer and preflight requests only. The later `curation-lineage.ts` and `migration-progress.ts` hash changes were observed after all six profiles had finished. No benchmark account had a migration manifest. [Start fingerprint](source-fingerprint.json) · [Observed workspace drift](source-drift.json)

Six compressed profile files preserve the decoded raw facts, job attempts, accepted observation snapshots, app recall results and exact returned answers. The original benchmark fixture and generated records are synthetic. This evaluation added benchmark artifacts only.

A separate frozen-input diagnostic repeated the 60 compatible observations and compared them with their exact archived linked raw facts. Results and tradeoffs are recorded with the paired outputs. [Paired evidence diagnostic](paired/README.md)
