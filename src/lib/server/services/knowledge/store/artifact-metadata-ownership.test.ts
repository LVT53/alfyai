// updateArtifactMetadata used to UPDATE by artifact id alone. Artifact ids are
// opaque but enumerable, so an id-only write let one account's ingestion patch
// metadata onto another account's artifact (a latent IDOR). These tests run
// against a real migrated SQLite file so they exercise the actual WHERE clause
// rather than a mocked query builder.
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

const NOW = new Date("2026-09-06T10:00:00.000Z");

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
				id: "attacker",
				email: "attacker@example.com",
				passwordHash: "hash",
				createdAt: NOW,
				updatedAt: NOW,
			},
		])
		.run();
	db.insert(schema.artifacts)
		.values({
			id: "artifact-1",
			userId: "owner",
			type: "source_document",
			retrievalClass: "durable",
			name: "contract.pdf",
			metadataJson: JSON.stringify({ uploadSource: "chat" }),
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

function readMetadata(
	db: ReturnType<typeof openSeedDatabase>["db"],
): Record<string, unknown> {
	const row = db
		.select({ metadataJson: schema.artifacts.metadataJson })
		.from(schema.artifacts)
		.all()
		.at(0);
	return JSON.parse(row?.metadataJson ?? "{}") as Record<string, unknown>;
}

describe("updateArtifactMetadata ownership scope", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-artifact-metadata-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// The DB module is only loaded by tests that reached the service.
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// Best-effort cleanup of the temporary database file.
		}
	});

	it("is a no-op when the userId does not own the artifact", async () => {
		const { sqlite, db } = openSeedDatabase();
		seed(db);
		sqlite.close();

		const { updateArtifactMetadata } = await import("./core");
		await updateArtifactMetadata({
			artifactId: "artifact-1",
			userId: "attacker",
			patch: { tokenEstimate: 999, injected: true },
		});

		const verify = openSeedDatabase();
		expect(readMetadata(verify.db)).toEqual({ uploadSource: "chat" });
		verify.sqlite.close();
	});

	it("merges the patch for the owning user without dropping existing keys", async () => {
		const { sqlite, db } = openSeedDatabase();
		seed(db);
		sqlite.close();

		const { updateArtifactMetadata } = await import("./core");
		await updateArtifactMetadata({
			artifactId: "artifact-1",
			userId: "owner",
			patch: { tokenEstimate: 4_200, pageCount: 38 },
		});

		const verify = openSeedDatabase();
		expect(readMetadata(verify.db)).toEqual({
			uploadSource: "chat",
			tokenEstimate: 4_200,
			pageCount: 38,
		});
		verify.sqlite.close();
	});

	it("is a no-op for an artifact id that does not exist", async () => {
		const { sqlite, db } = openSeedDatabase();
		seed(db);
		sqlite.close();

		const { updateArtifactMetadata } = await import("./core");
		await updateArtifactMetadata({
			artifactId: "missing",
			userId: "owner",
			patch: { tokenEstimate: 1 },
		});

		const verify = openSeedDatabase();
		expect(readMetadata(verify.db)).toEqual({ uploadSource: "chat" });
		verify.sqlite.close();
	});
});
