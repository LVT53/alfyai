import type Database from "better-sqlite3";

const MARK = Symbol.for("alfyai.takeWriteLockAtBegin");

/**
 * Every transaction on this connection takes SQLite's write lock when it BEGINs.
 *
 * better-sqlite3 begins a transaction DEFERRED, and Drizzle asks for exactly that
 * (`db.transaction(fn)` runs `client.transaction(fn).deferred(tx)`). A deferred
 * transaction takes no lock until its first statement, and a transaction that READS
 * first (every check-then-write the services make: `updateArtifactBody` reads the
 * newest version, then appends) holds a read snapshot from that point. If a second
 * writer of the file (a maintenance script, a backup, a second process) commits
 * before the first write, SQLite answers `database is locked` at once: the snapshot
 * went out of date, and the busy timeout does not apply to a snapshot that cannot
 * be upgraded. The reader's action fails for want of a lock that was free a moment
 * ago.
 *
 * Taking the write lock at BEGIN is the cure SQLite documents: the second writer
 * then waits for it (the connection's ten-second busy timeout) instead of the first
 * one failing. A transaction that only writes behaves exactly as before, since its
 * first statement took the lock anyway; one that only reads holds it for its
 * duration (readers of the WAL file are not blocked), and the app has none of
 * consequence. Nested transactions are savepoints and are untouched, and
 * `exclusive` is left as it is.
 *
 * The e2e servers load the same policy as a preload for every connection in the
 * process (`tests/e2e/immediate-transactions.cjs`); this is the app's own, on the
 * one connection it opens (`./index.ts`).
 */
export function takeWriteLockAtBegin<T extends Database.Database>(
	sqlite: T,
): T {
	const marked = sqlite as T & { [MARK]?: true };
	if (marked[MARK]) return sqlite;
	const stock = sqlite.transaction.bind(sqlite);
	const immediate = ((fn: (...args: unknown[]) => unknown) => {
		const real = stock(fn);
		function run(this: unknown, ...args: unknown[]) {
			return real.immediate.apply(this, args as never);
		}
		return Object.defineProperties(run, {
			default: { value: real.immediate },
			deferred: { value: real.immediate },
			immediate: { value: real.immediate },
			exclusive: { value: real.exclusive },
			database: { value: sqlite, enumerable: true },
		});
	}) as unknown as T["transaction"];
	sqlite.transaction = immediate;
	marked[MARK] = true;
	return sqlite;
}
