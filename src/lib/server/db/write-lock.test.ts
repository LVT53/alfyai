import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { takeWriteLockAtBegin } from "./write-lock";

// Two writers of one SQLite file (FG's finding 3): the server, and a second
// process (a maintenance script, a backup, the e2e specs' own seeding). The
// second writer is a real one here, a worker thread with its own connection, so
// "waits for the lock" and "gets `database is locked`" are what happens, not
// what a mock says.

const SECOND_WRITER = `
const { workerData, parentPort } = require("node:worker_threads");
const Database = require("better-sqlite3");
const flags = new Int32Array(workerData.shared);
const db = new Database(workerData.file);
db.pragma("busy_timeout = 5000");
// flags[0] = 1: the first writer has read and asks for the second write.
Atomics.wait(flags, 0, 0);
try {
	db.prepare("insert into notes (text) values ('second writer')").run();
	Atomics.store(flags, 1, 1);
	Atomics.notify(flags, 1);
	parentPort.postMessage({ ok: true });
} catch (error) {
	Atomics.store(flags, 1, 2);
	Atomics.notify(flags, 1);
	parentPort.postMessage({ ok: false, message: String(error && error.message) });
}
db.close();
`;

interface SecondWriter {
	/** Tells the second writer to write now. */
	go(): void;
	/** Blocks (this thread) until it has finished, or `ms` passed. "not-equal" / "ok": it has finished. */
	waitUntilDone(ms: number): "ok" | "not-equal" | "timed-out";
	outcome: Promise<{ ok: boolean; message?: string }>;
}

function startSecondWriter(file: string): SecondWriter {
	const shared = new SharedArrayBuffer(8);
	const flags = new Int32Array(shared);
	const worker = new Worker(SECOND_WRITER, {
		eval: true,
		workerData: { file, shared },
	});
	const outcome = new Promise<{ ok: boolean; message?: string }>(
		(resolve, reject) => {
			worker.once("message", resolve);
			worker.once("error", reject);
		},
	).finally(() => void worker.terminate());
	return {
		go() {
			Atomics.store(flags, 0, 1);
			Atomics.notify(flags, 0);
		},
		waitUntilDone(ms) {
			return Atomics.wait(flags, 1, 0, ms);
		},
		outcome,
	};
}

let directory: string;
let file: string;
let first: Database.Database;

function openFirstWriter(): Database.Database {
	const handle = new Database(file);
	handle.pragma("journal_mode = WAL");
	// The app's own timeout is ten seconds; a test only needs to be longer than the wait it makes.
	handle.pragma("busy_timeout = 5000");
	return handle;
}

function rows(): string[] {
	const reader = new Database(file, { readonly: true });
	try {
		return (
			reader.prepare("select text from notes order by id").all() as {
				text: string;
			}[]
		).map((row) => row.text);
	} finally {
		reader.close();
	}
}

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "alfyai-write-lock-"));
	file = join(directory, "chat.db");
	first = openFirstWriter();
	first.exec(
		"create table notes (id integer primary key autoincrement, text text not null)",
	);
});

afterEach(() => {
	first.close();
	rmSync(directory, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("a transaction that reads before it writes, with a second writer on the file", () => {
	it("is what fails by default: the read went out of date, so the first writer's write is `database is locked` at once", () => {
		const second = startSecondWriter(file);
		const readThenWrite = first.transaction(() => {
			first.prepare("select count(*) as n from notes").get();
			second.go();
			// The second writer is not held back by a read: it commits first.
			expect(second.waitUntilDone(5000)).toBe("ok");
			first.prepare("insert into notes (text) values ('first writer')").run();
		});

		expect(() => readThenWrite()).toThrow(/database is locked/);
		// Only the second writer's row is there: the user's action was lost.
		expect(rows()).toEqual(["second writer"]);
		return second.outcome.then((outcome) => expect(outcome.ok).toBe(true));
	});

	it("takes the write lock when it begins instead: the second writer waits its turn, and both writes land", async () => {
		takeWriteLockAtBegin(first);
		const second = startSecondWriter(file);
		const readThenWrite = first.transaction(() => {
			first.prepare("select count(*) as n from notes").get();
			second.go();
			// Give the second writer time to reach the lock: it must still be waiting.
			expect(second.waitUntilDone(400)).toBe("timed-out");
			first.prepare("insert into notes (text) values ('first writer')").run();
		});

		expect(() => readThenWrite()).not.toThrow();
		const outcome = await second.outcome;
		expect(outcome).toEqual({ ok: true });
		expect(rows()).toEqual(["first writer", "second writer"]);
	});

	it("is the behaviour of every spelling a caller can pick (Drizzle runs `deferred` for a plain transaction), and keeps the handle and `exclusive`", () => {
		takeWriteLockAtBegin(first);
		const other = new Database(file);
		other.pragma("busy_timeout = 0");
		const answers: Array<string | undefined> = [];
		const probe = first.transaction(() => {
			try {
				other.prepare("insert into notes (text) values ('other')").run();
				answers.push("let in");
			} catch (error) {
				answers.push((error as { code?: string }).code);
			}
		});
		try {
			probe();
			probe.default();
			probe.deferred();
			probe.immediate();
		} finally {
			other.close();
		}
		// Inside every one of them the file's write lock was already this connection's.
		expect(answers).toEqual([
			"SQLITE_BUSY",
			"SQLITE_BUSY",
			"SQLITE_BUSY",
			"SQLITE_BUSY",
		]);
		expect(typeof probe.exclusive).toBe("function");
		expect((probe as unknown as { database: unknown }).database).toBe(first);
		expect(rows()).toEqual([]);
	});

	it("is applied to the connection the app opens", async () => {
		// The app's own handle (`$lib/server/db`), opened on this file.
		const previous = process.env.DATABASE_PATH;
		process.env.DATABASE_PATH = file;
		vi.resetModules();
		try {
			const { sqlite } = await import("./index");
			const second = startSecondWriter(file);
			const readThenWrite = sqlite.transaction(() => {
				sqlite.prepare("select count(*) as n from notes").get();
				second.go();
				expect(second.waitUntilDone(400)).toBe("timed-out");
				sqlite.prepare("insert into notes (text) values ('app')").run();
			});
			expect(() => readThenWrite.deferred()).not.toThrow();
			expect(await second.outcome).toEqual({ ok: true });
			expect(rows()).toEqual(["app", "second writer"]);
			sqlite.close();
		} finally {
			if (previous === undefined) delete process.env.DATABASE_PATH;
			else process.env.DATABASE_PATH = previous;
		}
	});
});
