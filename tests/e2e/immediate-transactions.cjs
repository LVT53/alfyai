"use strict";
// Every better-sqlite3 transaction takes its write lock when it begins.
//
// An e2e run has two processes writing one SQLite file (the server, and the spec's own
// process, which seeds rows through the same services), and better-sqlite3 begins a
// transaction DEFERRED: a read inside it takes a snapshot, and if the other process
// commits before the transaction's first write, SQLite answers "database is locked" at
// once; the busy timeout does not apply to a snapshot that went out of date. Taking the
// write lock at BEGIN makes the other process wait for it instead (the app sets a
// ten-second busy timeout), which is what a second writer of one file should do.
//
// The app's own connection takes the same lock itself since FB-8 (src/lib/server/db/write-lock.ts,
// applied in db/index.ts). This preload stays for every other better-sqlite3 handle in an e2e
// process: the e2e servers load it with `node -r` (see e2e-servers.ts) and the Playwright config
// loads it in every worker.
//
// drizzle's better-sqlite3 session runs `client.transaction(fn)[behavior ?? "deferred"](tx)`,
// so `default` and `deferred` both become the immediate version; `exclusive` is left alone.
// Nested transactions are savepoints in better-sqlite3 whatever the behaviour.

function makeTransactionsImmediate(Database) {
	const stock = Database.prototype.transaction;
	if (stock.immediateTransactions) return Database;
	function transaction(fn) {
		const real = stock.call(this, fn);
		const immediate = real.immediate;
		const run = function (...args) {
			return immediate.apply(this, args);
		};
		return Object.defineProperties(run, {
			default: { value: immediate },
			deferred: { value: immediate },
			immediate: { value: immediate },
			exclusive: { value: real.exclusive },
			database: { value: this, enumerable: true },
		});
	}
	transaction.immediateTransactions = true;
	Database.prototype.transaction = transaction;
	return Database;
}

module.exports = { makeTransactionsImmediate };
