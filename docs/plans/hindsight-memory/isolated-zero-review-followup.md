# Isolated zero-review replay follow-up

The follow-up removed the previously flagged transient admission and fixed the batch validation failure. It recovered one of seven possible misses from the original skip sample, while dropping 16 admissions that passed the original candidate audit. The revised automatic selection is more conservative and changes which facts it covers. It does not establish a case for zero-review production migration.

## Diagnosing the first run

The first run's [result report](isolated-zero-review-results.md) records 281 native dry-run drafts from the 285 allowed messages. The independent audit flagged seven possible false negatives in a frozen 24-skip sample. Four had received a model judgment of not durable and two had received a judgment of unsupported. A seventh received an admit verdict but failed the deterministic guard for native annotation. Its annotation contained multiple components and was outside the app's narrow owner-only suffix rule. The seven were separate from the ten skips caused by two invalid responses.

The first run discarded response diagnostics. An exact replay of the two affected batches reproduced invalid reason-enum values in three of four attempts. The client saw a valid candidate ID set and otherwise valid fields on those attempts. The remaining attempt passed. This identifies a reproducible failure mode without establishing the contents of the discarded original responses.

## Changes and cost

The revised arm reused byte-identical native extraction from the authorized source seal. It made no new preview extraction calls and did not load the other 261 message bodies from the original 546-message cohort. The isolated app and native tenant were separate from the first run. Both protected authored edits were preserved.

The classifier requested schema-constrained reason values and still checked candidate IDs and fields before accepting a verdict. Only unverified entries qualified for smaller follow-up requests. All 281 candidates obtained valid results and fallback was unnecessary. For annotation-marked candidates, the model checked the underlying proposition against the complete authored message. Source evidence still had to retain ownership, time, scope and conditions without relying on annotation. The rubric clarified the distinction between continuing project conventions and completed work, tests and point-in-time software state.

The first pass provisionally admitted 55 candidates, including the previously flagged transient. A second, independent durability rubric using the same local model checked all provisional admissions. It passed 21, flagged 28 as transient and found six inconclusive. The final selection excluded every provisional admission that did not pass the second rubric. Both rubrics used the approved local Qwen gateway. The revised selection took 65 classifier requests, 49 for the first pass and 16 for the countercheck. The four diagnostic replay calls, native publication work and benchmark calls are separate. Separate rubrics provide another opportunity to catch mistakes, and they can still share model errors.

| Candidate disposition | First run | Revised run |
| --- | ---: | ---: |
| Eligible sealed source messages | 285 | 285 |
| Native drafts | 281 | 281 |
| Automatic admissions | 26 | 21 |
| Skipped | 253 | 258 |
| Held drafts / review clusters | 2 / 2 | 2 / 2 |
| Overflow | 0 | 0 |
| Unresolved classifier drafts | 10 | 0 |

Nine of the original 26 admissions stayed. The previously identified transient was removed alongside 16 candidates that had passed the original audit. The revision automatically admitted 12 candidates absent from the original admissions, including one of seven possible misses in the sampled skips. The recovered assertion had originally been classified as unsupported. Five of the remaining six again failed the durability requirement. The annotation-related candidate reached the second pass and was excluded as transient. Independent rechecking found that five of the six remaining skips were appropriate and one still appeared to be a plausible useful fact. All 16 previously justified skips in that sample stayed skipped. The one earlier inconclusive sample item is held. The ten drafts affected by invalid responses received valid skip outcomes in the revision. Held items stayed outside publication and received no human decisions. The real cohort did not exercise overflow. All 23 selected or protected sources went through the canonical isolated publication path. All 24 jobs succeeded including provision, yielding 28 published observations backed by 52 native rows across six banks. No pending native operations remained.

## Evaluation

The independent judge froze a source-only panel before any revision. It contains 21 cases in 18 families across four projects. It covers protected current facts, durable personal and project facts, ownership and dated source attribution, and wrong-scope and unknown controls. The revision had no access to questions, gold labels or arm answers. The judge ran the same local model settings against the protected-subset legacy mirror and both isolated native variants, then graded blinded responses.

| Frozen panel | Legacy mirror | First native run | Revised native run |
| --- | ---: | ---: | ---: |
| All cases | 7/21 | 10/21 | 11/21 |
| Durable and protected current positives | 0/10 | 3/10 | 3/10 |
| Dated source-attribution positives through current recall | 0/4 | 0/4 | 1/4 |
| Wrong-scope and unknown controls | 7/7 | 7/7 | 7/7 |

Compared with the first native run, the revision recovered two durable project answers and one dated answer. It lost one project answer and one personal answer. The dated cases tested attribution from the current Memory reader. Explicit historical chat search was not used. Both isolated variants answered every case they attempted correctly on this panel. The revised arm attempted four of 14 positive cases and the first native arm attempted three, so the main weakness was coverage. The legacy mirror represents the protected subset of the old baseline. The comparison cannot estimate quality across the full original legacy profile.

## Independent audits

All 28 revised observations had exact structural support and matched their source date and scope. The substantive audit passed 25, flagged one transient observation and left two inconclusive. Fourteen observations depended on newly admitted candidates. Twelve passed, one was transient and one was inconclusive. At the pre-retain stage, the independent audit of the 12 newly admitted candidates found eight passes, three transient assertions and one unsupported assertion. Canonical native delivery can split or rephrase a candidate, so those two levels count different items. The old transient was removed, and a different transient was still visible in the revised replay.

The audit found that one of the two held candidates warranted a review and the other was transient or of little value. Both remained held with no resolution. The revised arm is an experiment with measurable false positives and omissions.

## Production boundary

Production Memory stayed paused for migration. Legacy Memory continued serving, and the already prepared inactive production native migration was not cut over. The isolated variant used the verified staging gateway only. The restricted executor blocked the same three non-stage endpoints and three production paths. An independent check confirmed that production state was unchanged. Both isolated arms and checksum-verified evidence remain on the authorized host. No product code changed, and nothing was pushed or deployed.
