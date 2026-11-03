import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerHealth } from "$lib/client/api/health";
import {
	createNormalChatClientTurnRuntime,
	type NormalChatClientTurnRuntimeAdapters,
	type NormalChatMessageListEvent,
	type NormalChatRuntimeSnapshot,
} from "$lib/client/normal-chat-client-turn-runtime";
import type { ModelId } from "$lib/model-types";
import type { ReasoningDepth } from "$lib/reasoning-depth-types";
import type { AtlasJobCard } from "$lib/server/services/atlas/public-types";
import type { ConversationContextStatus } from "$lib/server/services/knowledge/context-types";
import type { ChatMessage } from "$lib/server/services/messages-types";
import type {
	StreamCallbacks,
	StreamChatOptions,
	StreamHandle,
	StreamMetadata,
	StreamTimingSnapshot,
} from "$lib/services/streaming";

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
		promptTokens: 5_000,
		promptTokensSource: "estimated",
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

// R1 (ADR-0060) — the nine message-list mutations the runtime used to drive
// through nine separate adapter members now go through one
// `applyMessageListEvent` dispatch. These sub-spies keep each mutation's own
// call-recording (and default in-memory list behaviour) intact for
// assertions and per-test overrides, without reintroducing nine adapter
// members.
type MessageListEventHandlers = {
	appendUserMessage: (message: ChatMessage) => void;
	appendAssistantPlaceholder: (placeholder: ChatMessage) => void;
	appendTokenChunk: (placeholderId: string, chunk: string) => void;
	appendThinkingChunk: (placeholderId: string, chunk: string) => void;
	applyToolCallUpdate: (
		placeholderId: string,
		name: string,
		input: Record<string, unknown>,
		status: "running" | "done" | "failed",
		details: unknown,
	) => void;
	applyResponseActivityUpdate: (placeholderId: string, entry: unknown) => void;
	setAssistantRuntimePhase: (placeholderId: string, phase: unknown) => void;
	removeMessage: (messageId: string) => void;
	finalizeStreamingMessage: (params: {
		placeholderId: string;
		clientUserMessageId: string | null;
		metadata?: StreamMetadata;
	}) => void;
};

function makeAdapters(
	overrides: Partial<NormalChatClientTurnRuntimeAdapters> = {},
	messageListOverrides: Partial<MessageListEventHandlers> = {},
) {
	const snapshots: NormalChatRuntimeSnapshot[] = [];
	const streamInvocations: StreamInvocation[] = [];
	const messages: ChatMessage[] = [];
	let idSequence = 0;

	const messageListEvents = {
		appendUserMessage: vi.fn(
			messageListOverrides.appendUserMessage ??
				((message: ChatMessage) => {
					messages.push(message);
				}),
		),
		appendAssistantPlaceholder: vi.fn(
			messageListOverrides.appendAssistantPlaceholder ??
				((placeholder: ChatMessage) => {
					messages.push(placeholder);
				}),
		),
		appendTokenChunk: vi.fn(
			messageListOverrides.appendTokenChunk ??
				((placeholderId: string, chunk: string) => {
					const message = messages.find((item) => item.id === placeholderId);
					if (message) message.content += chunk;
				}),
		),
		appendThinkingChunk: vi.fn(messageListOverrides.appendThinkingChunk),
		applyToolCallUpdate: vi.fn(messageListOverrides.applyToolCallUpdate),
		applyResponseActivityUpdate: vi.fn(
			messageListOverrides.applyResponseActivityUpdate,
		),
		setAssistantRuntimePhase: vi.fn(
			messageListOverrides.setAssistantRuntimePhase ??
				((placeholderId: string, phase: unknown) => {
					const message = messages.find((item) => item.id === placeholderId);
					if (message)
						message.runtimePhase = phase as ChatMessage["runtimePhase"];
				}),
		),
		removeMessage: vi.fn(
			messageListOverrides.removeMessage ??
				((messageId: string) => {
					const index = messages.findIndex((item) => item.id === messageId);
					if (index !== -1) messages.splice(index, 1);
				}),
		),
		finalizeStreamingMessage: vi.fn(
			messageListOverrides.finalizeStreamingMessage ??
				(({
					placeholderId,
					metadata,
				}: {
					placeholderId: string;
					clientUserMessageId: string | null;
					metadata?: StreamMetadata;
				}) => {
					const message = messages.find((item) => item.id === placeholderId);
					if (message) {
						message.id = metadata?.assistantMessageId ?? message.id;
						message.isStreaming = false;
						message.runtimePhase = undefined;
					}
				}),
		),
	} satisfies MessageListEventHandlers;

	const applyMessageListEvent = vi.fn((event: NormalChatMessageListEvent) => {
		switch (event.type) {
			case "appendUser":
				messageListEvents.appendUserMessage(event.message);
				return;
			case "appendAssistantPlaceholder":
				messageListEvents.appendAssistantPlaceholder(event.placeholder);
				return;
			case "appendToken":
				messageListEvents.appendTokenChunk(event.placeholderId, event.chunk);
				return;
			case "appendThinking":
				messageListEvents.appendThinkingChunk(event.placeholderId, event.chunk);
				return;
			case "applyToolCall":
				messageListEvents.applyToolCallUpdate(
					event.placeholderId,
					event.name,
					event.input,
					event.status,
					event.details,
				);
				return;
			case "applyResponseActivity":
				messageListEvents.applyResponseActivityUpdate(
					event.placeholderId,
					event.entry,
				);
				return;
			case "setRuntimePhase":
				messageListEvents.setAssistantRuntimePhase(
					event.placeholderId,
					event.phase,
				);
				return;
			case "remove":
				messageListEvents.removeMessage(event.messageId);
				return;
			case "finalize":
				messageListEvents.finalizeStreamingMessage({
					placeholderId: event.placeholderId,
					clientUserMessageId: event.clientUserMessageId,
					metadata: event.metadata,
				});
				return;
		}
	});

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
		getReasoningDepth: vi.fn((): ReasoningDepth => "thorough"),
		getPersonalityProfileId: vi.fn(() => null),
		getActiveDocumentArtifactId: vi.fn(() => undefined),
		getMessages: vi.fn(() => messages),
		isReadOnly: vi.fn(() => false),
		isEditResendPending: vi.fn(() => false),
		isEditOpen: vi.fn(() => false),
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
		applyMessageListEvent,
		applyStreamMetadata: vi.fn(),
		attachFileProductionJobsToAssistantMessage: vi.fn(),
		refreshPendingWrites: vi.fn(),
		pollMessageEvidence: vi.fn(),
		refreshMessageCost: vi.fn(),
		hydrateConversationDetail: vi.fn(),
		pollForCompletion: vi.fn(),
		loadPersistedData: vi.fn(),
		// A server that answers and is not draining: nothing waits for an update
		// unless a test says the server is away.
		fetchServerHealth: vi.fn(
			async (): Promise<ServerHealth> => ({ reachable: true, draining: false }),
		),
		isServerUpdating: vi.fn(async () => false),
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
		onBackgroundInterrupted: vi.fn(),
		onForkedSourceHistoryConfirmationRequired: vi.fn(),
		...overrides,
	};

	return {
		adapters,
		streamInvocations,
		messages,
		snapshots,
		messageListEvents,
	};
}

