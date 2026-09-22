/**
 * Removes generated artifacts that nothing can reach any more.
 *
 * `artifacts.conversation_id` is `ON DELETE SET NULL`, so before release
 * f41f7931 deleting a conversation cleared the link on every
 * `generated_output` / `work_capsule` it preserved. From that moment the row
 * was invisible in the Library, 404 on GET, and skipped by the bulk "forget
 * all" actions — which filter by canonical ownership, and canonical ownership
 * refuses those two types without a live conversation. The row, its chunks,
 * its embeddings, its extraction job, its stored file and its MinerU parse
 * bundle stayed on disk with nothing able to remove them.
 *
 * The delete path is fixed. This sweep is for what the old code already
 * stranded, and it MUST be run once with `--apply` after the production
 * cutover; see docs/uploads.md.
 *
 * Run via:
 *   DATABASE_PATH=./data/chat.db npx tsx scripts/sweep-orphan-generated-artifacts.ts
 *   DATABASE_PATH=./data/chat.db npx tsx scripts/sweep-orphan-generated-artifacts.ts --apply
 *
 * `--dry-run` is the DEFAULT: with no flag it only reports. Deletion goes
 * through `hardDeleteArtifactsForUser`, the same service function the app's
 * own delete uses, so chunks, links, embeddings, parse bundles, extraction job
 * rows and files on disk all go the way they would from the UI.
 *
 * What counts as unreachable is defined ONCE, in
 * `$lib/server/services/knowledge/store/orphan-artifacts.ts`, and shared with
 * the "forget all generated results" action. A sweep and a button that
 * disagreed would be worse than either alone.
 */

const APPLY = process.argv.includes("--apply");
const PREVIEW_IDS = 20;

function fail(message: string): never {
	console.error(`ERROR: ${message}`);
	process.exit(1);
}

// An explicit DATABASE_PATH, always. The app's own default is `./data/chat.db`
// relative to the working directory, and a destructive sweep that silently
// picked up a default could be pointed at production by a `cd`.
const databasePath = process.env.DATABASE_PATH?.trim();
if (!databasePath) {
	fail(
		"DATABASE_PATH must be set explicitly, e.g.\n" +
			"  DATABASE_PATH=./data/chat.db npx tsx scripts/sweep-orphan-generated-artifacts.ts",
	);
}

async function main(): Promise<void> {
	const [{ listOrphanGeneratedArtifacts }, { hardDeleteArtifactsForUser }] =
		await Promise.all([
			import("$lib/server/services/knowledge/store/orphan-artifacts"),
			import("$lib/server/services/knowledge/store/cleanup"),
		]);

	const orphans = await listOrphanGeneratedArtifacts();

	console.log(`Database: ${databasePath}`);
	console.log(`Mode:     ${APPLY ? "APPLY (deletes)" : "dry run (default)"}`);
	console.log(`Found ${orphans.length} unreachable generated artifacts.`);

	if (orphans.length === 0) {
		console.log("Nothing to sweep.");
		return;
	}

	const byUser = new Map<string, number>();
	const byType = new Map<string, number>();
	for (const row of orphans) {
		byUser.set(row.userId, (byUser.get(row.userId) ?? 0) + 1);
		byType.set(row.type, (byType.get(row.type) ?? 0) + 1);
	}

	console.log("\nPer user:");
	for (const [userId, count] of [...byUser].sort((a, b) => b[1] - a[1])) {
		console.log(`  ${userId}  ${count}`);
	}
	console.log("\nPer type:");
	for (const [type, count] of [...byType].sort((a, b) => b[1] - a[1])) {
		console.log(`  ${type}  ${count}`);
	}

	console.log(`\nFirst ${Math.min(PREVIEW_IDS, orphans.length)} ids:`);
	for (const row of orphans.slice(0, PREVIEW_IDS)) {
		console.log(`  ${row.id}  ${row.type}  ${row.name}`);
	}

	if (!APPLY) {
		console.log(
			"\nDry run — nothing was deleted. Re-run with --apply to remove these.",
		);
		return;
	}

	// Grouped by owner, because `hardDeleteArtifactsForUser` resolves the
	// ownership scope and the on-disk paths per user.
	const idsByUser = new Map<string, string[]>();
	for (const row of orphans) {
		idsByUser.set(row.userId, [...(idsByUser.get(row.userId) ?? []), row.id]);
	}

	let deleted = 0;
	let failedFiles = 0;
	for (const [userId, ids] of idsByUser) {
		const result = await hardDeleteArtifactsForUser(userId, ids);
		deleted += result.deletedArtifactIds.length;
		failedFiles += result.failedStoragePaths.length;
		console.log(
			`  ${userId}: deleted ${result.deletedArtifactIds.length}/${ids.length}, ` +
				`files removed ${result.deletedStoragePaths.length}, ` +
				`file gaps ${result.failedStoragePaths.length}`,
		);
	}

	console.log(`\nDeleted ${deleted} artifacts.`);
	if (failedFiles > 0) {
		console.log(
			`${failedFiles} stored files were not unlinked (missing, or refused for ` +
				"resolving outside the data directories). Their rows are gone; see " +
				"docs/uploads.md for how to find leftover bytes.",
		);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
