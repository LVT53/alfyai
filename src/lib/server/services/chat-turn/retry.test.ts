import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "$lib/server/config-store";

const {
	mockConversationMessages,
	mockMessageAttachments,
	capturedSyntheticBodies,
} = vi.hoisted(() => ({
	mockConversationMessages: [] as Array<{
		id: string;
		role: string;
		content: string;
	}>,
	mockMessageAttachments: new Map<
		string,
		Array<{
			id: string;
			artifactId: string;
			name: string;
			type: string;
			mimeType: string | null;
			sizeBytes: number | null;
			conversationId: string | null;
			messageId: string;
			createdAt: number;
		}>
	>(),
	capturedSyntheticBodies: [] as Array<Record<string, unknown>>,
}));

vi.mock("$lib/server/services/conversations", () => ({
	getConversation: vi.fn(async () => ({ id: "conv-1" })),
}));

vi.mock("$lib/server/db", () => ({
	db: {
		select: vi.fn(() => ({
			from: vi.fn(() => ({
				where: vi.fn(() => ({
					orderBy: vi.fn(async () => mockConversationMessages),
				})),
			})),
		})),
	},
}));

vi.mock("$lib/server/services/messages", () => ({
	deleteMessages: vi.fn(async () => undefined),
}));

vi.mock("$lib/server/services/knowledge", () => ({
	listMessageAttachments: vi.fn(async () => mockMessageAttachments),
}));

vi.mock("$lib/server/services/conversation-forks", () => ({
	listChildForksBySourceMessages: vi.fn(async () => ({})),
}));

vi.mock("$lib/server/services/message-sequences", () => ({
	repairConversationMessageSequences: vi.fn(),
}));

vi.mock("$lib/server/services/chat-turn/retry-cleanup", () => ({
	cleanupFailedTurn: vi.fn(async () => ({ steps: [], warnings: [] })),
}));

vi.mock("$lib/server/services/chat-turn/request", () => ({
	parseChatTurnRequest: vi.fn(async (request: Request) => {
		const body = await request.json();
		capturedSyntheticBodies.push(body);
		return {
			ok: true,
			value: {
				conversationId: body.conversationId,
				normalizedMessage: body.message,
				modelDisplayName: "Model 1",
				modelId: "model1",
				attachmentIds: Array.isArray(body.attachmentIds)
					? body.attachmentIds
					: [],
				linkedSources: [],
				pendingSkill: null,
				reasoningDepth: body.reasoningDepth ?? "auto",
				thinkingMode: "auto",
				forceWebSearch: false,
				skipPersistUserMessage: true,
			},
		};
	}),
}));

vi.mock("$lib/server/services/chat-turn/preflight", () => ({
	preflightChatTurn: vi.fn(async ({ request }) => ({
		ok: true,
		value: {
			...request,
			depthMetadata: {
				requested: request.reasoningDepth,
				appliedProfile: "standard",
				fallback: false,
			},
		},
	})),
}));

import { preflightChatTurn } from "$lib/server/services/chat-turn/preflight";
import { cleanupFailedTurn } from "$lib/server/services/chat-turn/retry-cleanup";
import { listChildForksBySourceMessages } from "$lib/server/services/conversation-forks";
import { listMessageAttachments } from "$lib/server/services/knowledge";
import { deleteMessages } from "$lib/server/services/messages";
import { prepareRetryChatTurn } from "./retry";

function makeRuntimeConfig(): RuntimeConfig {
	return {
		maxMessageLength: 10_000,
		model1MaxMessageLength: 10_000,
		model2MaxMessageLength: 10_000,
		model1: { displayName: "Model 1" },
		model2: { displayName: "Model 2" },
	} as RuntimeConfig;
}

