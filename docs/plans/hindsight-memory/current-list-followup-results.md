# Native-backed current Memory list

2026-11-18. Synthetic feasibility tests only. Hindsight pin `9fb28dbd724dc1ce4da7cb4c49008e601db76c5f`, clean upstream checkout; local configured model alias `qwen3-6-27b`. No native engine patches, custom extraction, product implementation, real-chat processing or deployment.

## Recommendation

Use **native observations**, rather than all valid raw facts, as the list's primary rows. Give native consolidation a current-information mission and set the supported per-bank `consolidation_llm_batch_size` to **1** for the evaluated configuration. Publish a saved, versioned copy of the resulting native rows only after the corresponding accepted work settles. Search and paginate that same published view.

This is a viable bounded path in the tested cases, not a claim that observations can never be wrong. Hindsight owns synthesis, conflict handling, deduplication and rebuilding. AlfyAI owns authorization, publication/read consistency, revocation and presentation. **No separate semantic current-truth engine was needed.**

## What was actually tested

| Native option | Observed outcome |
|---|---|
| Existing observations mission / default batching | Newer values generally appeared, but old descriptions remained in row text. Discarding a pending source caused old amber/teal/green assertions to return as separate observations. Not suitable as-is. |
| Current-information mission / default batching | Ordinary updates became clean current statements. Older-source replay still appended dated history, and pending-source deletion still rebuilt conflicting rows. Instructions alone were insufficient. |
| Current-information mission / one-fact native batches | English and Hungarian sequences kept current values through older-source replay, pending-source removal, explicit single-fact Edit/Remove and complete native observation rebuilding. A fresh mixed-time/ownership batch also preserved current/historical/planned distinctions after rebuilding. |

The two final language runs each completed eleven stages: original, newer assertion, explicit correction, old-source replay, unpublished candidate, candidate removal, new single-fact memory, its explicit edit, its removal, full native rebuild, and insertion during an older pinned page. A separate fresh bank exercised two states: initial out-of-order native batch and full rebuild. Expected meanings were inspected separately from the native model output.

Examples:

- Green backpack stayed green instead of reverting to amber/teal; espresso stayed current; canoe ownership and sister's tea preference survived.
- Hungarian bicycle stayed green; detailed-answer preference, white kayak and sister's Győr residence survived.
- Editing Leuchtturm to Rhodia changed the native observation; removing the raw source removed that observation without losing other information.
- Fresh holdout: Cork remained current, Galway remained explicitly in 2020, Belfast remained an undecided future move, the user did not own a drill, and colleague Nora did.

## Why the native setting mattered

Pinned `engine/consolidation/consolidator.py` processes LLM batches within one observation scope serially. A batch can contain multiple mutually conflicting source facts. After observations are deleted/rebuilt, those facts can become separate new observations in the same batch. Using one source fact per LLM batch lets each subsequent fact compare against already-persisted observations. Native assertion-date checks protect newer observations from older late-arriving facts. This explanation is supported by source inspection and the paired observed outcomes; it is not a proof that every consolidation conflict is solved.

**Cost:** more native consolidation calls and potentially slower backfill/rebuilds. This is a quality-oriented configuration, not a performance claim. Measure realistic per-user volume and local-model throughput before migration. Ordinary page opens must not trigger an LLM pass; serve the saved published view. No new nightly reconciliation process is proposed.

## Small application boundary

### Published view and revocation

Store native observation ID, text, source IDs and the accepted source-revision fingerprints as a read snapshot. Do not generate new facts, resolve conflicts again, or assign a property taxonomy. A bank's accepted generation determines when a new snapshot can publish; candidate preparation must not change the reader's current snapshot.

The probes verified that unaccepted source IDs contaminated the affected live observation and that the source-membership check rejected it. Keeping the **previous complete snapshot** avoids temporarily dropping its unaffected content. Do not publish a partial list merely because filtering rejected one pending row.

An explicit Remove/reset/privacy revocation is different: apply the live revocation filter to cached rows immediately, including rows on an older pagination snapshot. A fixed page cursor must never resurrect revoked content. The deterministic probe hid the affected cached notebook observation before refresh and confirmed native removal after settlement. If a compound raw source supports several observations, affected rows may need to show updating/temporarily disappear until native rebuild completes; do not show a stale claim or silently call the partial view complete.

