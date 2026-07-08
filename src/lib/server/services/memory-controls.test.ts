import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;
let sqlite: Database.Database;

vi.mock("$lib/server/db", () => ({
	get db() {
		return drizzle(sqlite, { schema });
	},
}));

function seedUser(userId: string, memoryEnabled: boolean) {
	const db = drizzle(sqlite, { schema });
	const now = new Date();
	db.insert(schema.users)
		.values({
			id: userId,
			email: `${userId}@example.com`,
			passwordHash: "hash",
			memoryEnabled,
			createdAt: now,
			updatedAt: now,
		})
		.run();
}

function seedConversation(id: string, userId: string, incognito: boolean) {
	const db = drizzle(sqlite, { schema });
	const now = new Date();
	db.insert(schema.conversations)
		.values({
			id,
			userId,
			title: "c",
			memoryIncognito: incognito,
			createdAt: now,
			updatedAt: now,
		})
		.run();
}

beforeEach(() => {
	dbPath = `./data/test-memory-controls-${randomUUID()}.db`;
	sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	migrate(drizzle(sqlite, { schema }), { migrationsFolder: "./drizzle" });
});

afterEach(() => {
	sqlite.close();
	try {
		unlinkSync(dbPath);
	} catch {
		// best effort
	}
});

describe("memory-controls gates", () => {
	it("isUserMemoryEnabled reflects the flag and fails open for unknown users", async () => {
		const { isUserMemoryEnabled } = await import("./memory-controls");
		seedUser("on", true);
		seedUser("off", false);
		expect(await isUserMemoryEnabled("on")).toBe(true);
		expect(await isUserMemoryEnabled("off")).toBe(false);
		// Missing user → fail open (do not silently drop memory for a valid id).
		expect(await isUserMemoryEnabled("ghost")).toBe(true);
	});

	it("isConversationIncognito reflects the flag and defaults false for unknown conversations", async () => {
		const { isConversationIncognito } = await import("./memory-controls");
		seedUser("u", true);
		seedConversation("normal", "u", false);
		seedConversation("secret", "u", true);
		expect(await isConversationIncognito("normal")).toBe(false);
		expect(await isConversationIncognito("secret")).toBe(true);
		expect(await isConversationIncognito("missing")).toBe(false);
	});

	it("isMemoryActiveForConversation requires memory on AND not incognito", async () => {
		const { isMemoryActiveForConversation } = await import("./memory-controls");
		seedUser("on", true);
		seedUser("off", false);
		seedConversation("c-on-normal", "on", false);
		seedConversation("c-on-secret", "on", true);
		seedConversation("c-off-normal", "off", false);

		expect(
			await isMemoryActiveForConversation({
				userId: "on",
				conversationId: "c-on-normal",
			}),
		).toBe(true);
		// Incognito conversation → inactive even though the user has memory on.
		expect(
			await isMemoryActiveForConversation({
				userId: "on",
				conversationId: "c-on-secret",
			}),
		).toBe(false);
		// Master toggle off → inactive even for a normal conversation.
		expect(
			await isMemoryActiveForConversation({
				userId: "off",
				conversationId: "c-off-normal",
			}),
		).toBe(false);
	});
});
