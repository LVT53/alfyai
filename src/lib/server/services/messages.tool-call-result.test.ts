// `updateAssistantToolCallResult` names a row by its ids, and a message id on its
// own must never be enough to rewrite a row of another conversation or one that
// is not an assistant's. The hand-rolled mock in messages.test.ts ignores its
// where-clause, so it cannot tell a write scoped to the row from an unscoped
// one: the scoping, and the read back through the read model the page uses, are
// proved here on real migrated SQLite.
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import {
	NOW,
	seedConversation,
	seedUser,
} from "$lib/server/services/artifacts/artifacts.test-helpers";

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

const { listMessages, updateAssistantToolCallResult } = await import(
	"./messages"
);

const OWNER = "user-owner";
const CONVERSATION = "conv-asked";
const OTHER_CONVERSATION = "conv-other";

const research = {
	type: "tool_call",
	callId: "call-research",
	name: "research_web",
	input: { query: "party ideas" },
	status: "done",
	outputSummary: "Web research returned 2 sources.",
	resultDigest: "Two venues were found.",
};
const asked = {
	type: "tool_call",
	callId: "call-ask",
	name: "ask_user",
	input: { questions: [{ question: "Which way should we take it?" }] },
	status: "done",
	outputSummary: "Asked the user; the reply paused for the answer.",
	metadata: { paused: true, questionId: "question-1" },
};
const TIMELINE = JSON.stringify([research, asked]);

const answer = {
	conversationId: CONVERSATION,
	messageId: "asking-1",
	callId: "call-ask",
	outputSummary: "The user picked: A party at home",
	resultDigest: '{"status":"answered"}',
};

function readToolCalls(messageId: string): string | null {
	return (
		memory.db
			.select({ toolCalls: schema.messages.toolCalls })
			.from(schema.messages)
			.where(eq(schema.messages.id, messageId))
			.get()?.toolCalls ?? null
	);
}

beforeEach(() => {
	memory = createInMemoryDatabase();
	seedUser(memory, OWNER);
	seedConversation(memory, { id: CONVERSATION, userId: OWNER });
	seedConversation(memory, { id: OTHER_CONVERSATION, userId: OWNER });
	memory.db
		.insert(schema.messages)
		.values([
			{
				id: "asking-1",
				conversationId: CONVERSATION,
				messageSequence: 1,
				role: "assistant",
				content: "I found two ways to go.",
				toolCalls: TIMELINE,
				createdAt: NOW,
			},
			// Not an assistant's row, though it holds a call with the same id.
			{
				id: "not-assistant-1",
				conversationId: CONVERSATION,
				messageSequence: 2,
				role: "user",
				content: "Plan the party",
				toolCalls: TIMELINE,
				createdAt: NOW,
			},
		])
		.run();
});

describe("updateAssistantToolCallResult on a real database", () => {
	it("rewrites the call in the stored row, and the page's read of the row shows the answer", async () => {
		await expect(updateAssistantToolCallResult(answer)).resolves.toBe(true);

		const [message] = (await listMessages(CONVERSATION)).filter(
			(candidate) => candidate.id === "asking-1",
		);
		expect(message?.thinkingSegments).toEqual([
			research,
			{
				...asked,
				outputSummary: "The user picked: A party at home",
				resultDigest: '{"status":"answered"}',
			},
		]);
	});

	it("does not rewrite a row of another conversation", async () => {
		await expect(
			updateAssistantToolCallResult({
				...answer,
				conversationId: OTHER_CONVERSATION,
			}),
		).resolves.toBe(false);

		expect(readToolCalls("asking-1")).toBe(TIMELINE);
	});

	it("does not rewrite a message that is not an assistant's", async () => {
		await expect(
			updateAssistantToolCallResult({
				...answer,
				messageId: "not-assistant-1",
			}),
		).resolves.toBe(false);

		expect(readToolCalls("not-assistant-1")).toBe(TIMELINE);
	});
});
