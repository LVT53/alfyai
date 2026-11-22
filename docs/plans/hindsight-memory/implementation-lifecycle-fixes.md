# Memory lifecycle fixes

The six defects in [review-lifecycle.md](review-lifecycle.md) reproduced against the combined implementation and now have permanent regressions using migrated SQLite, the existing job engine, and synthetic model and native HTTP responses. The change keeps extraction in Hindsight and uses the existing bounded curation checker for deliberate edits, replay and source deletion repair.

## Review findings

| Finding | Application behavior and evidence |
| --- | --- |
| 1. Source deletion loses an independent child fact | Source cleanup checks the surviving replies’ original facts, original assertions and sanitized prior context against the final raw facts and observations. Missing independent bicycle information leaves the affected family held and the unrelated chess observation visible. An empty replacement succeeds when all prior meaning depended on the deleted source. Re-emission of that dependent claim is refused. |
| 2. Remove publishes a stale observation | One final collective check receives the exact display wording prepared for publication and the accepted earlier observations in the affected family. A stable native observation containing the removed kayak fails even when its only backing fact is the retained bicycle. The pending action also fences unrelated retention and publication. A later clean capture can finish the same Remove, then release the waiting delivery. The regression exercises list, recall, and both jobs. |
| 3. Edit claims success with no visible change | The same final check requires a positive visible result for the requested replacement. A purple raw fact and only a bicycle observation leave the operation retryable and the previous accepted snapshot visible. A successful Edit with a stable native observation ID produces verified history. |
| 4. Overlapping resets orphan a bank | Each destructive invocation claims a durable token with its erasure scope. Broader scopes take precedence, and retrying a reset preserves its retired epoch. Local row sweeps, reopening, and account identity deletion check the token in their SQLite transactions. Two same-scope Clear Memory requests preserve a newly admitted bank after the older invocation resumes. Separate tests cover account erasure racing either reset type and resuming an interrupted reset from another connection without duplicating opaque cleanup. |
| 5. Remove dispatches a model request after Memory off | Every planner, proposal, review and final check rechecks current controls, source or action ownership, and the claimed attempt before admission. The configured transport checks again immediately before the outbound request. Switching off while APPLY is outstanding sends no checker input and preserves the acknowledged exclusion and cleanup obligation. The preceding mid-retain/off test also passes. |
| 6. Unchanged edit-resend resurrects a removed fact | An unchanged resend uses the same lineage and assertion date, maps saved intents through the explicit predecessor, and checks the settled replacement after predecessor cleanup. A deliberate changed resend submits the qualified native delta. Its final check gets prior and current intents in order, so appended unrelated text cannot reassert an unchanged removed detail. A new blue kayak assertion succeeds with its new date while the bicycle keeps the previous date. |

## Context and export

- A bounded stored assistant question can accompany a short reply when the original user source is still current, authorized and uncurated. The resolver checks the message role, ownership, sequence and saved fingerprint. Curated sources contribute sanitized acknowledged facts, while raw questions from such sources are omitted. Fact revocation queries use the current source’s candidate IDs.
- Rebuilt descendants receive sanitized verified prior native facts and original assertion dates. A transitive fixture extracts a short surviving reply using its repaired parent’s verified bicycle fact and omits the deleted root’s original context.
- Owner archive coverage now runs an actual Edit through publication and refresh, prunes its delivery job and exports with Memory off. Revoking its source removes the exported row and associated edit. The archive fixture also proves that a succeeded job with no accepted action outcome grants no history.

## Verification and recovery

The original six synthetic review probes reproduced the defects. Inverted permanent tests failed before the changes. Additional red cases proved that an unrelated delivery could publish a refused candidate, that an accepted prior source dropped the question needed by a short reply, and that a changed resend lacked the earlier removal intent. The updated fixtures now exercise those boundaries through native HTTP stubs and the real job engine.

