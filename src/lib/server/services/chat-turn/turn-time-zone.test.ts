import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import { resolveTurnTimeZone } from "./turn-time-zone";

// The zone a turn's clock is told in, read for the turn from the person's own
// row (real rows: the column is the migration's). It degrades to null, never to
// a failed turn: a null zone is a clock that keeps the server's date and says
// the zone is unknown.

let userId: string;

beforeEach(async () => {
	userId = randomUUID();
	await db.insert(users).values({
		id: userId,
		email: `${userId}@example.com`,
		passwordHash: "hash",
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	await db.delete(users).where(eq(users.id, userId));
});

async function store(timeZone: string | null) {
	await db.update(users).set({ timeZone }).where(eq(users.id, userId));
}

describe("resolveTurnTimeZone", () => {
	it("is null for a person no browser has saved a zone for yet", async () => {
		expect(await resolveTurnTimeZone(userId)).toBeNull();
	});

	it("returns the zone the person has stored", async () => {
		await store("Europe/Budapest");

		expect(await resolveTurnTimeZone(userId)).toBe("Europe/Budapest");
	});

	it("reads it again every turn: a zone changed between two turns is the next turn's clock", async () => {
		await store("Europe/Budapest");
		expect(await resolveTurnTimeZone(userId)).toBe("Europe/Budapest");

		await store("Asia/Tokyo");

		expect(await resolveTurnTimeZone(userId)).toBe("Asia/Tokyo");
	});

	it("is null for a stored name this runtime does not read, never the name", async () => {
		await store("Mars/Olympus");

		expect(await resolveTurnTimeZone(userId)).toBeNull();
	});

	it("is null for a person who is not there", async () => {
		expect(await resolveTurnTimeZone(randomUUID())).toBeNull();
	});

	it("is null, and says so in the log, when the read itself fails: the turn goes on", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(db, "select").mockImplementationOnce(() => {
			throw new Error("database is locked");
		});

		expect(await resolveTurnTimeZone(userId)).toBeNull();
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("[NORMAL_CHAT_CONTEXT]"),
			expect.objectContaining({ error: "database is locked" }),
		);
	});
});
