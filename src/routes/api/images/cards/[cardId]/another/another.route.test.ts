// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createImageFixture,
	type ImageFixture,
} from "$lib/server/services/images/testing/fixture";
import { insertTake } from "$lib/server/services/images/testing/takes";

let fixture: ImageFixture;

beforeEach(() => {
	fixture = createImageFixture("image-another-route");
	fixture.seedUser("u1");
	fixture.seedUser("u2");
	fixture.seedConversation("c1", "u1");
	fixture.seedCard({ id: "card-1", userId: "u1", conversationId: "c1" });
	process.env.DATABASE_PATH = fixture.dbPath;
	process.env.COMFYUI_URL = "http://127.0.0.1:9";
	vi.resetModules();
});

afterEach(async () => {
	try {
		const { sqlite } = await import("$lib/server/db");
		sqlite.close();
	} catch {
		// The database module was never imported.
	}
	delete process.env.COMFYUI_URL;
	fixture.cleanup();
	vi.restoreAllMocks();
});

function event(cardId: string, userId: string, query = "") {
	return {
		params: { cardId },
		url: new URL(`http://localhost/api/images/cards/${cardId}/another${query}`),
		locals: { user: { id: userId, role: "user" } },
	} as never;
}

const base = { userId: "u1", conversationId: "c1", cardId: "card-1" };

describe("POST /api/images/cards/[cardId]/another", () => {
	it("answers 201 with the new take's id", async () => {
		const { POST } = await import("./+server");
		await insertTake(base);
		const res = (await POST(
			event("card-1", "u1", "?conversationId=c1"),
		)) as Response;
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({ takeId: expect.any(String) });
	});

	it("answers 404 for another person's card and 409 past eight takes", async () => {
		const { POST } = await import("./+server");
		for (let i = 0; i < 8; i += 1) await insertTake({ ...base, seed: 50 + i });
		expect(((await POST(event("card-1", "u2"))) as Response).status).toBe(404);
		const full = (await POST(event("card-1", "u1"))) as Response;
		expect(full.status).toBe(409);
		expect(await full.json()).toEqual({ error: "too_many_takes" });
	});
});
