# Claim-level preservation: result and remaining acceptance work

2026-11-18. Authorized isolated prototype only. No product implementation, upstream work or migration.

## What this settled

**Storage can preserve unrelated facts when the input claims are genuinely separate. Automatic extraction is not yet reliably producing that input.** This is a more precise diagnosis than “Hindsight deletion is broken” or “we need another source-rewrite prompt.”

A hand-authored diagnostic control stored ownership, colour, price and frequency as four separate claim documents in native `chunks` mode. Deleting only the colour document and reprocessing ownership left colour unknown while ownership, €250 price and daily use survived. This is a positive native storage/lifecycle result, **not an extraction-quality pass**.

With actual local-model extraction, colour remained embedded in other claims: “The user's red bicycle cost 250 euros” and “The user owns a red bicycle.” Removing the colour claim did not remove those other occurrences. Native Hindsight answered red. The model also omitted ownership entirely in several simple examples, so claim deletion could not preserve it.

The next work is bounded by the [replacement readiness checklist](replacement-readiness.md). Feature parity is not solved by this experiment.

## Experiment

AlfyAI checkout remains `e60bb0c114c02a3063d5bf6972ddeb813cccbf6c`; Hindsight evaluator 1.2.1 at `9fb28dbd724dc1ce4da7cb4c49008e601db76c5f`. Synthetic sources and local Flash Next alias `qwen3-6-27b` only.

Three calls per case:

1. Extract evidence-linked atomic claims from the original source. Every claim has subject, attribute, value, a declarative sentence, source quote, assertion kind and event evidence. Shared-person facts should split; ownership should be distinct from colour.
2. Select the original claim IDs targeted by the explicit correction/removal. The selector cannot choose claims from the future source version.
3. Extract the latest source independently of edit intent, with the earlier subject/attribute vocabulary. Deterministic code preserves unrelated claims, deletes/corrects matching old values, accepts explicit events, and withholds unexplained conflicting values.

Quoted/question/hypothetical claims are excluded from asserted memory; plans can be retained as plans. This is a small experimental admission rule, not a verified comprehensive policy. Source quotes are mechanically checked, but a real quote does not prove its asserted interpretation is correct.

20 initial cases: 12 previously used and eight fresh frozen cases. One was initially blocked by an unnecessarily strict scratch validator requiring every claim template to have a value slot. A read-only ownership claim did not need such a slot to survive a colour removal. The validator was corrected to require a slot only when a correction actually uses it; that case was rerun and preserved ownership/shed/jazz/piano. Original and follow-up runs are saved separately; do not merge them into a perfect first-pass score.

One fresh translation case was ambiguous: `Translate: ... I prefer brief answers` did not clearly delimit where the translation ended. The extractor treated the whole source as quoted, preventing false biography but also excluding the preference. Rather than declaring that definitively wrong, an additional case explicitly separated the quotation and user preference. It retained brief answers without inventing children or a nursing profession. The original ambiguous fixture remains in the evidence and is not used as a clean accuracy claim.

No aggregate production accuracy is asserted. Structural admission (`accepted:true`) is not semantic correctness.

## Important observed outcomes

| Requirement | Outcome |
|---|---|
| Shared Hungarian location | User location removed; sibling location/running and user swimming retained. Native storage/answer confirmed this. |
| Shared Hungarian health | Partner condition, both locations and user hobby survived removal of the user condition in the projection. |
| Explicit negative | User's negative lactose-sensitivity statement and both rice preferences survived removal of partner condition. |
| Project separation | Atlas changed to TypeScript; Beacon's Rust/mobile information remained. |
| Shopping versus ownership | Comparison and unstarted renovation retained; no installed-cooker ownership or “no cooker” assertion created by this projector. |
| Conflicting colour edit | English/Hungarian conflicting colour claims were withheld rather than silently changed back; ownership was absent from extraction, so full preservation still failed. |
| Ownership independence | Frequently missing for “my bicycle,” even though explicitly requested in the extractor instructions. |
| Attribute independence | Colour leaked inside price/ownership claims. “One attribute” JSON labels did not make those claims atomic. Native recall exposed the leak. |
| Stable identity over time | `personal phone number` became `old personal phone number`; exact-key matching missed the old personal attribution, and extraction omitted the company's new reception-number claim. |
| New event history | Current green survived a repaint, but the separate historical blue/repaint detail was not fully retained as an eligible sentence. Event metadata alone is not a complete memory representation. |

## Native storage mode and new responsibilities

The tested native [`chunks` extraction mode](https://github.com/vectorize-io/hindsight/blob/9fb28dbd724dc1ce4da7cb4c49008e601db76c5f/hindsight-api-slim/hindsight_api/engine/retain/fact_extraction.py) copies each chunk to one fact without another extraction LLM call. The test uses short single-claim documents, so each is one chunk. Consolidation and retrieval remain native.

**This mode does not automatically extract entities.** Supplied entities can be used downstream, but this prototype did not provide them. We cannot carry over the earlier full-native benchmark scores or assume equivalent graph recall. A candidate using this mode must qualify entity linkage, coverage, source evidence, dates and recall under this actual representation.

This option moves initial extraction and attribution into AlfyAI, in addition to curation. It is more invasive than merely owning user edit intent. It does not recreate Hindsight's embeddings/search/consolidation, but it creates a substantial app-owned semantic layer. The owner permitted investigating our own component; this experiment does not silently approve that expanded production architecture.

The practical representation should make ownership, identity and mutable attributes separate and enforceable—not merely ask an LLM to call a compound sentence “atomic.” It also needs durable entity/attribute IDs rather than comparing free-form labels. These are requirements exposed by the test, not already-proven fixes. Correct completeness/attribution remains a model-quality problem even with a schema.

## Evidence and limits

[Artifacts](claim-level-prototype/) contain initial/follow-up source, frozen prompts/cases, all model output, compressed API traces, and three native roundtrips. `roundtrip-results.json` distinguishes actual-model projections from the hand-authored diagnostic control. The latter must never count as an automatic end-to-end pass. The source doc/claim IDs are synthetic and known. Large-bank discovery, multiple simultaneous edits, full privacy lifecycle and production concurrency were not tested here.

[Interactive claim walkthrough](claim-level-prototype/walkthrough.html) uses recorded claims and the actual deterministic curator. Select targets and inspect retained claims, including the “red bicycle” leakage inside supposedly unrelated claims. It makes no live calls. JavaScript syntax was checked; no browser/a11y acceptance is claimed.

Only docs and throwaway evaluator files changed. App gates were not needed. Scratch services are stopped after completion; artifacts and handoff remain available.
