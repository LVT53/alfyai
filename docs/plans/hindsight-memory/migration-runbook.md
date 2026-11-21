# Per-user Memory replacement migration

Implementation and rehearsal use synthetic data. The owner conditionally authorized the root agent to begin per-user `inspect`, `prepare`, and `verify` for real inactive banks if all implementation, acceptance tests, and final independent review finish before **05:00 Europe/Dublin on 19 November 2026**. If readiness misses the deadline, defer real preparation. Authorization ends at inactive-bank verification. Deployment and authority cutover require separate authorization. Individual workers continue with synthetic data unless the root agent explicitly assigns eligible work.

Keep existing Do Not Remember and history-consent decisions and every exclusion in force. Unknown historical eligibility requires that user's explicit opt-in.

Use Node 22. The single entrypoint is `scripts/memory-backfill.ts`. It requires an explicit database and user, defaults to `inspect`, and prints counts/checkpoint IDs only. The restricted `memory_migration_manifests` rows contain the detailed inventory and original text; do not paste them into logs or reports. Account privacy erasure owns these records alongside other memory state.

## Modes and safeguards

- `inspect`: read-only application inventory; no source/job/account rows created and no model calls. Counts eligible, uncertain, excluded and held sources, authored/endorsed actions and exceptions. The SQLite connection uses normal database WAL settings; inventory does not mutate application records.
- `prepare`: snapshot the original chats/actions/privacy state, create inactive banks, and enqueue the existing Memory delivery jobs. Repeating it resumes stable source/operation IDs and catches changes. It does not activate native reads. The configured existing worker must run to drain jobs; no second scheduler exists.
- `verify --manifest ID`: compare the current source/action/privacy fingerprint with the snapshot and inspect current checkpoint jobs, outstanding cleanup and source acceptance. A failed superseded retain stays in the job ledger. A failed required delivery or cleanup blocks readiness and appears in the failed count. Repeating prepare retries required retryable delivery with the same engine job and native operation identity.
- `cutover --manifest ID`: refuse changed/incomplete snapshots and unconfigured native banks. In one SQLite write transaction, verify the checkpoint and switch the user's reader/writer authority. The legacy projection mutation boundary rejects late old workers after this point. Preparing accounts keep the legacy reader; there is no blended profile.
- `rollback --manifest ID`: restore legacy authority only within the recorded 30-day window and only when the complete privacy/source/action checkpoint still matches. Any post-cutover removal, reset, choice, source change or other nonrepresentable state leaves memory unavailable (`rollback_blocked`) rather than resurrecting old information.

Mutating real-mode commands require `--execute yes --operator-ack approved-per-user-migration`. These are deliberate operator safeguards, not authorization on behalf of the user. `prepare` must respect that particular user's history choice; current-enabled does not grant historical permission. `verify` cannot substitute for the semantic/isolation acceptance report.

Command shape (placeholders, not executed):

```sh
node --import tsx scripts/memory-backfill.ts --database /explicit/database.db --user USER_ID
node --import tsx scripts/memory-backfill.ts --mode prepare --database /explicit/database.db --user USER_ID --execute yes --operator-ack approved-per-user-migration
node --import tsx scripts/memory-backfill.ts --mode verify --database /explicit/database.db --user USER_ID --manifest MANIFEST_ID
```

Use the same explicit acknowledgement for cutover/rollback. Never use an implicit default database or all-user target.

## Eligibility and live changes

Unknown historical on/off periods remain out of native requests until the user explicitly includes them, with a fixed cutoff/version. Known off intervals, incognito, deleted sources and pre-reset statements remain excluded. The optional choice is available while preparing and after cutover; native functionality can activate with uncertain history still held. Including/declining later resumes the existing manifest. Source permissions are checked again at native dispatch/publication, and withdrawal revokes queued historical sources before acknowledgement.

Known removed statements are mapped using explicit source/item/provenance IDs, including review-only do-not-remember records. A saved bounded action is applied by shared native curation before publication and replayed on retry, preserving unrelated facts. Generated endorsed profile text is audit intent, never native source material. Verified authored standalone statements retain their own scope and action date. A current legacy review replacement supplies that authored statement once. If the person removes it, the correction stays in restricted audit records and the bounded exclusion of the original statement still applies. Automatic review closure preserves its recorded reason. Where the old pre-edit statement or action date is unavailable, the affected source is held explicitly rather than inventing a correction. An unknown exclusion boundary holds historical backfill for that user; new eligible memory remains independent. Under that hold, an older review-only edit with no linked replacement needs an exact active and unexpired item in the same current scope and reset generation before it can carry over. If that support is absent, pre-cutover verification rejects the previous checkpoint and repeating prepare reconciles any previously staged source through the normal cleanup jobs. A later genuinely new assertion is not a permanent topic ban.

