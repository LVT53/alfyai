/**
 * The label migration's command line (`memory-label-migration.ts`): its
 * arguments, the paired backup the runbook requires before it writes, and
 * its counts-only report lines. Imports nothing of the app at run time, so it
 * loads before the app's environment is checked.
 */
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type {
	LabelMigrationAccount,
	LabelMigrationReport,
	LabelRollbackReport,
} from "../src/lib/server/services/memory-profile/label-migration";

export interface LabelMigrationArguments {
	mode: "migrate" | "rollback";
	execute: boolean;
	user?: string;
	all?: boolean;
	/** The folder holding the paired backup: required before any write. */
	backup?: string;
	/** Model calls in flight for an account, 1 to 3. */
	concurrency: number;
}

export const LABEL_MIGRATION_USAGE = [
	"usage: npx tsx scripts/memory-label-migration.ts [--user <id>]",
	"       npx tsx scripts/memory-label-migration.ts --execute (--user <id> | --all) --backup <dir> [--concurrency 1-3]",
	"       npx tsx scripts/memory-label-migration.ts --rollback --user <id> [--execute --backup <dir>]",
].join("\n");

export function parseLabelMigrationArguments(
	args: string[],
): LabelMigrationArguments {
	const flags = new Set<string>();
	const values = new Map<string, string>();
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (["--execute", "--all", "--rollback"].includes(arg)) {
			if (flags.has(arg)) throw Error("duplicate_argument");
			flags.add(arg);
			continue;
		}
		const value = args[i + 1];
		if (
			!["--user", "--backup", "--concurrency"].includes(arg) ||
			value === undefined ||
			value.startsWith("--")
		)
			throw Error("invalid_arguments");
		if (values.has(arg)) throw Error("duplicate_argument");
		values.set(arg, value);
		i += 1;
	}
	const parsed: LabelMigrationArguments = {
		mode: flags.has("--rollback") ? "rollback" : "migrate",
		execute: flags.has("--execute"),
		concurrency: 1,
	};
	const user = values.get("--user");
	if (user !== undefined) parsed.user = user;
	if (flags.has("--all")) parsed.all = true;
	const backup = values.get("--backup");
	if (backup !== undefined) parsed.backup = backup;
	const concurrency = values.get("--concurrency");
	if (concurrency !== undefined) {
		if (!/^[1-3]$/.test(concurrency)) throw Error("invalid_concurrency");
		parsed.concurrency = Number(concurrency);
	}
	if (parsed.mode === "rollback") {
		if (!parsed.user || parsed.all) throw Error("user_required");
	} else if (parsed.user && parsed.all) throw Error("user_or_all_required");
	else if (parsed.execute && !parsed.user && !parsed.all)
		throw Error("user_or_all_required");
	if (parsed.execute && !parsed.backup) throw Error("backup_required");
	return parsed;
}

export interface BackupFile {
	/** The file's path inside the backup folder. */
	name: string;
	bytes: number;
	modifiedAt: string;
}

export type PairedBackup =
	| { ok: true; sqlite: BackupFile; postgres: BackupFile }
	| { ok: false; code: string };

/** How old the newer half of the backup may be. */
const BACKUP_MAX_AGE_HOURS = 24;
/** How far apart its two halves may have been taken. */
const BACKUP_MAX_SPREAD_HOURS = 2;

/**
 * The paired backup the runbook requires before the migration writes: in one
 * folder, a backup of the app's SQLite database (an app database that holds
 * every account the run will label) and a PostgreSQL dump of Hindsight (plain
 * SQL, gzipped, custom format, or a directory-format dump's `toc.dat`), both
 * from the last day and taken within two hours of each other. Reads file
 * headers and account ids only; nothing is printed but names, sizes and times.
 */
