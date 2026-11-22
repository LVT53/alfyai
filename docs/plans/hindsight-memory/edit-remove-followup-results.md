# Bounded Edit/Remove follow-up

2026-11-18. Synthetic qualification only; no product implementation, production memory changes, migration or upstream work. Native extraction stays on the prior pinned Hindsight version/settings and configured local model alias `qwen3-6-27b`.

## Diagnosis

The old editor was asked to infer the before/after intent while performing exact span surgery across compound, duplicated native facts. Syntactic span validation could not detect omitted removals. Removing reasoning avoided the earlier token-exhaustion failure but did not fix semantic omissions. The recorded failures are preserved in `ui-qualification-run/`.

Changing only the output to complete replacement text did not solve omissions either. Separating one explicit action plan (`forget`, `replace`, `preserve`) from its application identified the requested changes more clearly, but some replacements introduced ambiguity or lost information. A model check caught some of these errors; an initially over-strict checker also rejected harmless grammar and required redundant copies of retained facts in every record. Its results are retained, not counted as a successful edit.

The final check evaluates factual meaning across the affected facts collectively. It rejects residual forgotten details, wrong attribution, invented facts and loss of retained information, without demanding perfect prose or preservation of every duplicate. This is the actual product requirement, not a relaxation allowing incorrect facts.

## Small boundary under test

1. Derive and persist one bounded action plan from the actual user-supplied before/after text. This runs only for a deliberate Edit/Remove action, not during ordinary ingestion.
2. Apply that same plan to known affected source revisions' native facts. Return native-ID/text replacements or invalidations; do not create a property ontology or extract a new personal profile.
3. Validate coverage/IDs and factual outcome before writing. Allow one repair attempt. Malformed output, timeouts or a failed final check must leave the previously accepted state active and report failure rather than success. The checker is a model, not a proof of semantic correctness.
4. Use the existing prepared-revision/publication mechanism for replay and failures. Reuse the saved action plan for an old source's new extraction; do not rediscover intent differently on each replay. Genuinely new assertions remain eligible and can establish the property again.
5. Native Hindsight still owns extraction, storage, embeddings, recall and consolidation. No global rewrite pass, duplicate-discovery engine, perpetual reconciliation or new user confirmation loop is introduced.

Usually this adds one plan call per deliberate action and an apply/check pair per affected revision batch; a failed check permits at most one additional apply/check pair. This cost belongs to explicit edits and their replays, not every chat turn. Large affected sets and paraphrases outside known provenance are not qualified here.

## Evidence and limits

`edit-remove-followup/` contains frozen prompts/cases, native API logs, local model transcripts, original failed alternatives and final runs. `offline-results.json` tests whole-text replacement against six saved English/Hungarian snapshots. `planned-results.json` adds the explicit action plan. `review-probe-results.json` preserves partial strict-review results; that probe later stopped on malformed JSON. `results.json` is the first native lifecycle with the overly strict reviewer. `final-results.json` is the revised factual-review lifecycle. Do not mix their verdicts.

Fixtures include the original Hungarian failure, fresh English and Hungarian mixed edits, and whole-memory removal from sources that also contain another person's similar possession and an unrelated hobby. The lifecycle checks edit, old-source replay, forced re-extraction and a genuinely new statement. There are no expected outputs in extractor/editor input. Expected semantics are inspected independently from the model's own pass decision.

The initial scratch lifecycles use in-place native PATCH after all edit checks finish. They are not a production transaction implementation; production must reuse immutable staging and verified publication, especially if re-extraction fails after changing native IDs. The previously tested publication boundary remains necessary. Original chats/chunks remain original evidence and must not bypass admitted-memory reads; Remove does not delete the original chat.

The synthetic answer helper initially used November 22 while new statements were dated November 23. A telescope answer consequently treated the purchase as future. This is a harness-clock mismatch, not a failed new-statement rule. Restart readback uses November 24 for all four cases; do not count the earlier future-purchase answer as current-state acceptance.

## Final outcome

**The final bounded prototype passed the four exercised Edit/Remove lifecycles.** Twelve edit/replay/reprocess states preserved the requested information and excluded the removed details. All four cases retained the newer explicit statement after an actual service restart, with native IDs/text unchanged. These are focused regressions, not a universal reliability score.

| Case | Result |
|---|---|
| Original Hungarian cat/diet failure | Removed the user's diet and Mák's colour; retained the cats and Luca's diet; changed Bodza to grey. Replay/re-extraction did not resurrect removed details. Later brown fur remained available after restart. |
| Fresh English bicycle/kayak | Removed bicycle colour, changed kayak to yellow, retained ownership/storage and brother's cycling. Later purple bicycle remained available after restart. |
| Fresh Hungarian instruments/diet | Removed user's diet and guitar colour, changed piano to brown, retained instruments and Márton's diet/location. Later white guitar remained available after restart. |
| Whole telescope memory removal | Removed user's silver telescope across repeats, retained sister's black telescope and birdwatching. Later explicit blue telescope purchase was remembered after restart. |

The final Hungarian regression used one repair across its three edit applications; the fresh Hungarian case used two. English cases needed none. Four validator controls passed: a correct proposal was accepted, and missed omission, wrong-object attribution and collateral loss were rejected. In the earlier strict run, both rejected Hungarian edits left native IDs/text exactly unchanged. See `manual-grades.json`, `safety-checks.json`, `restart-results.json` and `validation-controls-results.json`.

One answer over-interpreted vegetarian versus not-eating-meat wording as a temporal supersession; both native facts were actually preserved. This remains an answering-quality quirk, not a removal failure. Do not describe the answers as flawless.

Evidence caveat: the lifecycle harness's last `edit.accepted` array shares an array later extended with the new explicit event. Earlier recalled evidence and native post-write/API snapshots are immutable evidence of the pre-new-assertion state; use those for grading rather than treating that array as a historical snapshot. The final accepted list and restart checks are correct. A production ledger must store immutable snapshots, as already required by the publication design.

## Recommendation

Keep this as a bounded explicit-action component: saved user edit intent, application to known affected native facts, one factual check and at most one repair. No second extractor or global semantic memory engine was needed for these cases. An edit that cannot be validated must report failure and preserve the accepted revision; do not silently succeed or ask routine confirmation questions. A model validator is still fallible, and this small test set cannot establish a universal false-accept rate.

Prototype feasibility for the tested Edit/Remove cases is now established. Product implementation still needs transactional prepared revisions, authorization, replay queue integration, UI failure/retry handling and realistic latency testing. Unknown cross-chat duplicates outside affected provenance and the separate current-list/read-view issue remain outside this result. Do not claim all replacement feature parity is solved.

All eight recorded synthetic banks were deleted successfully; scratch API/proxy stopped. Evidence retained with SHA-256 hashes. Only research harnesses and handoff documents changed; no product gate was needed or run.
