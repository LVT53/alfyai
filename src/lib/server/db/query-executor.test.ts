import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDatabase, type InMemoryDatabase } from "./in-memory";
import { createQueryExecutor, type QueryExecutor } from "./query-executor";
import {
	getQueryTimingSnapshot,
	resetQueryTimingForTesting,
} from "./query-instrumentation";
import { users } from "./schema";

let memory: InMemoryDatabase;
let executor: QueryExecutor;

describe("query executor", () => {
	beforeEach(() => {
		memory = createInMemoryDatabase();
		executor = createQueryExecutor(memory.db);
		resetQueryTimingForTesting();
	});

	afterEach(() => {
		memory.close();
	});

	it("runs a composed query against the bound database and returns its result", async () => {
		memory.db
			.insert(users)
			.values({
				id: "user-1",
				email: "user-1@example.com",
				passwordHash: "hash",
			})
			.run();

		const rows = await executor.run("test.selectUser", (db) =>
			db.select().from(users).where(eq(users.id, "user-1")).limit(1),
		);

		expect(rows).toHaveLength(1);
		expect(rows[0]?.email).toBe("user-1@example.com");
	});

	it("records instrumentation for a successful query", async () => {
		memory.db
			.insert(users)
			.values({
				id: "user-1",
				email: "user-1@example.com",
				passwordHash: "hash",
			})
			.run();

		await executor.run("test.instrumentedSelect", (db) =>
			db.select().from(users).where(eq(users.id, "user-1")).limit(1),
		);
		await executor.run("test.instrumentedSelect", (db) =>
			db.select().from(users).where(eq(users.id, "user-1")).limit(1),
		);

		const snapshot = getQueryTimingSnapshot();
		const sample = snapshot.find(
			(entry) => entry.label === "test.instrumentedSelect",
		);

		expect(sample).toBeDefined();
		expect(sample?.count).toBe(2);
		expect(sample?.errorCount).toBe(0);
		expect(sample?.totalMs).toBeGreaterThanOrEqual(0);
		expect(sample?.maxMs).toBeGreaterThanOrEqual(0);
	});

	it("records instrumentation and rethrows when the query fails", async () => {
		await expect(
			executor.run("test.instrumentedFailure", (db) =>
				db.insert(users).values({
					id: "user-1",
					email: "user-1@example.com",
					// Missing passwordHash violates the NOT NULL constraint,
					// so this rejects rather than resolving.
					passwordHash: null as unknown as string,
				}),
			),
		).rejects.toThrow();

		const snapshot = getQueryTimingSnapshot();
		const sample = snapshot.find(
			(entry) => entry.label === "test.instrumentedFailure",
		);

		expect(sample).toBeDefined();
		expect(sample?.count).toBe(1);
		expect(sample?.errorCount).toBe(1);
	});

	it("runs the same compose callback against two independently constructed adapters", async () => {
		const other = createInMemoryDatabase();
		try {
			const otherExecutor = createQueryExecutor(other.db);
			other.db
				.insert(users)
				.values({
					id: "user-2",
					email: "user-2@example.com",
					passwordHash: "hash",
				})
				.run();

			const rowsFromOther = await otherExecutor.run("test.crossAdapter", (db) =>
				db.select().from(users).where(eq(users.id, "user-2")).limit(1),
			);
			const rowsFromFirst = await executor.run("test.crossAdapter", (db) =>
				db.select().from(users).where(eq(users.id, "user-2")).limit(1),
			);

			expect(rowsFromOther).toHaveLength(1);
			expect(rowsFromFirst).toHaveLength(0);
		} finally {
			other.close();
		}
	});
});
