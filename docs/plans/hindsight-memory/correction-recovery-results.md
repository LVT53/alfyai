# Correction recovery: native precedence and verified publication

2026-11-18. **The two focused blockers are resolved at prototype level under the owner's clarified rule.** The interrupted ordinary correction tests are complete. A composed native lifecycle passed interruption, actual service restart, verified publication, older-source reprocessing, late completion and reset. Extraction stays native; the failed disputed-value neutralizer is not part of the proposed boundary.

This establishes a behavior contract for design, not production release acceptance. No product code, UI, deployment or upstream changes were made. The existing 69/72 Hindsight benchmark is still the earlier configuration; this is not a new 72-question accuracy score.

## The rule that changed the result

The owner explicitly chose: **a later deliberate statement/edit wins**, including over conflicting claims in other chats. A correction to purple followed by an explicit source edit to green means green. Mere reprocessing does not constitute a new assertion.

The earlier requirement to remove the disputed value and leave it unresolved was an evaluator assumption, not an owner requirement. Trying to satisfy it caused unnecessary neutralization/classification work and collateral-loss failures. Those failures remain valid evidence about the abandoned operation, but do not block the owner's chosen semantics.

There is a second crucial distinction: an edit to one fact does not renew every unchanged statement in that old chat. Editing a kayak colour must not make an obsolete coffee preference current again. A statement about the past or a future plan also must not overwrite current state merely because it was mentioned later.

## Small boundary tested

1. **Ordinary assertions and explicit edits go through native retain.** A source edit is delivered as an application-authored event containing before/after text and its real edit time. Native retain is instructed to extract only actually changed claims; unchanged text is context, not a new assertion. No AlfyAI semantic extractor or property taxonomy is introduced.
2. **Keep assertion time separate from processing time.** Each source/event has a stable date. Re-extraction into a new native document preserves that date. The answer path receives verified raw facts with this provenance and applies the latest applicable explicit assertion for the same person/object/project/property.
3. **Prepare a new native revision without destroying the accepted one.** The small application ledger owns event/source identity, attempt number, reset epoch, desired version and acknowledged native IDs/text. It does not synthesize personal facts. Only after native completion and read-back verification does the accepted pointer change.
4. **Filter before retrieval and before exposure.** Native raw-fact Recall uses the accepted revision tags with `any_strict`, then exact acknowledged ID/text checks. Untagged derived material, pending revisions, raw chunks and arbitrary graph/source expansion do not bypass this boundary.
5. **Let native consolidation work across chats.** Revision tags otherwise partition observations by default. `default_observation_scopes: shared` lets Hindsight consolidate across those tags within the private user bank. This does not mean sharing memory between users. Derived observations remain aids, not unquestioned historical truth.
6. **Retain bounded native curation for selective removal.** The earlier exact-span/PATCH/invalidation path remains relevant for removing an attribution without losing unrelated information. Positive corrections and newer source facts no longer need the rejected conflict-neutralization pipeline.

The ledger and event envelope are ordinary integration/delivery state. Native Hindsight still owns extraction, storage, embeddings, retrieval and consolidation. No permanent endorsement system, routine review inbox or additional question to the user is required by this rule.

## Completed tests

| Area | Evidence |
|---|---|
| Interrupted ordinary curation | Seven remaining cases completed after model recovery; together with the previously passed kayak case, all eight forced-reprocess scenarios are completed across the two runs |
| Semantic repeats | Six repeated phone/shared-person/historical-move operations passed the required content checks |
| Publication mechanism | 12 assertions passed; accepted facts survived an injected preparation failure, stale acknowledgements were rejected, old-document cleanup preserved the new revision, and a late old native write did not enter recall |
| Publication restart/reset | Actual service restart preserved all three accepted facts; reset revoked admission and rejected pre-reset completion |
| Latest explicit statement across chats | Three scenario families passed before-edit, after-edit and older-chat replay checks, plus a future-plan/question check: 10 answer states per configuration |
| Shared native consolidation | The same 10 answer states passed with shared observation scope; native current summaries adopted the new values across chats |
| Temporal/scope follow-ups | Four passed: corrections are not proof of repainting; a later statement about July did not replace current state; a genuinely newer chat won; reprocessing the older edit did not undo it |
| Bounded recall | The last two follow-ups also passed with a 512-token native recall budget |
| Final composed lifecycle | 14 mechanical assertions and six answer-state checks passed in one scenario using native edit extraction, shared consolidation, a persisted per-event ledger, actual restart, old-source reprocessing, late native work and reset |

These are correlated synthetic development checks with manual, non-blind grading. They establish the tested behavior, not a universal accuracy percentage or large-bank retrieval guarantee. Hungarian answers sometimes cautiously distinguished “regular swimming” from an explicitly declared hobby, but retained the relevant activity. Minor stylistic issues are not hidden as memory-content failures or claimed solved.

### Native edit extraction preserved unrelated newer information

