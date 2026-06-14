import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { getConfig } from "$lib/server/config-store";
import { prepareRetryChatTurn } from "$lib/server/services/chat-turn/retry";
import { runChatStreamOrchestrator } from "$lib/server/services/chat-turn/stream-orchestrator";
import { POST } from "./+server";

function makeEvent(body: Record<string, unknown>) {
	return {
		request: new Request("http://localhost/api/chat/retry", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: {
			user: {
				id: "user-1",
				email: "user@example.com",
				displayName: "User",
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
});