Preparation captures a full content/action/control fingerprint. Repeat preparation to catch persisted chat edits/deletes, new chats and legacy choices. Same-ID text changes without a trustworthy original edit event are reported as exceptions; import time is never asserted as the edit date. During final cutover, SQLite's write transaction is the brief ingestion barrier: source/action changes serialized before the switch invalidate verification, and later live turns use native authority. Native late results remain subject to epoch/source/control fences.

## Per-user quality comparison

For each authorized migration, record the legacy Memory baseline before cutover and repeat the benchmark against replacement Memory after cutover. Use the same questions, expected evidence and scoring criteria for that user. Check factual recall, currentness, attribution and correct omission. Blind the scorer to the Memory implementation and report gains, regressions, inconclusive cases and sample size per user. An aggregate can supplement the individual results.

Keep each benchmark within that user's authorized personal and project scopes. Apply their consent and every source exclusion to both runs. Omit any case that becomes ineligible between runs and record the count and reason. Keep raw evidence in restricted, user-scoped storage and use no data from other users. This procedure requires authorization before it is run on real accounts.

## Synthetic rehearsal

Use only an isolated migrated SQLite fixture in the system temporary directory, with a `.alfyai-memory-synthetic` marker containing `alfyai-memory-synthetic-v1` beside it, and only `@test.invalid` accounts. Pass `--synthetic-fixture yes`. Synthetic mode bypasses the production operator acknowledgement, never the source/consent/epoch/cutover checks. Real-mode flag parsing and execution are also tested against a temporary synthetic database, never a real account database.

`migration.integration.test.ts` runs actual SQLite migrations and the existing job engine. Its native HTTP and curation fixtures are deterministic and explicitly do **not** prove native semantic accuracy. Real pinned-native EN/HU acceptance, throughput, backup/restore and independent review remain separate full-replacement gates.

## Rollback retention

Retain permitted legacy data for at most the 30-day rollback window recorded at cutover, subject to normal user erasure/deletion immediately. No automatic purge is implemented or authorized by this tooling. At expiry, an operator must review the retention/acceptance record and explicitly authorize disposal or document a bounded extension; this is not permission for indefinite retention. Do not restore a backup without preserving newer reset/revocation/control records. A blocked rollback requires resolution of the newer privacy state; it must not be bypassed by changing `authority` manually.

## New-account rollout

`HINDSIGHT_NEW_ACCOUNTS_ENABLED` defaults false and is separate from worker pause. With an authorized rollout configuration, only genuine new account creation receives native authority and an opaque tenant/known interval atomically. Existing accounts are unchanged. A missing/offline native service leaves the new account native and unavailable/pending; account creation itself performs no network request and never silently falls back to legacy. Use the normal application environment/configuration when invoking the CLI; it does not choose an implicit database or grant historical permission.

## Owner-approved review of a held cohort

The optional review worker defaults off. It requires the server-side `HINDSIGHT_QUARANTINE_ENABLED` flag and the pinned native dry-run extraction capability. The historical Include decision alone starts no review. A separately authorized operator identifies a fixed prepared manifest and verifies the exact owner identity, consent cutoff and canonical sorted held-source ID digest before granting access. The grant requires `--mode authorize-review --manifest ID --authorization-file FILE` alongside the existing per-user execution acknowledgement. The absolute owner-private file contains `userId`, `email`, `manifestId`, `cutoff`, `cohortHash`, `cohortCount`, the exact serialized `manifestHash`, a reviewed `deniedSourceIds` array and the resulting `allowedCohortHash`. Both cohort hashes are SHA-256 of the JSON-encoded sorted IDs. Prepare the receipt from the named, reviewed cohort. Keep it and any evidence off public logs and out of source control.

