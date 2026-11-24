import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LabelMigrationReport } from "../src/lib/server/services/memory-profile/label-migration";
import {
	checkPairedBackup,
	type LabelMigrationCommandDeps,
	labelMigrationLines,
	parseLabelMigrationArguments,
	runLabelMigrationCommand,
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

	/** What a settings file holds in these tests: never to appear in anything the check returns. */
	const SECRET = "HINDSIGHT_DB_PASSWORD=canary-never-read-this";
	const SETTINGS = [
		"alfyai-tenants.env",
		"native-tenants.env",
		"native-db.env",
		"compose.yaml",
	];
	function writeSettings(folder: string, files: string[], at: Date) {
		mkdirSync(folder, { recursive: true });
		for (const file of files) {
			const path = join(folder, file);
			writeFileSync(path, `${SECRET}\n`, { mode: 0o600 });
			utimesSync(path, at, at);
		}
	}
	/** The bundle as production takes it: `tar -cf <dir>/deployment-files.tar ./*.env ./*.yaml`. */
	function settingsTar(
		at = hoursAgo(1),
		files = SETTINGS,
		name = "deployment-files.tar",
	) {
		const source = mkdtempSync(join(tmpdir(), "label-migration-settings-"));
		try {
			writeSettings(source, files, at);
			const path = join(dir, name);
			execFileSync(
				"tar",
				["-cf", path, "-C", source, ...files.map((file) => `./${file}`)],
				{ env: { ...process.env, COPYFILE_DISABLE: "1" } },
			);
			utimesSync(path, at, at);
			return path;
		} finally {
			rmSync(source, { recursive: true, force: true });
		}
	}
	function settingsFolder(
		at = hoursAgo(1),
		files = SETTINGS,
		name = "deployment-files",
	) {
		const folder = join(dir, name);
		writeSettings(folder, files, at);
		return folder;
	}
	const canRefuseUnreadable = process.getuid?.() !== 0;

	it("names both halves and the settings bundle when they are recent, taken together, and hold every account", () => {
		appBackup(["u1", "u2"]);
		nativeDump();
		settingsTar();
		expect(checkPairedBackup(dir, ["u1", "u2"], now)).toEqual({
			ok: true,
			sqlite: expect.objectContaining({ name: "chat-20261125T0100Z.db" }),
			postgres: expect.objectContaining({
				name: "hindsight-20261125T0100Z.sql",
			}),
			bundle: {
				name: "deployment-files.tar",
				bytes: statSync(join(dir, "deployment-files.tar")).size,
				modifiedAt: hoursAgo(1).toISOString(),
				envFiles: 3,
			},
		});
	});

	describe("the settings bundle", () => {
		beforeEach(() => {
			appBackup(["u1"]);
			nativeDump();
		});

		it("is counted by its .env files, and the check never carries a settings value out", () => {
			settingsTar();
			const result = checkPairedBackup(dir, ["u1"], now);
			expect(result).toMatchObject({ ok: true, bundle: { envFiles: 3 } });
			expect(JSON.stringify(result)).not.toContain("canary");
			expect(JSON.stringify(result)).not.toContain("HINDSIGHT");
		});

		it("is also accepted as a folder of settings files", () => {
			settingsFolder();
			const result = checkPairedBackup(dir, ["u1"], now);
			expect(result).toMatchObject({
				ok: true,
				bundle: {
					name: "deployment-files/",
					envFiles: 3,
					modifiedAt: hoursAgo(1).toISOString(),
				},
			});
			expect(JSON.stringify(result)).not.toContain("canary");
		});

		it("is read by its tar headers alone, whatever an entry claims to hold", () => {
			// One header for "huge.env" that claims 8 GiB, in a file of 512 bytes:
			// the count comes from the header, and nothing past it is read.
			const header = Buffer.alloc(512);
			header.write("huge.env", 0, "ascii");
			header.write("77777777777", 124, "ascii");
			header.write("0", 156, "ascii");
			const path = join(dir, "settings.tar");
			writeFileSync(path, header);
			utimesSync(path, hoursAgo(1), hoursAgo(1));
			expect(checkPairedBackup(dir, ["u1"], now)).toMatchObject({
				ok: true,
				bundle: { name: "settings.tar", envFiles: 1, bytes: 512 },
			});
		});

		it("is refused when the folder holds the pair alone", () => {
			expect(checkPairedBackup(dir, ["u1"], now)).toEqual({
				ok: false,
				code: "backup_secret_bundle_missing",
			});
		});

		it("is refused when a tar holds no .env file, or is no tar, or a folder holds none", () => {
			settingsTar(hoursAgo(1), ["compose.yaml", "notes.txt"]);
			expect(checkPairedBackup(dir, ["u1"], now)).toEqual({
				ok: false,
				code: "backup_secret_bundle_missing",
			});
			writeFileSync(join(dir, "notes.tar"), "just some notes, not a tar\n");
			settingsFolder(hoursAgo(1), ["compose.yaml"], "yaml-only");
			// A pg_dump directory (toc.dat, numbered files) is not a settings folder.
			mkdirSync(join(dir, "dump-dir"));
			writeFileSync(join(dir, "dump-dir", "3011.dat.gz"), "x");
			expect(checkPairedBackup(dir, ["u1"], now)).toEqual({
				ok: false,
				code: "backup_secret_bundle_missing",
			});
		});

		it.skipIf(!canRefuseUnreadable)(
			"is refused when the app user cannot read it",
			() => {
				const tar = settingsTar();
				chmodSync(tar, 0o000);
				try {
					expect(checkPairedBackup(dir, ["u1"], now)).toEqual({
						ok: false,
						code: "backup_secret_bundle_unreadable",
					});
				} finally {
					chmodSync(tar, 0o600);
				}
				rmSync(tar);
				const folder = settingsFolder();
				chmodSync(join(folder, "native-db.env"), 0o000);
				try {
					expect(checkPairedBackup(dir, ["u1"], now)).toEqual({
						ok: false,
						code: "backup_secret_bundle_unreadable",
					});
				} finally {
					chmodSync(join(folder, "native-db.env"), 0o600);
				}
			},
		);

		it("is taken from a readable copy when another one cannot be read", () => {
			if (!canRefuseUnreadable) return;
			const tar = settingsTar(hoursAgo(1), SETTINGS, "root-owned.tar");
			chmodSync(tar, 0o000);
			try {
				settingsFolder();
				expect(checkPairedBackup(dir, ["u1"], now)).toMatchObject({
					ok: true,
					bundle: { name: "deployment-files/" },
				});
			} finally {
				chmodSync(tar, 0o600);
			}
		});

		it("is refused when older than the pair may be, or taken more than two hours from it", () => {
			settingsTar(hoursAgo(5));
			expect(checkPairedBackup(dir, ["u1"], now)).toEqual({
				ok: false,
				code: "backup_secret_bundle_stale",
			});
			// Inside the four hours, but 2.5 hours before the pair.
			settingsTar(hoursAgo(3.5));
			expect(checkPairedBackup(dir, ["u1"], now)).toEqual({
				ok: false,
				code: "backup_secret_bundle_not_paired",
			});
			// Exactly two hours from the pair, inside the window: accepted.
			settingsTar(hoursAgo(3));
			expect(checkPairedBackup(dir, ["u1"], now)).toMatchObject({ ok: true });
		});

		it("is judged by the oldest settings file of a folder", () => {
			const folder = settingsFolder();
			const old = hoursAgo(6);
			utimesSync(join(folder, "native-db.env"), old, old);
			expect(checkPairedBackup(dir, ["u1"], now)).toEqual({
				ok: false,
				code: "backup_secret_bundle_stale",
			});
		});

		it("comes last: a refused pair names its own code first", () => {
			rmSync(join(dir, "hindsight-20261125T0100Z.sql"));
			expect(checkPairedBackup(dir, ["u1"], now)).toEqual({
				ok: false,
				code: "backup_postgres_missing",
			});
		});
	});

	it("accepts a custom-format or gzipped PostgreSQL dump", () => {
		appBackup(["u1"]);
		settingsTar();
		const path = join(dir, "hindsight.dump");
		writeFileSync(path, "PGDMP\u0001\u000e");
		utimesSync(path, hoursAgo(1), hoursAgo(1));
		expect(checkPairedBackup(dir, ["u1"], now)).toMatchObject({ ok: true });
		rmSync(path);
		const gz = join(dir, "hindsight.sql.gz");
		writeFileSync(gz, gzipSync("--\n-- PostgreSQL database dump\n--\n"));
		utimesSync(gz, hoursAgo(1), hoursAgo(1));
		expect(checkPairedBackup(dir, ["u1"], now)).toMatchObject({ ok: true });
	});

	it("inflates a gzipped file and refuses one that is not a PostgreSQL dump", () => {
		appBackup(["u1"]);
		const gz = join(dir, "hindsight.sql.gz");
		writeFileSync(gz, gzipSync("just some notes"));
		utimesSync(gz, hoursAgo(1), hoursAgo(1));
		expect(checkPairedBackup(dir, ["u1"], now)).toEqual({
			ok: false,
			code: "backup_postgres_missing",
		});
		// A gzip header alone is not a dump either.
		writeFileSync(gz, Buffer.from([0x1f, 0x8b, 8, 0]));
		utimesSync(gz, hoursAgo(1), hoursAgo(1));
		expect(checkPairedBackup(dir, ["u1"], now)).toEqual({
			ok: false,
			code: "backup_postgres_missing",
		});
	});

	it("refuses a backup more than four hours old", () => {
		appBackup(["u1"], hoursAgo(5));
		nativeDump(hoursAgo(5));
		expect(checkPairedBackup(dir, ["u1"], now)).toEqual({
			ok: false,
			code: "backup_stale",
		});
	});

	it("skips a dangling link in the folder", () => {
		appBackup(["u1"]);
		nativeDump();
		settingsTar();
		symlinkSync(join(dir, "gone.db"), join(dir, "dangling.db"));
		expect(checkPairedBackup(dir, ["u1"], now)).toMatchObject({ ok: true });
	});

	/** An app database with the columns the comparison reads, for one account. */
	function appDatabase(
		path: string,
		account: {
			epoch?: number;
			unverified?: number | null;
			generation?: string;
			classifierLabels?: number;
		} = {},
	) {
		rmSync(path, { force: true });
		const sqlite = new Database(path);
		sqlite.exec(`
			CREATE TABLE memory_accounts (user_id TEXT PRIMARY KEY, epoch INTEGER, labels_unverified_epoch INTEGER);
			CREATE TABLE memory_banks (id TEXT PRIMARY KEY, user_id TEXT, epoch INTEGER, status TEXT, generation TEXT);
			CREATE TABLE memory_fact_labels (bank_id TEXT, native_fact_id TEXT, origin TEXT);
		`);
		const epoch = account.epoch ?? 0;
		sqlite
			.prepare("INSERT INTO memory_accounts VALUES ('u1', ?, ?)")
			.run(
				epoch,
				account.unverified === undefined ? epoch : account.unverified,
			);
		sqlite
			.prepare("INSERT INTO memory_banks VALUES ('b1', 'u1', ?, 'ready', ?)")
			.run(epoch, account.generation ?? "g1");
		for (let i = 0; i < (account.classifierLabels ?? 0); i++)
			sqlite
				.prepare(
					"INSERT INTO memory_fact_labels VALUES ('b1', ?, 'classifier')",
				)
				.run(`f${i}`);
		sqlite.close();
		return path;
	}

	it("compares the backup with the live database for the accounts to label", () => {
		const live = appDatabase(
			join(dir, "..", `${dir.split("/").pop()}-live.db`),
		);
		try {
			appDatabase(join(dir, "chat-20261125T0100Z.db"));
			utimesSync(join(dir, "chat-20261125T0100Z.db"), hoursAgo(1), hoursAgo(1));
			nativeDump();
			settingsTar();
			expect(checkPairedBackup(dir, ["u1"], now, live)).toMatchObject({
				ok: true,
			});
			for (const differs of [
				{ epoch: 1 },
				{ unverified: null },
				{ generation: "g2" },
				{ classifierLabels: 3 },
			]) {
				appDatabase(join(dir, "chat-20261125T0100Z.db"), differs);
				utimesSync(
					join(dir, "chat-20261125T0100Z.db"),
					hoursAgo(1),
					hoursAgo(1),
				);
				expect(checkPairedBackup(dir, ["u1"], now, live)).toEqual({
					ok: false,
					code: "backup_differs_from_live",
				});
			}
		} finally {
			rmSync(live, { force: true });
		}
	});

	it("refuses the live database itself, also through a link", () => {
		const live = appDatabase(join(dir, "chat.db"));
		utimesSync(live, hoursAgo(1), hoursAgo(1));
		nativeDump();
		expect(checkPairedBackup(dir, ["u1"], now, live)).toEqual({
			ok: false,
			code: "backup_is_live_database",
		});
		const elsewhere = mkdtempSync(join(tmpdir(), "label-migration-link-"));
		try {
			symlinkSync(live, join(elsewhere, "chat-backup.db"));
			const dump = join(elsewhere, "hindsight.sql");
			writeFileSync(dump, "--\n-- PostgreSQL database dump\n--\n");
			utimesSync(dump, hoursAgo(1), hoursAgo(1));
			expect(checkPairedBackup(elsewhere, ["u1"], now, live)).toEqual({
				ok: false,
				code: "backup_is_live_database",
			});
		} finally {
			rmSync(elsewhere, { recursive: true, force: true });
		}
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
		settingsTar();
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
				entries: 4,
				earlierEntries: 1,
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
					whole: {
						factsByKind: { temporary: 25, lasting: 2 },
						factsBySubject: { health: 25, other: 2 },
						entries: 4,
						entriesByKind: { temporary: 3, unlabelled: 1 },
						entriesBySubject: { health: 3, unlabelled: 1 },
						earlierEntries: 1,
					},
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
			"account u1 verified banks=1 configOneBanks=0 facts=25 removed=1 alreadyLabelled=0 toLabel=25 estimatedCalls=2 calls=2 labelled=25 kind.temporary=25 subject.health=25 account.facts.kind.temporary=25 account.facts.kind.lasting=2 account.facts.subject.health=25 account.facts.subject.other=2 entries=4 earlierEntries=1 entries.kind.temporary=3 entries.kind.unlabelled=1 entries.subject.health=3 entries.subject.unlabelled=1 verification=passed",
			"account u3 skipped excluded",
			"totals accounts=3 skipped.excluded=1 banks=2 facts=30 alreadyLabelled=2 toLabel=28 estimatedCalls=3 calls=3 labelled=25 entries=4 earlierEntries=1 verified=1 failed=1",
			"outcome: stopped at u2",
		]);
	});
});

