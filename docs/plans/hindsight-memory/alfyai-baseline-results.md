# Actual AlfyAI baseline against the Hindsight decision bench

2026-11-18. **The missing baseline is now measured. Hindsight's earlier 69/72 materially exceeds the current AlfyAI memory pipeline's 37/72 with tool assistance (32/72 passive).** This supports Hindsight as the leading replacement candidate on this dataset. It does not prove production-wide accuracy or settle correction/deletion guarantees.

The earlier 64/72 number was the same model supplied with all raw user history—not AlfyAI. Treating it as the existing-system baseline was incorrect. The earlier benchmark did explicitly disclose that AlfyAI had not been rerun, but subsequent adoption discussion did not keep that limitation sufficiently clear.

## Results

| Memory/context path | Fully grounded answers |
|---|---:|
| Hindsight facts + original evidence, earlier frozen run | **69/72** |
| Raw history, earlier comparator—not an AlfyAI pipeline | 64/72 |
| Actual AlfyAI, passive context plus existing memory-tool results | **37/72** |
| Actual AlfyAI, normal passive context only | **32/72** |

Three English conditional-relocation answers in each AlfyAI arm say there is no record/evidence of a decision instead of recalling the explicitly undecided plan. Under a lenient interpretation these pass, giving **40/72 tool-assisted and 35/72 passive**. The overall conclusion is unchanged. Both interpretations are recorded, not silently selected to favour an engine.

| Scenario family (6 checks each) | AlfyAI passive | AlfyAI tool-assisted |
|---|---:|---:|
| Future itinerary | 3 | 3 |
| Current itinerary | 4 | 4 |
| Completed itinerary | 0 | 1 |
| Updated device ownership | 0 | 0 |
| Fiction/quotation attribution, including added claims | 2 | 2 |
| Known conditional relocation | 0 | 0 |
| Project-specific response style | 6 | 6 |
| Project continuity | 2 | 6 |
| Updated general response preference | 0 | 0 |
| Dietary personalization | 6 | 6 |
| Personal allergy mentioned in another project | 6 | 6 |
| Codename/hobby continuity | 3 | 3 |

## What actually ran

AlfyAI checkout `e60bb0c114c02a3063d5bf6972ddeb813cccbf6c`. Six new migrated SQLite databases, 102 unchanged synthetic source sessions, 72 unchanged questions, 144 answer generations. **All six runs completed; zero unjudged messages, zero recorded intake/task/consolidation/retrieval execution errors.** Normal rejection/filtering of candidate facts is product behaviour, not an execution failure.

This invokes the real conversation/message persistence, `updateTaskStateCheckpoint`, `judgeFinishedTurn`, idle flush/dirty sweep, nightly consolidation, `buildConstructedContext`, and public `getMemoryContext`. No mocked extractor, copied intake prompt, custom fact selector or direct insertion of desired memories. Review items were not automatically accepted. JS and SQLite clocks agree on historical time; nightly maintenance ran across the intervening days. Same-day event order is copied from the original Hindsight runner, including its inherited same-day comparator reversal, so one arm is not given a different ordering.

The intended local Flash Next model alias and exact original answer function were used. The current AlfyAI memory calls retain their normal thinking-off implementation. Real configured Qwen embedding inference was enabled through the bounded remote configuration/inference helper; synthetic content only. The deployed non-secret configuration reported embeddings enabled (`qwen3-embedding-4b`) and memory dry-run false. This is a same-model current-code baseline, not a copied production database/provider configuration or a live deployment test. The original Hindsight run and this run reported the same vLLM runtime fingerprint; that alone is not proof of identical model weights or deterministic inference.

The passive arm uses actual constructed context. The tool-assisted arm additionally supplies actual persona retrieval and, only for a current project, actual project-summary retrieval. It never selects sources using gold answers or fixture categories. Both arms use the exact original shared answer prompt, temperature and output budget. No missing fact is rescued by dumping raw history.

The source dataset contains user messages only. Consequently the harness uses empty assistant text, and does not force conversation-summary refresh that the normal finalizer would skip. Actual task checkpoints provide the existing project-summary fallback. This is a **settled service-level memory/context benchmark**, not full Normal Chat tool-selection, UI, streaming, scheduling or latency acceptance. A chat agent allowed to search history or request project details might recover some missing information; that behaviour was not measured here. Hindsight was likewise given retrieval explicitly, making the tool-assisted AlfyAI arm the closer comparison.

## Why AlfyAI lost information

Stored records and telemetry identify real causes, not just weak answers:

- **14 candidates were rejected with `missing_target`.** These include all six replacement-device updates and all six changed response-format preferences. Old ownership and numbered-list preferences remained available. Several model proposals also transferred an everyday-use habit to a replacement device without evidence; fixing the target-reference issue alone would not validate every proposal.
- Completed trips were missing or still phrased as “this Friday … Monday,” allowing the reader to resolve old relative dates against the later question date. All six passive completed-itinerary answers failed.
- The three Hungarian codenames were unavailable by the final question; answers either invented Atlas/Cedar as the codename or admitted not knowing. The English codenames survived.
- Fiction/profession questions often received a correct “unknown” core answer but appended stale device ownership or obsolete preferences. Those additional personal claims fail the same grounding rubric used for Hindsight.
- Project summaries recovered continuity that passive context often lacked. Diet, allergy and project-style recall worked well, so this is not an all-or-nothing failure of the existing system.

Do not infer that every gap requires a wholesale replacement: the target-reference failures are concrete AlfyAI defects that could be fixed. Equally, do not assume fixing those defects would close the remaining gap without measurement. No product fix was made during the benchmark.

## Limits and interpretation

The set has twelve scenario families across six synthetic users, not 72 independent types of challenge. Manual grading is non-blind; all 144 answers were reviewed, with independent grading/peer review and explicit ambiguity records. Required content and unsupported additions matter; ordinary equivalent wording is accepted. Recipe checks are feasibility judgments, not medical or cooking validation. Pronoun/style slips are recorded separately unless they change a scored fact.

The Hindsight score is the earlier frozen run, not a newly randomized simultaneous A/B test. Its original-evidence access and different embedding stack are part of that tested configuration. Hindsight's more recent retain-reasoning setting was **not** used for that 69/72 result. No score for the newer candidate is invented.

AlfyAI mean answer input was about 460 tokens passive and 1,883 with tools; the earlier verbose Hindsight representation averaged 12,442. That integration overhead still needs reduction. These figures do not measure total engine cost or production capacity.

**Practical conclusion:** the owner was right to insist on the baseline. We now have substantial measured support for a meaningful improvement from native Hindsight, while correction/replay remains a separate release-quality concern. Do not discard a demonstrated retrieval/retention gain simply because no LLM memory engine is perfect; also do not use the average gain to conceal unreliable manual changes.

## Evidence

[Protocol and runner](alfyai-baseline/plan.md), [summary](alfyai-baseline/summary.json), [all graded answers](alfyai-baseline/graded-answers.json), [stored-state diagnostics](alfyai-baseline/diagnostics.json), [grading ambiguities](alfyai-baseline/grading-ambiguities-p01-p03.json), [actual integration seams](alfyai-baseline-seams.md), [original Hindsight report](prior-findings/larger-benchmark.md). Per-profile results, compressed synthetic databases/model transcripts and hashes live in `alfyai-baseline/`.

No product code, deployment, real-user data or upstream work. The connection helper's first launch was rejected by automatic approval review; it was tightened to explicit read-only/query-only remote configuration access and separate guarded local scratch databases, then approved. All inference data and stored memory in this evaluation were synthetic.
