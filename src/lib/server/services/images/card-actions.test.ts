// @vitest-environment node
//
// Another: the card's first request again, a seed unlike every seed in the
// card, at most eight visible takes.

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import { createImageFixture, type ImageFixture } from "./testing/fixture";
import { insertTake, takeRequest } from "./testing/takes";

let fixture: ImageFixture;

beforeEach(async () => {
	fixture = createImageFixture("image-card-actions");
	fixture.seedUser("u1");
	fixture.seedUser("u2");
	fixture.seedConversation("c1", "u1");
	fixture.seedCard({ id: "card-1", userId: "u1", conversationId: "c1" });
	process.env.DATABASE_PATH = fixture.dbPath;
	process.env.COMFYUI_URL = "http://127.0.0.1:9";
	delete process.env.COMFYUI_H3_URL;
	delete process.env.IMAGE_MODEL;
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
	delete process.env.COMFYUI_H3_URL;
	delete process.env.IMAGE_MODEL;
	fixture.cleanup();
	vi.restoreAllMocks();
});

const base = { userId: "u1", conversationId: "c1", cardId: "card-1" };

/** The live Admin switch and both server URLs, as the config store holds them. */
async function configurePictureModels(
	selected: "qwen" | "h3",
	urls: { qwen?: string; h3?: string },
): Promise<void> {
	const { getConfig } = await import("$lib/server/config-store");
	const config = getConfig();
	config.imageModel = selected;
	config.comfyuiUrl = urls.qwen ?? "";
	config.comfyuiH3Url = urls.h3 ?? "";
}

async function queuedRequest(takeId: string): Promise<Record<string, unknown>> {
	const { db } = await import("$lib/server/db");
	const [row] = db
		.select()
		.from(schema.imageJobs)
		.where(eq(schema.imageJobs.id, takeId))
		.all();
	if (!row) throw new Error("No queued take");
	return JSON.parse(row.requestJson) as Record<string, unknown>;
}

describe("anotherTake", () => {
	it("queues the first take's request with origin another and a seed unlike the card's", async () => {
		const { anotherTake } = await import("./card-actions");
		const { db } = await import("$lib/server/db");
		await insertTake({
			...base,
			seed: 11,
			request: takeRequest({ prompt: "first prompt", avoidSeeds: [5] }),
		});
		await insertTake({
			...base,
			seed: 12,
			request: takeRequest({ prompt: "second prompt" }),
		});

		const result = await anotherTake({ userId: "u1", cardId: "card-1" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const [row] = db
			.select()
			.from(schema.imageJobs)
			.where(eq(schema.imageJobs.id, result.takeId))
			.all();
		expect(row.origin).toBe("another");
		expect(row.heldUntil).toBeNull();
		expect(row.cardId).toBe("card-1");
		expect([5, 11, 12]).not.toContain(row.seed);
		const request = JSON.parse(row.requestJson);
		expect(request.prompt).toBe("first prompt");
		expect(request.avoidSeeds).toEqual(expect.arrayContaining([5, 11, 12]));
	});

	it("refuses the ninth visible take, counting only visible ones", async () => {
		const { anotherTake } = await import("./card-actions");
		for (let i = 0; i < 7; i += 1) await insertTake({ ...base, seed: 100 + i });
		await insertTake({ ...base, seed: 200, hidden: true });
		expect((await anotherTake({ userId: "u1", cardId: "card-1" })).ok).toBe(
			true,
		);
		expect(await anotherTake({ userId: "u1", cardId: "card-1" })).toEqual({
			ok: false,
			reason: "too_many_takes",
		});
	});

	it("is not_configured without a picture server address", async () => {
		delete process.env.COMFYUI_URL;
		vi.resetModules();
		const { anotherTake } = await import("./card-actions");
		await insertTake(base);
		expect(await anotherTake({ userId: "u1", cardId: "card-1" })).toEqual({
			ok: false,
			reason: "not_configured",
		});
	});

	it("uses the card's Qwen model while H3 is selected, even with no H3 address", async () => {
		await insertTake({
			...base,
			request: takeRequest({ model: "qwen", prompt: "a qwen card" }),
		});
		await configurePictureModels("h3", { qwen: "http://127.0.0.1:8188" });
		const { anotherTake } = await import("./card-actions");
		const result = await anotherTake({ userId: "u1", cardId: "card-1" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(await queuedRequest(result.takeId)).toMatchObject({
			model: "qwen",
			prompt: "a qwen card",
		});
	});

	it("uses the card's H3 model while Qwen is selected, even with no Qwen address", async () => {
		await insertTake({
			...base,
			request: takeRequest({ model: "h3", prompt: "an H3 card" }),
		});
		await configurePictureModels("qwen", { h3: "http://127.0.0.1:8189" });
		const { anotherTake } = await import("./card-actions");
		const result = await anotherTake({ userId: "u1", cardId: "card-1" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(await queuedRequest(result.takeId)).toMatchObject({
			model: "h3",
			prompt: "an H3 card",
		});
	});

	it("keeps not_configured when the card's own model has no address", async () => {
		await insertTake({
			...base,
			request: takeRequest({ model: "h3", prompt: "an H3 card" }),
		});
		// The selected model (Qwen) has an address; the card's model (H3) has none.
		await configurePictureModels("qwen", { qwen: "http://127.0.0.1:8188" });
		const { anotherTake } = await import("./card-actions");
		expect(await anotherTake({ userId: "u1", cardId: "card-1" })).toEqual({
			ok: false,
			reason: "not_configured",
		});
	});

	it("is not_found for another person's card, a wrong chat or a card with no take", async () => {
		const { anotherTake } = await import("./card-actions");
		expect(await anotherTake({ userId: "u1", cardId: "card-1" })).toEqual({
			ok: false,
			reason: "not_found",
		});
		await insertTake(base);
		expect(await anotherTake({ userId: "u2", cardId: "card-1" })).toEqual({
			ok: false,
			reason: "not_found",
		});
		expect(
			await anotherTake({
				userId: "u1",
				cardId: "card-1",
				conversationId: "other",
			}),
		).toEqual({ ok: false, reason: "not_found" });
	});

	it("serves an incognito chat only when the request names it", async () => {
		const { db } = await import("$lib/server/db");
		const { anotherTake } = await import("./card-actions");
		db.update(schema.conversations)
			.set({ memoryIncognito: true })
			.where(eq(schema.conversations.id, "c1"))
			.run();
		await insertTake(base);
		expect(await anotherTake({ userId: "u1", cardId: "card-1" })).toEqual({
			ok: false,
			reason: "not_found",
		});
		expect(
			(
				await anotherTake({
					userId: "u1",
					cardId: "card-1",
					conversationId: "c1",
				})
			).ok,
		).toBe(true);
	});
});
