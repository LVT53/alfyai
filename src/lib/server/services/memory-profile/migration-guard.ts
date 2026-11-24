import { eq } from "drizzle-orm";
import { type DatabaseInstance, db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import type { Tx } from "../jobs/types";

/**
 * The refusal code a migration reports for an account the guard keeps out.
 * Counts and ids only travel with it, never the account's address.
 */
export const MEMORY_MIGRATION_EXCLUDED = "memory_migration_excluded";

export type MemoryMigrationGuard =
	| { allowed: true }
	| { allowed: false; reason: "excluded" | "unknown_account" };

/**
 * The permanent tester rule (Memory redesign §5), the one place it is read.
 * Every migration of existing Memory data asks this before it acts on an
 * account (the label migration, the operator tools, any future one) and skips
 * or refuses an account it does not allow. Ordinary operation (delivery,
 * curation, bank configuration for new facts, recall) never asks: it is not a
 * migration.
 *
 * Reads the stored flag by user id only, never the address: migration 141 set
 * it once for the tester, so a later change of address keeps the exclusion and
 * no other account is excluded by its address. An account it cannot find is
 * refused too, so a mistyped id never reaches a migration.
 */
export function memoryMigrationGuard(
	userId: string,
	database: DatabaseInstance | Tx = db,
): MemoryMigrationGuard {
	const account = database
		.select({ excluded: users.memoryMigrationExcluded })
		.from(users)
		.where(eq(users.id, userId))
		.get();
	if (!account) return { allowed: false, reason: "unknown_account" };
	if (account.excluded) return { allowed: false, reason: "excluded" };
	return { allowed: true };
}

/**
 * The guard for a migration that refuses rather than skips (an operator acting
 * on one named account): throws `memory_migration_excluded` for the excluded
 * account and `memory_migration_account_unknown` for one it cannot find.
 */
export function assertMemoryMigrationAllowed(
	userId: string,
	database: DatabaseInstance | Tx = db,
): void {
	const guard = memoryMigrationGuard(userId, database);
	if (guard.allowed) return;
	throw Error(
		guard.reason === "excluded"
			? MEMORY_MIGRATION_EXCLUDED
			: "memory_migration_account_unknown",
	);
}
