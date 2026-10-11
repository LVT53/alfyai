"use strict";
// Preload for a process that opens the e2e database: `node -r ./tests/e2e/sqlite-immediate.cjs …`.
// What it does and why: immediate-transactions.cjs.
require("./immediate-transactions.cjs").makeTransactionsImmediate(
	require("better-sqlite3"),
);