A final check can fail before atomic publication. The previous accepted view remains authoritative subject to live revocation. A retryable Remove or Edit can verify the same saved proposal against a corrected settled candidate. One final check also covers any rebuilt descendants and their replayed intents.

Turning Memory off records a dirty Edit as rejected and saves its repair checkpoint before the engine cancels the attempt. Privacy cleanup can delete the staged delta while Memory is off. On enable, the existing job restores the previously accepted raw IDs and text, deletes the staged delta and rebuilds any dropped descendants against the restored parent. It checks the settled visible result before releasing the publication hold. The operation ends with `memory_edit_cancelled` and creates no explicit edit history. The process is idempotent after a lost restore response and preserves original dates. If native no longer recognizes a previously accepted raw ID, the operation remains held with a retryable recovery failure. No local code invents a new raw identity.

The latest focused run passed **222 tests across 15 suites** at `/tmp/hindsight-lifecycle-with-rollback.log`. The three compensation regressions passed at `/tmp/hindsight-compensate-green3.log`. `npm run check` reported 0 errors and 0 warnings at `/tmp/hindsight-lifecycle-rollback-final-typecheck.log`. The migration verifier and scoped Biome checks passed.

Official Drizzle transaction and SELECT docs and the Vitest test API docs were consulted. Local verification uses Node 22. An independent lifecycle judge and pinned native EN/HU acceptance remain required for identity drift, semantic accuracy, recall/answer grading, rejected work recovery, overlapping physical deletes, and restart behavior.

