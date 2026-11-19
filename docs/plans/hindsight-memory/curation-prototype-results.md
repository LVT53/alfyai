# AlfyAI-owned curation boundary — isolated prototype

2026-11-18. Owner permits maintaining an AlfyAI component and does not want upstream work. **Throwaway experiment; no product implementation, new contract or deployment.**

## Outcome

The tested version/publication boundary worked. We can keep Hindsight from reprocessing unedited original sources by giving it an effective source projection and guarding which bank generation may be read. This isolates the main source-resurrection failure without modifying Hindsight.

**The semantic editing component is not reliable enough yet.** A localized source-edit approach passed 18/24 manually graded examples (11/16 previously seen; 7/8 fresh). It still silently chose an old correction over a newly conflicting source value and lost unrelated information in other cases. A separate same-model audit was not a trustworthy safeguard.

This establishes a useful engineering boundary, not an accepted full replacement. It does not justify weakening the requirement, reverting to source-wide deletion, freezing sources, asking users to approve every memory, or shipping this scratch implementation.

## Question and prototype choices

Can AlfyAI own user edit intent and source versions, supply only eligible source text to Hindsight, and prevent stale jobs from undoing curation—without taking over search/consolidation?

The prototype has three pieces:

1. **Single-process revision ledger.** Per-user sources have stable IDs and increasing versions. Edits have idempotency IDs and snapshots of source scope. Duplicate deliveries are no-ops; older versions are rejected. New state invalidates the published revision. JSON is saved by temporary-file rename.
2. **Source projector.** An edit is applied to each pre-existing scoped source before retention. Two model approaches were compared below. Hindsight receives projected text, including for source expansion, not the unedited original.
3. **Publication gate.** A worker builds an isolated candidate bank from a revision snapshot. Only a worker matching the current revision may publish its bank pointer. Reads use only that pointer when its revision is current. While current work is incomplete, memory is withheld; chat need not stop.

These are experimental choices, not user-approved product semantics. Particularly: an edit's scope includes sources existing when the edit was made; a newly created source does not inherit the old edit automatically. Stable source IDs are therefore essential. A stale source replayed under a different ID could bypass that scope. The prototype allows genuinely new events in edited old sources, but interpreting those events is exactly where the model failed some probes.

The safest small experiment rebuilds a whole bank. That avoids observations combining edited and unedited sources, but **is not a proposed scalable implementation**. Incremental publication, consistency across old/new sources and unavailable-memory duration still need work.

## Actual native lifecycle results

Hindsight pin `9fb28dbd724dc1ce4da7cb4c49008e601db76c5f`, evaluator 1.2.1, local Flash Next alias `qwen3-6-27b`. Synthetic data only. Same existing isolated PostgreSQL evaluator; new scratch banks. No external-model fallback.

Alice had two sources repeating the red bicycle claim. One also held decaf preference, the other ownership, shed location and Berlin. A remove-colour action was followed by a source edit changing coffee to espresso and adding pottery.

| Check | Observed |
|---|---|
| Immediately after removal intent | Old published memory unavailable to the wrapper; it did not serve the old red fact while projection ran. |
| Old worker finishes after newer source edit | Candidate bank was built, but publication returned false. The old worker could not make its revision readable. |
| Current worker publishes | Both repeated colour claims removed. Stored/answered ownership, shed location, espresso and pottery remained; Berlin remained in the projected source. |
| Raw source path | Hindsight's candidate document bodies contained edited text. It could not expand to the original red text through those documents. |
| Native document reprocess | Reprocessing the active projected source kept colour unknown and preserved ownership, espresso and pottery. |
| Duplicate source delivery, stale delivery, duplicate edit | Returned duplicate, stale and duplicate respectively; current revision was not replaced. |
| Separate process reload | Loaded the same Alice/Bob bank pointers and revisions from the scratch ledger. This tests serialization/reload, not OS-crash durability or multi-process locking. |
| Second logical user with same source ID | Routed to a separate bank and retained green/tea, unaffected by Alice's edit. This is a routing check, **not a new tenant/security penetration test**: both used the evaluator's p05 API tenant. |

Four banks were built for this sequence, including the rejected stale candidate. Seven sources were retained plus one native reprocess. Candidate publication was exercised in a controlled order; no simultaneous distributed-writer correctness claim is made.

Bob's native answer knew green and tea, but unnecessarily refused to confirm ownership from “my bicycle.” His coffee preference and hobby were genuinely unknown. This illustrates that a correct projection does not solve every downstream answer-quality problem.

## Semantic experiment A: rewrite plus separate audit

Frozen 16-case suite: eight earlier cases and eight new cases. One call proposes the effective source, relation and conflicts. A second call independently audits against original/latest/action. JSON shape and conflict-list checks gate admission. No repair loop, prompt tuning or hidden retries rescued results.

Under the full requirement—including preservation of ownership and avoiding false conflict prompts—**3/16 met the complete intended outcome**. Three were blocked, and ten incorrect outcomes were accepted by the audit. One blocked Hungarian projection was actually correct: the audit returned `accept:false` while its long explanation concluded it should accept. Two other blocks caught genuinely wrong projections.

The stronger conflict instructions overcorrected: ordinary “red to blue” corrections became false conflicts merely because the old red source remained. Other failures included dropping ownership and touching a coffee preference unrelated to a phone-removal action. The separate call used the same local model; it is not independent evidence of truth. This design was not a net improvement over the simpler prior baseline.

