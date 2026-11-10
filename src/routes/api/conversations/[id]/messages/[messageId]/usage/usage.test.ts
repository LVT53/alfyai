import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "$lib/server/db";
import {
	conversations,
	messages,
	usageEvents,
	users,
} from "$lib/server/db/schema";
import { GET } from "./+server";

vi.mock("$lib/server/auth/hooks", () => ({ requireAuth: vi.fn() }));

let owner: string;
let conversationId: string;
let messageId: string;

beforeEach(async () => {
	owner = randomUUID();
	conversationId = randomUUID();
	messageId = randomUUID();
	await db.insert(users).values({
		id: owner,
		email: `${owner}@example.com`,
		passwordHash: "test",
		name: "Usage reader",
	});
	await db
		.insert(conversations)
		.values({ id: conversationId, userId: owner, title: "Cost" });
	await db.insert(messages).values({
		id: messageId,
		conversationId,
		role: "assistant",
		content: "Answer",
	});
});

async function read(
	asUser = owner,
	inConversation = conversationId,
	id = messageId,
) {
	return GET({
		locals: { user: { id: asUser } },
		params: { id: inConversation, messageId: id },
	} as Parameters<typeof GET>[0]);
}

async function recordUsage(
	id = messageId,
	costUsdMicros = 125000,
	totalTokens = 50,
) {
	await db.insert(usageEvents).values({
		id: randomUUID(),
		userId: owner,
		conversationId,
		messageId: id,
		modelId: "model1",
		billingMonth: "2026-11",
		costUsdMicros,
		totalTokens,
		generationTimeMs: 2500,
	});
}

describe("message usage read", () => {
	it("reports pending until accounting lands, then returns message cost and conversation totals", async () => {
		const pending = await read();
		expect(pending.status).toBe(202);
		expect(await pending.json()).toEqual({ status: "pending" });
		await recordUsage();
		const ready = await read();
		expect(ready.status).toBe(200);
		expect(await ready.json()).toEqual({
			status: "ready",
			costUsd: 0.125,
			generationDurationMs: 2500,
			totalCostUsdMicros: 125000,
			totalTokens: 50,
		});
	});
	it("treats a recorded zero cost as ready", async () => {
		await recordUsage(messageId, 0, 0);
		expect(await (await read()).json()).toMatchObject({
			status: "ready",
			costUsd: 0,
			totalCostUsdMicros: 0,
		});
	});
	it("includes prior turns in the total without changing the current turn cost", async () => {
		await recordUsage(randomUUID(), 200000, 80);
		await recordUsage();
		expect(await (await read()).json()).toMatchObject({
			costUsd: 0.125,
			totalCostUsdMicros: 325000,
			totalTokens: 130,
		});
	});
	it("ends polling for an incognito conversation", async () => {
		const { eq } = await import("drizzle-orm");
		await db
			.update(conversations)
			.set({ memoryIncognito: true })
			.where(eq(conversations.id, conversationId));
		expect(await (await read()).json()).toEqual({ status: "untracked" });
	});
	it("does not expose a conversation or message to another user", async () => {
		await recordUsage();
		expect((await read(randomUUID())).status).toBe(404);
		expect((await read(owner, conversationId, randomUUID())).status).toBe(404);
		const other = randomUUID();
		await db
			.insert(conversations)
			.values({ id: other, userId: owner, title: "Other" });
		expect((await read(owner, other)).status).toBe(404);
	});
});
