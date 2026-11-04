import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(() => ({
		maxMessageLength: 10000,
		model1MaxMessageLength: 10000,
		model2MaxMessageLength: 10000,
		model1: { displayName: "Model 1" },
		model2: { displayName: "Model 2" },
	})),
}));

vi.mock("$lib/server/services/chat-turn/retry", () => ({
	prepareRetryChatTurn: vi.fn(async () => ({
		ok: true,
		value: {
			orchestratorInput: {
				turn: {
					conversationId: "conv-1",
					normalizedMessage: "retry prompt",
					modelDisplayName: "Model 1",
					modelId: "model1",
					attachmentIds: [],
					linkedSources: [],
					pendingSkill: null,
					reasoningDepth: "auto",
					thinkingMode: "auto",
					forceWebSearch: false,
					skipPersistUserMessage: true,
					depthMetadata: {
						requested: "auto",
						appliedProfile: "standard",
						fallback: false,
					},
				},
				upstreamMessage: "retry prompt",
				isReconnect: false,
				systemPromptAppendix: "retry fresh",
			},
		},
	})),
}));

vi.mock("$lib/server/services/chat-turn/stream-orchestrator", () => ({
	runChatStreamOrchestrator: vi.fn(() => new Response("retry stream")),
}));

vi.mock("$lib/server/services/memory-profile/reset-generation", () => ({
	getCurrentMemoryResetGeneration: vi.fn(async () => 0),
}));

import { eq } from "drizzle-orm";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { askQuestions } from "$lib/server/db/schema";
import { setDraining } from "$lib/server/services/chat-turn/active-streams";
import {
	removeSeededAskUser,
	seedWaitingAskQuestion,
} from "$lib/server/services/chat-turn/ask-questions.test-helpers";
import { prepareRetryChatTurn } from "$lib/server/services/chat-turn/retry";
import { runChatStreamOrchestrator } from "$lib/server/services/chat-turn/stream-orchestrator";
import { POST } from "./+server";