describe("prepareRetryChatTurn", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		capturedSyntheticBodies.length = 0;
		mockMessageAttachments.clear();
		mockConversationMessages.splice(
			0,
			mockConversationMessages.length,
			{ id: "user-1", role: "user", content: "first prompt" },
			{ id: "assistant-1", role: "assistant", content: "first answer" },
			{ id: "user-2", role: "user", content: "historical prompt" },
			{ id: "assistant-2", role: "assistant", content: "historical answer" },
			{ id: "user-3", role: "user", content: "latest prompt" },
			{ id: "assistant-3", role: "assistant", content: "latest answer" },
		);
		(
			listChildForksBySourceMessages as ReturnType<typeof vi.fn>
		).mockResolvedValue({});
	});

	it("prepares a historical retry by validating the target, cleaning side effects, and deleting trailing messages", async () => {
		const result = await prepareRetryChatTurn({
			userId: "user-1",
			runtimeConfig: makeRuntimeConfig(),
			body: {
				conversationId: "conv-1",
				assistantMessageId: "assistant-2",
				userMessageId: "user-2",
				userMessage: "historical prompt",
				reasoningDepth: "max",
			},
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(cleanupFailedTurn).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-2",
		});
		expect(deleteMessages).toHaveBeenCalledWith([
			"assistant-2",
			"user-3",
			"assistant-3",
		]);
		expect(capturedSyntheticBodies[0]).toEqual(
			expect.objectContaining({
				message: "historical prompt",
				conversationId: "conv-1",
				reasoningDepth: "max",
				skipPersistUserMessage: true,
			}),
		);
		expect(result.value).not.toHaveProperty("upstreamMessage");
		expect(result.value.orchestratorInput).toEqual(
			expect.objectContaining({
				turn: expect.objectContaining({
					conversationId: "conv-1",
					normalizedMessage: "historical prompt",
					skipPersistUserMessage: true,
				}),
				upstreamMessage: "historical prompt",
				isReconnect: false,
				systemPromptAppendix: expect.stringContaining(
					"regenerating their last request",
				),
			}),
		);
	});

	it("prepares the latest assistant retry without selecting an older user message", async () => {
		const result = await prepareRetryChatTurn({
			userId: "user-1",
			runtimeConfig: makeRuntimeConfig(),
			body: {
				conversationId: "conv-1",
				assistantMessageId: "assistant-3",
				userMessageId: "user-3",
				userMessage: "latest prompt",
				reasoningDepth: "max",
			},
		});

		expect(result.ok).toBe(true);
		expect(deleteMessages).toHaveBeenCalledWith(["assistant-3"]);
		expect(capturedSyntheticBodies[0]?.message).toBe("latest prompt");
		expect(capturedSyntheticBodies[0]?.reasoningDepth).toBe("max");
		expect(capturedSyntheticBodies[0]).not.toHaveProperty("thinkingMode");
	});

	it("reuses persisted PDF attachment ids from the retried user message when the retry request omits them", async () => {
		mockMessageAttachments.set("user-3", [
			{
				id: "link-1",
				artifactId: "source-pdf-1",
				name: "Report.pdf",
				type: "source_document",
				mimeType: "application/pdf",
				sizeBytes: 1234,
				conversationId: "conv-1",
				messageId: "user-3",
				createdAt: 1,
			},
		]);

		const result = await prepareRetryChatTurn({
			userId: "user-1",
			runtimeConfig: makeRuntimeConfig(),
			body: {
				conversationId: "conv-1",
				assistantMessageId: "assistant-3",
				userMessageId: "user-3",
				userMessage: "latest prompt",
			},
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(listMessageAttachments).toHaveBeenCalledWith("conv-1");
		expect(capturedSyntheticBodies[0]).toEqual(
			expect.objectContaining({
				attachmentIds: ["source-pdf-1"],
				skipPersistUserMessage: true,
			}),
		);
		expect(result.value.orchestratorInput.turn.attachmentIds).toEqual([
			"source-pdf-1",
		]);
	});

	it("passes resolved Auto Reasoning Depth metadata through the prepared orchestrator input", async () => {
		(preflightChatTurn as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			ok: true,
			value: {
				conversationId: "conv-1",
				normalizedMessage: "latest prompt",
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
					appliedProfile: "extended",
					fallback: false,
					classifierSource: "control_model",
					modelId: "model1",
					modelDisplayName: "Model 1",
				},
			},
		});

		const result = await prepareRetryChatTurn({
			userId: "user-1",
			runtimeConfig: makeRuntimeConfig(),
			body: {
				conversationId: "conv-1",
				assistantMessageId: "assistant-3",
				userMessageId: "user-3",
				userMessage: "latest prompt",
				reasoningDepth: "auto",
			},
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.orchestratorInput.turn.depthMetadata).toEqual(
			expect.objectContaining({
				appliedProfile: "extended",
				classifierSource: "control_model",
			}),
		);
	});

	it("keeps active Skill prompt context when preparing a retry", async () => {
		(preflightChatTurn as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			ok: true,
			value: {
				conversationId: "conv-1",
				normalizedMessage: "latest prompt",
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
				skillPromptContext: {
					source: "active_session",
					sessionId: "session-1",
					sessionStatus: "active",
					skillId: "skill-1",
					skillOwnership: "user",
					skillKind: "user_skill",
					skillDisplayName: "Meeting critic",
					skillDescription: "Reviews notes",
					skillInstructions: "Capture decisions before answering.",
					durationPolicy: "session",
					questionPolicy: "none",
					notesPolicy: "create_private_notes",
					sourceScope: "selected_sources_only",
					skillVersion: 1,
					linkedSources: [],
				},
			},
		});

		const result = await prepareRetryChatTurn({
			userId: "user-1",
			runtimeConfig: makeRuntimeConfig(),
			body: {
				conversationId: "conv-1",
				assistantMessageId: "assistant-3",
				userMessageId: "user-3",
				userMessage: "latest prompt",
			},
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.orchestratorInput.systemPromptAppendix).toContain(
			"Active Skill Context",
		);
		expect(result.value.orchestratorInput.systemPromptAppendix).toContain(
			"Capture decisions before answering.",
		);
		expect(result.value.orchestratorInput.systemPromptAppendix).toContain(
			"regenerating their last request",
		);
	});

	it("rejects a mismatched user and assistant retry target before cleanup", async () => {
		const result = await prepareRetryChatTurn({
			userId: "user-1",
			runtimeConfig: makeRuntimeConfig(),
			body: {
				conversationId: "conv-1",
				assistantMessageId: "assistant-2",
				userMessageId: "user-3",
				userMessage: "latest prompt",
			},
		});

		expect(result).toEqual({
			ok: false,
			error: {
				error: "Retry target does not match the preceding user message",
				status: 409,
				responseShape: "json",
			},
		});
		expect(cleanupFailedTurn).not.toHaveBeenCalled();
		expect(deleteMessages).not.toHaveBeenCalled();
	});

	it("requires explicit confirmation before mutating source history with child forks", async () => {
		(
			listChildForksBySourceMessages as ReturnType<typeof vi.fn>
		).mockResolvedValue({
			"assistant-2": {
				count: 1,
				forks: [
					{
						conversationId: "fork-1",
						title: "Source (fork 1)",
						forkSequence: 1,
						createdAt: 1,
					},
				],
			},
		});

		const result = await prepareRetryChatTurn({
			userId: "user-1",
			runtimeConfig: makeRuntimeConfig(),
			body: {
				conversationId: "conv-1",
				assistantMessageId: "assistant-2",
				userMessageId: "user-2",
				userMessage: "historical prompt",
			},
		});

		expect(result).toEqual({
			ok: false,
			error: {
				error: "Forked source history requires confirmation",
				code: "forked_source_history_confirmation_required",
				errorKey: "fork.regenerateWarning",
				status: 409,
				responseShape: "json",
			},
		});
		expect(cleanupFailedTurn).not.toHaveBeenCalled();
		expect(deleteMessages).not.toHaveBeenCalled();
	});

	it("prepares forked source history retry after explicit confirmation", async () => {
		(
			listChildForksBySourceMessages as ReturnType<typeof vi.fn>
		).mockResolvedValue({
			"assistant-2": { count: 1, forks: [] },
		});

		const result = await prepareRetryChatTurn({
			userId: "user-1",
			runtimeConfig: makeRuntimeConfig(),
			body: {
				conversationId: "conv-1",
				assistantMessageId: "assistant-2",
				userMessageId: "user-2",
				userMessage: "historical prompt",
				confirmForkedSourceHistoryMutation: true,
			},
		});

		expect(result.ok).toBe(true);
		expect(deleteMessages).toHaveBeenCalledWith([
			"assistant-2",
			"user-3",
			"assistant-3",
		]);
	});
});
