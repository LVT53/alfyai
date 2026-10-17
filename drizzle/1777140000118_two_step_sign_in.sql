-- Two-step sign-in (docs/plans/two-step-sign-in, S2 Task 7).
--
-- Three new tables ONLY. The `sessions` table is deliberately untouched:
-- slice S1 already emptied it in `1777140000117_clear_sessions_for_hashed_tokens`,
-- when its ids became SHA-256 hashes and its expiry values changed unit (R9).
-- Another DELETE here would sign everyone out a second time for no reason.
--
-- One factor of each kind per person in version 1 (the unique index), but the
-- table is shaped for a later passkey: `kind` and the nullable `label` are
-- what that will use. `confirmed_at` NULL means setup never finished, so the
-- account is NOT protected by a second step yet. `last_used_step` is the TOTP
-- replay guard: a code is accepted only above it, in one conditional UPDATE.
CREATE TABLE `user_second_factors` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text DEFAULT 'totp' NOT NULL,
	`label` text,
	`secret_ciphertext` text NOT NULL,
	`secret_iv` text NOT NULL,
	`secret_auth_tag` text NOT NULL,
	`last_used_step` integer,
	`confirmed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_second_factors_user_kind_unique_idx` ON `user_second_factors` (`user_id`,`kind`);
--> statement-breakpoint
CREATE INDEX `user_second_factors_user_idx` ON `user_second_factors` (`user_id`);
--> statement-breakpoint
-- The ten one-time codes. `code_hash` is HMAC-SHA256 with a key derived from
-- SESSION_SECRET under its own HKDF label, so the database alone holds
-- nothing to test a guess against. A code is spent by setting `used_at`, in a
-- guarded UPDATE, so two racing requests cannot both spend it.
CREATE TABLE `user_backup_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`used_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_backup_codes_code_hash_unique_idx` ON `user_backup_codes` (`code_hash`);
--> statement-breakpoint
CREATE INDEX `user_backup_codes_user_idx` ON `user_backup_codes` (`user_id`);
--> statement-breakpoint
-- A correct password, waiting up to five minutes for its second step. The id
-- is the SHA-256 of the token in the `signin_attempt` cookie; the database
-- holds no value anyone could present. Five wrong codes delete the row.
CREATE TABLE `sign_in_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`remember_me` integer DEFAULT false NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sign_in_challenges_user_idx` ON `sign_in_challenges` (`user_id`);
--> statement-breakpoint
CREATE INDEX `sign_in_challenges_expires_idx` ON `sign_in_challenges` (`expires_at`);
