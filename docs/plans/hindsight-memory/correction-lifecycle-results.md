# Fresh native correction lifecycle: exact-span editing

**Follow-up:** [Recovered lifecycle and clarified precedence](correction-recovery-results.md) completes the interrupted work and replaces the evaluator-assumed unresolved-conflict policy with the owner's latest-explicit-change rule. Preserve this report as the earlier evidence, not the current blocker status.

2026-11-18. **Ordinary selective corrections are materially more promising with a small exact-span editor, but complete correction parity is still not qualified.** Conflicting source revisions remain a semantic failure. A local model-service failure also interrupted the remaining forced-reprocessing and repeat checks. These are separate findings; neither invalidates the earlier Hindsight-versus-AlfyAI baseline.

No product/UI changes, deployment, upstream work or real-user data. Native extraction remained native throughout. All scripts/results are under [correction-lifecycle](correction-lifecycle/); [protocol](correction-lifecycle/PROTOCOL.md), [summary](correction-lifecycle/summary.json).

## Mechanism tested

Instead of asking a model to rewrite a complete fact, ask for minimal exact substring replacements on native facts. Application code verifies complete fact-ID coverage, unique matching substrings and non-overlapping edits, then preserves every untouched byte. An entire fact can be removed only if it has no unrelated information. The model still chooses the spans: exact application prevents accidental text regeneration, but does not prove that the model selected the correct scope.

The first correction starts from an actual user instruction, not a supplied gold replacement/remainder. This addresses a limitation of the previous trusted-ledger experiment. The model operates only for explicit curation/affected source replay. There is no custom extractor, all-memory property taxonomy or ordinary-turn correction pass.

Native retain used the existing mission, concise extraction and local Flash Next with retain reasoning enabled. The fast editor initially used thinking off; the paired comparison changed only that setting/output ceiling. Native PATCH/invalidation, consolidation, raw Recall and model answers were exercised. Answer context admitted only exact acknowledged raw ID/text pairs. Chunks, graph/entity expansion and derived observations were captured separately and not passed through.

