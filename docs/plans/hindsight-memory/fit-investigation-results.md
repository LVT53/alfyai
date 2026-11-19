# Hindsight full-replacement fit: tested options

2026-11-18. Evaluation only. **No revised contract, product code, deployment or migration.**

## Decision supported by this investigation

**Hindsight has useful native building blocks, but these tests do not establish a clean full replacement with our required correction/removal semantics.** A strong native correction rule worked across unrelated source edits and a genuine later life event. That is promising. It is not equivalent to durable, selectively scoped editing: another rule failed, deletion can be recovered from source text, and replay recreates deleted facts.

Do not approve an implementation on the premise that a thin adapter already solves this. Do not weaken the requirements to source-wide deletion or frozen chat sources. The next decision is whether Hindsight itself should own durable curation, or whether we are willing to own substantial semantic reconciliation. This report does not prescribe a new product contract.

## Scope and controls

- Pinned Hindsight `9fb28dbd724dc1ce4da7cb4c49008e601db76c5f`, evaluator 1.2.1; AlfyAI checkout `e60bb0c114c02a3063d5bf6972ddeb813cccbf6c`.
- Synthetic data only, isolated local PostgreSQL/API; local Flash Next through alias `qwen3-6-27b`. The proxy rejects other model names. No expensive external-model fallback.
- 26 lifecycle snapshots, 32 native Reflect answers (16 cases with original-text storage on/off), and eight custom source-transformation probes.
- Public native APIs, except selective hard deletion: a small throwaway HTTP extension exposes the existing engine `delete_memory_unit` method, with tenant context and bank lookup. It does not implement semantic matching or change upstream code. This is evaluation scaffolding, not production-reviewed integration.
- Frozen source-transformation cases/prompt and Reflect cases/directive saved before their respective runs. The six new attribution cases were held out from earlier prompt iterations. Ten were previously used. Later combined-rule probes are exploratory, not held out.
- Manual grading of complete answers and stored facts. These are small synthetic tests, not a production accuracy estimate or proof of future reliability. New extraction occurred in each Reflect arm: improvements versus earlier runs cannot be attributed solely to Reflect.

## Options actually exercised

| Option | Observed result | Fit consequence |
|---|---|---|
| Native per-fact hard deletion, original source stored | Coffee survived removal of the bicycle fact. Reflect immediately recovered **red** from the same original source; identical retry also answered red. Changed-source retain and explicit reprocess recreated the raw fact and observation. | Selective storage deletion exists; it does not by itself provide durable forgetting. |
| Same deletion, `store_document_text:false` before ingest | Coffee survived; colour stayed unknown after deletion and identical retry. Changed-source retain recreated red. | Closes the original-text answer path, not the replay problem. Native reprocess returned 404 without original text. Evidence/reprocessing would need app-owned original sources. |
| Native correction directive | Reflect answered **blue**, including after a source edit, but raw facts and observations still said **red**. | An answer instruction is not a store correction. The memory screen and other recall consumers could disagree with the answer. |
| Correction rule in retain and observation missions | With strong wording, reprocessing and unrelated edits produced blue, retained coffee, added pottery, and changed coffee to espresso correctly. | A promising native configuration path; still model-interpreted instructions, not durable mutations. |
| Strong correction rule, original-text storage off | Stored/answered blue, accepted espresso and pottery, then correctly answered **green** after an explicitly dated repaint from blue to green. | Native temporal handling can accept genuine new events without a blanket freeze. This positive sequence must not be omitted from the assessment. |
| Softer rule explicitly distinguishing old mistakes from later events, storage off | Initial source and two subsequent stages still stored/answered **red**. Later repaint was understood and stayed green after replay of an older edited source; old raw red remained. | Rule wording affected success. This is not a controlled wording-only comparison: setup differs from the first mission test. Strong-wording/no-text follow-up narrows the issue but does not establish causality or repeatability. |
| Forget-colour rule in retain/observation missions, source stored | No colour facts remained, but Reflect answered **red** from original text in all three stages. | Extraction filtering alone does not cover every retrieval path. |
| Same forget rule, source storage off | Colour remained unknown through unrelated edits and identical retry; coffee and pottery survived. **Bicycle ownership was also lost**, despite the rule asking to preserve it. | Better than deleting the whole message, but not fully selective within a compound claim. The rule also acts like a continuing topic prohibition; the owner has not agreed that Remove means never learn it again. |
| Custom semantic source rewrite with local Flash Next | Seven of eight transformations met the case expectations. Failed a directly conflicting source edit: silently chose blue over newly edited green instead of flagging uncertainty. | Can preserve details, including Hungarian/shared-subject and reformatted phone cases, but introduces a second semantic authority. These eight tests exercised the transformation only, not end-to-end Hindsight ingestion or concurrency. |

All source IDs and deletion targets were known in the fixtures. No test proves automatic discovery of every repeated/paraphrased copy across a user's history. Selective engine deletion removed an entire bicycle-colour fact; it did not split ownership from colour. The explicit forget-rule probe demonstrates that finer-grained loss matters.

## Attribution: native Reflect is not an acceptance pass

Both arms scored **14/16** on the predefined semantic expectations: **9/10 previously used cases + 5/6 fresh cases**. Across arms this is 28/32 outputs, not 32 independent situations.

Both failed the same two situations:

