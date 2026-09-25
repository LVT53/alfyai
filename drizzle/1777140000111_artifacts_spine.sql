-- The artifact spine (Feature 2 · Artifacts, slice 0): version history,
-- comments and per-artifact key-value state for the artifact family that
-- hangs off the existing `artifacts` row. Three child tables rather than a
-- parallel document store, so ownership, incognito containment, erasure and
-- the disk sweeps keep working through the one backbone they already
-- understand.
--
-- `version_number` is explicit because `created_at` is second-resolution: two
-- versions written in the same second cannot be ordered by time, and the
-- unique index makes a doubled number a constraint violation rather than a
-- silent duplicate. `anchor_json` is nullable so a comment whose anchor cannot
-- be parsed survives as an orphan instead of being dropped or faked.
-- `artifact_kv` has no user column on purpose: a key-value row is reachable
-- only through a scoped read of the artifact that owns it, and it keeps the
-- house idiom of a surrogate `id` with the (artifact, key) pair unique.
CREATE TABLE `artifact_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`user_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`author` text NOT NULL,
	`summary` text NOT NULL,
	`body` text NOT NULL,
	`body_hash` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_versions_number_unique_idx` ON `artifact_versions` (`artifact_id`,`version_number`);
--> statement-breakpoint
CREATE INDEX `artifact_versions_artifact_idx` ON `artifact_versions` (`artifact_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `artifact_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`user_id` text NOT NULL,
	`parent_id` text,
	`anchor_json` text,
	`author` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `artifact_comments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `artifact_comments_artifact_idx` ON `artifact_comments` (`artifact_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `artifact_kv` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`key` text NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_kv_artifact_key_unique_idx` ON `artifact_kv` (`artifact_id`,`key`);
