// A migrated, seeded SQLite file for ledger tests.
//
// It talks to better-sqlite3 directly rather than to `$lib/server/db`, because
// the module under test captures that singleton at import time: a test has to
// create and seed the file BEFORE it imports the ledger, and a helper that went
// through the singleton would open the previous test's database.
//
// Shared rather than copied because five test files and the slices after this
// one all need the same three rows, and a fixture that lives in one `.test.ts`
// gets copied and then drifts.

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "$lib/server/db/schema";

export interface SeededArtifactInput {
	id?: string;
	userId: string;
	name?: string;
	type?: "source_document" | "normalized_document" | "generated_output";
	mimeType?: string | null;
	sizeBytes?: number;
	storagePath?: string | null;
	binaryHash?: string | null;
	contentText?: string | null;
	conversationId?: string | null;
	createdAt?: Date;
	/** `artifacts.metadata_json`. `extractionTier` lives here. */
	metadata?: Record<string, unknown> | null;
}

export interface LedgerFixture {
	dbPath: string;
	sqlite: InstanceType<typeof Database>;
	db: ReturnType<typeof drizzle<typeof schema>>;
	seedUser(id: string): string;
	seedConversation(id: string, userId: string): string;
	seedArtifact(input: SeededArtifactInput): string;
	seedNormalizedLink(params: {
		userId: string;
		normalizedArtifactId: string;
		sourceArtifactId: string;
	}): void;
	close(): void;
	cleanup(): void;
}

/**
 * Creates a fresh migrated database file. The caller is responsible for setting
 * `process.env.DATABASE_PATH` to `dbPath` and calling `vi.resetModules()`
 * before importing anything under `$lib/server`.
 */
export function createLedgerFixture(prefix = "extraction"): LedgerFixture {
	const dbPath = `/tmp/alfyai-${prefix}-${randomUUID()}.db`;
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });

	const epoch = new Date("2026-09-20T09:00:00.000Z");

	return {
		dbPath,
		sqlite,
		db,
		seedUser(id: string): string {
			db.insert(schema.users)
				.values({
					id,
					email: `${id}@example.com`,
					passwordHash: "hash",
				})
				.run();
			return id;
		},
		seedConversation(id: string, userId: string): string {
			db.insert(schema.conversations)
				.values({
					id,
					userId,
					title: `Conversation ${id}`,
					createdAt: epoch,
					updatedAt: epoch,
				})
				.run();
			return id;
		},
		seedArtifact(input: SeededArtifactInput): string {
			const id = input.id ?? randomUUID();
			const createdAt = input.createdAt ?? epoch;
			db.insert(schema.artifacts)
				.values({
					id,
					userId: input.userId,
					conversationId: input.conversationId ?? null,
					type: input.type ?? "source_document",
					name: input.name ?? "document.pdf",
					mimeType: input.mimeType ?? "application/pdf",
					sizeBytes: input.sizeBytes ?? 1024,
					storagePath: input.storagePath ?? null,
					binaryHash: input.binaryHash ?? null,
					contentText: input.contentText ?? null,
					metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
					createdAt,
					updatedAt: createdAt,
				})
				.run();
			return id;
		},
		seedNormalizedLink(params): void {
			db.insert(schema.artifactLinks)
				.values({
					id: randomUUID(),
					userId: params.userId,
					artifactId: params.normalizedArtifactId,
					relatedArtifactId: params.sourceArtifactId,
					linkType: "derived_from",
					createdAt: epoch,
				})
				.run();
		},
		close(): void {
			sqlite.close();
		},
		cleanup(): void {
			try {
				sqlite.close();
			} catch {
				// Already closed by the test; nothing to do.
			}
			for (const suffix of ["", "-wal", "-shm"]) {
				const path = `${dbPath}${suffix}`;
				if (existsSync(path)) unlinkSync(path);
			}
		},
	};
}