- [Drizzle transactions](https://orm.drizzle.team/docs/transactions)
- [Drizzle SELECT](https://orm.drizzle.team/docs/select)
- [Vitest test API](https://vitest.dev/api/test)

## Fallow and module ownership

The pinned Fallow 3.33.1 step failed at this shared-checkout snapshot with 203 findings, 201 new findings and 20 cycles. Two of the four baseline cycles remain. The 18 new paths below are relative to `src/lib/server/services/memory-profile/` except `memory-controls.ts`, which lives in the parent services directory. Every path closes from its last module to its first. The report is `/tmp/hindsight-lifecycle-fallow-final/fallow.json`. The baseline was kept intact.

- `memory-controls.ts` → `delivery-job.ts` → `delivery-runner.ts` → `curation-runner.ts` → `curation-actions.ts`
- `curation-actions.ts` → `delivery-job.ts` → `delivery-runner.ts` → `curation-runner.ts`
- `curation-actions.ts` → `dependency-repair.ts` → `delivery-job.ts` → `delivery-runner.ts` → `curation-runner.ts`
- `curation-runner.ts` → `dependency-repair.ts` → `delivery-job.ts` → `delivery-runner.ts`
- `curation-runner.ts` → `revisions.ts` → `dependency-repair.ts` → `delivery-job.ts` → `delivery-runner.ts`
- `curation-runner.ts` → `revisions.ts` → `migration-policy.ts` → `delivery-job.ts` → `delivery-runner.ts`
- `delivery-job.ts` → `delivery-runner.ts` → `dependency-repair.ts`
- `delivery-job.ts` → `delivery-runner.ts` → `dependency-repair.ts` → `revisions.ts` → `migration-policy.ts`
- `delivery-job.ts` → `delivery-runner.ts` → `migration.ts`
- `delivery-job.ts` → `delivery-runner.ts` → `migration.ts` → `revisions.ts` → `dependency-repair.ts`
- `delivery-job.ts` → `delivery-runner.ts` → `migration.ts` → `revisions.ts` → `migration-policy.ts`
- `delivery-job.ts` → `delivery-runner.ts` → `publication.ts` → `revisions.ts` → `dependency-repair.ts`
- `delivery-job.ts` → `delivery-runner.ts` → `revisions.ts` → `dependency-repair.ts`
- `delivery-job.ts` → `delivery-runner.ts` → `revisions.ts` → `migration-policy.ts`
- `dependency-repair.ts` → `revisions.ts`
- `dependency-repair.ts` → `revisions.ts` → `migration-policy.ts`
- `migration-policy.ts` → `migration.ts` → `revisions.ts`
- `migration-policy.ts` → `revisions.ts`

Ownership proposal for the architecture cleanup

1. Move the stored curation intent codec out of the action-admission module. Action admission owns user request validation and atomic job creation. The worker reads and writes the intent without importing the admission service.
2. Let the dependency planner own bounded synchronous discovery and hold preparation. It should consume database rows and data-only boundaries. Keep native repair execution and resumption at the existing worker and job/control boundary. Invert callbacks where that keeps the repair executor independent of job registration. This also breaks the source-revocation and repair back edge.
3. Separate history eligibility reads and manifest progress from migration policy controls and the migration coordinator. Worker and revision reads depend on eligibility and manifest state. The coordinator owns enqueue, preparation and authority transitions.
4. Keep the existing attempt engine as the only lifecycle writer. Drill down from its memory job handler into delivery and curation without importing the same registered kind back through the worker graph.

The report also finds standalone synthetic evidence programs. Declare intentional entry points individually where appropriate. Keep broad exclusions and baseline changes out of the repair.

## Second lifecycle re-review

The five independent reproductions in [the re-review](review-lifecycle-fixed.md) all reproduced before the changes. The four curation defects now have permanent tests, and the engine has separate compile-time and runtime checks for asynchronous checkpoint preparation.

| Finding | Implementation and regression |
| --- | --- |
| Terminal dirty Edit | The same attempt durably records rejected compensation when a terminal error follows the native mutation marker. It restores and verifies the accepted facts, cancels the staged delta, and preserves the original error verdict. The regression invalidates an original fact, forces post-PATCH readback failure, verifies the original fact was restored, and publishes an unrelated Add without losing it. |
| Observation ID or support drift | The final bounded check includes new and changed display rows and previously accepted rows removed by the candidate. It compares prepared display text, native text and exact supporting fingerprints to the prior accepted generation. The regression places stale kayak wording on a new chess-backed observation and verifies that the Remove stays pending while the safe view remains visible. |
| Source deletion during compensation | Rollback honors owner and scope revocation, restores authorized survivors, and verifies the withdrawn source is absent from the native candidate. It releases the hold only after verification. The regression cancels an Edit, runs production source revocation and cleanup, enables Memory, and publishes an unrelated Add without restoring the deleted original. |
| Unchanged resend after a changed revision | A bounded owner/bank/epoch/lineage walk supplies predecessor intents. Native receives an explicit replay frame containing only previously accepted facts. The candidate must preserve those facts before deleting the predecessor, and unsupported new raw claims are rejected from the replacement. The final display check receives the earlier ordered intents and the accepted prior facts. The original chat quotation stays in its source revision. The tests preserve a chess append and a newer deliberate kayak reassertion at their original edit date, and hold a lossy replay before deleting its predecessor. |
| Checkpoint callback | The callback return is typed as JSON data. The ledger rejects explicit async functions before invoking them and observes accidental returned promise rejections before refusing their transaction. The production checkpoint callback remains synchronous. The engine tests include two compile-time negative controls. |

The checker inspects a bounded display diff over the already captured bank snapshots. It runs no semantic discovery across unchanged unrelated rows. Physical rollback requires native support for reactivating existing raw identities. Exact unchanged replay remains held if native omits or rewrites an accepted fact. Pinned native validation of these recovery paths and English/Hungarian wording remains pending.

The targeted run used Node 22. The review probes reproduced in `/tmp/hindsight-lifecycle-second-review-original.log`. The promoted regression results are in `/tmp/hindsight-lifecycle-second-regressions.log`. The broader focused run passed **264 tests across 16 suites** at `/tmp/hindsight-lifecycle-second-final-verified.log`. Scoped Biome, the migration verifier and `git diff --check` passed. Typecheck reported **0 errors and 0 warnings** at `/tmp/hindsight-lifecycle-second-typecheck-final.log`.

The current pinned Fallow 3.33.1 result has one existing baseline cycle. The remaining 182 findings are 177 untracked evidence files and five scratch imports in the research evidence tree. There are no new application findings in that snapshot. The comparator remains red at `/tmp/hindsight-lifecycle-second-fallow/summary.txt` and the baseline remains intact.

Drizzle transaction and SELECT APIs and Vitest mock behavior were checked for this pass. [Drizzle transactions](https://orm.drizzle.team/docs/transactions) · [Drizzle SELECT](https://orm.drizzle.team/docs/select) · [Vitest mock API](https://vitest.dev/api/vi.html)

## Accepted-empty replay and combined withdrawal

The two follow-up reproductions in [the independent review](review-lifecycle-fixed.md#follow-up-review-of-the-fixes) passed their assertions of the old behavior. Seven permanent cases now exercise their replacements through the existing job engine and migrated synthetic SQLite.

- Exact resends separate a never-submitted assertion from an accepted empty inventory. The first native retain of an unsubmitted, uncurated predecessor sends the still-current assertion with its original assertion date and live resolved context. An expand-only migration adds a nullable accepted-generation receipt on the source row. Atomic publication stamps and refreshes the receipt for admitted sources in that bank and epoch. An accepted empty predecessor can be recognized with its job pruned. The current or previous accepted generation supplies receipt authority. A wrong-generation or otherwise ambiguous submitted predecessor stays held.
- Cancelled Edit compensation now supplies each surviving reply’s original source identity, authorized assertion and sanitized prior context when a newer deletion withdraws support. The checker can accept disappearance of a wholly dependent reply and must retain an independently supported statement from the same reply. The withdrawn root’s wording is omitted from the before/after prompt fields. The operation remains rejected after successful compensation.
- The overlapping source cleanup can finish physical deletion first and defer reconstruction to the pending compensation. After verification and atomic publication, cleanup uses the accepted replacement’s scoped receipt and exact recorded withdrawal. The stale submitted copy is coalesced only after native absence and a matching accepted successor are verified. Both claim orders settle without rebuilding the accepted replacement again.

The final Node 22 focused run passed **273 tests across 16 suites** at `/tmp/hindsight-lifecycle-followup-final-tests.log`. The independent old behavior is recorded in `/tmp/hindsight-lifecycle-followup-original.log`. The migration verifier, scoped Biome and `git diff --check` passed. Typecheck reported **0 errors and 0 warnings** at `/tmp/hindsight-lifecycle-followup-typecheck.log`. Pinned Fallow reports one matching baseline cycle and 184 research-evidence findings in `/tmp/hindsight-lifecycle-followup-fallow-final/summary.txt`.

The retained-generation receipt fence intentionally holds a revoked source when its accepted generation has aged out and the current published evidence cannot establish a prior accepted inventory. Native English/Hungarian acceptance, including exact empty replays and combined recovery, and fresh independent lifecycle verification remain separate.

## Withdrawal of a checkpointed dependent

The [receipt and withdrawal review](review-lifecycle-fixed.md#receipt-and-withdrawal-review) found that enable refused to reopen an Edit recovery when the user withdrew a saved dependent while Memory was off. The two permanent variants first failed with the cleanup hold still active and with the surviving reply never reaching verification. The red run is at `/tmp/hindsight-revoked-dependent-red.log`.

- The resume gate recognizes deletion authority only when the same owner, bank and epoch contain an exact source revocation. An unaccepted repair copy can inherit that authority through its matching predecessor, lineage, message and text fingerprint. Authorized steps still pass the current-source and held-state checks, and their staged copies are rebound to current controls.
- Recovery settles any submitted old and staged native documents for a withdrawn step through the document delete endpoint, including documents that extracted zero facts. It verifies absence before checkpointing progress. The withdrawn assertion and its context are omitted from re-retain and final review. The same scoped withdrawal is checked before publication.
- When both the root and the saved child are withdrawn, the operation settles without another model check after the remaining inventory and displayed observations are empty. When an authorized reply also depends on the withdrawn child, the verifier gets that reply's original assertion and sanitized context and preserves its independently supported bicycle fact. A cleanup job claimed first leaves reconstruction to the pending Edit recovery. Both cleanup jobs settle, the original Edit stays failed and clears its hold, and an unrelated chess Add becomes visible.

The Node 22 run passed **298 tests across 27 suites**, with one opt-in native smoke skipped, at `/tmp/hindsight-revoked-dependent-final-vitest.log`. The dependency suite passed **25/25**. Typecheck reported **0 errors and 0 warnings**. Scoped Biome, migrations and `git diff --check` passed. Fallow 3.33.1 found one matching baseline cycle and 186 findings in research evidence files. The checkout's gate remains red on those findings. The report is at `/tmp/hindsight-revoked-dependent-final-fallow/fallow.json`.

These assertions use migrated synthetic SQLite, the production job engine, and a stubbed native transport and checker. Actual native semantic and erasure acceptance and targeted independent closure are tracked separately.

## Shared Edit targets and carried chat facts

Two failures surfaced in the live synthetic lifecycle run. In the cancelled Edit trace, the pottery observation had native support from both the deleted root and the surviving dependent reply. Both were direct Edit targets. After a native PATCH and deletion while Memory was off, the reply was held for repair and compensation rejected it before checking the independent seed-library assertion. The read-only checkpoints are in `/tmp/alfyai-lifecycle-acceptance/accurate/cancel.json` and `cancel.db`. The Hungarian replay trace at `/tmp/alfyai-lifecycle-acceptance/accurate/hu.json` also recorded a Remove failing before its first model call because one accepted source still carried native facts from a deleted edit-resend message.

- Compensation now distinguishes direct PATCH restoration from reconstruction of a held direct target. A held target must have a current accepted-generation receipt and live source permission. The bounded dependency plan must find it through exact stored provenance from an explicitly withdrawn target. Recovery rebuilds from the surviving assertion and sanitized context, with the prior facts available to verify preservation. Existing checkpoint identities and topological ordering are preserved when the plan adds the held target. The original cancelled Edit stays failed. Permanent tests cover a surviving independent fact, rejected loss of that fact, and expansion of a plan with an already checkpointed descendant.
- Curation accepts a carried source solely for an accepted current-generation native revision backed by a durable successful source-edit receipt and a unique live, fingerprint-checked descendant in the same owned scope. A missing receipt or changed current message blocks native PATCH. Ingestion and dependency re-retain still use the strict original-message fence. The unavailable historical message remains an unavailable quotation. Plain deletion of the current message atomically withdraws carried predecessors and schedules immediate cleanup independently of the earlier edit-resend's deferred cleanup request.

The red runs are at `/tmp/hindsight-shared-target-red.log` and `/tmp/hindsight-carry-red.log`. The tests exercise migrated synthetic SQLite and the production job engine with native and checker stubs. Live recovery of the captured failures is tracked by the native lifecycle run.

### Durable retry and native checker evidence

An exhausted recovery attempt clears its engine checkpoint. The recovery plan now commits into the rejected Edit's existing intent in the same transaction as each checkpoint. An older interrupted attempt can leave a quarantined replacement with only its persisted job-derived event identity. Recovery verifies the owner, bank, epoch, exact predecessor, lineage, message and text fingerprint before reuse. It settles and deletes the old native submission, verifies its absence and allocates a fresh operation identity for that same document. Regression tests exercise a terminal engine failure followed by a normal retry with the rejected Edit's saved plan and with the older durable source record alone.

Withdrawal verification receives the precise withdrawn context IDs for each surviving reply. Its instructions use the reply and authorized context to test support and use the previously accepted inventory for comparison. Both captured persisted dirty cancellations settled through the real native and app paths after these changes. The seed-library assertion and independent paper-map preference retained their original dates, the schedule stayed absent, the cancelled Edit stayed failed, and an unrelated Add applied.

The thinking-off checker replay is still a release blocker. Both correct candidates were accepted, and both negative controls were also accepted, one that removed the independently asserted seed-library fact and one that restored the withdrawn schedule. The four outcomes are in `/tmp/hindsight-withdrawal-checker-native.log`. Automatic approval review declined the initial thinking-on request because the captured log payloads would pass through a bridge to a remote host. The subsequent request was approved for four verified synthetic snapshots with the same prompt, payload and schema.

The paired local Flash Next check accepted both correct candidates and rejected both negative controls. The diagnostic enabled top-level and template thinking for the same four requests, with the existing 8,192-token cap. All four responses ended normally, with 3,529 to 7,510 reasoning tokens. The detailed responses are in `/tmp/hindsight-withdrawal-checker-thinking.log`.

The existing final checker now enables thinking only when verifying surviving replies after a withdrawal. It keeps the configured private provider, one structured request, the 8,192-token ceiling and the 180-second application and gateway deadlines. The job heartbeat continues every 15 seconds under its 120-second stale-attempt window. A length-limited response cannot apply even when its text parses, and schema refusal makes no compatibility request on this path. The existing bounded job retry may report a pending recovery. Ordinary curation requests retain their current settings.

The frozen requests took 0.224–0.240 seconds with thinking off and 20.70–47.34 seconds with thinking on. Six additional synthetic local-model cases scored **6/6**. The English and Hungarian fixtures each accepted an independently supported survivor, rejected its loss, and rejected the return of withdrawn context. All six completed normally in 8.48–28.07 seconds, with 1,405–4,401 reasoning tokens. The new cases are recorded at `/tmp/hindsight-withdrawal-fresh-diagnostic.log`.

The focused Node 22 run passed **382 tests across 28 suites**, with one opt-in native smoke skipped. The final dependency suite passed **30/30**. Typecheck had **0 errors and 0 warnings**. Biome and `git diff --check` passed. The pinned Fallow gate still reports one matching baseline cycle and 186 research-file findings at `/tmp/hindsight-withdrawal-retry-fallow/fallow.json`.

### Exact resends preserve accepted native document ownership

A fresh native exact resend regenerated an accepted fact with a different attribution annotation. The app correctly refused the altered raw fingerprint, but the original message was already gone and its valid independent facts became unavailable. The exact-resend path now verifies the prior native document inventory and supporting accepted display without submitting the same assertion for extraction. A successful exact resend publishes the live successor with its existing scoped native owners in the same transaction. An eligible source that has never been admitted still retains from its live assertion once and at its original date. An ambiguous or missing native inventory stays held.

The logical successor supplies authorized facts from its proven physical owners to dependent turns and later changed edits. Current or previous generation receipts, exact owner and scope, and the trusted edit-resend withdrawal event fence the reuse. Physical owner pointers remain internal. A newer changed assertion can update the existing physical scope while independent facts retain their original dates. Explicit accepted correction documents are authorized by their exact lineage and remain independently authored if the chat message is deleted.

The original deleted quotation stays unavailable. Ordinary deletion withdraws the physical chat ancestors and schedules direct cleanup, and their old message IDs cannot authorize a later resend. A completed resend consumes its predecessor's transition in the publication transaction. A later edit request cannot give an ordinarily withdrawn source a new transition, even before the message row is deleted. The durable accepted-empty receipt still works after job pruning.

The ten-case source admission suite and the 15-case transition slice passed under Node 22. Permanent regressions cover zero retains for an accepted resend, new extraction for a never-submitted source, missing and ambiguous inventory, dependent context, a subsequent changed edit and both fact dates, competing resends, old-message replay refusal, physical document cleanup, and manual corrections saved before or after the exact resend. The logs are at `/tmp/hindsight-exact-carry-extended.log` and `/tmp/hindsight-exact-carry-transition-tests.log`. Typecheck passed, and pinned Fallow still reports the one baseline cycle and 186 evidence-file findings. The fresh complete native exact-resend and subsequent-change workload remains under independent verification.