These probes are single-writer scratch logic, not proof of production atomic capture under concurrent writers. The existing immutable prepared-revision/publication ledger, bank-level serialization and actual transactional tests remain necessary. A list over more than one native API page also needs a write-generation check or serialization during capture; offset pagination is not magically a snapshot.

### Displaying native history notes

The pinned engine's `_FactBatchResponse.to_actions` and `_with_earlier_states` append older-source notes to observation text in the form `(YYYY-MM-DD HH:MM: source sentence)`, even with a current-only mission. `triage.fact_sentence` uses the raw text before the native ` | ` annotation separator.

A small compatibility formatter separates **only an exact trailing generated note matching a cited source's date and sentence**. It leaves arbitrary parentheses, real historical information and unverified text untouched. It does not pick the current value or rewrite model prose. Original observation text and source references remain stored. The first probe matched the entire annotated raw text and correctly failed to strip these notes; `presentation.cjs` and `presentation-results.json` contain the corrected source-verified adapter.

This relies on a pinned internal format, **not a documented structured `current_text` field**. Keep focused upgrade tests; an upstream format change must fail visibly/conservatively rather than erase arbitrary text. A native separate current-text/history field would be cleaner, but no upstream work or fork is required by the tested adapter. These generated source notes are not original chat quotations or the UI's “Previous wording”; original chat links still resolve through source metadata.

### Search and identity

Literal search over published display text excluded old amber/red values and retained the canoe/kayak result. Native `q` still matched old values inside appended notes, so forwarding the UI query directly to that API is not equivalent. An ordinary index over published native text is acceptable application work, not another semantic memory system.

Native observation Recall was also tested and filtered against published ID/text. It returned current admitted rows, but ranked unrelated rows ahead of the boating result in these small banks. **Do not claim polished semantic search is solved.** Use predictable current-text search for the approved list; any richer search needs separate ranking acceptance, not another fact synthesizer.

Pinned snapshot pagination had no duplicates/omissions across an insertion. Native observation IDs and grouping can change during rebuilding: an English backpack/canoe temporarily shared a row and later split again. Do not promise permanent one-row-per-fact identity or invent matching histories. Keep detail links revision-aware; explicit accepted edit snapshots remain the history authority. Arbitrary automatic split/merge lineage is still unqualified.

## Other evidence and limitations

The broader English mixed-edit attempt in the default-batch probe was **withheld safely** because the bounded editor left older amber variants. It did not mutate those facts, and subsequent list-after-mixed-edit checks for that case were not run. The Hungarian mixed edit passed. This does not overturn the earlier successful four-case Edit/Remove prototype, but shows its expected reliability limit with a larger conflicting source set. Do not describe every edit as guaranteed to succeed. The final one-fact-batch list tests use native whole-fact edit/invalidation to isolate list behavior from this editor failure.

Native observation trees contain the same derived observations; they are an organizational surface, not a different truth resolver. Saved mental models are query-derived summaries, not a complete row store with reliable identity; earlier refresh/deletion issues also remain documented in the native-workflow evaluation. Neither was used to reintroduce the discarded portrait.

A custom whole-bank canonicalizer, semantic supersession graph, global deduplication service, or model-generated second row database would be **too much rebuilding**. None was added. If later volume/quality testing makes the one-fact native configuration impractical, revisit the list promise or native implementation boundary rather than quietly introducing those systems.

## Evidence

Under `current-list-followup/`: `frozen.json`, `run.cjs`, `results.json` and `api.jsonl` preserve the baseline/current-mission runs; `serial.cjs`, `serial-results.json` and `serial-api.jsonl` preserve the native batching runs. `presentation.cjs`, `presentation-results.json` and `mechanical-checks.json` cover the formatter, search, pinned pages, pending publication and revocation. `holdout.cjs` and `holdout-results.json` record the fresh temporal/attribution batch. `model-calls.jsonl` and server logs retain synthetic model evidence. Actual scratch restart results are in `restart-results.json`.

Eleven deterministic publication/pagination/revocation/formatter checks passed. Final persistence and cleanup status is recorded below after completion.

## Final verification and cleanup

All three successful banks preserved observation IDs/display text and effective configuration across an actual scratch API restart. The initial config comparator compared JSON key order; deep object comparison confirmed no setting changed. Eleven mechanical checks and both current-text search checks passed. Six recorded synthetic banks were deleted successfully; evidence is retained with SHA-256 hashes. No product static/build gate was run because no product code changed.

Scratch API and model proxy were stopped after cleanup. The upstream Hindsight checkout and AlfyAI product source both remained unchanged.
