import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

import {
	ASK_TEST_CAPTURED_TEXT,
	ASK_TEST_QUESTIONS,
	removeSeededAskUser,
	type SeededAskQuestion,
	seedWaitingAskQuestion,
} from "$lib/server/services/chat-turn/ask-questions.test-helpers";
import { GET } from "./+server";

type QuestionsEvent = Parameters<typeof GET>[0];

function makeEvent(userId: string, conversationId: string): QuestionsEvent {
	return {
		request: new Request(
			`http://localhost/api/conversations/${conversationId}/questions`,
		),
		locals: { user: { id: userId } },
		params: { id: conversationId },
		url: new URL(
			`http://localhost/api/conversations/${conversationId}/questions`,
		),
		route: { id: "/api/conversations/[id]/questions" },
	} as QuestionsEvent;
}

// The routes read the real store over rows of the test database, so what the list
// leaves out is what the store's own list leaves out.
describe("GET /api/conversations/[id]/questions", () => {
	const seeded: SeededAskQuestion[] = [];

	async function seed(): Promise<SeededAskQuestion> {
		const one = await seedWaitingAskQuestion();
		seeded.push(one);
		return one;
	}

	afterEach(async () => {
		for (const one of seeded.splice(0)) await removeSeededAskUser(one.userId);
	});

	it("lists the chat's questions without what the resume needs", async () => {
		const { userId, conversationId, messageId, questionId } = await seed();

		const response = await GET(makeEvent(userId, conversationId));
		const text = await response.text();
		const body = JSON.parse(text);

		expect(response.status).toBe(200);
		expect(body).toEqual({
			questions: [
				{
					id: questionId,
					conversationId,
					assistantMessageId: messageId,
					toolCallId: "call-ask",
					questions: ASK_TEST_QUESTIONS,
					status: "waiting",
					answer: null,
					createdAt: expect.any(Number),
				},
			],
		});
		// The capture the resume starts from stays on the server: no key for it, and
		// none of what it holds.
		expect(text).not.toContain(ASK_TEST_CAPTURED_TEXT);
		expect(text).not.toMatch(/resume|capture/i);
	});

	it("answers 404 for another person's chat", async () => {
		const owner = await seed();
		const stranger = await seed();

		const response = await GET(
			makeEvent(stranger.userId, owner.conversationId),
		);
		const text = await response.text();

		expect(response.status).toBe(404);
		expect(JSON.parse(text)).toEqual({ error: "Conversation not found" });
		expect(text).not.toContain(owner.questionId);
	});
});
