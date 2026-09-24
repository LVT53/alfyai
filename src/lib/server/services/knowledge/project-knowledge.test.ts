import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;

function openSeedDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	return { sqlite, db };
}

/**
 * One owner, one project of theirs, one project of somebody else's, and the
 * artifacts the ownership rules have to tell apart: an uploaded document with
 * its normalized sibling, a second document, a file that only belongs to the
 * other user, and a file that lives inside the owner's own incognito chat.
 */
function seedProjectKnowledgeScenario() {
	const { sqlite, db } = openSeedDatabase();
	const now = new Date("2026-07-01T09:00:00.000Z");

	db.insert(schema.users)
		.values([
			{ id: "owner-user", email: "owner@example.com", passwordHash: "hash" },
			{ id: "other-user", email: "other@example.com", passwordHash: "hash" },
		])
		.run();

	db.insert(schema.projects)
		.values([
			{
				id: "trip-project",
				userId: "owner-user",
				name: "Vienna trip",
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "other-project",
				userId: "other-user",
				name: "Someone else's project",
				createdAt: now,
				updatedAt: now,
			},
		])
		.run();

	db.insert(schema.conversations)
		.values([
			{
				id: "conv-plain",
				userId: "owner-user",
				title: "Plan the trip",
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "conv-incognito",
				userId: "owner-user",
				title: "Private chat",
				memoryIncognito: true,
				createdAt: now,
				updatedAt: now,
			},
		])
		.run();

	db.insert(schema.artifacts)
		.values([
			{
				id: "artifact-railjet",
				userId: "owner-user",
				type: "source_document",
				name: "Railjet tickets.pdf",
				mimeType: "application/pdf",
				sizeBytes: 240_000,
				contentText: "Budapest to Vienna, 10 October, coach 24.",
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "artifact-railjet-normalized",
				userId: "owner-user",
				type: "normalized_document",
				name: "Railjet tickets.pdf",
				mimeType: "text/markdown",
				sizeBytes: 900,
				summary: "Two tickets for 10 October, Budapest to Vienna.",
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "artifact-hotel",
				userId: "owner-user",
				type: "source_document",
				name: "Hotel Motto booking.pdf",
				mimeType: "application/pdf",
				sizeBytes: 120_000,
				summary: "Booking confirmation for 10 October.",
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "artifact-native-summary",
				userId: "owner-user",
				type: "source_document",
				name: "Notes about the trip.txt",
				mimeType: "text/plain",
				sizeBytes: 400,
				summary: "Plain notes with no normalized sibling.",
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "artifact-other-user",
				userId: "other-user",
				type: "source_document",
				name: "Their file.pdf",
				mimeType: "application/pdf",
				sizeBytes: 1_000,
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "artifact-incognito",
				userId: "owner-user",
				conversationId: "conv-incognito",
				type: "source_document",
				name: "Private notes.pdf",
				mimeType: "application/pdf",
				sizeBytes: 2_000,
				createdAt: now,
				updatedAt: now,
			},
		])
		.run();

	// The upload pipeline's own link: the source row and the normalized artifact
	// retrievdal actually returns for it.
	db.insert(schema.artifactLinks)
		.values({
			id: "link-railjet-derived",
			userId: "owner-user",
			artifactId: "artifact-railjet-normalized",
			relatedArtifactId: "artifact-railjet",
			linkType: "derived_from",
			createdAt: now,
		})
		.run();

	sqlite.close();
}

function readLinkRows(): Array<{
	id: string;
	user_id: string;
	project_id: string;
	artifact_id: string;
	created_at: number;
}> {
	const sqlite = new Database(dbPath);
	const rows = sqlite
		.prepare(
			"SELECT id, user_id, project_id, artifact_id, created_at FROM project_knowledge_links ORDER BY artifact_id",
		)
		.all() as Array<{
		id: string;
		user_id: string;
		project_id: string;
		artifact_id: string;
		created_at: number;
	}>;
	sqlite.close();
	return rows;
}

function readArtifact(artifactId: string) {
	const sqlite = new Database(dbPath);
	const row = sqlite
		.prepare(
			"SELECT id, name, size_bytes, content_text FROM artifacts WHERE id = ?",
		)
		.get(artifactId) as
		| {
				id: string;
				name: string;
				size_bytes: number | null;
				content_text: string | null;
		  }
		| undefined;
	sqlite.close();
	return row;
}