The retained edit-only outputs were:

- Gear: the touring kayak is green. Espresso remained current despite unchanged “I prefer decaf” text in the edited old chat; the white racing kayak, club storage and Saturday paddling survived.
- Hungarian city: the user lives in Pécs. The brother remained in Győr; a newer detailed-answer preference was not replaced by unchanged old short-answer wording; Wednesday swimming survived.
- Projects: Juniper uses Scala. Its newer Friday schedule was not replaced by unchanged Monday wording in the old edited chat; Harbor retained Kotlin and its dark theme.

No expected answer was passed to either the native extractor or answer model. Before/after text and explicit user correction content are legitimate input evidence. The source edit output came from Hindsight's normal extraction call, not an AlfyAI-written fact.

### Final composed interruption/restart sequence

The initial accepted evidence contained seven raw facts and answered purple / espresso / white racing kayak at the club / Saturday paddling. Native extraction then produced the pending green edit, but it was not published. The reader still admitted exactly those seven accepted facts.

The runner exited at that boundary and the scratch Hindsight service was actually stopped and restarted. Reloading the ledger preserved the same accepted facts. After native read-back and acknowledgement, eight raw facts were admitted; the answer selected green and preserved all unrelated information.

The older conflicting chat was extracted into a separate staging document at its original assertion time. Its staging document was forcibly reprocessed, creating new native identities, while the accepted older revision remained readable. After publication, green still won. A stale completion was rejected; forcing another old native document to reprocess did not change the admitted current answer. Reset immediately yielded no admitted facts and prevented pre-reset work from publishing. The synthetic bank was then deleted through the native API.

## What “superseded” means here

Older statements cease to control the current answer. They can remain as dated evidence of what was asserted; we do not rewrite history to pretend the person always said the newest value. A replay does not get a fresh assertion date.

Native shared observations got the current values right in these cases, but sometimes described earlier conflicting assertions as real historical states (“earlier it was purple”). That is not necessarily justified by a correction. The tested raw-fact answer path correctly rejected an invented physical repainting history. **Do not present native observations as verified histories or bypass the provenance-aware read boundary in a future UI or tool.**

This round does not claim physical erasure of old source text, a distributed transaction implementation, multi-process crash linearizability, exhaustive discovery of all paraphrases, or proof that small recall budgets always recover every relevant update. Those are integration/acceptance boundaries, not reasons to reinstate the abandoned neutralizer. Whole-source removal, explicit forget and retention controls must keep their documented scope; latest-statement precedence is not a replacement for deletion.

## Model and execution

The configured local alias `qwen3-6-27b` responded again at 2026-11-18 16:06:33 UTC. This run recorded 172 model requests with zero HTTP failures, using runtime fingerprint `vllm-0.31.0-6612147e`. That fingerprint is not proof of immutable model weights. Calls were run sequentially at the test-runner level after recovery; native background operations were allowed to settle before the next stage. No production service was restarted or modified.

Native Hindsight source remains pinned at `9fb28dbd724dc1ce4da7cb4c49008e601db76c5f`. The relevant pinned request/config code was checked for document reprocess, strict tag matching, raw fact types and shared observation scopes. AlfyAI product checkout remained `e60bb0c114c02a3063d5bf6972ddeb813cccbf6c`, with no tracked product diff.

## Design and implementation consequence

These two blockers no longer require a custom all-memory extractor or conflict-rewriting engine. The replacement can be designed around native dated assertions/edits and a small, durable publication boundary.

For later implementation, use actual transactional application storage for the ledger and enforce the same admission rules on every read path. The prototype used atomic local-file replacement with one writer and actual service restarts; it is not a production database transaction or a power-loss test. Handle verified empty extraction as a legitimate outcome where appropriate—the positive fixtures assert nonempty output only because their edits explicitly add a fact. Keep normal conversation/knowledge/task-continuity boundaries separate from profile-memory replacement.

No UI was started. Product implementation/migration still requires the owner's later instruction. UI design can now use the tested semantics without inheriting the earlier unresolved-conflict assumption. The 37-feature inventory remains the integration checklist, not a claim that an unbuilt replacement has passed end-to-end acceptance.

## Evidence

[Machine-readable summary](correction-recovery/summary.json), [manual semantic grades](correction-recovery/manual-grades.json), [finished curation cases](correction-recovery/finished-results.json), [repeat results](correction-recovery/repeat-results.json), [publication mechanism](correction-recovery/publication-results.json), [publication restart/reset](correction-recovery/publication-restart-results.json), [native supersession](correction-recovery/supersession-results.json), [shared-consolidation supersession](correction-recovery/supersession-shared-results.json), [temporal follow-ups](correction-recovery/supersession-followup-results.json), [final composed run](correction-recovery/composed-results.json). Frozen inputs/prompts, scripts, native API responses, model transcripts and hashes are beside them. Prior failed/interrupted artifacts were not overwritten.
