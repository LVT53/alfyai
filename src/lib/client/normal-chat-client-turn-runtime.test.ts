import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createNormalChatClientTurnRuntime,
	type NormalChatClientTurnRuntimeAdapters,
	type NormalChatRuntimeSnapshot,
} from "$lib/client/normal-chat-client-turn-runtime";
import type {
	StreamCallbacks,
	StreamChatOptions,
	StreamHandle,
	StreamMetadata,
} from "$lib/services/streaming";
import type {
	AtlasJobCard,
	ChatMessage,
	ConversationContextStatus,
	ModelId,
	ReasoningDepth,
} from "$lib/types";

type StreamInvocation = {
	message: string;
	conversationId: string;
	callbacks: StreamCallbacks;
	options?: StreamChatOptions;
	handle: StreamHandle;
};

function atlasJobFixture(overrides: Partial<AtlasJobCard> = {}): AtlasJobCard {
	return {
		id: "atlas-job-1",
		conversationId: "conv-1",
		assistantMessageId: "assistant-1",
		action: "create",
		parentAtlasJobId: null,
		profile: "in-depth",
		title: "Atlas research",
		status: "queued",
		stage: "queued",
		progress: { percent: 0, stage: "queued", details: { queries: [] } },
		sourceCounts: { local: 0, web: 0, accepted: 0, rejected: 0 },
		usage: {
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
			costUsdMicros: 0,
		},
		outputs: {
			fileProductionJobId: null,
			htmlChatGeneratedFileId: null,
			pdfChatGeneratedFileId: null,
			markdownChatGeneratedFileId: null,
		},
		error: null,
		createdAt: 1,
		updatedAt: 1,
		completedAt: null,
		...overrides,
	};
}

function conversationContextStatusFixture(): ConversationContextStatus {
	return {
		conversationId: "conv-1",
		userId: "user-1",
		estimatedTokens: 5_000,
		maxContextTokens: 10_000,
		thresholdTokens: 12_000,
		targetTokens: 10_000,
		compactionApplied: false,
		compactionMode: "none",
		routingStage: "deterministic",
		routingConfidence: 100,
		verificationStatus: "skipped",
		layersUsed: [],
		workingSetCount: 0,
		workingSetArtifactIds: [],
		workingSetApplied: false,
		taskStateApplied: false,
		promptArtifactCount: 0,
		recentTurnCount: 0,
		summary: null,
		updatedAt: 1,
	};
}

