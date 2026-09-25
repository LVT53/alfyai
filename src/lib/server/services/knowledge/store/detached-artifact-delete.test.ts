// Deleting a conversation used to strand its generated artifacts, and the
// delete API then denied they existed.
//
// `artifacts.conversation_id` is `ON DELETE SET NULL`, and
// `isArtifactCanonicallyOwned` gives `generated_output` / `work_capsule` no
// `userId` fallback — deliberately, because a working artifact whose
// conversation is gone must never come back as retrieval context. But
// `deleteArtifactForUser` reached the row through that same retrieval gate, so
// the moment the link was cleared the row became undeletable: invisible in the
// library, 404 on GET, and a cheerful 200 "already removed" on DELETE while the
// row, its chunks, its links, its extraction job rows and its stored file sat
// on disk with nothing left that could ever remove them.
//
// Real migrated SQLite with foreign keys ON, so the cascades are the real ones.
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;

const NOW = new Date("2026-09-21T10:00:00.000Z");

function open() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	return { sqlite, db };
}

type Db = ReturnType<typeof open>["db"];

function seed(db: Db) {
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

	// The conversation is already gone; this is the state the cleanup left.
	db.insert(schema.artifacts)
		.values([
			{
				id: "orphan",
				userId: "owner",
				type: "generated_output",
				retrievalClass: "durable",
				conversationId: null,
				name: "Q3 summary.docx",
				storagePath: null,
				createdAt: NOW,
				updatedAt: NOW,
			},
			{
				id: "bystander",
				userId: "owner",
				type: "source_document",
				retrievalClass: "durable",
				conversationId: null,
				name: "contract.pdf",
				storagePath: null,
				createdAt: NOW,
				updatedAt: NOW,
			},
		])
		.run();

	db.insert(schema.artifactChunks)
		.values({
			id: "chunk-1",
			artifactId: "orphan",
			userId: "owner",
			chunkIndex: 0,
			contentText: "text",
			createdAt: NOW,
		})
		.run();
}

function idsIn(db: Db, table: "artifacts" | "chunks"): string[] {
	if (table === "artifacts") {
		return db
			.select({ id: schema.artifacts.id })
			.from(schema.artifacts)
			.all()
			.map((row) => row.id)
			.sort();
	}
	return db
		.select({ id: schema.artifactChunks.id })
		.from(schema.artifactChunks)
		.all()
		.map((row) => row.id);
}

describe("deleting an artifact whose conversation is gone", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-detached-delete-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// Only loaded by tests that reached the service.
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// Best-effort cleanup of the temporary database file.
		}
	});

	it("removes the row and its chunks, rather than reporting a phantom success", async () => {
		const seeded = open();
		seed(seeded.db);
		seeded.sqlite.close();

		const { deleteArtifactForUser } = await import("./cleanup");
		const result = await deleteArtifactForUser("owner", "orphan");

		// Not null, and not an empty id list: the row really went.
		expect(result?.deletedArtifactIds).toEqual(["orphan"]);

		const verify = open();
		expect(idsIn(verify.db, "artifacts")).toEqual(["bystander"]);
		expect(idsIn(verify.db, "chunks")).toEqual([]);
		verify.sqlite.close();
	});

	it("still refuses a row belonging to someone else", async () => {
		const seeded = open();
		seed(seeded.db);
		seeded.sqlite.close();

		const { deleteArtifactForUser } = await import("./cleanup");
		expect(await deleteArtifactForUser("stranger", "orphan")).toBeNull();

		const verify = open();
		expect(idsIn(verify.db, "artifacts")).toEqual(["bystander", "orphan"]);
		verify.sqlite.close();
	});

	it("answers null for an id that does not exist", async () => {
		const seeded = open();
		seed(seeded.db);
		seeded.sqlite.close();

		const { deleteArtifactForUser } = await import("./cleanup");
		expect(await deleteArtifactForUser("owner", "no-such-id")).toBeNull();
	});

	// The retrieval gate must NOT move: a detached working artifact is still
	// not a valid context candidate. Only the delete authority changed.
	it("leaves the retrieval gate closed on the same row", async () => {
		const seeded = open();
		seed(seeded.db);
		seeded.sqlite.close();

		const { getArtifactForUser, getArtifactForUserToDelete } = await import(
			"./core"
		);
		expect(await getArtifactForUser("owner", "orphan")).toBeNull();
		expect(await getArtifactForUserToDelete("owner", "orphan")).not.toBeNull();
	});
});

// Item 5 of the client review: deleteArtifactForUser is the knowledge-side
// delete path for the artifact family (Feature 2). A version, a comment and a
// stored App value only ever disappear because the FK cascade on their
// artifact_id takes them with the parent row — deleteArtifactForUser never
// deletes from those three tables itself. Real migrated SQLite, foreign keys
// ON, so this is the same cascade tests/integration/artifact-spine.test.ts
// pins at the schema level, proven here through the actual delete path.
describe("deleteArtifactForUser and the artifact family's child rows", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-detached-delete-family-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// Only loaded by tests that reached the service.
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// Best-effort cleanup of the temporary database file.
		}
	});

	it("takes its versions, comments and kv rows with it", async () => {
		const seeded = open();
		seeded.db
			.insert(schema.users)
			.values({
				id: "owner",
				email: "owner@example.com",
				passwordHash: "hash",
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		seeded.db
			.insert(schema.conversations)
			.values({
				id: "conv-1",
				userId: "owner",
				title: "Launch",
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		seeded.db
			.insert(schema.artifacts)
			.values({
				id: "artifact-1",
				userId: "owner",
				conversationId: "conv-1",
				type: "artifact",
				retrievalClass: "durable",
				name: "Launch checklist",
				contentText: "- [ ] Ship it",
				metadataJson: JSON.stringify({
					artifactType: "document",
					title: "Launch checklist",
				}),
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		seeded.db
			.insert(schema.artifactVersions)
			.values({
				id: "version-1",
				artifactId: "artifact-1",
				userId: "owner",
				versionNumber: 1,
				author: "user",
				summary: "First draft",
				body: "- [ ] Ship it",
				bodyHash: "hash",
				createdAt: NOW,
			})
			.run();
		seeded.db
			.insert(schema.artifactComments)
			.values({
				id: "comment-1",
				artifactId: "artifact-1",
				userId: "owner",
				parentId: null,
				anchorJson: JSON.stringify({ kind: "node", nodeId: "node-1" }),
				author: "user",
				body: "Ship by Friday?",
				status: "open",
				createdAt: NOW,
			})
			.run();
		seeded.db
			.insert(schema.artifactKv)
			.values({
				id: "kv-1",
				artifactId: "artifact-1",
				key: "progress",
				valueJson: '"in_review"',
				updatedAt: NOW,
			})
			.run();
		seeded.sqlite.close();

		const { deleteArtifactForUser } = await import("./cleanup");
		const result = await deleteArtifactForUser("owner", "artifact-1");
		expect(result?.deletedArtifactIds).toEqual(["artifact-1"]);

		const verify = open();
		const childCounts = {
			versions: verify.db
				.select({ id: schema.artifactVersions.id })
				.from(schema.artifactVersions)
				.all().length,
			comments: verify.db
				.select({ id: schema.artifactComments.id })
				.from(schema.artifactComments)
				.all().length,
			kv: verify.db
				.select({ id: schema.artifactKv.id })
				.from(schema.artifactKv)
				.all().length,
		};
		verify.sqlite.close();

		expect(childCounts).toEqual({ versions: 0, comments: 0, kv: 0 });
	});
});
