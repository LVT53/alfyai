#!/usr/bin/env tsx
/**
 * The Memory label migration (docs/plans/hindsight-memory/migration-runbook.md,
 * "Label migration"): a kind and a subject for every raw fact an account's
 * banks held before bank config 2, then the account's labels verified, one
 * account at a time. A dry run (counts only) unless --execute; --execute
 * needs --user <id> or --all and --backup <dir>, the folder of the paired
 * backup, which it checks against the live database and names before it
 * writes, then labels exactly the accounts it checked the backup for.
 * --rollback --user <id> undoes one account. Skips the tester account (the
 * permanent tester rule), never writes to Hindsight, prints counts, ids and
 * codes only. Ctrl-C stops after the batches in flight are written. Run from this release's checkout with the app's
 * environment loaded. The command itself is `runLabelMigrationCommand`
 * (memory-label-migration-cli.ts); this file only wires the app to it.
 *
 *   npx tsx scripts/memory-label-migration.ts [--user <id>]
 *   npx tsx scripts/memory-label-migration.ts --execute (--user <id> | --all) --backup <dir> [--concurrency 1-3]
 *   npx tsx scripts/memory-label-migration.ts --rollback --user <id> [--execute --backup <dir>]
 */
import {
	checkPairedBackup,
	LABEL_MIGRATION_USAGE,
	type LabelMigrationArguments,
	parseLabelMigrationArguments,
	runLabelMigrationCommand,
} from "./memory-label-migration-cli";

let args: LabelMigrationArguments | undefined;
try {
	args = parseLabelMigrationArguments(process.argv.slice(2));
} catch (error) {
	console.error(
		`${error instanceof Error ? error.message : error}\n${LABEL_MIGRATION_USAGE}`,
	);
	process.exitCode = 2;
}
if (args) {
	const { rollbackLabelMigration, runLabelMigration } = await import(
		"../src/lib/server/services/memory-profile/label-migration"
	);
	// The live database, which the backup is compared with and must not be.
	const { getDatabasePath } = await import("../src/lib/server/env");
	const controller = new AbortController();
	process.once("SIGINT", () => {
		console.log("stopping: the batches in flight are written first");
		controller.abort();
	});
	process.exitCode = await runLabelMigrationCommand(args, {
		runLabelMigration,
		rollbackLabelMigration,
		checkBackup: (dir, accounts) =>
			checkPairedBackup(dir, accounts, new Date(), getDatabasePath()),
		log: (line) => console.log(line),
		signal: controller.signal,
	});
}
