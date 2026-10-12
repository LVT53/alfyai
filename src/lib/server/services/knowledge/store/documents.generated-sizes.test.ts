// What size a generated row of the Knowledge library shows (friction audit F23).
//
// The row's own `artifacts.size_bytes` is not the size of what it downloads: a
// source-first document's row never had one (the library read "0 B" for a 364 KB
// PDF) and a file's memory row holds the size of the text the memory kept. The row
// downloads the chat file its `sourceChatFileId` names, so that file's size is the
// row's size, read for the user's own files only.
//
// A real migrated SQLite file: the claim is about what the library lists.
//
// FB-8 (FB-1's finding 3) extends it to the file's NAME and TYPE: a source-first
// row's own mime is the source document's JSON, so opening it from the library
// said "Preview not available for this file type" for a PDF that downloads fine.

import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;
const NOW = new Date("2026-10-12T10:00:00.000Z");
const USER = "owner";
const OTHER = "someone-else";

type SeedDb = ReturnType<typeof drizzle<typeof schema>>;

function openSeedDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	return { sqlite, db };
}

function seedBase(db: SeedDb) {
	for (const [id, email] of [
		[USER, "owner@example.com"],
		[OTHER, "other@example.com"],
	] as const) {
		db.insert(schema.users)
			.values({
				id,
				email,
				passwordHash: "hash",
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
	}
	db.insert(schema.conversations)
		.values({
			id: "conv-1",
			userId: USER,
			title: "Chat",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

function seedChatFile(
	db: SeedDb,
	id: string,
	userId: string,
	sizeBytes: number,
) {
	db.insert(schema.chatGeneratedFiles)
		.values({
			id,
			conversationId: "conv-1",
			userId,
			filename: `${id}.pdf`,
			mimeType: "application/pdf",
			storagePath: `conv-1/${id}.pdf`,
			sizeBytes,
			createdAt: NOW,
		})
		.run();
}

function seedGeneratedRow(
	db: SeedDb,
	id: string,
	sourceChatFileId: string | null,
	sizeBytes: number | null,
	extraMetadata: Record<string, unknown> = {},
) {
	db.insert(schema.artifacts)
		.values({
			id,
			userId: USER,
			conversationId: "conv-1",
			type: "generated_output",
			retrievalClass: "durable",
			name: `Report ${id}`,
			mimeType: "application/vnd.alfyai.generated-document+json",
			sizeBytes,
			metadataJson: JSON.stringify({
				documentOrigin: "generated",
				documentFamilyId: `family-${id}`,
				documentFamilyStatus: "active",
				documentLabel: `Report ${id}`,
				versionNumber: 1,
				...(sourceChatFileId ? { sourceChatFileId } : {}),
				...extraMetadata,
			}),
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

async function listedSizes(): Promise<Record<string, number | null>> {
	const { listLogicalDocumentsPage } = await import("./documents");
	const page = await listLogicalDocumentsPage(USER, {
		includeGeneratedOutputs: true,
		limit: 50,
	});
	return Object.fromEntries(
		page.documents.map((document) => [document.id, document.sizeBytes]),
	);
}

describe("a generated row's size in the Knowledge library", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-documents-generated-sizes-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// The DB module may not have been imported if a test failed early.
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// Temporary DB cleanup is best-effort.
		}
	});

	it("is the size of the file the row downloads, whatever the row's own size says", async () => {
		const { sqlite, db } = openSeedDatabase();
		seedBase(db);
		seedChatFile(db, "file-pdf", USER, 373_760);
		seedChatFile(db, "file-md", USER, 18);
		// Never had a size of its own, and one that holds the memory text's size.
		seedGeneratedRow(db, "gen-source-first", "file-pdf", null);
		seedGeneratedRow(db, "gen-memory", "file-md", 4_096);
		sqlite.close();

		const sizes = await listedSizes();

		expect(sizes["gen-source-first"]).toBe(373_760);
		expect(sizes["gen-memory"]).toBe(18);
	});

	it("names the file and type the row downloads, so the library opens a preview of that file and not of the source it was rendered from", async () => {
		const { sqlite, db } = openSeedDatabase();
		seedBase(db);
		seedChatFile(db, "file-pdf", USER, 373_760);
		seedGeneratedRow(db, "gen-source-first", "file-pdf", null);
		sqlite.close();

		const { listLogicalDocumentsPage } = await import("./documents");
		const page = await listLogicalDocumentsPage(USER, {
			includeGeneratedOutputs: true,
			limit: 50,
		});
		const row = page.documents.find(
			(document) => document.id === "gen-source-first",
		);

		expect(row).toMatchObject({
			generatedFileName: "file-pdf.pdf",
			generatedFileMimeType: "application/pdf",
		});
		// The row itself is still the source it is listed as.
		expect(row?.mimeType).toBe(
			"application/vnd.alfyai.generated-document+json",
		);
	});

	it("names no file that is not the user's, or is not there", async () => {
		const { sqlite, db } = openSeedDatabase();
		seedBase(db);
		seedChatFile(db, "file-theirs", OTHER, 999_999);
		seedGeneratedRow(db, "gen-foreign-file", "file-theirs", 5);
		seedGeneratedRow(db, "gen-no-such-file", "file-gone", 7);
		sqlite.close();

		const { listLogicalDocumentsPage } = await import("./documents");
		const page = await listLogicalDocumentsPage(USER, {
			includeGeneratedOutputs: true,
			limit: 50,
		});
		for (const id of ["gen-foreign-file", "gen-no-such-file"]) {
			const row = page.documents.find((document) => document.id === id);
			expect(row?.generatedFileName ?? null, id).toBeNull();
			expect(row?.generatedFileMimeType ?? null, id).toBeNull();
		}
	});

	// FB-8 (FB-1's concern 2): a Download of a Document is delivery. Its rendered
	// file belongs to the Document, which already has a Download of its own, and the
	// source row it leaves is marked an export: no row of the library, whatever the
	// search, the page or the family expansion asks for.
	it("lists no export: a Download's file is delivery, not a generated file of the library", async () => {
		const { sqlite, db } = openSeedDatabase();
		seedBase(db);
		seedChatFile(db, "file-report", USER, 4_000);
		seedChatFile(db, "file-export", USER, 5_000);
		seedGeneratedRow(db, "gen-report", "file-report", null);
		seedGeneratedRow(db, "gen-export", "file-export", null, {
			artifactExport: true,
		});
		sqlite.close();

		const { listLogicalDocumentsPage } = await import("./documents");
		for (const query of [undefined, "Report"]) {
			const page = await listLogicalDocumentsPage(USER, {
				includeGeneratedOutputs: true,
				limit: 50,
				...(query ? { query } : {}),
			});
			const ids = page.documents.map((document) => document.id);
			expect(ids, `query ${query ?? "(none)"}`).toContain("gen-report");
			expect(ids, `query ${query ?? "(none)"}`).not.toContain("gen-export");
		}
	});

	it("leaves the row's own size when the file is not the user's, or is not there", async () => {
		const { sqlite, db } = openSeedDatabase();
		seedBase(db);
		seedChatFile(db, "file-theirs", OTHER, 999_999);
		seedGeneratedRow(db, "gen-foreign-file", "file-theirs", 5);
		seedGeneratedRow(db, "gen-no-such-file", "file-gone", 7);
		sqlite.close();

		const sizes = await listedSizes();

		expect(sizes["gen-foreign-file"]).toBe(5);
		expect(sizes["gen-no-such-file"]).toBe(7);
	});
});
