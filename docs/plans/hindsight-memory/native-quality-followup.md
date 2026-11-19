# Native extraction versus custom curation — follow-up

2026-11-18. Follow-up requested by the owner after the prior feasibility report. **The previous conclusion bundled different failure layers too broadly. The typed-frame failures do not disqualify native Hindsight extraction.** Hindsight remains a candidate; the custom all-memory extractor is not the preferred direction.

## What belongs to which layer

| Failure | Owning layer / evidence |
|---|---|
| Missing mobile app, rice preferences, brief-answer preference; invented nonownership from shopping | These particular results came from the AlfyAI throwaway typed-frame extractor and its renderer. They were not native Hindsight extraction results. |
| New Prague residence and new personal phone number withheld | The custom matcher treated an old correction as applying to later entity/property values, relying on a model-written transition flag. Native extraction preserved these new events in the direct comparison. |
| “No longer has” from `not_has` | Deterministic prototype rendering bug that invented historical ownership. Not Hindsight. |
| Translation text becomes user biography | Reproduced in native Hindsight with local Flash Next retain reasoning disabled, despite the mission. Also occurred in our prototype. Native reasoning configuration improved this in the new probes. |
| Curated fact reset by changed source/reprocess | Native lifecycle limitation previously reproduced. Native PATCH changes extracted records, not a durable application intent over future source versions. |
| Native source text bypasses removed facts | Native source expansion plus integration choice; requires guarded retrieval and careful source handling. |
| Conflicting source change silently overrides correction, or forgetting colour loses ownership | Reproduced with native prompt-based curation instructions in this follow-up. Configuration is not a reliable correction policy. |

The earlier native benchmark remains positive evidence for the configuration it tested. It neither validates our typed-frame replacement nor establishes durable correction/replay semantics. Conversely, our failed replacement extractor is not evidence that the earlier native benchmark was worthless.

## Controlled native extraction comparison

Same pinned Hindsight evaluator 1.2.1 / source `9fb28dbd724dc1ce4da7cb4c49008e601db76c5f`, same approved local Flash Next alias, synthetic English/Hungarian inputs. No custom claim schema, property ontology, renderer, selector or correction filter in the native extraction arms. Each bank received a single source; raw facts and native observations were inspected separately.

- **Native concise, thinking off:** ten cases, including the earlier failure sources and two fresh cases. Retained the mobile app, both rice preferences, separate brief preference, new personal/company numbers, current Prague/past Berlin and shopping/not-purchased distinction. Two translation cases also acquired false user biography.
- **Native custom instructions, thinking off:** fourteen cases, adding four frozen fresh cases. Uses the supported `retain_extraction_mode=custom` and `retain_custom_instructions`; still Hindsight's own extractor/schema/entities/consolidation. Stronger instructions alone did not eliminate the two quotation failures. Fresh client-email, Hungarian quotation and daughter-phone cases behaved better.
- **Exact native prompt replay, thinking on:** five captured native extraction requests, changed only thinking and output ceiling. Both quotation failures were corrected with the default and custom prompts; useful personal preferences survived. The curation/ownership failure did not improve. These are direct prompt replays, not persisted pipeline tests.
- **Integrated native concise, retain thinking on:** fourteen frozen cases through real retain and consolidation. The two quoted-biography failures did not recur. Native raw facts retained the important details our custom extractor lost. Consolidation remained thinking-off. No inference of user ownership/nonownership from the shopping cases was observed.

The supported settings used for the integrated run were `HINDSIGHT_API_RETAIN_LLM_EXTRA_BODY={"chat_template_kwargs":{"enable_thinking":true}}` and `HINDSIGHT_API_RETAIN_MAX_COMPLETION_TOKENS=8192`. They were checked against the pinned owning configuration/source and verified in actual proxy requests. The earlier bridge defaulted thinking off when not requested. Thus this is a genuine execution-setting difference, not a claim that the same native setup suddenly became infallible.

**Limits:** small synthetic, largely repeated cases, no production accuracy percentage, no broad benchmark rerun and no full app answer/UI acceptance. Native reasoning uses more time/tokens. A client-email source remained explicitly quoted in a raw fact, but consolidation turned it into direct statements about the client. It did not attribute those statements to the user, yet it demonstrates why derived observations are not an authority for certainty. Native fact dates also need their own broader temporal qualification. Do not describe this as all memory-quality problems solved.

## Correction work

A native-only curation arm applied scoped original evidence and explicit edit instructions through Hindsight's custom extraction configuration, with source text storage disabled. Seven scenarios each ran curated original, changed source and identical retry (21 states). Results are mixed: Atlas correction preserved Beacon's new mobile app; compound bicycle price/use survived colour removal; shared-person facts could be retained. But simple colour removal dropped bicycle ownership, a conflicting green source silently displaced a blue correction, and former personal-phone attribution survived the removal request. Thinking on the captured ownership prompt still lost ownership. **Native instruction configuration alone is insufficient.**