The owner can then explicitly start review. Only the exact currently eligible authored source goes through pinned dry-run extraction, with no preceding chat context. Known linked withdrawals, revisions requiring native curation replay, explicit known excluded wording, and changed source, project or consent checks hold the source before dispatch. Native dry-run does not retain facts, create embeddings, or publish Memory. SQLite drafts are accessible only through the owner's review API. Any explicit Keep or Edit and keep is a new owner-authored assertion in its original scope, dated at approval. The original source assertion date remains provenance. During preparation the approved action goes to the inactive native target and becomes available to chats after cutover. Discard stores a content-free decision. Restore holds, rollbacks, Clear Memory, Clear Workspace and account erasure remove the review grant and its drafts. Chat ownership and scope moves scrub affected draft content and detach obsolete approval provenance. The ordinary account archive excludes the grant and pending drafts.

Known text matching is conservative and cannot establish the semantic equivalence of unidentified or paraphrased historical material. Confirm the scope of consent for processing the held cohort before enabling it. Keep all withheld sources whose known exclusion cannot be resolved before inference outside that reviewed grant.

### Recover completed retains in an inactive bank

If several completed retains are present in the same inactive bank, a source job can fail publication because other sources in that snapshot have yet to be admitted. Keep the account in Preparing under legacy authority. Stop its scoped worker between completed attempts, preserve the SQLite and native backup, and verify the target account, current manifest and bank. The global Memory worker and new-account enrollment must be paused. No other operator may write that bank while the recovery runs.

```bash
node --import tsx scripts/memory-backfill.ts --mode recover-retained \
  --database /explicit/database.db --user USER_ID --manifest MANIFEST_ID \
  --bank BANK_ID --execute yes --operator-ack approved-per-user-migration
```

This operation reads the native bank without retaining any source again. It requires settled native operations and an unchanged manifest, and checks the current eligibility, scope and withdrawal state of every recovered source. Any unknown raw or observation support, or any change to the text or support of a previously published observation, blocks publication. Preserve the legacy serving state in that case.

The recovered sources enter one application generation. Failed checkpoint jobs are reopened through the job engine, which verifies their admitted native facts before completing them. Drain only the exact account's jobs. Run normal migration verification and scope recall checks before completing cutover. A successful recovery command alone does not make the account ready.

If an earlier attempt changed a previously approved observation, first establish the exact unpublished contributing source revisions in that bank. Use a protected operator receipt containing the account, manifest, bank, current manifest SHA-256 and exact contributor source IDs. `rewind-unpublished` requires that receipt through `--authorization-file`, in addition to the same explicit account, database, manifest, bank and execution arguments. Pause the account's worker and preserve a paired backup before starting.

The command invalidates only the old, unpublished source revisions. It removes those exact native documents and verifies that all existing published wording, support and dates return, allowing a regenerated native ID only when the full match is unique. All original eligible sources remain in the ordinary migration inventory and may be retained again with new immutable operation IDs. During this operation, the bank's new delivery is fenced by its manifest. If the operation is interrupted, rerun the same scoped command with the same receipt. If a user withdraws a source in the interim, verify the current controls and prioritize the canonical privacy cleanup. The rewind cannot authorize the changed observation or cut the account over.

A protected receipt may specify `holdCorrectionConflict: true` for an older source whose native facts changed the wording of a later authenticated authored observation in the same bank. This requires a strict date order, original scope, and complete raw support proof. A source with an independent native fact or observation cannot be held through this path. The resulting `held_conflict_with_later_correction` disposition is scoped to that original message, body hash, assertion date and scope. It records why the source could not be migrated safely. The original conversation remains available through ordinary authorized chat history, and the hold does not resolve any user review or record successful delivery.

During preparation, older ordinary history may corroborate a generated observation of a plain authored statement without an operator step, but only while the observation's published support is the statement's own facts. The observation must keep its native ID, wording, display and facts. Each fact the job adds must come from that job's own default-history chat, which must be older than the statement, and must also support an ordinary observation of its own. Exact pinned edits, their exact-wording companions, explicit edits and statements tied to an edit or removal stay exact. The row is published with its native support, so the Memory page lists the older chat as a second source and shows no single date, and removing either memory hides both until Memory rebuilds them. A row that already carries chat evidence stays exact, so a second corroboration or a dropped link fails closed for an operator. If a corroborating chat is withdrawn during preparation while another row still presents the statement, the source cleanup cannot prove an exact restore, and later history fails closed until an operator settles it. The owner chose this on 21 November 2026.

A plain rewind may accept one regenerated ordinary observation if exactly one otherwise-unmatched native successor has the complete original support set and unchanged raw wording and mention dates, with those facts also covered by an independently exact prior observation. The publisher also checks the original assertion dates. All other previously published observations, including every protected one, must still match exactly. The tool holds on missing evidence, multiple possible successors, or regeneration of protected wording.
