# Throwaway native correction lifecycle experiment

Restore the historical source at its original paths before following the replay commands or source references below. [Archive and restoration instructions](../research-source/README.md)

2026-11-18. No product/UI implementation. Only synthetic scratch banks `cl1-*` in the pre-existing isolated pg0 evaluator. Native source pin remains `9fb28dbd724dc1ce4da7cb4c49008e601db76c5f`.

Hypothesis: free-form full-fact rewriting caused avoidable collateral loss. Exact substring edits can preserve untouched bytes mechanically while keeping native extraction and storage. Every current raw fact is considered; there is no separate keep/merge classifier that can skip a required correction. The model still chooses edit spans, so semantic correctness is not mechanically guaranteed.

Six fresh EN/HU cases were written before their native extraction. Gold expectations are in cases.json but are NOT sent to either extractor or editor. All native extraction uses the existing retain mission, concise native mode, reasoning enabled and 8192 maximum output tokens. The correction prompt/schema were frozen before calls. Original `run.cjs` is retained unchanged as evidence.

First sequence per case: native retain → model span proposals → deterministic validation/application → native PATCH or invalidation → native consolidation → full raw Recall capture → only acknowledged raw ID/text admitted to answer → edited-source retain/reconcile → identical retry. Model answers receive only admitted text, never raw chunks, graphs or derived observations. This measures that restricted path, not unrestricted native Reflect or a production AlfyAI UI.

The initial city attempt proposed a nonunique substring. Validation rejected the whole proposed batch before writes. `lib.cjs` adds exactly one retry describing the mechanical error. Its retry can still be semantically wrong; indeed a first valid city edit left the old inline Where annotation. Original response and run log are preserved. The initial runner stopped after five completed scenarios, then `resume.cjs` completed the sixth with this bounded retry.

Two additional native compound-conflict cases are explicit tests of the candidate policy: a third source value with no life event should be withheld rather than silently selected. That policy is an evaluation choice, not a newly approved final product contract. Conflicts reuse two scenario domains and are not independent new domains.

`reasoning.cjs` is a paired comparison on captured native inputs: identical correction prompt/schema, same model, reasoning enabled and output ceiling 8192. No prompt tuning to expected answers. Reasoning-based results are not fresh held-out evidence after the first evaluation, and must not be combined with earlier variants into an invented perfect score.

`extend.cjs`, `repeats.cjs`, and `stale.cjs` are follow-up probes; file presence does not imply they ran. Execution results and the final report distinguish completed from planned checks. These scripts require the task's scratch service/proxy, not ordinary app startup. The scratch proxy reads only provider/configuration records read-only and sends synthetic inference. No real-user conversations or memories are read.

Official retain/recall documentation was checked (https://hindsight.vectorize.io/developer/api/retain and https://hindsight.vectorize.io/developer/api/recall), together with the pinned local source for PATCH, document reprocess and native annotation assembly. Pinned runtime behavior is the authority where current web documentation differs.
