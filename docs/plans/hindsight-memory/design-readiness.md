# Hindsight replacement: earlier feasibility decision

**Newer resolution:** [Native precedence and verified publication](correction-recovery-results.md) closes the two focused blockers at prototype level after the owner clarified latest-explicit-change precedence. The negative qualification below is historical; do not use the abandoned unresolved-value assumption to block design. Production acceptance is still separate.

**Latest evidence:** [Actual AlfyAI baseline](alfyai-baseline-results.md) is now measured (37/72 tool-assisted, 32/72 passive, versus earlier Hindsight 69/72). [Narrow replay results](replay-ledger-results.md) isolate remaining failures to custom reconciliation; do not read the historical qualification below as a reason to reject native Hindsight.

**Follow-up supersedes the broad adoption implication:** [native-versus-custom investigation](native-quality-followup.md) shows native extraction with retain reasoning is substantially more promising than the custom typed extractor. Hindsight remains a candidate; selective correction reconciliation still blocks full parity. The storage/privacy boundary findings below remain applicable.

2026-11-18. **The storage, update and app boundaries are clear. Full replacement parity is not established: automatic claim quality and durable semantic curation remain a blocker.** Do not scrap the current engine or present a final Hindsight-specific UI contract as proven. This is a completed investigation with a negative qualification result, not a product implementation or a claim that every requested outcome now works.

## What we can design around

| Responsibility | Evidence-backed design boundary | Status |
|---|---|---|
| Search, browse, detail and evidence | Native storage/retrieval behind authenticated AlfyAI routes; show verified raw claims as the authoritative items | Native primitives tested; actual UI unbuilt |
| Bounded edits and deletion | Separate claim documents; immutable revision IDs; revoke only affected publication; preserve unrelated acknowledged claims | Mechanism demonstrated on 10/100/300-claim banks and a five-claim overlapping-source consolidation fixture |
| Publication and retries | Durable desired revision/reset epoch, serialized delivery, read-back payload acknowledgement; IDs plus semantic/scope hashes | 12 offline checks against real native Recall payloads passed; distributed app recovery unbuilt |
| Derived memories | Use observations as retrieval aids only when complete current support is verified; never equate fresh provenance with semantic truth | Native dependency rebuilding exercised; no truth guarantee |
| Chat use | Filter native Recall before the existing chat answer path; apply identical admission to baseline/tool/UI/source reads | Integration seams audited; unrestricted native Reflect would bypass this boundary |
| Privacy and lifecycle | Server-owned user mapping, fail-closed admission, off/incognito gates, reset epoch, durable external erase/export workflow | Native isolation primitives plus app source audit; integrated race/security tests remain |
| UI operations | Searchable items, source evidence, targeted controls, pending/failed/retry/conflict states; no portrait | Designable structure, conditional correction semantics |
| Automatic understanding | Explicit claims, correct subject/uncertainty, useful detail retention, later events distinguished from source rewrites | **Failed qualification with local Flash Next, including reasoning and strict schema alternatives** |

Sources: [claim-quality results](typed-frame-results.md), [bounded updates](bounded-update-results.md), [app boundaries](design-readiness-boundaries.md), [37-feature mapping](replacement-readiness.md#coverage-of-the-existing-37-feature-inventory).

## The boundary is larger than a thin adapter

Hindsight can own storage, indexes, retrieval, consolidation and native dependency invalidation. AlfyAI necessarily owns authentication/privacy, delivery, source revisions, user action intent, publication consistency and lifecycle orchestration. Those are bounded integration responsibilities.

The tested full-parity approach additionally requires AlfyAI to own reliable multilingual claim extraction, entity/property identity, event interpretation, evidence admission and cross-source correction matching. **That is a significant part of a memory system.** The native engine remains useful, but its future improvements do not automatically fix our custom extractor or correction semantics. Chunks mode deliberately bypasses native extraction; supplying clean entities/claims becomes our responsibility.

Native fact edits alone are insufficient: changed-source replay can recreate the old claim. Deleting an entire source and freezing it would avoid some problems but violate the owner's preserved-fact/source-sync requirements. Those compromises remain rejected. No unsupported claim of permanent semantic forgetting is introduced.

## Full feature accounting

Every one of the 37 inventoried controls/behaviors has a disposition in the readiness matrix. Retain browse/search/details/evidence, targeted correction/removal, explicit remember, automatic learning, meaningful scope, status, memory off/incognito, user isolation, reset/erase/export, EN/HU, accessibility/mobile and guide integration. Preserve project/history/attachments/task continuity separately.

Approved omissions remain portrait/summary editing, inferred expiry/renewal, routine review inbox and notices, permanent endorsement machinery and general nightly undo. Optional simple activity is not a prerequisite. These omissions do not waive reliable user corrections or assumption handling.

**Do not promise yet:** automatic attribution quality; correction/removal surviving arbitrary paraphrase/source changes without collateral loss; final semantic grouping/counts; guaranteed observation truth; production latency/cost; immediate complete physical erasure. Acknowledge publication versus cleanup separately. No hidden acceptance of a reduced V1.

## Finite remaining work

1. **Qualification blocker:** choose and prove a materially different semantic intake/curation strategy before adopting the replacement. Existing fast/reasoning/strict-schema variants are insufficient. The precise failures and required invariants are documented; another generic prompt sweep is not a justified next step. If no candidate satisfies them at acceptable local-model cost, decline Hindsight as the full replacement under the current requirements. This does not mean the engine is generally unsuitable.
2. **Once qualified:** finalize the full UI and API around the stable boundaries above. No further exploratory prototype is identified for ordinary app wiring. Recheck P2 if the final representation changes its assumptions. Representative capacity, storage/trace growth and latency/cost targets remain acceptance work; the small ladder is not production sizing.
3. **After implementation is authorized and built:** execute the five acceptance groups in [readiness](replacement-readiness.md): privacy/isolation/lifecycle; chat/scope; complete UI; operations/recovery; migration/cutover. Fault-inject between durable boundaries, exercise real workers, and run a full bilingual/mobile UI walk. Those tests cannot honestly pass before the replacement exists.

Migration recommendation: preserve current-generation deliberate notes/edits with provenance; do not blindly bless old automatic guesses. Honor reset/off/incognito intervals. Switch one memory authority at a time. Rollback to an untouched old snapshot can resurrect removed facts; safe fallback is chat without profile memory unless reverse reconciliation is tested. Final migration policy and operational targets are decisions for implementation, not secretly assumed here.

## Stop condition and evidence

Stop open-ended feature discovery: the inventory and integration boundaries are complete enough to design the shared UI structure. **Do not mark semantic parity solved or commit to Hindsight as the complete replacement from these results.** The remaining uncertainty is concentrated in the product's central automatic-understanding promise, not another missing button or native endpoint.

Pinned AlfyAI checkout `e60bb0c114c02a3063d5bf6972ddeb813cccbf6c`; Hindsight `9fb28dbd724dc1ce4da7cb4c49008e601db76c5f` / evaluator 1.2.1. Synthetic data only. Product code unchanged; no deployment, migration or upstream work. Reproduction artifacts and hashes: [final feasibility](final-feasibility/README.md), [bounded updates](bounded-update-prototype/README.md). Independent review: [typed frames](typed-frame-review.md). Earlier positive native benchmark results are retained with limitations, not transferred to the new pipeline.