The lifecycle's removal projection happened to succeed across both sources at its current revision. That success must not override the broader suite's failures.

## Semantic experiment B: localized exact-span patches

The alternative returns exact source substrings plus replacements. Deterministic code rejects missing, ambiguous and overlapping spans, then applies accepted patches from right to left. Everything outside the selected spans remains byte-for-byte unchanged. No second model audit is used.

That guarantees preservation **outside** the chosen spans; it cannot guarantee that the model chose the right span or preserved unrelated subclaims **inside** it.

Results:

- **11/16 previously seen cases passed.** This is exploratory reuse after inspecting experiment A, not held-out accuracy.
- **7/8 fresh cases passed.** These were frozen before running and the prompt was not modified afterward.
- Combined **18/24** is a fixture result, not a production rate. It is also not a controlled head-to-head score against A, since the fresh sets differ.

The five failures in the seen set were lost ownership, two silently resolved colour conflicts (English/Hungarian), a removed new diagnosis update, and loss of a company's reception number when only its old personal attribution should go. The fresh failure again silently chose a manual silver correction over an unexplained new white camera value. Ordinary corrections, unrelated entity/project preservation, shared Hungarian location, duplicate passages, price/use preservation and later bicycle purchase worked in the fresh set.

One successful and one failing B projection were then retained in Hindsight and queried natively. Hindsight correctly answered blue/espresso/pottery for the successful correction. For the conflicting source edit, it confidently answered blue and explicitly said the colour was **not unresolved**. The projection had already erased the conflict evidence; Hindsight cannot repair information we withheld.

Per-source model timing in this run: A median 0.85s for rewrite+audit; B median 0.35s on seen cases and 0.34s on fresh cases. These exclude Hindsight extraction/consolidation, network/service load variation and publication. They are not production latency promises.

## How much of our own system does this require?

Hindsight still owns fact extraction, embeddings, retrieval, entity/link maintenance and observation consolidation. We did not recreate those.

AlfyAI would own durable user-edit intent, source revision identity, edit scope, effective-source projection, asynchronous delivery/publication and routing every memory read through the current revision. The hard semantic piece is deciding which old claim an edit targets, what a new source revision means, and which surrounding details must survive. Hosting that piece in an extension would not remove our responsibility for it.

The prototype deliberately makes additional costs visible:

- Full-bank rebuilding amplifies writes and LLM work; stale candidates also cost work. Incremental updates would be more complex.
- Withholding all memory for a user while current work is pending is a conservative experimental guard. Availability and unrelated-memory access need an explicit production design.
- Old/candidate banks remain in the scratch database. Old claims also remain in original chat and edit scope snapshots. This is **exclusion from the permitted read path, not physical erasure**. Garbage collection, reset/export/erase and retention of edit evidence are unimplemented.
- Every actual API/tool read, source viewer and generation pointer needs authorization and revision enforcement. The demo is not an integrated proof that AlfyAI has no bypasses.
- The JSON file has no multi-process CAS, journal fsync/recovery or distributed lease. Candidate bank naming in the scratch runner is not suitable for resumed production runs.
- Scanning all existing sources resolves the two known repeated copies here, but does not prove scalable discovery across a large bank. Multiple sequential edits on the same claim, revoking an edit, concurrent users/workers, multiple languages beyond these fixtures, migration and large-bank capacity remain unqualified.
- Target/evidence metadata can itself retain removed information. A future privacy design must distinguish removal from recall from full erasure; no new promise is assumed here.

## Recommendation from the experiment

Keep the revision/publication boundary as a validated **design direction**, with its controlled-test limits. Do not adopt either tested LLM editing policy as the full solution. A second model review did not supply correctness, and localized edits alone did not resolve semantics.

The next semantic approach should reduce free-form decisions—for example, stable claim-to-source spans established at curation time and explicit overlap handling when a source changes—before adding more prompt rules. That is a candidate to investigate, not a claim already tested or a replacement contract. It must still satisfy automatic operation, preserve unrelated facts, and avoid turning every paraphrase into a user confirmation. If that cannot be made reliable with the local model, the maintenance scope is larger than an ordinary adapter.

No upstream work is needed or proposed. The owner's willingness to maintain an AlfyAI component is recorded; no product implementation is approved by this experiment.

## Artifacts and reproduction

[Interactive walkthrough](curation-prototype/walkthrough.html) is a self-contained, in-memory illustration with recorded fixtures, free-play buttons and guided stale-worker/removal/failure scenarios. It makes no live model calls. Its JavaScript was syntax-checked; no visual browser acceptance is claimed.

[Artifact directory](curation-prototype/) contains both frozen prompts and cases, raw model/API traces (compressed), manual grades, actual lifecycle outputs, scratch state and a fresh-process reload result. `span-roundtrip-results.json` contains the success/failure native roundtrip. The SHA-256 manifest covers saved artifacts. Scripts are marked throwaway and require the isolated evaluator/model bridge; they are not application modules.

Runners: `bench.cjs` (A), `span.cjs` (B seen), `fresh-span.cjs` (B fresh), `lifecycle.cjs`, `span-roundtrip.cjs`. Use fresh scratch state and bank namespaces for a rerun; the saved files show the actual run. Do not point them at production. No repository app gates were run because only authorized evaluation artifacts/docs were added; tracked product code is unchanged.
