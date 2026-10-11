import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

// An e2e run has two processes writing one SQLite file: the server, and the spec's own
// process, which seeds rows by calling the same services (`updateArtifactBody` and the
// like) against the same file. Those services read and then write inside a transaction,
// and better-sqlite3 begins a transaction DEFERRED: the read takes a snapshot of the
// file, and when the other process commits before the write comes, the write cannot be
// moved onto the new state and SQLite answers "database is locked" at once, without
// waiting (the busy timeout is for a lock that will be released; this one is a snapshot
// that went out of date). One whole-suite run in ten hit it (artifact-versions.spec.ts,
// 489 ms into a test, `insertVersionRow` inside `updateArtifactBody`).
//
// `makeTransactionsImmediate` makes every transaction take its write lock when it
// begins, so the other process waits (it has a ten-second busy timeout) instead of
// slipping a commit between the read and the write. The e2e servers and the Playwright
// workers load it; the app itself does not.

const require = createRequire(import.meta.url);
const {
	makeTransactionsImmediate,
} = require("../e2e/immediate-transactions.cjs");

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function twoConnections(timeoutMs = 10_000) {
	const dir = mkdtempSync(join(tmpdir(), "sqlite-immediate-"));
	dirs.push(dir);
	const path = join(dir, "t.db");
	// One class per behaviour, so patching one leaves the other as better-sqlite3 made it.
	class Stock extends Database {}
	class Immediate extends Database {}
	makeTransactionsImmediate(Immediate);
	const setup = new Database(path);
	setup.pragma("journal_mode = WAL");
	setup.exec("create table t (id integer primary key, v text)");
	setup.exec("insert into t (v) values ('first')");
	setup.close();
	const open = (Klass: typeof Database, timeout = timeoutMs) => {
		const db = new Klass(path, { timeout });
		db.pragma("journal_mode = WAL");
		return db;
	};
	return { open, Stock, Immediate };
}

describe("the transactions of the e2e processes", () => {
	it("stock: a read-then-write transaction fails when another connection commits in between (the hazard)", () => {
		const { open, Stock } = twoConnections();
		const spec = open(Stock);
		const server = open(Stock);
		const seed = spec.transaction(() => {
			spec.prepare("select count(*) from t").get(); // the snapshot
			server.prepare("insert into t (v) values ('server')").run(); // the other process commits
			spec.prepare("insert into t (v) values ('spec')").run(); // cannot move onto the new state
		});
		expect(() => seed()).toThrow(/database is locked/);
		spec.close();
		server.close();
	});

	it("immediate: the other process cannot commit in between, so the transaction completes", () => {
		const { open, Immediate } = twoConnections();
		const spec = open(Immediate);
		const server = open(Immediate, 0);
		let serverWasKeptOut = false;
		const seed = spec.transaction(() => {
			spec.prepare("select count(*) from t").get();
			try {
				server.prepare("insert into t (v) values ('server')").run();
			} catch (error) {
				serverWasKeptOut = /database is locked/.test(String(error));
			}
			spec.prepare("insert into t (v) values ('spec')").run();
		});
		expect(() => seed()).not.toThrow();
		expect(serverWasKeptOut).toBe(true);
		// ...and once the transaction is over the other process writes as it always did.
		server.prepare("insert into t (v) values ('server, after')").run();
		const rows = spec.prepare("select v from t order by id").all() as {
			v: string;
		}[];
		expect(rows.map((row) => row.v)).toEqual([
			"first",
			"spec",
			"server, after",
		]);
		spec.close();
		server.close();
	});

	it("keeps the shapes drizzle and the services use: .deferred(), .immediate(), nesting as a savepoint, rollback on a throw", () => {
		const { open, Immediate } = twoConnections();
		const db = open(Immediate);
		const inner = db.transaction(() => {
			db.prepare("insert into t (v) values ('inner')").run();
		});
		const outer = db.transaction((fail: boolean) => {
			db.prepare("insert into t (v) values ('outer')").run();
			inner();
			if (fail) throw new Error("boom");
		});
		// drizzle's better-sqlite3 session calls `transaction(fn)[behavior ?? "deferred"](tx)`.
		expect(typeof outer.deferred).toBe("function");
		expect(typeof outer.immediate).toBe("function");
		outer.deferred(false);
		expect(() => outer(true)).toThrow("boom");
		const rows = db.prepare("select v from t order by id").all() as {
			v: string;
		}[];
		expect(rows.map((row) => row.v)).toEqual(["first", "outer", "inner"]);
		db.close();
	});

	it("is applied once, however often it is loaded", () => {
		const { Immediate } = twoConnections();
		const first = Immediate.prototype.transaction;
		makeTransactionsImmediate(Immediate);
		expect(Immediate.prototype.transaction).toBe(first);
	});
});
