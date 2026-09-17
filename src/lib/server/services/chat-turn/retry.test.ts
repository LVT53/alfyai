import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "$lib/server/config-store";

const {
	mockConversationMessages,
	mockMessageAttachments,
	capturedSyntheticBodies,
	capturedMessageSelections,
} = vi.hoisted(() => ({
	mockConversationMessages: [] as Array<{
		id: string;
		role: string;
		content: string;
		metadataJson?: string | null;
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
	// Every column set the retry asked the messages table for, so a test can
	// assert the conversation-scoped read that makes another user's or another
	// conversation's record unreachable.
	capturedMessageSelections: [] as Array<Record<string, unknown>>,
}));

vi.mock("$lib/server/services/conversations", () => ({
	getConversation: vi.fn(async () => ({ id: "conv-1" })),
}));

vi.mock("$lib/server/db", () => ({
	db: {
		select: vi.fn((columns: Record<string, unknown>) => {
			capturedMessageSelections.push(columns);
			return {
				from: vi.fn(() => ({
					where: vi.fn(() => ({
						orderBy: vi.fn(async () => mockConversationMessages),
					})),
				})),
			};
		}),
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

// The real `parsePendingSkill` is kept: the retry path feeds it a selection
// rebuilt from persisted JSON, and the point of the exercise is that it passes
// exactly the validation a fresh send's request body gets.
vi.mock("$lib/server/services/chat-turn/request", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/chat-turn/request")
	>("$lib/server/services/chat-turn/request");
	return {
		parsePendingSkill: actual.parsePendingSkill,
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
					pendingSkill: body.pendingSkill ?? null,
					reasoningDepth: body.reasoningDepth ?? "auto",
					thinkingMode: "auto",
					forceWebSearch: body.forceWebSearch === true,
					skipPersistUserMessage: true,
				},
			};
		}),
	};
});

vi.mock("$lib/server/services/chat-turn/preflight", () => ({
	// Mirrors the real preflight: a `pendingSkill` that survived parsing is
	// resolved into `appliedSkill`, and a resolution failure fails the turn.
	preflightChatTurn: vi.fn(async ({ userId, request }) => {
		let appliedSkill = null;
		if (request.pendingSkill) {
			const resolved = await resolveAppliedSkill({
				userId,
				pendingSkill: request.pendingSkill,
				requestText: request.normalizedMessage,
			});
			if (!resolved.ok) return resolved;
			appliedSkill = resolved.value;
		}
		return {
			ok: true,
			value: {
				...request,
				appliedSkill,
				depthMetadata: {
					requested: request.reasoningDepth,
					appliedProfile: "standard",
					fallback: false,
				},
			},
		};
	}),
	resolveAppliedSkill: vi.fn(async () => ({
		ok: false,
		error: {
			status: 409,
			error: "Selected skill is no longer available.",
			code: "pending_skill_unavailable",
		},
	})),
}));

