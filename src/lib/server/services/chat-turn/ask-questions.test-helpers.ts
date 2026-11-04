import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { conversations, messages, users } from "$lib/server/db/schema";
import type { AskQuestion } from "$lib/shared/ask-user";
import {
	type AskResumeCapture,
	recordAskQuestion,
	stampAskQuestion,
} from "./ask-questions";

// A question that waits, in rows of the test database a route reads: the routes and
// refusals of "Ask me first" (the question list, the answer, the refusal of a new
// message) are tested over the real store, so the status, the stamp and the claim
// they act on are the store's own. Every call makes a new person and chat with
// unique ids, because a worker keeps its database from one test file to the next;
// `removeSeededAskUser` takes them out again (the rows cascade from the person).

export const ASK_TEST_QUESTIONS: AskQuestion[] = [
	{
		question: "Which colour?",
		options: [{ label: "Red", recommended: true }, { label: "Blue" }],
	},
];

/** Words only the resume needs, kept in the capture: a body that holds them leaked it. */
export const ASK_TEST_CAPTURED_TEXT = "PAGE-TEXT-ONLY-THE-RESUME-NEEDS";

const CAPTURE: AskResumeCapture = {
	v: 1,
	messages: [
		{
			role: "assistant",
			content: [
				{
					type: "tool-call",
					toolCallId: "call-search",
					toolName: "research_web",
					input: { query: "colours" },
				},
			],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "call-search",
					toolName: "research_web",
					output: { type: "json", value: { text: ASK_TEST_CAPTURED_TEXT } },
				},
			],
		},
	],
	results: [
		{
			toolCallId: "call-search",
			toolName: "research_web",
			localDistilled: false,
			digest: { ok: true, summary: "Found two sources." },
		},
	],
};

export type SeededAskQuestion = {
	userId: string;
	conversationId: string;
	/** The assistant row that asked it. */
	messageId: string;
	questionId: string;
};

/** A new person with a chat whose saved reply asked a question that waits. */
export async function seedWaitingAskQuestion(): Promise<SeededAskQuestion> {
	const userId = `ask-user-${randomUUID()}`;
	const conversationId = `ask-chat-${randomUUID()}`;
	const messageId = `ask-message-${randomUUID()}`;
	await db.insert(users).values({
		id: userId,
		email: `${userId}@example.com`,
		passwordHash: "hash",
	});
	await db
		.insert(conversations)
		.values({ id: conversationId, userId, title: "A chat" });
	await db.insert(messages).values({
		id: messageId,
		conversationId,
		role: "assistant",
		content: "A reply",
	});
	const { id: questionId } = await recordAskQuestion({
		userId,
		conversationId,
		toolCallId: "call-ask",
		questions: ASK_TEST_QUESTIONS,
	});
	const stamped = await stampAskQuestion({
		userId,
		questionId,
		assistantMessageId: messageId,
		capture: CAPTURE,
	});
	if (!stamped) throw new Error("the seeded question was not stamped");
	return { userId, conversationId, messageId, questionId };
}

/** Removes a seeded person with their chats, messages and questions. */
export async function removeSeededAskUser(userId: string): Promise<void> {
	await db.delete(users).where(eq(users.id, userId));
}