describe("project knowledge links", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-project-knowledge-${randomUUID()}.db`;
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

	it("links a library document to a project and lists it with its summary and added date", async () => {
		seedProjectKnowledgeScenario();
		const { linkProjectKnowledge, listProjectKnowledge } = await import(
			"./project-knowledge"
		);
		const before = Math.floor(Date.now() / 1000);

		const linked = await linkProjectKnowledge({
			userId: "owner-user",
			projectId: "trip-project",
			artifactIds: ["artifact-railjet", "artifact-hotel"],
		});

		// Name order, so the Files modal and the prompt section agree on one
		// order and the section's prefix stays stable turn over turn.
		expect(linked.map((file) => file.name)).toEqual([
			"Hotel Motto booking.pdf",
			"Railjet tickets.pdf",
		]);
		expect(linked[1]).toEqual({
			artifactId: "artifact-railjet",
			name: "Railjet tickets.pdf",
			mimeType: "application/pdf",
			type: "source_document",
			sizeBytes: 240_000,
			// The link's own timestamp, not the artifact's: the modal's "Added"
			// column is about the link, and the artifact was uploaded in July.
			linkedAt: expect.any(Number),
			summary: "Two tickets for 10 October, Budapest to Vienna.",
		});
		expect(linked[1].linkedAt).toBeGreaterThanOrEqual(before);

		const listed = await listProjectKnowledge({
			userId: "owner-user",
			projectId: "trip-project",
		});
		expect(listed).toEqual(linked);
		expect(readLinkRows()).toHaveLength(2);
	});

	it("falls back to the document's own summary when it was never normalized", async () => {
		seedProjectKnowledgeScenario();
		const { linkProjectKnowledge, listProjectKnowledge } = await import(
			"./project-knowledge"
		);

		await linkProjectKnowledge({
			userId: "owner-user",
			projectId: "trip-project",
			artifactIds: ["artifact-native-summary"],
		});
		const [file] = await listProjectKnowledge({
			userId: "owner-user",
			projectId: "trip-project",
		});

		expect(file).toMatchObject({
			artifactId: "artifact-native-summary",
			summary: "Plain notes with no normalized sibling.",
		});
	});

	it("is idempotent when the same document is linked twice", async () => {
		seedProjectKnowledgeScenario();
		const { linkProjectKnowledge } = await import("./project-knowledge");

		await linkProjectKnowledge({
			userId: "owner-user",
			projectId: "trip-project",
			artifactIds: ["artifact-railjet"],
		});
		const second = await linkProjectKnowledge({
			userId: "owner-user",
			projectId: "trip-project",
			artifactIds: ["artifact-railjet", "artifact-hotel"],
		});

		// Both documents, one row each — the second call adds only what is new
		// and never duplicates what is already there.
		expect(second.map((file) => file.artifactId)).toEqual([
			"artifact-hotel",
			"artifact-railjet",
		]);
		expect(readLinkRows().map((row) => row.artifact_id)).toEqual([
			"artifact-hotel",
			"artifact-railjet",
		]);
	});

	it("stores the document's own id when it is linked by its normalized artifact", async () => {
		seedProjectKnowledgeScenario();
		const { linkProjectKnowledge } = await import("./project-knowledge");

		const linked = await linkProjectKnowledge({
			userId: "owner-user",
			projectId: "trip-project",
			artifactIds: ["artifact-railjet-normalized"],
		});

		// One document, one link: linking through either id has to land on the
		// same row, or the library's own row and the normalized artifact would
		// both list.
		expect(linked.map((file) => file.artifactId)).toEqual(["artifact-railjet"]);
		expect(readLinkRows().map((row) => row.artifact_id)).toEqual([
			"artifact-railjet",
		]);
	});

	it("returns the artifact ids for the retrieval boost, normalized siblings included", async () => {
		seedProjectKnowledgeScenario();
		const { linkProjectKnowledge, listProjectKnowledgeArtifactIds } =
			await import("./project-knowledge");

		await linkProjectKnowledge({
			userId: "owner-user",
			projectId: "trip-project",
			artifactIds: ["artifact-railjet", "artifact-hotel"],
		});

		// The boost has to reach the rows retrieval actually returns, which for
		// an uploaded PDF is the normalized artifact, not the source row.
		await expect(
			listProjectKnowledgeArtifactIds({
				userId: "owner-user",
				projectId: "trip-project",
			}),
		).resolves.toEqual([
			"artifact-hotel",
			"artifact-railjet",
			"artifact-railjet-normalized",
		]);
	});

	it("rejects linking another user's artifact without writing a row", async () => {
		seedProjectKnowledgeScenario();
		const { linkProjectKnowledge, isProjectKnowledgeError } = await import(
			"./project-knowledge"
		);

		const error = await linkProjectKnowledge({
			userId: "owner-user",
			projectId: "trip-project",
			artifactIds: ["artifact-railjet", "artifact-other-user"],
		}).catch((thrown: unknown) => thrown);

		expect(isProjectKnowledgeError(error)).toBe(true);
		if (!isProjectKnowledgeError(error)) throw error;
		expect(error.code).toBe("artifact_not_owned");
		expect(error.status).toBe(404);
		// The whole call is rejected, not just the offending id: a partial link
		// would leave the caller believing both documents were added.
		expect(readLinkRows()).toEqual([]);
	});

	it("rejects a project that belongs to another user, writing nothing", async () => {
		seedProjectKnowledgeScenario();
		const {
			linkProjectKnowledge,
			unlinkProjectKnowledge,
			isProjectKnowledgeError,
		} = await import("./project-knowledge");

		const error = await linkProjectKnowledge({
			userId: "owner-user",
			projectId: "other-project",
			artifactIds: ["artifact-railjet"],
		}).catch((thrown: unknown) => thrown);

		expect(isProjectKnowledgeError(error)).toBe(true);
		if (!isProjectKnowledgeError(error)) throw error;
		expect(error.code).toBe("project_not_found");
		expect(error.status).toBe(404);
		expect(readLinkRows()).toEqual([]);

		// Unlinking somebody else's project is a 404 as well, not a quiet no-op:
		// the caller named a project they cannot act on.
		await expect(
			unlinkProjectKnowledge({
				userId: "owner-user",
				projectId: "other-project",
				artifactId: "artifact-railjet",
			}),
		).rejects.toMatchObject({ code: "project_not_found", status: 404 });
	});

	it("404s and writes nothing when the artifact does not exist", async () => {
		seedProjectKnowledgeScenario();
		const { linkProjectKnowledge, isProjectKnowledgeError } = await import(
			"./project-knowledge"
		);

		const error = await linkProjectKnowledge({
			userId: "owner-user",
			projectId: "trip-project",
			artifactIds: ["no-such-artifact"],
		}).catch((thrown: unknown) => thrown);

		expect(isProjectKnowledgeError(error)).toBe(true);
		if (!isProjectKnowledgeError(error)) throw error;
		expect(error.code).toBe("artifact_not_owned");
		expect(error.status).toBe(404);
		expect(readLinkRows()).toEqual([]);
	});

	it("refuses to link a file that lives inside another chat's incognito conversation", async () => {
		seedProjectKnowledgeScenario();
		const { linkProjectKnowledge, isProjectKnowledgeError } = await import(
			"./project-knowledge"
		);

		const error = await linkProjectKnowledge({
			userId: "owner-user",
			projectId: "trip-project",
			artifactIds: ["artifact-incognito"],
		}).catch((thrown: unknown) => thrown);

		// A project link is a standing grant to every chat in the project, so a
		// file an incognito chat produced must never enter through it.
		expect(isProjectKnowledgeError(error)).toBe(true);
		expect(readLinkRows()).toEqual([]);
	});

	it("does not list another user's project's files", async () => {
		seedProjectKnowledgeScenario();
		const {
			linkProjectKnowledge,
			listProjectKnowledge,
			listProjectKnowledgeArtifactIds,
		} = await import("./project-knowledge");

		await linkProjectKnowledge({
			userId: "owner-user",
			projectId: "trip-project",
			artifactIds: ["artifact-railjet"],
		});

		// Somebody else's project is indistinguishable from an empty one, and
		// the id list is empty with it — the retrieval boost must not reach
		// across an ownership boundary either.
		await expect(
			listProjectKnowledge({ userId: "other-user", projectId: "trip-project" }),
		).resolves.toEqual([]);
		await expect(
			listProjectKnowledge({
				userId: "owner-user",
				projectId: "other-project",
			}),
		).resolves.toEqual([]);
		await expect(
			listProjectKnowledgeArtifactIds({
				userId: "other-user",
				projectId: "trip-project",
			}),
		).resolves.toEqual([]);
	});

	it("unlinks without deleting the artifact or its bytes", async () => {
		seedProjectKnowledgeScenario();
		const { linkProjectKnowledge, unlinkProjectKnowledge } = await import(
			"./project-knowledge"
		);

		await linkProjectKnowledge({
			userId: "owner-user",
			projectId: "trip-project",
			artifactIds: ["artifact-railjet", "artifact-hotel"],
		});

		await expect(
			unlinkProjectKnowledge({
				userId: "owner-user",
				projectId: "trip-project",
				artifactId: "artifact-railjet",
			}),
		).resolves.toBe(true);

		expect(readLinkRows().map((row) => row.artifact_id)).toEqual([
			"artifact-hotel",
		]);
		expect(readArtifact("artifact-railjet")).toMatchObject({
			id: "artifact-railjet",
			name: "Railjet tickets.pdf",
			size_bytes: 240_000,
			content_text: "Budapest to Vienna, 10 October, coach 24.",
		});
		// The document is still the library's: nothing about the row changed.
		expect(readArtifact("artifact-railjet")?.name).toBe("Railjet tickets.pdf");
	});

	it("treats a second unlink as a no-op rather than an error", async () => {
		seedProjectKnowledgeScenario();
		const { linkProjectKnowledge, unlinkProjectKnowledge } = await import(
			"./project-knowledge"
		);

		await linkProjectKnowledge({
			userId: "owner-user",
			projectId: "trip-project",
			artifactIds: ["artifact-railjet"],
		});
		await unlinkProjectKnowledge({
			userId: "owner-user",
			projectId: "trip-project",
			artifactId: "artifact-railjet",
		});

		await expect(
			unlinkProjectKnowledge({
				userId: "owner-user",
				projectId: "trip-project",
				artifactId: "artifact-railjet",
			}),
		).resolves.toBe(false);
	});

	it("unlinks a document that was linked through its normalized artifact", async () => {
		seedProjectKnowledgeScenario();
		const { linkProjectKnowledge, unlinkProjectKnowledge } = await import(
			"./project-knowledge"
		);

		await linkProjectKnowledge({
			userId: "owner-user",
			projectId: "trip-project",
			artifactIds: ["artifact-railjet"],
		});
		await expect(
			unlinkProjectKnowledge({
				userId: "owner-user",
				projectId: "trip-project",
				artifactId: "artifact-railjet-normalized",
			}),
		).resolves.toBe(true);

		expect(readLinkRows()).toEqual([]);
	});

	it("deletes the links when the project is deleted, and keeps the library files", async () => {
		seedProjectKnowledgeScenario();
		const { linkProjectKnowledge } = await import("./project-knowledge");
		const { deleteProject } = await import("$lib/server/services/projects");

		await linkProjectKnowledge({
			userId: "owner-user",
			projectId: "trip-project",
			artifactIds: ["artifact-railjet", "artifact-hotel"],
		});

		await expect(deleteProject("owner-user", "trip-project")).resolves.toBe(
			true,
		);

		expect(readLinkRows()).toEqual([]);
		expect(readArtifact("artifact-railjet")?.name).toBe("Railjet tickets.pdf");
		expect(readArtifact("artifact-hotel")?.name).toBe(
			"Hotel Motto booking.pdf",
		);
	});

	it("deletes the link when the library file is deleted, leaving no dangling row", async () => {
		seedProjectKnowledgeScenario();
		const { linkProjectKnowledge } = await import("./project-knowledge");
		const { deleteArtifactForUser } = await import(
			"$lib/server/services/knowledge/store"
		);

		await linkProjectKnowledge({
			userId: "owner-user",
			projectId: "trip-project",
			artifactIds: ["artifact-railjet", "artifact-hotel"],
		});

		await expect(
			deleteArtifactForUser("owner-user", "artifact-railjet"),
		).resolves.not.toBeNull();

		expect(readLinkRows().map((row) => row.artifact_id)).toEqual([
			"artifact-hotel",
		]);
		expect(readArtifact("artifact-railjet")).toBeUndefined();
	});

	it("keeps another project's link when the owner's project is deleted", async () => {
		seedProjectKnowledgeScenario();
		const { linkProjectKnowledge, listProjectKnowledge } = await import(
			"./project-knowledge"
		);
		const { deleteProject } = await import("$lib/server/services/projects");

		await linkProjectKnowledge({
			userId: "owner-user",
			projectId: "trip-project",
			artifactIds: ["artifact-railjet"],
		});

		await expect(deleteProject("other-user", "trip-project")).resolves.toBe(
			false,
		);

		expect(readLinkRows()).toHaveLength(1);
		await expect(
			listProjectKnowledge({ userId: "owner-user", projectId: "trip-project" }),
		).resolves.toHaveLength(1);
	});
});