function makeAdapters(
	overrides: Partial<NormalChatClientTurnRuntimeAdapters> = {},
) {
	const snapshots: NormalChatRuntimeSnapshot[] = [];
	const streamInvocations: StreamInvocation[] = [];
	const messages: ChatMessage[] = [];
	let idSequence = 0;

	const adapters: NormalChatClientTurnRuntimeAdapters = {
		streamChat: vi.fn((message, conversationId, callbacks, options) => {
			const handle = {
				stop: vi.fn(),
				detach: vi.fn(),
			};
			streamInvocations.push({
				message,
				conversationId,
				callbacks,
				options,
				handle,
			});
			return handle;
		}),
		checkForOrphanedStream: vi.fn(async () => null),
		getStreamBufferInfo: vi.fn(async () => null),
		submitAtlasTurn: vi.fn(async () => ({
			message: "Atlas is queued.",
			atlasJob: atlasJobFixture(),
		})),
		getConversationId: vi.fn(() => "conv-1"),
		getSelectedModel: vi.fn(() => "model1" as ModelId),
		getReasoningDepth: vi.fn((): ReasoningDepth => "auto"),
		getPersonalityProfileId: vi.fn(() => null),
		getActiveDocumentArtifactId: vi.fn(() => undefined),
		getMessages: vi.fn(() => messages),
		isReadOnly: vi.fn(() => false),
		isEditResendPending: vi.fn(() => false),
		isBrowserHidden: vi.fn(() => false),
		randomId: vi.fn(() => `id-${++idSequence}`),
		schedule: vi.fn((callback, _delay) => {
			callback();
			return 1 as unknown as ReturnType<typeof setTimeout>;
		}),
		onStateChange: vi.fn((snapshot) => {
			snapshots.push(snapshot);
		}),
		setConversationModelSelection: vi.fn(),
		clearDraft: vi.fn(),
		clearAttachedArtifacts: vi.fn(() => []),
		recordConversationActivity: vi.fn(),
		startPendingSkillSession: vi.fn(
			async (): Promise<{ ok: true }> => ({
				ok: true,
			}),
		),
		appendUserMessage: vi.fn((message) => {
			messages.push(message);
		}),
		appendAssistantPlaceholder: vi.fn((placeholder) => {
			messages.push(placeholder);
		}),
		appendTokenChunk: vi.fn((placeholderId, chunk) => {
			const message = messages.find((item) => item.id === placeholderId);
			if (message) message.content += chunk;
		}),
		appendThinkingChunk: vi.fn(),
		applyToolCallUpdate: vi.fn(),
		removeMessage: vi.fn((messageId) => {
			const index = messages.findIndex((item) => item.id === messageId);
			if (index !== -1) messages.splice(index, 1);
		}),
		finalizeStreamingMessage: vi.fn(
			({
				placeholderId,
				metadata,
			}: {
				placeholderId: string;
				metadata?: StreamMetadata;
			}) => {
				const message = messages.find((item) => item.id === placeholderId);
				if (message) {
					message.id = metadata?.assistantMessageId ?? message.id;
					message.isStreaming = false;
				}
			},
		),
		applyStreamMetadata: vi.fn(),
		attachFileProductionJobsToAssistantMessage: vi.fn(),
		pollMessageEvidence: vi.fn(),
		refreshMessageCost: vi.fn(),
		hydrateConversationDetail: vi.fn(),
		pollForCompletion: vi.fn(),
		loadPersistedData: vi.fn(),
		mergeGeneratedFiles: vi.fn(),
		setContextCompressionMarkers: vi.fn(),
		maybeTriggerTitleGeneration: vi.fn(),
		runManualContextCompression: vi.fn(async () => undefined),
		restorePayloadToDraft: vi.fn(),
		markPendingSkillUnavailable: vi.fn((payload) => ({
			...payload,
			pendingSkill: payload.pendingSkill
				? { ...payload.pendingSkill, unavailable: true }
				: payload.pendingSkill,
		})),
		isPendingSkillUnavailableError: vi.fn(
			(error) =>
				(error as { code?: string })?.code === "pending_skill_unavailable",
		),
		isForkedSourceHistoryConfirmationRequired: vi.fn(
			(error) =>
				(error as { code?: string })?.code ===
				"forked_source_history_confirmation_required",
		),
		toFriendlySendError: vi.fn((error) =>
			error instanceof Error ? error.message : "Stream failed",
		),
		setSendError: vi.fn(),
		setSkillSessionError: vi.fn(),
		onBackgroundInterrupted: vi.fn(),
		onForkedSourceHistoryConfirmationRequired: vi.fn(),
		...overrides,
	};

	return { adapters, streamInvocations, messages, snapshots };
}