export function checkPairedBackup(
	dir: string,
	accounts: readonly string[],
	now = new Date(),
): PairedBackup {
	let entries: string[];
	try {
		if (!statSync(dir).isDirectory())
			return { ok: false, code: "backup_dir_missing" };
		entries = readdirSync(dir).sort();
	} catch {
		return { ok: false, code: "backup_dir_missing" };
	}
	const files: { name: string; path: string }[] = [];
	for (const entry of entries) {
		const path = join(dir, entry);
		const stat = statSync(path);
		if (stat.isFile()) files.push({ name: entry, path });
		else if (stat.isDirectory()) {
			const toc = join(path, "toc.dat");
			try {
				if (statSync(toc).isFile())
					files.push({ name: `${entry}/toc.dat`, path: toc });
			} catch {
				/* Not a directory-format dump. */
			}
		}
	}
	const newest = (list: typeof files) =>
		list
			.map((file) => ({ ...file, stat: statSync(file.path) }))
			.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0];
	const sqlite = newest(
		files.filter((file) => head(file.path, 16).equals(SQLITE_MAGIC)),
	);
	if (!sqlite) return { ok: false, code: "backup_sqlite_missing" };
	const postgres = newest(files.filter((file) => isPostgresDump(file)));
	if (!postgres) return { ok: false, code: "backup_postgres_missing" };
	let missing = 0;
	try {
		const backup = new Database(sqlite.path, {
			readonly: true,
			fileMustExist: true,
		});
		try {
			const tables = new Set(
				(
					backup
						.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
						.all() as { name: string }[]
				).map(({ name }) => name),
			);
			if (!tables.has("memory_accounts") || !tables.has("memory_fact_labels"))
				return { ok: false, code: "backup_sqlite_not_app_database" };
			const held = backup.prepare(
				"SELECT 1 FROM memory_accounts WHERE user_id = ?",
			);
			for (const id of accounts) if (!held.get(id)) missing++;
		} finally {
			backup.close();
		}
	} catch {
		return { ok: false, code: "backup_sqlite_unreadable" };
	}
	if (missing) return { ok: false, code: "backup_missing_accounts" };
	const times = [sqlite.stat.mtimeMs, postgres.stat.mtimeMs];
	if (
		Math.max(...times.map((time) => now.getTime() - time)) >
		BACKUP_MAX_AGE_HOURS * 3_600_000
	)
		return { ok: false, code: "backup_stale" };
	if (Math.abs(times[0] - times[1]) > BACKUP_MAX_SPREAD_HOURS * 3_600_000)
		return { ok: false, code: "backup_not_paired" };
	const describe = (file: NonNullable<typeof sqlite>): BackupFile => ({
		name: file.name,
		bytes: file.stat.size,
		modifiedAt: new Date(file.stat.mtimeMs).toISOString(),
	});
	return { ok: true, sqlite: describe(sqlite), postgres: describe(postgres) };
}

const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "binary");

function head(path: string, bytes: number): Buffer {
	const buffer = Buffer.alloc(bytes);
	const fd = openSync(path, "r");
	try {
		const read = readSync(fd, buffer, 0, bytes, 0);
		return buffer.subarray(0, read);
	} finally {
		closeSync(fd);
	}
}

function isPostgresDump(file: { name: string; path: string }): boolean {
	const start = head(file.path, 4096);
	if (start.subarray(0, 5).toString("binary") === "PGDMP") return true;
	if (/\.gz$/.test(file.name)) return start[0] === 0x1f && start[1] === 0x8b;
	return (
		/\.sql$/.test(file.name) &&
		start.toString("utf8").includes("PostgreSQL database dump")
	);
}

/** The non-zero counts of a breakdown, each as `prefix.key=n`. */
function counts(prefix: string, values: Record<string, number | undefined>) {
	return Object.entries(values)
		.filter((entry): entry is [string, number] => !!entry[1])
		.map(([key, value]) => `${prefix}${key}=${value}`);
}

/** One account's line: its outcome and counts, never memory text. */
export function labelMigrationAccountLine(
	account: LabelMigrationAccount,
): string {
	if (account.outcome === "skipped")
		return `account ${account.userId} skipped ${account.skipped}`;
	return [
		`account ${account.userId} ${account.outcome}`,
		...(account.failure ? [`failure=${account.failure}`] : []),
		`banks=${account.banks} configOneBanks=${account.configOneBanks} facts=${account.facts} removed=${account.removed} alreadyLabelled=${account.alreadyLabelled} toLabel=${account.toLabel} estimatedCalls=${account.estimatedCalls} calls=${account.calls} labelled=${account.labelled}`,
		...counts("kind.", account.byKind),
		...counts("subject.", account.bySubject),
		...counts("unlabelled.", account.unlabelled),
		...(account.verification
			? [
					`verification=${
						Object.values(account.verification).every(Boolean)
							? "passed"
							: "failed"
					}`,
				]
			: []),
	].join(" ");
}

/** One line per account, the totals and the outcome: counts, ids and codes only. */
export function labelMigrationLines(report: LabelMigrationReport): string[] {
	const { totals } = report;
	return [
		...report.accounts.map(labelMigrationAccountLine),
		[
			`totals accounts=${totals.accounts}`,
			...counts("skipped.", totals.skipped),
			`banks=${totals.banks} facts=${totals.facts} alreadyLabelled=${totals.alreadyLabelled} toLabel=${totals.toLabel} estimatedCalls=${totals.estimatedCalls} calls=${totals.calls} labelled=${totals.labelled} verified=${totals.verified} failed=${totals.failed}`,
		].join(" "),
		`outcome: ${report.outcome}${report.stoppedAt ? ` at ${report.stoppedAt}` : ""}`,
	];
}

export function rollbackLines(report: LabelRollbackReport): string[] {
	return [
		`rollback ${report.userId} ${report.outcome} banks=${report.banks} labels=${report.labels}${report.code ? ` code=${report.code}` : ""}`,
	];
}
