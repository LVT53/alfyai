# Where the isolated replay lost seven current facts

The revised native replay missed seven of ten current-fact probes. All seven cited messages were inside the allowed cohort, and each produced at least one native draft. None of those drafts reached the revised published generation. A separate semantic review found a draft expressing the requested assertion for every case. It found one clear durable coverage miss and flagged the other six frozen current labels as time-bound.

## Evidence through selection and publication

Labels C1–C7 stand for opaque frozen probe IDs. The trace used the sealed source and benchmark receipts, draft classifications, durability verdicts, source acknowledgements, current-generation publication support, and the recall evidence saved during the original benchmark. The two isolated databases were opened read-only. No replay, model calls or bank writes were made for the structural trace.

| Case | Probe family | Native drafts from cited message | Recorded stop | First native run | Post-hoc durability |
| --- | --- | ---: | --- | --- | --- |
| C1 | Durable project | 2 | First pass skipped the intact draft as unsupported and the partial draft as not durable | Missed | Time-bound |
| C2 | Ownership attribution | 3 | First pass skipped both intact drafts as not durable. A separate draft that did not answer the probe failed the source-scope check | Missed | Time-bound |
| C3 | Durable project | 1 | First pass classified the draft as not durable | Missed | Time-bound |
| C4 | Durable personal | 1 | First pass admitted the draft. Durability validation ended inconclusive | Passed | Durable |
| C5 | Durable project | 1 | First pass admitted the draft. Durability validation classified it as transient | Passed | Time-bound |
| C6 | Durable project | 1 | First pass classified the draft as not durable | Missed | Time-bound |
| C7 | Durable personal | 1 | First pass classified the draft as not durable | Missed | Time-bound |

For C4, all four candidates in the same durability batch have the inconclusive marker. The harness recorded that same marker for unresolved model judgments and for failed or invalid batch responses. The receipt cannot distinguish the two explanations. For both C4 and C5, the first native run delivered an observation linked to the cited source and included it in the saved recall evidence.

## Alternate support and answer context

The semantic reviewer used the approved staging-local model to compare the sealed assertions with the drafts, actual published observations and saved answer context. It did not rerun extraction, recall or answer generation. It found no intact version of any of the seven assertions in the revised published generation or in the saved model prompts.

C1 and C2 had intact alternate support within the allowed scope. The reviewer found two alternate authored sources for C1 and one for C2, with one intact alternate draft for each case. Those drafts did not reach publication. C1 had two related observations in its saved recall context, but they omitted required detail and did not establish the requested fact. The reviewer found no additional intact in-scope alternative for the other five in its targeted scan. A semantic review cannot prove absence of every paraphrase.

## Interpretation

The benchmark's original 3/10 current score stands under the frozen labels. The post-hoc durability check flags six of those seven misses as questionable current positives. They may still be valid dated claims. C4 is the one clear durable miss under this check, and the failure occurred during durability validation before publication. Regrading the benchmark retrospectively would change the experiment.

The evidence points to admission policy and, in one case, an unresolved validation batch. It does not show an intact published current fact being lost by retrieval or answer generation for these seven. All work remained on the isolated host. No selection rules, bank state or production state changed.
