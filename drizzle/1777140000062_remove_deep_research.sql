CREATE TEMP TABLE deep_research_artifact_purge_targets (
	artifact_id text PRIMARY KEY
);
--> statement-breakpoint
INSERT OR IGNORE INTO deep_research_artifact_purge_targets (artifact_id)
SELECT report_artifact_id
FROM deep_research_jobs
WHERE report_artifact_id IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO deep_research_artifact_purge_targets (artifact_id)
SELECT id
FROM artifacts
WHERE metadata_json LIKE '%"deepResearchJobId"%';
--> statement-breakpoint
DELETE FROM semantic_embeddings
WHERE subject_type = 'artifact'
	AND subject_id IN (
		SELECT artifact_id FROM deep_research_artifact_purge_targets
	);
--> statement-breakpoint
DELETE FROM artifact_links
WHERE artifact_id IN (
		SELECT artifact_id FROM deep_research_artifact_purge_targets
	)
	OR related_artifact_id IN (
		SELECT artifact_id FROM deep_research_artifact_purge_targets
	);
--> statement-breakpoint
DELETE FROM artifact_chunks
WHERE artifact_id IN (
	SELECT artifact_id FROM deep_research_artifact_purge_targets
);
--> statement-breakpoint
DELETE FROM task_state_evidence_links
WHERE artifact_id IN (
	SELECT artifact_id FROM deep_research_artifact_purge_targets
);
--> statement-breakpoint
DELETE FROM conversation_working_set_items
WHERE artifact_id IN (
	SELECT artifact_id FROM deep_research_artifact_purge_targets
);
--> statement-breakpoint
DELETE FROM skill_note_operations
WHERE artifact_id IN (
	SELECT artifact_id FROM deep_research_artifact_purge_targets
);
--> statement-breakpoint
DELETE FROM skill_note_checkpoints
WHERE note_artifact_id IN (
	SELECT artifact_id FROM deep_research_artifact_purge_targets
);
--> statement-breakpoint
DELETE FROM artifacts
WHERE id IN (
	SELECT artifact_id FROM deep_research_artifact_purge_targets
);
--> statement-breakpoint
DELETE FROM admin_config
WHERE key LIKE 'DEEP_RESEARCH_%';
--> statement-breakpoint
DROP TABLE IF EXISTS deep_research_citation_audit_verdicts;
--> statement-breakpoint
DROP TABLE IF EXISTS deep_research_claim_evidence_links;
--> statement-breakpoint
DROP TABLE IF EXISTS deep_research_synthesis_claims;
--> statement-breakpoint
DROP TABLE IF EXISTS deep_research_evidence_notes;
--> statement-breakpoint
DROP TABLE IF EXISTS deep_research_coverage_gaps;
--> statement-breakpoint
DROP TABLE IF EXISTS deep_research_resume_points;
--> statement-breakpoint
DROP TABLE IF EXISTS deep_research_pass_checkpoints;
--> statement-breakpoint
DROP TABLE IF EXISTS deep_research_tasks;
--> statement-breakpoint
DROP TABLE IF EXISTS deep_research_sources;
--> statement-breakpoint
DROP TABLE IF EXISTS deep_research_usage_records;
--> statement-breakpoint
DROP TABLE IF EXISTS deep_research_timeline_events;
--> statement-breakpoint
DROP TABLE IF EXISTS deep_research_plan_versions;
--> statement-breakpoint
DROP TABLE IF EXISTS deep_research_jobs;
--> statement-breakpoint
DROP TABLE IF EXISTS deep_research_artifact_purge_targets;
