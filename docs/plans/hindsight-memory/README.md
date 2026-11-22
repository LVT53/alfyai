# Hindsight Memory redesign — session handoff

## Current handoff — local implementation and rollout boundary

The complete replacement is integrated locally on `codex/hindsight-memory-replacement`, with product and regression candidate `afe75236a2dfd250b41c7b75ca27399ba3dee35b`. It includes the released app lineage and the approved dependency update through `b729c68e1`. Independent review accepted the local candidate. Release verification passed across the recorded runs, including 28,678 unit tests and 1,725 browser tests. Start with the [independent whole-plan review](review-final-whole-plan.md) and [implementation progress](implementation-progress.md) for the exact gates, fixes and remaining limits.

The app uses pinned native Hindsight for extraction and consolidation. It uses its existing job engine for delivery and owns source permission, scoped publication, evidence, corrections/removals, and migration controls. Personal memory is available in all of the user's eligible chats. A project's memories stay in that project. The bounded synthetic evaluation found recall improvements and model-dependent limits, including one mixed contextual edit held by the checker. [Native smoke](native-acceptance/integrated-smoke/README.md) · [Recall benchmark](integrated-native-benchmark/README.md) · [Mixed lifecycle evidence](native-lifecycle-acceptance/mixed-check/README.md)

Real accounts remain on their existing app. The old live app cannot safely record every privacy change or hand off native erasure while preparing inactive banks. Conditional authorization for inactive enrollment was insufficient to resolve that blocker. Separate authorization is needed for the compatible deployment and per-user cutover. The runbook records the order and trustworthy rollback requirements. [Predeployment privacy evidence](predeployment-migration-readiness.md) · [Migration runbook](migration-runbook.md)

## Historical planning checkpoint — 18 November 2026

