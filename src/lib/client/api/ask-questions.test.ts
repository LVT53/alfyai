import { describe, expect, it, vi } from "vitest";
import type { AskQuestionDto } from "$lib/shared/ask-user";
import { fetchConversationQuestions } from "./ask-questions";

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

describe("ask-questions client API", () => {
	it("reads a chat's questions, and an empty list when there are none", async () => {
		const question: AskQuestionDto = {
			id: "q-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			toolCallId: "call-1",
			questions: [
				{
					question: "Which format do you want?",
					options: [
						{ label: "A short note", recommended: true },
						{ label: "A report" },
					],
				},
			],
			status: "waiting",
			answer: null,
			createdAt: 1_700_000_000_000,
		};
		const fetchMock = vi.fn(async () =>
			jsonResponse({ questions: [question] }),
		);

		await expect(
			fetchConversationQuestions("conv-1", fetchMock),
		).resolves.toEqual([question]);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/conversations/conv-1/questions",
		);

		// A chat that asked nothing, and a body that carries no list at all.
		await expect(
			fetchConversationQuestions(
				"conv-2",
				vi.fn(async () => jsonResponse({ questions: [] })),
			),
		).resolves.toEqual([]);
		await expect(
			fetchConversationQuestions(
				"conv-2",
				vi.fn(async () => jsonResponse({})),
			),
		).resolves.toEqual([]);
	});
});