Current official [retain](https://hindsight.vectorize.io/developer/api/retain) and [recall](https://hindsight.vectorize.io/developer/api/recall) docs were checked, alongside pinned local source `9fb28dbd724dc1ce4da7cb4c49008e601db76c5f` for PATCH, forced reprocessing and inline annotation assembly. The pinned runtime is the authority for this experiment.

## Fresh cases and results

Six domains were frozen before native extraction: two kayaks, personal telephone reassignment to an organisation, Hungarian siblings/cities/hobbies, two software projects, shared food restrictions, and a correction of historical residence followed by a genuine move. Two further untouched domains tested same-named dogs belonging to different people and Hungarian workshop/home addresses. Gold expectations were never passed to either extractor or editor.

| Check | Observed result |
|---|---|
| Fast editor, first six domains | 11/12 initial/changed-source text states passed; historical-city initial edit left a contradictory inline Where annotation |
| Same captured native inputs, editor reasoning enabled | All 12 ordinary text states passed; both additional third-value conflict states failed, giving 12/14 for that paired set |
| Two untouched domains with reasoning enabled | Both passed initial correction, changed-source replay and identical retry through native storage and guarded answers: 6/6 stages |
| Forced native reprocess | Kayak case passed; phone re-extraction completed but correction call failed with model-service HTTP 500; six remaining scenarios were not run |
| Repeated semantic input | One additional phone replay passed; next call failed with the same model-service error; remaining planned repeats were not run |
| Scratch API restart | All 24 acknowledged facts across seven completed banks persisted and were recalled/admitted |
| Interrupted phone bank after restart | 0/3 prior acknowledgement pairs matched; no unacknowledged new facts were admitted |
| Mechanical exact-span checks | Eight passed: unique edits, two explicit occurrences, missing/nonunique/empty spans, overlap, whole-fact deletion and unchanged text |

These are development probes with manual, non-blind grading, not independent population accuracy estimates. Do not combine successful outputs from different variants into a perfect pipeline score. The paired reasoning text comparison itself did not write those outputs back; native writeback evidence comes from the original run, untouched cases and forced-reprocess probe. No independent sub-agent grading was performed in this round.

## What failed, and why it matters

### Inline annotations are part of the fact

Native extraction assembles prose plus `When`, `Where`, `Involving` and explanatory material into one text. The initial city attempt proposed replacing `Cork`, which appeared twice. Deterministic validation rejected it before writes. One bounded syntax-location retry was then added, with the failed attempt retained. That retry produced a unique edit but changed only the sentence, leaving `Where: Cork`. The answer correctly reported the contradiction instead of silently hiding it.

Reasoning enabled changed both occurrences to Galway in the paired comparison. The untouched Hungarian workshop/home case also updated repeated address information correctly through native writeback and replay. This is encouraging, not a proof that every annotation/metadata combination will be coherent. Minor grammar such as “an purple” remained in some stored edits; grammatical cleanup was not used to hide semantic failures.

### Conflict handling still does not meet the tested policy

Two additional native compound cases changed a previously corrected property to a third value without an explicit new event. The tested policy was to withhold that disputed aspect, retain unrelated information and flag the conflict. This is an evaluation policy, not a newly approved final product contract.

Both fast and reasoning-enabled editors silently reapplied the old correction (purple/Go). Making chronology explicit improved conflict detection but still produced either the approved value or a bracketed list of contradictory values in the fact. A reasoning-enabled timeline variant exhausted all 8,192 output tokens without a usable response in two saved attempts; it was stopped rather than allowed to run through the remaining cases.

Separating conflict removal from ordinary correction did not establish reliability either. With a historical imperative instruction, one case still chose the old corrected value. Using recorded before/after accepted facts instead of that instruction removed the disputed colour but also removed explicit touring-kayak ownership from a compound ownership fact. The other independent fact said the user paddles that kayak; it does not restore the missing ownership assertion.

Exact-span editing therefore reduces rewriting risk but does not eliminate semantic scope errors. Further broad prompt sweeps are not justified by these results. No tested combination here earns a full conflict-reconciliation pass.

### Provider failure interrupted lifecycle qualification

During forced-reprocess/repeat testing, the configured local model returned `EngineCore encountered an issue` / HTTP 500. Two later minimal readiness checks returned `fetch failed`, the last at **2026-11-18 16:01:41 UTC**. The cause was not established; do not attribute it to Hindsight, the prototype, concurrency or a particular server change without logs. Production services were not restarted or modified.

The scratch Hindsight API was restarted independently. Seven completed banks retained their acknowledged results. The phone bank had already replaced its original native IDs during forced re-extraction when its correction call failed. The read guard correctly rejected the replacement facts, preventing forgotten attribution from leaking, but all three facts from that source were temporarily unavailable.

This is a real availability limitation of this in-place prototype, not a fully passing recovery design. The previously proposed immutable source-revision/publication mechanism should retain the last accepted revision while a new one is prepared; that mechanism has not been integrated and verified with this editor. Do not claim these restart checks prove crash recovery, zero interruption or a distributed publication transaction.

## Storage, recall and source boundaries

Raw source chunks still contained the original personal number/city and original corrected values after fact edits. Native entity/causal metadata was not comprehensively rewritten by this prototype. Corrected text alone does not establish complete physical erasure or safe unrestricted source/Reflect expansion.

The observed successful answers used the restricted raw-fact path. Browser/source views, other tools, export, graph-derived material and any future UI need equivalent verified boundaries. Inline text annotations also require semantic checking, as the city failure demonstrates. These are lifecycle constraints, not permission to build a second memory engine.

## Decision and exact continuation point

Keep Hindsight as the leading candidate and keep extraction native. A small exact-span curation component is worth retaining as an experimental direction. It improves ordinary corrections and addresses automatic first-edit generation more directly than the previous trusted-remainder ledger, but does not settle conflicting source revisions.

Before claiming complete correction lifecycle:

1. Restore availability of the local model through its normal operations path; this session did not change that service.
2. Reconcile the interrupted phone source, then finish forced-reprocessing and repeat checks sequentially. Keep interrupted results; do not overwrite them as if the first attempt passed.
3. Test preparation/publication against immutable source revisions so failed re-extraction cannot remove the last accepted useful facts.
4. Resolve the narrow conflict operation with explicit preservation evidence and fresh cases, without silently choosing a value, deleting unrelated facts, weakening the requirements or introducing a general extractor.
5. Verify metadata/source/read boundaries and recovery together with the chosen curation mechanism before UI work.

The `extend.cjs`, `repeats.cjs` and `stale.cjs` files are earlier prepared probes, not evidence they ran. Actual executed follow-ups are `extend-reasoning.cjs`, `repeats-reasoning.cjs` and `restart-check.cjs`. The late stale-source simulation was not run. The interrupted outputs and logs, original frozen prompts, provider transcripts, native API responses and file hashes are archived. Scratch API/proxy were shut down; the owned pg0 instance stopped with the API. Product code remained unchanged; application gates were not run for this scratch/documentation work.
