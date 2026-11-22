# Native extraction with a narrow correction/replay ledger

2026-11-18. **Native extraction remains the preferred path. A smaller correction component is plausible, but this prototype does not yet satisfy full correction/replay parity.** Its remaining failures are in our custom reconciliation, not evidence that native extraction failed these inputs. The [actual AlfyAI baseline](alfyai-baseline-results.md) independently establishes a substantial retrieval/retention advantage for the earlier Hindsight configuration.

## What changed and what ran

Earlier prototypes asked one model step to interpret an edit, preserve the remainder and reconcile changing sources. This experiment separates an already accepted edit from subsequent replay. It uses recorded native facts; it does not replace Hindsight extraction with an AlfyAI ontology.

The synthetic ledger contains the original targeted statement, an explicitly approved replacement and a neutral remainder. These texts are supplied as trusted inputs: **automatic first-edit generation is not tested or proven here.** On changed-source facts a local-model classifier chooses keep, replay, conflict or local merge. Exact replay substitutes the approved text verbatim. A conflicting value without a new life event is withheld; genuinely new events and unrelated facts should survive. Only mixed facts require local rewriting. No whole-history rewrite or general custom extractor is involved.

The model is the configured local Flash Next alias `qwen3-6-27b`, temperature zero, thinking off, structured output. Eleven cases reuse actual native outputs from the earlier retained-source experiments. Three additional counterexamples are constructed compound facts, not fresh native extractions. Model requests, raw replies, frozen inputs, scripts and projected outputs are in [replay-ledger-prototype](replay-ledger-prototype/). These are exploratory development cases, not an independent accuracy benchmark.

| Variant | Observed text outcome |
|---|---|
| Initial ledger | 11/11 original cases passed with the trusted ledger |
| Initial ledger on three added compound conflicts | 0/3: silently selected the approved colour, or lost new activity/another bicycle |
| Added conflict-plus-new-detail branch | 12/14: two disputed values remained in active text |
| Separate relationship-removal prompt for that branch | 12/14: fixed those two examples, but lost road-bicycle ownership/Tuesday riding and restored a forgotten former personal-number association |

The final run independently reviewed all 14 outcomes. The phone regression happened in classification (`keep`), so the localized editor was never invoked. The road-bicycle failure happened in the localized deletion step: it preserved the mountain bicycle but dropped the whole road-bicycle clause. See [independent review](replay-ledger-review.md). Do not cherry-pick the successful output of different variants into a fictitious passing pipeline.

## What this establishes

The accepted-edit ledger reduces the custom component's responsibilities. Unchanged source chunks can retain native identities; replay of a known accepted edit can be mechanical. Earlier bounded native updates and publication guards still apply. Useful independent details, separate people/projects, explicit new life events and many selective removals survived the narrower approach.

However, identifying the targeted relationship across a changed compound fact is still semantic model work. A strict JSON schema and exact ID coverage validate the shape, not whether all unrelated meaning survived or forgotten attribution returned. Repeated prompt changes moved the failures instead of establishing a stable guarantee. This round stops here rather than presenting another prompt variant as a solved contract.

The next justified experiment would isolate semantic preservation/target attribution on changed facts, with fresh held-out cases and repeats, before any wider UI/API replacement. A runtime checker could itself make semantic mistakes; it is not an established solution. Do not quietly adopt source freezing, collateral deletion, a general extractor or compulsory routine user review to make this result appear to pass.

## Remaining integration limits

- First-edit acceptance/remainder creation is assumed here, not automatically solved.
- These projected text outcomes were not written back through native PATCH and Recall in this round. Earlier two PATCH/Recall roundtrips do not certify this new pipeline.
- Native entity/context/date/causal-edge metadata and source expansion can still expose information absent from corrected text. All answer, browse, evidence and tool paths need the same verified publication boundary; unrestricted source/graph/Reflect expansion is unsafe to assume.
- Arbitrary cross-source paraphrase discovery, fresh distributed races/restarts, many-edit composition and long-run conflict rates are not established.
- The evaluation ledger retains original/previous/latest text for debugging. Logical removal is not physical erasure; production retention, reset and erase rules would have to cover the ledger too.

**Decision:** keep Hindsight as the leading candidate and keep extraction native. A small AlfyAI-owned correction component remains worth investigating, but no tested variant here supports a full feature-parity claim. No product code, deployment or upstream changes were made.
