import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LabelMigrationReport } from "../src/lib/server/services/memory-profile/label-migration";
import {
	checkPairedBackup,
	labelMigrationLines,
	parseLabelMigrationArguments,
} from "./memory-label-migration-cli";

describe("the label migration's arguments", () => {
	it("is a dry run over every account by default", () => {
		expect(parseLabelMigrationArguments([])).toEqual({
			mode: "migrate",
			execute: false,
			concurrency: 1,
		});
		expect(parseLabelMigrationArguments(["--user", "u1"])).toMatchObject({
			execute: false,
			user: "u1",
		});
	});

	it("acts only with --execute, one account or --all, and a backup", () => {
		expect(
			parseLabelMigrationArguments([
				"--execute",
				"--all",
				"--backup",
				"/b",
				"--concurrency",
				"3",
			]),
		).toEqual({
			mode: "migrate",
			execute: true,
			all: true,
			backup: "/b",
			concurrency: 3,
		});
		expect(() => parseLabelMigrationArguments(["--execute"])).toThrow(
			"user_or_all_required",
		);
		expect(() =>
			parseLabelMigrationArguments(["--execute", "--user", "u1"]),
		).toThrow("backup_required");
		expect(() =>
			parseLabelMigrationArguments(["--user", "u1", "--all"]),
		).toThrow("user_or_all_required");
		expect(() => parseLabelMigrationArguments(["--concurrency", "4"])).toThrow(
			"invalid_concurrency",
		);
		expect(() => parseLabelMigrationArguments(["--users", "u1"])).toThrow(
			"invalid_arguments",
		);
	});

	it("rolls back one named account only", () => {
		expect(
			parseLabelMigrationArguments([
				"--rollback",
				"--user",
				"u1",
				"--execute",
				"--backup",
				"/b",
			]),
		).toMatchObject({ mode: "rollback", user: "u1", execute: true });
		expect(() => parseLabelMigrationArguments(["--rollback", "--all"])).toThrow(
			"user_required",
		);
	});
});

describe("the paired backup check", () => {
	let dir: string;
	const now = new Date("2026-11-25T02:00:00Z");
	const hoursAgo = (hours: number) =>
		new Date(now.getTime() - hours * 3_600_000);
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "label-migration-backup-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function appBackup(accounts: string[], at = hoursAgo(1)) {
		const path = join(dir, "chat-20261125T0100Z.db");
		rmSync(path, { force: true });
		const sqlite = new Database(path);
		sqlite.exec(
			"CREATE TABLE memory_accounts (user_id TEXT PRIMARY KEY); CREATE TABLE memory_fact_labels (bank_id TEXT);",
		);
		for (const id of accounts)
			sqlite.prepare("INSERT INTO memory_accounts VALUES (?)").run(id);
		sqlite.close();
		utimesSync(path, at, at);
	}
	function nativeDump(at = hoursAgo(1), name = "hindsight-20261125T0100Z.sql") {
		const path = join(dir, name);
		writeFileSync(path, "--\n-- PostgreSQL database dump\n--\n");
		utimesSync(path, at, at);
	}

	it("names both halves when they are recent, taken together, and hold every account", () => {
		appBackup(["u1", "u2"]);
		nativeDump();
		expect(checkPairedBackup(dir, ["u1", "u2"], now)).toEqual({
			ok: true,
			sqlite: expect.objectContaining({ name: "chat-20261125T0100Z.db" }),
			postgres: expect.objectContaining({
				name: "hindsight-20261125T0100Z.sql",
			}),
		});
	});

	it("accepts a custom-format or gzipped PostgreSQL dump", () => {
		appBackup(["u1"]);
		const path = join(dir, "hindsight.dump");
		writeFileSync(path, "PGDMP\u0001\u000e");
		utimesSync(path, hoursAgo(1), hoursAgo(1));
		expect(checkPairedBackup(dir, ["u1"], now)).toMatchObject({ ok: true });
		rmSync(path);
		const gz = join(dir, "hindsight.sql.gz");
		writeFileSync(gz, Buffer.from([0x1f, 0x8b, 8, 0]));
		utimesSync(gz, hoursAgo(1), hoursAgo(1));
		expect(checkPairedBackup(dir, ["u1"], now)).toMatchObject({ ok: true });
	});

	it("refuses a missing folder, a missing half, or a database that is not the app's", () => {
		expect(checkPairedBackup(join(dir, "none"), ["u1"], now)).toEqual({
			ok: false,
			code: "backup_dir_missing",
		});
		nativeDump();
		expect(checkPairedBackup(dir, ["u1"], now)).toEqual({
			ok: false,
			code: "backup_sqlite_missing",
		});
		appBackup(["u1"]);
		rmSync(join(dir, "hindsight-20261125T0100Z.sql"));
		expect(checkPairedBackup(dir, ["u1"], now)).toEqual({
			ok: false,
			code: "backup_postgres_missing",
		});
		const other = new Database(join(dir, "other.db"));
		other.exec("CREATE TABLE notes (id TEXT)");
		other.close();
		rmSync(join(dir, "chat-20261125T0100Z.db"));
		nativeDump();
		expect(checkPairedBackup(dir, ["u1"], now)).toEqual({
			ok: false,
			code: "backup_sqlite_not_app_database",
		});
	});

	it("refuses a backup missing an account to label, a stale one, or halves taken apart", () => {
		appBackup(["u1"]);
		nativeDump();
		expect(checkPairedBackup(dir, ["u1", "u2"], now)).toEqual({
			ok: false,
			code: "backup_missing_accounts",
		});
		appBackup(["u1"], hoursAgo(30));
		nativeDump(hoursAgo(30));
		expect(checkPairedBackup(dir, ["u1"], now)).toEqual({
			ok: false,
			code: "backup_stale",
		});
		appBackup(["u1"], hoursAgo(1));
		nativeDump(hoursAgo(5));
		expect(checkPairedBackup(dir, ["u1"], now)).toEqual({
			ok: false,
			code: "backup_not_paired",
		});
	});

	it("reads a folder of dumps only at its top level and its pg_dump directory", () => {
		appBackup(["u1"]);
		mkdirSync(join(dir, "hindsight-dir"));
		const toc = join(dir, "hindsight-dir", "toc.dat");
		writeFileSync(toc, "PGDMP\u0001");
		utimesSync(toc, hoursAgo(1), hoursAgo(1));
		expect(checkPairedBackup(dir, ["u1"], now)).toMatchObject({
			ok: true,
			postgres: { name: "hindsight-dir/toc.dat" },
		});
	});
});

