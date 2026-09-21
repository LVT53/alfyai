// `totalItems` and the rows beside it have to answer the same question.
//
// They did not. The ROWS were filtered by `isArtifactCanonicallyOwned` after
// they came back from SQLite; the COUNT ran with only
// `buildArtifactVisibilityCondition`, which is strictly wider — it admits any
// row stamped with the user's id OR sitting in one of their conversations,
// while canonical ownership refuses a `generated_output` whose conversation
// link is gone and refuses a row whose conversation belongs to someone else.
// Every such artifact was counted and never shown, so the library claimed more
// documents than it could page through and the last page came back empty.
//
// A real migrated SQLite file, so the actual WHERE clause is what is tested.

import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;
const NOW = new Date("2026-09-20T10:00:00.000Z");

function openSeedDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	return { sqlite, db };
}

function seed(db: ReturnType<typeof openSeedDatabase>["db"]) {
	db.insert(schema.users)
		.values([
			{
				id: "owner",
				email: "owner@example.com",
				passwordHash: "hash",
				createdAt: NOW,
				updatedAt: NOW,
			},
			{
				id: "stranger",
				email: "stranger@example.com",
				passwordHash: "hash",
				createdAt: NOW,
				updatedAt: NOW,
			},
		])
		.run();
	db.insert(schema.conversations)
		.values([
			{
				id: "conv-owner",
				userId: "owner",
				title: "Owner chat",
				createdAt: NOW,
				updatedAt: NOW,
			},
			{
				id: "conv-stranger",
				userId: "stranger",
				title: "Stranger chat",
				createdAt: NOW,
				updatedAt: NOW,
			},
		])
		.run();

	db.insert(schema.artifacts)
		.values([
			// Genuinely the owner's, and the only one that should be counted.
			{
				id: "owned-source",
				userId: "owner",
				type: "source_document",
				retrievalClass: "durable",
				name: "mine.pdf",
				mimeType: "application/pdf",
				sizeBytes: 10,
				conversationId: null,
				createdAt: NOW,
				updatedAt: NOW,
			},
			// Stamped with the owner's id, but LINKED into someone else's
			// conversation. Visible to the wide condition, not canonically the
			// owner's, and never rendered as one of their documents.
			{
				id: "linked-elsewhere",
				userId: "owner",
				type: "source_document",
				retrievalClass: "durable",
				name: "linked.pdf",
				mimeType: "application/pdf",
				sizeBytes: 10,
				conversationId: "conv-stranger",
				createdAt: NOW,
				updatedAt: NOW,
			},
		])
		.run();
}

describe("listLogicalDocumentsPage totals", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-logical-page-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// The module may never have been imported.
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// Best effort.
		}
	});

	it("counts exactly the documents it is willing to show", async () => {
		const { sqlite, db } = openSeedDatabase();
		seed(db);
		sqlite.close();

		const { listLogicalDocumentsPage } = await import("./documents");
		const page = await listLogicalDocumentsPage("owner", {
			offset: 0,
			limit: 20,
		});

		expect(page.documents.map((document) => document.id)).toEqual([
			"owned-source",
		]);
		// Before the shared predicate this was 2: `linked-elsewhere` was
		// counted and then filtered out of the rows.
		expect(page.totalItems).toBe(page.documents.length);
		expect(page.totalItems).toBe(1);
	});

	it("agrees with the JS predicate row by row", async () => {
		const { sqlite, db } = openSeedDatabase();
		seed(db);
		sqlite.close();

		const core = await import("./core");
		const { db: liveDb } = await import("$lib/server/db");
		const scope = await core.getArtifactOwnershipScope("owner");

		const viaSql = await liveDb
			.select({ id: schema.artifacts.id })
			.from(schema.artifacts)
			.where(
				core.buildArtifactCanonicalOwnershipCondition({
					userId: "owner",
					ownershipScope: scope,
				}),
			);
		const allRows = await liveDb.select().from(schema.artifacts);
		const viaJs = allRows.filter((row) =>
			core.isArtifactCanonicallyOwned({
				userId: "owner",
				ownershipScope: scope,
				artifact: row,
			}),
		);

		expect(viaSql.map((row) => row.id).sort()).toEqual(
			viaJs.map((row) => row.id).sort(),
		);
	});

	it("refuses a generated output whose conversation link was cleared", async () => {
		const { sqlite, db } = openSeedDatabase();
		seed(db);
		// What a conversation delete leaves behind: ON DELETE SET NULL cleared
		// the link, and canonical ownership deliberately refuses the row.
		db.insert(schema.artifacts)
			.values({
				id: "orphan-generated",
				userId: "owner",
				type: "generated_output",
				retrievalClass: "durable",
				name: "report.docx",
				mimeType:
					"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				sizeBytes: 10,
				conversationId: null,
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		sqlite.close();

		const core = await import("./core");
		const { db: liveDb } = await import("$lib/server/db");
		const scope = await core.getArtifactOwnershipScope("owner");
		const viaSql = await liveDb
			.select({ id: schema.artifacts.id })
			.from(schema.artifacts)
			.where(
				core.buildArtifactCanonicalOwnershipCondition({
					userId: "owner",
					ownershipScope: scope,
				}),
			);

		expect(viaSql.map((row) => row.id)).not.toContain("orphan-generated");
	});
});
