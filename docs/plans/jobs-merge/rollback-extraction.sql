-- Rolls slice S3 (document extraction on the job engine) back to the words the
-- PREVIOUS release's code reads. Migration 1777140000115_extraction_jobs_on_engine
-- rewrote them; the previous release does not know the new ones. See
-- rollback-extraction.md for when and how to run this.
--
-- Run it with the new process stopped and before the previous release starts, so
-- that nothing writes the tables while it runs:
--
--   sqlite3 data/chat.db < docs/plans/jobs-merge/rollback-extraction.sql
--
-- It is one transaction: either every statement applies or none does. It is
-- idempotent (a second run finds nothing to change), and the migration itself is
-- not undone: the two new columns and the live index stay, unread by the old code.

BEGIN;

-- 1. A running job goes back to the active word it was in. The engine's claim
--    always sets a phase, so the fallback only exists for a row no code of ours
--    has written (the old code would not know what to do with plain `running`).
UPDATE document_extraction_jobs
SET status = CASE
	WHEN phase IN ('uploading', 'parsing', 'downloading', 'indexing') THEN phase
	ELSE 'uploading'
END
WHERE status = 'running';

-- 2. `cancelled` goes back to the one-l spelling, on jobs and on attempts. The old
--    code's Retry and its terminal checks only know `canceled`.
UPDATE document_extraction_jobs SET status = 'canceled' WHERE status = 'cancelled';
UPDATE document_extraction_job_attempts SET status = 'canceled' WHERE status = 'cancelled';

-- 3. The retry policy's memory goes back under the reserved `$outage` key of the
--    hints, which is where the old code reads and writes it. Hints that are not a
--    JSON object (the old reader dropped those) are replaced by an object holding
--    just the state, which is what the old code would have written next.
UPDATE document_extraction_jobs
SET hints_json = json_set(
		CASE
			WHEN hints_json IS NULL THEN '{}'
			WHEN NOT json_valid(hints_json) THEN '{}'
			WHEN json_type(hints_json) <> 'object' THEN '{}'
			ELSE hints_json
		END,
		'$."$outage"',
		json(retry_state_json)
	),
	retry_state_json = NULL
WHERE retry_state_json IS NOT NULL AND json_valid(retry_state_json);

-- 4. The old ledger clears the attempt a job names whenever the job leaves the
--    active words (success, failure, requeue, cancel); the engine leaves it set.
--    Nothing of the old code reads it on such a row, but put it back as the old code
--    wrote it so a row looks the same to both.
UPDATE document_extraction_jobs
SET current_attempt_id = NULL
WHERE status NOT IN ('uploading', 'parsing', 'downloading', 'indexing')
	AND current_attempt_id IS NOT NULL;

COMMIT;
