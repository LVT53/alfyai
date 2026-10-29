// An Image item's stored body is JSON (file ids, the prompt, marks), not prose.
// The Documents tab lists it by its title with kind "image"; neither the
// Knowledge Base search nor Workspace Search may match it by the JSON.
//
// A real migrated SQLite file, so the actual WHERE clauses are what is tested.

import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import { serializeImageVersionBody } from "$lib/shared/artifacts/image-body";

let dbPath: string;
const NOW = new Date("2026-09-20T10:00:00.000Z");

const IMAGE_BODY = serializeImageVersionBody({
	v: 1,
	fileId: "abc123",
	width: 1248,
	height: 832,
	hasAlpha: false,
	baseFileId: null,
	sources: [],
	marks: null,
	prompt: "lamplight",
	takeId: null,
	seed: 1,
	anchorFileId: null,
	chainSinceAnchor: 0,
});

function seedDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	db.insert(schema.users)
		.values({
			id: "owner",
			email: "owner@example.com",
			passwordHash: "hash",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	db.insert(schema.conversations)
		.values({
			id: "conv-owner",
			userId: "owner",
			title: "Owner chat",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	db.insert(schema.artifacts)
		.values([
			{
				id: "image-1",
				userId: "owner",
				type: "artifact",
				retrievalClass: "durable",
				name: "Cosy living room",
				conversationId: "conv-owner",
				contentText: IMAGE_BODY,
				metadataJson: JSON.stringify({
					artifactType: "image",
					title: "Cosy living room",
				}),
				createdAt: NOW,
				updatedAt: NOW,
			},
			{
				id: "doc-1",
				userId: "owner",
				type: "artifact",
				retrievalClass: "durable",
				name: "Trip plan",
				conversationId: "conv-owner",
				contentText: "A plan for the trip",
				metadataJson: JSON.stringify({
					artifactType: "document",
					title: "Trip plan",
				}),
				createdAt: NOW,
				updatedAt: NOW,
			},
		])
		.run();
	sqlite.close();
}

describe("an Image item in the knowledge library and in search", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-image-items-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		seedDatabase();
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

	it("lists the item with kind image, and kindFilter image returns only it", async () => {
		const { listLogicalDocumentsPage } = await import("./documents");

		const all = await listLogicalDocumentsPage("owner", { limit: 20 });
		const image = all.documents.find((doc) => doc.id === "image-1");
		expect(image).toMatchObject({ kind: "image", name: "Cosy living room" });
		expect(all.countsByKind.image).toBe(1);

		const filtered = await listLogicalDocumentsPage("owner", {
			limit: 20,
			kindFilter: "image",
		});
		expect(filtered.documents.map((doc) => doc.id)).toEqual(["image-1"]);
	});

	it("carries the picture a list row shows (the file and its shape), never the JSON, and nothing for a Document", async () => {
		const { listLogicalDocumentsPage } = await import("./documents");

		const page = await listLogicalDocumentsPage("owner", { limit: 20 });
		const image = page.documents.find((doc) => doc.id === "image-1");
		expect(image?.imagePreview).toEqual({
			fileId: "abc123",
			width: 1248,
			height: 832,
			hasAlpha: false,
		});
		expect(JSON.stringify(image)).not.toContain("lamplight");
		const document = page.documents.find((doc) => doc.id === "doc-1");
		expect(document).not.toHaveProperty("imagePreview");
	});

	it("finds an Image item in the Knowledge Base by its title, and not by its JSON", async () => {
		const { listLogicalDocumentsPage } = await import("./documents");

		const byTitle = await listLogicalDocumentsPage("owner", {
			limit: 20,
			query: "cosy",
		});
		expect(byTitle.documents.map((doc) => doc.id)).toEqual(["image-1"]);

		for (const query of ["fileid", "abc123", "lamplight"]) {
			const byJson = await listLogicalDocumentsPage("owner", {
				limit: 20,
				query,
			});
			expect(byJson.documents, query).toEqual([]);
		}
	});

	it("finds an Image item in Workspace Search by its title, and not by 'fileid'", async () => {
		const { searchWorkspace } = await import("../../workspace-search");

		const byTitle = await searchWorkspace("owner", { query: "cosy" });
		expect(byTitle.documents.map((doc) => doc.displayArtifactId)).toEqual([
			"image-1",
		]);

		const byJson = await searchWorkspace("owner", { query: "fileid" });
		expect(byJson.documents).toEqual([]);
	});
});
