CREATE INDEX `file_production_jobs_live_claim_idx` ON `file_production_jobs` (`status`,`created_at`) WHERE "file_production_jobs"."status" = 'queued' or "file_production_jobs"."status" = 'running';