describe("Normal Chat Client Turn Runtime", () => {
	beforeEach(() => {
		vi.useRealTimers();
	});

	it("keeps an attachment's outline and cost fields on the optimistic user message", () => {
		// Chips redesign: the sent bubble splits a quote back out of the text
		// only against THIS message's outline headings, and draws the file
		// chip's "24 pp · 18k tok" meta from the same fields. They must survive
		// the optimistic append, not only the server projection on reload.
		const { adapters, messages } = makeAdapters();
		const runtime = createNormalChatClientTurnRuntime(adapters);
		const outline = [
			{
				level: 2,
				title: "2.3 Break clause",
				offset: 0,
				preview: "Either party may terminate",
			},
		];

		runtime.send({
			message: "2.3 Break clause: Either party may terminate…\n\nCan we leave?",
			attachmentIds: ["artifact-lease", "artifact-note"],
			attachments: [
				{
					id: "artifact-lease",
					type: "source_document",
					retrievalClass: "durable",
					name: "Lease agreement 2026.pdf",
					mimeType: "application/pdf",
					sizeBytes: 482_112,
					conversationId: "conv-1",
					summary: null,
					createdAt: 1,
					updatedAt: 1,
					tokenEstimate: 18_400,
					pageCount: 24,
					outline,
				},
				{
					id: "artifact-note",
					type: "source_document",
					retrievalClass: "durable",
					name: "note.txt",
					mimeType: "text/plain",
					sizeBytes: 12,
					conversationId: "conv-1",
					summary: null,
					createdAt: 1,
					updatedAt: 1,
				},
			],
			pendingAttachments: [],
			modelId: "model2",
		});

		const user = messages.find((message) => message.role === "user");
		expect(user?.attachments).toHaveLength(2);
		expect(user?.attachments?.[0]).toMatchObject({
			artifactId: "artifact-lease",
			tokenEstimate: 18_400,
			pageCount: 24,
			outline,
		});
		// An artifact that never had the fields does not grow empty ones —
		// the server projection omits them too, so the shapes stay identical.
		expect(user?.attachments?.[1]).toMatchObject({
			artifactId: "artifact-note",
		});
		expect(user?.attachments?.[1]).not.toHaveProperty("outline");
		expect(user?.attachments?.[1]).not.toHaveProperty("tokenEstimate");
		expect(user?.attachments?.[1]).not.toHaveProperty("pageCount");
	});

	it("runs a normal send through the browser stream transport callbacks", () => {
		const {
			adapters,
			streamInvocations,
			messages,
			snapshots,
			messageListEvents,
		} = makeAdapters();
		const runtime = createNormalChatClientTurnRuntime(adapters);

		expect(runtime.snapshot().phase).toBe("idle");

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
			phase: "preparing",
			canRetry: true,
			queuedTurn: null,
		});
		expect(messages[1]).toMatchObject({
			role: "assistant",
			runtimePhase: "preparing",
		});

		const metadata: StreamMetadata = {
			assistantMessageId: "assistant-1",
			userMessageId: "user-1",
			contextStatus: conversationContextStatusFixture(),
		};
		streamInvocations[0].callbacks.onToken("Hi");
		expect(runtime.snapshot().phase).toBe("generating");
		expect(messages[1]).toMatchObject({ runtimePhase: "generating" });

		streamInvocations[0].callbacks.onFinishPart?.({
			type: "finish",
			finishReason: "stop",
		});
		expect(runtime.snapshot()).toMatchObject({
			phase: "finalizing",
			active: true,
			isSending: true,
		});
		expect(messages[1]).toMatchObject({ runtimePhase: "finalizing" });

		streamInvocations[0].callbacks.onEnd("Hi", metadata);

		expect(messageListEvents.appendTokenChunk).toHaveBeenCalledWith(
			"id-2",
			"Hi",
		);
		expect(adapters.applyStreamMetadata).toHaveBeenCalledWith(metadata);
		expect(messageListEvents.finalizeStreamingMessage).toHaveBeenCalledWith({
			placeholderId: "id-2",
			clientUserMessageId: "id-1",
			metadata,
		});
		expect(adapters.pollMessageEvidence).toHaveBeenCalledWith("assistant-1");
		expect(adapters.refreshMessageCost).not.toHaveBeenCalled();
		expect(adapters.maybeTriggerTitleGeneration).toHaveBeenCalledTimes(1);
		expect(runtime.snapshot()).toMatchObject({
			active: false,
			isSending: false,
			phase: "idle",
			canRetry: false,
		});
		expect(messages[1]).toMatchObject({
			id: "assistant-1",
			runtimePhase: undefined,
		});
	});

	// Gap 2 — the server can only record an activity_events "edit_resend" row
	// if the edit-and-resend flow's isEditResend flag actually reaches the
	// request; this pins the client-side leg of that plumbing.
	it("threads payload.isEditResend into the stream request options", () => {
		const { adapters, streamInvocations } = makeAdapters();
		const runtime = createNormalChatClientTurnRuntime(adapters);

		runtime.send({
			message: "Edited message",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
			isEditResend: true,
		});

		expect(streamInvocations[0]).toMatchObject({
			message: "Edited message",
			options: { isEditResend: true },
		});
	});

	it("omits isEditResend (false) for an ordinary send", () => {
		const { adapters, streamInvocations } = makeAdapters();
		const runtime = createNormalChatClientTurnRuntime(adapters);

		runtime.send({
			message: "Hello",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});

		expect(streamInvocations[0]).toMatchObject({
			options: { isEditResend: false },
		});
		expect(streamInvocations[0].options?.retryOrigin).toBeUndefined();
	});

	it("marks an Answer-now regenerate so the server does not count it as a regenerate", async () => {
		const { adapters, streamInvocations } = makeAdapters();
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.send(
			{
				message: "Review this plan",
				attachmentIds: [],
				attachments: [],
				pendingAttachments: [],
				reasoningDepth: "quick",
			},
			{
				skipUserMessage: true,
				skipPersistUserMessage: true,
				retryAssistantMessageId: "assistant-1",
				retryUserMessageId: "user-1",
				retryOrigin: "answer_now",
			},
		);

		expect(streamInvocations[0].options).toMatchObject({
			retryAssistantMessageId: "assistant-1",
			retryOrigin: "answer_now",
		});
	});

	it("clears sending before receipt-only completion metadata starts eventual hydration", () => {
		const { adapters, streamInvocations } = makeAdapters();
		const runtime = createNormalChatClientTurnRuntime(adapters);
		const hydrationSnapshots: NormalChatRuntimeSnapshot[] = [];
		vi.mocked(adapters.hydrateConversationDetail).mockImplementation(() => {
			hydrationSnapshots.push(runtime.snapshot());
		});

		runtime.send({
			message: "Make a report",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});

		streamInvocations[0].callbacks.onToken("Done");
		streamInvocations[0].callbacks.onFinishPart?.({
			type: "finish",
			finishReason: "stop",
		});
		streamInvocations[0].callbacks.onEnd("Done", {
			assistantMessageId: "assistant-1",
			userMessageId: "user-1",
			responseTokenCount: 8,
		});

		expect(runtime.snapshot()).toMatchObject({
			active: false,
			isSending: false,
			phase: "idle",
		});
		expect(adapters.hydrateConversationDetail).toHaveBeenCalledTimes(1);
		expect(hydrationSnapshots[0]).toMatchObject({
			active: false,
			isSending: false,
			phase: "idle",
		});
		expect(adapters.pollMessageEvidence).toHaveBeenCalledWith("assistant-1");
		expect(adapters.refreshMessageCost).toHaveBeenCalledWith("assistant-1");
		expect(
			adapters.attachFileProductionJobsToAssistantMessage,
		).toHaveBeenCalledWith("assistant-1");
		// Issue 7.5 — fires at the same "assistant message id known" moment so
		// a pending write proposed this turn picks up its server-backfilled
		// assistantMessageId before it drops out of the streaming-fallback
		// match.
		expect(adapters.refreshPendingWrites).toHaveBeenCalledTimes(1);
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

	// A person leaving the chat takes their queued words with them: the page asks
	// for the turn to save its words in the chat's draft. Nothing is sent and
	// nothing is put back in a composer.
	describe("handing the queued turn over", () => {
		const queuedPayload = {
			message: "Second",
			attachmentIds: ["file-1"],
			attachments: [],
			pendingAttachments: [],
			conversationId: "conv-1",
		};

		it("gives the turn back and empties the queue, sending and restoring nothing", async () => {
			const { adapters, streamInvocations } = makeAdapters();
			const runtime = createNormalChatClientTurnRuntime(adapters);
			await runtime.send({
				message: "First",
				attachmentIds: [],
				attachments: [],
				pendingAttachments: [],
			});
			runtime.queue(queuedPayload);

			const taken = runtime.takeQueuedTurn();

			expect(taken).toMatchObject({
				message: "Second",
				attachmentIds: ["file-1"],
				conversationId: "conv-1",
			});
			expect(runtime.snapshot().queuedTurn).toBeNull();
			expect(adapters.restorePayloadToDraft).not.toHaveBeenCalled();

			// The first turn ending finds nothing queued to send.
			streamInvocations[0].callbacks.onEnd("Done", {
				assistantMessageId: "assistant-1",
			});
			await Promise.resolve();
			await Promise.resolve();
			expect(streamInvocations).toHaveLength(1);
		});

		it("hands over a copy, not the runtime's own", async () => {
			const { adapters } = makeAdapters();
			const runtime = createNormalChatClientTurnRuntime(adapters);
			await runtime.send({
				message: "First",
				attachmentIds: [],
				attachments: [],
				pendingAttachments: [],
			});
			runtime.queue(queuedPayload);

			const taken = runtime.takeQueuedTurn();

			expect(taken).not.toBe(queuedPayload);
			expect(taken?.attachmentIds).not.toBe(queuedPayload.attachmentIds);
		});

		it("tells the state listeners the queue is empty", async () => {
			const { adapters } = makeAdapters();
			const runtime = createNormalChatClientTurnRuntime(adapters);
			await runtime.send({
				message: "First",
				attachmentIds: [],
				attachments: [],
				pendingAttachments: [],
			});
			runtime.queue(queuedPayload);
			vi.mocked(adapters.onStateChange as (s: unknown) => void).mockClear();

			runtime.takeQueuedTurn();

			expect(adapters.onStateChange).toHaveBeenLastCalledWith(
				expect.objectContaining({ queuedTurn: null }),
			);
		});

		it("answers null when nothing is queued", async () => {
			const { adapters } = makeAdapters();
			const runtime = createNormalChatClientTurnRuntime(adapters);

			expect(runtime.takeQueuedTurn()).toBeNull();
		});
	});

	it("forwards response activity stream callbacks to the active assistant placeholder", () => {
		const applyResponseActivityUpdate = vi.fn();
		const { adapters, streamInvocations } = makeAdapters(
			{},
			{ applyResponseActivityUpdate },
		);
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
			contextPreparationClass: "context-retrieval" as const,
			count: 2,
		};
		streamInvocations[0].callbacks.onResponseActivity?.(entry);

		expect(applyResponseActivityUpdate).toHaveBeenCalledWith("id-2", entry);
	});

	it("forwards stream timing snapshots to the optional diagnostics adapter hook", () => {
		const onStreamTiming = vi.fn();
		const { adapters, streamInvocations, messages } = makeAdapters({
			onStreamTiming,
		} as Partial<NormalChatClientTurnRuntimeAdapters>);
		const runtime = createNormalChatClientTurnRuntime(adapters);

		runtime.send({
			message: "Hello",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});

		const timing: StreamTimingSnapshot = {
			streamId: "stream-1",
			url: "/api/chat/stream",
			serverTiming: "route_parse;dur=1",
			parsedServerTiming: { route_parse: 1 },
			serverTimeline: { version: 1, server: { prelude: 2 } },
			outcome: "success",
			phases: {
				fetchStartMs: 0,
				firstActivityMs: 4,
				endMs: 10,
			},
		};
		streamInvocations[0].callbacks.onTiming?.(timing);

		expect(onStreamTiming).toHaveBeenCalledWith(timing);
		expect(messages[1]).toMatchObject({
			role: "assistant",
			content: "",
			isStreaming: true,
		});
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
			getReasoningDepth: vi.fn((): ReasoningDepth => "quick"),
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
			reasoningDepth: "thorough",
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
			reasoningDepth: "thorough",
			forceWebSearch: true,
			activeDocumentArtifactId: "active-doc-1",
			personalityProfileId: null,
		});
	});

	it("puts the pictures of a send on the optimistic user message, from its first paint", async () => {
		const { adapters, messageListEvents } = makeAdapters();
		const runtime = createNormalChatClientTurnRuntime(adapters);
		const pictures = {
			refs: [{ imageFileId: "file-1", number: 2, name: "Red rug" }],
			uploads: [{ artifactId: "photo-1", number: 1 }],
			open: null,
			marks: null,
		};

		await runtime.send({
			message: "Blend them",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
			pictureRefs: [{ imageFileId: "file-1", number: 2 }],
			pictures,
		});

		expect(messageListEvents.appendUserMessage).toHaveBeenCalledWith(
			expect.objectContaining({ role: "user", pictures }),
		);
	});

	it("keeps the pictures' names through a queued turn's copy and its restore", async () => {
		const pictures = {
			refs: [{ imageFileId: "file-1", number: 1, name: "Red rug" }],
			open: null,
			marks: null,
		};
		const { adapters } = makeAdapters();
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
			pictureRefs: [{ imageFileId: "file-1", number: 1 }],
			pictures,
		});
		const queued = runtime.snapshot().queuedTurn;
		expect(queued?.pictures).toEqual(pictures);
		expect(queued?.pictures).not.toBe(pictures);
		runtime.editQueuedTurn();
		expect(adapters.restorePayloadToDraft).toHaveBeenCalledWith(
			expect.objectContaining({ pictures }),
		);
	});

	it("hands the card pictures and the marks of a send to the stream", async () => {
		const { adapters, streamInvocations } = makeAdapters();
		const runtime = createNormalChatClientTurnRuntime(adapters);
		const pictureRefs = [{ imageFileId: "file-1", number: 1 }];
		const imageMarks = {
			imageFileId: "file-1",
			marks: [{ letter: "B" as const, x: 0, y: 0, w: 0.5, h: 0.5 }],
		};

		await runtime.send({
			message: "Make the marked part blue",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
			pictureRefs,
			imageMarks,
		});

		expect(streamInvocations[0].options).toMatchObject({
			pictureRefs,
			imageMarks,
		});
	});

	// The composer's chips are gone once the turn is sent, so what the user
	// chose is stamped on the optimistic assistant placeholder for its
	// provenance line (see $lib/message-user-intent.ts). The server's own
	// record on the terminal frame replaces it when it arrives.
	it("stamps the user's applied skill and forced web search on the assistant placeholder", async () => {
		const { adapters, messageListEvents } = makeAdapters();
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.send({
			message: "Review this plan",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
			pendingSkill: {
				id: "skill-1",
				ownership: "user",
				displayName: "Planning reviewer",
			},
			forceWebSearch: true,
		});

		expect(messageListEvents.appendAssistantPlaceholder).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "assistant",
				userIntent: {
					skill: { id: "skill-1", displayName: "Planning reviewer" },
					webSearch: true,
				},
			}),
		);
	});

	it("leaves the placeholder without a userIntent when the user chose nothing", async () => {
		const { adapters, messageListEvents } = makeAdapters();
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.send({
			message: "Just a question",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});

		const [placeholder] =
			messageListEvents.appendAssistantPlaceholder.mock.calls[0];
		expect(placeholder).not.toHaveProperty("userIntent");
	});

	// An Atlas turn carries neither choice: the server drops `pendingSkill`
	// and `forceWebSearch` for `atlasMode` (chat-turn/request.ts), so stamping
	// them here would draw a chip for something the server never honoured —
	// and nothing would ever come back to take it away, because the Atlas
	// finalize frame carries no record either.
	it("stamps no userIntent on an Atlas turn, whatever the composer had on", async () => {
		const { adapters, messageListEvents } = makeAdapters();
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.send({
			message: "Research the market",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
			atlasMode: true,
			atlasProfile: "in-depth",
			atlasAction: "create",
			pendingSkill: {
				id: "skill-1",
				ownership: "user",
				displayName: "Planning reviewer",
			},
			forceWebSearch: true,
		});

		const [placeholder] =
			messageListEvents.appendAssistantPlaceholder.mock.calls[0];
		expect(placeholder).not.toHaveProperty("userIntent");
	});

	// A regenerate replaces an assistant message whose turn choices the server
	// re-reads from its own record, so the placeholder inherits them rather
	// than dropping the provenance chip for the length of the turn. The caller
	// has already removed that message from the timeline by now, so it hands
	// the record in.
	it("carries the replaced message's userIntent onto a regenerate placeholder", async () => {
		const { adapters, messageListEvents, streamInvocations } = makeAdapters();
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.send(
			{
				message: "Review this plan",
				attachmentIds: [],
				attachments: [],
				pendingAttachments: [],
			},
			{
				skipUserMessage: true,
				skipPersistUserMessage: true,
				retryAssistantMessageId: "assistant-1",
				retryUserMessageId: "user-1",
				retryUserIntent: {
					skill: { id: "skill-1", displayName: "Planning reviewer" },
					webSearch: true,
				},
			},
		);

		expect(messageListEvents.appendAssistantPlaceholder).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "assistant",
				userIntent: {
					skill: { id: "skill-1", displayName: "Planning reviewer" },
					webSearch: true,
				},
			}),
		);
		// The retry request itself still carries no skill/search fields — the
		// server reads them off the message being replaced.
		expect(streamInvocations[0].options).toMatchObject({
			retryAssistantMessageId: "assistant-1",
			retryOrigin: "regenerate",
		});
		expect(streamInvocations[0].options?.pendingSkill ?? null).toBeNull();
		expect(streamInvocations[0].options?.forceWebSearch).toBe(false);
	});

	it("threads the composer's enabledConnectionCapabilities selection to streamChat (Issue 7.2)", async () => {
		const { adapters, streamInvocations } = makeAdapters();
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.send({
			message: "What's on my calendar?",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
			enabledConnectionCapabilities: ["files", "calendar"],
		});

		expect(streamInvocations[0].options).toMatchObject({
			enabledConnectionCapabilities: ["files", "calendar"],
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
				dismissed: false,
				sourceMode: null,
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

	// Item 6 (UX-speed plan) — a produce_file tool call shows a "queued"
	// FileProductionCard the instant it starts, instead of only appearing
	// once the call finishes and the conversation re-hydrates.
	describe("produce_file placeholder (Item 6, UX-speed plan)", () => {
		it("adds a queued placeholder job as soon as a produce_file tool call starts", () => {
			const addFileProductionJobPlaceholder = vi.fn();
			const { adapters, streamInvocations } = makeAdapters({
				addFileProductionJobPlaceholder,
			});
			const runtime = createNormalChatClientTurnRuntime(adapters);

			runtime.send({
				message: "Make a file",
				attachmentIds: [],
				attachments: [],
				pendingAttachments: [],
			});
			streamInvocations[0].callbacks.onToolCall?.(
				"produce_file",
				{ requestTitle: "Quarterly report" },
				"running",
				{ callId: "call-1" },
			);

			expect(addFileProductionJobPlaceholder).toHaveBeenCalledWith({
				id: "pending:call-1",
				conversationId: "conv-1",
				input: { requestTitle: "Quarterly report" },
			});
		});

		it("does not add a second placeholder for a repeated running event on the same call", () => {
			const addFileProductionJobPlaceholder = vi.fn();
			const { adapters, streamInvocations } = makeAdapters({
				addFileProductionJobPlaceholder,
			});
			const runtime = createNormalChatClientTurnRuntime(adapters);

			runtime.send({
				message: "Make a file",
				attachmentIds: [],
				attachments: [],
				pendingAttachments: [],
			});
			streamInvocations[0].callbacks.onToolCall?.(
				"produce_file",
				{ title: "Report" },
				"running",
				{ callId: "call-1" },
			);
			streamInvocations[0].callbacks.onToolCall?.(
				"produce_file",
				{ title: "Report" },
				"running",
				{ callId: "call-1" },
			);

			expect(addFileProductionJobPlaceholder).toHaveBeenCalledTimes(1);
		});

		it("leaves the placeholder for mergeFileProductionJobs to replace once the call finishes", () => {
			const addFileProductionJobPlaceholder = vi.fn();
			const failFileProductionJobPlaceholder = vi.fn();
			const mergeFileProductionJobs = vi.fn();
			const { adapters, streamInvocations } = makeAdapters({
				addFileProductionJobPlaceholder,
				failFileProductionJobPlaceholder,
				mergeFileProductionJobs,
			});
			const runtime = createNormalChatClientTurnRuntime(adapters);

			runtime.send({
				message: "Make a file",
				attachmentIds: [],
				attachments: [],
				pendingAttachments: [],
			});
			streamInvocations[0].callbacks.onToolCall?.(
				"produce_file",
				{ title: "Report" },
				"running",
				{ callId: "call-1" },
			);
			streamInvocations[0].callbacks.onToolCall?.(
				"produce_file",
				{ title: "Report" },
				"done",
				{ callId: "call-1" },
			);

			// A "done" call is not a failure — the placeholder is left alone for
			// the hydration the "done" status already triggers (via
			// shouldHydrateFileProductionJobsOnToolCall) to replace, or for the
			// turn's own metadata.fileProductionJobs to replace via
			// mergeFileProductionJobs.
			expect(failFileProductionJobPlaceholder).not.toHaveBeenCalled();

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
					dismissed: false,
					sourceMode: null,
				},
			];
			streamInvocations[0].callbacks.onEnd("Done", {
				assistantMessageId: "assistant-1",
				fileProductionJobs,
			});

			expect(mergeFileProductionJobs).toHaveBeenCalledWith(fileProductionJobs);
		});

		it("turns the placeholder into a failed job when the tool call itself fails", () => {
			const addFileProductionJobPlaceholder = vi.fn();
			const failFileProductionJobPlaceholder = vi.fn();
			const { adapters, streamInvocations } = makeAdapters({
				addFileProductionJobPlaceholder,
				failFileProductionJobPlaceholder,
			});
			const runtime = createNormalChatClientTurnRuntime(adapters);

			runtime.send({
				message: "Make a file",
				attachmentIds: [],
				attachments: [],
				pendingAttachments: [],
			});
			streamInvocations[0].callbacks.onToolCall?.(
				"produce_file",
				{ title: "Report" },
				"running",
				{ callId: "call-1" },
			);
			streamInvocations[0].callbacks.onToolCall?.(
				"produce_file",
				{ title: "Report" },
				"failed",
				{ callId: "call-1", outputSummary: "Renderer timed out" },
			);

			expect(failFileProductionJobPlaceholder).toHaveBeenCalledWith({
				id: "pending:call-1",
				message: "Renderer timed out",
			});
		});

		it("guards placeholder creation against a stream whose conversation is no longer current", () => {
			let currentConversationId = "conv-A";
			const addFileProductionJobPlaceholder = vi.fn();
			const { adapters, streamInvocations } = makeAdapters({
				getConversationId: vi.fn(() => currentConversationId),
				addFileProductionJobPlaceholder,
			});
			const runtime = createNormalChatClientTurnRuntime(adapters);

			runtime.send({
				message: "Make a file",
				attachmentIds: [],
				attachments: [],
				pendingAttachments: [],
			});
			currentConversationId = "conv-B";
			streamInvocations[0].callbacks.onToolCall?.(
				"produce_file",
				{ title: "Report" },
				"running",
				{ callId: "call-1" },
			);

			expect(addFileProductionJobPlaceholder).not.toHaveBeenCalled();
		});
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

	it("keeps a queued follow-up's card pictures and marks through the queue, the snapshot, the restore and the drain", async () => {
		const marks = {
			imageFileId: "file-1",
			marks: [{ letter: "A" as const, x: 0.1, y: 0.1, w: 0.3, h: 0.3 }],
		};
		const pictureRefs = [{ imageFileId: "file-1", number: 2 }];
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
			pictureRefs,
			imageMarks: marks,
		});
		const queued = runtime.snapshot().queuedTurn;
		expect(queued?.pictureRefs).toEqual(pictureRefs);
		expect(queued?.imageMarks).toEqual(marks);
		// A copy: the person's later edits do not reach the queued turn.
		expect(queued?.pictureRefs).not.toBe(pictureRefs);
		expect(queued?.imageMarks?.marks).not.toBe(marks.marks);

		runtime.editQueuedTurn();
		expect(adapters.restorePayloadToDraft).toHaveBeenCalledWith(
			expect.objectContaining({ pictureRefs, imageMarks: marks }),
		);
		expect(streamInvocations).toHaveLength(1);
	});

	it("keeps the marked item through a queued turn's copy and its restore, and never sends it (T6)", async () => {
		const markedPicture = {
			artifactId: "img-1",
			name: "Cosy room",
			addedRef: true,
			version: 2,
		};
		const { adapters, streamInvocations } = makeAdapters();
		const runtime = createNormalChatClientTurnRuntime(adapters);
		await runtime.send({
			message: "First",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
			markedPicture,
		});
		expect(JSON.stringify(streamInvocations[0]?.options ?? {})).not.toContain(
			"markedPicture",
		);
		runtime.queue({
			message: "Second",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
			markedPicture,
		});
		const queued = runtime.snapshot().queuedTurn;
		expect(queued?.markedPicture).toEqual(markedPicture);
		expect(queued?.markedPicture).not.toBe(markedPicture);
		runtime.editQueuedTurn();
		expect(adapters.restorePayloadToDraft).toHaveBeenCalledWith(
			expect.objectContaining({ markedPicture }),
		);
	});

	it("sends a drained follow-up with its pictures and marks", async () => {
		const marks = {
			imageFileId: "file-1",
			marks: [{ letter: "A" as const, x: 0.1, y: 0.1, w: 0.3, h: 0.3 }],
		};
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
			pictureRefs: [{ imageFileId: "file-1", number: 1 }],
			imageMarks: marks,
		});
		streamInvocations[0].callbacks.onEnd("Done", {
			assistantMessageId: "assistant-1",
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(streamInvocations).toHaveLength(2);
		expect(streamInvocations[1].options).toMatchObject({
			pictureRefs: [{ imageFileId: "file-1", number: 1 }],
			imageMarks: marks,
		});
	});

	it("keeps the first queued follow-up when later queue attempts are rejected", async () => {
		const { adapters, streamInvocations } = makeAdapters();
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.send(
			{
				message: "First",
				attachmentIds: [],
				attachments: [],
				pendingAttachments: [],
			},
			{ clearDraft: true },
		);
		runtime.queue({
			message: "Second",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
			reasoningDepth: "thorough",
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
			reasoningDepth: "thorough",
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
			reasoningDepth: "thorough",
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

		expect(adapters.maybeTriggerTitleGeneration).toHaveBeenCalledTimes(1);
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
			phase: "idle",
			queuedTurn: null,
		});
	});

	// The server ends a turn this way when deleting its chat stopped it
	// (chat-turn/stream-completion.ts): stopped, and no message id, because
	// nothing was saved. It has to end like a turn the person stopped: no error
	// surface, no retry, no reconnect or recovery for a chat that is gone, and a
	// follow-up that was queued goes back to the draft instead of being sent.
	it("ends a stopped turn that carries no message id without an error, a retry or a reconnect", async () => {
		const { adapters, streamInvocations } = makeAdapters();
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.send({
			message: "First",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});
		streamInvocations[0].callbacks.onToken("Partial answer");
		runtime.queue({
			message: "Keep this",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});

		streamInvocations[0].callbacks.onEnd("Partial answer", {
			wasStopped: true,
		});
		await Promise.resolve();

		// The runtime clears the send error when a turn starts (a null); nothing
		// put one up.
		expect(adapters.setSendError).not.toHaveBeenCalledWith(expect.anything());
		expect(adapters.checkForOrphanedStream).not.toHaveBeenCalled();
		expect(adapters.pollForCompletion).not.toHaveBeenCalled();
		expect(adapters.pollMessageEvidence).not.toHaveBeenCalled();
		// Nothing started a second stream: not a retry, not a reconnect, not the
		// queued follow-up.
		expect(streamInvocations).toHaveLength(1);
		expect(adapters.restorePayloadToDraft).toHaveBeenCalledWith(
			expect.objectContaining({ message: "Keep this" }),
		);
		expect(runtime.snapshot()).toMatchObject({
			active: false,
			isSending: false,
			phase: "idle",
			canRetry: false,
			queuedTurn: null,
		});
	});

	it("ignores stop attempts after the finish part so queued follow-ups drain normally", async () => {
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
		});

		streamInvocations[0].callbacks.onToken("Done");
		streamInvocations[0].callbacks.onFinishPart?.({
			type: "finish",
			finishReason: "stop",
		});
		runtime.stop();

		expect(streamInvocations[0].handle.stop).not.toHaveBeenCalled();
		expect(runtime.snapshot()).toMatchObject({
			active: true,
			isSending: true,
			phase: "finalizing",
			queuedTurn: expect.objectContaining({ message: "Second" }),
		});

		streamInvocations[0].callbacks.onEnd("Done", {
			assistantMessageId: "assistant-1",
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(adapters.restorePayloadToDraft).not.toHaveBeenCalled();
		expect(streamInvocations).toHaveLength(2);
		expect(streamInvocations[1].message).toBe("Second");
	});

	it("ignores stop attempts while polling for completion after stream close", async () => {
		const { adapters, streamInvocations } = makeAdapters();
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.send({
			message: "First",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});

		streamInvocations[0].callbacks.onWaiting?.();
		runtime.stop();

		expect(streamInvocations[0].handle.stop).not.toHaveBeenCalled();
		expect(adapters.pollForCompletion).toHaveBeenCalledWith("id-2", "id-1");
		expect(runtime.snapshot()).toMatchObject({
			active: false,
			isSending: true,
			isPollingForCompletion: true,
			phase: "polling",
		});
	});

	it("restores stale pending-skill payloads when the stream reports the skill is unavailable", async () => {
		const { adapters, streamInvocations, messageListEvents } = makeAdapters();
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
		expect(messageListEvents.removeMessage).toHaveBeenCalledWith("id-1");
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
		const { adapters, streamInvocations, messageListEvents } = makeAdapters({
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

		expect(messageListEvents.removeMessage).toHaveBeenCalledWith("id-2");
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
			phase: "idle",
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
		const { adapters, streamInvocations, messages, messageListEvents } =
			makeAdapters({
				getSelectedModel: vi.fn(() => "fallback-model" as ModelId),
				getReasoningDepth: vi.fn((): ReasoningDepth => "quick"),
				getPersonalityProfileId: vi.fn(() => "persona-retry"),
				getActiveDocumentArtifactId: vi.fn(() => "active-doc-retry"),
			});
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.send({
			message: "Regenerate this",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
			reasoningDepth: "thorough",
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

		await runtime.retry();

		expect(messageListEvents.removeMessage).toHaveBeenCalledWith(
			"assistant-old",
		);
		expect(streamInvocations).toHaveLength(2);
		expect(streamInvocations[1]).toMatchObject({
			message: "Regenerate this",
			options: {
				modelId: "model1",
				reasoningDepth: "thorough",
				activeDocumentArtifactId: "active-doc-retry",
				personalityProfileId: "persona-retry",
				retryAssistantMessageId: "assistant-old",
				retryUserMessageId: "id-1",
				retryUserMessage: "Regenerate this",
				// The Retry button after a failed turn is not a verdict on the
				// answer — the server must not count it as a regenerate.
				retryOrigin: "error_retry",
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

	it("carries the last assistant message's userIntent onto a retry() placeholder", async () => {
		const { adapters, streamInvocations, messages, messageListEvents } =
			makeAdapters();
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.send({
			message: "Regenerate this",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});
		streamInvocations[0].callbacks.onError(new Error("Network failed"));

		messages.push({
			id: "assistant-old",
			role: "assistant",
			content: "Bad answer",
			timestamp: 3,
			modelId: "model1",
			userIntent: {
				skill: { id: "skill-1", displayName: "Planning reviewer" },
				webSearch: true,
			},
		});
		messageListEvents.appendAssistantPlaceholder.mockClear();

		await runtime.retry();

		expect(messageListEvents.appendAssistantPlaceholder).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "assistant",
				userIntent: {
					skill: { id: "skill-1", displayName: "Planning reviewer" },
					webSearch: true,
				},
			}),
		);
	});

	// The server keeps nothing of a turn that fails: it saves the reader's message
	// with the reply, at the end. So after a failed turn the page's list ends in a
	// user message the server does not have, and Retry sends that message again and
	// touches nothing above it. (A list that really ends in an assistant message is
	// the older path, which the two tests above hold.)
	describe("Retry when the list ends in the message that failed", () => {
		const earlierTurn = (): ChatMessage[] => [
			{ id: "user-1", role: "user", content: "First question", timestamp: 1 },
			{
				id: "assistant-1",
				role: "assistant",
				content: "First answer",
				timestamp: 2,
				modelId: "model1",
			},
		];
		const box = { letter: "A" as const, x: 0.1, y: 0.1, w: 0.4, h: 0.4 };

		/** Every message the runtime asked the page to take out of the list. */
		function removedIds(
			messageListEvents: ReturnType<typeof makeAdapters>["messageListEvents"],
		) {
			return messageListEvents.removeMessage.mock.calls.map(([id]) => id);
		}

		it("keeps every earlier reply and sends the message again with everything it was sent with", async () => {
			const { adapters, streamInvocations, messages, messageListEvents } =
				makeAdapters({
					// The page's choice now is not the failed send's: the send's own wins.
					getSelectedModel: vi.fn(() => "fallback-model" as ModelId),
					getReasoningDepth: vi.fn((): ReasoningDepth => "thorough"),
					getPersonalityProfileId: vi.fn(() => "page-persona"),
					getActiveDocumentArtifactId: vi.fn(() => "open-image-item"),
					deleteDraft: vi.fn(),
				});
			messages.push(...earlierTurn());
			const runtime = createNormalChatClientTurnRuntime(adapters);

			await runtime.send(
				{
					message: "Second question",
					attachmentIds: ["photo-1"],
					attachments: [],
					pendingAttachments: [],
					pictureRefs: [{ imageFileId: "file-cottage", number: 2 }],
					imageMarks: { imageFileId: "file-cottage", marks: [box] },
					modelId: "model2",
					reasoningDepth: "quick",
					personalityProfileId: "persona-1",
					forceWebSearch: true,
				},
				{ clearDraft: true },
			);
			streamInvocations[0].callbacks.onError(new Error("Network failed"));
			expect(messages.map((message) => message.id)).toEqual([
				"user-1",
				"assistant-1",
				"id-1",
			]);

			await runtime.retry();

			// Nothing above the failed message left the list, and no second bubble.
			expect(removedIds(messageListEvents)).toEqual(["id-2"]);
			expect(messageListEvents.appendUserMessage).toHaveBeenCalledTimes(1);
			expect(messages.map((message) => message.id)).toEqual([
				"user-1",
				"assistant-1",
				"id-1",
				"id-3",
			]);
			// It is the same send again, to the stream and not to the retry route.
			expect(streamInvocations).toHaveLength(2);
			expect(streamInvocations[1].message).toBe("Second question");
			expect(streamInvocations[1].options).toMatchObject({
				modelId: "model2",
				reasoningDepth: "quick",
				personalityProfileId: "persona-1",
				attachmentIds: ["photo-1"],
				pictureRefs: [{ imageFileId: "file-cottage", number: 2 }],
				imageMarks: { imageFileId: "file-cottage", marks: [box] },
				forceWebSearch: true,
				skipPersistUserMessage: false,
				isEditResend: false,
			});
			expect(
				streamInvocations[1].options?.retryAssistantMessageId,
			).toBeUndefined();
			expect(streamInvocations[1].options?.retryUserMessageId).toBeUndefined();
			expect(streamInvocations[1].options?.retryUserMessage).toBeUndefined();
			// Retry clears no draft: the composer's send did that, once, and the
			// person may have typed something new since.
			expect(adapters.clearDraft).toHaveBeenCalledTimes(1);
			expect(adapters.deleteDraft).toHaveBeenCalledTimes(1);
			// ...and the files waiting in the composer are the next message's.
			expect(adapters.clearAttachedArtifacts).toHaveBeenCalledTimes(1);
			expect(runtime.snapshot()).toMatchObject({
				isSending: true,
				active: true,
				canRetry: true,
				lastUserMessage: "Second question",
			});
		});

		it("lets the bubble on screen take the server's id when the retried turn lands", async () => {
			const { adapters, streamInvocations, messageListEvents } = makeAdapters();
			const runtime = createNormalChatClientTurnRuntime(adapters);

			await runtime.send({
				message: "Second question",
				attachmentIds: [],
				attachments: [],
				pendingAttachments: [],
			});
			streamInvocations[0].callbacks.onError(new Error("Network failed"));
			await runtime.retry();

			const metadata: StreamMetadata = {
				assistantMessageId: "assistant-2",
				userMessageId: "user-2",
			};
			streamInvocations[1].callbacks.onEnd("Answer", metadata);

			// The page swaps the bubble's client id for the server's: the pencil and
			// later edits need the server's. It is the bubble the first send drew.
			expect(messageListEvents.appendUserMessage).toHaveBeenCalledTimes(1);
			expect(messageListEvents.finalizeStreamingMessage).toHaveBeenCalledWith({
				placeholderId: "id-3",
				clientUserMessageId: "id-1",
				metadata,
			});
			expect(runtime.snapshot()).toMatchObject({ canRetry: false });
		});

		it("sends the resend of an edit as an edit's resend again", async () => {
			const { adapters, streamInvocations, messages, messageListEvents } =
				makeAdapters();
			messages.push(...earlierTurn());
			const runtime = createNormalChatClientTurnRuntime(adapters);

			await runtime.send({
				message: "Edited question",
				attachmentIds: ["photo-1"],
				attachments: [],
				pendingAttachments: [],
				pictureRefs: [{ imageFileId: "file-cottage", number: 1 }],
				isEditResend: true,
			});
			streamInvocations[0].callbacks.onError(new Error("Network failed"));
			await runtime.retry();

			expect(removedIds(messageListEvents)).toEqual(["id-2"]);
			// A picture gone since is dropped by the server, not refused, as for the
			// first try: the edited message is not on the server to go back to.
			expect(streamInvocations[1].options).toMatchObject({
				isEditResend: true,
				attachmentIds: ["photo-1"],
				pictureRefs: [{ imageFileId: "file-cottage", number: 1 }],
			});
			expect(
				streamInvocations[1].options?.retryAssistantMessageId,
			).toBeUndefined();
		});

		it("aims a failed regenerate's Retry at the reply it was regenerating, not at the turn before", async () => {
			const { adapters, streamInvocations, messages, messageListEvents } =
				makeAdapters();
			// What the page shows after the regenerate cut the reply from the list.
			messages.push(...earlierTurn(), {
				id: "user-2",
				role: "user",
				content: "Second question",
				timestamp: 3,
			});
			const runtime = createNormalChatClientTurnRuntime(adapters);

			await runtime.send(
				{
					message: "Second question",
					attachmentIds: ["photo-1"],
					attachments: [],
					pendingAttachments: [],
					reasoningDepth: "quick",
				},
				{
					skipUserMessage: true,
					skipPersistUserMessage: true,
					retryAssistantMessageId: "assistant-2",
					retryUserMessageId: "user-2",
					retryOrigin: "answer_now",
				},
			);
			streamInvocations[0].callbacks.onError(new Error("Network failed"));
			await runtime.retry();

			expect(removedIds(messageListEvents)).toEqual(["id-1"]);
			expect(messages.map((message) => message.id)).toEqual([
				"user-1",
				"assistant-1",
				"user-2",
				"id-2",
			]);
			expect(streamInvocations[1].message).toBe("Second question");
			expect(streamInvocations[1].options).toMatchObject({
				retryAssistantMessageId: "assistant-2",
				retryUserMessageId: "user-2",
				retryUserMessage: "Second question",
				// The Retry button is a verdict on the failure, not on the answer,
				// whichever button started the regenerate.
				retryOrigin: "error_retry",
				reasoningDepth: "quick",
				attachmentIds: ["photo-1"],
			});
			// The message it regenerates for is on screen already and stays one.
			expect(messageListEvents.appendUserMessage).not.toHaveBeenCalled();
		});

		it("says the skill and the web search of the turn in a regenerate's request, and in its Retry's", async () => {
			const { adapters, streamInvocations, messages } = makeAdapters();
			messages.push(...earlierTurn(), {
				id: "user-2",
				role: "user",
				content: "Second question",
				timestamp: 3,
			});
			const runtime = createNormalChatClientTurnRuntime(adapters);
			const intent = {
				skill: { id: "skill-1", displayName: "Planning reviewer" },
				webSearch: true as const,
			};

			await runtime.send(
				{
					message: "Second question",
					attachmentIds: [],
					attachments: [],
					pendingAttachments: [],
				},
				{
					skipUserMessage: true,
					skipPersistUserMessage: true,
					retryAssistantMessageId: "assistant-2",
					retryUserMessageId: "user-2",
					retryUserIntent: intent,
				},
			);
			streamInvocations[0].callbacks.onError(new Error("Network failed"));
			await runtime.retry();

			// The reply a regenerate replaces carries the record; once it is gone the
			// server has only this to know what the person chose.
			expect(streamInvocations[0].options?.retryUserIntent).toEqual(intent);
			expect(streamInvocations[1].options?.retryUserIntent).toEqual(intent);
		});

		it("leaves the intent out of a request that is not a regenerate", async () => {
			const { adapters, streamInvocations } = makeAdapters();
			const runtime = createNormalChatClientTurnRuntime(adapters);

			await runtime.send({
				message: "Second question",
				attachmentIds: [],
				attachments: [],
				pendingAttachments: [],
				forceWebSearch: true,
			});

			expect(streamInvocations[0].options?.retryUserIntent).toBeUndefined();
		});

		it("sends only the text for a turn that failed after a reload, and touches no earlier reply", async () => {
			const { adapters, streamInvocations, messages, messageListEvents } =
				makeAdapters({
					loadPersistedData: vi.fn(async () => {
						messages.length = 0;
						messages.push(...earlierTurn());
					}),
				});
			const runtime = createNormalChatClientTurnRuntime(adapters);

			// An earlier send in this very page, with a file, must not be mistaken for
			// this message's payload: the runtime holds no payload for a reconnected turn.
			await runtime.send({
				message: "Question with a file",
				attachmentIds: ["old-file"],
				attachments: [],
				pendingAttachments: [],
				modelId: "model2",
			});
			streamInvocations[0].callbacks.onEnd("Done", {
				assistantMessageId: "assistant-9",
				userMessageId: "user-9",
			});
			await runtime.reconnectToOrphanedStream("stream-1", "Resume me");
			streamInvocations[1].callbacks.onError(new Error("The model refused."));
			await vi.waitFor(() => expect(runtime.snapshot().canRetry).toBe(true));
			expect(messages.map((message) => message.content)).toEqual([
				"First question",
				"First answer",
				"Resume me",
			]);
			messageListEvents.removeMessage.mockClear();

			await runtime.retry();

			expect(removedIds(messageListEvents)).toEqual([]);
			expect(streamInvocations).toHaveLength(3);
			expect(streamInvocations[2].message).toBe("Resume me");
			expect(
				streamInvocations[2].options?.retryAssistantMessageId,
			).toBeUndefined();
			expect(streamInvocations[2].options?.attachmentIds ?? []).toEqual([]);
			expect(streamInvocations[2].options?.reconnectToStreamId).toBeUndefined();
			expect(streamInvocations[2].options?.modelId).toBe("model1");
		});

		it("keeps the message's files and pictures when a dropped connection on this page is followed by a reconnect that fails", async () => {
			const { adapters, streamInvocations, messages, messageListEvents } =
				makeAdapters({
					// The turn is still running on the server when the page looks for it.
					checkForOrphanedStream: vi.fn(async () => "stream-1"),
					getStreamBufferInfo: vi.fn(async () => ({
						exists: true,
						userMessage: "Second question",
					})),
					// What the server holds once the turn has failed: nothing of it.
					loadPersistedData: vi.fn(async () => {
						messages.length = 0;
						messages.push(...earlierTurn());
					}),
				});
			messages.push(...earlierTurn());
			const runtime = createNormalChatClientTurnRuntime(adapters);

			await runtime.send({
				message: "Second question",
				attachmentIds: ["photo-1"],
				attachments: [],
				pendingAttachments: [],
				pictureRefs: [{ imageFileId: "file-cottage", number: 2 }],
				imageMarks: { imageFileId: "file-cottage", marks: [box] },
				modelId: "model2",
				reasoningDepth: "quick",
			});
			// Words had come when the connection dropped: the page reconnects to the
			// turn the server is still running, and that turn then fails.
			streamInvocations[0].callbacks.onToken("The lake");
			streamInvocations[0].callbacks.onError(new Error("Network failed"));
			await vi.waitFor(() => expect(streamInvocations).toHaveLength(2));
			expect(streamInvocations[1].options?.reconnectToStreamId).toBe(
				"stream-1",
			);
			streamInvocations[1].callbacks.onError(new Error("The model refused."));
			// Retry was possible all along, so it is the error that says the page is done.
			await vi.waitFor(() =>
				expect(adapters.setSendError).toHaveBeenCalledWith(
					"The model refused.",
				),
			);
			expect(messages.map((message) => message.content)).toEqual([
				"First question",
				"First answer",
				"Second question",
			]);
			messageListEvents.removeMessage.mockClear();
			// The turn has failed, so the server runs nothing for the chat now.
			vi.mocked(adapters.checkForOrphanedStream).mockResolvedValue(null);

			await runtime.retry();

			// The message the page itself sent, so it goes again as it went: with its
			// files, its pictures and its choices.
			expect(removedIds(messageListEvents)).toEqual([]);
			expect(streamInvocations).toHaveLength(3);
			expect(streamInvocations[2].message).toBe("Second question");
			expect(streamInvocations[2].options).toMatchObject({
				modelId: "model2",
				reasoningDepth: "quick",
				attachmentIds: ["photo-1"],
				pictureRefs: [{ imageFileId: "file-cottage", number: 2 }],
				imageMarks: { imageFileId: "file-cottage", marks: [box] },
			});
			expect(
				streamInvocations[2].options?.retryAssistantMessageId,
			).toBeUndefined();
			expect(streamInvocations[2].options?.reconnectToStreamId).toBeUndefined();
		});

		it("forgets the send when the reconnect that fails is for another message", async () => {
			const { adapters, streamInvocations, messages } = makeAdapters({
				loadPersistedData: vi.fn(async () => {
					messages.length = 0;
					messages.push(...earlierTurn());
				}),
			});
			messages.push(...earlierTurn());
			const runtime = createNormalChatClientTurnRuntime(adapters);

			await runtime.send({
				message: "Second question",
				attachmentIds: ["photo-1"],
				attachments: [],
				pendingAttachments: [],
				modelId: "model2",
			});
			streamInvocations[0].callbacks.onError(new Error("Network failed"));
			// A turn of another tab, say, that this page reconnects to and that fails.
			await runtime.reconnectToOrphanedStream("stream-9", "Another message");
			streamInvocations[1].callbacks.onError(new Error("The model refused."));
			await vi.waitFor(() =>
				expect(messages.at(-1)?.content).toBe("Another message"),
			);

			await runtime.retry();

			expect(streamInvocations[2].message).toBe("Another message");
			expect(streamInvocations[2].options?.attachmentIds ?? []).toEqual([]);
			expect(streamInvocations[2].options?.modelId).toBe("model1");
		});

		it("does the same on a second failure and a second press as on the first", async () => {
			const { adapters, streamInvocations, messages, messageListEvents } =
				makeAdapters({ deleteDraft: vi.fn() });
			messages.push(...earlierTurn());
			const runtime = createNormalChatClientTurnRuntime(adapters);

			await runtime.send(
				{
					message: "Second question",
					attachmentIds: ["photo-1"],
					attachments: [],
					pendingAttachments: [],
					modelId: "model2",
				},
				{ clearDraft: true },
			);
			streamInvocations[0].callbacks.onError(new Error("Network failed"));
			await runtime.retry();
			streamInvocations[1].callbacks.onError(new Error("Network failed again"));
			expect(runtime.snapshot().canRetry).toBe(true);
			await runtime.retry();

			expect(streamInvocations).toHaveLength(3);
			expect(streamInvocations[2].message).toBe("Second question");
			expect(streamInvocations[2].options).toMatchObject({
				modelId: "model2",
				attachmentIds: ["photo-1"],
			});
			expect(
				streamInvocations[2].options?.retryAssistantMessageId,
			).toBeUndefined();
			// Only the placeholders came out: one per try that failed.
			expect(removedIds(messageListEvents)).toEqual(["id-2", "id-3"]);
			expect(messageListEvents.appendUserMessage).toHaveBeenCalledTimes(1);
			expect(adapters.clearDraft).toHaveBeenCalledTimes(1);
			expect(adapters.deleteDraft).toHaveBeenCalledTimes(1);
			expect(messages.map((message) => message.id)).toEqual([
				"user-1",
				"assistant-1",
				"id-1",
				"id-4",
			]);
		});

		it("forgets what it remembered when the chat changes, so a Retry never replays a message into another chat", async () => {
			let conversationId = "conv-1";
			const { adapters, streamInvocations, messages } = makeAdapters({
				getConversationId: vi.fn(() => conversationId),
			});
			const runtime = createNormalChatClientTurnRuntime(adapters);

			await runtime.send({
				message: "Second question",
				attachmentIds: ["photo-1"],
				attachments: [],
				pendingAttachments: [],
			});
			streamInvocations[0].callbacks.onError(new Error("Network failed"));

			// The page moved to another chat without resetting the runtime (it does
			// reset it on a switch): the message is still not sent into it.
			conversationId = "conv-2";
			messages.length = 0;
			messages.push({
				id: "other-user",
				role: "user",
				content: "Second question",
				timestamp: 1,
			});
			await runtime.retry();
			expect(streamInvocations).toHaveLength(1);

			// And a reset, which the page does on every switch, ends it for good.
			conversationId = "conv-1";
			runtime.reset();
			await runtime.retry();
			expect(streamInvocations).toHaveLength(1);
			expect(runtime.snapshot()).toMatchObject({
				canRetry: false,
				lastUserMessage: "",
			});
		});

		it("still regenerates the last reply when the list really ends in an assistant message", async () => {
			const { adapters, streamInvocations, messages, messageListEvents } =
				makeAdapters();
			const runtime = createNormalChatClientTurnRuntime(adapters);

			await runtime.send({
				message: "Regenerate this",
				attachmentIds: ["photo-1"],
				attachments: [],
				pendingAttachments: [],
			});
			streamInvocations[0].callbacks.onError(new Error("Network failed"));
			// The server did keep the turn, and the page read it back.
			messages.length = 0;
			messages.push(
				{
					id: "user-saved",
					role: "user",
					content: "Regenerate this",
					timestamp: 1,
				},
				{
					id: "assistant-saved",
					role: "assistant",
					content: "A",
					timestamp: 2,
				},
			);

			await runtime.retry();

			expect(removedIds(messageListEvents)).toContain("assistant-saved");
			expect(streamInvocations[1].options).toMatchObject({
				retryAssistantMessageId: "assistant-saved",
				retryUserMessageId: "user-saved",
				retryUserMessage: "Regenerate this",
				retryOrigin: "error_retry",
			});
		});

		const askedWords = "Second question";
		const serverUser = (id = "user-2", text = askedWords): ChatMessage => ({
			id,
			role: "user",
			content: text,
			timestamp: 5,
		});
		const serverReply = (id = "assistant-2"): ChatMessage => ({
			id,
			role: "assistant",
			content: "Done",
			timestamp: 6,
		});

		/** Words sent from the composer to a server that is reachable, with the first try failed. */
		async function failedSend(
			overrides: Parameters<typeof makeAdapters>[0] = {},
		) {
			const made = makeAdapters(overrides);
			made.messages.push(...earlierTurn());
			const runtime = createNormalChatClientTurnRuntime(made.adapters);
			await runtime.send({
				message: askedWords,
				attachmentIds: ["photo-1"],
				attachments: [],
				pendingAttachments: [],
			});
			made.streamInvocations[0].callbacks.onError(new Error("Network failed"));
			return { ...made, runtime };
		}

		// A dropped connection never reads the chat, and the server keeps running the
		// turn: it can save the message and its reply while the page shows an error and
		// a Retry. The page asks the server before it believes the message failed.
		describe("a turn the server finished", () => {
			it("is not sent again: Retry loads the chat the server holds, clears the error and sends nothing", async () => {
				const readChatMessages = vi.fn(async () => [
					...earlierTurn(),
					serverUser(),
					serverReply(),
				]);
				const { adapters, streamInvocations, runtime } = await failedSend({
					readChatMessages,
				});
				vi.mocked(adapters.setSendError).mockClear();

				await runtime.retry();

				expect(readChatMessages).toHaveBeenCalledTimes(1);
				expect(adapters.loadPersistedData).toHaveBeenCalledTimes(1);
				expect(streamInvocations).toHaveLength(1);
				expect(adapters.setSendError).toHaveBeenCalledWith(null);
				expect(runtime.snapshot()).toMatchObject({
					canRetry: false,
					isSending: false,
					active: false,
				});
			});

			it("is found by the words trimmed, and by a reply the page does not hold", async () => {
				const { adapters, streamInvocations, runtime } = await failedSend({
					readChatMessages: vi.fn(async () => [
						...earlierTurn(),
						serverUser("user-2", `  ${askedWords}\n`),
						serverReply(),
					]),
				});

				await runtime.retry();

				expect(adapters.loadPersistedData).toHaveBeenCalledTimes(1);
				expect(streamInvocations).toHaveLength(1);
			});

			it("is not mistaken for an earlier turn with the same words: the ids tell them apart", async () => {
				const earlier: ChatMessage[] = [
					{ id: "q-old", role: "user", content: askedWords, timestamp: 1 },
					{ id: "a-old", role: "assistant", content: "Old", timestamp: 2 },
				];
				const made = makeAdapters({
					// The chat as the server has it: the earlier turn, which the page holds.
					readChatMessages: vi.fn(async () => earlier),
				});
				made.messages.push(...earlier);
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await runtime.send({
					message: askedWords,
					attachmentIds: [],
					attachments: [],
					pendingAttachments: [],
				});
				made.streamInvocations[0].callbacks.onError(
					new Error("Network failed"),
				);

				await runtime.retry();

				expect(made.adapters.loadPersistedData).not.toHaveBeenCalled();
				expect(made.streamInvocations).toHaveLength(2);
				expect(made.streamInvocations[1].message).toBe(askedWords);
			});

			it("goes on as it does today when the chat cannot be read", async () => {
				for (const readChatMessages of [
					vi.fn(async () => null),
					vi.fn(async () => {
						throw new Error("Network down");
					}),
				]) {
					const { adapters, streamInvocations, runtime } = await failedSend({
						readChatMessages,
					});

					await runtime.retry();

					expect(readChatMessages).toHaveBeenCalledTimes(1);
					expect(adapters.loadPersistedData).not.toHaveBeenCalled();
					expect(streamInvocations).toHaveLength(2);
					expect(streamInvocations[1].options?.attachmentIds).toEqual([
						"photo-1",
					]);
				}
			});

			// A regenerate that fails before the server deleted the reply (the network):
			// the page took the reply off its list, so the reply the server still has
			// reads as new, and the turn before it as the same words again.
			it("is not found in the reply a regenerate was replacing, and Retry replays the regenerate", async () => {
				const made = makeAdapters({
					readChatMessages: vi.fn(async () => earlierTurn()),
				});
				// The page's list after the regenerate took the reply off it.
				made.messages.push(earlierTurn()[0]);
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await runtime.send(
					{
						message: "First question",
						attachmentIds: [],
						attachments: [],
						pendingAttachments: [],
					},
					{
						skipUserMessage: true,
						skipPersistUserMessage: true,
						retryAssistantMessageId: "assistant-1",
						retryUserMessageId: "user-1",
					},
				);
				made.streamInvocations[0].callbacks.onError(
					new Error("Network failed"),
				);

				await runtime.retry();

				expect(made.adapters.loadPersistedData).not.toHaveBeenCalled();
				expect(made.streamInvocations).toHaveLength(2);
				expect(made.streamInvocations[1].options).toMatchObject({
					retryAssistantMessageId: "assistant-1",
					retryUserMessageId: "user-1",
					retryOrigin: "error_retry",
				});
				expect(runtime.snapshot().canRetry).toBe(true);
			});

			it("goes on as it does today when the server does not hold the turn", async () => {
				const { adapters, streamInvocations, runtime } = await failedSend({
					readChatMessages: vi.fn(async () => earlierTurn()),
				});

				await runtime.retry();

				expect(adapters.loadPersistedData).not.toHaveBeenCalled();
				expect(streamInvocations).toHaveLength(2);
				expect(
					streamInvocations[1].options?.retryAssistantMessageId,
				).toBeUndefined();
			});

			it("sends a message the server holds without a reply through the retry route, never as a plain send that would save it twice", async () => {
				const { streamInvocations, messageListEvents, runtime } =
					await failedSend({
						readChatMessages: vi.fn(async () => [
							...earlierTurn(),
							serverUser(),
						]),
					});

				await runtime.retry();

				expect(streamInvocations).toHaveLength(2);
				const placeholder =
					messageListEvents.appendAssistantPlaceholder.mock.calls.at(-1)?.[0];
				expect(streamInvocations[1].message).toBe(askedWords);
				expect(streamInvocations[1].options).toMatchObject({
					// The reply is not there: its id is the new placeholder's, an id the
					// chat holds no reply under.
					retryAssistantMessageId: placeholder?.id,
					retryUserMessageId: "user-2",
					retryUserMessage: askedWords,
					retryOrigin: "error_retry",
					// What the person sent it with goes along; the server rebuilds the rest.
					attachmentIds: ["photo-1"],
				});
			});

			it("does the same for a turn that failed after a reload, which holds no payload: the files come back from the record", async () => {
				const { adapters, streamInvocations, messages, messageListEvents } =
					makeAdapters({
						loadPersistedData: vi.fn(async () => {
							messages.length = 0;
							messages.push(
								...earlierTurn(),
								serverUser("user-2", "Resume me"),
							);
						}),
						readChatMessages: vi.fn(async () => [
							...earlierTurn(),
							serverUser("user-2", "Resume me"),
						]),
					});
				const runtime = createNormalChatClientTurnRuntime(adapters);

				await runtime.reconnectToOrphanedStream("stream-1", "Resume me");
				streamInvocations[0].callbacks.onError(new Error("The model refused."));
				await vi.waitFor(() => expect(runtime.snapshot().canRetry).toBe(true));
				// The chat as the server has it: the message ends it, and no copy is added.
				expect(messages.map((message) => message.id)).toEqual([
					"user-1",
					"assistant-1",
					"user-2",
				]);

				await runtime.retry();

				const placeholder =
					messageListEvents.appendAssistantPlaceholder.mock.calls.at(-1)?.[0];
				expect(streamInvocations).toHaveLength(2);
				expect(streamInvocations[1].options).toMatchObject({
					retryAssistantMessageId: placeholder?.id,
					retryUserMessageId: "user-2",
					retryUserMessage: "Resume me",
					retryOrigin: "error_retry",
				});
				expect(streamInvocations[1].options?.attachmentIds ?? []).toEqual([]);
				// The bubble the reconnect drew; the retry adds none.
				expect(messageListEvents.appendUserMessage).toHaveBeenCalledTimes(1);
			});

			it("leaves a failed regenerate to the retry it remembers", async () => {
				const made = makeAdapters({
					readChatMessages: vi.fn(async () => [
						...earlierTurn(),
						serverUser("user-2"),
					]),
				});
				made.messages.push(...earlierTurn(), {
					...serverUser("user-2"),
					timestamp: 3,
				});
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await runtime.send(
					{
						message: askedWords,
						attachmentIds: [],
						attachments: [],
						pendingAttachments: [],
					},
					{
						skipUserMessage: true,
						skipPersistUserMessage: true,
						retryAssistantMessageId: "assistant-2",
						retryUserMessageId: "user-2",
					},
				);
				made.streamInvocations[0].callbacks.onError(
					new Error("Network failed"),
				);

				await runtime.retry();

				expect(made.streamInvocations[1].options).toMatchObject({
					retryAssistantMessageId: "assistant-2",
					retryUserMessageId: "user-2",
					retryOrigin: "error_retry",
				});
			});

			it("shows no error and no Retry when a dropped connection is followed by a turn the server finished", async () => {
				const readChatMessages = vi.fn(async () => [
					...earlierTurn(),
					serverUser(),
					serverReply(),
				]);
				const { adapters, streamInvocations, messages, messageListEvents } =
					makeAdapters({ readChatMessages });
				messages.push(...earlierTurn());
				const runtime = createNormalChatClientTurnRuntime(adapters);
				await runtime.send({
					message: askedWords,
					attachmentIds: [],
					attachments: [],
					pendingAttachments: [],
				});
				// Words had come when the connection dropped, and the server has no stream
				// left to reconnect to: it finished.
				streamInvocations[0].callbacks.onToken("The lake");
				streamInvocations[0].callbacks.onError(new Error("Network failed"));
				await vi.waitFor(() =>
					expect(adapters.loadPersistedData).toHaveBeenCalledTimes(1),
				);

				expect(readChatMessages).toHaveBeenCalledTimes(1);
				expect(
					vi
						.mocked(adapters.setSendError)
						.mock.calls.filter(([message]) => message !== null),
				).toEqual([]);
				expect(runtime.snapshot()).toMatchObject({
					canRetry: false,
					isSending: false,
				});
				expect(removedIds(messageListEvents)).toContain("id-2");
				expect(streamInvocations).toHaveLength(1);
			});

			it("still shows the error and the Retry when the server does not hold the turn after all", async () => {
				const { adapters, streamInvocations, messages } = makeAdapters({
					readChatMessages: vi.fn(async () => earlierTurn()),
				});
				messages.push(...earlierTurn());
				const runtime = createNormalChatClientTurnRuntime(adapters);
				await runtime.send({
					message: askedWords,
					attachmentIds: [],
					attachments: [],
					pendingAttachments: [],
				});
				streamInvocations[0].callbacks.onToken("The lake");
				streamInvocations[0].callbacks.onError(new Error("Network failed"));
				await vi.waitFor(() =>
					expect(adapters.setSendError).toHaveBeenCalledWith("Network failed"),
				);

				expect(runtime.snapshot().canRetry).toBe(true);
				expect(adapters.loadPersistedData).not.toHaveBeenCalled();
			});

			it("adds no ghost message and no error when the reconnect that failed had finished on the server", async () => {
				const { adapters, streamInvocations, messages } = makeAdapters({
					loadPersistedData: vi.fn(async () => {
						messages.length = 0;
						messages.push(
							...earlierTurn(),
							serverUser("user-9", "Resume me"),
							serverReply("assistant-9"),
						);
					}),
				});
				messages.push(...earlierTurn());
				const runtime = createNormalChatClientTurnRuntime(adapters);

				await runtime.reconnectToOrphanedStream("stream-1", "Resume me");
				streamInvocations[0].callbacks.onError(
					new Error("Stream closed before a terminal completion event"),
				);
				await vi.waitFor(() =>
					expect(adapters.loadPersistedData).toHaveBeenCalledTimes(1),
				);
				await new Promise((resolve) => setTimeout(resolve, 0));

				expect(messages.map((message) => message.id)).toEqual([
					"user-1",
					"assistant-1",
					"user-9",
					"assistant-9",
				]);
				expect(
					vi
						.mocked(adapters.setSendError)
						.mock.calls.filter(([message]) => message !== null),
				).toEqual([]);
				expect(runtime.snapshot()).toMatchObject({
					canRetry: false,
					isSending: false,
				});
			});

			it("does not run twice when Retry is pressed twice, and does not mistake the first press's reply for one", async () => {
				const { streamInvocations, messageListEvents, runtime } =
					await failedSend();

				const first = runtime.retry();
				const second = runtime.retry();
				await Promise.all([first, second]);

				expect(streamInvocations).toHaveLength(2);
				// Only the first try's placeholder was ever removed.
				expect(removedIds(messageListEvents)).toEqual(["id-2"]);
			});

			/**
			 * A read of the chat that answers when the test says so. The chat is read after
			 * the stream question, so `answer` waits until the read has been asked.
			 */
			function aChatReadThatWaits() {
				let resolveIt: (messages: ChatMessage[] | null) => void = () => {};
				let answered = 0;
				const readChatMessages = vi.fn(
					() =>
						new Promise<ChatMessage[] | null>((resolve) => {
							resolveIt = resolve;
						}),
				);
				async function answer(messages: ChatMessage[] | null) {
					await vi.waitFor(() =>
						expect(readChatMessages.mock.calls.length).toBeGreaterThan(
							answered,
						),
					);
					answered += 1;
					resolveIt(messages);
				}
				return { readChatMessages, answer };
			}

			it("does not run twice either while the chat is being read", async () => {
				const { readChatMessages, answer } = aChatReadThatWaits();
				const { streamInvocations, runtime } = await failedSend({
					readChatMessages,
				});

				const first = runtime.retry();
				const second = runtime.retry();
				await answer(null);
				await Promise.all([first, second]);

				expect(readChatMessages).toHaveBeenCalledTimes(1);
				expect(streamInvocations).toHaveLength(2);
			});

			// The read can take seconds and the page stays live: a pencil pressed meanwhile
			// opens an edit, and the Retry that lands after it would send the old words,
			// give the failed bubble the server's id (so the edit's submit finds no message
			// and closes with what was typed), or load a chat that no longer holds it.
			describe("when an edit is opened while the page asks", () => {
				async function pressedWithAnEditOpenedMeanwhile(
					overrides: Parameters<typeof makeAdapters>[0],
					answerWith: ChatMessage[] | null,
				) {
					let editOpen = false;
					const state = await failedSend({
						isEditOpen: vi.fn(() => editOpen),
						readChatMessages: vi.fn(async () => answerWith),
						...overrides,
					});
					const pressed = state.runtime.retry();
					// Opened before any answer to the page's questions has come back.
					editOpen = true;
					await pressed;
					return {
						...state,
						closeTheEdit: () => {
							editOpen = false;
						},
					};
				}

				it("sends nothing, and the message can still be retried once the edit is over", async () => {
					const { streamInvocations, runtime, closeTheEdit } =
						await pressedWithAnEditOpenedMeanwhile({}, null);

					expect(streamInvocations).toHaveLength(1);
					expect(runtime.snapshot().canRetry).toBe(true);

					closeTheEdit();
					await runtime.retry();
					expect(streamInvocations).toHaveLength(2);
				});

				it("loads nothing when the server turned out to have the turn", async () => {
					const { adapters, streamInvocations } =
						await pressedWithAnEditOpenedMeanwhile({}, [
							...earlierTurn(),
							serverUser(),
							serverReply(),
						]);

					expect(adapters.loadPersistedData).not.toHaveBeenCalled();
					expect(streamInvocations).toHaveLength(1);
				});

				it("joins nothing when the server turned out to be running the turn", async () => {
					const { streamInvocations } = await pressedWithAnEditOpenedMeanwhile(
						{
							checkForOrphanedStream: vi.fn(async () => "stream-1"),
						},
						null,
					);

					expect(streamInvocations).toHaveLength(1);
				});

				it("does not ask at all while an edit is open", async () => {
					const readChatMessages = vi.fn(async () => null);
					const { streamInvocations, runtime } = await failedSend({
						isEditOpen: vi.fn(() => true),
						readChatMessages,
					});

					await runtime.retry();

					expect(readChatMessages).not.toHaveBeenCalled();
					expect(streamInvocations).toHaveLength(1);
				});
			});

			it("sends nothing when a turn has started, or the chat has changed, while the chat was being read", async () => {
				let conversationId = "conv-1";
				const { readChatMessages, answer } = aChatReadThatWaits();
				const { streamInvocations, runtime } = await failedSend({
					readChatMessages,
					getConversationId: vi.fn(() => conversationId),
				});

				// A new message goes while the read is out.
				const first = runtime.retry();
				void runtime.send({
					message: "Something else",
					attachmentIds: [],
					attachments: [],
					pendingAttachments: [],
				});
				await answer(null);
				await first;
				expect(streamInvocations).toHaveLength(2);
				expect(streamInvocations[1].message).toBe("Something else");

				// The chat changes while the read is out.
				streamInvocations[1].callbacks.onError(new Error("Network failed"));
				const second = runtime.retry();
				conversationId = "conv-2";
				await answer(null);
				await second;
				expect(streamInvocations).toHaveLength(2);
			});
		});

		// The server saves a turn's message at its end, so while it still runs a turn
		// whose connection dropped, the chat does not hold the message. A resend then is
		// turned away for the person's one reply at a time and tried again by the backoff
		// for 3.5 seconds without asking: a turn that ends in that window ran twice.
		// Retry asks whether a stream is running for the chat first, and joins it. The
		// stream is asked before the chat: the server saves a turn's message before it
		// unregisters its stream, so a turn that ends between the two questions is
		// answered by the second, where asked the other way round it got two noes.
		describe("a turn the server is still running", () => {
			/** A clock that never runs out: the stream questions are bounded on `schedule`, which the adapters' default fires at once. */
			const patientClock = () =>
				vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>);
			const runningTurn = () => ({
				schedule: patientClock(),
				checkForOrphanedStream: vi.fn(async () => "stream-1"),
				getStreamBufferInfo: vi.fn(async () => ({
					exists: true,
					userMessage: askedWords,
					reasoningDepth: "quick" as ReasoningDepth,
					createdAt: Date.now() - 2000,
				})),
			});

			it("is joined, not sent again: Retry reconnects to its stream and sends nothing", async () => {
				const running = runningTurn();
				const readChatMessages = vi.fn(async () => earlierTurn());
				const { adapters, streamInvocations, messages, runtime } =
					await failedSend({ ...running, readChatMessages });
				vi.mocked(adapters.setSendError).mockClear();

				await runtime.retry();

				expect(running.checkForOrphanedStream).toHaveBeenCalledWith("conv-1");
				// The stream says the turn is going; the chat is not read for it.
				expect(readChatMessages).not.toHaveBeenCalled();
				expect(streamInvocations).toHaveLength(2);
				expect(streamInvocations[1].options).toMatchObject({
					reconnectToStreamId: "stream-1",
					reconnectUserMessage: askedWords,
					reasoningDepth: "quick",
				});
				expect(
					streamInvocations[1].options?.retryAssistantMessageId,
				).toBeUndefined();
				// The bubble on screen is the message, once, and the error is gone.
				expect(
					messages.filter(
						(message) =>
							message.role === "user" && message.content === askedWords,
					),
				).toHaveLength(1);
				expect(adapters.setSendError).toHaveBeenCalledWith(null);
				expect(runtime.snapshot().isSending).toBe(true);
			});

			it("asks the stream first and the chat after, so a turn that ends between the two is not missed by both", async () => {
				// The turn ends right after the first question, whichever it is.
				let ended = false;
				const asked: string[] = [];
				const { streamInvocations, runtime } = await failedSend({
					schedule: patientClock(),
					checkForOrphanedStream: vi.fn(async () => {
						asked.push("stream");
						const answer = ended ? null : "stream-1";
						ended = true;
						return answer;
					}),
					getStreamBufferInfo: vi.fn(async () => ({
						exists: true,
						userMessage: askedWords,
					})),
					readChatMessages: vi.fn(async () => {
						asked.push("chat");
						const answer = ended
							? [...earlierTurn(), serverUser(), serverReply()]
							: earlierTurn();
						ended = true;
						return answer;
					}),
				});

				await runtime.retry();

				// Joined while it ran, not sent again after it had ended.
				expect(asked[0]).toBe("stream");
				expect(streamInvocations).toHaveLength(2);
				expect(streamInvocations[1].options?.reconnectToStreamId).toBe(
					"stream-1",
				);
			});

			it("reads the chat when no stream is running, and loads the turn it holds", async () => {
				const asked: string[] = [];
				const { adapters, streamInvocations, runtime } = await failedSend({
					checkForOrphanedStream: vi.fn(async () => {
						asked.push("stream");
						return null;
					}),
					readChatMessages: vi.fn(async () => {
						asked.push("chat");
						return [...earlierTurn(), serverUser(), serverReply()];
					}),
				});

				await runtime.retry();

				expect(asked).toEqual(["stream", "chat"]);
				expect(adapters.loadPersistedData).toHaveBeenCalledTimes(1);
				expect(streamInvocations).toHaveLength(1);
			});

			it("sends the message as before when no stream is running", async () => {
				const { adapters, streamInvocations, runtime } = await failedSend({
					checkForOrphanedStream: vi.fn(async () => null),
					readChatMessages: vi.fn(async () => earlierTurn()),
				});

				await runtime.retry();

				expect(adapters.getStreamBufferInfo).not.toHaveBeenCalled();
				expect(streamInvocations).toHaveLength(2);
				expect(streamInvocations[1].message).toBe(askedWords);
				expect(
					streamInvocations[1].options?.reconnectToStreamId,
				).toBeUndefined();
			});

			it("is asked once for two presses while the question is out", async () => {
				let found: (streamId: string | null) => void = () => {};
				const running = {
					schedule: patientClock(),
					checkForOrphanedStream: vi.fn(
						() =>
							new Promise<string | null>((resolve) => {
								found = resolve;
							}),
					),
					getStreamBufferInfo: vi.fn(async () => null),
				};
				const { streamInvocations, runtime } = await failedSend(running);

				const first = runtime.retry();
				const second = runtime.retry();
				found("stream-1");
				await Promise.all([first, second]);

				expect(running.checkForOrphanedStream).toHaveBeenCalledTimes(1);
				expect(streamInvocations).toHaveLength(2);
				expect(streamInvocations[1].options?.reconnectToStreamId).toBe(
					"stream-1",
				);
			});

			// The stream says whose message it runs. Another device's message in the same
			// chat is refused for the person's one reply at a time, and the stream that
			// runs is that one's: joining it would clear the error with this message
			// unsent, and a reload would lose it.
			describe("a stream that is another message's", () => {
				const streamOf = (userMessage: string) => ({
					schedule: patientClock(),
					checkForOrphanedStream: vi.fn(async () => "stream-other"),
					getStreamBufferInfo: vi.fn(async () => ({
						exists: true,
						userMessage,
					})),
				});

				it("is not this turn: Retry goes on to the chat and to the resend, as it would with no stream", async () => {
					const readChatMessages = vi.fn(async () => earlierTurn());
					const { adapters, streamInvocations, runtime } = await failedSend({
						...streamOf("A question from another device"),
						readChatMessages,
					});

					await runtime.retry();

					expect(readChatMessages).toHaveBeenCalledTimes(1);
					expect(adapters.loadPersistedData).not.toHaveBeenCalled();
					expect(streamInvocations).toHaveLength(2);
					expect(streamInvocations[1].message).toBe(askedWords);
					expect(
						streamInvocations[1].options?.reconnectToStreamId,
					).toBeUndefined();
				});

				it("still finds this turn in the chat when it has landed", async () => {
					const { adapters, streamInvocations, runtime } = await failedSend({
						...streamOf("A question from another device"),
						readChatMessages: vi.fn(async () => [
							...earlierTurn(),
							serverUser(),
							serverReply(),
						]),
					});

					await runtime.retry();

					expect(adapters.loadPersistedData).toHaveBeenCalledTimes(1);
					expect(streamInvocations).toHaveLength(1);
				});

				it("is this turn when only the white space differs, and the bubble on screen stays the one", async () => {
					const { streamInvocations, messages, runtime } = await failedSend({
						...streamOf(`  ${askedWords}\n`),
					});

					await runtime.retry();

					expect(streamInvocations).toHaveLength(2);
					expect(streamInvocations[1].options).toMatchObject({
						reconnectToStreamId: "stream-other",
						reconnectUserMessage: askedWords,
					});
					expect(
						messages.filter(
							(message) =>
								message.role === "user" && message.content === askedWords,
						),
					).toHaveLength(1);
				});

				it("is this turn when the stream says nothing of its message", async () => {
					const { streamInvocations, runtime } = await failedSend({
						schedule: patientClock(),
						checkForOrphanedStream: vi.fn(async () => "stream-1"),
						getStreamBufferInfo: vi.fn(async () => ({ exists: false })),
					});

					await runtime.retry();

					expect(streamInvocations).toHaveLength(2);
					expect(streamInvocations[1].options?.reconnectToStreamId).toBe(
						"stream-1",
					);
				});
			});

			// A stalled connection must not hold Retry for as long as the browser takes
			// to give up: the questions about the stream are bounded, on the clock the
			// runtime already uses (`schedule`), and no answer is no stream. The press
			// comes down either way, or every later press would do nothing.
			describe("when the server does not answer", () => {
				/** A clock the test runs by hand. */
				const clock = () => {
					const timers: Array<{ callback: () => void; delay: number }> = [];
					const schedule = vi.fn((callback: () => void, delay: number) => {
						timers.push({ callback, delay });
						return 1 as unknown as ReturnType<typeof setTimeout>;
					});
					return { timers, schedule };
				};
				const neverAnswers = <T>() => new Promise<T>(() => {});

				it("takes a stream question that has not answered in 5 s for no stream, and sends the message as before", async () => {
					const { timers, schedule } = clock();
					const { streamInvocations, runtime } = await failedSend({
						schedule,
						checkForOrphanedStream: vi.fn(() => neverAnswers<string | null>()),
						readChatMessages: vi.fn(async () => earlierTurn()),
					});

					const pressed = runtime.retry();
					await vi.waitFor(() => expect(timers).toHaveLength(1));
					expect(timers[0].delay).toBe(5000);
					timers[0].callback();
					await pressed;

					expect(streamInvocations).toHaveLength(2);
					expect(streamInvocations[1].message).toBe(askedWords);
					expect(
						streamInvocations[1].options?.reconnectToStreamId,
					).toBeUndefined();
				});

				it("takes a stream question that fails for no stream, and the press comes down", async () => {
					const { streamInvocations, runtime } = await failedSend({
						schedule: patientClock(),
						checkForOrphanedStream: vi.fn(async () => {
							throw new Error("Network failed");
						}),
					});

					await runtime.retry();
					expect(streamInvocations).toHaveLength(2);

					// The next press is not swallowed by a flag that stayed up.
					streamInvocations[1].callbacks.onError(new Error("Network failed"));
					await runtime.retry();
					expect(streamInvocations).toHaveLength(3);
				});

				it("brings the press down when the question never answers and the clock does", async () => {
					const { timers, schedule } = clock();
					const { streamInvocations, runtime } = await failedSend({
						schedule,
						checkForOrphanedStream: vi.fn(() => neverAnswers<string | null>()),
					});

					const first = runtime.retry();
					await vi.waitFor(() => expect(timers).toHaveLength(1));
					timers[0].callback();
					await first;
					streamInvocations[1].callbacks.onError(new Error("Network failed"));

					// A second press asks again, and is not swallowed.
					const second = runtime.retry();
					await vi.waitFor(() => expect(timers).toHaveLength(2));
					timers[1].callback();
					await second;
					expect(streamInvocations).toHaveLength(3);
				});

				it("joins a stream whose buffer cannot be read in time, with what the page knows of the message", async () => {
					const { timers, schedule } = clock();
					const { streamInvocations, runtime } = await failedSend({
						schedule,
						checkForOrphanedStream: vi.fn(async () => "stream-1"),
						getStreamBufferInfo: vi.fn(() => neverAnswers<null>()),
					});

					const pressed = runtime.retry();
					await vi.waitFor(() => expect(timers).toHaveLength(2));
					timers[1].callback();
					await pressed;

					expect(streamInvocations).toHaveLength(2);
					expect(streamInvocations[1].options).toMatchObject({
						reconnectToStreamId: "stream-1",
						reconnectUserMessage: askedWords,
					});
				});
			});
		});
	});

	it("reconnects to an orphaned stream and hands waiting state to polling", async () => {
		const { adapters, streamInvocations, messageListEvents } = makeAdapters({
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
		streamInvocations[0].callbacks.onFinishPart?.({
			type: "finish",
			finishReason: "stop",
		});
		streamInvocations[0].callbacks.onEnd("Persisted elsewhere", {
			assistantMessageId: "assistant-1",
		});

		expect(streamInvocations[0].handle.detach).toHaveBeenCalledTimes(1);
		expect(adapters.pollForCompletion).toHaveBeenCalledWith("id-1", "id-2");
		expect(messageListEvents.finalizeStreamingMessage).not.toHaveBeenCalled();
		expect(runtime.snapshot()).toMatchObject({
			active: false,
			isSending: true,
			isPollingForCompletion: true,
			phase: "polling",
		});
	});

	it("reconnects with the original stream Reasoning depth from the buffer snapshot", async () => {
		const { adapters, streamInvocations } = makeAdapters({
			getReasoningDepth: vi.fn((): ReasoningDepth => "quick"),
			checkForOrphanedStream: vi.fn(async () => "stream-1"),
			getStreamBufferInfo: vi.fn(async () => ({
				exists: true,
				userMessage: "Resume me",
				reasoningDepth: "thorough" as ReasoningDepth,
			})),
		});
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.checkForOrphanedStreamOnMount();

		expect(streamInvocations[0]).toMatchObject({
			message: "Resume me",
			options: {
				reconnectToStreamId: "stream-1",
				reconnectUserMessage: "Resume me",
				reasoningDepth: "thorough",
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

	it("retries a fresh send's capacity/global_limit rejection with bounded backoff instead of a hard error", async () => {
		vi.useFakeTimers();
		const { adapters, streamInvocations, messages, messageListEvents } =
			makeAdapters({
				schedule: vi.fn((callback, delay) => setTimeout(callback, delay)),
			});
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.send({
			message: "Hello during a drain",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});

		const setSendErrorCallsBeforeError = vi.mocked(adapters.setSendError).mock
			.calls.length;

		const capacity = new Error("Server at capacity") as Error & {
			code?: string;
		};
		capacity.code = "CAPACITY_EXCEEDED";
		streamInvocations[0].callbacks.onError(capacity);

		expect(adapters.schedule).toHaveBeenCalledWith(expect.any(Function), 500);
		expect(streamInvocations).toHaveLength(1);
		// No hard error surfaced and the placeholder stays in place while
		// backing off — this is the "still working on it" degrade, not a
		// failure the user has to notice and manually retry.
		expect(vi.mocked(adapters.setSendError).mock.calls.length).toBe(
			setSendErrorCallsBeforeError,
		);
		expect(messageListEvents.removeMessage).not.toHaveBeenCalled();
		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);

		await vi.runOnlyPendingTimersAsync();

		expect(streamInvocations).toHaveLength(2);
		expect(streamInvocations[1].message).toBe("Hello during a drain");
		expect(vi.mocked(adapters.setSendError).mock.calls.length).toBe(
			setSendErrorCallsBeforeError,
		);
		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
		vi.useRealTimers();
	});

	it("gives up after 3 fresh-send capacity retries and surfaces a retryable friendly error", async () => {
		vi.useFakeTimers();
		const { adapters, streamInvocations } = makeAdapters({
			schedule: vi.fn((callback, delay) => setTimeout(callback, delay)),
		});
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.send({
			message: "Hello during a long drain",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});

		function capacityError() {
			const err = new Error("Server at capacity") as Error & {
				code?: string;
			};
			err.code = "CAPACITY_EXCEEDED";
			return err;
		}

		streamInvocations[0].callbacks.onError(capacityError());
		await vi.runOnlyPendingTimersAsync();
		streamInvocations[1].callbacks.onError(capacityError());
		await vi.runOnlyPendingTimersAsync();
		streamInvocations[2].callbacks.onError(capacityError());
		await vi.runOnlyPendingTimersAsync();
		// The 4th rejection exceeds the retryCount < 3 bound, so this one
		// falls through to the existing hard-error + manual-retry path.
		streamInvocations[3].callbacks.onError(capacityError());

		expect(streamInvocations).toHaveLength(4);
		expect(adapters.setSendError).toHaveBeenLastCalledWith(
			"Server at capacity",
		);
		expect(runtime.snapshot()).toMatchObject({
			canRetry: true,
			isSending: false,
			active: false,
		});
		vi.useRealTimers();
	});

	// R1 (ADR-0060) defect 1 — a mid-stream network drop used to call
	// removeMessage unconditionally, deleting the partial answer with no
	// recovery attempt (only a capacity rejection got the bounded-backoff
	// treatment). RED before the fix: this exact scenario (onToken then a
	// plain network Error) hit the unconditional `removeMessage` and never
	// called `checkForOrphanedStream` at all.
	it("R1 defect 1 — preserves the partial answer on a mid-stream network drop and attempts automatic reconnect recovery", async () => {
		vi.useFakeTimers();
		const { adapters, streamInvocations, messageListEvents } = makeAdapters({
			schedule: vi.fn((callback, delay) => setTimeout(callback, delay)),
			checkForOrphanedStream: vi.fn(async () => "stream-network-1"),
			getStreamBufferInfo: vi.fn(async () => ({
				exists: true,
				userMessage: "Tell me a story",
			})),
		});
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.send({
			message: "Tell me a story",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});

		// Some of the answer is already visible before the connection drops.
		streamInvocations[0].callbacks.onToken("Once upon a time");

		streamInvocations[0].callbacks.onError(new Error("Failed to fetch"));

		// The partial answer must not be deleted immediately — the runtime
		// preserves it while it attempts to recover the stream, using the
		// same bounded-backoff idiom as a capacity rejection.
		expect(messageListEvents.removeMessage).not.toHaveBeenCalled();
		expect(adapters.schedule).toHaveBeenCalledWith(expect.any(Function), 500);

		await vi.runOnlyPendingTimersAsync();

		// Recovery is attempted automatically — no user action required —
		// via the same orphaned-stream mechanism that already recovers a
		// backgrounded tab (the server keeps generating independent of this
		// dropped client connection).
		expect(adapters.checkForOrphanedStream).toHaveBeenCalledWith("conv-1");
		expect(adapters.getStreamBufferInfo).toHaveBeenCalledWith(
			"stream-network-1",
			"conv-1",
		);
		expect(streamInvocations).toHaveLength(2);
		expect(streamInvocations[1].options).toMatchObject({
			reconnectToStreamId: "stream-network-1",
		});
		// Only now — immediately before the reconnect replays the answer back
		// in — does the original placeholder get swapped for the reconnected
		// one; there is no window where the answer is simply gone.
		expect(messageListEvents.removeMessage).toHaveBeenCalledWith("id-2");

		streamInvocations[1].callbacks.onEnd("Once upon a time, forever.", {
			assistantMessageId: "assistant-1",
		});

		expect(messageListEvents.finalizeStreamingMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({
					assistantMessageId: "assistant-1",
				}),
			}),
		);
		vi.useRealTimers();
	});

	// R1 (ADR-0060) defect 1, second RED — the network-drop recovery must
	// extend the *same* bounded reconnect/backoff idiom D2 already added for
	// fresh-send capacity errors (exponential delay, capped attempts), not
	// retry forever when no orphaned stream is ever found.
	it("R1 defect 1 — retries network-drop recovery with the same bounded backoff idiom as capacity errors, then gives up", async () => {
		vi.useFakeTimers();
		const { adapters, streamInvocations, messageListEvents } = makeAdapters({
			schedule: vi.fn((callback, delay) => setTimeout(callback, delay)),
			checkForOrphanedStream: vi.fn(async () => null),
		});
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.send({
			message: "Tell me a story",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});

		streamInvocations[0].callbacks.onToken("Once upon a time");
		streamInvocations[0].callbacks.onError(new Error("Failed to fetch"));

		// Same exponential idiom as the capacity backoff: 500ms, 1000ms, 2000ms.
		expect(adapters.schedule).toHaveBeenLastCalledWith(
			expect.any(Function),
			500,
		);
		await vi.runOnlyPendingTimersAsync();
		expect(adapters.schedule).toHaveBeenLastCalledWith(
			expect.any(Function),
			1000,
		);
		await vi.runOnlyPendingTimersAsync();
		expect(adapters.schedule).toHaveBeenLastCalledWith(
			expect.any(Function),
			2000,
		);
		await vi.runOnlyPendingTimersAsync();

		// No orphaned stream was ever found — after the bounded attempts the
		// runtime gives up and surfaces a retryable error instead of backing
		// off forever.
		expect(messageListEvents.removeMessage).toHaveBeenCalledWith("id-2");
		expect(adapters.setSendError).toHaveBeenCalledWith("Failed to fetch");
		expect(runtime.snapshot()).toMatchObject({
			canRetry: true,
			isSending: false,
			active: false,
		});
		expect(streamInvocations).toHaveLength(1);
		vi.useRealTimers();
	});

	// R1 (ADR-0060) defect 2 — reproduced first (this mechanism was read, not
	// proven): a mid-stream turn's callbacks read `getConversationId()` fresh
	// on every call, exactly as the page's adapters read `data.conversation.id`
	// fresh — so navigating away mid-stream, without anything else changing,
	// used to let every later callback (onToken, onToolCall, onEnd, evidence
	// polling, hydration) keep writing under the conversation the runtime was
	// *started* against, now silently re-targeted at whatever conversation is
	// current. RED before the fix: none of the assertions below held — every
	// one of these adapter calls fired using B's current conversation id.
	it("R1 defect 2 — drops writes for a stream whose conversation is no longer the one displayed", async () => {
		let currentConversationId = "conv-A";
		const { adapters, streamInvocations, messages, messageListEvents } =
			makeAdapters({
				getConversationId: vi.fn(() => currentConversationId),
			});
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.send({
			message: "Tell me about A",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});

		// onToken batches through the rAF-aligned display buffer, so flush it
		// (via onFinishPart, same as a real "finish" stream part would) to
		// prove the content that streamed *before* the switch really landed.
		streamInvocations[0].callbacks.onToken("Streaming A's answer");
		streamInvocations[0].callbacks.onFinishPart?.({
			type: "finish",
			finishReason: "stop",
		});
		expect(messages[1]).toMatchObject({ content: "Streaming A's answer" });

		// The user navigates from /chat/A to /chat/B while A is still
		// streaming — nothing else in this test changes.
		currentConversationId = "conv-B";

		const appendCallsBeforeSwitch =
			messageListEvents.appendTokenChunk.mock.calls.length;

		streamInvocations[0].callbacks.onToken(" — more of A's answer");
		streamInvocations[0].callbacks.onToolCall?.("search", {}, "done");
		streamInvocations[0].callbacks.onEnd(
			"Streaming A's answer — more of A's answer",
			{ assistantMessageId: "assistant-A" },
		);

		// None of A's post-switch stream output reached page state — it would
		// otherwise render as B's streamed text, evidence, activity, or
		// hydration.
		expect(messageListEvents.appendTokenChunk.mock.calls.length).toBe(
			appendCallsBeforeSwitch,
		);
		expect(messageListEvents.applyToolCallUpdate).not.toHaveBeenCalled();
		expect(messageListEvents.finalizeStreamingMessage).not.toHaveBeenCalled();
		expect(adapters.pollMessageEvidence).not.toHaveBeenCalled();
		expect(adapters.hydrateConversationDetail).not.toHaveBeenCalled();
		expect(messages[1].content).toBe("Streaming A's answer");
	});

	// R1 (ADR-0060) defect 2 — the one gap page-level detach alone can never
	// close: a scheduled retry firing after the conversation switched away.
	it("R1 defect 2 — drops a scheduled capacity retry if the conversation switched during backoff", async () => {
		vi.useFakeTimers();
		let currentConversationId = "conv-A";
		const { adapters, streamInvocations } = makeAdapters({
			getConversationId: vi.fn(() => currentConversationId),
			schedule: vi.fn((callback, delay) => setTimeout(callback, delay)),
		});
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.send({
			message: "Hello during a drain",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});

		const capacity = new Error("Server at capacity") as Error & {
			code?: string;
		};
		capacity.code = "CAPACITY_EXCEEDED";
		streamInvocations[0].callbacks.onError(capacity);

		// The user switches conversations during the backoff delay.
		currentConversationId = "conv-B";
		await vi.runOnlyPendingTimersAsync();

		// The retry never re-dispatched — it would otherwise have posted
		// A's message into conversation B.
		expect(streamInvocations).toHaveLength(1);
		expect(adapters.streamChat).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
	});

	// R1 defect 2 (retry-race amendment) — a scheduled capacity retry is a raw
	// timer nothing cancels. If a genuinely new turn (turn2) starts on a
	// different conversation during the backoff, the stale retry firing later
	// must not clobber turn2's shared runtime state (isSending/activeStream/
	// activePlaceholderId) via an unconditional completeTurn() inside the
	// `!isTurnConversationActive` guard.
	it("R1 defect 2 — a stale scheduled capacity retry does not clobber a genuinely active turn2 started during the backoff", async () => {
		vi.useFakeTimers();
		let currentConversationId = "conv-A";
		const { adapters, streamInvocations, messages, messageListEvents } =
			makeAdapters({
				getConversationId: vi.fn(() => currentConversationId),
				schedule: vi.fn((callback, delay) => setTimeout(callback, delay)),
			});
		const runtime = createNormalChatClientTurnRuntime(adapters);

		// Turn1 sends on conv-A, then hits a capacity rejection that schedules
		// a bounded backoff retry.
		await runtime.send({
			message: "Hello during a drain",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});
		const capacity = new Error("Server at capacity") as Error & {
			code?: string;
		};
		capacity.code = "CAPACITY_EXCEEDED";
		streamInvocations[0].callbacks.onError(capacity);

		// The user navigates away entirely (conv-A -> conv-B); the page's
		// reset effect runs, same as a real navigation.
		currentConversationId = "conv-B";
		runtime.reset();

		// A genuine new turn (turn2) starts on conv-B before turn1's backoff
		// timer fires.
		await runtime.send({
			message: "Hello on B",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});
		expect(streamInvocations).toHaveLength(2);
		const turn2SnapshotBeforeRetry = runtime.snapshot();
		expect(turn2SnapshotBeforeRetry.isSending).toBe(true);
		expect(turn2SnapshotBeforeRetry.active).toBe(true);

		// Turn1's scheduled capacity retry now fires.
		await vi.runOnlyPendingTimersAsync();

		// The stale retry must not have re-dispatched (it dropped its own
		// work)...
		expect(streamInvocations).toHaveLength(2);
		expect(adapters.streamChat).toHaveBeenCalledTimes(2);
		// ...and turn2's shared runtime state must be exactly as it was —
		// not reset to idle by the stale turn's guard.
		const afterRetrySnapshot = runtime.snapshot();
		expect(afterRetrySnapshot.isSending).toBe(true);
		expect(afterRetrySnapshot.active).toBe(true);

		// Turn2's live stream is still fully wired up — proof
		// activePlaceholderId still points at turn2, not nulled out.
		streamInvocations[1].callbacks.onToken("Streaming B's answer");
		streamInvocations[1].callbacks.onFinishPart?.({
			type: "finish",
			finishReason: "stop",
		});
		expect(messageListEvents.appendTokenChunk).toHaveBeenCalledWith(
			expect.any(String),
			"Streaming B's answer",
		);
		expect(
			messages.find((message) => message.content === "Streaming B's answer"),
		).toBeDefined();

		vi.useRealTimers();
	});

	it("reuses the optimistic user message when reconnecting after a background interruption", async () => {
		let browserHidden = true;
		let composerDepth: "quick" | "thorough" = "thorough";
		const { adapters, streamInvocations, messages, messageListEvents } =
			makeAdapters({
				isBrowserHidden: vi.fn(() => browserHidden),
				getReasoningDepth: vi.fn((): ReasoningDepth => composerDepth),
				checkForOrphanedStream: vi.fn(async () => "stream-1"),
				getStreamBufferInfo: vi.fn(async () => ({
					exists: true,
					userMessage: "Resume me",
					reasoningDepth: "thorough" as ReasoningDepth,
				})),
			});
		const runtime = createNormalChatClientTurnRuntime(adapters);

		await runtime.send({
			message: "Resume me",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
			reasoningDepth: "thorough",
		});
		const abortError = new Error("backgrounded");
		abortError.name = "AbortError";
		streamInvocations[0].callbacks.onError(abortError);

		composerDepth = "quick";
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
			reasoningDepth: "thorough",
		});

		streamInvocations[1].callbacks.onEnd("Done", {
			assistantMessageId: "assistant-1",
			userMessageId: "server-user-1",
		});

		expect(messageListEvents.finalizeStreamingMessage).toHaveBeenLastCalledWith(
			{
				placeholderId: "id-3",
				clientUserMessageId: "id-1",
				metadata: {
					assistantMessageId: "assistant-1",
					userMessageId: "server-user-1",
				},
			},
		);
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

	// FB-8's note (FX-1 item 5): a reload during a first turn that FAILS reconnects to
	// it; the reconnect ends on the server's error, the server kept nothing of the
	// turn, and the chat showed an empty conversation that said nothing.
	describe("a reconnected turn that fails", () => {
		it("puts the reader's message back, says the turn failed and offers Retry when the server kept nothing", async () => {
			const { adapters, streamInvocations, messages } = makeAdapters({
				// What the server has: nothing of the failed turn, so the list is emptied.
				loadPersistedData: vi.fn(async () => {
					messages.length = 0;
				}),
			});
			const runtime = createNormalChatClientTurnRuntime(adapters);

			await runtime.reconnectToOrphanedStream("stream-1", "Resume me");
			streamInvocations[0].callbacks.onError(new Error("The model refused."));
			await vi.waitFor(() =>
				expect(adapters.setSendError).toHaveBeenCalledWith(
					"The model refused.",
				),
			);

			expect(
				messages.map((message) => [message.role, message.content]),
			).toEqual([["user", "Resume me"]]);
			expect(runtime.snapshot()).toMatchObject({
				canRetry: true,
				lastUserMessage: "Resume me",
				active: false,
				isSending: false,
			});
		});

		it("makes Retry send the message again as a new turn", async () => {
			const { adapters, streamInvocations, messages } = makeAdapters({
				loadPersistedData: vi.fn(async () => {
					messages.length = 0;
				}),
			});
			const runtime = createNormalChatClientTurnRuntime(adapters);

			await runtime.reconnectToOrphanedStream("stream-1", "Resume me");
			streamInvocations[0].callbacks.onError(new Error("The model refused."));
			await vi.waitFor(() => expect(runtime.snapshot().canRetry).toBe(true));
			await runtime.retry();

			expect(streamInvocations).toHaveLength(2);
			expect(streamInvocations[1].message).toBe("Resume me");
			expect(streamInvocations[1].options).toMatchObject({
				retryOrigin: "error_retry",
			});
			expect(streamInvocations[1].options?.reconnectToStreamId).toBeUndefined();
		});

		it("says it failed after earlier turns too, and does not add a message the server kept", async () => {
			const kept = (role: "user" | "assistant", content: string) =>
				({ id: `${role}-kept`, role, content, timestamp: 1 }) as ChatMessage;
			const { adapters, streamInvocations, messages } = makeAdapters({
				loadPersistedData: vi.fn(async () => {
					messages.length = 0;
					messages.push(kept("user", "Earlier"), kept("assistant", "Answer"));
				}),
			});
			const runtime = createNormalChatClientTurnRuntime(adapters);

			await runtime.reconnectToOrphanedStream("stream-1", "Resume me");
			streamInvocations[0].callbacks.onError(new Error("The model refused."));
			await vi.waitFor(() => expect(runtime.snapshot().canRetry).toBe(true));
			// The earlier turns are there, and the failed turn's message after them.
			expect(messages.map((message) => message.content)).toEqual([
				"Earlier",
				"Answer",
				"Resume me",
			]);

			// A server that did keep the message (it ends the persisted list) is not added to.
			const second = makeAdapters({
				loadPersistedData: vi.fn(async () => {
					second.messages.length = 0;
					second.messages.push(kept("user", "Resume me"));
				}),
			});
			const secondRuntime = createNormalChatClientTurnRuntime(second.adapters);
			await secondRuntime.reconnectToOrphanedStream("stream-2", "Resume me");
			second.streamInvocations[0].callbacks.onError(new Error("It failed."));
			await vi.waitFor(() =>
				expect(second.adapters.setSendError).toHaveBeenCalledWith("It failed."),
			);
			expect(second.messages.map((message) => message.content)).toEqual([
				"Resume me",
			]);
		});

		it("still says it failed when the turn's message is not known (nothing to retry)", async () => {
			const { adapters, streamInvocations } = makeAdapters();
			const runtime = createNormalChatClientTurnRuntime(adapters);

			await runtime.reconnectToOrphanedStream("stream-1", "");
			streamInvocations[0].callbacks.onError(new Error("The model refused."));
			await vi.waitFor(() =>
				expect(adapters.setSendError).toHaveBeenCalledWith(
					"The model refused.",
				),
			);

			expect(runtime.snapshot().canRetry).toBe(false);
		});
	});

	// The page replaces its list with the chat it reads back, and the last thing its
	// load does is end the turn state (`completePollingRecovery`). A message sent
	// while the read is out would lose its bubble to the new list, and its turn would
	// lose `isSending` under the live stream. So the turn state is held through the
	// read, as polling recovery holds it, and what is sent meanwhile is queued.
	describe("reading the chat back for a turn that landed", () => {
		const words = "Plan the weekend";
		const earlier: ChatMessage[] = [
			{ id: "user-1", role: "user", content: "First question", timestamp: 1 },
			{ id: "assistant-1", role: "assistant", content: "First", timestamp: 2 },
		];
		const answered: ChatMessage[] = [
			...earlier,
			{ id: "user-2", role: "user", content: words, timestamp: 3 },
			{ id: "assistant-2", role: "assistant", content: "Done", timestamp: 4 },
		];
		const aSend = (message: string) => ({
			message,
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});

		it("Retry holds the turn state through the load, queues what is sent meanwhile and sends it after", async () => {
			let finishTheLoad: () => void = () => {};
			const made = makeAdapters({
				readChatMessages: vi.fn(async () => answered),
				loadPersistedData: vi.fn(
					() =>
						new Promise<void>((resolve) => {
							finishTheLoad = resolve;
						}),
				),
			});
			made.messages.push(...earlier);
			const runtime = createNormalChatClientTurnRuntime(made.adapters);
			await runtime.send(aSend(words));
			made.streamInvocations[0].callbacks.onError(new Error("Network failed"));

			const pressed = runtime.retry();
			await vi.waitFor(() =>
				expect(made.adapters.loadPersistedData).toHaveBeenCalled(),
			);

			// While the chat is read back the composer is held: nothing starts, and what
			// the person sends waits in the queue.
			expect(runtime.snapshot().isSending).toBe(true);
			await runtime.send(aSend("Sent meanwhile"));
			expect(made.streamInvocations).toHaveLength(1);
			runtime.queue(aSend("Queued meanwhile"));
			expect(runtime.snapshot().queuedTurn?.message).toBe("Queued meanwhile");

			finishTheLoad();
			await pressed;

			expect(made.streamInvocations).toHaveLength(2);
			expect(made.streamInvocations[1].message).toBe("Queued meanwhile");
			expect(runtime.snapshot().queuedTurn).toBeNull();
		});

		it("Retry lets the turn state go when the load fails before it does", async () => {
			const made = makeAdapters({
				readChatMessages: vi.fn(async () => answered),
				loadPersistedData: vi.fn(async () => {
					throw new Error("The page could not read the chat");
				}),
			});
			made.messages.push(...earlier);
			const runtime = createNormalChatClientTurnRuntime(made.adapters);
			await runtime.send(aSend(words));
			made.streamInvocations[0].callbacks.onError(new Error("Network failed"));

			await expect(runtime.retry()).rejects.toThrow("could not read");

			expect(runtime.snapshot()).toMatchObject({
				isSending: false,
				active: false,
			});
		});

		it("the give-up of the recovery holds it too", async () => {
			vi.useFakeTimers();
			try {
				let duringTheLoad: boolean | undefined;
				const held: {
					runtime?: ReturnType<typeof createNormalChatClientTurnRuntime>;
				} = {};
				const made = makeAdapters({
					schedule: vi.fn((callback, delay) => setTimeout(callback, delay)),
					checkForOrphanedStream: vi.fn(async () => null),
					readChatMessages: vi.fn(async () => answered),
					loadPersistedData: vi.fn(async () => {
						duringTheLoad = held.runtime?.snapshot().isSending;
					}),
				});
				made.messages.push(...earlier);
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				held.runtime = runtime;
				await runtime.send(aSend(words));
				made.streamInvocations[0].callbacks.onToken("Plan");
				made.streamInvocations[0].callbacks.onError(
					new Error("Failed to fetch"),
				);
				await vi.runOnlyPendingTimersAsync();
				await vi.runOnlyPendingTimersAsync();
				await vi.runOnlyPendingTimersAsync();

				expect(made.adapters.loadPersistedData).toHaveBeenCalledTimes(1);
				expect(duringTheLoad).toBe(true);
				expect(runtime.snapshot().isSending).toBe(false);
			} finally {
				vi.useRealTimers();
			}
		});

		it("so does the load after a reconnect that failed", async () => {
			let duringTheLoad: boolean | undefined;
			const held: {
				runtime?: ReturnType<typeof createNormalChatClientTurnRuntime>;
			} = {};
			const made = makeAdapters({
				loadPersistedData: vi.fn(async () => {
					duringTheLoad = held.runtime?.snapshot().isSending;
				}),
			});
			const runtime = createNormalChatClientTurnRuntime(made.adapters);
			held.runtime = runtime;

			await runtime.reconnectToOrphanedStream("stream-1", words);
			made.streamInvocations[0].callbacks.onError(new Error("It failed."));
			await vi.waitFor(() =>
				expect(made.adapters.setSendError).toHaveBeenCalledWith("It failed."),
			);

			expect(duringTheLoad).toBe(true);
			expect(runtime.snapshot()).toMatchObject({
				isSending: false,
				canRetry: true,
			});
		});
	});

	// ADR-0054, "An Update During A Turn". A deploy drains the server (a new
	// message is turned away with the reason "draining"), then restarts it (the
	// reverse proxy answers its maintenance page). A request refused for that ran
	// nothing, so the turn waits for the server to come back and sends the same
	// request again, instead of counting down three tries and blaming the provider.
	describe("a request refused while the server is updated", () => {
		const POLL_MS = 3000;
		const EIGHT_MINUTES_MS = 8 * 60 * 1000;
		const AWAY: ServerHealth = { reachable: false, draining: false };
		const DRAINING: ServerHealth = { reachable: true, draining: true };
		const WELL: ServerHealth = { reachable: true, draining: false };

		function refusedAsDraining(): Error {
			return Object.assign(
				new Error("Server at capacity. Please try again later."),
				{ status: 503, code: "CAPACITY_EXCEEDED", reason: "draining" },
			);
		}

		function refusedByTheProxy(): Error {
			return Object.assign(new Error("HTTP 503"), {
				status: 503,
				serverUnavailable: true,
			});
		}

		function refusedAsFull(reason: "global_limit" | "user_limit"): Error {
			return Object.assign(
				new Error("Server at capacity. Please try again later."),
				{ status: 503, code: "CAPACITY_EXCEEDED", reason },
			);
		}

		const words = (text = "Hello during an update") => ({
			message: text,
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});

		/**
		 * Adapters whose clock is the test's (`schedule` is a timer vitest advances)
		 * and whose server is whatever `server.health` says.
		 */
		function updateAdapters(
			overrides: Partial<NormalChatClientTurnRuntimeAdapters> = {},
		) {
			vi.useFakeTimers();
			const server = { health: DRAINING };
			const made = makeAdapters({
				schedule: vi.fn((callback, delay) => setTimeout(callback, delay)),
				fetchServerHealth: vi.fn(async () => server.health),
				onServerUpdateSign: vi.fn(),
				setTurnWaitingForUpdate: vi.fn(),
				...overrides,
			});
			return { ...made, server };
		}

		/** What the page was told through `setSendError`, ignoring the clearing a send does. */
		function sentenceShown(adapters: NormalChatClientTurnRuntimeAdapters) {
			return vi
				.mocked(adapters.setSendError)
				.mock.calls.map(([message]) => message)
				.filter((message) => message !== null);
		}

		afterEach(() => {
			vi.useRealTimers();
		});

		it("waits in awaiting_update while the server drains, then sends the same request again", async () => {
			const { adapters, streamInvocations, messages, server } =
				updateAdapters();
			const runtime = createNormalChatClientTurnRuntime(adapters);

			await runtime.send(words());
			streamInvocations[0].callbacks.onError(refusedAsDraining());

			// Not the capacity backoff, and no error: the placeholder waits, saying so.
			expect(adapters.schedule).not.toHaveBeenCalledWith(
				expect.any(Function),
				500,
			);
			expect(sentenceShown(adapters)).toEqual([]);
			expect(messages.map((message) => message.role)).toEqual([
				"user",
				"assistant",
			]);
			expect(messages[1].runtimePhase).toBe("awaiting_update");
			expect(runtime.snapshot()).toMatchObject({
				phase: "awaiting_update",
				isSending: true,
				active: false,
			});
			// The shell is told, once, and holds its Refresh notice.
			expect(adapters.onServerUpdateSign).toHaveBeenCalledTimes(1);
			expect(adapters.setTurnWaitingForUpdate).toHaveBeenLastCalledWith(true);

			// The first look is a poll away, and the server is still draining.
			await vi.advanceTimersByTimeAsync(POLL_MS - 1);
			expect(adapters.fetchServerHealth).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(adapters.fetchServerHealth).toHaveBeenCalledTimes(1);
			expect(streamInvocations).toHaveLength(1);

			// It is back: the same request goes again, to the same two bubbles.
			server.health = WELL;
			await vi.advanceTimersByTimeAsync(POLL_MS);
			expect(adapters.fetchServerHealth).toHaveBeenCalledTimes(2);
			expect(streamInvocations).toHaveLength(2);
			expect(streamInvocations[1]).toMatchObject({
				message: "Hello during an update",
				conversationId: "conv-1",
			});
			expect(streamInvocations[1].options).toBe(streamInvocations[0].options);
			expect(adapters.setTurnWaitingForUpdate).toHaveBeenLastCalledWith(false);
			expect(messages.map((message) => message.role)).toEqual([
				"user",
				"assistant",
			]);
			expect(messages[1].runtimePhase).toBe("preparing");
			expect(runtime.snapshot()).toMatchObject({
				phase: "preparing",
				isSending: true,
				active: true,
			});

			// And it streams like any turn: no sentence was ever shown.
			streamInvocations[1].callbacks.onToken("Hi");
			streamInvocations[1].callbacks.onEnd("Hi", {
				assistantMessageId: "assistant-1",
			});
			expect(sentenceShown(adapters)).toEqual([]);
			expect(runtime.snapshot()).toMatchObject({
				isSending: false,
				canRetry: false,
			});
		});

		it("takes the proxy's maintenance page for the same wait, and goes on waiting through the restart", async () => {
			const { adapters, streamInvocations, messages, server } =
				updateAdapters();
			const runtime = createNormalChatClientTurnRuntime(adapters);

			await runtime.send(words());
			streamInvocations[0].callbacks.onError(refusedByTheProxy());

			expect(messages[1].runtimePhase).toBe("awaiting_update");
			expect(adapters.schedule).not.toHaveBeenCalledWith(
				expect.any(Function),
				500,
			);

			// The restart: the health route does not answer at all.
			server.health = AWAY;
			await vi.advanceTimersByTimeAsync(POLL_MS * 5);
			expect(streamInvocations).toHaveLength(1);
			expect(messages[1].runtimePhase).toBe("awaiting_update");

			server.health = WELL;
			await vi.advanceTimersByTimeAsync(POLL_MS);
			expect(streamInvocations).toHaveLength(2);
			expect(sentenceShown(adapters)).toEqual([]);
		});

		it("gives up after eight minutes: the placeholder goes, the question stays with Retry and the sentence for it", async () => {
			const { adapters, streamInvocations, messages } = updateAdapters();
			const runtime = createNormalChatClientTurnRuntime(adapters);

			await runtime.send(words());
			streamInvocations[0].callbacks.onError(refusedAsDraining());

			await vi.advanceTimersByTimeAsync(EIGHT_MINUTES_MS - 1);
			expect(runtime.snapshot().phase).toBe("awaiting_update");
			await vi.advanceTimersByTimeAsync(1);

			expect(sentenceShown(adapters)).toEqual(["chat.updateStillRunning"]);
			expect(messages.map((message) => message.role)).toEqual(["user"]);
			expect(runtime.snapshot()).toMatchObject({
				isSending: false,
				active: false,
				canRetry: true,
			});
			expect(adapters.setTurnWaitingForUpdate).toHaveBeenLastCalledWith(false);
			expect(streamInvocations).toHaveLength(1);

			// The polls stop with the wait.
			const looks = vi.mocked(adapters.fetchServerHealth).mock.calls.length;
			await vi.advanceTimersByTimeAsync(60_000);
			expect(vi.mocked(adapters.fetchServerHealth)).toHaveBeenCalledTimes(
				looks,
			);
			expect(streamInvocations).toHaveLength(1);
		});

		it("does not let a health question that never answers hold the polls back", async () => {
			const { adapters, streamInvocations } = updateAdapters({
				fetchServerHealth: vi.fn(() => new Promise<ServerHealth>(() => {})),
			});
			const runtime = createNormalChatClientTurnRuntime(adapters);

			await runtime.send(words());
			streamInvocations[0].callbacks.onError(refusedAsDraining());

			await vi.advanceTimersByTimeAsync(POLL_MS);
			expect(adapters.fetchServerHealth).toHaveBeenCalledTimes(1);
			// No answer in five seconds is "away", and the next look comes a poll later.
			await vi.advanceTimersByTimeAsync(5000 + POLL_MS);
			expect(adapters.fetchServerHealth).toHaveBeenCalledTimes(2);
			expect(streamInvocations).toHaveLength(1);
		});

		it("sends a Retry that is refused the same way again once the server is back", async () => {
			const { adapters, streamInvocations, messages, server } =
				updateAdapters();
			const runtime = createNormalChatClientTurnRuntime(adapters);

			await runtime.send(words("Question"));
			streamInvocations[0].callbacks.onError(new Error("Network failed"));
			await runtime.retry();
			expect(streamInvocations).toHaveLength(2);

			streamInvocations[1].callbacks.onError(refusedAsDraining());
			expect(messages.at(-1)?.runtimePhase).toBe("awaiting_update");
			expect(adapters.onServerUpdateSign).toHaveBeenCalledTimes(1);

			server.health = WELL;
			await vi.advanceTimersByTimeAsync(POLL_MS);

			expect(streamInvocations).toHaveLength(3);
			expect(streamInvocations[2].message).toBe("Question");
			// Still the same user bubble and one placeholder.
			expect(messages.map((message) => message.role)).toEqual([
				"user",
				"assistant",
			]);
		});

		it.each([
			"global_limit",
			"user_limit",
		] as const)("keeps the old three-step backoff for a refusal that says %s", async (reason) => {
			const { adapters, streamInvocations, messages } = updateAdapters();
			const runtime = createNormalChatClientTurnRuntime(adapters);

			await runtime.send(words());
			streamInvocations[0].callbacks.onError(refusedAsFull(reason));

			// Backing off, the old way: no wait, no sign, no awaiting phase.
			expect(adapters.schedule).toHaveBeenCalledWith(expect.any(Function), 500);
			expect(adapters.onServerUpdateSign).not.toHaveBeenCalled();
			expect(adapters.setTurnWaitingForUpdate).not.toHaveBeenCalled();
			expect(messages[1].runtimePhase).not.toBe("awaiting_update");

			await vi.advanceTimersByTimeAsync(500);
			expect(streamInvocations).toHaveLength(2);
		});

		it("still ends a full server's refusals with the capacity sentence after three tries", async () => {
			const { adapters, streamInvocations } = updateAdapters();
			const runtime = createNormalChatClientTurnRuntime(adapters);

			await runtime.send(words());
			streamInvocations[0].callbacks.onError(refusedAsFull("global_limit"));
			await vi.advanceTimersByTimeAsync(500);
			streamInvocations[1].callbacks.onError(refusedAsFull("global_limit"));
			await vi.advanceTimersByTimeAsync(1000);
			streamInvocations[2].callbacks.onError(refusedAsFull("global_limit"));
			await vi.advanceTimersByTimeAsync(2000);
			streamInvocations[3].callbacks.onError(refusedAsFull("global_limit"));

			expect(streamInvocations).toHaveLength(4);
			expect(sentenceShown(adapters)).toEqual([
				"Server at capacity. Please try again later.",
			]);
			expect(runtime.snapshot()).toMatchObject({
				canRetry: true,
				isSending: false,
			});
		});

		it("sends a request again only a few times when the server calls itself well and keeps refusing it as an update", async () => {
			const { adapters, streamInvocations, server } = updateAdapters();
			const runtime = createNormalChatClientTurnRuntime(adapters);
			server.health = WELL;

			await runtime.send(words());
			// Refused, waited, sent again: three times over.
			for (let sent = 0; sent < 3; sent += 1) {
				streamInvocations[sent].callbacks.onError(refusedByTheProxy());
				await vi.advanceTimersByTimeAsync(POLL_MS);
				expect(streamInvocations).toHaveLength(sent + 2);
			}
			expect(adapters.onServerUpdateSign).toHaveBeenCalledTimes(3);

			// The fourth refusal is not waited for: it fails like any other.
			streamInvocations[3].callbacks.onError(refusedByTheProxy());
			expect(adapters.onServerUpdateSign).toHaveBeenCalledTimes(3);
			expect(runtime.snapshot()).toMatchObject({
				phase: "idle",
				isSending: false,
				canRetry: true,
			});
			expect(sentenceShown(adapters)).toEqual(["HTTP 503"]);
		});

		describe("Stop, and leaving the chat, while it waits", () => {
			it("ends the wait on Stop: the unsent bubble and the placeholder go, and the words return to the composer", async () => {
				const { adapters, streamInvocations, messages, server } =
					updateAdapters();
				const runtime = createNormalChatClientTurnRuntime(adapters);
				const payload = {
					...words("Words that never arrived"),
					attachmentIds: ["file-1"],
				};

				await runtime.send(payload);
				streamInvocations[0].callbacks.onError(refusedAsDraining());
				expect(runtime.snapshot().phase).toBe("awaiting_update");

				// Stop is not "nothing to stop" now: it ends the wait, at once.
				expect(runtime.stop()).toBe(true);

				expect(messages).toEqual([]);
				expect(adapters.restorePayloadToDraft).toHaveBeenCalledTimes(1);
				expect(adapters.restorePayloadToDraft).toHaveBeenCalledWith(
					expect.objectContaining({
						message: "Words that never arrived",
						attachmentIds: ["file-1"],
					}),
				);
				// No sentence: the person stopped it. And nothing is left to retry.
				expect(sentenceShown(adapters)).toEqual([]);
				expect(runtime.snapshot()).toMatchObject({
					phase: "idle",
					isSending: false,
					canRetry: false,
				});
				expect(adapters.setTurnWaitingForUpdate).toHaveBeenLastCalledWith(
					false,
				);

				// Nothing is sent afterwards, whatever the server does.
				server.health = WELL;
				await vi.advanceTimersByTimeAsync(POLL_MS * 4);
				expect(streamInvocations).toHaveLength(1);
				expect(adapters.fetchServerHealth).not.toHaveBeenCalled();
			});

			it("returns a message queued behind the waiting one after it, so the words keep their order", async () => {
				const { adapters, streamInvocations } = updateAdapters();
				const runtime = createNormalChatClientTurnRuntime(adapters);

				await runtime.send(words("First"));
				streamInvocations[0].callbacks.onError(refusedAsDraining());
				runtime.queue(words("Second, typed while it waited"));
				expect(runtime.snapshot().queuedTurn?.message).toBe(
					"Second, typed while it waited",
				);

				runtime.stop();

				expect(
					vi
						.mocked(adapters.restorePayloadToDraft)
						.mock.calls.map(([restored]) => restored.message),
				).toEqual(["First", "Second, typed while it waited"]);
				expect(runtime.snapshot().queuedTurn).toBeNull();
			});

			it("leaves a stopped regenerate the way a failed one is left, with no sentence and no words to restore", async () => {
				const { adapters, streamInvocations, messages } = updateAdapters();
				const runtime = createNormalChatClientTurnRuntime(adapters);
				// The page took the reply it replaces off the list, and the question stays.
				messages.push({
					id: "user-1",
					role: "user",
					content: "The old question",
					timestamp: 1,
				});

				await runtime.send(words("The old question"), {
					skipUserMessage: true,
					skipPersistUserMessage: true,
					retryAssistantMessageId: "assistant-old",
					retryUserMessageId: "user-1",
				});
				streamInvocations[0].callbacks.onError(refusedAsDraining());
				expect(messages.at(-1)?.runtimePhase).toBe("awaiting_update");

				runtime.stop();

				// The placeholder goes; the question, which the server holds, stays; and
				// the question's words are not put in the composer as if unsent.
				expect(messages.map((message) => message.id)).toEqual(["user-1"]);
				expect(adapters.restorePayloadToDraft).not.toHaveBeenCalled();
				expect(sentenceShown(adapters)).toEqual([]);
				expect(runtime.snapshot()).toMatchObject({
					isSending: false,
					canRetry: true,
				});
			});

			it("does the same for a request with no payload at all, the regenerate Retry makes of a reply", async () => {
				const { adapters, streamInvocations, messages } = updateAdapters();
				const runtime = createNormalChatClientTurnRuntime(adapters);

				await runtime.send(words("Question"));
				streamInvocations[0].callbacks.onError(new Error("Network failed"));
				// The list now ends in a reply (something else put it there): Retry asks
				// for it again.
				messages.push({
					id: "reply-1",
					role: "assistant",
					content: "An answer",
					timestamp: 3,
				});
				await runtime.retry();
				expect(streamInvocations[1].options?.retryAssistantMessageId).toBe(
					"reply-1",
				);

				streamInvocations[1].callbacks.onError(refusedAsDraining());
				expect(runtime.snapshot().phase).toBe("awaiting_update");
				runtime.stop();

				expect(adapters.restorePayloadToDraft).not.toHaveBeenCalled();
				expect(messages.map((message) => message.role)).toEqual(["user"]);
				expect(runtime.snapshot()).toMatchObject({
					isSending: false,
					canRetry: true,
				});
			});

			it("sends nothing from a chat the person left: a reset drops the wait", async () => {
				const { adapters, streamInvocations, server } = updateAdapters();
				const runtime = createNormalChatClientTurnRuntime(adapters);

				await runtime.send(words());
				streamInvocations[0].callbacks.onError(refusedAsDraining());

				runtime.reset();
				expect(adapters.setTurnWaitingForUpdate).toHaveBeenLastCalledWith(
					false,
				);

				server.health = WELL;
				await vi.advanceTimersByTimeAsync(EIGHT_MINUTES_MS);
				expect(streamInvocations).toHaveLength(1);
				expect(adapters.fetchServerHealth).not.toHaveBeenCalled();
				expect(sentenceShown(adapters)).toEqual([]);
			});

			it("sends nothing when the chat on screen changed and the page has not reset the runtime yet", async () => {
				let shown = "conv-1";
				const { adapters, streamInvocations, server } = updateAdapters({
					getConversationId: vi.fn(() => shown),
				});
				const runtime = createNormalChatClientTurnRuntime(adapters);

				await runtime.send(words());
				streamInvocations[0].callbacks.onError(refusedAsDraining());
				shown = "conv-2";

				server.health = WELL;
				await vi.advanceTimersByTimeAsync(POLL_MS * 3);

				expect(streamInvocations).toHaveLength(1);
				expect(adapters.setTurnWaitingForUpdate).toHaveBeenLastCalledWith(
					false,
				);
				expect(runtime.snapshot()).toMatchObject({
					isSending: false,
					phase: "idle",
				});
				expect(sentenceShown(adapters)).toEqual([]);
			});

			it("does not touch a turn of the chat that is on screen now when a wait of the one left ends", async () => {
				let shown = "conv-1";
				const { adapters, streamInvocations, server } = updateAdapters({
					getConversationId: vi.fn(() => shown),
				});
				const runtime = createNormalChatClientTurnRuntime(adapters);

				await runtime.send(words("Left behind"));
				streamInvocations[0].callbacks.onError(refusedAsDraining());
				shown = "conv-2";
				runtime.reset();
				await runtime.send(words("In the new chat"));
				expect(streamInvocations).toHaveLength(2);

				server.health = WELL;
				await vi.advanceTimersByTimeAsync(POLL_MS * 3);

				// The new chat's turn is exactly as it was.
				expect(streamInvocations).toHaveLength(2);
				expect(runtime.snapshot()).toMatchObject({
					isSending: true,
					active: true,
				});
			});

			it("hands the waiting words to a page that is being left, and sends nothing", async () => {
				const { adapters, streamInvocations, server } = updateAdapters();
				const runtime = createNormalChatClientTurnRuntime(adapters);

				await runtime.send({ ...words("Mine"), attachmentIds: ["file-1"] });
				streamInvocations[0].callbacks.onError(refusedAsDraining());

				const taken = runtime.takeWaitingRequest();

				expect(taken).toMatchObject({
					message: "Mine",
					attachmentIds: ["file-1"],
				});
				// A copy: the page may change it, and the wait is over.
				expect(adapters.setTurnWaitingForUpdate).toHaveBeenLastCalledWith(
					false,
				);
				expect(runtime.takeWaitingRequest()).toBeNull();
				server.health = WELL;
				await vi.advanceTimersByTimeAsync(POLL_MS * 3);
				expect(streamInvocations).toHaveLength(1);
			});

			it("hands them over after the page was detached, and the detached wait sends nothing meanwhile", async () => {
				const { adapters, streamInvocations, server } = updateAdapters();
				const runtime = createNormalChatClientTurnRuntime(adapters);

				await runtime.send(words("Mine"));
				streamInvocations[0].callbacks.onError(refusedAsDraining());

				// The page's destroy: detach first, then it takes the words.
				runtime.detach();
				server.health = WELL;
				await vi.advanceTimersByTimeAsync(POLL_MS * 3);
				expect(streamInvocations).toHaveLength(1);
				expect(runtime.takeWaitingRequest()).toMatchObject({ message: "Mine" });
			});

			it("has no words to hand over for a regenerate, which the server holds, or when nothing waits", async () => {
				const { adapters, streamInvocations } = updateAdapters();
				const runtime = createNormalChatClientTurnRuntime(adapters);
				expect(runtime.takeWaitingRequest()).toBeNull();

				await runtime.send(words("The old question"), {
					skipUserMessage: true,
					skipPersistUserMessage: true,
					retryAssistantMessageId: "assistant-old",
					retryUserMessageId: "user-1",
				});
				streamInvocations[0].callbacks.onError(refusedAsDraining());

				expect(runtime.takeWaitingRequest()).toBeNull();
				expect(adapters.setTurnWaitingForUpdate).toHaveBeenLastCalledWith(
					false,
				);
			});
		});
	});

	// ADR-0054, "An Update During A Turn". A reply that was running when the server
	// restarted is cut off by a connection that fails. Before that is put down to
	// the provider, the page is asked whether the server is being updated; if it
	// is, the turn waits for the server, asks what it holds (it may have finished
	// the turn while the browser was cut off), and otherwise says an update cut the
	// reply. It is never sent again by itself: tools may have run (a produced file,
	// a Document), and sending it again is the person's choice, through Retry.
	describe("a reply cut off while the server is updated", () => {
		const POLL_MS = 3000;
		const WELL: ServerHealth = { reachable: true, draining: false };
		const DRAINING: ServerHealth = { reachable: true, draining: true };

		/** What a restart looks like from a reply that was running. */
		const connectionFailed = () => new TypeError("network error");
		const closedEarly = () =>
			Object.assign(
				new Error("Stream closed before a terminal completion event"),
				{ transport: true },
			);

		const question = "Write the report";
		const heldByTheServer: ChatMessage[] = [
			{ id: "user-server", role: "user", content: question, timestamp: 1 },
			{
				id: "assistant-server",
				role: "assistant",
				content: "The report",
				timestamp: 2,
			},
		];

		function cutAdapters(
			overrides: Partial<NormalChatClientTurnRuntimeAdapters> = {},
		) {
			vi.useFakeTimers();
			const server = {
				health: DRAINING,
				updating: true,
				// What the chat holds on the server now: nothing of this turn.
				chat: [] as ChatMessage[],
			};
			const made = makeAdapters({
				schedule: vi.fn((callback, delay) => setTimeout(callback, delay)),
				fetchServerHealth: vi.fn(async () => server.health),
				isServerUpdating: vi.fn(async () => server.updating),
				onServerUpdateSign: vi.fn(),
				setTurnWaitingForUpdate: vi.fn(),
				readChatMessages: vi.fn(async () => server.chat),
				...overrides,
			});
			return { ...made, server };
		}

		const send = (
			runtime: ReturnType<typeof createNormalChatClientTurnRuntime>,
		) =>
			runtime.send({
				message: question,
				attachmentIds: [],
				attachments: [],
				pendingAttachments: [],
			});

		function sentenceShown(adapters: NormalChatClientTurnRuntimeAdapters) {
			return vi
				.mocked(adapters.setSendError)
				.mock.calls.map(([message]) => message)
				.filter((message) => message !== null);
		}

		afterEach(() => {
			vi.useRealTimers();
		});

		describe("after some of it was read", () => {
			/** The reply is read for a while, the connection fails, and the three looks for its stream (3.5 s) find none. */
			async function cutAfterSomeText(
				made: ReturnType<typeof cutAdapters>,
				failure: Error = connectionFailed(),
			) {
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await send(runtime);
				made.streamInvocations[0].callbacks.onToken("Half an");
				made.streamInvocations[0].callbacks.onError(failure);
				await vi.advanceTimersByTimeAsync(500 + 1000 + 2000);
				return runtime;
			}

			it("waits in awaiting_update for the server instead of giving up on the three looks, and tells the shell", async () => {
				const made = cutAdapters();
				const runtime = await cutAfterSomeText(made);

				// The look for the stream found nothing, and the page was asked.
				expect(made.adapters.checkForOrphanedStream).toHaveBeenCalledTimes(3);
				expect(made.adapters.isServerUpdating).toHaveBeenCalledTimes(1);
				expect(sentenceShown(made.adapters)).toEqual([]);
				expect(made.messages.at(-1)?.runtimePhase).toBe("awaiting_update");
				expect(runtime.snapshot()).toMatchObject({
					phase: "awaiting_update",
					isSending: true,
				});
				expect(made.adapters.onServerUpdateSign).toHaveBeenCalledTimes(1);
				expect(made.adapters.setTurnWaitingForUpdate).toHaveBeenLastCalledWith(
					true,
				);
				// Nothing was asked of the chat yet: the server is still away.
				expect(made.adapters.readChatMessages).not.toHaveBeenCalled();
			});

			it("loads the turn the server finished meanwhile, with no error, and sends nothing", async () => {
				const made = cutAdapters();
				const runtime = await cutAfterSomeText(made);

				made.server.health = WELL;
				made.server.chat = heldByTheServer;
				await vi.advanceTimersByTimeAsync(POLL_MS);

				expect(made.adapters.readChatMessages).toHaveBeenCalledTimes(1);
				expect(made.adapters.loadPersistedData).toHaveBeenCalledTimes(1);
				expect(sentenceShown(made.adapters)).toEqual([]);
				expect(runtime.snapshot()).toMatchObject({
					isSending: false,
					canRetry: false,
				});
				expect(made.streamInvocations).toHaveLength(1);
				expect(made.adapters.setTurnWaitingForUpdate).toHaveBeenLastCalledWith(
					false,
				);
			});

			it("says an update cut the reply when the server holds nothing of it, offers Retry, and sends nothing by itself", async () => {
				const made = cutAdapters();
				const runtime = await cutAfterSomeText(made);

				made.server.health = WELL;
				await vi.advanceTimersByTimeAsync(POLL_MS);

				expect(sentenceShown(made.adapters)).toEqual(["chat.updateCutReply"]);
				// The question stays on screen, the half reply goes, Retry is offered.
				expect(made.messages.map((message) => message.role)).toEqual(["user"]);
				expect(runtime.snapshot()).toMatchObject({
					isSending: false,
					canRetry: true,
				});
				// Never sent again by itself, however long the server has been back.
				await vi.advanceTimersByTimeAsync(60_000);
				expect(made.streamInvocations).toHaveLength(1);
				expect(made.adapters.loadPersistedData).not.toHaveBeenCalled();
			});

			it("gives the same answer after the cap, when the server never came back", async () => {
				const made = cutAdapters();
				const runtime = await cutAfterSomeText(made);

				await vi.advanceTimersByTimeAsync(8 * 60 * 1000);

				expect(sentenceShown(made.adapters)).toEqual(["chat.updateCutReply"]);
				expect(runtime.snapshot()).toMatchObject({
					isSending: false,
					canRetry: true,
				});
				expect(made.streamInvocations).toHaveLength(1);
			});

			it("goes on as it always did when the server is not being updated", async () => {
				const made = cutAdapters();
				made.server.updating = false;
				const runtime = await cutAfterSomeText(made);

				// The provider sentence for the failure, now.
				expect(sentenceShown(made.adapters)).toEqual(["network error"]);
				expect(made.adapters.onServerUpdateSign).not.toHaveBeenCalled();
				expect(made.adapters.setTurnWaitingForUpdate).not.toHaveBeenCalled();
				expect(made.messages.map((message) => message.role)).toEqual(["user"]);
				expect(runtime.snapshot()).toMatchObject({
					isSending: false,
					canRetry: true,
				});
			});

			it("does not ask about an update for an error the server named, a model failure say", async () => {
				const made = cutAdapters();
				await cutAfterSomeText(
					made,
					Object.assign(new Error("The model failed."), { code: "timeout" }),
				);

				expect(made.adapters.isServerUpdating).not.toHaveBeenCalled();
				expect(sentenceShown(made.adapters)).toEqual(["The model failed."]);
			});

			it("does not take the turn state back from a turn that started while it was looking", async () => {
				const made = cutAdapters();
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await send(runtime);
				made.streamInvocations[0].callbacks.onToken("Half an");
				made.streamInvocations[0].callbacks.onError(connectionFailed());

				// The composer is free while the three looks go on: another message starts.
				await runtime.send({
					message: "Another",
					attachmentIds: [],
					attachments: [],
					pendingAttachments: [],
				});
				expect(made.streamInvocations).toHaveLength(2);
				await vi.advanceTimersByTimeAsync(500 + 1000 + 2000);

				// The new turn owns the state, as it did before an update could be asked about.
				expect(runtime.snapshot()).toMatchObject({
					isSending: true,
					active: true,
				});
				expect(made.adapters.onServerUpdateSign).not.toHaveBeenCalled();
				expect(sentenceShown(made.adapters)).toEqual([]);
			});
		});

		describe("before any of it was read", () => {
			it("waits for the server instead of showing the provider's error, keeping the question", async () => {
				const made = cutAdapters();
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await send(runtime);

				made.streamInvocations[0].callbacks.onError(closedEarly());
				await vi.advanceTimersByTimeAsync(0);

				expect(made.adapters.isServerUpdating).toHaveBeenCalledTimes(1);
				expect(made.messages.map((message) => message.role)).toEqual([
					"user",
					"assistant",
				]);
				expect(made.messages[1].runtimePhase).toBe("awaiting_update");
				expect(sentenceShown(made.adapters)).toEqual([]);
				expect(made.adapters.onServerUpdateSign).toHaveBeenCalledTimes(1);

				// The server comes back holding nothing: the sentence, Retry, no resend.
				made.server.health = WELL;
				await vi.advanceTimersByTimeAsync(POLL_MS);
				expect(sentenceShown(made.adapters)).toEqual(["chat.updateCutReply"]);
				expect(made.messages.map((message) => message.role)).toEqual(["user"]);
				expect(runtime.snapshot()).toMatchObject({
					isSending: false,
					canRetry: true,
				});
				expect(made.streamInvocations).toHaveLength(1);
			});

			it("loads a turn that landed while the browser was cut off", async () => {
				const made = cutAdapters();
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await send(runtime);

				made.streamInvocations[0].callbacks.onError(connectionFailed());
				await vi.advanceTimersByTimeAsync(0);
				made.server.health = WELL;
				made.server.chat = heldByTheServer;
				await vi.advanceTimersByTimeAsync(POLL_MS);

				expect(made.adapters.loadPersistedData).toHaveBeenCalledTimes(1);
				expect(sentenceShown(made.adapters)).toEqual([]);
				expect(made.streamInvocations).toHaveLength(1);
				expect(runtime.snapshot().canRetry).toBe(false);
			});

			it("is the failure it always was when the server is not being updated", async () => {
				const made = cutAdapters();
				made.server.updating = false;
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await send(runtime);

				made.streamInvocations[0].callbacks.onError(connectionFailed());
				await vi.advanceTimersByTimeAsync(0);

				expect(sentenceShown(made.adapters)).toEqual(["network error"]);
				expect(made.messages.map((message) => message.role)).toEqual(["user"]);
				expect(runtime.snapshot()).toMatchObject({
					isSending: false,
					canRetry: true,
				});
				expect(made.adapters.onServerUpdateSign).not.toHaveBeenCalled();
			});

			it("ends the wait on Stop, and asks the server what it holds before it says so", async () => {
				const made = cutAdapters();
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await send(runtime);
				made.streamInvocations[0].callbacks.onError(connectionFailed());
				await vi.advanceTimersByTimeAsync(0);
				expect(runtime.snapshot().phase).toBe("awaiting_update");

				expect(runtime.stop()).toBe(true);
				await vi.advanceTimersByTimeAsync(0);

				// No words to restore: the server may hold the message, so the question
				// stays and Retry asks the server before it sends anything.
				expect(made.adapters.restorePayloadToDraft).not.toHaveBeenCalled();
				expect(made.adapters.readChatMessages).toHaveBeenCalledTimes(1);
				expect(sentenceShown(made.adapters)).toEqual(["chat.updateCutReply"]);
				expect(runtime.snapshot()).toMatchObject({
					isSending: false,
					canRetry: true,
				});
				expect(made.streamInvocations).toHaveLength(1);
			});

			it("has no words to hand to a page that is being left, and drops the wait", async () => {
				const made = cutAdapters();
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await send(runtime);
				made.streamInvocations[0].callbacks.onError(connectionFailed());
				await vi.advanceTimersByTimeAsync(0);

				expect(runtime.takeWaitingRequest()).toBeNull();
				expect(made.adapters.setTurnWaitingForUpdate).toHaveBeenLastCalledWith(
					false,
				);
				made.server.health = WELL;
				await vi.advanceTimersByTimeAsync(POLL_MS * 3);
				expect(made.adapters.readChatMessages).not.toHaveBeenCalled();
				expect(sentenceShown(made.adapters)).toEqual([]);
			});
		});

		describe("a reconnect that ends on a failed connection", () => {
			it("waits for the server, then reads the chat and says an update cut it when the server kept nothing", async () => {
				const made = cutAdapters({
					loadPersistedData: vi.fn(async () => {
						made.messages.length = 0;
					}),
				});
				const runtime = createNormalChatClientTurnRuntime(made.adapters);

				await runtime.reconnectToOrphanedStream("stream-1", "Resume me");
				made.streamInvocations[0].callbacks.onError(connectionFailed());
				await vi.advanceTimersByTimeAsync(0);

				expect(made.messages.at(-1)?.runtimePhase).toBe("awaiting_update");
				expect(made.adapters.onServerUpdateSign).toHaveBeenCalledTimes(1);
				expect(made.adapters.loadPersistedData).not.toHaveBeenCalled();

				made.server.health = WELL;
				await vi.advanceTimersByTimeAsync(POLL_MS);

				await vi.waitFor(() =>
					expect(sentenceShown(made.adapters)).toEqual(["chat.updateCutReply"]),
				);
				expect(
					made.messages.map((message) => [message.role, message.content]),
				).toEqual([["user", "Resume me"]]);
				expect(runtime.snapshot()).toMatchObject({
					canRetry: true,
					isSending: false,
				});
				expect(made.streamInvocations).toHaveLength(1);
			});

			it("takes the proxy's maintenance page for the same wait", async () => {
				const made = cutAdapters({
					loadPersistedData: vi.fn(async () => {
						made.messages.length = 0;
					}),
				});
				const runtime = createNormalChatClientTurnRuntime(made.adapters);

				await runtime.reconnectToOrphanedStream("stream-1", "Resume me");
				made.streamInvocations[0].callbacks.onError(
					Object.assign(new Error("HTTP 503"), {
						status: 503,
						serverUnavailable: true,
					}),
				);
				await vi.advanceTimersByTimeAsync(0);

				expect(runtime.snapshot().phase).toBe("awaiting_update");
			});

			it("is the failure it always was when the server is not being updated", async () => {
				const made = cutAdapters({
					loadPersistedData: vi.fn(async () => {
						made.messages.length = 0;
					}),
				});
				made.server.updating = false;
				const runtime = createNormalChatClientTurnRuntime(made.adapters);

				await runtime.reconnectToOrphanedStream("stream-1", "Resume me");
				made.streamInvocations[0].callbacks.onError(connectionFailed());
				await vi.advanceTimersByTimeAsync(0);

				await vi.waitFor(() =>
					expect(sentenceShown(made.adapters)).toEqual(["network error"]),
				);
				expect(made.adapters.onServerUpdateSign).not.toHaveBeenCalled();
			});
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
			const { adapters, streamInvocations, messageListEvents } = makeAdapters();
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

			expect(messageListEvents.appendTokenChunk).toHaveBeenCalledTimes(1);
			expect(messageListEvents.appendTokenChunk).toHaveBeenCalledWith(
				"id-2",
				"AB",
			);
		});

		it("flushes the token buffer on stream errors so buffered text is not lost", async () => {
			const { adapters, streamInvocations, messageListEvents } = makeAdapters();
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

			expect(messageListEvents.appendTokenChunk).toHaveBeenCalledTimes(1);
			expect(messageListEvents.appendTokenChunk).toHaveBeenCalledWith(
				"id-2",
				"AB",
			);

			// R1 (ADR-0060, defect 1) — this error lands the runtime in the new
			// network-drop-recovery path (content had already streamed), which
			// schedules further async recovery work. Settle it so it does not
			// dangle past this test's teardown; the recovery path itself is
			// covered by its own dedicated tests below.
			await new Promise((resolve) => setTimeout(resolve, 0));
		});

		it("does not deliver buffered token text before stream-end or stream-error", () => {
			const { adapters, streamInvocations, messageListEvents } = makeAdapters();
			const runtime = createNormalChatClientTurnRuntime(adapters);

			runtime.send({
				message: "Hello",
				attachmentIds: [],
				attachments: [],
				pendingAttachments: [],
			});

			streamInvocations[0].callbacks.onToken("A");

			expect(messageListEvents.appendTokenChunk).not.toHaveBeenCalled();
		});

		it("coalesces thinking chunks through the buffer and delivers them on end", () => {
			const { adapters, streamInvocations, messageListEvents } = makeAdapters();
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

			expect(messageListEvents.appendThinkingChunk).toHaveBeenCalledTimes(1);
			expect(messageListEvents.appendThinkingChunk).toHaveBeenCalledWith(
				"id-2",
				"AB",
			);
		});
	});
});
