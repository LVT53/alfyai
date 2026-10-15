-- Document extraction moves onto the job engine (docs/plans/jobs-merge, slice S3).
--
-- This is the one migration of the run that REWRITES DATA. The engine speaks five
-- status words (queued, running, succeeded, failed, cancelled); the extraction
-- ledger spoke eight (queued, uploading, parsing, downloading, indexing,
-- succeeded, failed, canceled), and its outage counter rode inside `hints_json`
-- under a reserved `$outage` key. The rewrite is here and not in code because
-- `db:prepare` stays the real migration path; the same statements are re-applied,
-- idempotently, at every start by `normalizeExtractionLifecycleWords` in
-- `src/lib/server/db/compat.ts`, because `db:prepare` runs while the previous
-- release keeps serving and claiming for up to two minutes, and it writes the old
-- words. Everything else here is expand-only: two nullable columns and an index.
--
-- The previous release's rollback is `docs/plans/jobs-merge/rollback-extraction.sql`.

-- The engine's progress phase: the word an active status used to be. NULL for a
-- job that is not running; a settled job keeps the phase it ended in.
ALTER TABLE `document_extraction_jobs` ADD `phase` text;
--> statement-breakpoint
-- The retry policy's own memory (JSON): `{ "since": <epoch ms | null>, "waits": <n> }`,
-- what used to live under `hints_json.$outage`.
ALTER TABLE `document_extraction_jobs` ADD `retry_state_json` text;
--> statement-breakpoint
-- The four active words become `running`, the word moves to `phase`. All the
-- right-hand sides are read before any assignment is made, so `phase` gets the OLD
-- status. The attempts already spell their `phase` with the same four words.
UPDATE `document_extraction_jobs` SET `phase` = `status`, `status` = 'running' WHERE `status` IN ('uploading', 'parsing', 'downloading', 'indexing');
--> statement-breakpoint
-- `canceled` (one l) becomes the engine's `cancelled`, on jobs and on attempts. A
-- cancelled attempt's `error_code` is a historical string and is left as it is.
UPDATE `document_extraction_jobs` SET `status` = 'cancelled' WHERE `status` = 'canceled';
--> statement-breakpoint
UPDATE `document_extraction_job_attempts` SET `status` = 'cancelled' WHERE `status` = 'canceled';
--> statement-breakpoint
-- `$outage` moves out of `hints_json` into `retry_state_json`. The hints column is
-- left holding the caller's own keys, or NULL when nothing is left. Only a hints
-- value that is valid JSON with an object under the key is touched: the old reader
-- treated anything else as "no outage state", and so does this. The guard is a CASE
-- so that `json_type` is never asked of text that is not JSON.
UPDATE `document_extraction_jobs`
SET `retry_state_json` = json_extract(`hints_json`, '$."$outage"'),
	`hints_json` = CASE
		WHEN json_remove(`hints_json`, '$."$outage"') = '{}' THEN NULL
		ELSE json_remove(`hints_json`, '$."$outage"')
	END
WHERE CASE
	WHEN `hints_json` IS NOT NULL AND json_valid(`hints_json`)
		THEN json_type(`hints_json`, '$."$outage"')
	ELSE NULL
END = 'object';
--> statement-breakpoint
-- The index the claim and the idle tick read. Two `=` terms joined by `or`, not an
-- `in (...)` list, so SQLite can see the index's own terms in the query's. The
-- previous release's `document_extraction_jobs_claim_idx` stays: its claim reads it.
CREATE INDEX `document_extraction_jobs_live_claim_idx` ON `document_extraction_jobs` (`status`,`priority`,`created_at`) WHERE "document_extraction_jobs"."status" = 'queued' or "document_extraction_jobs"."status" = 'running';
