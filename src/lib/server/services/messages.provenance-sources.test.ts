import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db } from "$lib/server/db";
import { conversations, messages, users } from "$lib/server/db/schema";
import {
	CONVERSATION_PROVENANCE_MESSAGE_LIMIT,
	listConversationProvenanceSources,
} from "./messages";

// listConversationProvenanceSources is the one read the provenance rule needs
// when the turn that asks is not stored yet: the user's own words and the calls
// the tools answered, for one of the user's own conversations. It runs against a
// real migrated database, because the point is the ownership scope and the
// ordering, which a hand-rolled mock would only restate.

async function seedUser(): Promise<string> {
	const id = `user-${randomUUID()}`;
	await db
		.insert(users)
		.values({ id, email: `${id}@example.com`, passwordHash: "hash" });
	return id;
}

async function seedConversation(userId: string): Promise<string> {
	const id = `conversation-${randomUUID()}`;
	await db.insert(conversations).values({ id, userId, title: "Provenance" });
	return id;
}

let sequence = 0;
async function seedMessage(params: {
	conversationId: string;
	role: "user" | "assistant" | "system";
	content: string;
	toolCalls?: unknown;
}) {
	sequence += 1;
	await db.insert(messages).values({
		id: `message-${randomUUID()}`,
		conversationId: params.conversationId,
		role: params.role,
		content: params.content,
		messageSequence: sequence,
		toolCalls:
			params.toolCalls === undefined ? null : JSON.stringify(params.toolCalls),
	});
}

const researchCall = (url: string) => ({
	type: "tool_call",
	name: "research_web",
	input: { query: "q" },
	status: "done",
	candidates: [{ id: "c1", title: "Result", url, sourceType: "web" }],
});

describe("listConversationProvenanceSources", () => {
	it("reads the user's messages newest first and the tool calls of the assistant's, and nothing else", async () => {
		const userId = await seedUser();
		const conversationId = await seedConversation(userId);
		await seedMessage({
			conversationId,
			role: "system",
			content: "system text",
		});
		await seedMessage({
			conversationId,
			role: "user",
			content: "first question",
		});
		await seedMessage({
			conversationId,
			role: "assistant",
			content: "answer https://model-words.example/",
			toolCalls: [
				{ type: "text", content: "thinking" },
				researchCall("https://found.example/a"),
			],
		});
		await seedMessage({
			conversationId,
			role: "user",
			content: "second question",
		});
		await seedMessage({
			conversationId,
			role: "assistant",
			content: "no tools here",
		});

		const sources = await listConversationProvenanceSources({
			conversationId,
			userId,
		});

		expect(sources.userTexts).toEqual(["second question", "first question"]);
		expect(sources.toolCalls).toHaveLength(1);
		expect(sources.toolCalls[0]?.candidates?.[0]?.url).toBe(
			"https://found.example/a",
		);
	});

	it("reads nothing of a conversation that is not the user's, or does not exist", async () => {
		const owner = await seedUser();
		const stranger = await seedUser();
		const conversationId = await seedConversation(owner);
		await seedMessage({
			conversationId,
			role: "user",
			content: "private words",
		});
		await seedMessage({
			conversationId,
			role: "assistant",
			content: "a",
			toolCalls: [researchCall("https://private.example/")],
		});

		await expect(
			listConversationProvenanceSources({ conversationId, userId: stranger }),
		).resolves.toEqual({ userTexts: [], toolCalls: [] });
		await expect(
			listConversationProvenanceSources({
				conversationId: "no-such-conversation",
				userId: owner,
			}),
		).resolves.toEqual({ userTexts: [], toolCalls: [] });
	});

	it("skips a malformed tool-call record and keeps reading", async () => {
		const userId = await seedUser();
		const conversationId = await seedConversation(userId);
		sequence += 1;
		await db.insert(messages).values({
			id: `message-${randomUUID()}`,
			conversationId,
			role: "assistant",
			content: "broken record",
			messageSequence: sequence,
			toolCalls: "{not json",
		});
		await seedMessage({
			conversationId,
			role: "assistant",
			content: "fine",
			toolCalls: [researchCall("https://found.example/a")],
		});

		const sources = await listConversationProvenanceSources({
			conversationId,
			userId,
		});

		expect(sources.toolCalls).toHaveLength(1);
	});

	it("bounds how many of the newest messages it reads", async () => {
		const userId = await seedUser();
		const conversationId = await seedConversation(userId);
		for (let index = 0; index < 5; index += 1) {
			await seedMessage({
				conversationId,
				role: "user",
				content: `message ${index}`,
			});
		}

		const sources = await listConversationProvenanceSources({
			conversationId,
			userId,
			limit: 2,
		});

		expect(sources.userTexts).toEqual(["message 4", "message 3"]);
		expect(CONVERSATION_PROVENANCE_MESSAGE_LIMIT).toBeGreaterThan(100);
	});
});
