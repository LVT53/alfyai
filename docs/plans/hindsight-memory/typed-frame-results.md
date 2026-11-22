# Final claim-quality qualification

2026-11-18. **P1 did not pass.** Typed entities and independent scalar properties improve containment, but the tested local Flash Next pipeline still loses useful facts, misattributes ownership and mishandles new events. These are not just malformed JSON. No production representation is approved by this experiment.

## Experiment

The extractor sees source text and optional prior naming vocabulary, not correction intent. A separate selector chooses the targeted old property; deterministic code removes/replaces values and renders statements. Ownership is separate from colour/price so removing colour need not delete ownership. This isolates model extraction from sentence rewriting. The selector is a diagnostic convenience; a real UI should send stable item IDs directly.

All calls used the approved local endpoint under alias `qwen3-6-27b`; the alias is not evidence of weight count. No paid external-model comparison. Temperature 0; fast output budget 3,500; reasoning extraction 6,000. Reasoning comparison changes both thinking and output budget and repeats cases: it is not an independent held-out benchmark. Source extraction/projection tests do not establish persisted native recall or downstream answer quality.

| Run | Cases | Structural acceptance | Observed extraction median / maximum |
|---|---:|---:|---:|
| Revised fast | 20 | 20 | 1,562.5 / 3,042 ms |
| Fresh fast | 10 | 10 | 1,626 / 2,534 ms |
| Reasoning extraction | 14 repeated | 10 | 9,892 / 40,965 ms |
| Strict-schema fast | 4 repeated | 4 | 1,514.5 / 2,156 ms |

Times are single local evaluation observations, not an SLA. They exclude parts of a full ingestion/recall pipeline. **Structural acceptance is not quality accuracy**; no combined percentage is defensible. Initial pre-normalization results are also archived, not pooled. A known-role identity normalizer and limited quote guard were added before the revised fast run; neither is a complete semantic solution.

## Decisive outcomes

- Separate ownership survives bicycle-colour removal while espresso/pottery and unrelated price/use facts remain in several fixtures. Same-word facts belonging to other people/objects often survive. This is useful evidence for independent claim boundaries.
- Fast extraction omitted Beacon's mobile app and both people's rice preference. A clean Hungarian quotation fixture lost the separate request for brief answers. These facts are absent before filtering; renderer fixes cannot recover them.
- Fast extraction/projection dropped an explicitly new Prague residence and a reassigned personal phone number. Reasoning recovered Prague and both rice preferences, but still lost the new phone number and the Hungarian reply preference.
- Shopping text “I have not bought one” became a nonownership assertion; the renderer further invented past ownership by saying “no longer has.” Fixing the renderer to “does not have” would still leave the unsupported inference. Reasoning exhausted its output budget on the shopping case rather than establishing a correct replacement.
- Reasoning had four structural failures: missing entity status, two empty/incomplete frames at the 6,000-token ceiling, and an unknown holder reference. It is slower and not a demonstrated overall cure.
- A strict `json_schema` request succeeded, including an adversarial request asking for disallowed enum/type/extra-field output. Four actual strict-schema pipeline repeats were well-formed, yet still omitted the mobile app and brief-answer preference, lost the new phone number, and asserted unsupported dishwasher nonownership. **Schema enforcement solves shape, not meaning.**

See [raw evidence](final-feasibility/README.md) and [independent review](typed-frame-review.md). Do not treat the old 69/72 native benchmark as validation of this new extraction/chunks representation.

## What must change before this can qualify

The independent review found mechanical defects: ownership bypasses quote admission; evidence is located with ambiguous first-occurrence matching; edit matching ignores temporal lineage; any model-provided transition quote can exempt a value; renamed entities can bypass corrections. These must be corrected in a new candidate, but doing so does not resolve omissions or unsupported entailments. The experimental code is deliberately preserved with these defects visible rather than silently repaired and represented as tested.

A credible candidate needs provenance spans tied to immutable source revisions, stable claim/action identity, supported relation predicates (purchase is not ownership), event lineage, and admission of every assertion-bearing field. It must measure useful retention as well as wrong-memory suppression. Holding every difficult fact back would fail the automatic-memory promise. Asking users to routinely repair extraction would also fail the intended experience.

This is a material semantic intake/curation subsystem, not merely an API adapter. Native Hindsight does not supply the missing guarantee demonstrated here. A further prompt sweep or repeated fixture pass would not justify freezing it. A changed representation/model strategy must first explain how it addresses these failure classes, then be qualified on frozen adversarial and fresh EN/HU cases before the larger answer benchmark is worth rerunning.
