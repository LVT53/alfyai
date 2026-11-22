# Memory replacement readiness — finite gates

## Latest qualification (2026-11-18)

**Planning update:** the owner has agreed the [migration policy](chat-backfill-migration.md#accepted-migration-policy--owner-approved-2026-11-18). The [final full replacement implementation plan](../../superpowers/plans/2026-11-18-hindsight-memory-replacement.md) maps all remaining A1–A5 work to implementation tasks and tests. Policy selection is complete; real source mapping/consent collection, implementation and integrated acceptance are not. No implementation authorization yet. Historical P1/P2 discussion below is evidence history, not an instruction to resume rejected architectures.

Read [current-list follow-up](current-list-followup-results.md), [Edit/Remove follow-up](edit-remove-followup-results.md), [capacity/backfill results](capacity-backfill-results.md) and [completed overnight concurrency tests](capacity-concurrency-results.md) before the historical P1/P2 discussion below. The qualified native-backed path is an implementation target; no further open-ended engine redesign or generic benchmark is recommended. Full product parity remains an integration claim that cannot be made before implementation. A1–A5 below still apply. Historical eligibility/exclusion mapping now has an agreed policy; local-model capacity is practical, with a rough 2–4-hour overnight allowance at six concurrent model requests.

Updated 2026-11-18 after [native precedence/publication qualification](correction-recovery-results.md); earlier findings remain below for traceability. **Feature parity and release readiness are not solved.** The target is the owner's approved full replacement, not a literal copy of every old control. Dropped features are deliberate scope changes, not hidden unfinished work.

Source inventory: [37 current UI/behavior features](prior-findings/ui-inventory.md), reviewed at AlfyAI `e60bb0c114c02a3063d5bf6972ddeb813cccbf6c`; this is still the current checkout. Native primitives were tested separately from app integration. There is no implemented replacement UI/API to certify.

## Latest measured comparison

[Actual baseline](alfyai-baseline-results.md): earlier Hindsight 69/72 versus actual AlfyAI 37/72 tool-assisted and 32/72 passive (lenient 40/72 and 35/72). This is meaningful evidence for adoption, separate from correction guarantees. [Narrow replay ledger](replay-ledger-results.md): final variant 12/14 exploratory cases with trusted accepted edits; attribution and collateral loss persist in our custom layer. No complete parity claim.

## Fresh lifecycle follow-up

[Exact-span correction tests](correction-lifecycle-results.md) improve ordinary first edits and replay while retaining native extraction. Conflicting source edits still fail preservation/neutralization. One forced reprocess and seven-bank restart verification succeeded before/after a model-service failure, but in-place replacement temporarily withheld the interrupted source's useful facts. Immutable revision publication still needs integration with the editor. P1/P2 are not converted to full passes by these results.

## Latest resolution of the two focused blockers

[Native precedence and verified publication](correction-recovery-results.md) closes the specific disputed-value/reprocessing-availability blockers at prototype level. The owner explicitly chose latest explicit changes over older conflicting claims across chats; the former unresolved-value policy was not a requirement. Native edit extraction, stable assertion dates and per-event publication passed the composed restart/replay/reset test. Design can proceed on these semantics; product integration, physical-erasure boundaries and release acceptance are not certified by a scratch prototype.

## Qualification status

### P1. Claim quality and curation — focused blockers closed; integrated acceptance remains

A candidate must use local Flash Next and preserve each independent claim, correct attribution and uncertainty. Targeted removal/correction must survive paraphrases, repeated sources, source edits and replay without collateral loss or silent conflicting choices. It must distinguish new events from rewritten history, keep proper dates/negatives, and avoid translated/quoted biography or ownership inferred from shopping.

The [native-versus-custom follow-up](native-quality-followup.md) corrects the earlier overgeneralization: custom typed-frame failures do not disqualify Hindsight. Fourteen integrated native cases with retain reasoning preserved important details and avoided the two reproduced quotation errors. Prefer native extraction; do not assume the custom all-memory ontology is required. A narrow curator over native facts improved ownership/shared-person/phone corrections, including two native PATCH/consolidation/Recall checks, but compound-fact conflict handling, collateral loss and output-budget failures remain. P1 is specifically selective correction/source reconciliation plus broader native quality qualification, not evidence that native extraction generally failed.

**Exit evidence:** freeze the actual proposed representation and pipeline, then run the existing adversarial cases plus fresh multi-session EN/HU cases and the broader recall benchmark. Grade storage, sources, derived facts and answers separately. Known privacy/collateral-loss/conflict regressions must be fixed, not hidden by average scores; compare useful recall as well as false-memory reduction. Measure how often ambiguity withholds memory or needs a clarification. A small perfect fixture run is not a universal guarantee.

Do not launch another generic source-rewrite/model-review prompt sweep. Work should test enforceable claim boundaries and stable identity, with completeness/attribution evaluated explicitly. If it cannot pass, choose a materially different representation/model strategy or decline adoption; do not silently weaken the full-replacement requirement.

### P2. Practical updates — mechanism demonstrated; production acceptance remains

[Bounded native update experiments](bounded-update-results.md) tested 10/100/300-claim banks, overlapping-source consolidation, stale replay, retries and 12 offline read-admission checks on actual Recall payloads. Unrelated claims survived bounded edits. No whole-history rebuild is necessary. Native writes are not revision-conditional, so immutable revision documents, an app intent/acknowledgement ledger, payload hashes and reset epochs are required. All reads must be admitted; unrestricted Reflect cannot bypass this boundary.

The mechanism is conditional on the final P1 representation. It does not certify representative capacity, disk/trace growth, production latency/cost or live distributed worker interruption/recovery. Those remain finite qualification/implementation tests, not a reason for another broad architecture search. Use verified raw claims as authoritative; current observation provenance does not prove derived text true.

**Stop open-ended feature discovery.** P1 is the remaining architectural qualification blocker. Once a materially changed strategy passes P1, recheck representation-sensitive P2 assumptions, finalize the full design, then implement only on authorization. Ordinary app boundaries need implementation acceptance, not more speculative prototypes.

## Integration/release acceptance — still required after implementation

These are necessary tests, not reasons to run separate speculative prototypes now.

| Gate | Required evidence | Current evidence |
|---|---|---|
| A1 Privacy and isolation | Every read/write/source/history endpoint belongs to the authenticated user; incognito and memory-off suppress the intended reads/writes, including queued work; clear/reset/erase cannot be undone by late ingestion; export/erase covers original projections, intent ledger, histories, old banks, logs/backups under the chosen policy. | Native tenant/bank and deletion probes exist; the new adapter and lifecycle integration do not. Logical Alice/Bob routing in the generation prototype was not a new security test. |
| A2 Chat and scope | Normal/retry/stream paths use the same bounded memory; source/project/user scope preserved in ingestion and derived retrieval; explicit remember works; no portrait injection; project/history/attachment/task continuity still works separately. | Native recall/tag probes and source review exist. Integrated send/stream/tool paths are unbuilt. |
| A3 Complete memory UI | Browse/search/detail/evidence, correct/remove, accurate progress/failure/retry states, concurrent/stale actions, sensible fact/observation grouping, EN/HU, keyboard/focus/accessibility/mobile and Feature Guide links. | Existing feature inventory and native APIs only. No redesigned integrated UI walk has passed. |
| A4 Operational reliability | Actual model/config routing, worker restart and retries, bounded backlog, resource limits, monitoring, maintenance controls, service failure/degraded chat, supported upgrade/backup/restore. | Small isolated probes; no production-size or deployed integration qualification. |
| A5 Migration and cutover | Explicit migration scope, preservation of intended manual edits, handling of existing low-quality memories, source/date mappings, no automatic replay after reset, rollback without running competing memory authorities. | Source-audited migration/cutover recommendation recorded in design-readiness-boundaries.md; no executed rehearsal. Earlier synthetic banks are not a migration rehearsal. |

Quality and curation regressions from P1 remain in the integrated regression suite; implementation can change the inputs and invalidate a prototype result.

## Coverage of the existing 37-feature inventory

| IDs | Disposition / remaining requirement |
|---|---|
| 01, 03, 04, 08, 13, 22, 25 | Keep browsing/search/detail/evidence/actions/status/navigation. Native primitives exist; define displayed item/count and test actual UI under A3. |
| 02, 05 | Redesign grouping and provenance labels. Do not recreate the four-category classifier or label native fact types as stated/inferred certainty. Actual claims about certainty must be evidence-backed under P1. |
| 06, 31 | Keep meaningful scope and bounded chat retrieval; qualify under A2. Native tags alone do not prove app scope or derived-observation isolation. |
| 09–12, 37 | Keep reliable edits, removal and stale-action behavior; central blockers P1/P2, then A1/A3. Source-wide collateral deletion and blanket source freezes remain rejected. Removal versus physical erasure still needs precise user-facing semantics. |
| 14–16 | Portrait and summary editing deliberately omitted by owner direction. No portrait refresh/deletion subsystem needs prototyping. Consolidation freshness still matters under P2/A4. |
| 07, 17–21, 24 | Inferred expiry/renewal, routine review queue/deadlines/notices, permanent endorsement machinery and general nightly undo deliberately omitted. This does not waive honoring explicit user edits or asking when a consequential assumption genuinely needs confirmation. |
| 23 | Optional simple activity/provenance can use native history. Do not rebuild nightly narrative/undo machinery by default. Exact presentation belongs in UI design. |
| 26–27 | Memory on/off and incognito are retained privacy requirements; A1/A2. |
| 28–30 | Explicit remember, automatic learning and careful handling of assumptions remain core requirements; P1 then A2. Neither “manual source” nor a prompt alone guarantees protected/true facts. |
| 32 | Existing project/history/attachment continuity is outside profile-memory replacement; preserve and regression-test, do not delete because its API contains the word memory. |
| 33–34 | Clear/reset/account erase/export must include the new external store and app-owned ledger; A1/A5. |
| 35 | Replace obsolete engine-specific admin controls with actual supported model/worker/config controls; A4/A3. No need for exact legacy control parity. |
| 36 | Full EN/HU, accessibility, mobile and guide integration retained; A3. |

## Plain answer

The design boundaries and feature inventory are clear. Hindsight's bounded storage/update mechanisms are feasible; **the tested automatic understanding/curation pipeline still fails the full replacement requirement**. No more ordinary feature probes are identified. A qualified semantic strategy is needed before committing to this backend as the full replacement; actual integration/UI/recovery/migration acceptance follows implementation. Do not call either stage passed prematurely.
