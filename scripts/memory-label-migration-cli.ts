/**
 * The label migration's command line (`memory-label-migration.ts`): its
 * arguments, the paired backup the runbook requires before it writes, and
 * its counts-only report lines. Imports nothing of the app at run time, so it
 * loads before the app's environment is checked.
 */
import {
	closeSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	type Stats,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { constants, gunzipSync } from "node:zlib";
import Database from "better-sqlite3";
import type {
	LabelMigrationAccount,
	LabelMigrationDeps,
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

/**
 * How old either half of the backup may be: the runbook takes it, has the
 * owner's go-ahead and runs in one sitting, and the comparison with the live
 * database catches anything written since.
 */
const BACKUP_MAX_AGE_HOURS = 4;
/** How far apart its two halves may have been taken. */
const BACKUP_MAX_SPREAD_HOURS = 2;

/**
 * The paired backup the runbook requires before the migration writes: in one
 * folder, a backup of the app's SQLite database (an app database that holds
 * every account the run will label) and a PostgreSQL dump of Hindsight (plain
 * SQL, gzipped plain SQL, inflated to be read, custom format, or a
 * directory-format dump's `toc.dat`), both from the last four hours and taken
 * within two hours of each other. Given the live database's path, it refuses
 * that file itself (by its real path, so a link to it too), and the backup
 * must hold each account to label as the live database does: the same epoch,
 * labels mark, banks with their generations, and classifier-label count. Reads
 * file headers, ids and counts only; nothing is printed but names, sizes and
 * times.
 */
export function checkPairedBackup(
	dir: string,
	accounts: readonly string[],
	now = new Date(),
	live?: string,
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
		const stat = statOrNull(path);
		if (!stat) continue;
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
			.flatMap((file) => {
				const stat = statOrNull(file.path);
				return stat ? [{ ...file, stat }] : [];
			})
			.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0];
	const sqlite = newest(
		files.filter((file) => head(file.path, 16).equals(SQLITE_MAGIC)),
	);
	if (!sqlite) return { ok: false, code: "backup_sqlite_missing" };
	if (live && sameFile(sqlite.path, live))
		return { ok: false, code: "backup_is_live_database" };
	const postgres = newest(files.filter((file) => isPostgresDump(file)));
	if (!postgres) return { ok: false, code: "backup_postgres_missing" };
	let missing = 0;
	let differs = false;
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
			if (!missing && live) differs = !sameAccounts(backup, live, accounts);
		} finally {
			backup.close();
		}
	} catch {
		return { ok: false, code: "backup_sqlite_unreadable" };
	}
	if (missing) return { ok: false, code: "backup_missing_accounts" };
	if (differs) return { ok: false, code: "backup_differs_from_live" };
	const times = [sqlite.stat.mtimeMs, postgres.stat.mtimeMs];
	if (Math.abs(times[0] - times[1]) > BACKUP_MAX_SPREAD_HOURS * 3_600_000)
		return { ok: false, code: "backup_not_paired" };
	if (
		Math.max(...times.map((time) => now.getTime() - time)) >
		BACKUP_MAX_AGE_HOURS * 3_600_000
	)
		return { ok: false, code: "backup_stale" };
	const describe = (file: NonNullable<typeof sqlite>): BackupFile => ({
		name: file.name,
		bytes: file.stat.size,
		modifiedAt: new Date(file.stat.mtimeMs).toISOString(),
	});
	return { ok: true, sqlite: describe(sqlite), postgres: describe(postgres) };
}

const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "binary");

/** A path's stat, or null for one that is gone (a dangling link included). */
function statOrNull(path: string): Stats | null {
	try {
		return statSync(path);
	} catch {
		return null;
	}
}

function sameFile(a: string, b: string): boolean {
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return false;
	}
}

/** What the backup must hold for an account as the live database does. */
function accountState(database: Database.Database, userId: string): string {
	const account = database
		.prepare(
			"SELECT epoch, labels_unverified_epoch AS unverified FROM memory_accounts WHERE user_id = ?",
		)
		.get(userId) as { epoch: number; unverified: number | null } | undefined;
	if (!account) return "missing";
	const banks = database
		.prepare(
			"SELECT id, generation FROM memory_banks WHERE user_id = ? AND epoch = ? AND status != 'retired' ORDER BY id",
		)
		.all(userId, account.epoch);
	const { labels } = database
		.prepare(
			"SELECT COUNT(*) AS labels FROM memory_fact_labels JOIN memory_banks ON memory_banks.id = memory_fact_labels.bank_id WHERE memory_banks.user_id = ? AND memory_banks.epoch = ? AND memory_fact_labels.origin = 'classifier'",
		)
		.get(userId, account.epoch) as { labels: number };
	return JSON.stringify({ account, banks, labels });
}

function sameAccounts(
	backup: Database.Database,
	livePath: string,
	accounts: readonly string[],
): boolean {
	const live = new Database(livePath, { readonly: true, fileMustExist: true });
	try {
		return accounts.every(
			(userId) => accountState(backup, userId) === accountState(live, userId),
		);
	} finally {
		live.close();
	}
}

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
	if (/\.gz$/.test(file.name)) {
		if (start[0] !== 0x1f || start[1] !== 0x8b) return false;
		// Inflate the start only (a dump can be large) and read it as one.
		try {
			const text = gunzipSync(head(file.path, 65_536), {
				finishFlush: constants.Z_SYNC_FLUSH,
			})
				.subarray(0, 4096)
				.toString("utf8");
			return text.includes("PostgreSQL database dump");
		} catch {
			return false;
		}
	}
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

