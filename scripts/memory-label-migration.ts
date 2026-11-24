#!/usr/bin/env tsx
/**
 * The Memory label migration (docs/plans/hindsight-memory/migration-runbook.md,
 * "Label migration"): a kind and a subject for every raw fact an account's
 * banks held before bank config 2, then the account's labels verified, one
 * account at a time. A dry run (counts only) unless --execute; --execute
 * needs --user <id> or --all and --backup <dir>, the folder of the paired
 * backup, which it checks and names before it writes. --rollback --user <id>
 * undoes one account. Skips the tester account (the permanent tester rule),
 * never writes to Hindsight, prints counts, ids and codes only. Ctrl-C stops
 * after the batches in flight are written. Run from this release's checkout
 * with the app's environment loaded.
 *
 *   npx tsx scripts/memory-label-migration.ts [--user <id>]
 *   npx tsx scripts/memory-label-migration.ts --execute (--user <id> | --all) --backup <dir> [--concurrency 1-3]
 *   npx tsx scripts/memory-label-migration.ts --rollback --user <id> [--execute --backup <dir>]
 */
import {
	checkPairedBackup,
	LABEL_MIGRATION_USAGE,
	type LabelMigrationArguments,
	labelMigrationAccountLine,
	labelMigrationLines,
	parseLabelMigrationArguments,
	rollbackLines,
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
if (args) process.exitCode = await run(args);

/** Checks and names the paired backup; false when the run must not write. */
function backupReady(dir: string, accounts: string[]): boolean {
	const backup = checkPairedBackup(dir, accounts);
	if (!backup.ok) {
		console.log(`backup: refused ${backup.code}`);
		return false;
	}
	console.log(
		`backup: sqlite=${backup.sqlite.name} bytes=${backup.sqlite.bytes} at=${backup.sqlite.modifiedAt} postgres=${backup.postgres.name} bytes=${backup.postgres.bytes} at=${backup.postgres.modifiedAt} accounts=${accounts.length}`,
	);
	return true;
}

async function run(args: LabelMigrationArguments): Promise<number> {
	const { rollbackLabelMigration, runLabelMigration } = await import(
		"../src/lib/server/services/memory-profile/label-migration"
	);
	if (args.mode === "rollback" && args.user) {
		const dry = rollbackLabelMigration({ userId: args.user, execute: false });
		for (const line of rollbackLines(dry)) console.log(line);
		if (!args.execute || dry.outcome !== "dry_run") {
			console.log(JSON.stringify(dry));
			return dry.outcome === "dry_run" ? 0 : 1;
		}
		if (!args.backup || !backupReady(args.backup, [args.user])) return 1;
		const done = rollbackLabelMigration({ userId: args.user, execute: true });
		for (const line of rollbackLines(done)) console.log(line);
		console.log(JSON.stringify(done));
		return done.outcome === "done" ? 0 : 1;
	}
	const controller = new AbortController();
	process.once("SIGINT", () => {
		console.log("stopping: the batches in flight are written first");
		controller.abort();
	});
	const scope = { execute: false, ...(args.user ? { userId: args.user } : {}) };
	console.log("dry run:");
	const dry = await runLabelMigration(scope, { signal: controller.signal });
	for (const line of labelMigrationLines(dry)) console.log(line);
	if (!args.execute) {
		console.log(JSON.stringify(dry));
		return 0;
	}
	const accounts = dry.accounts
		.filter(({ outcome }) => outcome === "dry_run")
		.map(({ userId }) => userId);
	if (!accounts.length) {
		console.log("nothing to label");
		return 0;
	}
	if (!args.backup || !backupReady(args.backup, accounts)) return 1;
	console.log("execute:");
	const report = await runLabelMigration(
		{ ...scope, execute: true },
		{
			signal: controller.signal,
			concurrency: args.concurrency,
			onAccount: (account) => console.log(labelMigrationAccountLine(account)),
		},
	);
	for (const line of labelMigrationLines(report).slice(report.accounts.length))
		console.log(line);
	console.log(JSON.stringify(report));
	return report.outcome === "done" ? 0 : 1;
}
