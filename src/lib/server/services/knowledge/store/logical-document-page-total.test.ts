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

	// Slice 7: a second source (`type: "artifact"`, Feature 2's Document/App/
	// Canvas/Slides family) is merged into the same page. Merging a second
	// source is a second chance for the rows/totalItems disagreement this file
	// exists to prevent, so the mixed-row-type case lives here, not in a new
	// file.
	it("counts a mix of an upload, a produced file and two artifact-family rows as one total", async () => {
		const { sqlite, db } = openSeedDatabase();
		seed(db);
		db.insert(schema.artifacts)
			.values([
				// A produced file: `generated_output`, durable, with the
				// sourceChatFileId marker `hasGeneratedFileSource` requires.
				{
					id: "owned-file",
					userId: "owner",
					type: "generated_output",
					retrievalClass: "durable",
					name: "report.docx",
					mimeType:
						"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
					sizeBytes: 10,
					conversationId: "conv-owner",
					metadataJson: JSON.stringify({ sourceChatFileId: "chat-file-1" }),
					createdAt: NOW,
					updatedAt: NOW,
				},
				// Two artifact-family rows (Feature 2, slice 0): `type: "artifact"`,
				// kind carried in `metadata_json.artifactType`.
				{
					id: "owned-canvas",
					userId: "owner",
					type: "artifact",
					retrievalClass: "durable",
					name: "Vienna trip board",
					conversationId: "conv-owner",
					metadataJson: JSON.stringify({
						artifactType: "canvas",
						title: "Vienna trip board",
					}),
					createdAt: NOW,
					updatedAt: NOW,
				},
				{
					id: "owned-document",
					userId: "owner",
					type: "artifact",
					retrievalClass: "durable",
					name: "Saturday plan",
					conversationId: "conv-owner",
					metadataJson: JSON.stringify({
						artifactType: "document",
						title: "Saturday plan",
					}),
					createdAt: NOW,
					updatedAt: NOW,
				},
			])
			.run();
		sqlite.close();

		const { listLogicalDocumentsPage } = await import("./documents");

		const fullPage = await listLogicalDocumentsPage("owner", {
			includeGeneratedOutputs: true,
			offset: 0,
			limit: 20,
		});
		expect(fullPage.totalItems).toBe(4);
		expect(fullPage.documents).toHaveLength(4);
		expect(fullPage.documents.map((document) => document.id).sort()).toEqual(
			["owned-canvas", "owned-document", "owned-file", "owned-source"].sort(),
		);

		// A limit-1 walk must visit each of the four exactly once — the same
		// discipline the file's other cases already hold the single-source path
		// to, now proven across the merged two-source page.
		const visited: string[] = [];
		for (let offset = 0; offset < 4; offset += 1) {
			const page = await listLogicalDocumentsPage("owner", {
				includeGeneratedOutputs: true,
				offset,
				limit: 1,
			});
			expect(page.totalItems).toBe(4);
			expect(page.documents).toHaveLength(1);
			visited.push(page.documents[0].id);
		}
		expect(visited.sort()).toEqual(
			["owned-canvas", "owned-document", "owned-file", "owned-source"].sort(),
		);
	});

	it("tallies countsByKind before kindFilter narrows the page, and never moves the other chips' counts", async () => {
		const { sqlite, db } = openSeedDatabase();
		seed(db);
		db.insert(schema.artifacts)
			.values([
				{
					id: "owned-file",
					userId: "owner",
					type: "generated_output",
					retrievalClass: "durable",
					name: "report.docx",
					sizeBytes: 10,
					conversationId: "conv-owner",
					metadataJson: JSON.stringify({ sourceChatFileId: "chat-file-1" }),
					createdAt: NOW,
					updatedAt: NOW,
				},
				{
					id: "owned-canvas",
					userId: "owner",
					type: "artifact",
					retrievalClass: "durable",
					name: "Vienna trip board",
					conversationId: "conv-owner",
					metadataJson: JSON.stringify({
						artifactType: "canvas",
						title: "Vienna trip board",
					}),
					createdAt: NOW,
					updatedAt: NOW,
				},
				{
					id: "owned-document",
					userId: "owner",
					type: "artifact",
					retrievalClass: "durable",
					name: "Saturday plan",
					conversationId: "conv-owner",
					metadataJson: JSON.stringify({
						artifactType: "document",
						title: "Saturday plan",
					}),
					createdAt: NOW,
					updatedAt: NOW,
				},
			])
			.run();
		sqlite.close();

		const { listLogicalDocumentsPage } = await import("./documents");

		const unfiltered = await listLogicalDocumentsPage("owner", {
			includeGeneratedOutputs: true,
			offset: 0,
			limit: 20,
		});
		// "mine.pdf" (owned-source) and "report.docx" (owned-file) both fold into
		// "uploaded" — ruling 46 as corrected: a produced file groups under
		// Uploaded with its file-format pill, there is no "file" bucket.
		expect(unfiltered.countsByKind).toEqual({
			uploaded: 2,
			document: 1,
			canvas: 1,
			app: 0,
			slides: 0,
		});

		const canvasOnly = await listLogicalDocumentsPage("owner", {
			includeGeneratedOutputs: true,
			offset: 0,
			limit: 20,
			kindFilter: "canvas",
		});
		expect(canvasOnly.documents.map((document) => document.id)).toEqual([
			"owned-canvas",
		]);
		expect(canvasOnly.totalItems).toBe(1);
		// The chip's own click must never move the OTHER chips' numbers.
		expect(canvasOnly.countsByKind).toEqual(unfiltered.countsByKind);
	});

	it("narrows an artifact-family row by name, and a query never matches by its kind alone", async () => {
		const { sqlite, db } = openSeedDatabase();
		seed(db);
		db.insert(schema.artifacts)
			.values({
				id: "owned-canvas",
				userId: "owner",
				type: "artifact",
				retrievalClass: "durable",
				name: "Vienna trip board",
				conversationId: "conv-owner",
				metadataJson: JSON.stringify({
					artifactType: "canvas",
					title: "Vienna trip board",
				}),
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		sqlite.close();

		const { listLogicalDocumentsPage } = await import("./documents");

		const byName = await listLogicalDocumentsPage("owner", {
			includeGeneratedOutputs: true,
			query: "vienna",
			offset: 0,
			limit: 20,
		});
		expect(byName.documents.map((document) => document.id)).toEqual([
			"owned-canvas",
		]);

		const byKindWord = await listLogicalDocumentsPage("owner", {
			includeGeneratedOutputs: true,
			query: "canvas",
			offset: 0,
			limit: 20,
		});
		expect(byKindWord.documents.map((document) => document.id)).not.toContain(
			"owned-canvas",
		);
	});

	// RV-7: the merged sort hardcodes `compareKnowledgeDocumentItems(...,
	// "date", "desc")` as the search tie-break whenever `query` is set,
	// regardless of the caller's own `sortKey`/`sortDirection`. The retired
	// single-source comparator this slice replaced fell through to the
	// CALLER's sortKey whenever two scores tied during a search — exactly the
	// "byte-identical below the new branch" promise this file's own Global
	// Constraints make — so this silently changed ordering for every row, old
	// and new alike, the moment two results tie on relevance.
	it("keeps the caller's own sortKey as the search tie-break, not a hardcoded date order", async () => {
		const { sqlite, db } = openSeedDatabase();
		seed(db);
		db.insert(schema.artifacts)
			.values([
				// Identical name -> identical relevance score for a "weekly" query
				// (`scoreArtifactFamilyRowForSearch` reads `name` only), so any
				// order difference below comes from the TIE-BREAK, not the score.
				{
					id: "owned-app",
					userId: "owner",
					type: "artifact",
					retrievalClass: "durable",
					name: "Weekly board",
					conversationId: "conv-owner",
					metadataJson: JSON.stringify({ artifactType: "app" }),
					createdAt: new Date(NOW.getTime() - 60_000), // older
					updatedAt: NOW,
				},
				{
					id: "owned-canvas",
					userId: "owner",
					type: "artifact",
					retrievalClass: "durable",
					name: "Weekly board",
					conversationId: "conv-owner",
					metadataJson: JSON.stringify({ artifactType: "canvas" }),
					createdAt: NOW, // newer
					updatedAt: NOW,
				},
			])
			.run();
		sqlite.close();

		const { listLogicalDocumentsPage } = await import("./documents");

		const page = await listLogicalDocumentsPage("owner", {
			includeGeneratedOutputs: true,
			query: "weekly",
			sortKey: "type",
			sortDirection: "asc",
			offset: 0,
			limit: 20,
		});

		// Both rows tie on search score; sorted by TYPE ascending ("app" before
		// "canvas", per the caller's own request) "owned-app" must lead,
		// regardless of which of the two is newer.
		expect(page.documents.map((document) => document.id)).toEqual([
			"owned-app",
			"owned-canvas",
		]);
	});

	// Ruling 60: the Documents tab's second-tier filter. `countsByFileFamily`
	// is tallied over the Files ("uploaded") bucket only, on the SAME
	// query-filtered set `countsByKind` uses — before either `kindFilter` or
	// `fileFamilyFilter` narrows the page — so switching families never moves
	// a sibling family's own number, exactly like the existing kind chips.
	it("tallies countsByFileFamily over the Files bucket before fileFamilyFilter narrows it, and the filter narrows to that family", async () => {
		const { sqlite, db } = openSeedDatabase();
		seed(db);
		db.insert(schema.artifacts)
			.values([
				// A second uploaded PDF, so the "pdf" family count needs a real
				// tally rather than happening to equal 1 by coincidence.
				{
					id: "owned-pdf-2",
					userId: "owner",
					type: "source_document",
					retrievalClass: "durable",
					name: "second.pdf",
					mimeType: "application/pdf",
					sizeBytes: 10,
					conversationId: null,
					createdAt: NOW,
					updatedAt: NOW,
				},
				// A produced Word file — a generated_output groups under Files too.
				{
					id: "owned-word",
					userId: "owner",
					type: "generated_output",
					retrievalClass: "durable",
					name: "report.docx",
					mimeType:
						"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
					sizeBytes: 10,
					conversationId: "conv-owner",
					metadataJson: JSON.stringify({ sourceChatFileId: "chat-file-1" }),
					createdAt: NOW,
					updatedAt: NOW,
				},
				// An artifact-family Canvas row: never a Files row, and must never
				// be counted in any file family regardless of its own name/mime.
				{
					id: "owned-canvas",
					userId: "owner",
					type: "artifact",
					retrievalClass: "durable",
					name: "Vienna trip board",
					conversationId: "conv-owner",
					metadataJson: JSON.stringify({
						artifactType: "canvas",
						title: "Vienna trip board",
					}),
					createdAt: NOW,
					updatedAt: NOW,
				},
			])
			.run();
		sqlite.close();

		const { listLogicalDocumentsPage } = await import("./documents");

		const unfiltered = await listLogicalDocumentsPage("owner", {
			includeGeneratedOutputs: true,
			offset: 0,
			limit: 20,
		});
		// "mine.pdf" + "second.pdf" -> pdf: 2; "report.docx" -> word: 1. The
		// canvas row contributes to no family at all.
		expect(unfiltered.countsByFileFamily).toEqual({
			pdf: 2,
			word: 1,
			spreadsheet: 0,
			presentation: 0,
			image: 0,
			textMarkdown: 0,
			other: 0,
		});

		const wordOnly = await listLogicalDocumentsPage("owner", {
			includeGeneratedOutputs: true,
			offset: 0,
			limit: 20,
			kindFilter: "uploaded",
			fileFamilyFilter: "word",
		});
		expect(wordOnly.documents.map((document) => document.id)).toEqual([
			"owned-word",
		]);
		expect(wordOnly.totalItems).toBe(1);
		// Narrowing to one family must never move any family's own count,
		// including the one just selected.
		expect(wordOnly.countsByFileFamily).toEqual(unfiltered.countsByFileFamily);
	});

	// A kind chip other than Files paired with a fileFamilyFilter is a
	// combination the UI never actually sends (switching away from Files
	// clears the family), but the store must still refuse to leak a Files row
	// into a kind chip's result rather than silently ignoring the stray param.
	it("never shows a Files row under a non-Files kind chip, even if a fileFamilyFilter is also set", async () => {
		const { sqlite, db } = openSeedDatabase();
		seed(db);
		db.insert(schema.artifacts)
			.values({
				id: "owned-canvas",
				userId: "owner",
				type: "artifact",
				retrievalClass: "durable",
				name: "Vienna trip board",
				conversationId: "conv-owner",
				metadataJson: JSON.stringify({
					artifactType: "canvas",
					title: "Vienna trip board",
				}),
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		sqlite.close();

		const { listLogicalDocumentsPage } = await import("./documents");

		const page = await listLogicalDocumentsPage("owner", {
			includeGeneratedOutputs: true,
			offset: 0,
			limit: 20,
			kindFilter: "canvas",
			fileFamilyFilter: "pdf",
		});
		// "mine.pdf" (owned-source) matches the family but not the kind chip;
		// "owned-canvas" matches the kind chip but carries no file family. The
		// combination must resolve to nothing, never to either row.
		expect(page.documents).toEqual([]);
		expect(page.totalItems).toBe(0);
	});

	it("walks a fileFamilyFilter-narrowed page one row at a time without skipping or repeating", async () => {
		const { sqlite, db } = openSeedDatabase();
		seed(db);
		db.insert(schema.artifacts)
			.values([
				{
					id: "owned-pdf-2",
					userId: "owner",
					type: "source_document",
					retrievalClass: "durable",
					name: "second.pdf",
					mimeType: "application/pdf",
					sizeBytes: 10,
					conversationId: null,
					createdAt: NOW,
					updatedAt: NOW,
				},
				{
					id: "owned-pdf-3",
					userId: "owner",
					type: "source_document",
					retrievalClass: "durable",
					name: "third.pdf",
					mimeType: "application/pdf",
					sizeBytes: 10,
					conversationId: null,
					createdAt: NOW,
					updatedAt: NOW,
				},
				// A Word upload in the same Files bucket, excluded by the family
				// filter below — proves the walk is narrowed, not just paginated.
				{
					id: "owned-word",
					userId: "owner",
					type: "source_document",
					retrievalClass: "durable",
					name: "report.docx",
					mimeType:
						"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
					sizeBytes: 10,
					conversationId: null,
					createdAt: NOW,
					updatedAt: NOW,
				},
			])
			.run();
		sqlite.close();

		const { listLogicalDocumentsPage } = await import("./documents");

		const visited: string[] = [];
		for (let offset = 0; offset < 3; offset += 1) {
			const page = await listLogicalDocumentsPage("owner", {
				includeGeneratedOutputs: true,
				offset,
				limit: 1,
				kindFilter: "uploaded",
				fileFamilyFilter: "pdf",
			});
			expect(page.totalItems).toBe(3);
			expect(page.documents).toHaveLength(1);
			visited.push(page.documents[0].id);
		}
		expect(visited.sort()).toEqual(
			["owned-source", "owned-pdf-2", "owned-pdf-3"].sort(),
		);
	});
});