function makeEvent(
	body: Record<string, unknown>,
	user: { id: string } = { id: "user-1" },
) {
	return {
		request: new Request("http://localhost/api/chat/retry", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: {
			user: {
				email: "user@example.com",
				displayName: "User",
				...user,
			},
		},
		params: {},
	} as never;
}

describe("POST /api/chat/retry", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("delegates retry preparation to chat-turn and streams the prepared orchestrator input", async () => {
		const response = await POST(
			makeEvent({
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				userMessageId: "user-1",
				userMessage: "retry prompt",
				reasoningDepth: "auto",
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("retry stream");
		expect(prepareRetryChatTurn).toHaveBeenCalledWith({
			userId: "user-1",
			runtimeConfig: getConfig(),
			body: expect.objectContaining({
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				userMessage: "retry prompt",
			}),
		});
		expect(runChatStreamOrchestrator).toHaveBeenCalledWith(
			expect.objectContaining({
				user: {
					id: "user-1",
					displayName: "User",
					email: "user@example.com",
				},
				upstreamMessage: "retry prompt",
				isReconnect: false,
				systemPromptAppendix: "retry fresh",
				requestStartTime: expect.any(Number),
				startedResetGeneration: 0,
				downstreamAbortSignal: expect.any(AbortSignal),
			}),
		);
	});

	it("maps retry preparation JSON errors without invoking the stream orchestrator", async () => {
		(prepareRetryChatTurn as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			ok: false,
			error: {
				status: 409,
				error: "Forked source history requires confirmation",
				code: "forked_source_history_confirmation_required",
				errorKey: "fork.regenerateWarning",
				responseShape: "json",
			},
		});

		const response = await POST(
			makeEvent({
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				userMessageId: "user-1",
				userMessage: "retry prompt",
			}),
		);

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: "Forked source history requires confirmation",
			code: "forked_source_history_confirmation_required",
			errorKey: "fork.regenerateWarning",
		});
		expect(runChatStreamOrchestrator).not.toHaveBeenCalled();
	});

	it("maps retry preparation stream-json errors with the shared stream error shape", async () => {
		(prepareRetryChatTurn as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			ok: false,
			error: {
				status: 422,
				error: "Attachment is not ready",
				code: "attachment_not_ready",
				attachmentIds: ["att-1"],
				responseShape: "stream-json",
			},
		});

		const response = await POST(
			makeEvent({
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				userMessageId: "user-1",
				userMessage: "retry prompt",
			}),
		);

		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({
			status: 422,
			error: "Attachment is not ready",
			code: "attachment_not_ready",
			attachmentIds: ["att-1"],
		});
		expect(runChatStreamOrchestrator).not.toHaveBeenCalled();
	});

	// A deploy drains the server before it restarts it: a new message is turned away
	// (and the page waits), and a turn started now is cut by the restart. A
	// regenerate, "Answer now" and a Retry go through this route, which never asked.
	describe("while the server drains for a deploy", () => {
		const retryBody = {
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			userMessageId: "user-1",
			userMessage: "retry prompt",
		};

		afterEach(() => {
			setDraining(false);
			// Back to the config the file mocks, whatever a test gave it.
			vi.mocked(getConfig).mockReset();
		});

		it("turns the retry away with the 503 a new message gets, having prepared and deleted nothing", async () => {
			setDraining(true);

			const response = await POST(makeEvent(retryBody));

			expect(response.status).toBe(503);
			expect(response.headers.get("Retry-After")).toBe("10");
			expect(await response.json()).toEqual({
				error: "Server at capacity. Please try again later.",
				code: "CAPACITY_EXCEEDED",
				reason: "draining",
				retryAfter: 10,
			});
			expect(prepareRetryChatTurn).not.toHaveBeenCalled();
			expect(runChatStreamOrchestrator).not.toHaveBeenCalled();
		});

		it("takes the retry again once the drain is undone", async () => {
			setDraining(true);
			await POST(makeEvent(retryBody));
			setDraining(false);

			const response = await POST(makeEvent(retryBody));

			expect(response.status).toBe(200);
			expect(runChatStreamOrchestrator).toHaveBeenCalledTimes(1);
		});

		it("applies no limit of the stream route's: a full server still takes a retry", async () => {
			vi.mocked(getConfig).mockReturnValue({
				concurrentStreamLimit: 0,
				perUserStreamLimit: 0,
				maxMessageLength: 10000,
			} as ReturnType<typeof getConfig>);

			const response = await POST(makeEvent(retryBody));

			expect(response.status).toBe(200);
			expect(runChatStreamOrchestrator).toHaveBeenCalledTimes(1);
		});
	});

	// "Ask me first": a retry deletes the reply it replaces while it prepares, before
	// the stream's arbiter has seen the turn. While the chat holds a saved question
	// that waits, or whose answer is being carried on, that reply may be the row the
	// resume continues, so the retry is turned away like a new message.
	describe("while a question waits in the chat", () => {
		it("turns the retry away with the 409 a new message gets, having prepared and deleted nothing", async () => {
			const waiting = await seedWaitingAskQuestion();
			try {
				for (const status of ["waiting", "answering"] as const) {
					db.update(askQuestions)
						.set({ status })
						.where(eq(askQuestions.id, waiting.questionId))
						.run();

					const response = await POST(
						makeEvent(
							{
								conversationId: waiting.conversationId,
								assistantMessageId: waiting.messageId,
								userMessageId: "user-message-1",
								userMessage: "retry prompt",
							},
							{ id: waiting.userId },
						),
					);

					expect(response.status).toBe(409);
					expect(await response.json()).toEqual({
						status: 409,
						error:
							"Answer the question Alfy asked before sending a new message",
						code: "QUESTION_WAITING",
					});
				}
				expect(prepareRetryChatTurn).not.toHaveBeenCalled();
				expect(runChatStreamOrchestrator).not.toHaveBeenCalled();
			} finally {
				await removeSeededAskUser(waiting.userId);
			}
		});

		it("takes the retry again once the question is answered", async () => {
			const waiting = await seedWaitingAskQuestion();
			try {
				db.update(askQuestions)
					.set({ status: "answered" })
					.where(eq(askQuestions.id, waiting.questionId))
					.run();

				const response = await POST(
					makeEvent(
						{
							conversationId: waiting.conversationId,
							assistantMessageId: waiting.messageId,
							userMessageId: "user-message-1",
							userMessage: "retry prompt",
						},
						{ id: waiting.userId },
					),
				);

				expect(response.status).toBe(200);
				expect(prepareRetryChatTurn).toHaveBeenCalledTimes(1);
				expect(runChatStreamOrchestrator).toHaveBeenCalledTimes(1);
			} finally {
				await removeSeededAskUser(waiting.userId);
			}
		});
	});
});