describe("the command", () => {
	/** Fakes for the library and the backup check, recording what ran in which order. */
	function fakes(backupOk = true) {
		const steps: string[] = [];
		const lines: string[] = [];
		const account = (userId: string, outcome: "dry_run" | "skipped") => ({
			userId,
			epoch: 0,
			outcome,
			banks: 1,
			configOneBanks: 0,
			facts: 2,
			removed: 0,
			alreadyLabelled: 0,
			toLabel: 2,
			estimatedCalls: 1,
			calls: 0,
			labelled: 0,
			byKind: {},
			bySubject: {},
			unlabelled: {},
		});
		const deps: LabelMigrationCommandDeps = {
			runLabelMigration: async (input) => {
				steps.push(
					input.execute
						? `execute ${JSON.stringify(input.userIds)}`
						: `dry run ${input.userId ?? "all"}`,
				);
				return {
					execute: input.execute,
					outcome: input.execute ? "done" : "dry_run",
					totals: {
						accounts: 3,
						skipped: {},
						banks: 0,
						facts: 0,
						alreadyLabelled: 0,
						toLabel: 0,
						estimatedCalls: 0,
						calls: 0,
						labelled: 0,
						verified: 0,
						failed: 0,
						entries: 0,
						earlierEntries: 0,
					},
					accounts: [
						account("u1", "dry_run"),
						account("u2", "skipped"),
						account("u3", "dry_run"),
					],
				};
			},
			rollbackLabelMigration: (input) => {
				steps.push(`rollback ${input.execute ? "execute" : "dry run"}`);
				return {
					userId: input.userId,
					execute: input.execute,
					outcome: input.execute ? "done" : "dry_run",
					banks: 1,
					labels: 2,
					epochVerified: true,
				};
			},
			checkBackup: (_dir, accounts) => {
				steps.push(`backup ${JSON.stringify(accounts)}`);
				return backupOk
					? {
							ok: true,
							sqlite: { name: "chat.db", bytes: 1, modifiedAt: "t" },
							postgres: { name: "pg.sql", bytes: 1, modifiedAt: "t" },
							bundle: {
								name: "deployment-files.tar",
								bytes: 2,
								modifiedAt: "t",
								envFiles: 3,
							},
						}
					: { ok: false, code: "backup_stale" };
			},
			log: (line) => lines.push(line),
			signal: new AbortController().signal,
		};
		return { steps, lines, deps };
	}
	const all = parseLabelMigrationArguments([
		"--execute",
		"--all",
		"--backup",
		"/b",
	]);

	it("--all labels exactly the accounts the backup was checked for, after the check", async () => {
		const { steps, deps } = fakes();
		expect(await runLabelMigrationCommand(all, deps)).toBe(0);
		expect(steps).toEqual([
			"dry run all",
			'backup ["u1","u3"]',
			'execute ["u1","u3"]',
		]);
	});

	it("writes nothing when the backup is refused, a rollback included", async () => {
		const refused = fakes(false);
		expect(await runLabelMigrationCommand(all, refused.deps)).toBe(1);
		expect(refused.steps).toEqual(["dry run all", 'backup ["u1","u3"]']);
		const rollback = fakes(false);
		const args = parseLabelMigrationArguments([
			"--rollback",
			"--user",
			"u1",
			"--execute",
			"--backup",
			"/b",
		]);
		expect(await runLabelMigrationCommand(args, rollback.deps)).toBe(1);
		expect(rollback.steps).toEqual(["rollback dry run", 'backup ["u1"]']);
		const ok = fakes();
		expect(await runLabelMigrationCommand(args, ok.deps)).toBe(0);
		expect(ok.steps).toEqual([
			"rollback dry run",
			'backup ["u1"]',
			"rollback execute",
		]);
	});

	it("names the whole backup it checked, the settings bundle by name, size and count only", async () => {
		const { lines, deps } = fakes();
		expect(await runLabelMigrationCommand(all, deps)).toBe(0);
		expect(lines).toContain(
			"backup: sqlite=chat.db bytes=1 at=t postgres=pg.sql bytes=1 at=t bundle=deployment-files.tar bytes=2 env=3 at=t accounts=2",
		);
	});

	it("says which part of the backup it refused", async () => {
		const { lines, deps } = fakes();
		deps.checkBackup = () => ({
			ok: false,
			code: "backup_secret_bundle_missing",
		});
		expect(await runLabelMigrationCommand(all, deps)).toBe(1);
		expect(lines).toContain("backup: refused backup_secret_bundle_missing");
	});

	it("a dry run checks no backup and writes nothing", async () => {
		const { steps, deps } = fakes();
		expect(
			await runLabelMigrationCommand(parseLabelMigrationArguments([]), deps),
		).toBe(0);
		expect(steps).toEqual(["dry run all"]);
	});
});
