// A migrated, seeded SQLite file for the image kind's tests. Like the jobs and
// file-production fixtures it talks to better-sqlite3 directly: the modules
// under test capture the `$lib/server/db` singleton at import time, so a test
// creates this file FIRST, points `DATABASE_PATH` at it, resets the module
// registry and only then imports the app.

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { vi } from "vitest";
import * as schema from "$lib/server/db/schema";

export interface ImageFixture {
	dbPath: string;
	sqlite: InstanceType<typeof Database>;
	seedUser(id: string): string;
	seedConversation(id: string, userId: string): string;
	seedCard(input: {
		id: string;
		userId: string;
		conversationId: string;
		turnId?: string;
	}): string;
	cleanup(): void;
}

export function createImageFixture(prefix = "images"): ImageFixture {
	const dbPath = join(tmpdir(), `alfyai-${prefix}-${randomUUID()}.db`);
	const sqlite = new Database(dbPath);
	sqlite.pragma("journal_mode = WAL");
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });

	return {
		dbPath,
		sqlite,
		seedUser(id) {
			db.insert(schema.users)
				.values({ id, email: `${id}@example.com`, passwordHash: "hash" })
				.run();
			return id;
		},
		seedConversation(id, userId) {
			db.insert(schema.conversations)
				.values({ id, userId, title: `Conversation ${id}` })
				.run();
			return id;
		},
		seedCard(input) {
			db.insert(schema.imageCards)
				.values({
					id: input.id,
					userId: input.userId,
					conversationId: input.conversationId,
					turnId: input.turnId ?? "turn-1",
					title: "A picture",
					madeFrom: "words",
				})
				.run();
			return input.id;
		},
		cleanup() {
			try {
				sqlite.close();
			} catch {
				// Closed already.
			}
			for (const suffix of ["", "-wal", "-shm"]) {
				if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
			}
		},
	};
}

/**
 * Loads the heavy module graph once, before any test runs. Each test resets the
 * module registry so the app sees its own database file, which makes the first
 * import of a file's graph (the artifacts facade, sharp, the job engine) the
 * cost the first test pays: seconds when many workers transform at once. Run
 * this from `beforeAll` and the tests only re-evaluate cached modules.
 *
 * It points `DATABASE_PATH` at a throwaway migrated file for the import (the
 * database module opens its file when loaded), then closes it and resets the
 * registry again so no test sees this copy.
 */
export async function warmModules(
	loaders: Array<() => Promise<unknown>>,
): Promise<void> {
	const fixture = createImageFixture("image-warm");
	const previous = process.env.DATABASE_PATH;
	process.env.DATABASE_PATH = fixture.dbPath;
	try {
		await Promise.all(loaders.map((load) => load()));
		const { sqlite } = await import("$lib/server/db");
		sqlite.close();
	} finally {
		if (previous === undefined) delete process.env.DATABASE_PATH;
		else process.env.DATABASE_PATH = previous;
		fixture.cleanup();
		vi.resetModules();
	}
}
