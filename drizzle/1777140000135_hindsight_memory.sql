CREATE TABLE memory_accounts (
 user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 tenant_id text NOT NULL UNIQUE,
 authority text NOT NULL DEFAULT 'legacy',
 epoch integer NOT NULL DEFAULT 0,
 history_choice text,
 history_cutoff integer,
 history_decided_at integer,
 history_policy_version text NOT NULL DEFAULT '1',
 history_status text NOT NULL DEFAULT 'not_requested',
 created_at integer NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE TABLE memory_banks (
 id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 scope_key text NOT NULL,
 epoch integer NOT NULL,
 generation text,
 revision integer NOT NULL DEFAULT 0,
 status text NOT NULL DEFAULT 'ready',
 native_config_version text
);
--> statement-breakpoint
CREATE TABLE memory_source_revisions (
 id text PRIMARY KEY,
 bank_id text NOT NULL REFERENCES memory_banks(id) ON DELETE CASCADE,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 epoch integer NOT NULL,
 event_id text NOT NULL,
 lineage_id text NOT NULL,
 conversation_id text,
 message_id text,
 text text NOT NULL,
 context text NOT NULL,
 text_hash text NOT NULL,
 asserted_at integer NOT NULL,
 explicit_edit_at integer,
 acknowledged_facts_json text NOT NULL DEFAULT '[]',
 state text NOT NULL DEFAULT 'pending',
 created_at integer NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE TABLE memory_published_rows (
 id text PRIMARY KEY,
 bank_id text NOT NULL REFERENCES memory_banks(id) ON DELETE CASCADE,
 generation text NOT NULL,
 epoch integer NOT NULL,
 native_id text NOT NULL,
 text text NOT NULL,
 native_text text NOT NULL,
 source_ids_json text NOT NULL,
 source_fingerprints_json text NOT NULL,
 updated_at integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE memory_revocations (
 id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 bank_id text NOT NULL REFERENCES memory_banks(id) ON DELETE CASCADE,
 epoch integer NOT NULL,
 source_id text,
 native_fact_id text,
 native_text_hash text,
 action_id text,
 created_at integer NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE TABLE memory_actions (
 id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 bank_id text NOT NULL REFERENCES memory_banks(id) ON DELETE CASCADE,
 epoch integer NOT NULL,
 request_id text NOT NULL,
 kind text NOT NULL,
 generation text,
 row_id text,
 text text,
 intent_json text,
 previous_text text,
 result_row_id text,
 exclusion_acknowledged integer NOT NULL DEFAULT 0,
 cleanup_pending integer NOT NULL DEFAULT 0,
 created_at integer NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE TABLE memory_control_intervals (
 id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 enabled integer NOT NULL,
 started_at integer NOT NULL,
 ended_at integer,
 epoch integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE memory_migration_manifests (
 id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 epoch integer NOT NULL,
 status text NOT NULL,
 manifest_json text NOT NULL,
 checkpoint_json text,
 created_at integer NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE TABLE memory_delivery_jobs (
 id text PRIMARY KEY, user_id text NOT NULL, status text NOT NULL DEFAULT 'queued', phase text, priority integer NOT NULL DEFAULT 0, run_after integer, attempt_count integer NOT NULL DEFAULT 0, current_attempt_id text, retryable integer NOT NULL DEFAULT 0, error_code text, error_message text, checkpoint_json text, retry_state_json text, cancel_requested_at integer, started_at integer, completed_at integer, created_at integer NOT NULL DEFAULT (unixepoch()), updated_at integer NOT NULL DEFAULT (unixepoch()),
 bank_id text NOT NULL,
 tenant_id text,
 epoch integer NOT NULL,
 kind text NOT NULL,
 source_id text,
 action_id text,
 request_id text NOT NULL
);
--> statement-breakpoint
CREATE TABLE memory_delivery_attempts (
 id text PRIMARY KEY, job_id text NOT NULL REFERENCES memory_delivery_jobs(id) ON DELETE CASCADE, attempt_number integer NOT NULL, status text NOT NULL DEFAULT 'running', phase text, worker_id text, claimed_at integer, heartbeat_at integer, started_at integer, finished_at integer, error_code text, error_message text, retryable integer NOT NULL DEFAULT 0, diagnostics_json text, created_at integer NOT NULL DEFAULT (unixepoch()), updated_at integer NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE TABLE memory_history_choices (
 id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 request_id text NOT NULL,
 choice text NOT NULL,
 cutoff integer NOT NULL,
 decided_at integer NOT NULL,
 policy_version text NOT NULL,
 epoch integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX memory_banks_scope_idx ON memory_banks (user_id,scope_key,epoch);
--> statement-breakpoint
CREATE UNIQUE INDEX memory_source_event_idx ON memory_source_revisions (user_id,event_id);
--> statement-breakpoint
CREATE  INDEX memory_source_bank_idx ON memory_source_revisions (bank_id,state);
--> statement-breakpoint
CREATE  INDEX memory_published_generation_idx ON memory_published_rows (bank_id,generation);
--> statement-breakpoint
CREATE  INDEX memory_revocations_bank_idx ON memory_revocations (bank_id,epoch);
--> statement-breakpoint
CREATE UNIQUE INDEX memory_actions_request_idx ON memory_actions (user_id,request_id);
--> statement-breakpoint
CREATE UNIQUE INDEX memory_delivery_jobs_request_idx ON memory_delivery_jobs (user_id,request_id);
--> statement-breakpoint
CREATE  INDEX memory_delivery_jobs_live_claim_idx ON memory_delivery_jobs (status,priority,created_at);
--> statement-breakpoint
CREATE  INDEX memory_delivery_attempts_job_idx ON memory_delivery_attempts (job_id);
--> statement-breakpoint
CREATE UNIQUE INDEX memory_delivery_attempts_job_number_idx ON memory_delivery_attempts (job_id,attempt_number);
--> statement-breakpoint
CREATE UNIQUE INDEX memory_history_choices_request_idx ON memory_history_choices (user_id,request_id);
--> statement-breakpoint
ALTER TABLE memory_accounts ADD COLUMN control_revision integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE memory_source_revisions ADD COLUMN control_revision integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE memory_delivery_jobs ADD COLUMN control_revision integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE memory_source_revisions ADD COLUMN predecessor_source_id text;
--> statement-breakpoint
ALTER TABLE memory_source_revisions ADD COLUMN native_operation_id text;
--> statement-breakpoint
ALTER TABLE memory_banks ADD COLUMN native_base_url text;
--> statement-breakpoint
ALTER TABLE memory_banks ADD COLUMN native_credential_hash text;
--> statement-breakpoint
ALTER TABLE memory_delivery_jobs ADD COLUMN native_base_url text;
--> statement-breakpoint
ALTER TABLE memory_delivery_jobs ADD COLUMN native_credential_hash text;
--> statement-breakpoint
ALTER TABLE memory_source_revisions ADD COLUMN native_submitted integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE memory_delivery_jobs ADD COLUMN native_operation_ids_json text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE memory_banks ADD COLUMN previous_generation text;
--> statement-breakpoint
ALTER TABLE memory_delivery_jobs ADD COLUMN cleanup_settled integer NOT NULL DEFAULT 0;

--> statement-breakpoint
ALTER TABLE memory_source_revisions ADD COLUMN native_acknowledged integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE memory_accounts ADD COLUMN lifecycle_state text NOT NULL DEFAULT 'active';
--> statement-breakpoint
ALTER TABLE memory_accounts ADD COLUMN erasure_token text;

--> statement-breakpoint
CREATE INDEX memory_source_context_message_idx ON memory_source_revisions(bank_id,epoch,message_id);

--> statement-breakpoint
CREATE TABLE memory_foreground_leases (id text PRIMARY KEY NOT NULL, expires_at integer NOT NULL);
--> statement-breakpoint
CREATE INDEX memory_foreground_expiry_idx ON memory_foreground_leases(expires_at);
