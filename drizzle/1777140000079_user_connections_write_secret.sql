ALTER TABLE `user_connections` ADD `write_secret_ciphertext` text;
--> statement-breakpoint
ALTER TABLE `user_connections` ADD `write_secret_iv` text;
--> statement-breakpoint
ALTER TABLE `user_connections` ADD `write_secret_auth_tag` text;