describe("the label migration's report lines", () => {
	it("prints counts, ids and codes, one line per account and the totals", () => {
		const report: LabelMigrationReport = {
			execute: true,
			outcome: "stopped",
			stoppedAt: "u2",
			totals: {
				accounts: 3,
				skipped: { excluded: 1 },
				banks: 2,
				facts: 30,
				alreadyLabelled: 2,
				toLabel: 28,
				estimatedCalls: 3,
				calls: 3,
				labelled: 25,
				verified: 1,
				failed: 1,
			},
			accounts: [
				{
					userId: "u1",
					epoch: 0,
					outcome: "verified",
					banks: 1,
					configOneBanks: 0,
					facts: 25,
					removed: 1,
					alreadyLabelled: 0,
					toLabel: 25,
					estimatedCalls: 2,
					calls: 2,
					labelled: 25,
					byKind: { temporary: 25 },
					bySubject: { health: 25 },
					unlabelled: {},
					verification: {
						factsAccounted: true,
						factsUnchanged: true,
						publishedRowsUnchanged: true,
						fewUnlabelled: true,
						labelsPlausible: true,
					},
				},
				{
					userId: "u3",
					epoch: null,
					outcome: "skipped",
					skipped: "excluded",
					banks: 0,
					configOneBanks: 0,
					facts: 0,
					removed: 0,
					alreadyLabelled: 0,
					toLabel: 0,
					estimatedCalls: 0,
					calls: 0,
					labelled: 0,
					byKind: {},
					bySubject: {},
					unlabelled: {},
				},
			],
		};
		expect(labelMigrationLines(report)).toEqual([
			"account u1 verified banks=1 configOneBanks=0 facts=25 removed=1 alreadyLabelled=0 toLabel=25 estimatedCalls=2 calls=2 labelled=25 kind.temporary=25 subject.health=25 verification=passed",
			"account u3 skipped excluded",
			"totals accounts=3 skipped.excluded=1 banks=2 facts=30 alreadyLabelled=2 toLabel=28 estimatedCalls=3 calls=3 labelled=25 verified=1 failed=1",
			"outcome: stopped at u2",
		]);
	});
});
