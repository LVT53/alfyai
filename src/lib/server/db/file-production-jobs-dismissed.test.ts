import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "./schema";

const TEST_DB_PATH = "./test-data/file-production-dismissed-test.db";

describe("file_production_jobs.dismissed column", () => {
	let sqlite: Database.Database;

	beforeAll(() => {
		const dbDir = dirname(TEST_DB_PATH);
		if (!existsSync(dbDir)) {
			mkdirSync(dbDir, { recursive: true });
		}
		if (existsSync(TEST_DB_PATH)) {
			unlinkSync(TEST_DB_PATH);
		}

		sqlite = new Database(TEST_DB_PATH);
		sqlite.pragma("foreign_keys = ON");
		const db = drizzle(sqlite, { schema });
		migrate(db, { migrationsFolder: "./drizzle" });
	});

	afterAll(() => {
		sqlite?.close();
		if (existsSync(TEST_DB_PATH)) {
			unlinkSync(TEST_DB_PATH);
		}
	});

	it("exists with a non-null integer default of 0, mirroring the retryable precedent", () => {
		const columns = sqlite
			.prepare("PRAGMA table_info(file_production_jobs)")
			.all() as {
			name: string;
			notnull: number;
			dflt_value: string | null;
			type: string;
		}[];

		expect(columns.map((column) => column.name)).toContain("dismissed");

		const dismissed = columns.find((column) => column.name === "dismissed");
		expect(dismissed).toEqual(
			expect.objectContaining({
				name: "dismissed",
				type: "INTEGER",
				notnull: 1,
				dflt_value: "0",
			}),
		);

		// Sanity-check the precedent column we mirrored carries the same shape.
		const retryable = columns.find((column) => column.name === "retryable");
		expect(retryable?.notnull).toBe(1);
		expect(retryable?.dflt_value).toBe("0");
	});

	it("defaults to false (0) on insert and round-trips through the schema", () => {
		const db = drizzle(sqlite, { schema });

		db.insert(schema.users)
			.values({
				id: "dismissed-roundtrip-user",
				email: "dismissed-roundtrip@example.com",
				passwordHash: "hash",
			})
			.run();
		db.insert(schema.conversations)
			.values({
				id: "dismissed-roundtrip-conv",
				userId: "dismissed-roundtrip-user",
				title: "Dismissed roundtrip",
			})
			.run();
		db.insert(schema.fileProductionJobs)
			.values({
				id: "dismissed-roundtrip-job",
				conversationId: "dismissed-roundtrip-conv",
				userId: "dismissed-roundtrip-user",
				title: "Roundtrip job",
			})
			.run();

		const row = db
			.select()
			.from(schema.fileProductionJobs)
			.where(eq(schema.fileProductionJobs.id, "dismissed-roundtrip-job"))
			.get();

		expect(row?.dismissed).toBe(false);
	});
});
