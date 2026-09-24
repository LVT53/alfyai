import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
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

	it("answers which of the caller's projects know a document", async () => {
		seedProjectKnowledgeScenario();
		const { linkProjectKnowledge, listProjectLinksForArtifacts } = await import(
			"./project-knowledge"
		);
		const { createProject } = await import("$lib/server/services/projects");

		const secondProject = await createProject("owner-user", "Flat renovation");
		await linkProjectKnowledge({
			userId: "owner-user",
			projectId: "trip-project",
			artifactIds: ["artifact-hotel"],
		});
		await linkProjectKnowledge({
			userId: "owner-user",
			projectId: secondProject.id,
			artifactIds: ["artifact-hotel"],
		});

		// The library's token is keyed by the document's own id, and the answer
		// counts projects — the same document in two projects is "In 2 projects".
		const links = await listProjectLinksForArtifacts({
			userId: "owner-user",
			artifactIds: ["artifact-hotel", "artifact-native-summary"],
		});
		expect(links).toEqual([
			{
				artifactId: "artifact-hotel",
				projectId: secondProject.id,
				projectName: "Flat renovation",
			},
			{
				artifactId: "artifact-hotel",
				projectId: "trip-project",
				projectName: "Vienna trip",
			},
		]);

		// A document no project knows has no links, and asking about nothing
		// costs nothing.
		await expect(
			listProjectLinksForArtifacts({
				userId: "owner-user",
				artifactIds: ["artifact-native-summary"],
			}),
		).resolves.toEqual([]);
		await expect(
			listProjectLinksForArtifacts({ userId: "owner-user", artifactIds: [] }),
		).resolves.toEqual([]);
	});

	it("answers a document asked about through either of its ids", async () => {
		seedProjectKnowledgeScenario();
		const { linkProjectKnowledge, listProjectLinksForArtifacts } = await import(
			"./project-knowledge"
		);

		await linkProjectKnowledge({
			userId: "owner-user",
			projectId: "trip-project",
			artifactIds: ["artifact-railjet"],
		});

		// The library lists the source row; retrieval returns the normalized one.
		// Both ids name the same document, and both have to answer, or the token
		// would depend on which id the page happened to hold.
		await expect(
			listProjectLinksForArtifacts({
				userId: "owner-user",
				artifactIds: ["artifact-railjet-normalized"],
			}),
		).resolves.toEqual([
			{
				artifactId: "artifact-railjet-normalized",
				projectId: "trip-project",
				projectName: "Vienna trip",
			},
		]);
	});

	it("never answers with another user's project for the same document id", async () => {
		seedProjectKnowledgeScenario();
		const { linkProjectKnowledge, listProjectLinksForArtifacts } = await import(
			"./project-knowledge"
		);

		// The other user linked their own file into their own project. Nothing
		// about that row is the owner's to see, and nothing here is a lookup by
		// artifact id alone: the join carries the caller's user id.
		await linkProjectKnowledge({
			userId: "other-user",
			projectId: "other-project",
			artifactIds: ["artifact-other-user"],
		});

		await expect(
			listProjectLinksForArtifacts({
				userId: "owner-user",
				artifactIds: ["artifact-other-user", "artifact-hotel"],
			}),
		).resolves.toEqual([]);
		await expect(
			listProjectLinksForArtifacts({
				userId: "other-user",
				artifactIds: ["artifact-other-user"],
			}),
		).resolves.toEqual([
			{
				artifactId: "artifact-other-user",
				projectId: "other-project",
				projectName: "Someone else's project",
			},
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

	it("resolves the project files a message names into linked-source candidates", async () => {
		seedProjectKnowledgeScenario();
		const { linkProjectKnowledge, resolveProjectFileMentions } = await import(
			"./project-knowledge"
		);

		await linkProjectKnowledge({
			userId: "owner-user",
			projectId: "trip-project",
			artifactIds: [
				"artifact-railjet",
				"artifact-hotel",
				"artifact-native-summary",
			],
		});

		const mentions = await resolveProjectFileMentions({
			userId: "owner-user",
			projectId: "trip-project",
			message: "Compare the Railjet tickets.pdf with the Hotel Motto booking.",
		});

		// The two the message names, in the project's own name order. The third
		// linked file — the notes nobody named — is not in the turn: naming a
		// file is the whole signal, and "it happens to be linked" is not one.
		expect(mentions.map((source) => source.name)).toEqual([
			"Hotel Motto booking.pdf",
			"Railjet tickets.pdf",
		]);
		// Every candidate is the canonical shape the linked-source path already
		// persists and validates — the uploaded document keeps its normalized
		// artifact as the prompt id, and the one that was never normalized
		// carries no prompt id at all.
		expect(mentions[1]).toMatchObject({
			displayArtifactId: "artifact-railjet",
			promptArtifactId: "artifact-railjet-normalized",
			type: "document",
		});
		expect(mentions[1].familyArtifactIds).toEqual(
			expect.arrayContaining([
				"artifact-railjet",
				"artifact-railjet-normalized",
			]),
		);
		expect(mentions[0]).toMatchObject({
			displayArtifactId: "artifact-hotel",
			promptArtifactId: null,
		});
	});

	it("does not resolve another user's project file by name", async () => {
		seedProjectKnowledgeScenario();
		const { linkProjectKnowledge, resolveProjectFileMentions } = await import(
			"./project-knowledge"
		);
		await linkProjectKnowledge({
			userId: "owner-user",
			projectId: "trip-project",
			artifactIds: ["artifact-hotel"],
		});
		await linkProjectKnowledge({
			userId: "other-user",
			projectId: "other-project",
			artifactIds: ["artifact-other-user"],
		});

		// Somebody else's project id reads as a project with nothing in it,
		// whoever is asking.
		expect(
			await resolveProjectFileMentions({
				userId: "owner-user",
				projectId: "other-project",
				message: "Read me Their file.pdf",
			}),
		).toEqual([]);
		// And naming a file is not a way around ownership: the caller's own
		// project does not hold somebody else's document.
		expect(
			await resolveProjectFileMentions({
				userId: "other-user",
				projectId: "trip-project",
				message: "Read me Hotel Motto booking.pdf",
			}),
		).toEqual([]);
		expect(
			await resolveProjectFileMentions({
				userId: "owner-user",
				projectId: "trip-project",
				message: "Read me Their file.pdf",
			}),
		).toEqual([]);
	});

	it("fails a named file the same way the linked-source path does when it is not prompt ready", async () => {
		seedProjectKnowledgeScenario();
		const { linkProjectKnowledge, resolveProjectFileMentions } = await import(
			"./project-knowledge"
		);
		const { resolveLinkedContextSourcesForConversation } = await import(
			"$lib/server/services/linked-context-sources"
		);

		// A plain text upload the pipeline never normalized: it links, it lists,
		// and its content is what cannot be served.
		await linkProjectKnowledge({
			userId: "owner-user",
			projectId: "trip-project",
			artifactIds: ["artifact-native-summary"],
		});

		const mentions = await resolveProjectFileMentions({
			userId: "owner-user",
			projectId: "trip-project",
			message: "What does Notes about the trip.txt say?",
		});
		expect(mentions).toHaveLength(1);

		await expect(
			resolveLinkedContextSourcesForConversation({
				userId: "owner-user",
				conversationId: "conv-plain",
				linkedSources: mentions,
				attachmentIds: [],
			}),
		).rejects.toMatchObject({
			name: "LinkedContextSourceError",
			status: 409,
			code: "linked_source_not_prompt_ready",
		});
	});

	// Unlink is not delete, and a library document's bytes are a real file under
	// `data/knowledge/<user>/` — so "the row is still there" is not the whole
	// guarantee. These tests read the file.
	describe("a document's bytes", () => {
		const OWNER_DIR = join(process.cwd(), "data", "knowledge", "owner-user");

		afterEach(() => {
			rmSync(OWNER_DIR, { recursive: true, force: true });
		});

		/** A real upload, through the real store: row, hash and file on disk. */
		async function uploadRealDocument(bytes: Buffer, name: string) {
			const { saveUploadedArtifact } = await import("./store");
			const saved = await saveUploadedArtifact({
				userId: "owner-user",
				file: new File([bytes], name, { type: "application/pdf" }),
			});
			const storagePath = saved.artifact.storagePath;
			expect(storagePath).toBeTruthy();
			return {
				artifactId: saved.artifact.id,
				absolutePath: join(process.cwd(), storagePath as string),
			};
		}

		it("survive an unlink untouched", async () => {
			seedProjectKnowledgeScenario();
			const { linkProjectKnowledge, unlinkProjectKnowledge } = await import(
				"./project-knowledge"
			);
			const bytes = Buffer.from("PK\u0003\u0004 unlink must not touch this");
			const { artifactId, absolutePath } = await uploadRealDocument(
				bytes,
				"Bytes to keep.pdf",
			);
			expect(existsSync(absolutePath)).toBe(true);

			await linkProjectKnowledge({
				userId: "owner-user",
				projectId: "trip-project",
				artifactIds: [artifactId],
			});
			await unlinkProjectKnowledge({
				userId: "owner-user",
				projectId: "trip-project",
				artifactId,
			});

			expect(readLinkRows()).toEqual([]);
			// The file itself, byte for byte.
			expect(existsSync(absolutePath)).toBe(true);
			expect(readFileSync(absolutePath).equals(bytes)).toBe(true);
			expect(readArtifact(artifactId)?.size_bytes).toBe(bytes.length);
		});

		it("survive the project being deleted untouched", async () => {
			seedProjectKnowledgeScenario();
			const { linkProjectKnowledge } = await import("./project-knowledge");
			const { deleteProject } = await import("$lib/server/services/projects");
			const bytes = Buffer.from("PK\u0003\u0004 project deletion keeps this");
			const { artifactId, absolutePath } = await uploadRealDocument(
				bytes,
				"Bytes to keep too.pdf",
			);

			await linkProjectKnowledge({
				userId: "owner-user",
				projectId: "trip-project",
				artifactIds: [artifactId],
			});
			await expect(deleteProject("owner-user", "trip-project")).resolves.toBe(
				true,
			);

			expect(readLinkRows()).toEqual([]);
			expect(existsSync(absolutePath)).toBe(true);
			expect(readFileSync(absolutePath).equals(bytes)).toBe(true);
			expect(readArtifact(artifactId)?.name).toBe("Bytes to keep too.pdf");
		});
	});

	// The non-destruction promise is a property of the module, not of one test:
	// this is the guard that fires if a later edit teaches an unlink to tidy up
	// after itself.
	it("never reaches for the filesystem or for an artifact row", async () => {
		const source = readFileSync(
			join(
				process.cwd(),
				"src",
				"lib",
				"server",
				"services",
				"knowledge",
				"project-knowledge.ts",
			),
			"utf8",
		);

		for (const forbidden of [
			"unlinkSync",
			"rmSync",
			"rm(",
			"writeFile",
			"mkdir",
			"deleteArtifactForUser",
			"db.delete(artifacts)",
		]) {
			expect(
				source.includes(forbidden),
				`project-knowledge.ts must not contain ${forbidden}: a link is not a file`,
			).toBe(false);
		}
		// And the one delete it does issue is the link row's.
		expect(source).toContain("db\n\t\t.delete(projectKnowledgeLinks)");
	});

	// Every other test of the upload path's project check mocks `getProject`, so
	// none of them can tell a real cross-user project from a missing one. This
	// is the one place it runs against the database.
	describe("the upload path's project check", () => {
		it("refuses a project that exists but belongs to another user", async () => {
			seedProjectKnowledgeScenario();
			const { validateKnowledgeUploadProject, isKnowledgeUploadProjectError } =
				await import("./upload-intake");

			const error = await validateKnowledgeUploadProject({
				userId: "owner-user",
				projectId: "other-project",
			}).catch((thrown: unknown) => thrown);

			expect(isKnowledgeUploadProjectError(error)).toBe(true);
			expect(error).toMatchObject({
				code: "invalid_project",
				status: 400,
			});
		});

		it("refuses a project that does not exist", async () => {
			seedProjectKnowledgeScenario();
			const { validateKnowledgeUploadProject, isKnowledgeUploadProjectError } =
				await import("./upload-intake");

			const error = await validateKnowledgeUploadProject({
				userId: "owner-user",
				projectId: "no-such-project",
			}).catch((thrown: unknown) => thrown);

			expect(isKnowledgeUploadProjectError(error)).toBe(true);
		});

		it("accepts the caller's own project, and reads a blank id as none", async () => {
			seedProjectKnowledgeScenario();
			const { validateKnowledgeUploadProject } = await import(
				"./upload-intake"
			);

			await expect(
				validateKnowledgeUploadProject({
					userId: "owner-user",
					projectId: "trip-project",
				}),
			).resolves.toBe("trip-project");
			await expect(
				validateKnowledgeUploadProject({
					userId: "owner-user",
					projectId: "   ",
				}),
			).resolves.toBeNull();
			await expect(
				validateKnowledgeUploadProject({
					userId: "owner-user",
					projectId: null,
				}),
			).resolves.toBeNull();
		});
	});
});