/** The whole account's counts: facts and entries by kind and subject, and the Earlier entries. */
function wholeCounts(account: LabelMigrationAccount): string[] {
	const { whole } = account;
	if (!whole) return [];
	return [
		...counts("account.facts.kind.", whole.factsByKind),
		...counts("account.facts.subject.", whole.factsBySubject),
		`entries=${whole.entries} earlierEntries=${whole.earlierEntries}`,
		...counts("entries.kind.", whole.entriesByKind),
		...counts("entries.subject.", whole.entriesBySubject),
	];
}

/**
 * One account's line: its outcome and counts, never memory text. `labelled`,
 * `kind.` and `subject.` are this run's labels; `account.facts.` and
 * `entries` are the whole account's, a resumed run's included.
 */
function labelMigrationAccountLine(account: LabelMigrationAccount): string {
	if (account.outcome === "skipped")
		return [
			`account ${account.userId} skipped ${account.skipped}`,
			...wholeCounts(account),
		].join(" ");
	return [
		`account ${account.userId} ${account.outcome}`,
		...(account.failure ? [`failure=${account.failure}`] : []),
		`banks=${account.banks} configOneBanks=${account.configOneBanks} facts=${account.facts} removed=${account.removed} alreadyLabelled=${account.alreadyLabelled} toLabel=${account.toLabel} estimatedCalls=${account.estimatedCalls} calls=${account.calls} labelled=${account.labelled}`,
		...counts("kind.", account.byKind),
		...counts("subject.", account.bySubject),
		...counts("unlabelled.", account.unlabelled),
		...wholeCounts(account),
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
			`banks=${totals.banks} facts=${totals.facts} alreadyLabelled=${totals.alreadyLabelled} toLabel=${totals.toLabel} estimatedCalls=${totals.estimatedCalls} calls=${totals.calls} labelled=${totals.labelled} entries=${totals.entries} earlierEntries=${totals.earlierEntries} verified=${totals.verified} failed=${totals.failed}`,
		].join(" "),
		`outcome: ${report.outcome}${report.stoppedAt ? ` at ${report.stoppedAt}` : ""}`,
	];
}

function rollbackLines(report: LabelRollbackReport): string[] {
	return [
		`rollback ${report.userId} ${report.outcome} banks=${report.banks} labels=${report.labels} epochVerified=${report.epochVerified}${report.code ? ` code=${report.code}` : ""}`,
	];
}

/** What the command acts through: the library, the backup check and the output. */
export interface LabelMigrationCommandDeps {
	runLabelMigration: (
		input: { execute: boolean; userId?: string; userIds?: string[] },
		deps: Pick<LabelMigrationDeps, "signal" | "concurrency" | "onAccount">,
	) => Promise<LabelMigrationReport>;
	rollbackLabelMigration: (input: {
		userId: string;
		execute: boolean;
	}) => LabelRollbackReport;
	/** The paired backup's check against the live database (`checkPairedBackup`). */
	checkBackup: (dir: string, accounts: string[]) => PairedBackup;
	log: (line: string) => void;
	signal: AbortSignal;
}

/**
 * The command: a dry run first; with `--execute`, the paired backup checked
 * for the accounts that dry run found to label, before any write (a rollback's
 * too), then exactly those accounts labelled, in that order. Returns the exit
 * code.
 */
export async function runLabelMigrationCommand(
	args: LabelMigrationArguments,
	deps: LabelMigrationCommandDeps,
): Promise<number> {
	const { log } = deps;
	/** Checks and names the paired backup; false when the run must not write. */
	const backupReady = (accounts: string[]) => {
		if (!args.backup) return false;
		const backup = deps.checkBackup(args.backup, accounts);
		if (!backup.ok) {
			log(`backup: refused ${backup.code}`);
			return false;
		}
		log(
			`backup: sqlite=${backup.sqlite.name} bytes=${backup.sqlite.bytes} at=${backup.sqlite.modifiedAt} postgres=${backup.postgres.name} bytes=${backup.postgres.bytes} at=${backup.postgres.modifiedAt} accounts=${accounts.length}`,
		);
		return true;
	};
	if (args.mode === "rollback" && args.user) {
		const dry = deps.rollbackLabelMigration({
			userId: args.user,
			execute: false,
		});
		for (const line of rollbackLines(dry)) log(line);
		if (!args.execute || dry.outcome !== "dry_run") {
			log(JSON.stringify(dry));
			return dry.outcome === "dry_run" ? 0 : 1;
		}
		if (!backupReady([args.user])) return 1;
		const done = deps.rollbackLabelMigration({
			userId: args.user,
			execute: true,
		});
		for (const line of rollbackLines(done)) log(line);
		log(JSON.stringify(done));
		return done.outcome === "done" ? 0 : 1;
	}
	const scope = args.user ? { userId: args.user } : {};
	log("dry run:");
	const dry = await deps.runLabelMigration(
		{ ...scope, execute: false },
		{ signal: deps.signal },
	);
	for (const line of labelMigrationLines(dry)) log(line);
	if (!args.execute) {
		log(JSON.stringify(dry));
		return 0;
	}
	const accounts = dry.accounts
		.filter(({ outcome }) => outcome === "dry_run")
		.map(({ userId }) => userId);
	if (!accounts.length) {
		log("nothing to label");
		return 0;
	}
	if (!backupReady(accounts)) return 1;
	log("execute:");
	// Exactly the accounts the backup was checked for: one that became
	// eligible since the dry run waits for the next run and its own backup.
	const report = await deps.runLabelMigration(
		{ execute: true, userIds: accounts },
		{
			signal: deps.signal,
			concurrency: args.concurrency,
			onAccount: (account) => log(labelMigrationAccountLine(account)),
		},
	);
	for (const line of labelMigrationLines(report).slice(report.accounts.length))
		log(line);
	log(JSON.stringify(report));
	return report.outcome === "done" ? 0 : 1;
}
