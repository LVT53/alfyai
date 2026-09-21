// What "unreachable" means, and every way a row escapes that verdict.
//
// This predicate authorises a DELETE of data no UI can show, so the only
// mistake that matters is a false positive: a row that something could still
// reach, swept because one exclusion was not checked. Each case below seeds
// exactly one route back to a candidate and asserts the sweep leaves it alone.
//
// A real migrated SQLite file and real files on disk — half the exclusions are
// about whether bytes exist.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;
let storageDir: string;
const NOW = new Date("2026-09-20T10:00:00.000Z");
const USER = "owner";

type SeedDb = ReturnType<typeof drizzle<typeof schema>>;

function openSeedDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	return { sqlite, db };
}

function seedBase(db: SeedDb) {
	db.insert(schema.users)
		.values({
			id: USER,
			email: "owner@example.com",
			passwordHash: "hash",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

function seedConversation(db: SeedDb, id: string) {
	db.insert(schema.conversations)
		.values({
			id,
			userId: USER,
			title: "Chat",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

function seedArtifact(
	db: SeedDb,
	overrides: Partial<typeof schema.artifacts.$inferInsert> & { id: string },
) {
	db.insert(schema.artifacts)
		.values({
			userId: USER,
			type: "generated_output",
			retrievalClass: "durable",
			name: "report.docx",
			mimeType: "text/markdown",
			sizeBytes: 10,
			conversationId: null,
			createdAt: NOW,
			updatedAt: NOW,
			...overrides,
		})
		.run();
}

async function orphanIds(): Promise<string[]> {
	const { listOrphanGeneratedArtifacts } = await import("./orphan-artifacts");
	return (await listOrphanGeneratedArtifacts()).map((row) => row.id);
}

describe("listOrphanGeneratedArtifacts", () => {
	beforeEach(async () => {
		dbPath = `/tmp/alfyai-orphan-${randomUUID()}.db`;
		storageDir = await mkdtemp(join(tmpdir(), "alfyai-orphan-"));
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// Never imported.
		}
		await rm(dbPath, { force: true }).catch(() => undefined);
		await rm(storageDir, { recursive: true, force: true }).catch(
			() => undefined,
		);
	});

	it("finds a generated output whose conversation was deleted", async () => {
		const { sqlite, db } = openSeedDatabase();
		seedBase(db);
		seedArtifact(db, { id: "stranded" });
		sqlite.close();

		expect(await orphanIds()).toEqual(["stranded"]);
	});

	it("finds a stranded work capsule too", async () => {
		const { sqlite, db } = openSeedDatabase();
		seedBase(db);
		seedArtifact(db, { id: "capsule", type: "work_capsule" });
		sqlite.close();

		expect(await orphanIds()).toEqual(["capsule"]);
	});

	it("leaves an artifact that still has its conversation", async () => {
		const { sqlite, db } = openSeedDatabase();
		seedBase(db);
		seedConversation(db, "conv-live");
		seedArtifact(db, { id: "attached", conversationId: "conv-live" });
		sqlite.close();

		expect(await orphanIds()).toEqual([]);
	});

	it("leaves an artifact linked to a live conversation", async () => {
		const { sqlite, db } = openSeedDatabase();
		seedBase(db);
		seedConversation(db, "conv-live");
		seedArtifact(db, { id: "linked" });
		db.insert(schema.artifactLinks)
			.values({
				id: "link-1",
				userId: USER,
				artifactId: "linked",
				conversationId: "conv-live",
				linkType: "attached_to_conversation",
				createdAt: NOW,
			})
			.run();
		sqlite.close();

		expect(await orphanIds()).toEqual([]);
	});

	it("sweeps a row whose only link went with the deleted conversation", async () => {
		// The real shape of the bug: the conversation delete cascades the link
		// row away and SET NULLs `artifacts.conversation_id`, leaving a row with
		// no route back at all. The liveness check on the link is kept anyway —
		// `artifact_links` is also written by paths the cascade does not cover,
		// and a link pointing at a row that is gone must never read as
		// reachability.
		const { sqlite, db } = openSeedDatabase();
		seedBase(db);
		seedConversation(db, "conv-gone");
		seedArtifact(db, { id: "dangling", conversationId: "conv-gone" });
		db.insert(schema.artifactLinks)
			.values({
				id: "link-2",
				userId: USER,
				artifactId: "dangling",
				conversationId: "conv-gone",
				linkType: "attached_to_conversation",
				createdAt: NOW,
			})
			.run();
		sqlite.prepare("DELETE FROM conversations WHERE id = ?").run("conv-gone");
		expect(
			(
				sqlite.prepare("SELECT count(*) AS n FROM artifact_links").get() as {
					n: number;
				}
			).n,
		).toBe(0);
		sqlite.close();

		expect(await orphanIds()).toEqual(["dangling"]);
	});

	it("leaves an artifact whose chat file row and bytes both survive", async () => {
		const absolute = join(storageDir, "kept.md");
		await writeFile(absolute, "still here", "utf8");
		const { sqlite, db } = openSeedDatabase();
		seedBase(db);
		seedConversation(db, "conv-file");
		db.insert(schema.chatGeneratedFiles)
			.values({
				id: "chat-file-1",
				conversationId: "conv-file",
				userId: USER,
				filename: "kept.md",
				storagePath: relative(process.cwd(), absolute),
				sizeBytes: 10,
				createdAt: NOW,
			})
			.run();
		seedArtifact(db, {
			id: "has-file",
			metadataJson: JSON.stringify({ sourceChatFileId: "chat-file-1" }),
		});
		sqlite.close();

		expect(await orphanIds()).toEqual([]);
	});

	it("sweeps an artifact whose chat file row survived but whose bytes did not", async () => {
		const { sqlite, db } = openSeedDatabase();
		seedBase(db);
		seedConversation(db, "conv-file");
		db.insert(schema.chatGeneratedFiles)
			.values({
				id: "chat-file-2",
				conversationId: "conv-file",
				userId: USER,
				filename: "gone.md",
				storagePath: "data/chat-files/never-written.md",
				sizeBytes: 10,
				createdAt: NOW,
			})
			.run();
		seedArtifact(db, {
			id: "file-unlinked",
			metadataJson: JSON.stringify({ sourceChatFileId: "chat-file-2" }),
		});
		sqlite.close();

		expect(await orphanIds()).toEqual(["file-unlinked"]);
	});

	it("leaves an old version whose family still has a reachable member", async () => {
		const { sqlite, db } = openSeedDatabase();
		seedBase(db);
		seedConversation(db, "conv-live");
		seedArtifact(db, {
			id: "v1",
			metadataJson: JSON.stringify({
				documentFamilyId: "fam-1",
				versionNumber: 1,
			}),
		});
		seedArtifact(db, {
			id: "v2",
			conversationId: "conv-live",
			metadataJson: JSON.stringify({
				documentFamilyId: "fam-1",
				versionNumber: 2,
			}),
		});
		sqlite.close();

		expect(await orphanIds()).toEqual([]);
	});

	it("sweeps a whole family when every member lost its conversation", async () => {
		const { sqlite, db } = openSeedDatabase();
		seedBase(db);
		seedArtifact(db, {
			id: "dead-v1",
			metadataJson: JSON.stringify({
				documentFamilyId: "fam-2",
				versionNumber: 1,
			}),
		});
		seedArtifact(db, {
			id: "dead-v2",
			metadataJson: JSON.stringify({
				documentFamilyId: "fam-2",
				versionNumber: 2,
			}),
		});
		sqlite.close();

		expect((await orphanIds()).sort()).toEqual(["dead-v1", "dead-v2"]);
	});

	it("never returns a source document or a normalized one", async () => {
		const { sqlite, db } = openSeedDatabase();
		seedBase(db);
		// These two keep working with a null conversation_id — canonical
		// ownership falls back to the user stamp for them — so they are not
		// stranded and must never be swept.
		seedArtifact(db, { id: "source", type: "source_document" });
		seedArtifact(db, { id: "normalized", type: "normalized_document" });
		sqlite.close();

		expect(await orphanIds()).toEqual([]);
	});

	it("scopes to one user when asked", async () => {
		const { sqlite, db } = openSeedDatabase();
		seedBase(db);
		db.insert(schema.users)
			.values({
				id: "other",
				email: "other@example.com",
				passwordHash: "hash",
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		seedArtifact(db, { id: "mine" });
		seedArtifact(db, { id: "theirs", userId: "other" });
		sqlite.close();

		const { listOrphanGeneratedArtifacts } = await import("./orphan-artifacts");
		expect(
			(await listOrphanGeneratedArtifacts({ userId: USER })).map(
				(row) => row.id,
			),
		).toEqual(["mine"]);
		expect((await listOrphanGeneratedArtifacts()).length).toBe(2);
	});
});

describe("forget_all_results", () => {
	beforeEach(async () => {
		dbPath = `/tmp/alfyai-orphan-bulk-${randomUUID()}.db`;
		storageDir = await mkdtemp(join(tmpdir(), "alfyai-orphan-bulk-"));
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// Never imported.
		}
		await rm(dbPath, { force: true }).catch(() => undefined);
		await rm(storageDir, { recursive: true, force: true }).catch(
			() => undefined,
		);
	});

	it("now removes the orphans it used to skip", async () => {
		const { sqlite, db } = openSeedDatabase();
		seedBase(db);
		seedConversation(db, "conv-live");
		seedArtifact(db, { id: "visible", conversationId: "conv-live" });
		seedArtifact(db, { id: "stranded" });
		sqlite.close();

		const { deleteKnowledgeArtifactsByAction } = await import("./cleanup");
		const result = await deleteKnowledgeArtifactsByAction(
			USER,
			"forget_all_results",
		);

		expect(result.deletedArtifactIds.sort()).toEqual(["stranded", "visible"]);

		const { db: liveDb } = await import("$lib/server/db");
		expect(await liveDb.select().from(schema.artifacts)).toEqual([]);
	});

	// The sweep's whole reason to exist is a box that ran the old delete path
	// for a long time, so "many stranded rows" is its NORMAL input, not an edge
	// case. SQLite's bound-parameter ceiling is 32766, and the reachability
	// passes spend TWO parameters per candidate (`artifact_id` OR
	// `related_artifact_id`), so the predicate stopped working at roughly 16k
	// candidates — by throwing, from inside the cutover script, having reported
	// nothing.
	it("handles more candidates than SQLite's bound-parameter ceiling", async () => {
		const { sqlite, db } = openSeedDatabase();
		seedBase(db);
		const insert = sqlite.prepare(
			"INSERT INTO artifacts (id, user_id, conversation_id, type, retrieval_class, name, created_at, updated_at) VALUES (?, ?, NULL, 'generated_output', 'durable', 'report.docx', 0, 0)",
		);
		const seedMany = sqlite.transaction((count: number) => {
			for (let index = 0; index < count; index += 1) {
				insert.run(`stranded-${index}`, USER);
			}
		});
		seedMany(17_000);
		sqlite.close();

		const { listOrphanGeneratedArtifacts } = await import("./orphan-artifacts");
		expect((await listOrphanGeneratedArtifacts()).length).toBe(17_000);

		// And the delete side of the same sweep, which batches the ids into an
		// `IN (...)` of its own.
		const { hardDeleteArtifactsForUser } = await import("./cleanup");
		const ids = Array.from({ length: 17_000 }, (_, i) => `stranded-${i}`);
		const result = await hardDeleteArtifactsForUser(USER, ids);
		expect(result.deletedArtifactIds.length).toBe(17_000);
	}, 120_000);

	it("does not touch a reachable orphan candidate", async () => {
		const { sqlite, db } = openSeedDatabase();
		seedBase(db);
		seedConversation(db, "conv-live");
		seedArtifact(db, { id: "capsule", type: "work_capsule" });
		db.insert(schema.artifactLinks)
			.values({
				id: "link-capsule",
				userId: USER,
				artifactId: "capsule",
				conversationId: "conv-live",
				linkType: "captured_by_capsule",
				createdAt: NOW,
			})
			.run();
		sqlite.close();

		const { deleteKnowledgeArtifactsByAction } = await import("./cleanup");
		const result = await deleteKnowledgeArtifactsByAction(
			USER,
			"forget_all_results",
		);

		// A work capsule is not a "generated result" anyway, and this one is
		// reachable besides.
		expect(result.deletedArtifactIds).toEqual([]);
	});
});

// The two bulk actions must answer the same question about unreachable rows.
// `forget_all_results` learned to include `generated_output` orphans in this
// release; `forget_all_workflows` did not, so "forget all workflows" left the
// user's stranded capsules exactly where they were — the same bug, on the other
// button, with the same shared predicate sitting right there.
describe("forget_all_workflows", () => {
	beforeEach(async () => {
		dbPath = `/tmp/alfyai-orphan-wf-${randomUUID()}.db`;
		storageDir = await mkdtemp(join(tmpdir(), "alfyai-orphan-wf-"));
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// Never imported.
		}
		await rm(dbPath, { force: true }).catch(() => undefined);
		await rm(storageDir, { recursive: true, force: true }).catch(
			() => undefined,
		);
	});

	it("removes the stranded work capsules it used to skip", async () => {
		const { sqlite, db } = openSeedDatabase();
		seedBase(db);
		seedConversation(db, "conv-live");
		seedArtifact(db, {
			id: "visible",
			type: "work_capsule",
			conversationId: "conv-live",
		});
		seedArtifact(db, { id: "stranded", type: "work_capsule" });
		sqlite.close();

		const { deleteKnowledgeArtifactsByAction } = await import("./cleanup");
		const result = await deleteKnowledgeArtifactsByAction(
			USER,
			"forget_all_workflows",
		);

		expect(result.deletedArtifactIds.sort()).toEqual(["stranded", "visible"]);
	});

	it("leaves a stranded generated output alone", async () => {
		const { sqlite, db } = openSeedDatabase();
		seedBase(db);
		seedArtifact(db, { id: "stranded-output" });
		seedArtifact(db, { id: "stranded-capsule", type: "work_capsule" });
		sqlite.close();

		const { deleteKnowledgeArtifactsByAction } = await import("./cleanup");
		const result = await deleteKnowledgeArtifactsByAction(
			USER,
			"forget_all_workflows",
		);

		// Each button owns exactly one type, orphans included.
		expect(result.deletedArtifactIds).toEqual(["stranded-capsule"]);
	});
});
