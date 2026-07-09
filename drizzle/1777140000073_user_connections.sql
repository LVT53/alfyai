CREATE TABLE `user_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`label` text NOT NULL,
	`account_identifier` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'disconnected' NOT NULL,
	`status_detail` text,
	`default_on` integer DEFAULT false NOT NULL,
	`allow_writes` integer DEFAULT false NOT NULL,
	`write_allowlist_json` text DEFAULT '[]' NOT NULL,
	`capabilities_json` text DEFAULT '[]' NOT NULL,
	`secret_ciphertext` text,
	`secret_iv` text,
	`secret_auth_tag` text,
	`oauth_scopes_json` text DEFAULT '[]' NOT NULL,
	`token_expires_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_connections_user_provider_account_unique` ON `user_connections` (`user_id`,`provider`,`account_identifier`);
--> statement-breakpoint
CREATE INDEX `user_connections_user_idx` ON `user_connections` (`user_id`);
