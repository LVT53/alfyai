-- The permanent tester rule (Memory redesign §5): the tester account is
-- excluded from every migration of existing Memory data, forever. The flag is
-- set here once, by the account's address; from then on every migration reads
-- it by user id through memoryMigrationGuard (memory-profile/migration-guard.ts),
-- so a later change of address does not matter. Ordinary operation (delivery,
-- bank configuration for new facts) never reads it.
-- Expand-only: one column, so undoing it is a drop.
ALTER TABLE `users` ADD `memory_migration_excluded` integer DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE `users` SET `memory_migration_excluded` = 1 WHERE lower(`email`) = 'tester@tester.com';