import {
	preflightChatTurn,
	resolveAppliedSkill,
} from "$lib/server/services/chat-turn/preflight";
import { cleanupFailedTurn } from "$lib/server/services/chat-turn/retry-cleanup";
import { listChildForksBySourceMessages } from "$lib/server/services/conversation-forks";
import { getConversation } from "$lib/server/services/conversations";
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
		capturedMessageSelections.length = 0;
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

	it("carries the applied Skill's instructions into the retry's packet, separate from the regeneration appendix", async () => {
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
				appliedSkill: {
					skillId: "skill-1",
					skillOwnership: "user",
					skillKind: "user_skill",
					skillDisplayName: "Meeting critic",
					instructionsEnvelope:
						'Skill "Meeting critic" instructions — apply these for the rest of this turn:\n\nCapture decisions before answering.',
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
		expect(result.value.orchestratorInput.pendingSkillInstructions).toContain(
			"Capture decisions before answering.",
		);
		expect(result.value.orchestratorInput.systemPromptAppendix).toContain(
			"regenerating their last request",
		);
		expect(result.value.orchestratorInput.systemPromptAppendix).not.toContain(
			"Capture decisions before answering.",
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

	// The user's own turn choices (composer-applied skill, forced `/web`)
	// survive only as the assistant message's `userIntent` record, so a retry
	// has to read them back off the message it replaces — before deleting it —
	// or the regenerated answer silently drops both.
	describe("recorded user intent", () => {
		beforeEach(() => {
			// `vi.clearAllMocks()` clears calls, not implementations, so restore
			// the "skill no longer available" default each test starts from.
			(resolveAppliedSkill as ReturnType<typeof vi.fn>).mockImplementation(
				async () => ({
					ok: false,
					error: {
						status: 409,
						error: "Selected skill is no longer available.",
						code: "pending_skill_unavailable",
					},
				}),
			);
		});

		function recordOn(messageId: string, userIntent: unknown) {
			const target = mockConversationMessages.find(
				(message) => message.id === messageId,
			);
			if (!target) throw new Error(`no fixture message ${messageId}`);
			target.metadataJson = JSON.stringify({
				wasStopped: false,
				userIntent,
			});
		}

		function retryLatest() {
			return prepareRetryChatTurn({
				userId: "user-1",
				runtimeConfig: makeRuntimeConfig(),
				body: {
					conversationId: "conv-1",
					assistantMessageId: "assistant-3",
					userMessageId: "user-3",
					userMessage: "latest prompt",
				},
			});
		}

		function resolvesSkill(displayName: string) {
			(resolveAppliedSkill as ReturnType<typeof vi.fn>).mockImplementation(
				async ({ pendingSkill }) => ({
					ok: true,
					value: {
						skillId: pendingSkill.id,
						skillOwnership: pendingSkill.ownership,
						skillKind: "user_skill",
						skillDisplayName: displayName,
						instructionsEnvelope: `Skill "${displayName}" was selected by the user — Capture decisions before answering.`,
					},
				}),
			);
		}

		it("re-applies a recorded skill, so the regenerated answer is recorded with the same intent", async () => {
			recordOn("assistant-3", {
				skill: { id: "skill-1", displayName: "Meeting critic" },
			});
			resolvesSkill("Meeting critic");

			const result = await retryLatest();

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			// Resolved through the same validator + resolver the send path uses,
			// which re-checks ownership and enabled state.
			expect(resolveAppliedSkill).toHaveBeenCalledWith({
				userId: "user-1",
				pendingSkill: expect.objectContaining({
					id: "skill-1",
					ownership: "user",
					displayName: "Meeting critic",
				}),
				requestText: "latest prompt",
			});
			expect(capturedSyntheticBodies[0]?.pendingSkill).toEqual(
				expect.objectContaining({ id: "skill-1", ownership: "user" }),
			);
			// The orchestrator rebuilds both the skillUse activity event and the
			// message's own `userIntent` record from `turn.appliedSkill`.
			expect(result.value.orchestratorInput.turn.appliedSkill).toEqual(
				expect.objectContaining({
					skillId: "skill-1",
					skillDisplayName: "Meeting critic",
				}),
			);
			expect(result.value.orchestratorInput.pendingSkillInstructions).toContain(
				"Capture decisions before answering.",
			);
		});

		it("probes a system skill id with system ownership first", async () => {
			recordOn("assistant-3", {
				skill: { id: "system:study-coach", displayName: "Study coach" },
			});
			resolvesSkill("Study coach");

			const result = await retryLatest();

			expect(result.ok).toBe(true);
			// One probe (which hit), then preflight's own canonical resolution.
			expect(resolveAppliedSkill).toHaveBeenCalledTimes(2);
			expect(resolveAppliedSkill).toHaveBeenNthCalledWith(
				1,
				expect.objectContaining({
					pendingSkill: expect.objectContaining({
						id: "system:study-coach",
						ownership: "system",
					}),
				}),
			);
		});

		it("keeps a recorded forced web search on the regenerated turn", async () => {
			recordOn("assistant-3", { webSearch: true });

			const result = await retryLatest();

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(capturedSyntheticBodies[0]?.forceWebSearch).toBe(true);
			expect(result.value.orchestratorInput.turn.forceWebSearch).toBe(true);
			// No skill was recorded, so none is resolved.
			expect(resolveAppliedSkill).not.toHaveBeenCalled();
			expect(capturedSyntheticBodies[0]?.pendingSkill).toBeUndefined();
		});

		it("regenerates without a since-deleted or disabled skill instead of failing the turn", async () => {
			recordOn("assistant-3", {
				skill: { id: "skill-gone", displayName: "Meeting critic" },
				webSearch: true,
			});
			// The mocked resolver's default: the 409 a fresh send would get.

			const result = await retryLatest();

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			// Both ownerships probed, then dropped — never surfaced as
			// `pending_skill_unavailable`.
			expect(resolveAppliedSkill).toHaveBeenCalledTimes(2);
			expect(capturedSyntheticBodies[0]?.pendingSkill).toBeUndefined();
			expect(result.value.orchestratorInput.turn.appliedSkill).toBeNull();
			expect(
				result.value.orchestratorInput.pendingSkillInstructions,
			).toBeUndefined();
			// The rest of the record still applies.
			expect(result.value.orchestratorInput.turn.forceWebSearch).toBe(true);
		});

		it("stops probing when the Composer Command Registry is off", async () => {
			recordOn("assistant-3", {
				skill: { id: "skill-1", displayName: "Meeting critic" },
			});
			(resolveAppliedSkill as ReturnType<typeof vi.fn>).mockResolvedValue({
				ok: false,
				error: {
					status: 403,
					error: "Composer Command Registry is disabled.",
					code: "composer_commands_disabled",
				},
			});

			const result = await retryLatest();

			expect(result.ok).toBe(true);
			expect(resolveAppliedSkill).toHaveBeenCalledTimes(1);
			expect(capturedSyntheticBodies[0]?.pendingSkill).toBeUndefined();
		});

		it("treats a message with no record, or a malformed one, as a plain retry", async () => {
			const result = await retryLatest();

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(resolveAppliedSkill).not.toHaveBeenCalled();
			expect(capturedSyntheticBodies[0]).not.toHaveProperty("pendingSkill");
			expect(capturedSyntheticBodies[0]).not.toHaveProperty("forceWebSearch");
			expect(result.value.orchestratorInput.turn.forceWebSearch).toBe(false);

			capturedSyntheticBodies.length = 0;
			const target = mockConversationMessages.find(
				(message) => message.id === "assistant-3",
			);
			if (target) target.metadataJson = "{not json";
			const malformed = await retryLatest();

			expect(malformed.ok).toBe(true);
			expect(capturedSyntheticBodies[0]).not.toHaveProperty("pendingSkill");
			expect(capturedSyntheticBodies[0]).not.toHaveProperty("forceWebSearch");
		});

		it("reads only the retried message's own record", async () => {
			// A record on a DIFFERENT assistant message in the same conversation
			// must not leak into this retry.
			recordOn("assistant-2", {
				skill: { id: "skill-1", displayName: "Meeting critic" },
				webSearch: true,
			});
			resolvesSkill("Meeting critic");

			const result = await retryLatest();

			expect(result.ok).toBe(true);
			expect(resolveAppliedSkill).not.toHaveBeenCalled();
			expect(capturedSyntheticBodies[0]).not.toHaveProperty("pendingSkill");
			expect(capturedSyntheticBodies[0]).not.toHaveProperty("forceWebSearch");
		});

		it("never reads a record outside the caller's own conversation", async () => {
			(getConversation as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

			const result = await prepareRetryChatTurn({
				userId: "other-user",
				runtimeConfig: makeRuntimeConfig(),
				body: {
					conversationId: "conv-1",
					assistantMessageId: "assistant-3",
					userMessageId: "user-3",
					userMessage: "latest prompt",
				},
			});

			expect(result).toEqual({
				ok: false,
				error: {
					error: "Conversation not found",
					status: 404,
					responseShape: "json",
				},
			});
			// Ownership is checked before any message row is read at all.
			expect(capturedMessageSelections).toHaveLength(0);

			// And the read that does happen asks for the metadata column from the
			// messages table, filtered to this conversation.
			await retryLatest();
			expect(capturedMessageSelections).toHaveLength(1);
			expect(Object.keys(capturedMessageSelections[0])).toContain(
				"metadataJson",
			);
			expect(getConversation).toHaveBeenLastCalledWith("user-1", "conv-1");
		});
	});
});