**Start with the [full replacement implementation plan](../../superpowers/plans/2026-11-18-hindsight-memory-replacement.md) and [accepted migration policy](chat-backfill-migration.md#accepted-migration-policy--owner-approved-2026-11-18).** The owner approved preserving all deliberate exclusions (including review resolutions), withholding ambiguously mapped historical material, preserving verified authored edits, and a one-time optional per-user choice for history whose memory-off eligibility is unknown. Incognito, known disabled periods, resets and removals remain excluded regardless of import consent. No owner-wide consent for other accounts. Ordinary new eligible memory continues while history is pending. No recurring review inbox or permanent topic ban.

The plan covers all eight delivery tasks and A1–A5 acceptance, reuses AlfyAI's existing job engine, and explicitly supersedes the old local-only architectural rule during implementation. **No implementation, real-data processing, migration or deployment is authorized yet.** Remaining record-level exceptions are execution/audit work under the agreed policy, not unresolved product-policy questions. Do not reopen settled design or start another broad model bake-off.

Read [overnight concurrency](capacity-concurrency-results.md) and [local-model capacity and backfill](capacity-backfill-results.md) first. Batch-one consolidation added about 6.5% to combined extraction/consolidation time on the short workload; ordinary updates took 5–8 seconds. Inventory found 2,104 potential user-message inputs across six accounts. Matched concurrency 1/3/6/8 tests found 2.2× speedup at three and 2.8× at six; eight offered no further improvement. Rough overnight planning allowance is 2–4 hours, not a measured real migration duration. Bound admission before native request timeouts; a large serial proxy queue caused recovered timeouts. All synthetic banks were cleaned up and scratch services stopped.

The inventory also found 28 active authored statements, 38 deleted/suppressed rows, and 96 saved do-not-remember review decisions affecting 105 existing items, with only six overlapping the deleted/suppressed list. Historical memory-off eligibility and indirect exclusion mappings require bounded audit under the now-agreed policy. Preserve these choices; do not build a global semantic deletion engine. No real-chat backfill or product implementation is authorized by the tests.

Read [current-list follow-up](current-list-followup-results.md), [Edit/Remove follow-up](edit-remove-followup-results.md), [chat-backfill migration](chat-backfill-migration.md), and [agreed UI design](agreed-ui-design.md).

The latest scratch tests found a native-backed current-list path: native observations with a current-information mission and supported `consolidation_llm_batch_size: 1`, published through an immutable accepted read snapshot. A small source-verified formatter separates native dated provenance suffixes from the main statement. No engine fork, second extractor, property taxonomy or global semantic canonicalizer was built. Both languages survived older-source replay, pending discard, native single-fact edit/removal, full observation rebuild and actual restart. Fresh historical/future/ownership holdouts passed. Current-text search/pagination/revocation checks passed.

Costs/limits: more background consolidation calls; suffix formatting depends on pinned native internals; native semantic search ranking was noisy; native row IDs/groupings can change on rebuild. Arbitrary split/merge history and unknown cross-chat duplicates remain unqualified. An expanded English mixed edit was safely withheld (older colour variants survived its candidate), so do not claim every edit succeeds. The prior four-case Edit/Remove prototype remains valid evidence, not universal correctness.

**No product implementation, real-chat processing, migration or deployment occurred.** Capacity tests and aggregate inventory now exist; complete the actual migration rehearsal and transactional/UI/privacy integration gates during implementation. The user accepts imperfect model quality when materially better than legacy; do not turn this into another bespoke memory engine.

The owner-approved Quiet list visual design stands. No Manage buttons: on/off/reset remain in Profile settings. No portrait or new nightly reconciliation process. Original eligible chats, verified manual choices and reset/removal boundaries are the proposed migration inputs, with inactive banks prepared before per-user cutover.

Earlier entries below are historical evidence, not the latest qualification verdict.


Updated: 2026-11-18 after local model recovery and the owner's explicit latest-statement ruling. **The two focused correction/replay blockers are resolved at prototype level.** Read [native precedence and verified publication](correction-recovery-results.md) first. Native dated edit events supersede older conflicting claims across chats, while immutable prepared revisions preserve accepted memory during reprocessing failures. The final composed interruption/restart/replay/reset run passed. After further exploration, the owner chose Quiet list as the base to refine, with the Personal/project dropdown. Notebook and Loose notes were rejected. The latest [complete design study](ui-complete-design.md) applies the accepted [hierarchy direction](ui-hierarchy-refinement.md) across Memory views. Source links must open the original chat at the referenced message, with no intermediate Memory source page. This remains design-only and awaits feedback, governed by the accepted [scope boundary](scope-boundary.md). No product implementation was started; release acceptance remains separate from design readiness.

## Owner decisions

- **Accepted scope boundary (2026-11-18):** [Personal/project boundary](scope-boundary.md). Project memories stay in their project; personal memory is available everywhere for that user. Global project awareness uses names/descriptions from project records only. No automatic sharing of project key points. The first UI directions were rejected; design exploration continues, no implementation.


- **Latest explicit conflict rule (2026-11-18):** owner chose “Use green” when an older memory correction says purple and a later deliberate source edit says green. The later explicit change supersedes the previous fact, including conflicting claims in other chats. Mere reprocessing or unrelated source edits must not promote stale claims. The earlier “withhold the disputed value” policy was an evaluator assumption, not an owner requirement; do not keep trying to satisfy it as the product contract.

- **Latest direction:** owner is willing to maintain an AlfyAI-owned correction/removal component and does not want upstream work. Authorized an isolated prototype. See [prototype results](curation-prototype-results.md); do not restart upstream research or infer product implementation approval.

- **Latest correction (2026-11-18): this is the full replacement, not a reduced v1.** Owner rejected losing unrelated facts during source-level removal and freezing curated memory when its chat source is edited. Selective removal and synchronized edits must preserve user corrections. Integration simplicity must not weaken these outcomes. Earlier approved feature simplifications remain; do not automatically restore dropped controls. Hindsight must earn its fit against these requirements.


- Prefer replacing the bespoke profile-memory engine with self-hosted Hindsight if it meets the product needs. Do not rebuild the old engine inside an adapter.
- Automatic for ordinary users; manually adjustable when necessary. Explicit personal statements may be remembered automatically. Questions/interest must not become ownership; assumptions must not become confirmed facts without confirmation. Avoid constant questioning.
- Local Flash Next is the intended memory LLM. `qwen3-6-27b`, `qwen3-8-flash-next`, and `flash-next` are aliases; the prior “27B” label was not verified weight identity. No more expensive-model testing by default.
- Keep browsing/search, evidence, correction, clear removal controls, operation status, memory on/off, incognito and user isolation.
- Owner approved simplifying away the old expiry/renewal rules, routine review inbox, permanent endorsement/protection machinery and nightly maintenance undo from the replacement design. This does NOT waive accurate attribution or reliable correction/removal.
- Drop the persona portrait from the replacement design if the new UI makes remembered information understandable. Do not preserve summary editing. Use a searchable, understandable memory view instead.
- Owner permits maintaining and prototyping an AlfyAI-owned component. No particular ledger/projector or app-owned extraction architecture is approved for production yet; flag the maintenance cost before adopting it.
- No product code, deployment, migration or UI implementation yet. Synthetic test harnesses and documentation are authorized.

## Sequence to follow

1. **Test the simplest native workflow (completed).** Native raw-fact correction; reversible invalidation for no-longer-current facts; document deletion for source removal. Use native fact recall without a portrait or raw chunks in ordinary answer context. Check repeated sources, unrelated facts, unchanged retries, restart and changed-source replay. Record limitations rather than hiding them with custom state.
2. **Resolve the capability gaps and revise the product contract (previous draft rejected).** See the owner correction in [product-contract.md](product-contract.md). Test selective removal preserving unrelated facts and source-edit synchronization preserving corrections before proposing revised semantics. Specify what Correct, No longer true, and Remove promise; which targets are editable; what disappears; how past chats and reprocessing interact. Surface any remaining substantive tradeoff to the owner. Do not invent a permanent semantic ban as an assumed requirement.
3. **Design the new Memory UI.** Searchable information, sources and straightforward controls. No expiry/review/undo/summary editor by default. Keep EN/HU, accessibility and the app's minimal visual language. Design only after operation semantics are concrete.
4. Implementation/migration needs a later owner instruction. Test the actual integrated UI and privacy lifecycle then; native API tests are not end-to-end UI acceptance.

## Latest completed result — native precedence and publication

[Recovery results](correction-recovery-results.md) supersede the blocking conclusion below for these two problems. All eight ordinary forced-reprocess scenarios are completed across the previous/recovered runs; six additional repeats passed. Native cross-chat supersession passed three families, including unchanged stale text, older-source replay, questions/future plans and genuinely newer assertions. The final composed lifecycle passed 14 mechanical checks plus its answer-state checks through actual restart and reset.

Do not resume the rejected disputed-value neutralizer. The owner's rule is latest explicit assertion wins; reprocessing never renews its assertion date. Prepare new revisions separately, verify them, then publish. Keep the provenance-aware raw-fact boundary; native observations are not guaranteed historical truth. See the report for exact evidence, scope and the distinction between design readiness and production acceptance.

## Latest experiment — fresh correction lifecycle

Read [fresh lifecycle results](correction-lifecycle-results.md) first. Exact-span edits keep extraction native and preserve untouched bytes. Six fresh domains plus two untouched EN/HU domains showed substantially better ordinary correction behavior. Paired reasoning passed 12 ordinary text states but failed both third-value conflicts; the untouched two domains passed all six native initial/replay/retry stages. No perfect combined score is claimed.

Forced reprocessing passed one case before the local model service returned EngineCore HTTP500 and then became unavailable. Scratch API restart preserved 24 acknowledged facts in seven completed banks. The interrupted phone bank admitted no unacknowledged replacements, preventing leakage but withholding its useful facts too. Full lifecycle/parity remains unqualified: conflict scope and publication availability are unresolved. Follow the report's exact continuation steps; no UI work or production service restart occurred.

## Completed baseline and current replay boundary

The missing actual AlfyAI baseline is now complete: six synthetic users, 102 sessions, 72 questions, 144 answers, zero recorded execution errors or unjudged messages. **Earlier Hindsight: 69/72; actual AlfyAI tool-assisted: 37/72; passive: 32/72.** Lenient grading of three ambiguous conditional answers gives AlfyAI 40/72 and 35/72. The earlier 64/72 comparator was raw history, not AlfyAI. Read [baseline results and limitations](alfyai-baseline-results.md). This supports a meaningful improvement on this dataset, not a production accuracy guarantee.

[The narrow replay ledger](replay-ledger-results.md) preserves native extraction and separates accepted edits from replay. The initial 11 cases passed with trusted, supplied edit/remainder text; added compound-conflict cases exposed silent choices and collateral loss. The final variant passed 12/14 exploratory text cases, failing former-phone attribution and unrelated road-bicycle details. First-edit generation and native writeback of this new pipeline are not qualified. Full parity is still unresolved; do not combine successes across variants or reject native Hindsight because our custom reconciliation failed.

## Latest result — read before proceeding

The owner asked whether the failures belonged to Hindsight or our custom layer and requested further work before giving up. Read [native quality follow-up](native-quality-followup.md): it supersedes the overly broad implication of [previous feasibility decision](design-readiness.md), while preserving its bounded-update/privacy findings.

New evidence separates four layers: native extraction, native derived observations, native curation/replay limitations, and custom extraction/correction defects. Ten native default cases, fourteen native configurable cases, five exact native reasoning replays, fourteen integrated native reasoning cases, twenty-one native-policy curation states, two nine-case narrow-curator variants plus the initial version, and two native PATCH/Recall roundtrips are archived. They are not a combined accuracy score.

Prefer native extraction with qualified retain-specific reasoning; do not adopt the custom all-memory typed ontology. Our code can focus on explicit user correction intent, affected-source reconciliation and consistent publication. Native source replay still does not enforce that intent. Compound facts, conflict fragments/collateral loss and model output-budget failures remain specific blockers for the narrow curator; no feature-parity pass is claimed.

[Bounded native updates](bounded-update-results.md), [app boundaries](design-readiness-boundaries.md) and the [37-feature matrix](replacement-readiness.md) remain applicable. The rejected [product contract](product-contract.md) remains rejected. Do not revive source-wide collateral deletion, frozen sources, an ordinary-user review burden, or unrestricted native Reflect/source expansion that bypasses curation. Preserve the approved omissions. No upstream work is wanted.

## Established findings

- Larger synthetic bench: grounded Hindsight 69/72 vs raw history 64/72. Correlated template cases, manual grading; not a production accuracy estimate. Feeding full raw API objects was expensive in prompt tokens.
- Attribution follow-up: local Flash Next passed 20 reasoning-on probes and paired repeats passed both on/off. Prior failures did not reproduce consistently; reasoning is not proven to fix them.
- Native PATCH corrects raw facts and rebuilds observations. Derived observations cannot be edited directly. Changed source reprocessing resets curation. Unchanged retries behaved differently and need explicit coverage.
- Invalidation removes facts from recall, but old raw source chunks can still contain their text. A source-aware answer can therefore repeat “removed” information.
- Retaining an explicit correction produced correct answers, but changed older-source replay recreated a contradictory old observation. Do not expose observations as guaranteed current truth.
- Native source deletion removes its extracted facts but replay can recreate them. Source-level replacement experiments survived replay/restart but covered known single-source changes, not arbitrary paraphrase discovery.
- Native browse/filter/source inspection, invalidation/restore, tagged recall, async operation tracking, saved summaries and bank deletion were exercised.
- Saved summary deletion is problematic: after its last in-scope source was deleted, explicit full refresh preserved deleted text and reported non-stale. An auto summary also invented a November 2024 date from November 2026 evidence. Another auto refresh correctly adopted a later preference. These findings support omitting the portrait.
- Native API does not expose equivalent old review/endorsement/expiry/maintenance-undo contracts. Temporal dates are not enforced expiry; fact types are not stated/inferred confidence.
- Our existing Edit summary adds sentence facts and regenerates, rather than replacing underlying facts. Delete permanently marks a fact deleted; it is not complete physical erasure. Do not preserve those misleading promises.
- Privacy gates, source delivery IDs/acknowledgements, tenant mapping, reset/erase/export and bounded chat context remain necessary application integration. That is distinct from a second memory authority.
- `memory_context` also serves folder/history/attachment/task continuity. Do not scrap all memory-named APIs or the knowledge/artifact subsystem blindly.

## Evidence and reproducibility

The historical source archive restores the original prototype runners alongside these reports and fixtures. It includes a path-by-path checksum manifest and replay instructions. [Historical research source](research-source/README.md)

AlfyAI reviewed at `e60bb0c114c02a3063d5bf6972ddeb813cccbf6c`.
Hindsight source `9fb28dbd724dc1ce4da7cb4c49008e601db76c5f`, evaluator 1.2.1.

Detailed previous evidence is copied into `prior-findings/` in this directory for continuity. Original complete artifacts, including raw transcripts:

- `/Users/lvt53/.codex/visualizations/2026/11/17/01a1ebf0-5321-7190-a198-41c2994a41ea/hindsight-bench-v2/`
- `/Users/lvt53/.codex/visualizations/2026/11/17/01a1ebf0-5321-7190-a198-41c2994a41ea/hindsight-adoption/`
- `/Users/lvt53/.codex/visualizations/2026/11/17/01a1ebf0-5321-7190-a198-41c2994a41ea/hindsight-ui-inventory/`

Scratch evaluator: `/tmp/alfyai-hindsight-eval` (clone, venv, embedded PostgreSQL, local embeddings/reranker). Native workflow runner: `/tmp/alfyai-hindsight-native-workflow`. Ports 18890/18891 are scratch-only. Model proxy uses synthetic requests and remote readonly provider configuration; credentials remain remote. Never print secrets. Only isolated evaluation services may be restarted; do not restart production.

For new sessions: read this file, `design-readiness.md`, `typed-frame-results.md`, `bounded-update-results.md`, `design-readiness-boundaries.md` and `replacement-readiness.md`. Follow their links for earlier evidence only when needed. Verify current checkout and tool availability. Do not rerun all previous benchmarks or assume scratch processes are still running.

Latest fit evaluator shutdown: API/proxy on 18890/18891 and isolated `alfyai-eval` PostgreSQL stopped after the completed 2026-11-18 run. Artifacts remain in `fit-investigation/`; scratch files in `/tmp/alfyai-hindsight-fit`.

Curation prototype cleanup: its API/proxy (18890/18891) and scratch `alfyai-eval` PostgreSQL were stopped after completed probes. Scratch runner files remain at `/tmp/alfyai-hindsight-curation-prototype`; durable copies and hashes are in `curation-prototype/`.

Source-anchor cleanup: scratch API/proxy on 18890/18891 and `alfyai-eval` PostgreSQL stopped after completed testing. Artifacts are in `source-anchor-prototype/`, with originals at `/tmp/alfyai-hindsight-anchors`.

Claim-level cleanup: scratch API/proxy (18890/18891) and `alfyai-eval` PostgreSQL stopped. Complete artifacts remain in `claim-level-prototype/`, with scratch originals at `/tmp/alfyai-hindsight-claims`.

Final feasibility cleanup (2026-11-18): completed fast/fresh/reasoning/strict-schema runs archived in `final-feasibility/`; 32 artifact hashes and all case counts verified. The isolated API/proxy (18890/18891) and `alfyai-eval` PostgreSQL were stopped. No product files changed.

Native-quality follow-up cleanup (2026-11-18): all nine runs completed, 35 artifact hashes/case counts/syntax verified; isolated API/proxy and `alfyai-eval` PostgreSQL stopped. Product files remain unchanged.
