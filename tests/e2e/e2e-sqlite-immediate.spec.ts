import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";

// The specs seed rows through the app's own services in this process, into the file their
// server writes too. The config loads tests/e2e/sqlite-immediate.cjs in every worker so
// that a transaction here takes its write lock at BEGIN instead of failing with "database
// is locked" when the server commits between its read and its write; the servers load the
// same file on their command line (tests/integration/e2e-slots.test.ts holds that half).
test("a worker's transactions take their write lock when they begin", () => {
	const transaction = Database.prototype.transaction as {
		immediateTransactions?: boolean;
	};
	expect(transaction.immediateTransactions).toBe(true);
});