1. **Translation becomes biography.** “Translate: I have two children and work as a nurse” yielded user-child-count and profession facts. Without original text, Reflect asserted those facts. With original text, it recognized the translation caveat but still supplied two children/nurse as the best answer. The generic retain mission already said quotations were not assertions; the Reflect directive also prohibited this inference.
2. **Unknown becomes none.** A fresh cooker-shopping case said renovation had not started. Both arms answered **no cooker is installed**, rather than saying the installed cooker was unknown. Neither shopping nor an unstarted renovation establishes an empty kitchen.

Positive cases included user/client food-condition separation, sister allergy, colleague/neighbor ownership, an explicit negative in Hungarian, fictional dialogue, and genuine self-assertions. The former client-attribution failure did not recur here. No prompt was changed to rescue the two failures within this benchmark.

Additional quality issues: a few Hungarian outputs contained Chinese fragments, a raw fact from an English life-event source was written in Chinese, and answers were often much longer than requested. These did not change the narrow semantic scores. They still matter for a polished full replacement and were not graded as passing UI behavior.

Native Reflect latency on this tiny-bank run: median **5.44s**, range **2.84–8.88s**, excluding retention. Shared local inference and concurrent synthetic workflows make this unsuitable for a production capacity claim. Adding Reflect before every normal chat reply needs its own latency justification.

## Where integration becomes rebuilding

**Ordinary integration:** authenticated tenant/bank routing, privacy gates, source delivery/version IDs, operation status, UI adaptation, bounded context, and potentially exposing an existing engine operation. These are not another memory engine.

**Potentially modest, but not yet dependable:** generic retain/observation missions and Reflect directives. Strong correction wording showed useful results. Per-user correction/removal instructions would need scoping, lifecycle and growth management; a removed subject stored in policy also needs explicit privacy semantics. Passing a short example does not settle these concerns.

**Substantial custom memory ownership:** retaining an edit-intent ledger, finding all semantically related facts/sources, applying corrections to changed/paraphrased source versions, distinguishing a correction from a later genuine event, resolving conflicts without unnecessary questions, preserving unrelated subclaims, preventing old deliveries/races from resurrecting information, and keeping every recall/source-expansion path consistent. A source-rewrite layer doing this is much of the difficult part we wanted to stop maintaining. It would not recreate embeddings/search, but it would recreate curation and source reconciliation.

Native extension hooks do not make that logic disappear. In the inspected version, `MemoryReview` permits keep/drop and tag replacement; it does not rewrite a fact. Dropping every extracted fact can still store the source chunk. The hook is an insertion point for our policy, not a supplied persistent correction/removal policy. These hooks were code-reviewed, not tested as a complete custom plugin.

Likewise, splitting every source into atomic app-owned facts could improve deletion granularity, but then AlfyAI owns extraction, attribution, linkage and synchronization. This was not implemented or benchmarked; it must not be advertised as a tested easy solution.

## What is justified next

Keep Hindsight under consideration for extraction/retrieval/consolidation, but **do not start the full replacement assuming the curation gap is solved**. The narrow next investigation, if chosen, should be whether an upstream-owned durable correction/deletion mechanism can cover source replay and source expansion while preserving unrelated claims. Our existing failing fixtures are a concrete acceptance suite for that mechanism.

If the only available answer is a custom semantic ledger/rewrite system, present that maintenance cost as a substantive architecture choice. Do not hide it in an adapter or a newly weakened UI contract. No upstream issue/message was sent, no upstream feature commitment was verified, and no delivery estimate is asserted here.

The proposed UI simplifications remain approved. Dropping the portrait does not excuse incorrect attribution, resurrection after removal, or collateral data loss.

## Evidence and source references

Raw results and scripts: [fit-investigation/](fit-investigation/). Start with `native-options.jsonl`, `reflect-results.json`, `reflect-grading.json`, `merge-results.json`, and `merge-grading.json`. Compressed API/model traces retain the inputs, native tool calls and replies; SHA-256 manifest covers saved artifacts. Scripts are scratch runners, not application modules. `reflect-frozen.json` contains all 16 cases so the benchmark does not depend on recovering the older scratch input file.

Inspected native source at the pinned commit:

- [Engine deletion and reprocessing](https://github.com/vectorize-io/hindsight/blob/9fb28dbd724dc1ce4da7cb4c49008e601db76c5f/hindsight-api-slim/hindsight_api/engine/memory_engine.py): `delete_memory_unit` around line 12051; `reprocess_document` around 14502. Reprocess explicitly forces re-extraction; absent original text returns no document result.
- [Reflect agent](https://github.com/vectorize-io/hindsight/blob/9fb28dbd724dc1ce4da7cb4c49008e601db76c5f/hindsight-api-slim/hindsight_api/engine/reflect/agent.py): source expansion gated by `store_document_text`, around line 657.
- [Operation validator](https://github.com/vectorize-io/hindsight/blob/9fb28dbd724dc1ce4da7cb4c49008e601db76c5f/hindsight-api-slim/hindsight_api/extensions/operation_validator.py): `MemoryReview` around 391; retain/consolidation filters around 1177–1200.
- Official [memories API](https://hindsight.vectorize.io/developer/api/memories) and [extensions documentation](https://hindsight.vectorize.io/developer/extensions), read during investigation. Conclusions above are bounded to the tested commit, not a claim that every future/current upstream release behaves identically.

No product tests/gates were needed: only synthetic evaluation and documentation changed. No restart durability claim is added by this batch; earlier native-workflow restart results remain separate. Real UI behavior, migration, erase/export lifecycle and production-sized memory performance were not retested here.