The follow-up therefore tests a smaller custom component over native-extracted facts: exact text patches for the requested edit, without taking over extraction. It defaults unrelated facts to unchanged, verifies target IDs and unique exact substrings, and represents conflicts explicitly. The first schema redundantly allowed both a delete action and replacement patches; the model produced contradictory combinations. Those outputs were rejected, not silently treated as successful. A second schema expresses only patches plus conflict/unresolved state. Its results and native roundtrips are recorded below.

This is still semantic curation and needs qualification. Exact substring validation proves where an edit applies, not that its meaning is correct. It must be applied before publication, with the earlier revision/epoch/payload acknowledgement boundary; direct raw source expansion or unguarded native Reflect would bypass it. It does not solve discovery of every paraphrase across an unlimited history merely by existing.

## Narrow-curator results

Nine scenarios used fresh native facts from the changed source, original source text and one authorized action. All native extraction used reasoning. The curator itself was compared with and without reasoning, using identical version-2 prompt/schema. No extra all-memory extraction layer, taxonomy or entity-key normalization was introduced.

| Scenario | V2 reasoning | V2 fast |
|---|---|---|
| Forget bicycle colour; keep ownership/espresso/pottery | Preserved intended remainder | Preserved intended remainder |
| Forget user's health condition; preserve partner/city/pottery | Preserved intended remainder | Text preserved remainder; old shared `Involving` metadata remained |
| Historical correction plus real move to Prague | Output budget exhausted, no usable result | Kept past Berlin, current Prague, office |
| Manual blue versus edited source green | Flagged conflict, but left a noun fragment instead of a proper ownership fact | Flagged conflict, but removed ownership, leaving metadata-only residue |
| Remove colour from compound price/daily-use fact | Kept ownership, price and daily use | Kept ownership, price and daily use |
| Correct Atlas; preserve Beacon Rust/mobile | Correct | Correct |
| Correct only road bicycle; preserve mountain bicycle/Sundays | Correct | Correct |
| Forget user's city; preserve sister's city/running and user tennis | Preserved intended remainder | Lost sister's city too |
| Forget old personal-phone attribution; preserve company/new personal number | Preserved intended remainder | Preserved intended remainder |

Median curator-call time was 22.558 seconds reasoning versus 0.786 seconds fast in this run. These are isolated synthetic observations, not a production SLA; reasoning is not uniformly better. The initial redundant-action schema had additional rejected delete-plus-patch outputs and incorrect conflict handling, retained in the artifacts rather than hidden.

**Two successful edits were actually persisted through native PATCH, native consolidation and Recall:** bicycle colour removal preserved ownership/espresso/pottery, and removal of the user's health condition preserved partner sensitivity, shared city and pottery. This is stronger than inspecting projected strings, but it is not a full changed-source publication/recovery test. Native uncurated source text remains unsuitable for unrestricted expansion.

The patch boundary needs to cover all assertion-bearing metadata and verify a meaningful remaining statement; substring correctness alone is insufficient. Native facts can bundle multiple people/properties, and a model still sometimes drops a valid remainder. The result supports narrowing the component, **not declaring it reliable enough for release**. A parser error must reject the entire candidate transaction; the scratch arrays accumulated before an error are diagnostic only.

## Revised decision and next boundary

1. **Keep Hindsight under active consideration and prefer native extraction.** The typed-frame extractor introduced avoidable problems. Do not make AlfyAI own all extraction/entity typing because that prototype failed.
2. **Retain reasoning is a tested candidate setting for local Flash Next.** It corrected the observed quotation failures in the integrated run while preserving useful facts. Qualify on a larger fresh native benchmark, temporal cases and realistic throughput before making an accuracy/cost promise. Do not automatically enable reasoning for every other stage.
3. **Own correction intent and publication, not ordinary extraction.** A narrow reconciliation component can operate only when a source has an explicit user edit/removal, on native candidate facts before acknowledgement. Uncurated sources stay on the native path. Existing per-user/privacy/scope/revision fencing remains necessary. This is materially smaller than an all-memory ontology/projector, although cross-source affected-set discovery and semantic correctness remain genuine work.
4. **The remaining specific blocker is safe selective reconciliation of compound facts and conflicting source edits.** Native instructions alone failed; narrow patches improved several failures but still have collateral-loss/fragment/budget cases. A robust next candidate must preserve the independent remainder, distinguish an actual conflict from replay, and reject semantically invalid output before publication. Do not hide this by freezing entire sources, silently dropping unrelated facts, treating all model-valid JSON as correct, or requiring ordinary users to review all intake.

No conclusion here gives up on Hindsight or authorizes product implementation. The earlier blanket-sounding recommendation is superseded by this more precise split: native understanding is promising with the tested configuration; custom correction reconciliation still needs qualification. There is no basis for scrapping Hindsight because our custom extractor failed, and no basis yet for claiming full feature parity.

Evidence: [artifacts and reproduction notes](native-quality-followup/README.md). All checks used synthetic data and the local model; no product code, production data, upstream submissions, deployment or migration. Model settings were checked against pinned official owning source, not guessed from memory. No app gates are claimed for this documentation/evaluation-only work.