describe("Normal Chat Client Turn Runtime", () => {
	beforeEach(() => {
		vi.useRealTimers();
	});

	it("runs a normal send through the browser stream transport callbacks", () => {
		const { adapters, streamInvocations, messages, snapshots } = makeAdapters();
		const runtime = createNormalChatClientTurnRuntime(adapters);

		runtime.send({
			message: "Hello",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
			modelId: "model2",
		});

		expect(adapters.streamChat).toHaveBeenCalledTimes(1);
		expect(streamInvocations[0]).toMatchObject({
			message: "Hello",
			conversationId: "conv-1",
			options: {
				modelId: "model2",
				attachmentIds: [],
				skipPersistUserMessage: false,
			},
		});
		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
		expect(snapshots.at(-1)).toMatchObject({
			isSending: true,
			active: true,
			canRetry: true,
			queuedTurn: null,
		});

		const metadata: StreamMetadata = {
			assistantMessageId: "assistant-1",
			userMessageId: "user-1",
			contextStatus: conversationContextStatusFixture(),
		};
		streamInvocations[0].callbacks.onToken("Hi");
		streamInvocations[0].callbacks.onEnd("Hi", metadata);

		expect(adapters.appendTokenChunk).toHaveBeenCalledWith("id-2", "Hi");
		expect(adapters.applyStreamMetadata).toHaveBeenCalledWith(metadata);
		expect(adapters.finalizeStreamingMessage).toHaveBeenCalledWith({
			placeholderId: "id-2",
			clientUserMessageId: "id-1",
			metadata,
		});
		expect(adapters.pollMessageEvidence).toHaveBeenCalledWith("assistant-1");
		expect(adapters.refreshMessageCost).not.toHaveBeenCalled();
		expect(adapters.maybeTriggerTitleGeneration).toHaveBeenCalledWith(
			"Hello",
			"Hi",
		);
		expect(runtime.snapshot()).toMatchObject({
			active: false,
			isSending: false,
			canRetry: false,
		});
	});

	it("sends Atlas turns through the send route adapter and starts polling detail", async () => {
		const { adapters, streamInvocations, messages } = makeAdapters();
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.send({
			message: "Research Atlas UI state",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
			atlasMode: true,
			atlasProfile: "in-depth",
			atlasAction: "create",
			clientAtlasTurnId: "client-atlas-1",
		});

		expect(adapters.submitAtlasTurn).toHaveBeenCalledWith({
			conversationId: "conv-1",
			message: "Research Atlas UI state",
			attachmentIds: [],
			linkedSources: [],
			profile: "in-depth",
			action: "create",
			parentAtlasJobId: null,
			clientAtlasTurnId: "client-atlas-1",
		});
		expect(adapters.streamChat).not.toHaveBeenCalled();
		expect(streamInvocations).toHaveLength(0);
		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
		expect(messages[1]).toMatchObject({
			id: "assistant-1",
			content: "Atlas is queued.",
			isStreaming: false,
		});
		expect(adapters.hydrateConversationDetail).toHaveBeenCalledTimes(1);
		expect(runtime.snapshot()).toMatchObject({
			active: false,
			isSending: false,
			canRetry: false,
		});
	});

	it("preserves Atlas options when cloning queued follow-up turns", async () => {
		const { adapters, streamInvocations } = makeAdapters();
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.send({
			message: "First",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});
		runtime.queue({
			message: "Continue Atlas report",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
			atlasMode: true,
			atlasProfile: "exhaustive",
			atlasAction: "continue",
			parentAtlasJobId: "atlas-parent-1",
			clientAtlasTurnId: "client-atlas-2",
		});

		expect(runtime.snapshot().queuedTurn).toMatchObject({
			message: "Continue Atlas report",
			atlasMode: true,
			atlasProfile: "exhaustive",
			atlasAction: "continue",
			parentAtlasJobId: "atlas-parent-1",
			clientAtlasTurnId: "client-atlas-2",
		});

		streamInvocations[0].callbacks.onEnd("Done", {
			assistantMessageId: "assistant-1",
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(adapters.submitAtlasTurn).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Continue Atlas report",
				profile: "exhaustive",
				action: "continue",
				parentAtlasJobId: "atlas-parent-1",
				clientAtlasTurnId: "client-atlas-2",
			}),
		);
		expect(streamInvocations).toHaveLength(1);
	});

	it("forwards response activity stream callbacks to the active assistant placeholder", () => {
		const applyResponseActivityUpdate = vi.fn();
		const { adapters, streamInvocations } = makeAdapters({
			applyResponseActivityUpdate,
		} as Partial<NormalChatClientTurnRuntimeAdapters>);
		const runtime = createNormalChatClientTurnRuntime(adapters);

		runtime.send({
			message: "Hello",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});

		const entry = {
			id: "context-ready",
			kind: "context" as const,
			status: "done" as const,
			count: 2,
		};
		streamInvocations[0].callbacks.onResponseActivity?.(entry);

		expect(applyResponseActivityUpdate).toHaveBeenCalledWith("id-2", entry);
	});

	it("passes turn-scoped model, personality, search, Reasoning depth, and document options to the stream", async () => {
		const linkedSources = [
			{
				displayArtifactId: "artifact-display",
				promptArtifactId: "artifact-prompt",
				familyArtifactIds: ["artifact-display", "artifact-prompt"],
				name: "Quarterly plan",
				type: "document" as const,
				mimeType: "application/pdf",
			},
		];
		const pendingSkill = {
			id: "skill-1",
			ownership: "user" as const,
			skillKind: "user_skill" as const,
			displayName: "Planning reviewer",
			baseSkillId: null,
			baseSkillDisplayName: null,
		};
		const { adapters, streamInvocations } = makeAdapters({
			getSelectedModel: vi.fn(() => "fallback-model" as ModelId),
			getReasoningDepth: vi.fn((): ReasoningDepth => "off"),
			getPersonalityProfileId: vi.fn(() => "persona-from-adapter"),
			getActiveDocumentArtifactId: vi.fn(() => "active-doc-1"),
		});
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.send({
			message: "Review this plan",
			attachmentIds: ["artifact-display"],
			attachments: [],
			pendingAttachments: [],
			linkedSources,
			pendingSkill,
			modelId: "model2",
			personalityProfileId: null,
			reasoningDepth: "max",
			forceWebSearch: true,
		});

		expect(adapters.setConversationModelSelection).toHaveBeenCalledWith(
			"model2",
		);
		expect(streamInvocations[0].options).toMatchObject({
			modelId: "model2",
			attachmentIds: ["artifact-display"],
			linkedSources,
			pendingSkill,
			reasoningDepth: "max",
			forceWebSearch: true,
			activeDocumentArtifactId: "active-doc-1",
			personalityProfileId: null,
		});
	});

	it("merges generated files and context compression snapshots from stream metadata", () => {
		const { adapters, streamInvocations } = makeAdapters();
		const runtime = createNormalChatClientTurnRuntime(adapters);
		const generatedFiles: NonNullable<StreamMetadata["generatedFiles"]> = [
			{
				id: "file-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				artifactId: "artifact-1",
				filename: "plan.docx",
				mimeType:
					"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				sizeBytes: 1234,
				createdAt: 1,
			},
		];
		const contextCompressionSnapshots: NonNullable<
			StreamMetadata["contextCompressionSnapshots"]
		> = [
			{
				id: "snapshot-1",
				trigger: "manual",
				status: "valid",
				sourceEndMessageId: "user-1",
				createdAt: 1,
				updatedAt: 2,
				estimatedTokens: 500,
			},
		];
		const fileProductionJobs: NonNullable<
			StreamMetadata["fileProductionJobs"]
		> = [
			{
				id: "job-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				title: "Report",
				status: "succeeded",
				createdAt: 1,
				updatedAt: 2,
				files: [],
				warnings: [],
			},
		];
		const mergeFileProductionJobs = vi.fn();
		adapters.mergeFileProductionJobs = mergeFileProductionJobs;

		runtime.send({
			message: "Make a file",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});
		streamInvocations[0].callbacks.onEnd("Done", {
			assistantMessageId: "assistant-1",
			generatedFiles,
			fileProductionJobs,
			contextCompressionSnapshots,
		});

		expect(adapters.mergeGeneratedFiles).toHaveBeenCalledWith(generatedFiles);
		expect(mergeFileProductionJobs).toHaveBeenCalledWith(fileProductionJobs);
		expect(adapters.hydrateConversationDetail).not.toHaveBeenCalled();
		expect(adapters.setContextCompressionMarkers).toHaveBeenCalledWith(
			contextCompressionSnapshots,
		);
		expect(
			adapters.attachFileProductionJobsToAssistantMessage,
		).toHaveBeenCalledWith("assistant-1");
	});

	it("drains queued manual compression before a queued follow-up turn after success", async () => {
		const order: string[] = [];
		const { adapters, streamInvocations } = makeAdapters({
			runManualContextCompression: vi.fn(async () => {
				order.push("compression");
			}),
			streamChat: vi.fn((message, conversationId, callbacks, options) => {
				order.push(`stream:${message}`);
				const handle = {
					stop: vi.fn(),
					detach: vi.fn(),
				};
				streamInvocations.push({
					message,
					conversationId,
					callbacks,
					options,
					handle,
				});
				return handle;
			}),
		});
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.send({
			message: "First",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});
		runtime.queue({
			message: "Second",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});
		runtime.compact();

		streamInvocations[0].callbacks.onEnd("Done", {
			assistantMessageId: "assistant-1",
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(order).toEqual(["stream:First", "compression", "stream:Second"]);
		expect(streamInvocations).toHaveLength(2);
		expect(runtime.snapshot()).toMatchObject({
			active: true,
			isSending: true,
			queuedTurn: null,
			queuedContextCompression: false,
		});
	});

	it("keeps the first queued follow-up when later queue attempts are rejected", async () => {
		const { adapters, streamInvocations } = makeAdapters();
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.send({
			message: "First",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});
		runtime.queue({
			message: "Second",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
			reasoningDepth: "max",
			forceWebSearch: true,
		});
		runtime.queue({
			message: "Third",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});

		expect(runtime.snapshot().queuedTurn).toMatchObject({
			message: "Second",
			reasoningDepth: "max",
			forceWebSearch: true,
		});
		expect(adapters.clearDraft).toHaveBeenCalledTimes(2);

		streamInvocations[0].callbacks.onEnd("Done", {
			assistantMessageId: "assistant-1",
		});
		await Promise.resolve();

		expect(streamInvocations).toHaveLength(2);
		expect(streamInvocations[1].message).toBe("Second");
		expect(streamInvocations[1].options).toMatchObject({
			reasoningDepth: "max",
		});
		expect(streamInvocations[1].options).toMatchObject({
			forceWebSearch: true,
		});
	});

	it("restores a queued follow-up to the draft instead of sending it when a turn stops", async () => {
		const { adapters, streamInvocations } = makeAdapters();
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.send({
			message: "First",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});
		const queuedPayload = {
			message: "Keep this",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		};
		runtime.queue(queuedPayload);

		streamInvocations[0].callbacks.onEnd("Stopped", {
			assistantMessageId: "assistant-1",
			wasStopped: true,
		});

		expect(adapters.maybeTriggerTitleGeneration).toHaveBeenCalledWith(
			"First",
			"Stopped",
		);
		expect(streamInvocations).toHaveLength(1);
		expect(adapters.restorePayloadToDraft).toHaveBeenCalledWith(
			expect.objectContaining({
				message: queuedPayload.message,
				attachmentIds: queuedPayload.attachmentIds,
			}),
		);
		expect(runtime.snapshot()).toMatchObject({
			active: false,
			isSending: false,
			queuedTurn: null,
		});
	});

	it("restores stale pending-skill payloads when the stream reports the skill is unavailable", async () => {
		const { adapters, streamInvocations } = makeAdapters();
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.send({
			message: "Use the skill",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
			pendingSkill: {
				id: "skill-1",
				ownership: "user",
				skillKind: "skill_variant",
				displayName: "Draft helper",
				baseSkillId: null,
				baseSkillDisplayName: null,
			},
		});
		const error = new Error("Skill unavailable") as Error & { code?: string };
		error.code = "pending_skill_unavailable";

		streamInvocations[0].callbacks.onError(error);

		expect(adapters.restorePayloadToDraft).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Use the skill",
				pendingSkill: expect.objectContaining({ unavailable: true }),
			}),
		);
		expect(adapters.removeMessage).toHaveBeenCalledWith("id-1");
		expect(adapters.setSendError).toHaveBeenCalledWith(
			"pendingSkill.recoveryError",
		);
		expect(runtime.snapshot()).toMatchObject({
			active: false,
			isSending: false,
			canRetry: false,
		});
	});

	it("restores a queued follow-up to the draft when the browser backgrounds a normal stream", async () => {
		const { adapters, streamInvocations } = makeAdapters({
			isBrowserHidden: vi.fn(() => true),
		});
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.send({
			message: "First",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});
		const queuedPayload = {
			message: "Restore this",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		};
		runtime.queue(queuedPayload);
		const abortError = new Error("backgrounded");
		abortError.name = "AbortError";

		streamInvocations[0].callbacks.onError(abortError);

		expect(adapters.removeMessage).toHaveBeenCalledWith("id-2");
		expect(adapters.restorePayloadToDraft).toHaveBeenCalledWith(
			expect.objectContaining({
				message: queuedPayload.message,
				attachmentIds: queuedPayload.attachmentIds,
			}),
		);
		expect(adapters.onBackgroundInterrupted).toHaveBeenCalledTimes(1);
		expect(runtime.snapshot()).toMatchObject({
			active: false,
			isSending: false,
			queuedTurn: null,
			streamInterruptedByBackground: true,
		});
	});

	it("runs queued manual compression and clears the queued marker when a stream errors", async () => {
		const { adapters, streamInvocations } = makeAdapters();
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.send({
			message: "First",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});
		runtime.compact();

		streamInvocations[0].callbacks.onError(new Error("Network failed"));

		expect(adapters.runManualContextCompression).toHaveBeenCalledTimes(1);
		expect(runtime.snapshot()).toMatchObject({
			active: false,
			isSending: false,
			queuedContextCompression: false,
			canRetry: true,
		});
	});

	it("defers queued manual compression until background recovery loads persisted detail", async () => {
		let browserHidden = true;
		const order: string[] = [];
		const { adapters, streamInvocations } = makeAdapters({
			isBrowserHidden: vi.fn(() => browserHidden),
			checkForOrphanedStream: vi.fn(async () => null),
			loadPersistedData: vi.fn(async () => {
				order.push("load-persisted");
			}),
			runManualContextCompression: vi.fn(async () => {
				order.push("compress");
			}),
		});
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.send({
			message: "First",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});
		runtime.compact();
		const abortError = new Error("backgrounded");
		abortError.name = "AbortError";

		streamInvocations[0].callbacks.onError(abortError);

		expect(adapters.runManualContextCompression).not.toHaveBeenCalled();
		expect(runtime.snapshot()).toMatchObject({
			streamInterruptedByBackground: true,
			queuedContextCompression: true,
		});

		browserHidden = false;
		await runtime.handleVisibilityVisible();

		expect(order).toEqual(["load-persisted", "compress"]);
		expect(runtime.snapshot()).toMatchObject({
			streamInterruptedByBackground: false,
			queuedContextCompression: false,
		});
	});

	it("keeps generic stream errors retryable and retries against the previous assistant message", async () => {
		const { adapters, streamInvocations, messages } = makeAdapters({
			getSelectedModel: vi.fn(() => "fallback-model" as ModelId),
			getReasoningDepth: vi.fn((): ReasoningDepth => "off"),
			getPersonalityProfileId: vi.fn(() => "persona-retry"),
			getActiveDocumentArtifactId: vi.fn(() => "active-doc-retry"),
		});
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.send({
			message: "Regenerate this",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
			reasoningDepth: "max",
		});
		streamInvocations[0].callbacks.onError(new Error("Network failed"));

		expect(adapters.setSendError).toHaveBeenCalledWith("Network failed");
		expect(runtime.snapshot()).toMatchObject({
			active: false,
			isSending: false,
			canRetry: true,
			lastUserMessage: "Regenerate this",
		});

		messages.push({
			id: "assistant-old",
			role: "assistant",
			content: "Bad answer",
			timestamp: 3,
			modelId: "model1",
		});
		vi.mocked(adapters.setSendError).mockClear();

		runtime.retry();

		expect(adapters.removeMessage).toHaveBeenCalledWith("assistant-old");
		expect(streamInvocations).toHaveLength(2);
		expect(streamInvocations[1]).toMatchObject({
			message: "Regenerate this",
			options: {
				modelId: "model1",
				reasoningDepth: "max",
				activeDocumentArtifactId: "active-doc-retry",
				personalityProfileId: "persona-retry",
				retryAssistantMessageId: "assistant-old",
				retryUserMessageId: "id-1",
				retryUserMessage: "Regenerate this",
			},
		});
		expect(adapters.setSendError).toHaveBeenCalledWith(null);

		vi.mocked(adapters.setSendError).mockClear();
		const forkError = new Error("Confirm fork mutation") as Error & {
			code?: string;
		};
		forkError.code = "forked_source_history_confirmation_required";

		streamInvocations[1].callbacks.onError(forkError);

		expect(
			adapters.onForkedSourceHistoryConfirmationRequired,
		).toHaveBeenCalledTimes(1);
		expect(adapters.setSendError).not.toHaveBeenCalledWith(
			"fork.regenerateWarning",
		);
	});

	it("reconnects to an orphaned stream and hands waiting state to polling", async () => {
		const { adapters, streamInvocations } = makeAdapters({
			checkForOrphanedStream: vi.fn(async () => "stream-1"),
			getStreamBufferInfo: vi.fn(async () => ({
				exists: true,
				userMessage: "Resume me",
			})),
		});
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.checkForOrphanedStreamOnMount();

		expect(adapters.getStreamBufferInfo).toHaveBeenCalledWith(
			"stream-1",
			"conv-1",
		);
		expect(streamInvocations[0]).toMatchObject({
			message: "Resume me",
			options: {
				reconnectToStreamId: "stream-1",
				reconnectUserMessage: "Resume me",
			},
		});

		streamInvocations[0].callbacks.onWaiting?.();

		expect(streamInvocations[0].handle.detach).toHaveBeenCalledTimes(1);
		expect(adapters.pollForCompletion).toHaveBeenCalledWith("id-1", "id-2");
		expect(runtime.snapshot()).toMatchObject({
			active: false,
			isSending: true,
			isPollingForCompletion: true,
		});
	});

	it("reconnects with the original stream Reasoning depth from the buffer snapshot", async () => {
		const { adapters, streamInvocations } = makeAdapters({
			getReasoningDepth: vi.fn((): ReasoningDepth => "off"),
			checkForOrphanedStream: vi.fn(async () => "stream-1"),
			getStreamBufferInfo: vi.fn(async () => ({
				exists: true,
				userMessage: "Resume me",
				reasoningDepth: "max" as ReasoningDepth,
			})),
		});
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.checkForOrphanedStreamOnMount();

		expect(streamInvocations[0]).toMatchObject({
			message: "Resume me",
			options: {
				reconnectToStreamId: "stream-1",
				reconnectUserMessage: "Resume me",
				reasoningDepth: "max",
			},
		});
	});

	it("retries orphan reconnect capacity errors with bounded backoff", async () => {
		vi.useFakeTimers();
		const { adapters, streamInvocations, messages } = makeAdapters({
			schedule: vi.fn((callback, delay) => setTimeout(callback, delay)),
		});
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.reconnectToOrphanedStream("stream-1", "Resume me");
		const capacity = new Error("Server at capacity") as Error & {
			code?: string;
		};
		capacity.code = "CAPACITY_EXCEEDED";
		streamInvocations[0].callbacks.onError(capacity);

		expect(adapters.schedule).toHaveBeenCalledWith(expect.any(Function), 500);
		expect(streamInvocations).toHaveLength(1);

		await vi.runOnlyPendingTimersAsync();

		expect(streamInvocations).toHaveLength(2);
		expect(streamInvocations[1].options).toMatchObject({
			reconnectToStreamId: "stream-1",
			reconnectUserMessage: "Resume me",
		});
		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
		vi.useRealTimers();
	});

	it("reuses the optimistic user message when reconnecting after a background interruption", async () => {
		let browserHidden = true;
		let composerDepth: "off" | "max" = "max";
		const { adapters, streamInvocations, messages } = makeAdapters({
			isBrowserHidden: vi.fn(() => browserHidden),
			getReasoningDepth: vi.fn((): ReasoningDepth => composerDepth),
			checkForOrphanedStream: vi.fn(async () => "stream-1"),
			getStreamBufferInfo: vi.fn(async () => ({
				exists: true,
				userMessage: "Resume me",
				reasoningDepth: "max" as ReasoningDepth,
			})),
		});
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.send({
			message: "Resume me",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
			reasoningDepth: "max",
		});
		const abortError = new Error("backgrounded");
		abortError.name = "AbortError";
		streamInvocations[0].callbacks.onError(abortError);

		composerDepth = "off";
		browserHidden = false;
		runtime.handleVisibilityVisible();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
		expect(streamInvocations[1].options).toMatchObject({
			reconnectToStreamId: "stream-1",
			reconnectUserMessage: "Resume me",
			reasoningDepth: "max",
		});

		streamInvocations[1].callbacks.onEnd("Done", {
			assistantMessageId: "assistant-1",
			userMessageId: "server-user-1",
		});

		expect(adapters.finalizeStreamingMessage).toHaveBeenLastCalledWith({
			placeholderId: "id-3",
			clientUserMessageId: "id-1",
			metadata: {
				assistantMessageId: "assistant-1",
				userMessageId: "server-user-1",
			},
		});
	});

	it("loads persisted conversation detail when a backgrounded stream has no orphan to reconnect", async () => {
		let browserHidden = true;
		const { adapters, streamInvocations } = makeAdapters({
			isBrowserHidden: vi.fn(() => browserHidden),
			checkForOrphanedStream: vi.fn(async () => null),
		});
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.send({
			message: "Finish while hidden",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});
		const abortError = new Error("backgrounded");
		abortError.name = "AbortError";
		streamInvocations[0].callbacks.onError(abortError);

		browserHidden = false;
		await runtime.handleVisibilityVisible();

		expect(adapters.checkForOrphanedStream).toHaveBeenCalledWith("conv-1");
		expect(adapters.loadPersistedData).toHaveBeenCalledTimes(1);
		expect(streamInvocations).toHaveLength(1);
		expect(runtime.snapshot()).toMatchObject({
			streamInterruptedByBackground: false,
			active: false,
			isSending: false,
		});
	});

	describe("Token Display Buffer", () => {
		beforeEach(() => {
			vi.useRealTimers();
			// Prevent rAF from firing so tests only see synchronous flush paths.
			vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(
				() => -1,
			);
		});

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("coalesces multiple token chunks via the buffer and flushes them as one chunk on end", () => {
			const { adapters, streamInvocations } = makeAdapters();
			const runtime = createNormalChatClientTurnRuntime(adapters);

			runtime.send({
				message: "Hello",
				attachmentIds: [],
				attachments: [],
				pendingAttachments: [],
			});

			streamInvocations[0].callbacks.onToken("A");
			streamInvocations[0].callbacks.onToken("B");

			streamInvocations[0].callbacks.onEnd("AB", {
				assistantMessageId: "assistant-1",
			});

			expect(adapters.appendTokenChunk).toHaveBeenCalledTimes(1);
			expect(adapters.appendTokenChunk).toHaveBeenCalledWith("id-2", "AB");
		});

		it("flushes the token buffer on stream errors so buffered text is not lost", () => {
			const { adapters, streamInvocations } = makeAdapters();
			const runtime = createNormalChatClientTurnRuntime(adapters);

			runtime.send({
				message: "Hello",
				attachmentIds: [],
				attachments: [],
				pendingAttachments: [],
			});

			streamInvocations[0].callbacks.onToken("A");
			streamInvocations[0].callbacks.onToken("B");

			streamInvocations[0].callbacks.onError(new Error("Network failed"));

			expect(adapters.appendTokenChunk).toHaveBeenCalledTimes(1);
			expect(adapters.appendTokenChunk).toHaveBeenCalledWith("id-2", "AB");
		});

		it("does not deliver buffered token text before stream-end or stream-error", () => {
			const { adapters, streamInvocations } = makeAdapters();
			const runtime = createNormalChatClientTurnRuntime(adapters);

			runtime.send({
				message: "Hello",
				attachmentIds: [],
				attachments: [],
				pendingAttachments: [],
			});

			streamInvocations[0].callbacks.onToken("A");

			expect(adapters.appendTokenChunk).not.toHaveBeenCalled();
		});

		it("coalesces thinking chunks through the buffer and delivers them on end", () => {
			const { adapters, streamInvocations } = makeAdapters();
			const runtime = createNormalChatClientTurnRuntime(adapters);

			runtime.send({
				message: "Hello",
				attachmentIds: [],
				attachments: [],
				pendingAttachments: [],
			});

			streamInvocations[0].callbacks.onThinking("A");
			streamInvocations[0].callbacks.onThinking("B");

			streamInvocations[0].callbacks.onEnd("AB", {
				assistantMessageId: "assistant-1",
			});

			expect(adapters.appendThinkingChunk).toHaveBeenCalledTimes(1);
			expect(adapters.appendThinkingChunk).toHaveBeenCalledWith("id-2", "AB");
		});
	});
});
