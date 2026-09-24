/**
 * Replays every month of Parallel billing under the current free allowance.
 *
 * `recordParallelUsage` books each call against the month's running total, so
 * every Parallel row written before this feature existed was charged full price
 * even though the whole server's month sits far below the allowance. The owner
 * asked for history to be recomputed rather than grandfathered, so this replays
 * each month with `recomputeParallelBillingForMonth` — the same function the
 * admin config write uses when the allowance moves — and writes only the rows
 * whose cost actually changes.
 *
 * Run via:
 *   DATABASE_PATH=./data/chat.db npx tsx scripts/recompute-parallel-billing.ts
 *   DATABASE_PATH=./data/chat.db npx tsx scripts/recompute-parallel-billing.ts --apply
 *
 * `--dry-run` is the DEFAULT: with no flag it only reports. That matters
 * because this rewrites cost rows users can see in their own analytics, and it
 * is a once-only operation — the record path keeps the allowance applied from
 * here on.
 *
 * The allowance is the EFFECTIVE one: the stored `admin_config` override if the
 * admin set one, the environment default otherwise. Replaying under the env
 * default while the server was applying an override would book the month at a
 * cost nobody is charged.
 */

import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

export interface ReplayRow {
	month: string;
	calls: number;
	/** The month's Parallel spend at list price, before the allowance. */
	listMicros: number;
	/** What the month was booked at when the run started. */
	beforeMicros: number;
	/** What it should be booked at — written as well, when applying. */
	afterMicros: number;
	/** Rows whose stored cost differs from the recomputed one. */
	changed: number;
}

export interface ReplaySummary {
	rows: ReplayRow[];
	applied: boolean;
	calls: number;
	changed: number;
	beforeMicros: number;
	afterMicros: number;
}

// Micros to a 6-decimal dollar string, the same shape the account data archive
// exports costs in. Six decimals is the precision the column holds.
function usd(micros: number): string {
	return `$${(micros / 1_000_000).toFixed(6)}`;
}

function fail(message: string): never {
	console.error(`ERROR: ${message}`);
	process.exit(1);
}

/**
 * Replays every month that holds Parallel calls, oldest first. Exported so the
 * test can drive the arithmetic without capturing stdout.
 */
export async function replayAllMonths(options: {
	apply: boolean;
}): Promise<ReplaySummary> {
	const [{ getParallelFreeMonthlyUsd, refreshConfig }, analytics] =
		await Promise.all([
			import("$lib/server/config-store"),
			import("$lib/server/services/analytics"),
		]);

	// The stored override lives in `admin_config`, which the runtime config
	// only reads on refresh. Without this the script would replay the whole
	// history against the environment default.
	await refreshConfig();
	const allowanceUsd = getParallelFreeMonthlyUsd();

	const rows: ReplayRow[] = [];
	for (const month of analytics.listParallelBillingMonths()) {
		const result = await analytics.recomputeParallelBillingForMonth(
			month,
			allowanceUsd,
			options,
		);
		rows.push({
			month,
			calls: result.calls,
			listMicros: analytics.parallelListMicrosForCalls(result.calls),
			beforeMicros: result.previousMicros,
			afterMicros: result.billedMicros,
			changed: result.changed,
		});
	}

	return {
		rows,
		applied: options.apply,
		calls: rows.reduce((sum, row) => sum + row.calls, 0),
		changed: rows.reduce((sum, row) => sum + row.changed, 0),
		beforeMicros: rows.reduce((sum, row) => sum + row.beforeMicros, 0),
		afterMicros: rows.reduce((sum, row) => sum + row.afterMicros, 0),
	};
}

export async function main(argv: string[]): Promise<number> {
	const apply = argv.includes("--apply");
	if (argv.includes("--help")) {
		console.log(
			"Usage: DATABASE_PATH=./data/chat.db npx tsx scripts/recompute-parallel-billing.ts [--apply]\n" +
				"  With no flag it only reports; --apply writes the recomputed costs.",
		);
		return 0;
	}

	// An explicit DATABASE_PATH, always. The app's own default is
	// `./data/chat.db` relative to the working directory, and a rewrite that
	// silently picked up a default could be pointed at production by a `cd`.
	const databasePath = process.env.DATABASE_PATH?.trim();
	if (!databasePath) {
		fail(
			"DATABASE_PATH must be set explicitly, e.g.\n" +
				"  DATABASE_PATH=./data/chat.db npx tsx scripts/recompute-parallel-billing.ts",
		);
	}

	const { existsSync } = await import("node:fs");
	if (!existsSync(databasePath)) {
		fail(
			`DATABASE_PATH does not exist: ${databasePath}\n` +
				"       (this script never creates a database; check the path)",
		);
	}

	const { getParallelFreeMonthlyUsd, refreshConfig } = await import(
		"$lib/server/config-store"
	);
	await refreshConfig();

	console.log(`Database:  ${databasePath}`);
	console.log(`Mode:      ${apply ? "APPLY (writes)" : "dry run (default)"}`);
	console.log(
		`Allowance: ${usd(Math.round(getParallelFreeMonthlyUsd() * 1_000_000))}`,
	);

	const summary = await replayAllMonths({ apply });

	if (summary.rows.length === 0) {
		console.log("No month has Parallel calls. Nothing to replay.");
		return 0;
	}

	for (const row of summary.rows) {
		console.log(
			`  ${row.month}  calls=${row.calls}  list=${usd(row.listMicros)}  ` +
				`billed ${usd(row.beforeMicros)} -> ${usd(row.afterMicros)}  ` +
				`changed=${row.changed}  applied=${apply ? "yes" : "no"}`,
		);
	}

	console.log(
		`\n${apply ? "" : "(dry-run) "}parallel billing replay complete: ` +
			`months=${summary.rows.length}, calls=${summary.calls}, changed=${summary.changed}, ` +
			`billed ${usd(summary.beforeMicros)} -> ${usd(summary.afterMicros)}`,
	);
	if (!apply && summary.changed > 0) {
		console.log(
			"Nothing was written. Re-run with --apply to book these months at the allowance.",
		);
	}

	return 0;
}

function isDirectExecution(): boolean {
	return Boolean(
		process.argv[1] &&
			resolvePath(process.argv[1]) === fileURLToPath(import.meta.url),
	);
}

if (isDirectExecution()) {
	main(process.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((error) => {
			console.error(error);
			process.exit(1);
		});
}
