-- Retire the June 2026 legacy-memory-curation review backlog (owner decision,
-- 2026-09). The deleted legacy curation path (memory-profile/legacy-curation.ts,
-- removed in 9c75509e) flipped preserved legacy items to `review_needed`,
-- stamped their metadata with `source: "legacy_memory_curation"`, set no
-- expiry, and opened `legacy-memory-curation:<digest>` review rows. Those items
-- never auto-expire, never enter prompts, and hold review-queue slots that block
-- the Memory Judge's review cap.
--
-- Backlog item predicate (status change only; nothing is deleted):
--   status = 'review_needed'
--   AND expires_at IS NULL
--   AND metadata.source = 'legacy_memory_curation'
--   AND metadata.origin IS NOT 'user_authored'
-- Judge-created items never carry `source` (the judge overwrites metadata with
-- its own origin) and always carry a review expiry, so they cannot match.
-- Every statement is guarded so a re-run changes nothing.
UPDATE `memory_projection_state`
SET `revision` = `revision` + 1,
	`updated_at` = unixepoch()
WHERE `id` IN (
	SELECT DISTINCT `projection_state_id`
	FROM `memory_profile_items`
	WHERE `status` = 'review_needed'
		AND `expires_at` IS NULL
		AND CASE WHEN json_valid(`metadata_json`) THEN json_extract(`metadata_json`, '$.source') END = 'legacy_memory_curation'
		AND coalesce(CASE WHEN json_valid(`metadata_json`) THEN json_extract(`metadata_json`, '$.origin') END, '') <> 'user_authored'
);
--> statement-breakpoint
UPDATE `memory_profile_items`
SET `status` = 'retired',
	`revision` = `revision` + 1,
	`updated_at` = unixepoch(),
	`metadata_json` = json_set(`metadata_json`, '$.retiredReason', 'legacy_review_backlog_2026_09')
WHERE `status` = 'review_needed'
	AND `expires_at` IS NULL
	AND CASE WHEN json_valid(`metadata_json`) THEN json_extract(`metadata_json`, '$.source') END = 'legacy_memory_curation'
	AND coalesce(CASE WHEN json_valid(`metadata_json`) THEN json_extract(`metadata_json`, '$.origin') END, '') <> 'user_authored';
--> statement-breakpoint
-- Close still-open legacy-curation review rows that no longer point at any
-- review_needed item (rows for a protected user_authored item stay open).
-- One resolution per row, mirroring memory-profile/review-resolution.ts.
INSERT OR IGNORE INTO `memory_review_resolutions`
	(`id`, `review_item_id`, `user_id`, `reset_generation`, `resolution_type`, `metadata_json`, `created_at`)
SELECT
	lower(hex(randomblob(16))),
	r.`id`,
	r.`user_id`,
	r.`reset_generation`,
	'do_not_remember',
	json_object('reason', 'legacy_review_backlog_2026_09'),
	unixepoch()
FROM `memory_review_items` r
WHERE r.`status` = 'open'
	AND r.`subject_key` LIKE 'legacy-memory-curation:%'
	AND json_valid(r.`affected_item_ids_json`)
	AND NOT EXISTS (
		SELECT 1
		FROM json_each(CASE WHEN json_valid(r.`affected_item_ids_json`) THEN r.`affected_item_ids_json` ELSE '[]' END) a
		JOIN `memory_profile_items` i ON i.`id` = a.`value`
		WHERE i.`status` = 'review_needed'
	);
--> statement-breakpoint
UPDATE `memory_review_items`
SET `status` = 'resolved',
	`resolved_at` = unixepoch(),
	`updated_at` = unixepoch()
WHERE `status` = 'open'
	AND `subject_key` LIKE 'legacy-memory-curation:%'
	AND json_valid(`affected_item_ids_json`)
	AND NOT EXISTS (
		SELECT 1
		FROM json_each(CASE WHEN json_valid(`memory_review_items`.`affected_item_ids_json`) THEN `memory_review_items`.`affected_item_ids_json` ELSE '[]' END) a
		JOIN `memory_profile_items` i ON i.`id` = a.`value`
		WHERE i.`status` = 'review_needed'
	);
