# Four UI-facing Hindsight checks

**Later follow-up:** The tested Edit/Remove failures have now passed a bounded intent/apply/check prototype with replay and actual restart. See [latest results](edit-remove-followup-results.md). The subsequent [current-list follow-up](current-list-followup-results.md) found a native-backed path in focused tests, with explicit cost/compatibility limits. This document preserves the original four-check results.

2026-11-18. Synthetic scratch evaluation only; no product implementation or production memory writes. Native extraction unchanged throughout. Local configured model alias `qwen3-6-27b`; no inference about actual model size. Hindsight pin `9fb28dbd724dc1ce4da7cb4c49008e601db76c5f`.

## Verdict

**Not a complete feature-parity pass.** Bank isolation and dated answering remain promising. Current-list semantics and mixed correction/removal still prevent claiming the entire approved UI works cleanly. Do not discard Hindsight's successful native extraction because of our editor failure; do not quietly add an all-memory semantic projection engine to make the list look correct.

| Requirement | Observed result | Implication |
|---|---|---|
| Current browse/search | Native `state=valid` includes accepted old amber/decaf assertions alongside newer teal/espresso; it also exposes unpublished orange evidence. Accepted-ID/text filtering excludes the pending evidence from recall, but does not resolve old accepted contradictions in the list. A concurrent insertion produced duplicate IDs across offset pages. `q=amber` still found obsolete claims. | **Failed as a current-truth list.** The native evidence list is not the UI's promised current-memory view. Snapshot pagination is ordinary app work; deciding which parts of compound facts remain current is semantic work and the main maintenance-expansion risk. |
| One editor for changes and omissions | English backpack-colour removal + canoe-colour replacement preserved ownership/storage across replay, forced native reprocessing, new explicit statement and restart. Hungarian combined user/Luca diet omission + cat-colour omission/replacement did not pass. | **Failed overall.** Do not enable the free-text editor on the assumption that syntactically valid span edits guarantee semantic completeness. |
| Previous versions/source links | Native IDs changed on reprocessing. Raw memory `/history` returned `[]`; exact source text remained in documents. Supplied chat/message metadata survived native processing/restart. Follow-up replay explicitly reused original chat/message IDs across a new document revision. | **Small app support required, partially qualified.** Save actual accepted before/after wording and stable source references in the existing publication ledger. Native observation history is not raw-edit history. Arbitrary split/merge row lineage and a history of automatic cross-chat current facts remain unproven and tied to the current-list gap. |
| Personal/project banks | Same bank names under two users remained isolated. All six personal/project read compositions used only permitted scopes. Foreign raw-ID lookup returned 404. Updating/replaying Juniper left personal and Harbor unchanged; deleting p05 Juniper left its personal and Harbor banks unchanged. p06 Juniper's newer Sunday/concise-diagram statement survived old-source replay. | **Passed exercised native isolation/composition cases.** App authorization, queues, full account reset/export and real source navigation remain integration tests. No automatic project-to-personal promotion was added. |

## Correction failure attribution

Original Hungarian attempt: the application-side exact-span editor exhausted 8,192 reasoning tokens twice without returning usable JSON. The harness then failed reading `facts` from null. This is an editor generation/validation failure, not a native-retain failure. No edit was applied in that failed attempt. A production wrapper must fail closed and retain the prior accepted state on malformed output.

Bounded follow-up disabled thinking only for the small application editor/answer, leaving native retain settings intact. It produced valid span edits but omitted Mák's colour removal. Later replay also left the user's gluten-free diet in evidence. After restart the answer again asserted that diet and described removed black fur as a past state. The later brown-fur assertion worked, but does not rescue the omission failures. Exact-span/coverage validation prevents invented IDs or collateral text replacement; it cannot prove the requested semantic omissions were completed. No bespoke Hungarian rule, gold answer, custom extraction or whole-bank rewriting was introduced to force a pass.

The English and Hungarian fixtures are small, not a statistical benchmark. Earlier benchmark comparisons are not rerun or superseded here. These failures narrow which UI promises can currently be made; they do not negate earlier native quality improvements over legacy AlfyAI.

## Provenance and temporal limitations

The first English replay harness generated chat/message metadata from the new document ID. That is a harness choice, not a Hindsight lineage bug. The Hungarian follow-up supplied the original chat/message IDs for `repeat-r2` and verified them after restart. The app must own that stable mapping. Source metadata identity and saved source text do not prove arbitrary automatic split/merge history.

Native extraction/answering sometimes converted a weekday-only release statement into a specific November date. Scope isolation passed, but this is not proof of temporal interpretation quality. Historical-looking observation text must not be used as the UI's verified previous wording.

The actual scratch restart preserved raw IDs/text for both completed edit runs. Persistence checks passed even where persisted Hungarian content was semantically wrong; these are separate verdicts.

## Evidence

All under `ui-qualification-run/`:

- `run.cjs`, `frozen.json`, `results.json`, `api.jsonl`: original four groups, including the original failure.
- `editor-followup.cjs`, `editor-followup-frozen.json`, `editor-followup-results.json`, `editor-followup-api.jsonl`: isolated no-thinking editor follow-up, native extraction unchanged.
- `followup.cjs`, `followup-results.json`, `followup-api.jsonl`, `restart-server.log`: actual scratch restart, source metadata, project update/replay.
- `model-calls.jsonl`: synthetic prompts/responses, including token-limit failures.
- `backfill.cjs`, `backfill-results.json`, `backfill-api.jsonl`: additional native batch/retry probe. See [migration investigation](chat-backfill-migration.md).

No full app gate was run: no product code changed. The standalone approved visual study received 12px horizontal row padding and existing-style hover transitions with reduced-motion handling; its 34-state preview check reported no JS errors/overflow. Production UI implementation remains unauthorized.

## Next bounded decisions

1. Resolve the current-view promise using a native-supported representation or an explicitly agreed UI tradeoff. A global semantic canonicalizer/supersession graph would be rebuilding too much; flag it before any implementation.
2. Qualify a bounded editor that handles both replacement and omission reliably on the intended local model. Do not expand this into a second extractor or silently accept failed removals. These fresh cases are regression inputs, not instructions to hard-code outputs.
3. Treat chat backfill as a migration requirement: native batch ingestion is feasible, but existing manual choices/privacy exceptions and cutover need qualification. Prepare inactive banks before activation to meet the day-one goal.

The approved visual hierarchy stands. No further visual redesign is implied by this report; backend-backed meaning must be settled before implementation promises.

## Cleanup and owner perspective

All eleven recorded synthetic bank entries were deleted successfully (see `ui-qualification-run/cleanup.json`); the scratch API and proxy were stopped. Evidence is retained with SHA-256 hashes. No production memory changed.

The owner emphasized that the measured improvement over the legacy baseline is already valuable and perfection is not the adoption criterion. Treat the remaining issues as bounded product tradeoffs and acceptance risks, not a demand to eliminate every model error or abandon Hindsight. Do not equate a benchmark-score ratio with universal precision without the underlying metric definition.
