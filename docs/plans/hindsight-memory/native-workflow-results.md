# Native workflow test results — 18 November 2026

**Step 1 is complete. Native correction, retirement and source deletion work within clear boundaries; the complete local-model answer path is not yet an acceptance pass.** No product code or production service was changed.

## What was tested

Five synthetic workflows, 37 snapshots, using local Flash Next (`qwen3-6-27b` alias) for Hindsight extraction/consolidation and chat answering. No portrait, no custom source replacement ledger, no raw chunks in answer context. Recall returned native facts/observations plus supporting extracted facts. The answer model received those returned objects.

Workflows: single fact correction; single fact retirement; source deletion; a fact repeated across two sources corrected one then both; the same repeated fact removed by deleting one then both sources. Sources also contained unrelated coffee and response-style preferences. A new pottery hobby was introduced after each action.

Each workflow checked initial state, action, unrelated new message, identical source retry, process/database restart, and changed-source reprocessing. For repeated evidence, the one-source and all-known-sources states were separately recorded. After the deliberate retry test, the intended action was reapplied before restarting; this is explicit in the logs and avoids pretending a restart repaired a failed deletion. Changed-source replay then deliberately tested the native limitation again.

Expectations and hashes of the original workflow/common runner were frozen before the workflow started (`native-workflow/frozen.json`). The attribution repeats and compact representation were exploratory follow-ups, not preregistered fixes. Simulated message/query times were supplied explicitly.

## Native behavior observed

| Action | Ordinary follow-up | Identical source retry | Restart | Changed source reprocessed |
|---|---|---|---|---|
| Correct raw bicycle fact red → blue | Blue; coffee/hobby preserved | Blue preserved | Blue preserved | Red returns |
| Retire the bicycle fact | Not recalled; coffee/hobby preserved | Remains retired | Remains retired | Red returns |
| Delete source containing bicycle + coffee | Both facts removed; later hobby preserved | Source and both facts recreated | Both absent after deletion was reapplied | Source and facts recreated |
| Correct repeated fact across both known sources | Blue; unrelated preferences preserved | Blue preserved | Blue preserved | Red returns |
| Delete both sources repeating the fact | Repeated fact removed; each source's unrelated facts also removed | Both sources recreated | Both absent after deletion was reapplied | Facts recreated |

These assertions were checked against stored valid facts, invalidated records and recall data, not merely the answer text. All workflow answers completed without token truncation. The verification file records **20 assertions of observed behavior**, including expected failures/limitations; it is not a 20/20 general reliability score.

### Repeated evidence is a real user-facing issue

After editing only the first source's extracted bicycle fact, the valid store contained both blue and red. The model answered **red**. After editing the second source's fact too, the valid store and answer were blue.

After deleting only the first source, the bicycle was still remembered from the second. Deleting both removed it. The coffee preference in the first source and short-reply preference in the second disappeared too, as source-level deletion should imply.

The runner was given these two source IDs and identified the bicycle facts in a deliberately small fixture. It did not prove that the system can discover every paraphrase or safely bulk-correct arbitrary real histories. Do not turn this result into a promise of one-click universal semantic correction.

### Native curation is useful without raw source chunks

Retirement successfully kept the bicycle out of answers while retaining the coffee fact from the same original message. The earlier raw-chunk pathway repeated the retired fact from that message; omitting raw chunks avoided that particular leak here. The source remains available for deliberate evidence inspection; retirement is not physical erasure.

This does not mean raw evidence is unnecessary for all answer quality. The attribution probes below expose the tradeoff.

## Answer-quality check: remaining failure

Ten previous English/Hungarian ownership/attribution probes were answered using the existing frozen Hindsight retrieval results with raw chunks omitted. This reuses existing extracted evidence; it is not a fresh extraction-quality trial.

- Central attribution decisions: **9/10**. The model incorrectly said the user was gluten-sensitive when the facts concerned the user's client.
- Three paired repeats of that case, with a 4,096 output-token ceiling in both arms: the attribution failed **3/3 with reasoning off and 3/3 with reasoning on**. Reasoning did not fix it.
- A generic compact rendering (fact ID, text, type, mention date, source ID; no entity/scoring metadata and no duplicated supporting-fact map) fixed that client example but failed another: it asserted **no dishwasher was installed** when installation was merely unknown. Again **9/10** central decisions.

Every result is retained, including the failures. Scores concern the central decision, not every phrasing/temporal nuance. The small correlated suite was manually, non-blindly assessed; it is not a production quality estimate. A statement about an unsold car also leans too strongly on old evidence for current status, so these counts should not be read as full grounding scores.

The failing client facts themselves said the client was gluten-sensitive. A reasoning response explicitly treated the entity association between client and user as evidence of identity. That suggests metadata interpretation is contributing, but the compact representation's different failure means simply stripping metadata is not a proven solution. The original source wording disambiguates the client, yet feeding original chunks indiscriminately conflicts with the native retirement/correction contract. This tradeoff remains unresolved.

**Do not claim the proposed facts-only local-model pipeline is ready merely because storage controls passed.** Earlier successful attribution runs used other representations and do not supersede these failures.

## Smallest integration implied by the evidence

The tests support ordinary native operations, not a shadow fact store:

1. Stable source identities and delivery acknowledgements, so each eligible source is normally ingested once and an unchanged retry is identifiable.
2. A source-level removal record or equivalent delivery policy that prevents removed source IDs being resubmitted by retries/backfills. Native deletion alone cannot provide this. This is not a semantic ban on future independently stated information.
3. An explicit policy for edits to already ingested chats and future reprocessing. Native curation resets on changed content; silent reprocessing cannot coexist with a promise that manual corrections always win.
4. If a displayed remembered claim has multiple supporting facts, decide whether Correct targets one fact or a reviewed set. The API does not make a one-fact PATCH universal or atomic across multiple facts.
5. Removal wording must distinguish **retire a fact** (keep source/audit, stop ordinary recall) from **remove a source** (remove everything extracted from that source). Avoid the old ambiguous trio of Forget/Retire/Delete permanently.

These are proposed integration requirements, not implemented guarantees. In particular, user removal, in-flight jobs, queued retries and account reset still need an integrated concurrency test. The owner has not approved a semantic redaction ledger or a second permanent profile authority.

## Next action

Proceed to **Step 2: a short product contract** for correction, retirement and removal, showing the source/reprocessing tradeoff clearly. Record final retrieval/answer reliability as an open acceptance condition before implementation or a finished UI design. A native storage boundary is now concrete; the local answer-quality boundary is not.

Do not restart a broad architecture rewrite or keep tuning these ten examples until they pass. A subsequent bounded evaluation should assess a generally applicable retrieval/answer contract against held-out attribution cases and the same correction/removal checks together. Preserve the user's goal: local Flash Next must work, with minimal custom memory machinery.

## Artifacts and resumption

- `README.md`: owner decisions and action sequence.
- `native-workflow/`: runnable experiment code, frozen plan, 37 snapshots, native API and synthetic model transcripts, attribution evidence, verification and SHA-256 hashes.
- `prior-findings/`: archived previous benchmark, adoption and 37-feature inventory reports.

Hindsight source: `9fb28dbd724dc1ce4da7cb4c49008e601db76c5f`; AlfyAI baseline: `e60bb0c114c02a3063d5bf6972ddeb813cccbf6c`. Tests used isolated synthetic tenant `p04` under the evaluator's `adoption` schemas. Only the scratch API/database were restarted. Raw transcripts contain synthetic data, not production user memories. Temporary test services are stopped at completion; files remain for reproduction. No product build/test gates were required because only documentation and standalone evaluation artifacts were added.
