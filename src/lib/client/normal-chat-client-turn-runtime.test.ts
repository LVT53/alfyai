import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerHealth } from "$lib/client/api/health";
import {
	type AskRuntimeEvent,
	createNormalChatClientTurnRuntime,
	type NormalChatClientTurnRuntimeAdapters,
	type NormalChatMessageListEvent,
	type NormalChatRuntimeSnapshot,
} from "$lib/client/normal-chat-client-turn-runtime";
import {
	applyNormalChatOutputView,
	normalChatOutputView,
} from "$lib/client/normal-chat-output-view";
import type { ServerUpdateKind } from "$lib/client/server-update-watch";
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
import type { AskAnswer } from "$lib/shared/ask-user";
import {
	projectNormalChatFinalization,
	TURN_FINALIZATION_WINDOW_MS,
} from "$lib/shared/normal-chat-completion";
import { createNormalChatOutputAccumulator } from "$lib/shared/normal-chat-output";
import { finalizeStreamingMessageList } from "../../routes/(app)/chat/[conversationId]/_helpers";

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
		canonicalMessage?: ChatMessage;
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
					canonicalMessage,
				}: {
					canonicalMessage?: ChatMessage;
					placeholderId: string;
					clientUserMessageId: string | null;
					metadata?: StreamMetadata;
				}) => {
					if (canonicalMessage) {
						messages.splice(
							0,
							messages.length,
							...finalizeStreamingMessageList(messages, {
								placeholderId,
								clientUserMessageId: null,
								metadata,
								canonicalMessage,
							}),
						);
						return;
					}
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
			case "applyNormalChatOutput":
				messages.splice(
					0,
					messages.length,
					...applyNormalChatOutputView(
						messages,
						event.placeholderId,
						event.view,
					),
				);
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
					...(event.canonicalMessage
						? { canonicalMessage: event.canonicalMessage }
						: {}),
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
			async (): Promise<ServerHealth> => ({ state: "up" }),
		),
		// No new version, and the page says a lost connection is no update.
		isNewVersionLive: vi.fn(() => false),
		askServerUpdate: vi.fn(async (): Promise<ServerUpdateKind> => "none"),
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
		expect(adapters.refreshMessageCost).toHaveBeenCalledWith("assistant-1");
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
	it("keeps structural partials on failed recovery and ignores stale output/end after B starts", async () => {
		vi.useFakeTimers();
		const made = makeAdapters({
			schedule: vi.fn((callback, delay) => setTimeout(callback, delay)),
		});
		const runtime = createNormalChatClientTurnRuntime(made.adapters);
		await runtime.send({
			message: "A",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});
		const a = made.streamInvocations[0].callbacks;
		const output = createNormalChatOutputAccumulator();
		const scope = {
			version: 1,
			turnId: "t",
			segmentId: "s",
			attemptId: "a",
			stepId: "w",
			phase: "working",
		} as const;
		output.apply({
			...scope,
			sequence: 0,
			type: "block_start",
			blockId: "b",
			nativeId: "n",
			kind: "text",
			role: "provisional",
		});
		output.apply({
			...scope,
			sequence: 1,
			type: "block_delta",
			blockId: "b",
			text: "Working",
		});
		a.onNormalChatOutput?.(output.getProjection());
		expect(made.messages.at(-1)?.content).toBe("");
		a.onError(new Error("model failed"));
		await vi.advanceTimersByTimeAsync(3500);
		expect(
			made.messages.find((message) => message.id === "id-2"),
		).toMatchObject({ content: "", isStreaming: false });
		await runtime.send({
			message: "B",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});
		const state = runtime.snapshot();
		vi.mocked(made.adapters.applyMessageListEvent).mockClear();
		a.onNormalChatOutput?.(output.getProjection());
		a.onEnd("stale", { finalContent: "stale", assistantMessageId: "old" });
		expect(made.adapters.applyMessageListEvent).not.toHaveBeenCalled();
		expect(runtime.snapshot()).toEqual(state);
		vi.useRealTimers();
	});

	it("does not reload or join A after background recovery yields to B", async () => {
		let resolveStream!: (value: string | null) => void;
		const made = makeAdapters({
			isBrowserHidden: () => true,
			checkForOrphanedStream: vi.fn(
				() =>
					new Promise<string | null>((resolve) => {
						resolveStream = resolve;
					}),
			),
		});
		const runtime = createNormalChatClientTurnRuntime(made.adapters);
		await runtime.send({
			message: "A",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});
		made.streamInvocations[0].callbacks.onToken("A partial");
		made.streamInvocations[0].callbacks.onError(
			Object.assign(new Error("background"), { name: "AbortError" }),
		);
		const recovery = runtime.handleVisibilityVisible();
		expect(made.adapters.checkForOrphanedStream).toHaveBeenCalledTimes(1);
		await runtime.send({
			message: "B",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});
		const before = runtime.snapshot();
		vi.mocked(made.adapters.applyMessageListEvent).mockClear();
		resolveStream("stream-A");
		await recovery;
		expect(made.streamInvocations).toHaveLength(2);
		expect(made.adapters.loadPersistedData).not.toHaveBeenCalled();
		expect(made.adapters.applyMessageListEvent).not.toHaveBeenCalled();
		expect(runtime.snapshot()).toEqual(before);
	});

	it.each(
		(["legacy", "structural"] as const).flatMap((kind) =>
			(["saved-read", "update-status"] as const).flatMap((stage) =>
				(["B-completes", "stop", "route-leave"] as const).map((action) => ({
					kind,
					stage,
					action,
				})),
			),
		),
	)("keeps late A $stage inert after $action with $kind partials", async ({
		kind,
		stage,
		action,
	}) => {
		vi.useFakeTimers();
		let finishRead!: (value: ChatMessage[]) => void;
		let finishUpdate!: (value: ServerUpdateKind) => void;
		const onServerUpdateSign = vi.fn();
		const made = makeAdapters({
			onServerUpdateSign,
			schedule: vi.fn((callback, delay) => setTimeout(callback, delay)),
			readChatMessages: vi.fn(
				() =>
					new Promise<ChatMessage[]>((resolve) => {
						finishRead = resolve;
					}),
			),
			askServerUpdate: vi.fn(
				() =>
					new Promise<ServerUpdateKind>((resolve) => {
						finishUpdate = resolve;
					}),
			),
		});
		const runtime = createNormalChatClientTurnRuntime(made.adapters);
		const words = (message: string) => ({
			message,
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});
		await runtime.send(words("A"));
		const a = made.streamInvocations[0].callbacks;
		if (kind === "legacy") a.onToken("A partial");
		else {
			const output = createNormalChatOutputAccumulator();
			const scope = {
				version: 1,
				turnId: "t",
				segmentId: "s",
				attemptId: "a",
				stepId: "w",
				phase: "working",
			} as const;
			output.apply({
				...scope,
				sequence: 0,
				type: "block_start",
				blockId: "b",
				nativeId: "n",
				kind: "text",
				role: "provisional",
			});
			output.apply({
				...scope,
				sequence: 1,
				type: "block_delta",
				blockId: "b",
				text: "A working",
			});
			a.onNormalChatOutput?.(output.getProjection());
		}
		a.onError(
			stage === "saved-read"
				? new Error("Failed to fetch")
				: new TypeError("Failed to fetch"),
		);
		await vi.advanceTimersByTimeAsync(3500);
		expect(made.adapters.checkForOrphanedStream).toHaveBeenCalledTimes(3);
		if (stage === "saved-read")
			expect(made.adapters.readChatMessages).toHaveBeenCalledTimes(1);
		else expect(made.adapters.askServerUpdate).toHaveBeenCalledTimes(1);
		if (action === "B-completes") {
			await runtime.send(words("B"));
			made.streamInvocations[1].callbacks.onToken("B answer");
			made.streamInvocations[1].callbacks.onEnd("B answer");
			expect(runtime.snapshot()).toMatchObject({
				isSending: false,
				lastUserMessage: "B",
				lastAssistantResponse: "B answer",
				canRetry: false,
			});
		} else if (action === "stop") runtime.stop();
		else runtime.detach();
		const before = runtime.snapshot();
		vi.mocked(made.adapters.applyMessageListEvent).mockClear();
		vi.mocked(made.adapters.setSendError).mockClear();
		onServerUpdateSign.mockClear();
		if (stage === "saved-read") finishRead([]);
		else finishUpdate("draining");
		await vi.advanceTimersByTimeAsync(0);
		expect.soft(made.adapters.applyMessageListEvent).not.toHaveBeenCalled();
		expect.soft(made.adapters.setSendError).not.toHaveBeenCalled();
		expect.soft(made.adapters.onServerUpdateSign).not.toHaveBeenCalled();
		expect.soft(runtime.snapshot()).toEqual(before);
		expect(made.messages.find((row) => row.id === "id-2")).toBeDefined();
		vi.useRealTimers();
	});

	it.each([
		"waiting",
		"failed",
		"replay",
	] as const)("keeps structural partial until atomic observer replacement: %s", async (result) => {
		vi.useFakeTimers();
		const made = makeAdapters({
			schedule: vi.fn((cb, ms) => setTimeout(cb, ms)),
			checkForOrphanedStream: vi.fn(async () => "observer"),
			getStreamBufferInfo: vi.fn(async () => ({
				exists: true,
				userMessage: "A",
			})),
		});
		const runtime = createNormalChatClientTurnRuntime(made.adapters);
		await runtime.send({
			message: "A",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});
		const projection = (text: string) => {
			const output = createNormalChatOutputAccumulator();
			const scope = {
				version: 1,
				turnId: "t",
				segmentId: "s",
				attemptId: "a",
				stepId: "c",
				phase: "closing",
			} as const;
			output.apply({
				...scope,
				sequence: 0,
				type: "block_start",
				blockId: "b",
				nativeId: "n",
				kind: "text",
				role: "answer",
			});
			output.apply({
				...scope,
				sequence: 1,
				type: "block_delta",
				blockId: "b",
				text,
			});
			return output.getProjection();
		};
		made.streamInvocations[0].callbacks.onNormalChatOutput?.(
			projection("Partial 42"),
		);
		made.streamInvocations[0].callbacks.onError(new Error("Failed to fetch"));
		await vi.advanceTimersByTimeAsync(500);
		const observer = made.streamInvocations[1].callbacks;
		expect(made.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
		expect(made.messages.at(-1)?.content).toBe("Partial 42");
		if (result === "waiting") observer.onWaiting?.();
		else if (result === "failed")
			observer.onError(new TypeError("observer lost"));
		else {
			observer.onNormalChatOutput?.(projection("Replayed"));
			expect(made.messages.at(-1)?.content).toBe("Partial 42");
			observer.onNormalChatOutput?.(projection("Complete replacement 42"));
			observer.onReplayComplete?.();
			expect(made.messages.at(-1)?.content).toBe("Complete replacement 42");
		}
		if (result !== "replay")
			expect(made.messages.at(-1)?.content).toBe("Partial 42");
		expect(made.messageListEvents.removeMessage).not.toHaveBeenCalledWith(
			"id-2",
		);
		if (result === "failed")
			expect(made.messages.at(-1)?.isStreaming).toBe(false);
		vi.useRealTimers();
	});

	it.each([
		"unsaved",
		"saved",
		"pending-stop",
		"unavailable",
		"saved-missing",
		"pending-terminal",
	] as const)("settles scoped durable observation without impossible message polling: %s", async (result) => {
		vi.useFakeTimers();
		const made = makeAdapters({
			schedule: vi.fn((cb, ms) => setTimeout(cb, ms)),
			readChatMessages: vi.fn(async () => [
				{
					id: result === "saved-missing" ? "different-row" : "saved",
					role: "assistant" as const,
					content: "Canonical durable answer",
					timestamp: 1,
				},
			]),
		});
		const runtime = createNormalChatClientTurnRuntime(made.adapters);
		await runtime.reconnectToOrphanedStream("observer", "A");
		const callbacks = made.streamInvocations[0].callbacks;
		const identity = {
			version: 1 as const,
			streamId: "observer",
			conversationId: "conv-1",
		};
		if (result === "pending-stop") {
			callbacks.onWaiting?.({
				...identity,
				state: "pending",
				turnId: "t",
				segmentId: "s",
			});
			expect(made.adapters.pollForCompletion).not.toHaveBeenCalled();
			runtime.stop();
			await vi.advanceTimersByTimeAsync(2000);
			expect(made.streamInvocations).toHaveLength(2);
			expect(runtime.snapshot().isSending).toBe(false);
		} else if (result === "unavailable") {
			callbacks.onEnd("", {
				observation: { ...identity, state: "unavailable" },
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(made.adapters.pollForCompletion).not.toHaveBeenCalled();
			expect(made.adapters.setSendError).toHaveBeenCalledWith(
				"chat.observationUnavailable",
			);
			expect(runtime.snapshot().isSending).toBe(false);
		} else {
			let terminalCallbacks = callbacks;
			if (result === "pending-terminal") {
				callbacks.onWaiting?.({
					...identity,
					state: "pending",
					turnId: "t",
					segmentId: "s",
				});
				await vi.advanceTimersByTimeAsync(2000);
				expect(made.streamInvocations).toHaveLength(2);
				terminalCallbacks = made.streamInvocations[1].callbacks;
			}
			terminalCallbacks.onEnd("", {
				observation: {
					...identity,
					state: "terminal",
					assistantMessageId:
						result === "saved" || result === "saved-missing" ? "saved" : null,
					completion: {
						version: 1,
						turnId: "t",
						segmentId: "s",
						phase: "closing",
						outcome: result === "saved" ? "answered" : "incomplete",
						stopCause: "uncertain_execution",
						workingStopCause: "transport_error",
						closingAttempted: true,
					},
				},
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(made.adapters.pollForCompletion).not.toHaveBeenCalled();
			expect(runtime.snapshot().isSending).toBe(false);
			if (result === "saved")
				expect(made.messages.at(-1)?.content).toBe("Canonical durable answer");
			else if (result === "saved-missing")
				expect(made.messages.at(-1)?.content).not.toBe(
					"Canonical durable answer",
				);
			else
				expect(
					normalChatOutputView(
						made.messages.at(-1) ?? {
							id: "missing",
							role: "assistant",
							content: "",
							timestamp: 0,
						},
					)?.completion?.outcome,
				).toBe("incomplete");
		}
		vi.useRealTimers();
	});

	it("cancels pending observation ownership on route reset before a newer turn is stopped", async () => {
		vi.useFakeTimers();
		const made = makeAdapters({
			schedule: vi.fn((cb, ms) => setTimeout(cb, ms)),
		});
		const runtime = createNormalChatClientTurnRuntime(made.adapters);
		await runtime.reconnectToOrphanedStream("observer", "A");
		made.streamInvocations[0].callbacks.onWaiting?.({
			version: 1,
			state: "pending",
			streamId: "observer",
			conversationId: "conv-1",
			turnId: "t",
			segmentId: "s",
		});
		runtime.reset();
		await runtime.send({
			message: "B",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});
		runtime.stop();
		expect(made.streamInvocations[1].handle.stop).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(2000);
		expect(made.streamInvocations).toHaveLength(2);
		vi.useRealTimers();
	});

	it("keeps typed pending observation active and stoppable through the runtime state seam", async () => {
		vi.useFakeTimers();
		const made = makeAdapters({
			schedule: vi.fn((cb, ms) => setTimeout(cb, ms)),
		});
		const runtime = createNormalChatClientTurnRuntime(made.adapters);
		await runtime.reconnectToOrphanedStream("pending-live", "A");
		const observer = made.streamInvocations[0];
		observer.callbacks.onWaiting?.({
			version: 1,
			state: "pending",
			streamId: "pending-live",
			conversationId: "conv-1",
			turnId: "t",
			segmentId: "s",
		});
		expect(observer.handle.detach).toHaveBeenCalledOnce();
		expect(observer.handle.stop).not.toHaveBeenCalled();
		expect.soft(runtime.snapshot()).toMatchObject({
			active: true,
			canStop: true,
			phase: "polling",
			isSending: true,
		});
		runtime.stop();
		runtime.stop();
		await vi.advanceTimersByTimeAsync(4000);
		expect(observer.handle.stop).toHaveBeenCalledOnce();
		expect(runtime.snapshot()).toMatchObject({
			active: false,
			canStop: false,
			isSending: false,
		});
		expect(made.streamInvocations).toHaveLength(2);
		vi.useRealTimers();
	});

	it("keeps cancellation owned while the next observation request is in flight", async () => {
		vi.useFakeTimers();
		const made = makeAdapters({
			schedule: vi.fn((cb, ms) => setTimeout(cb, ms)),
		});
		const runtime = createNormalChatClientTurnRuntime(made.adapters);
		await runtime.reconnectToOrphanedStream("pending-live", "A");
		const first = made.streamInvocations[0];
		first.callbacks.onWaiting?.({
			version: 1,
			state: "pending",
			streamId: "pending-live",
			conversationId: "conv-1",
			turnId: "t",
			segmentId: "s",
		});
		await vi.advanceTimersByTimeAsync(2000);
		expect(made.streamInvocations).toHaveLength(2);
		expect
			.soft(runtime.snapshot())
			.toMatchObject({ active: true, canStop: true, phase: "polling" });
		expect(runtime.stop()).toBe(true);
		expect(first.handle.stop).not.toHaveBeenCalled();
		expect(made.streamInvocations[1].handle.stop).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(4000);
		expect(made.streamInvocations).toHaveLength(3);
		vi.useRealTimers();
	});

	it("drops stale pending cancellation ownership on reset and Stop targets only B", async () => {
		vi.useFakeTimers();
		const made = makeAdapters({
			schedule: vi.fn((cb, ms) => setTimeout(cb, ms)),
		});
		const runtime = createNormalChatClientTurnRuntime(made.adapters);
		await runtime.reconnectToOrphanedStream("pending-A", "A");
		const a = made.streamInvocations[0];
		a.callbacks.onWaiting?.({
			version: 1,
			state: "pending",
			streamId: "pending-A",
			conversationId: "conv-1",
			turnId: "t",
			segmentId: "s",
		});
		runtime.reset();
		await runtime.send({
			message: "B",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});
		const b = made.streamInvocations[1];
		a.callbacks.onWaiting?.({
			version: 1,
			state: "pending",
			streamId: "pending-A",
			conversationId: "conv-1",
			turnId: "t",
			segmentId: "s",
		});
		runtime.stop();
		await vi.advanceTimersByTimeAsync(4000);
		expect(a.handle.stop).not.toHaveBeenCalled();
		expect(b.handle.stop).toHaveBeenCalledOnce();
		expect(made.streamInvocations).toHaveLength(2);
		vi.useRealTimers();
	});

	it.each([
		"en",
		"hu",
	] as const)("localizes saved failed Retry through the existing formatter: %s", async (language) => {
		const { toFriendlySendError } = await import(
			"../../routes/(app)/chat/[conversationId]/_helpers"
		);
		const { get } = await import("svelte/store");
		const { t } = await import("$lib/i18n");
		const { uiLanguage } = await import("$lib/stores/settings");
		const { default: chatDict } = await import("$lib/i18n/chat");
		const scope = {
			version: 1,
			turnId: "failed",
			segmentId: "failed",
			attemptId: "terminal",
			stepId: "terminal:0",
			phase: "closing",
		} as const;
		const event = {
			...scope,
			sequence: 1,
			type: "completion",
			completion: {
				version: 1,
				turnId: scope.turnId,
				segmentId: scope.segmentId,
				phase: "closing",
				outcome: "failed",
				stopCause: "transport_error",
				workingStopCause: "transport_error",
				closingAttempted: true,
			},
		} as const;
		const made = makeAdapters({
			toFriendlySendError: vi.fn((error) => toFriendlySendError(error, get(t))),
		});
		made.messages.push(
			{ id: "saved-user", role: "user", timestamp: 1, content: "A" },
			{
				id: "saved-failed",
				role: "assistant",
				timestamp: 1,
				content: "",
				normalChatOutput: { version: 1, events: [event] },
			},
		);
		const runtime = createNormalChatClientTurnRuntime(made.adapters);
		const previousLanguage = get(uiLanguage);
		uiLanguage.set(language);
		try {
			await runtime.checkForOrphanedStreamOnMount();
			expect(runtime.snapshot().canRetry).toBe(true);
			expect(made.adapters.setSendError).toHaveBeenLastCalledWith(
				chatDict[language]["chat.error.backend"],
			);
			expect(made.messages.at(-1)?.id).toBe("saved-failed");
			expect(made.adapters.streamChat).not.toHaveBeenCalled();
		} finally {
			runtime.detach();
			uiLanguage.set(previousLanguage);
		}
	});

	it.each(
		(["live", "observe", "reload", "unreadable"] as const).flatMap((mode) =>
			[false, true].map((wasStopped) => ({ mode, wasStopped })),
		),
	)("settles persistence-only finalization without generation Retry/recovery: $mode stopped=$wasStopped", async ({
		mode,
		wasStopped,
	}) => {
		const { streamChat } = await import("$lib/services/streaming");
		const { uiFrame } = await import("$lib/services/streaming.test-helpers");
		const { projectNormalChatFinalization } = await import(
			"$lib/shared/normal-chat-completion"
		);
		const scope = {
			version: 1,
			turnId: "t",
			segmentId: "s",
			attemptId: "a",
			stepId: "w",
			phase: "working",
		} as const;
		const modelCompletion = {
			version: 1,
			turnId: "t",
			segmentId: "s",
			phase: "closing",
			outcome: "answered",
			stopCause: "natural_stop",
			workingStopCause: "tool_budget",
			closingAttempted: true,
		} as const;
		const normalChatFinalization = {
			version: 1,
			status: "failed",
			cause: "file_association_failed",
			wasStopped,
		} as const;
		const events: import("$lib/shared/normal-chat-output").NormalChatOutputEvent[] =
			[
				{
					...scope,
					sequence: 0,
					type: "block_start",
					blockId: "b",
					nativeId: "b",
					kind: "text",
					role: "activity",
				},
				{
					...scope,
					sequence: 1,
					type: "block_delta",
					blockId: "b",
					text: "Working activity",
				},
				{
					...scope,
					sequence: 2,
					type: "completion",
					completion: modelCompletion,
				},
			];
		const saved: ChatMessage = {
			id: "saved-finalization",
			role: "assistant",
			timestamp: 2,
			content: "  Canonical answer\n",
			normalChatOutput: { version: 1, events },
			normalChatFinalization,
		};
		const user: ChatMessage = {
			id: "saved-user",
			role: "user",
			timestamp: 1,
			content: "A",
		};
		const made = makeAdapters({
			streamChat,
			schedule: vi.fn((cb, delay) => setTimeout(cb, delay)),
			checkForOrphanedStream: vi.fn(async () =>
				mode === "observe" ? "observed" : null,
			),
			getStreamBufferInfo: vi.fn(async () => ({
				exists: true,
				userMessage: "A",
			})),
			readChatMessages: vi.fn(async () =>
				mode === "unreadable" ? [] : [user, saved],
			),
		});
		const runtime = createNormalChatClientTurnRuntime(made.adapters);
		const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			runtime.queue({
				message: "Queued B",
				attachmentIds: [],
				attachments: [],
				pendingAttachments: [],
			});
			const observation = {
				version: 1,
				streamId: body.streamId,
				conversationId: "conv-1",
				state: "terminal",
				assistantMessageId: saved.id,
				normalChatFinalization,
				modelCompletion,
				completion: projectNormalChatFinalization(
					modelCompletion,
					normalChatFinalization,
				),
			};
			return new Response(
				(mode === "unreadable"
					? events
							.map((event) =>
								uiFrame({ type: "data-normal-chat-output", data: event }),
							)
							.join("")
					: "") +
					uiFrame({
						type: "data-stream-metadata",
						data: {
							observation,
							...(mode === "unreadable" ? { finalContent: saved.content } : {}),
						},
						transient: true,
					}) +
					uiFrame({
						type: "finish",
						finishReason: wasStopped ? "stop" : "error",
					}) +
					uiFrame("[DONE]"),
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		});
		vi.stubGlobal("fetch", fetch);
		try {
			if (mode === "reload") {
				made.messages.push(user, saved);
				await runtime.checkForOrphanedStreamOnMount();
			} else if (mode === "observe") {
				made.messages.push(user);
				await runtime.checkForOrphanedStreamOnMount();
			} else
				await runtime.send({
					message: "A",
					attachmentIds: [],
					attachments: [],
					pendingAttachments: [],
				});
			await vi.waitFor(() => expect(runtime.snapshot().isSending).toBe(false));
			expect(runtime.snapshot().canRetry).toBe(false);
			const held = made.messages.at(-1);
			expect(held?.id).toBe(saved.id);
			expect(held?.content).toBe(saved.content);
			expect(held?.normalChatFinalization).toEqual(normalChatFinalization);
			const view = held && normalChatOutputView(held);
			expect(view?.completion?.outcome).toBe(wasStopped ? "stopped" : "failed");
			expect(view?.modelCompletion).toEqual(modelCompletion);
			expect(view?.activity[0].text).toBe("Working activity");
			await runtime.retry();
			expect(fetch).toHaveBeenCalledTimes(mode === "reload" ? 0 : 1);
			expect(made.adapters.pollForCompletion).not.toHaveBeenCalled();
			if (mode !== "reload")
				expect(made.adapters.restorePayloadToDraft).toHaveBeenCalledWith(
					expect.objectContaining({ message: "Queued B" }),
				);
		} finally {
			runtime.detach();
			vi.unstubAllGlobals();
		}
	});

	it.each([
		"direct",
		"observer",
		"reload",
		"polling",
		"reconnect-error",
	] as const)("offers explicit Retry for a saved failed completion through %s transport settlement", async (mode) => {
		const { streamChat } = await import("$lib/services/streaming");
		const { endEvent, errorEvent, uiFrame } = await import(
			"$lib/services/streaming.test-helpers"
		);
		const scope = {
			version: 1,
			turnId: "failed-turn",
			segmentId: "failed-segment",
			attemptId: "a",
			stepId: "w",
			phase: "working",
		} as const;
		const completion = {
			version: 1,
			turnId: scope.turnId,
			segmentId: scope.segmentId,
			phase: "working",
			outcome: "failed",
			stopCause: "transport_error",
			workingStopCause: "transport_error",
			closingAttempted: false,
		} as const;
		const events = [
			{
				...scope,
				sequence: 0,
				type: "block_start",
				blockId: "b",
				nativeId: "n",
				kind: "text",
				role: "provisional",
			},
			{
				...scope,
				sequence: 1,
				type: "block_delta",
				blockId: "b",
				text: "Attempted work",
			},
			{ ...scope, sequence: 2, type: "completion", completion },
		] satisfies import("$lib/shared/normal-chat-output").NormalChatOutputEvent[];
		const user = {
			id: "saved-user",
			role: "user",
			content: "A",
			timestamp: 1,
		} satisfies ChatMessage;
		const failed = {
			id: "saved-failed",
			role: "assistant",
			content: "",
			timestamp: 1,
			normalChatOutput: { version: 1, events },
		} satisfies ChatMessage;
		const made = makeAdapters({
			schedule: vi.fn((callback, delay) => setTimeout(callback, delay)),
			streamChat,
			checkForOrphanedStream: vi.fn(async () =>
				mode === "observer" || mode === "reconnect-error"
					? "observed-failed"
					: null,
			),
			getStreamBufferInfo: vi.fn(async () => ({
				exists: true,
				userMessage: "A",
			})),
			readChatMessages: vi.fn(async () => [user, failed]),
		});
		const runtime = createNormalChatClientTurnRuntime(made.adapters);
		const fetch = vi.fn(async () => {
			if (mode === "direct")
				runtime.queue({
					message: "Queued B",
					attachmentIds: [],
					attachments: [],
					pendingAttachments: [],
				});
			return new Response(
				mode === "reconnect-error"
					? errorEvent({ message: "The model failed", code: "provider_error" })
					: mode === "observer"
						? endEvent({
								observation: {
									version: 1,
									streamId: "observed-failed",
									conversationId: "conv-1",
									state: "terminal",
									assistantMessageId: failed.id,
									completion,
								},
							})
						: events
								.map((data) =>
									uiFrame({ type: "data-normal-chat-output", data }),
								)
								.join("") +
							endEvent({ assistantMessageId: failed.id, finalContent: "" }),
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		});
		vi.mocked(made.adapters.loadPersistedData).mockImplementation(async () => {
			made.messages.splice(0, made.messages.length, user, failed);
			runtime.completePollingRecovery();
		});
		vi.stubGlobal("fetch", fetch);
		try {
			if (mode === "reload" || mode === "polling") {
				made.messages.push(user, failed);
				if (mode === "polling") runtime.completePollingRecovery();
				else await runtime.checkForOrphanedStreamOnMount();
			} else {
				if (mode === "observer" || mode === "reconnect-error") {
					made.messages.push(user);
					await runtime.checkForOrphanedStreamOnMount();
				} else
					await runtime.send({
						message: "A",
						attachmentIds: [],
						attachments: [],
						pendingAttachments: [],
					});
				await vi.waitFor(() =>
					expect(runtime.snapshot().isSending).toBe(false),
				);
			}
			expect(runtime.snapshot()).toMatchObject({
				canRetry: true,
				lastUserMessage: "A",
			});
			expect(made.adapters.setSendError).toHaveBeenLastCalledWith(
				"Chat reply failed.",
			);
			expect(made.messages.at(-1)?.id).toBe(failed.id);
			expect(
				normalChatOutputView(made.messages[made.messages.length - 1])
					?.activity[0].text,
			).toBe("Attempted work");
			expect(fetch).toHaveBeenCalledTimes(
				mode === "reload" || mode === "polling" ? 0 : 1,
			);
			if (mode === "direct")
				expect(made.adapters.restorePayloadToDraft).toHaveBeenCalledWith(
					expect.objectContaining({ message: "Queued B" }),
				);
			vi.mocked(made.adapters.checkForOrphanedStream).mockResolvedValue(null);
			// Only a deliberate Retry replaces the failed row; no automatic tool replay.
			let finishRetry!: (response: Response) => void;
			fetch.mockImplementation(
				() =>
					new Promise<Response>((resolve) => {
						finishRetry = resolve;
					}),
			);
			await Promise.all([runtime.retry(), runtime.retry()]);
			expect(fetch).toHaveBeenCalledTimes(
				mode === "reload" || mode === "polling" ? 1 : 2,
			);
			const [url, init] = vi.mocked(globalThis.fetch).mock.calls.at(-1) ?? [];
			expect(url).toBe("/api/chat/retry");
			expect(JSON.parse(String(init?.body))).toMatchObject({
				assistantMessageId: failed.id,
				userMessageId: made.messages[0].id,
				retryOrigin: "error_retry",
				userMessage: "A",
			});
			expect(made.messages.filter((row) => row.role === "user")).toHaveLength(
				1,
			);
			finishRetry(
				new Response(
					endEvent({
						assistantMessageId: "fresh-answer",
						finalContent: "Fresh answer",
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				),
			);
			await vi.waitFor(() => expect(runtime.snapshot().isSending).toBe(false));
			expect(runtime.snapshot().canRetry).toBe(false);
			expect(made.messages.at(-1)?.id).toBe("fresh-answer");
			expect(
				made.messageListEvents.finalizeStreamingMessage,
			).toHaveBeenLastCalledWith(
				expect.objectContaining({
					metadata: expect.objectContaining({
						assistantMessageId: "fresh-answer",
						finalContent: "Fresh answer",
					}),
				}),
			);
		} finally {
			runtime.detach();
			vi.unstubAllGlobals();
		}
	});

	it("settles a real abandoned ledger through observer wire, browser decoder and client runtime", async () => {
		const { createHash } = await import("node:crypto");
		const { db } = await import("$lib/server/db");
		const { users, conversations } = await import("$lib/server/db/schema");
		const { eq } = await import("drizzle-orm");
		const { admitTurn } = await import(
			"$lib/server/services/chat-turn/turn-ledger"
		);
		const { doReconnect } = await import(
			"$lib/server/services/chat-turn/stream-reconnect"
		);
		const { streamChat } = await import("$lib/services/streaming");
		const userId = "whole-client-synthetic-user";
		const conversationId = "whole-client-synthetic-conversation";
		const requestId = "whole-client-abandoned";
		db.insert(users)
			.values({
				id: userId,
				email: "whole-client@test.invalid",
				passwordHash: "synthetic",
			})
			.run();
		db.insert(conversations)
			.values({ id: conversationId, userId, title: "Synthetic" })
			.run();
		try {
			const segmentId = createHash("sha256")
				.update(JSON.stringify([userId, conversationId, requestId]))
				.digest("hex");
			admitTurn({
				userId,
				conversationId,
				turnId: "whole-client-turn",
				segmentId,
				ownerId: "lost-process",
			});
			const made = makeAdapters({ getConversationId: () => conversationId });
			const runtime = createNormalChatClientTurnRuntime(made.adapters);
			await runtime.reconnectToOrphanedStream(requestId, "A");
			const callbacks = made.streamInvocations[0].callbacks;
			const output = createNormalChatOutputAccumulator();
			const scope = {
				version: 1,
				turnId: "whole-client-turn",
				segmentId,
				attemptId: "a",
				stepId: "w",
				phase: "working",
			} as const;
			output.apply({
				...scope,
				sequence: 0,
				type: "block_start",
				blockId: "w",
				nativeId: "w",
				kind: "text",
				role: "activity",
			});
			output.apply({
				...scope,
				sequence: 1,
				type: "block_delta",
				blockId: "w",
				text: "Working commentary",
			});
			output.apply({
				...scope,
				stepId: "c",
				phase: "closing",
				sequence: 2,
				type: "block_start",
				blockId: "c",
				nativeId: "c",
				kind: "text",
				role: "answer",
			});
			output.apply({
				...scope,
				stepId: "c",
				phase: "closing",
				sequence: 3,
				type: "block_delta",
				blockId: "c",
				text: "Partial 42",
			});
			callbacks.onNormalChatOutput?.(output.getProjection());
			const frames: string[] = [];
			await doReconnect(requestId, {
				userId,
				conversationId,
				enqueueChunk: (chunk) => {
					frames.push(chunk);
					return true;
				},
				closeDownstream: vi.fn(),
				downstreamAbortSignal: new AbortController().signal,
				getStreamBuffer: () => undefined,
				subscribeToStream: vi.fn(() => false),
				unsubscribeFromStream: vi.fn(),
				createSsePreludeComment: () => ": prelude\n\n",
				createSseHeartbeatComment: () => ": heartbeat\n\n",
			});
			vi.stubGlobal(
				"fetch",
				vi.fn(
					async () =>
						new Response(frames.join(""), {
							headers: { "Content-Type": "text/event-stream" },
						}),
				),
			);
			streamChat("A", conversationId, callbacks, {
				reconnectToStreamId: requestId,
			});
			await vi.waitFor(() => expect(runtime.snapshot().isSending).toBe(false));
			expect(made.adapters.pollForCompletion).not.toHaveBeenCalled();
			const held = made.messages.at(-1);
			expect(held?.content).toBe("Partial 42");
			const view = held && normalChatOutputView(held);
			expect(view?.activity[0].text).toBe("Working commentary");
			expect(view?.completion).toMatchObject({
				outcome: "incomplete",
				stopCause: "uncertain_execution",
			});
		} finally {
			vi.unstubAllGlobals();
			db.delete(users).where(eq(users.id, userId)).run();
		}
	});

	it("a stale recovery preserves A partial and B progress before any removal", async () => {
		vi.useFakeTimers();
		let resolveInfo!: (value: { exists: boolean; userMessage: string }) => void;
		const { adapters, streamInvocations, messageListEvents } = makeAdapters({
			schedule: vi.fn((callback, delay) => setTimeout(callback, delay)),
			checkForOrphanedStream: vi.fn(async () => "stream-A"),
			getStreamBufferInfo: vi.fn(
				() =>
					new Promise<{ exists: boolean; userMessage: string }>((resolve) => {
						resolveInfo = resolve;
					}),
			),
		});
		const runtime = createNormalChatClientTurnRuntime(adapters);
		await runtime.send({
			message: "A",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});
		streamInvocations[0].callbacks.onToken("A partial");
		streamInvocations[0].callbacks.onError(new Error("Failed to fetch"));
		await vi.advanceTimersByTimeAsync(500);
		await runtime.send({
			message: "B",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});
		streamInvocations[1].callbacks.onToken("B progress");
		const before = runtime.snapshot();
		messageListEvents.removeMessage.mockClear();
		resolveInfo({ exists: true, userMessage: "A" });
		await Promise.resolve();
		await Promise.resolve();
		expect(messageListEvents.removeMessage).not.toHaveBeenCalled();
		expect(runtime.snapshot()).toEqual(before);
		expect(streamInvocations).toHaveLength(2);
		vi.useRealTimers();
	});

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

	// A page that is left (`detach()`: it is destroyed, or the chat is switched) leaves
	// work behind that answers later: a backoff or recovery timer, a look at the
	// server, a Retry's reads, the load of the chat. None of it may start a stream, a
	// wait or a sign for the shell from a page nobody sees, and none of it brings the
	// page back: only an entry point the page calls does (a send, a Retry, the
	// reconnect on mount), at its start, before it awaits anything.
	describe("work that is out when the page is left", () => {
		const aSend = (message: string) => ({
			message,
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});
		const capacityRefusal = () =>
			Object.assign(new Error("Server at capacity"), {
				status: 503,
				code: "CAPACITY_EXCEEDED",
				reason: "global_limit",
			});
		/** A question the test answers when it chooses. */
		function answerLater<T>() {
			let answer: (value: T) => void = () => {};
			const question = new Promise<T>((resolve) => {
				answer = resolve;
			});
			return { question, answer: (value: T) => answer(value) };
		}
		/** A clock the test advances, with the wait and the shell's sign watched. */
		function onTheClock(
			overrides: Partial<NormalChatClientTurnRuntimeAdapters> = {},
		) {
			vi.useFakeTimers();
			return makeAdapters({
				schedule: vi.fn((callback, delay) => setTimeout(callback, delay)),
				setTurnWaitingForUpdate: vi.fn(),
				onServerUpdateSign: vi.fn(),
				...overrides,
			});
		}
		/** A clock that never runs out: the questions a Retry asks are bounded on `schedule`, which the adapters' default fires at once. */
		const patientClock = () =>
			vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>);
		/** A reply that streamed some text and lost its connection: the recovery is scheduled. */
		async function cutAfterSomeText(
			made: ReturnType<typeof makeAdapters>,
			runtime: ReturnType<typeof createNormalChatClientTurnRuntime>,
		) {
			await runtime.send(aSend("Write"));
			made.streamInvocations[0].callbacks.onToken("Half");
			made.streamInvocations[0].callbacks.onError(
				new TypeError("network error"),
			);
			expect(made.adapters.schedule).toHaveBeenCalledWith(
				expect.any(Function),
				500,
			);
		}

		afterEach(() => {
			vi.useRealTimers();
		});

		it("sends nothing from a capacity backoff that was scheduled before", async () => {
			const { adapters, streamInvocations } = onTheClock();
			const runtime = createNormalChatClientTurnRuntime(adapters);
			await runtime.send(aSend("Hello"));
			streamInvocations[0].callbacks.onError(capacityRefusal());
			expect(adapters.schedule).toHaveBeenCalledWith(expect.any(Function), 500);

			runtime.detach();
			await vi.advanceTimersByTimeAsync(500);

			expect(streamInvocations).toHaveLength(1);
		});

		it("looks for no stream, joins none and starts no wait from a recovery that was scheduled before", async () => {
			const made = onTheClock({
				checkForOrphanedStream: vi.fn(async () => "stream-1"),
				askServerUpdate: vi.fn(
					async (): Promise<ServerUpdateKind> => "restarting",
				),
			});
			const { adapters, streamInvocations, messageListEvents } = made;
			const runtime = createNormalChatClientTurnRuntime(adapters);
			await cutAfterSomeText(made, runtime);

			// The page is destroyed: it detaches, then takes the wait (there is none).
			runtime.detach();
			expect(runtime.takeWaitingRequest()).toBeNull();
			await vi.advanceTimersByTimeAsync(8 * 60 * 1000);

			expect(adapters.checkForOrphanedStream).not.toHaveBeenCalled();
			expect(streamInvocations).toHaveLength(1);
			expect(messageListEvents.removeMessage).not.toHaveBeenCalled();
			expect(adapters.setTurnWaitingForUpdate).not.toHaveBeenCalled();
			expect(adapters.onServerUpdateSign).not.toHaveBeenCalled();
		});

		it("joins no stream that the look finds after the page was left, and keeps the partial reply", async () => {
			const look = answerLater<string | null>();
			const made = onTheClock({
				checkForOrphanedStream: vi.fn(() => look.question),
			});
			const { adapters, streamInvocations, messageListEvents } = made;
			const runtime = createNormalChatClientTurnRuntime(adapters);
			await cutAfterSomeText(made, runtime);
			await vi.advanceTimersByTimeAsync(500);
			expect(adapters.checkForOrphanedStream).toHaveBeenCalledTimes(1);

			runtime.detach();
			look.answer("stream-1");
			await vi.advanceTimersByTimeAsync(0);

			expect(adapters.getStreamBufferInfo).not.toHaveBeenCalled();
			expect(messageListEvents.removeMessage).not.toHaveBeenCalled();
			expect(streamInvocations).toHaveLength(1);
		});

		it("does not swap the partial reply for a replay when the page was left while the stream was described", async () => {
			const described = answerLater<{ exists: boolean; userMessage: string }>();
			const made = onTheClock({
				checkForOrphanedStream: vi.fn(async () => "stream-1"),
				getStreamBufferInfo: vi.fn(() => described.question),
			});
			const { adapters, streamInvocations, messageListEvents } = made;
			const runtime = createNormalChatClientTurnRuntime(adapters);
			await cutAfterSomeText(made, runtime);
			await vi.advanceTimersByTimeAsync(500);
			expect(adapters.getStreamBufferInfo).toHaveBeenCalledTimes(1);

			runtime.detach();
			described.answer({ exists: true, userMessage: "Write" });
			await vi.advanceTimersByTimeAsync(0);

			expect(messageListEvents.removeMessage).not.toHaveBeenCalled();
			expect(streamInvocations).toHaveLength(1);
		});

		it("retries no reconnect whose backoff was scheduled before", async () => {
			const { adapters, streamInvocations } = onTheClock();
			const runtime = createNormalChatClientTurnRuntime(adapters);
			await runtime.reconnectToOrphanedStream("stream-1", "Resume me");
			streamInvocations[0].callbacks.onError(capacityRefusal());
			expect(adapters.schedule).toHaveBeenCalledWith(expect.any(Function), 500);

			runtime.detach();
			await vi.advanceTimersByTimeAsync(500);

			expect(streamInvocations).toHaveLength(1);
		});

		it("is not brought back by a reconnect: the runtime's own join starts nothing", async () => {
			const { adapters, streamInvocations } = makeAdapters();
			const runtime = createNormalChatClientTurnRuntime(adapters);
			runtime.reset();

			expect(
				await runtime.reconnectToOrphanedStream("stream-1", "Resume me"),
			).toBe(false);

			expect(streamInvocations).toHaveLength(0);
		});

		it("is not brought back by the queue either: a message queued behind the turn is not sent", async () => {
			const { adapters, streamInvocations } = makeAdapters();
			const runtime = createNormalChatClientTurnRuntime(adapters);
			await runtime.send(aSend("Still going"));
			runtime.queue(aSend("Queued behind it"));
			runtime.detach();

			await runtime.drainPostTurnQueue();

			expect(streamInvocations).toHaveLength(1);
			expect(runtime.snapshot().queuedTurn?.message).toBe("Queued behind it");
		});

		it("joins nothing when the tab comes back to a page that was left", async () => {
			let browserHidden = true;
			const { adapters, streamInvocations } = makeAdapters({
				isBrowserHidden: vi.fn(() => browserHidden),
				checkForOrphanedStream: vi.fn(async () => "stream-1"),
			});
			const runtime = createNormalChatClientTurnRuntime(adapters);
			await runtime.send(aSend("Write"));
			const backgrounded = new Error("backgrounded");
			backgrounded.name = "AbortError";
			streamInvocations[0].callbacks.onError(backgrounded);
			expect(runtime.snapshot().streamInterruptedByBackground).toBe(true);
			runtime.detach();

			browserHidden = false;
			await runtime.handleVisibilityVisible();

			expect(adapters.checkForOrphanedStream).toHaveBeenCalledWith("conv-1");
			expect(streamInvocations).toHaveLength(1);
		});

		it("shows no failure for a reconnected turn whose chat was being loaded when the page was left", async () => {
			const load = answerLater<void>();
			const { adapters, streamInvocations } = makeAdapters({
				loadPersistedData: vi.fn(() => load.question),
			});
			const runtime = createNormalChatClientTurnRuntime(adapters);
			await runtime.reconnectToOrphanedStream("stream-1", "Resume me");
			streamInvocations[0].callbacks.onError(new Error("It failed."));
			await vi.waitFor(() =>
				expect(adapters.loadPersistedData).toHaveBeenCalledTimes(1),
			);

			runtime.detach();
			load.answer();
			await vi.waitFor(() => expect(runtime.snapshot().isSending).toBe(false));

			expect(adapters.setSendError).not.toHaveBeenCalledWith("It failed.");
			expect(runtime.snapshot().canRetry).toBe(false);
		});

		describe("a Retry that is out", () => {
			const savedList = (): ChatMessage[] => [
				{ id: "user-saved", role: "user", content: "Write", timestamp: 1 },
				{
					id: "assistant-saved",
					role: "assistant",
					content: "A",
					timestamp: 2,
				},
			];

			it("takes nothing off the list and starts nothing when the page is left while it asks", async () => {
				const look = answerLater<string | null>();
				const { adapters, streamInvocations, messages, messageListEvents } =
					makeAdapters({
						schedule: patientClock(),
						checkForOrphanedStream: vi.fn(() => look.question),
					});
				const runtime = createNormalChatClientTurnRuntime(adapters);
				await runtime.send(aSend("Write"));
				streamInvocations[0].callbacks.onError(new Error("Network failed"));
				// The server kept the turn, and the page read it back: the list ends in a reply.
				messages.length = 0;
				messages.push(...savedList());
				messageListEvents.removeMessage.mockClear();

				const pressed = runtime.retry();
				runtime.detach();
				look.answer(null);
				await pressed;

				expect(streamInvocations).toHaveLength(1);
				expect(messageListEvents.removeMessage).not.toHaveBeenCalled();
				expect(messages.map((message) => message.id)).toEqual([
					"user-saved",
					"assistant-saved",
				]);
			});

			it("loads no chat when the page is left while the server is asked what it holds", async () => {
				const read = answerLater<ChatMessage[] | null>();
				const { adapters, streamInvocations } = makeAdapters({
					schedule: patientClock(),
					readChatMessages: vi.fn(() => read.question),
				});
				const runtime = createNormalChatClientTurnRuntime(adapters);
				await runtime.send(aSend("Write"));
				streamInvocations[0].callbacks.onError(new Error("Network failed"));

				const pressed = runtime.retry();
				runtime.detach();
				read.answer(savedList());
				await pressed;

				expect(adapters.loadPersistedData).not.toHaveBeenCalled();
				expect(streamInvocations).toHaveLength(1);
			});

			it("is an entry point: a page that presses it is there, and sends the message again", async () => {
				const { adapters, streamInvocations } = makeAdapters();
				const runtime = createNormalChatClientTurnRuntime(adapters);
				await runtime.send(aSend("Write"));
				streamInvocations[0].callbacks.onError(new Error("Network failed"));
				runtime.detach();

				await runtime.retry();

				expect(streamInvocations).toHaveLength(2);
				expect(streamInvocations[1].message).toBe("Write");
			});
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
		// The restart: the proxy answers instead of the app. A server that cannot be
		// reached at all says nothing, and a wait keeps waiting through it.
		const AWAY: ServerHealth = { state: "proxy_down" };
		const UNREACHABLE: ServerHealth = { state: "unreachable" };
		const DRAINING: ServerHealth = { state: "draining" };
		const WELL: ServerHealth = { state: "up" };

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

		// A wait cannot tell a server that cannot be reached from the restart (it is
		// what the restart looks like from a phone), so it keeps waiting through it, and
		// ends only when the server says it is up.
		it("keeps waiting while the server cannot be reached, and ends only when it says it is up", async () => {
			const { adapters, streamInvocations, messages, server } =
				updateAdapters();
			const runtime = createNormalChatClientTurnRuntime(adapters);

			await runtime.send(words());
			streamInvocations[0].callbacks.onError(refusedAsDraining());

			for (const health of [UNREACHABLE, DRAINING, AWAY, UNREACHABLE]) {
				server.health = health;
				await vi.advanceTimersByTimeAsync(POLL_MS * 2);
				expect(streamInvocations).toHaveLength(1);
				expect(messages[1].runtimePhase).toBe("awaiting_update");
			}

			server.health = WELL;
			await vi.advanceTimersByTimeAsync(POLL_MS);
			expect(streamInvocations).toHaveLength(2);
			expect(sentenceShown(adapters)).toEqual([]);
		});

		// A regenerate, "Answer now" and a Retry go through the retry route, which turns
		// a draining server's request away as the stream route does.
		it("waits for a regenerate the same way and asks for the same reply again, once the server is up", async () => {
			const { adapters, streamInvocations, messages, server } =
				updateAdapters();
			const runtime = createNormalChatClientTurnRuntime(adapters);
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
			expect(sentenceShown(adapters)).toEqual([]);
			server.health = WELL;
			await vi.advanceTimersByTimeAsync(POLL_MS);

			expect(streamInvocations).toHaveLength(2);
			expect(streamInvocations[1].options).toBe(streamInvocations[0].options);
			expect(streamInvocations[1].options?.retryAssistantMessageId).toBe(
				"assistant-old",
			);
			expect(streamInvocations[1].options?.retryUserMessageId).toBe("user-1");
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

		// `/api/chat/send` takes an Atlas turn through a drain (its job is recovered
		// after the restart); it is the restart itself that answers the proxy's page.
		// The server de-duplicates the kickoff by `clientAtlasTurnId`, so the turn waits
		// like a message that was turned away and is submitted again under the same id.
		describe("an Atlas kickoff turned away by the restart", () => {
			const atlasWords = (
				clientAtlasTurnId: string | null = "client-atlas-1",
			) => ({
				...words("Research the market"),
				atlasMode: true,
				atlasProfile: "in-depth" as const,
				atlasAction: "create" as const,
				clientAtlasTurnId,
			});

			function atlasAdapters(
				overrides: Partial<NormalChatClientTurnRuntimeAdapters> = {},
			) {
				const atlas = { down: true };
				const made = updateAdapters({
					submitAtlasTurn: vi.fn(async () => {
						if (atlas.down) throw refusedByTheProxy();
						return {
							message: "Atlas is queued.",
							atlasJob: atlasJobFixture(),
						};
					}),
					...overrides,
				});
				return { ...made, atlas };
			}

			it("waits in awaiting_update with both bubbles, and tells the shell", async () => {
				const made = atlasAdapters();
				const runtime = createNormalChatClientTurnRuntime(made.adapters);

				await runtime.send(atlasWords());

				expect(made.messages.map((message) => message.role)).toEqual([
					"user",
					"assistant",
				]);
				expect(made.messages[1].runtimePhase).toBe("awaiting_update");
				expect(sentenceShown(made.adapters)).toEqual([]);
				expect(made.adapters.restorePayloadToDraft).not.toHaveBeenCalled();
				expect(made.adapters.onServerUpdateSign).toHaveBeenCalledTimes(1);
				expect(made.adapters.setTurnWaitingForUpdate).toHaveBeenLastCalledWith(
					true,
				);
				expect(runtime.snapshot()).toMatchObject({
					phase: "awaiting_update",
					isSending: true,
				});
			});

			it("is submitted again under the same clientAtlasTurnId once the server is up, and starts as it would have", async () => {
				const made = atlasAdapters();
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await runtime.send(atlasWords());

				made.atlas.down = false;
				made.server.health = DRAINING;
				await vi.advanceTimersByTimeAsync(POLL_MS);
				expect(made.adapters.submitAtlasTurn).toHaveBeenCalledTimes(1);
				made.server.health = WELL;
				await vi.advanceTimersByTimeAsync(POLL_MS);

				expect(made.adapters.submitAtlasTurn).toHaveBeenCalledTimes(2);
				const [first, second] = vi
					.mocked(made.adapters.submitAtlasTurn)
					.mock.calls.map(([submitted]) => submitted);
				expect(second).toEqual(first);
				expect(second.clientAtlasTurnId).toBe("client-atlas-1");
				expect(made.messages[1]).toMatchObject({
					content: "Atlas is queued.",
					isStreaming: false,
				});
				expect(sentenceShown(made.adapters)).toEqual([]);
				expect(made.adapters.setTurnWaitingForUpdate).toHaveBeenLastCalledWith(
					false,
				);
				expect(made.adapters.hydrateConversationDetail).toHaveBeenCalledTimes(
					1,
				);
				expect(runtime.snapshot()).toMatchObject({
					isSending: false,
					canRetry: false,
				});
			});

			it("keeps the id the runtime made when the composer gave none", async () => {
				const made = atlasAdapters();
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await runtime.send(atlasWords(null));

				made.atlas.down = false;
				made.server.health = WELL;
				await vi.advanceTimersByTimeAsync(POLL_MS);

				const ids = vi
					.mocked(made.adapters.submitAtlasTurn)
					.mock.calls.map(([submitted]) => submitted.clientAtlasTurnId);
				expect(ids).toHaveLength(2);
				expect(ids[0]).toBeTruthy();
				expect(ids[1]).toBe(ids[0]);
			});

			it("ends on Stop as a kickoff that did not start: both bubbles go and the words return in Atlas mode, with no sentence", async () => {
				const made = atlasAdapters();
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await runtime.send(atlasWords());

				expect(runtime.stop()).toBe(true);

				expect(made.messages).toEqual([]);
				expect(made.adapters.restorePayloadToDraft).toHaveBeenCalledWith(
					expect.objectContaining({
						message: "Research the market",
						atlasMode: true,
						atlasProfile: "in-depth",
						clientAtlasTurnId: "client-atlas-1",
					}),
				);
				expect(sentenceShown(made.adapters)).toEqual([]);
				expect(made.adapters.setTurnWaitingForUpdate).toHaveBeenLastCalledWith(
					false,
				);
				expect(runtime.snapshot()).toMatchObject({
					isSending: false,
					phase: "idle",
					canRetry: false,
				});
				made.atlas.down = false;
				made.server.health = WELL;
				await vi.advanceTimersByTimeAsync(POLL_MS * 3);
				expect(made.adapters.submitAtlasTurn).toHaveBeenCalledTimes(1);
			});

			it("ends at the cap the same way, with the sentence for a wait that did not end", async () => {
				const made = atlasAdapters();
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await runtime.send(atlasWords());

				await vi.advanceTimersByTimeAsync(EIGHT_MINUTES_MS);

				expect(sentenceShown(made.adapters)).toEqual([
					"chat.updateStillRunning",
				]);
				expect(made.messages).toEqual([]);
				expect(made.adapters.restorePayloadToDraft).toHaveBeenCalledWith(
					expect.objectContaining({ atlasMode: true }),
				);
				expect(runtime.snapshot()).toMatchObject({
					isSending: false,
					canRetry: false,
				});
			});

			// The composer queues what is sent while the kickoff is out and while it waits.
			// Nothing drains that queue when the kickoff ends without a reply.
			it("gives a message queued behind the kickoff back to the composer, behind the kickoff's words, on Stop", async () => {
				const made = atlasAdapters();
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await runtime.send(atlasWords());
				runtime.queue(words("Queued behind the kickoff"));

				runtime.stop();

				expect(
					vi
						.mocked(made.adapters.restorePayloadToDraft)
						.mock.calls.map(([restored]) => restored.message),
				).toEqual(["Research the market", "Queued behind the kickoff"]);
				expect(runtime.snapshot()).toMatchObject({
					isSending: false,
					queuedTurn: null,
				});
				await vi.advanceTimersByTimeAsync(60_000);
				expect(made.adapters.submitAtlasTurn).toHaveBeenCalledTimes(1);
				expect(made.streamInvocations).toHaveLength(0);
			});

			it("gives it back at the cap too, and runs a context compression queued meanwhile", async () => {
				const made = atlasAdapters();
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await runtime.send(atlasWords());
				runtime.queue(words("Queued behind the kickoff"));
				runtime.compact();

				await vi.advanceTimersByTimeAsync(EIGHT_MINUTES_MS);

				expect(sentenceShown(made.adapters)).toEqual([
					"chat.updateStillRunning",
				]);
				expect(
					vi
						.mocked(made.adapters.restorePayloadToDraft)
						.mock.calls.map(([restored]) => restored.message),
				).toEqual(["Research the market", "Queued behind the kickoff"]);
				expect(runtime.snapshot()).toMatchObject({
					isSending: false,
					queuedTurn: null,
					queuedContextCompression: false,
				});
				expect(made.adapters.runManualContextCompression).toHaveBeenCalledTimes(
					1,
				);
			});

			it("gives it back when the kickoff fails for a reason that is not an update, too", async () => {
				const made = atlasAdapters({
					submitAtlasTurn: vi.fn(async () => {
						throw Object.assign(new Error("Atlas is currently disabled."), {
							status: 503,
							code: "ATLAS_DISABLED",
						});
					}),
				});
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				const sending = runtime.send(atlasWords());
				// The composer queues while the submit is out.
				runtime.queue(words("Queued behind the kickoff"));
				await sending;

				expect(
					vi
						.mocked(made.adapters.restorePayloadToDraft)
						.mock.calls.map(([restored]) => restored.message),
				).toEqual(["Research the market", "Queued behind the kickoff"]);
				expect(runtime.snapshot().queuedTurn).toBeNull();
			});

			it("hands its words to a page that is being left, and submits nothing", async () => {
				const made = atlasAdapters();
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await runtime.send(atlasWords());

				runtime.detach();
				made.atlas.down = false;
				made.server.health = WELL;
				await vi.advanceTimersByTimeAsync(POLL_MS * 3);

				expect(made.adapters.submitAtlasTurn).toHaveBeenCalledTimes(1);
				expect(runtime.takeWaitingRequest()).toMatchObject({
					message: "Research the market",
					atlasMode: true,
					clientAtlasTurnId: "client-atlas-1",
				});
			});

			it("fails like any other kickoff after being sent again three times and refused each time", async () => {
				const made = atlasAdapters();
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				made.server.health = WELL;

				await runtime.send(atlasWords());
				for (let sent = 0; sent < 3; sent += 1) {
					await vi.advanceTimersByTimeAsync(POLL_MS);
				}

				expect(made.adapters.submitAtlasTurn).toHaveBeenCalledTimes(4);
				expect(sentenceShown(made.adapters)).toEqual([
					refusedByTheProxy().message,
				]);
				expect(made.messages).toEqual([]);
				expect(made.adapters.restorePayloadToDraft).toHaveBeenCalledTimes(1);
				expect(runtime.snapshot()).toMatchObject({
					isSending: false,
					canRetry: false,
				});
			});

			it("does not wait for a failure that is not an update: it fails as it did", async () => {
				const made = atlasAdapters({
					submitAtlasTurn: vi.fn(async () => {
						throw Object.assign(new Error("Atlas is currently disabled."), {
							status: 503,
							code: "ATLAS_DISABLED",
						});
					}),
				});
				const runtime = createNormalChatClientTurnRuntime(made.adapters);

				await runtime.send(atlasWords());

				expect(sentenceShown(made.adapters)).toEqual([
					"Atlas is currently disabled.",
				]);
				expect(made.adapters.onServerUpdateSign).not.toHaveBeenCalled();
				expect(made.adapters.restorePayloadToDraft).toHaveBeenCalledTimes(1);
				expect(made.messages).toEqual([]);
			});
		});

		// A tab that sleeps (a phone locked in a pocket) wakes to find the cap passed.
		// The poll that would have noticed the server was back never ran, so the cap
		// asks once more before it gives up.
		describe("at the cap", () => {
			it("asks the server once more, and sends the request when it is back", async () => {
				const { adapters, streamInvocations, server } = updateAdapters();
				const runtime = createNormalChatClientTurnRuntime(adapters);
				await runtime.send(words());
				streamInvocations[0].callbacks.onError(refusedAsDraining());

				// The server is away for the whole wait, and the last poll before the cap
				// was a moment before it came back.
				await vi.advanceTimersByTimeAsync(EIGHT_MINUTES_MS - 100);
				server.health = WELL;
				await vi.advanceTimersByTimeAsync(100);

				expect(sentenceShown(adapters)).toEqual([]);
				expect(streamInvocations).toHaveLength(2);
				expect(streamInvocations[1].message).toBe("Hello during an update");
				expect(adapters.setTurnWaitingForUpdate).toHaveBeenLastCalledWith(
					false,
				);
			});

			it("gives up only if that look finds the server still not back", async () => {
				const { adapters, streamInvocations, messages } = updateAdapters();
				const runtime = createNormalChatClientTurnRuntime(adapters);
				await runtime.send(words());
				streamInvocations[0].callbacks.onError(refusedAsDraining());
				const looksBefore = () =>
					vi.mocked(adapters.fetchServerHealth).mock.calls.length;

				await vi.advanceTimersByTimeAsync(EIGHT_MINUTES_MS - 1);
				const looked = looksBefore();
				await vi.advanceTimersByTimeAsync(1);

				// One more look, at the cap, and it found the server still draining.
				expect(looksBefore()).toBe(looked + 1);
				expect(sentenceShown(adapters)).toEqual(["chat.updateStillRunning"]);
				expect(messages.map((message) => message.role)).toEqual(["user"]);
			});

			it("takes a tab that slept past the cap, and woke to timers that are all overdue at once, for a server that is back", async () => {
				// A phone tab frozen in the background: nothing runs while it is frozen,
				// and on resume every overdue timer runs in due order, each as its own
				// task, while a network answer needs a later task.
				const timers: Array<{ at: number; seq: number; callback: () => void }> =
					[];
				let now = 0;
				let seq = 0;
				const answers: Array<(health: ServerHealth) => void> = [];
				const { adapters, streamInvocations } = updateAdapters({
					schedule: vi.fn((callback, delay) => {
						timers.push({ at: now + delay, seq: seq++, callback });
						return seq as unknown as ReturnType<typeof setTimeout>;
					}),
					fetchServerHealth: vi.fn(
						() =>
							new Promise<ServerHealth>((resolve) => {
								answers.push(resolve);
							}),
					),
				});
				const runtime = createNormalChatClientTurnRuntime(adapters);
				await runtime.send(words());
				streamInvocations[0].callbacks.onError(refusedAsDraining());

				// The phone wakes 12 minutes later; the update ended at minute 5.
				now = 12 * 60 * 1000;
				for (;;) {
					timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
					const next = timers[0];
					if (!next || next.at > now) break;
					timers.shift();
					next.callback();
					for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
				}
				// Every question is out on the network, and nothing has been decided.
				expect(answers.length).toBeGreaterThanOrEqual(2);
				expect(sentenceShown(adapters)).toEqual([]);

				for (const answer of answers.splice(0)) answer(WELL);
				for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();

				expect(sentenceShown(adapters)).toEqual([]);
				expect(streamInvocations).toHaveLength(2);
			});
		});

		// The page was left (Home, Settings) while a refusal, or the question about a
		// cut reply, was still out. `isTurnConversationActive` stays true for a page
		// that is destroyed, so it is the runtime's own `detach()` that stops a wait,
		// a resend and a sign for the shell from starting on a page nobody sees.
		describe("a refusal that arrives after the page was left", () => {
			it("starts no wait, tells the shell nothing and sends nothing", async () => {
				const { adapters, streamInvocations, server } = updateAdapters();
				const runtime = createNormalChatClientTurnRuntime(adapters);
				await runtime.send(words());

				runtime.detach();
				expect(runtime.takeWaitingRequest()).toBeNull();
				streamInvocations[0].callbacks.onError(refusedByTheProxy());
				server.health = WELL;
				await vi.advanceTimersByTimeAsync(EIGHT_MINUTES_MS);

				expect(adapters.onServerUpdateSign).not.toHaveBeenCalled();
				expect(adapters.setTurnWaitingForUpdate).not.toHaveBeenCalled();
				expect(adapters.fetchServerHealth).not.toHaveBeenCalled();
				expect(streamInvocations).toHaveLength(1);
			});

			it("is over for the next send of a page that is there: it waits as it always did", async () => {
				const { adapters, streamInvocations, messages, server } =
					updateAdapters();
				const runtime = createNormalChatClientTurnRuntime(adapters);
				await runtime.send(words("Left behind"));
				// A switch of chat: the page resets the runtime, and sends in the next chat.
				runtime.reset();

				await runtime.send(words("In the next chat"));
				streamInvocations[1].callbacks.onError(refusedAsDraining());

				expect(messages.at(-1)?.runtimePhase).toBe("awaiting_update");
				expect(adapters.onServerUpdateSign).toHaveBeenCalledTimes(1);
				server.health = WELL;
				await vi.advanceTimersByTimeAsync(POLL_MS);
				expect(streamInvocations).toHaveLength(3);
				expect(streamInvocations[2].message).toBe("In the next chat");
			});

			it("is over for a reconnect of a page that is there, too", async () => {
				const { adapters, streamInvocations, messages } = updateAdapters({
					askServerUpdate: vi.fn(
						async (): Promise<ServerUpdateKind> => "restarting",
					),
					checkForOrphanedStream: vi.fn(async () => "stream-1"),
					getStreamBufferInfo: vi.fn(async () => ({
						exists: true,
						userMessage: "Resume me",
					})),
				});
				const runtime = createNormalChatClientTurnRuntime(adapters);
				runtime.reset();

				// The page's reconnect on mount is an entry point: the page is here.
				expect(await runtime.checkForOrphanedStreamOnMount()).toBe(true);
				streamInvocations[0].callbacks.onError(new TypeError("network error"));
				await vi.advanceTimersByTimeAsync(0);

				expect(messages.at(-1)?.runtimePhase).toBe("awaiting_update");
				expect(adapters.onServerUpdateSign).toHaveBeenCalledTimes(1);
			});
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

			// The server holds a regenerate's message, and the page took the reply it
			// replaces off the screen when the request began. The request never ran, so
			// on Stop the chat is read back and the reply the server holds returns.
			describe("a regenerate, which the server knows, stopped while it waits", () => {
				const oldReply: ChatMessage = {
					id: "assistant-old",
					role: "assistant",
					content: "The old answer",
					timestamp: 2,
				};
				const question: ChatMessage = {
					id: "user-1",
					role: "user",
					content: "The old question",
					timestamp: 1,
				};

				async function waitingRegenerate(
					overrides: Partial<NormalChatClientTurnRuntimeAdapters> = {},
				) {
					const made = updateAdapters(overrides);
					const runtime = createNormalChatClientTurnRuntime(made.adapters);
					// The page took the reply it replaces off the list, and the question stays.
					made.messages.push({ ...question });
					await runtime.send(words("The old question"), {
						skipUserMessage: true,
						skipPersistUserMessage: true,
						retryAssistantMessageId: "assistant-old",
						retryUserMessageId: "user-1",
					});
					made.streamInvocations[0].callbacks.onError(refusedAsDraining());
					expect(made.messages.at(-1)?.runtimePhase).toBe("awaiting_update");
					return { ...made, runtime };
				}

				it("reads the chat back, so the reply the server holds returns, with no sentence and no words to restore", async () => {
					const made = await waitingRegenerate({
						readChatMessages: vi.fn(async () => [question, oldReply]),
						loadPersistedData: vi.fn(async () => {
							made.messages.length = 0;
							made.messages.push(question, oldReply);
						}),
					});

					expect(made.runtime.stop()).toBe(true);
					await vi.advanceTimersByTimeAsync(0);

					// The placeholder went, the chat was read, and the old reply is back.
					expect(made.adapters.readChatMessages).toHaveBeenCalledTimes(1);
					expect(made.adapters.loadPersistedData).toHaveBeenCalledTimes(1);
					expect(made.messages.map((message) => message.id)).toEqual([
						"user-1",
						"assistant-old",
					]);
					expect(made.adapters.restorePayloadToDraft).not.toHaveBeenCalled();
					expect(sentenceShown(made.adapters)).toEqual([]);
					expect(
						made.adapters.setTurnWaitingForUpdate,
					).toHaveBeenLastCalledWith(false);
					expect(made.runtime.snapshot()).toMatchObject({
						isSending: false,
						phase: "idle",
					});
					// And the request is not sent, whatever the server does.
					made.server.health = WELL;
					await vi.advanceTimersByTimeAsync(POLL_MS * 3);
					expect(made.streamInvocations).toHaveLength(1);
				});

				it("holds the turn state through the read, so a message sent meanwhile is queued, then sent after", async () => {
					let finishRead: (messages: ChatMessage[] | null) => void = () => {};
					const made = await waitingRegenerate({
						readChatMessages: vi.fn(
							() =>
								new Promise<ChatMessage[] | null>((resolve) => {
									finishRead = resolve;
								}),
						),
					});

					made.runtime.stop();
					expect(made.runtime.snapshot()).toMatchObject({ isSending: true });
					// The composer sees a turn that is not over: it queues.
					made.runtime.queue(words("Typed while the chat was being read"));
					expect(made.runtime.snapshot().queuedTurn?.message).toBe(
						"Typed while the chat was being read",
					);

					finishRead([question, oldReply]);
					await vi.advanceTimersByTimeAsync(0);

					expect(made.streamInvocations).toHaveLength(2);
					expect(made.streamInvocations[1].message).toBe(
						"Typed while the chat was being read",
					);
				});

				it("ends with the sentence for a wait that did not end, and Retry, when the chat cannot be read (the restart)", async () => {
					const made = await waitingRegenerate({
						readChatMessages: vi.fn(async () => null),
					});

					made.runtime.stop();
					await vi.advanceTimersByTimeAsync(0);

					expect(made.adapters.loadPersistedData).not.toHaveBeenCalled();
					expect(sentenceShown(made.adapters)).toEqual([
						"chat.updateStillRunning",
					]);
					expect(made.messages.map((message) => message.id)).toEqual([
						"user-1",
					]);
					expect(made.adapters.restorePayloadToDraft).not.toHaveBeenCalled();
					expect(made.runtime.snapshot()).toMatchObject({
						isSending: false,
						canRetry: true,
					});
				});

				// The composer queues what is sent while the chat is read back (the turn state
				// is held through the read). When the chat cannot be read nothing drains that
				// queue, so what was typed during the read must go back to the composer.
				it("gives a message queued while the chat was being read back to the composer when the chat cannot be read", async () => {
					let finishRead: (messages: ChatMessage[] | null) => void = () => {};
					const made = await waitingRegenerate({
						readChatMessages: vi.fn(
							() =>
								new Promise<ChatMessage[] | null>((resolve) => {
									finishRead = resolve;
								}),
						),
					});

					made.runtime.stop();
					made.runtime.queue(words("Typed during the read"));
					expect(made.runtime.snapshot().queuedTurn?.message).toBe(
						"Typed during the read",
					);
					finishRead(null);
					await vi.advanceTimersByTimeAsync(0);

					expect(sentenceShown(made.adapters)).toEqual([
						"chat.updateStillRunning",
					]);
					// Not stranded in the queue banner with no turn to send it, not sent.
					expect(made.runtime.snapshot()).toMatchObject({
						isSending: false,
						queuedTurn: null,
					});
					expect(
						vi
							.mocked(made.adapters.restorePayloadToDraft)
							.mock.calls.map(([restored]) => restored.message),
					).toEqual(["Typed during the read"]);
					expect(made.streamInvocations).toHaveLength(1);
					await vi.advanceTimersByTimeAsync(60_000);
					expect(made.streamInvocations).toHaveLength(1);
				});

				it("runs a context compression queued during that read, as every turn that ends does", async () => {
					let finishRead: (messages: ChatMessage[] | null) => void = () => {};
					const made = await waitingRegenerate({
						readChatMessages: vi.fn(
							() =>
								new Promise<ChatMessage[] | null>((resolve) => {
									finishRead = resolve;
								}),
						),
					});

					made.runtime.stop();
					made.runtime.compact();
					expect(made.runtime.snapshot().queuedContextCompression).toBe(true);
					finishRead(null);
					await vi.advanceTimersByTimeAsync(0);

					expect(
						made.adapters.runManualContextCompression,
					).toHaveBeenCalledTimes(1);
					expect(made.runtime.snapshot().queuedContextCompression).toBe(false);
				});

				it("does not wait for a read that never answers: five seconds is a chat that cannot be read", async () => {
					const made = await waitingRegenerate({
						readChatMessages: vi.fn(
							() => new Promise<ChatMessage[] | null>(() => {}),
						),
					});

					made.runtime.stop();
					await vi.advanceTimersByTimeAsync(4999);
					expect(sentenceShown(made.adapters)).toEqual([]);
					await vi.advanceTimersByTimeAsync(1);

					expect(sentenceShown(made.adapters)).toEqual([
						"chat.updateStillRunning",
					]);
					expect(made.runtime.snapshot()).toMatchObject({
						isSending: false,
						canRetry: true,
					});
				});

				it("gives a message queued behind it back to the composer", async () => {
					const made = await waitingRegenerate({
						readChatMessages: vi.fn(async () => [question, oldReply]),
					});
					made.runtime.queue(words("Queued behind the regenerate"));

					made.runtime.stop();

					expect(
						vi
							.mocked(made.adapters.restorePayloadToDraft)
							.mock.calls.map(([restored]) => restored.message),
					).toEqual(["Queued behind the regenerate"]);
				});
			});

			it("does the same for a request with no payload at all, the regenerate Retry makes of a reply", async () => {
				const { adapters, streamInvocations, messages } = updateAdapters({
					readChatMessages: vi.fn(async () => null),
				});
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
				await vi.advanceTimersByTimeAsync(0);

				expect(adapters.restorePayloadToDraft).not.toHaveBeenCalled();
				expect(messages.map((message) => message.role)).toEqual(["user"]);
				expect(runtime.snapshot()).toMatchObject({
					isSending: false,
					canRetry: true,
				});
				// "Network failed" is the first send's; the last sentence is the Stop's.
				expect(sentenceShown(adapters).at(-1)).toBe("chat.updateStillRunning");
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
		const WELL: ServerHealth = { state: "up" };
		const DRAINING: ServerHealth = { state: "draining" };
		const AWAY: ServerHealth = { state: "proxy_down" };

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
				// What the wait's polls find: the restart is on.
				health: AWAY as ServerHealth,
				// What the page says the server is doing when a cut reply asks.
				update: "restarting" as ServerUpdateKind,
				// What the chat holds on the server now: nothing of this turn.
				chat: [] as ChatMessage[],
			};
			const made = makeAdapters({
				schedule: vi.fn((callback, delay) => setTimeout(callback, delay)),
				fetchServerHealth: vi.fn(async () => server.health),
				askServerUpdate: vi.fn(async () => server.update),
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
				expect(made.adapters.askServerUpdate).toHaveBeenCalledTimes(1);
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
				made.server.update = "none";
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

				expect(made.adapters.askServerUpdate).not.toHaveBeenCalled();
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

				expect(made.adapters.askServerUpdate).toHaveBeenCalledTimes(1);
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
				made.server.update = "none";
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
				made.server.update = "none";
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

		// The page asks what the server is doing for up to five seconds, and the person
		// can leave the chat, or press Stop, meanwhile.
		describe("while the page is asked what the server is doing", () => {
			function askedLate(
				overrides: Partial<NormalChatClientTurnRuntimeAdapters> = {},
			) {
				let answer: (kind: ServerUpdateKind) => void = () => {};
				const made = cutAdapters({
					askServerUpdate: vi.fn(
						() =>
							new Promise<ServerUpdateKind>((resolve) => {
								answer = resolve;
							}),
					),
					...overrides,
				});
				return { ...made, answer: (kind: ServerUpdateKind) => answer(kind) };
			}

			it("starts no wait on a page that was left meanwhile, and the shell hears nothing", async () => {
				const made = askedLate();
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await send(runtime);
				// Before any text, the connection fails (a phone losing signal looks the same).
				made.streamInvocations[0].callbacks.onError(closedEarly());

				// The person leaves the chat page, which takes the words it holds.
				runtime.detach();
				expect(runtime.takeWaitingRequest()).toBeNull();
				expect(runtime.takeQueuedTurn()).toBeNull();
				made.answer("restarting");
				await vi.advanceTimersByTimeAsync(0);

				expect(made.adapters.onServerUpdateSign).not.toHaveBeenCalled();
				expect(made.adapters.setTurnWaitingForUpdate).not.toHaveBeenCalled();
				await vi.advanceTimersByTimeAsync(8 * 60 * 1000);
				expect(made.adapters.fetchServerHealth).not.toHaveBeenCalled();
				expect(made.streamInvocations).toHaveLength(1);
			});

			it("keeps Stop within reach: the turn counts as active, though the stream that failed is gone", async () => {
				const made = askedLate();
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await send(runtime);
				made.streamInvocations[0].callbacks.onError(closedEarly());

				expect(runtime.snapshot()).toMatchObject({
					active: true,
					isSending: true,
					phase: "preparing",
				});
				made.answer("none");
				await vi.advanceTimersByTimeAsync(0);
				expect(runtime.snapshot().active).toBe(false);
			});

			// Stop used to land on the stream that had already failed: it reported true
			// and nothing ended, and the turn waited for the update after all.
			it("honours a Stop pressed meanwhile: it asks the server to stop the run, waits for nothing and ends the turn", async () => {
				const made = askedLate();
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await send(runtime);
				made.streamInvocations[0].callbacks.onError(closedEarly());

				expect(runtime.stop()).toBe(true);
				// The run the server may still have is asked to stop, once.
				expect(made.streamInvocations[0].handle.stop).toHaveBeenCalledTimes(1);
				made.answer("restarting");
				await vi.advanceTimersByTimeAsync(0);

				// No wait or unscoped detail fallback: a handle without a stream ID cannot establish a terminal fact.
				expect(
					made.messages.some(
						(message) => message.runtimePhase === "awaiting_update",
					),
				).toBe(false);
				expect(made.adapters.onServerUpdateSign).not.toHaveBeenCalled();
				expect(made.adapters.setTurnWaitingForUpdate).not.toHaveBeenCalled();
				expect(made.adapters.readChatMessages).not.toHaveBeenCalled();
				expect(sentenceShown(made.adapters)).toEqual([
					"chat.observationUnavailable",
				]);
				expect(runtime.snapshot()).toMatchObject({
					isSending: false,
					active: false,
					phase: "idle",
				});
				await vi.advanceTimersByTimeAsync(8 * 60 * 1000);
				expect(made.adapters.fetchServerHealth).not.toHaveBeenCalled();
				expect(made.streamInvocations).toHaveLength(1);
			});

			it("does not load an unscoped legacy reply as proof of terminal completion after Stop", async () => {
				const made = askedLate();
				made.server.chat = heldByTheServer;
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await send(runtime);
				made.streamInvocations[0].callbacks.onError(closedEarly());

				runtime.stop();
				made.answer("restarting");
				await vi.advanceTimersByTimeAsync(0);

				expect(made.adapters.loadPersistedData).not.toHaveBeenCalled();
				expect(sentenceShown(made.adapters)).toEqual([
					"chat.observationUnavailable",
				]);
			});

			it("ends a Stop pressed during a reconnect's question the same way", async () => {
				const made = askedLate({
					loadPersistedData: vi.fn(async () => {
						made.messages.length = 0;
					}),
				});
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await runtime.reconnectToOrphanedStream("stream-1", "Resume me");
				made.streamInvocations[0].callbacks.onError(connectionFailed());

				expect(runtime.stop()).toBe(true);
				made.answer("restarting");
				await vi.advanceTimersByTimeAsync(0);

				expect(made.adapters.setTurnWaitingForUpdate).not.toHaveBeenCalled();
				expect(made.adapters.onServerUpdateSign).not.toHaveBeenCalled();
				await vi.waitFor(() =>
					expect(runtime.snapshot()).toMatchObject({ isSending: false }),
				);
			});

			it("has nothing to stop once the question is answered and the turn is over", async () => {
				const made = askedLate();
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await send(runtime);
				made.streamInvocations[0].callbacks.onError(closedEarly());
				made.answer("none");
				await vi.advanceTimersByTimeAsync(0);

				expect(runtime.stop()).toBe(false);
				expect(made.streamInvocations[0].handle.stop).not.toHaveBeenCalled();
			});
		});

		// The server is draining: the old process is alive and finishes the replies it
		// runs (the drain waits for them), so a connection that failed meanwhile has not
		// ended the turn, and the reply is probably still running there. Nothing is
		// waited for: its stream is looked for again and joined, and if there is none
		// the server is asked what it holds. It is the failure it always was if the
		// turn did not land, not the sentence for an update.
		describe("while the server drains, the old process still runs the reply", () => {
			function drainingAdapters(
				overrides: Partial<NormalChatClientTurnRuntimeAdapters> = {},
			) {
				const made = cutAdapters(overrides);
				made.server.update = "draining";
				made.server.health = DRAINING;
				return made;
			}

			/** The three looks for the stream after a drop (3.5 s) find none; the look the drain sends it to finds it. */
			function streamAppearsOnTheFourthLook(
				made: ReturnType<typeof cutAdapters>,
			) {
				vi.mocked(made.adapters.checkForOrphanedStream)
					.mockResolvedValueOnce(null)
					.mockResolvedValueOnce(null)
					.mockResolvedValueOnce(null)
					.mockResolvedValue("stream-1");
				vi.mocked(made.adapters.getStreamBufferInfo).mockResolvedValue({
					exists: true,
					userMessage: question,
				});
			}

			it("joins the reply's stream again after the three looks, with nothing waited for", async () => {
				const made = drainingAdapters();
				streamAppearsOnTheFourthLook(made);
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await send(runtime);
				made.streamInvocations[0].callbacks.onToken("Half an");
				made.streamInvocations[0].callbacks.onError(connectionFailed());

				await vi.advanceTimersByTimeAsync(500 + 1000 + 2000);

				// The stream was looked for a fourth time, and joined.
				expect(made.adapters.checkForOrphanedStream).toHaveBeenCalledTimes(4);
				expect(made.streamInvocations).toHaveLength(2);
				expect(made.streamInvocations[1].options?.reconnectToStreamId).toBe(
					"stream-1",
				);
				// Not a wait: the bubble never said "waiting for the update", the shell
				// holds no notice back, and nothing was said to the person.
				expect(
					made.messages.some(
						(message) => message.runtimePhase === "awaiting_update",
					),
				).toBe(false);
				expect(made.adapters.setTurnWaitingForUpdate).not.toHaveBeenCalled();
				expect(sentenceShown(made.adapters)).toEqual([]);
				expect(made.adapters.readChatMessages).not.toHaveBeenCalled();
				expect(made.messages.map((message) => message.role)).toEqual([
					"user",
					"assistant",
				]);
				// The shell still hears that the server is being updated.
				expect(made.adapters.onServerUpdateSign).toHaveBeenCalledTimes(1);
			});

			it("loads the turn when the server finished it, with no error", async () => {
				const made = drainingAdapters();
				made.server.chat = heldByTheServer;
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await send(runtime);
				made.streamInvocations[0].callbacks.onToken("Half an");
				made.streamInvocations[0].callbacks.onError(connectionFailed());

				await vi.advanceTimersByTimeAsync(500 + 1000 + 2000);

				expect(made.adapters.loadPersistedData).toHaveBeenCalledTimes(1);
				expect(sentenceShown(made.adapters)).toEqual([]);
				expect(runtime.snapshot()).toMatchObject({
					isSending: false,
					canRetry: false,
				});
				expect(made.streamInvocations).toHaveLength(1);
			});

			it("is the failure it always was when there is no stream and the server holds nothing: not the sentence for an update", async () => {
				const made = drainingAdapters();
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await send(runtime);
				made.streamInvocations[0].callbacks.onToken("Half an");
				made.streamInvocations[0].callbacks.onError(connectionFailed());

				await vi.advanceTimersByTimeAsync(500 + 1000 + 2000);

				expect(sentenceShown(made.adapters)).toEqual(["network error"]);
				expect(made.messages.map((message) => message.role)).toEqual(["user"]);
				expect(runtime.snapshot()).toMatchObject({
					phase: "idle",
					isSending: false,
					canRetry: true,
				});
				expect(
					made.messages.some(
						(message) => message.runtimePhase === "awaiting_update",
					),
				).toBe(false);
				// And it holds no wait for three minutes of a drain.
				await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
				expect(made.streamInvocations).toHaveLength(1);
				expect(made.adapters.setTurnWaitingForUpdate).not.toHaveBeenCalled();
			});

			it("joins the stream of a reply that died before any text, too", async () => {
				const made = drainingAdapters();
				vi.mocked(made.adapters.checkForOrphanedStream).mockResolvedValue(
					"stream-1",
				);
				vi.mocked(made.adapters.getStreamBufferInfo).mockResolvedValue({
					exists: true,
					userMessage: question,
				});
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await send(runtime);

				made.streamInvocations[0].callbacks.onError(closedEarly());
				await vi.advanceTimersByTimeAsync(0);

				expect(made.streamInvocations).toHaveLength(2);
				expect(made.streamInvocations[1].options?.reconnectToStreamId).toBe(
					"stream-1",
				);
				expect(made.messages.map((message) => message.role)).toEqual([
					"user",
					"assistant",
				]);
				expect(sentenceShown(made.adapters)).toEqual([]);
				expect(runtime.snapshot()).toMatchObject({
					isSending: true,
					active: true,
				});
			});

			it("does not join the stream of another message of the chat", async () => {
				const made = drainingAdapters();
				vi.mocked(made.adapters.checkForOrphanedStream).mockResolvedValue(
					"stream-other",
				);
				vi.mocked(made.adapters.getStreamBufferInfo).mockResolvedValue({
					exists: true,
					userMessage: "Another device's question",
				});
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await send(runtime);

				made.streamInvocations[0].callbacks.onError(closedEarly());
				await vi.advanceTimersByTimeAsync(0);

				expect(made.streamInvocations).toHaveLength(1);
				expect(sentenceShown(made.adapters)).toEqual([
					"Stream closed before a terminal completion event",
				]);
			});

			it("rejoins a reconnect that failed, at most three times over", async () => {
				const made = drainingAdapters();
				vi.mocked(made.adapters.checkForOrphanedStream).mockResolvedValue(
					"stream-1",
				);
				vi.mocked(made.adapters.getStreamBufferInfo).mockResolvedValue({
					exists: true,
					userMessage: "Resume me",
				});
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await runtime.reconnectToOrphanedStream("stream-1", "Resume me");

				for (let failure = 0; failure < 4; failure += 1) {
					made.streamInvocations[failure].callbacks.onError(connectionFailed());
					await vi.advanceTimersByTimeAsync(0);
				}

				// The first connection and three rejoins; the fourth failure is not followed.
				expect(made.streamInvocations).toHaveLength(4);
				expect(made.adapters.setTurnWaitingForUpdate).not.toHaveBeenCalled();
			});

			it("waits for nothing, and a Stop has nothing to end", async () => {
				const made = drainingAdapters();
				streamAppearsOnTheFourthLook(made);
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await send(runtime);
				made.streamInvocations[0].callbacks.onToken("Half an");
				made.streamInvocations[0].callbacks.onError(connectionFailed());
				await vi.advanceTimersByTimeAsync(500 + 1000 + 2000);

				// It is a live reconnect now; Stop is the stream's.
				expect(runtime.stop()).toBe(true);
				expect(made.streamInvocations[1].handle.stop).toHaveBeenCalledTimes(1);
			});

			// The composer is free after a drop, so a message sent while the looks go on
			// is a turn that holds the turn state, and a join needs it free. The reply is
			// then settled like any cut reply that cannot be joined (`settleCutReply`),
			// around that turn, as a network-drop recovery does for any other answer.
			describe("when a turn started since the reply was cut", () => {
				const drainRefusal = () =>
					Object.assign(
						new Error("Server at capacity. Please try again later."),
						{ status: 503, code: "CAPACITY_EXCEEDED", reason: "draining" },
					);
				const another = {
					message: "Another",
					attachmentIds: [],
					attachments: [],
					pendingAttachments: [],
				};

				it("leaves the cut reply and the newer waiting turn intact without stale recovery", async () => {
					const made = drainingAdapters();
					streamAppearsOnTheFourthLook(made);
					const runtime = createNormalChatClientTurnRuntime(made.adapters);
					await send(runtime);
					const cutReplyId = made.messages.at(-1)?.id;
					made.streamInvocations[0].callbacks.onToken("Half an");
					made.streamInvocations[0].callbacks.onError(connectionFailed());
					// The drain turns the next message away, and it waits.
					await runtime.send(another);
					made.streamInvocations[1].callbacks.onError(drainRefusal());
					expect(runtime.snapshot().phase).toBe("awaiting_update");

					await vi.advanceTimersByTimeAsync(500 + 1000 + 2000);

					// The three looks of the drop found nothing, and a fourth could not be used.
					expect(made.adapters.checkForOrphanedStream).not.toHaveBeenCalled();
					expect(made.streamInvocations).toHaveLength(2);
					// The server was asked what it holds of the cut reply, and the reply left
					// the screen with no error: the chat brings it back when it is read.
					expect(made.adapters.readChatMessages).not.toHaveBeenCalled();
					expect(
						made.messages.find((message) => message.id === cutReplyId),
					).toMatchObject({ content: "Half an" });
					expect(sentenceShown(made.adapters)).toEqual([]);
					// The turn that waits for the update is as it was, and still goes.
					expect(runtime.snapshot()).toMatchObject({
						phase: "awaiting_update",
						isSending: true,
					});
					made.server.health = WELL;
					await vi.advanceTimersByTimeAsync(POLL_MS);
					expect(made.streamInvocations).toHaveLength(3);
					expect(made.streamInvocations[2].message).toBe("Another");
				});

				it("takes nothing off the screen for a stream it finds after a turn started meanwhile", async () => {
					const made = drainingAdapters();
					let streamFound: (streamId: string | null) => void = () => {};
					vi.mocked(made.adapters.checkForOrphanedStream)
						.mockResolvedValueOnce(null)
						.mockResolvedValueOnce(null)
						.mockResolvedValueOnce(null)
						.mockImplementation(
							() =>
								new Promise<string | null>((resolve) => {
									streamFound = resolve;
								}),
						);
					vi.mocked(made.adapters.getStreamBufferInfo).mockResolvedValue({
						exists: true,
						userMessage: question,
					});
					const runtime = createNormalChatClientTurnRuntime(made.adapters);
					await send(runtime);
					const cutReplyId = made.messages.at(-1)?.id;
					made.streamInvocations[0].callbacks.onToken("Half an");
					made.streamInvocations[0].callbacks.onError(connectionFailed());
					await vi.advanceTimersByTimeAsync(500 + 1000 + 2000);
					expect(made.adapters.checkForOrphanedStream).toHaveBeenCalledTimes(4);

					// The fourth look is out when the person sends, and the server runs it.
					await runtime.send(another);
					expect(made.streamInvocations).toHaveLength(2);
					streamFound("stream-1");
					await vi.advanceTimersByTimeAsync(0);

					// Nothing was joined: the stream is the cut reply's, the state is the new turn's.
					expect(made.streamInvocations).toHaveLength(2);
					expect(
						made.streamInvocations[1].options?.reconnectToStreamId,
					).toBeUndefined();
					// The originating epoch is stale, so no saved-state read starts.
					expect(made.adapters.readChatMessages).not.toHaveBeenCalled();
					expect(
						made.messages.find((message) => message.id === cutReplyId),
					).toMatchObject({ content: "Half an" });
					expect(made.messageListEvents.removeMessage).not.toHaveBeenCalledWith(
						cutReplyId,
					);
					expect(sentenceShown(made.adapters)).toEqual([]);
					expect(runtime.snapshot()).toMatchObject({
						isSending: true,
						active: true,
					});
				});
			});
		});

		// A version that went live during this turn, with the server answering: the
		// restart is over and it cut the reply. Nothing is waited for, and the page says
		// so after it has asked the server what it holds.
		describe("when a new version went live during the turn and the server answers", () => {
			/** The three looks for the stream after a drop (3.5 s) find none; the look the new version sends it to finds it. */
			function streamAppearsOnTheFourthLook(
				made: ReturnType<typeof cutAdapters>,
			) {
				vi.mocked(made.adapters.checkForOrphanedStream)
					.mockResolvedValueOnce(null)
					.mockResolvedValueOnce(null)
					.mockResolvedValueOnce(null)
					.mockResolvedValue("stream-1");
				vi.mocked(made.adapters.getStreamBufferInfo).mockResolvedValue({
					exists: true,
					userMessage: question,
				});
			}

			it("joins the reply's stream when the old process still runs it, with nothing waited for", async () => {
				const made = cutAdapters();
				made.server.update = "new_version";
				made.server.health = WELL;
				streamAppearsOnTheFourthLook(made);
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await send(runtime);
				made.streamInvocations[0].callbacks.onToken("Half an");
				made.streamInvocations[0].callbacks.onError(connectionFailed());

				await vi.advanceTimersByTimeAsync(500 + 1000 + 2000);

				expect(made.adapters.checkForOrphanedStream).toHaveBeenCalledTimes(4);
				expect(made.streamInvocations).toHaveLength(2);
				expect(made.streamInvocations[1].options?.reconnectToStreamId).toBe(
					"stream-1",
				);
				// No sentence, no wait, no read of the chat: it is a live reconnect.
				expect(sentenceShown(made.adapters)).toEqual([]);
				expect(made.adapters.readChatMessages).not.toHaveBeenCalled();
				expect(made.adapters.setTurnWaitingForUpdate).not.toHaveBeenCalled();
				expect(
					made.messages.some(
						(message) => message.runtimePhase === "awaiting_update",
					),
				).toBe(false);
				expect(made.messages.map((message) => message.role)).toEqual([
					"user",
					"assistant",
				]);
				expect(runtime.snapshot()).toMatchObject({
					isSending: true,
					active: true,
				});
				// The shell still hears that the server was updated.
				expect(made.adapters.onServerUpdateSign).toHaveBeenCalledTimes(1);
			});

			it("joins the stream of a reply that died before any text, too", async () => {
				const made = cutAdapters();
				made.server.update = "new_version";
				made.server.health = WELL;
				vi.mocked(made.adapters.checkForOrphanedStream).mockResolvedValue(
					"stream-1",
				);
				vi.mocked(made.adapters.getStreamBufferInfo).mockResolvedValue({
					exists: true,
					userMessage: question,
				});
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await send(runtime);

				made.streamInvocations[0].callbacks.onError(closedEarly());
				await vi.advanceTimersByTimeAsync(0);

				expect(made.streamInvocations).toHaveLength(2);
				expect(made.streamInvocations[1].options?.reconnectToStreamId).toBe(
					"stream-1",
				);
				expect(sentenceShown(made.adapters)).toEqual([]);
				expect(runtime.snapshot()).toMatchObject({
					isSending: true,
					active: true,
				});
			});

			it("says an update cut a reply that died before any text when there is no stream either", async () => {
				const made = cutAdapters();
				made.server.update = "new_version";
				made.server.health = WELL;
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await send(runtime);

				made.streamInvocations[0].callbacks.onError(closedEarly());
				await vi.advanceTimersByTimeAsync(0);

				expect(made.adapters.checkForOrphanedStream).toHaveBeenCalledTimes(1);
				expect(sentenceShown(made.adapters)).toEqual(["chat.updateCutReply"]);
				expect(made.messages.map((message) => message.role)).toEqual(["user"]);
				expect(runtime.snapshot()).toMatchObject({
					isSending: false,
					canRetry: true,
				});
				expect(made.streamInvocations).toHaveLength(1);
			});

			it("rejoins a reconnect that failed, at most three times over, and then says an update cut it", async () => {
				const made = cutAdapters();
				made.server.update = "new_version";
				made.server.health = WELL;
				vi.mocked(made.adapters.checkForOrphanedStream).mockResolvedValue(
					"stream-1",
				);
				vi.mocked(made.adapters.getStreamBufferInfo).mockResolvedValue({
					exists: true,
					userMessage: "Resume me",
				});
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await runtime.reconnectToOrphanedStream("stream-1", "Resume me");

				for (let failure = 0; failure < 4; failure += 1) {
					made.streamInvocations[failure].callbacks.onError(connectionFailed());
					await vi.advanceTimersByTimeAsync(0);
				}

				// The first connection and three rejoins; the fourth failure is not followed.
				expect(made.streamInvocations).toHaveLength(4);
				expect(sentenceShown(made.adapters)).toEqual(["chat.updateCutReply"]);
				expect(made.adapters.setTurnWaitingForUpdate).not.toHaveBeenCalled();
			});

			it("lets the turn state go when the chat was changed while the stream was looked for", async () => {
				let conversationId = "conv-1";
				let streamFound: (streamId: string | null) => void = () => {};
				const made = cutAdapters({
					getConversationId: vi.fn(() => conversationId),
				});
				made.server.update = "new_version";
				made.server.health = WELL;
				vi.mocked(made.adapters.checkForOrphanedStream)
					.mockResolvedValueOnce(null)
					.mockResolvedValueOnce(null)
					.mockResolvedValueOnce(null)
					.mockImplementation(
						() =>
							new Promise<string | null>((resolve) => {
								streamFound = resolve;
							}),
					);
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await send(runtime);
				made.streamInvocations[0].callbacks.onToken("Half an");
				made.streamInvocations[0].callbacks.onError(connectionFailed());
				await vi.advanceTimersByTimeAsync(500 + 1000 + 2000);
				// The turn state is held for the reply while its stream is looked for.
				expect(made.adapters.checkForOrphanedStream).toHaveBeenCalledTimes(4);
				expect(runtime.snapshot().isSending).toBe(true);

				conversationId = "conv-2";
				streamFound("stream-1");
				await vi.advanceTimersByTimeAsync(0);

				expect(runtime.snapshot().isSending).toBe(false);
				expect(made.streamInvocations).toHaveLength(1);
				expect(sentenceShown(made.adapters)).toEqual([]);
			});

			it("looks for the stream first, and says an update cut the reply only when there is none, after asking the server what it holds, without a wait", async () => {
				const made = cutAdapters();
				made.server.update = "new_version";
				made.server.health = WELL;
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await send(runtime);
				made.streamInvocations[0].callbacks.onToken("Half an");
				made.streamInvocations[0].callbacks.onError(connectionFailed());

				await vi.advanceTimersByTimeAsync(500 + 1000 + 2000);

				// The three looks of the drop, and the one the new version sends it to.
				expect(made.adapters.checkForOrphanedStream).toHaveBeenCalledTimes(4);
				expect(sentenceShown(made.adapters)).toEqual(["chat.updateCutReply"]);
				expect(made.adapters.readChatMessages).toHaveBeenCalledTimes(1);
				expect(made.adapters.onServerUpdateSign).toHaveBeenCalledTimes(1);
				// Nothing waited: the bubble never said it, and the shell holds nothing.
				expect(
					made.messages.some(
						(message) => message.runtimePhase === "awaiting_update",
					),
				).toBe(false);
				expect(made.adapters.setTurnWaitingForUpdate).not.toHaveBeenCalled();
				expect(made.adapters.fetchServerHealth).not.toHaveBeenCalled();
				expect(runtime.snapshot()).toMatchObject({
					isSending: false,
					canRetry: true,
				});
				expect(made.streamInvocations).toHaveLength(1);
			});

			it("loads the turn when the server finished it, with no error", async () => {
				const made = cutAdapters();
				made.server.update = "new_version";
				made.server.chat = heldByTheServer;
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await send(runtime);
				made.streamInvocations[0].callbacks.onError(closedEarly());

				await vi.advanceTimersByTimeAsync(0);

				expect(made.adapters.loadPersistedData).toHaveBeenCalledTimes(1);
				expect(sentenceShown(made.adapters)).toEqual([]);
				expect(runtime.snapshot().canRetry).toBe(false);
			});
		});

		// A version change counts only if it happened during this turn: the page reads
		// what it knew (`updated.current`) the moment the failure is handled, before it
		// awaits anything, and the question is asked with that.
		describe("what the page knew of the version when the failure was handled", () => {
			it("is read before anything is awaited, and handed to the question", async () => {
				let live = true;
				const made = cutAdapters({
					isNewVersionLive: vi.fn(() => live),
				});
				made.server.update = "none";
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await send(runtime);
				const failed = made.streamInvocations[0].callbacks.onError;

				failed(closedEarly());
				// Said true when the failure was handled; it is false by the time the
				// question is answered.
				live = false;
				await vi.advanceTimersByTimeAsync(0);

				expect(made.adapters.isNewVersionLive).toHaveBeenCalledTimes(1);
				expect(made.adapters.askServerUpdate).toHaveBeenCalledWith(true);
			});

			it("is read when the connection drops, not when the recovery gives up three seconds later", async () => {
				let live = false;
				const made = cutAdapters({
					isNewVersionLive: vi.fn(() => live),
				});
				made.server.update = "none";
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await send(runtime);
				made.streamInvocations[0].callbacks.onToken("Half an");

				made.streamInvocations[0].callbacks.onError(connectionFailed());
				// A deploy completes while the three looks go on, and the page notices.
				live = true;
				await vi.advanceTimersByTimeAsync(500 + 1000 + 2000);

				expect(made.adapters.askServerUpdate).toHaveBeenCalledWith(false);
			});
		});
	});

	// "Ask me first". Alfy can stop a reply to ask the person one to three
	// questions, and the person's answer carries the same reply on as a new segment:
	// an assistant row that continues the asking row. An answer is a turn of its own
	// (`answerQuestion`) and meets what a send meets (an update, a busy server, a
	// connection that drops), but it fails differently: there is no message to put
	// back, no Retry and no sentence on the page. The card shows the answer again
	// and says why, which is what `answerNotSent` is for.
	describe("an answer to a question Alfy asked", () => {
		type AnswerParams = Parameters<
			ReturnType<typeof createNormalChatClientTurnRuntime>["answerQuestion"]
		>[0];
		type Reported = { mock: { calls: Array<[AskRuntimeEvent]> } };

		const POLL_MS = 3000;
		const EIGHT_MINUTES_MS = 8 * 60 * 1000;
		const WELL: ServerHealth = { state: "up" };
		const DRAINING: ServerHealth = { state: "draining" };
		const ANSWER: AskAnswer = {
			kind: "answered",
			answers: [{ picked: [1], ownWords: null }],
		};

		/** The chat when Alfy has asked: the person's message, and the row the question sits in. */
		const askingChat = (): ChatMessage[] => [
			{ id: "user-1", role: "user", content: "Plan my trip", timestamp: 1 },
			{
				id: "seg-1",
				role: "assistant",
				content: "Before I plan it,",
				timestamp: 2,
			},
		];

		const answerOf = (overrides: Partial<AnswerParams> = {}): AnswerParams => ({
			questionId: "q-1",
			answer: ANSWER,
			continuesMessageId: "seg-1",
			userMessage: "Plan my trip",
			...overrides,
		});

		const words = (message: string) => ({
			message,
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});

		function refused(status: number, code: string, message: string): Error {
			return Object.assign(new Error(message), { status, code });
		}
		const questionWaiting = () =>
			refused(
				409,
				"QUESTION_WAITING",
				"Answer the question Alfy asked before sending a new message",
			);
		const alreadyAnswered = () =>
			refused(
				409,
				"QUESTION_ALREADY_ANSWERED",
				"The question has already been answered",
			);
		const refusedAsDraining = () =>
			Object.assign(new Error("Server at capacity. Please try again later."), {
				status: 503,
				code: "CAPACITY_EXCEEDED",
				reason: "draining",
			});
		const refusedAsFull = (reason: "global_limit" | "user_limit") =>
			Object.assign(new Error("Server at capacity. Please try again later."), {
				status: 503,
				code: "CAPACITY_EXCEEDED",
				reason,
			});
		// The restart: the proxy answers its own page instead of the app.
		const refusedByTheProxy = () =>
			Object.assign(new Error("HTTP 503"), {
				status: 503,
				serverUnavailable: true,
			});

		/**
		 * Adapters whose clock is the test's, whose server is whatever `server.health`
		 * says, and whose page listens for the ask events. The chat holds the asking
		 * row.
		 */
		function onTheClock(
			overrides: Partial<NormalChatClientTurnRuntimeAdapters> = {},
		) {
			vi.useFakeTimers();
			const server = { health: DRAINING };
			const onAskEvent = vi.fn<(event: AskRuntimeEvent) => void>();
			const made = makeAdapters({
				schedule: vi.fn((callback, delay) => setTimeout(callback, delay)),
				fetchServerHealth: vi.fn(async () => server.health),
				setTurnWaitingForUpdate: vi.fn(),
				onServerUpdateSign: vi.fn(),
				onAskEvent,
				...overrides,
			});
			made.messages.push(...askingChat());
			return { ...made, server, onAskEvent };
		}

		/** What the page was told, optionally of one kind. */
		const reported = (
			onAskEvent: Reported,
			type?: AskRuntimeEvent["type"],
		): AskRuntimeEvent[] =>
			onAskEvent.mock.calls
				.map(([event]) => event)
				.filter((event) => type === undefined || event.type === type);

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

		it("streams an answer under a placeholder that continues the asking row, with the composer's choices", async () => {
			const made = onTheClock({
				getSelectedModel: vi.fn(() => "model2" as ModelId),
				getReasoningDepth: vi.fn((): ReasoningDepth => "quick"),
				getPersonalityProfileId: vi.fn(() => "persona-1"),
				getActiveDocumentArtifactId: vi.fn(() => "open-doc"),
				getEnabledConnectionCapabilities: vi.fn(() => ["mail.read"]),
			});
			const runtime = createNormalChatClientTurnRuntime(made.adapters);

			await runtime.answerQuestion(answerOf());

			// One placeholder under the asking row, and no bubble of the person's: their
			// message is on screen already.
			expect(made.messageListEvents.appendUserMessage).not.toHaveBeenCalled();
			expect(
				made.messageListEvents.appendAssistantPlaceholder,
			).toHaveBeenCalledTimes(1);
			expect(
				made.messageListEvents.appendAssistantPlaceholder.mock.calls[0][0],
			).toMatchObject({
				role: "assistant",
				content: "",
				isStreaming: true,
				runtimePhase: "preparing",
				continuesMessageId: "seg-1",
			});
			// The answer goes to its question's route, as a turn of the composer's choices.
			expect(made.streamInvocations).toHaveLength(1);
			expect(made.streamInvocations[0]).toMatchObject({
				message: "Plan my trip",
				conversationId: "conv-1",
			});
			expect(made.streamInvocations[0].options).toEqual({
				modelId: "model2",
				reasoningDepth: "quick",
				personalityProfileId: "persona-1",
				enabledConnectionCapabilities: ["mail.read"],
				activeDocumentArtifactId: "open-doc",
				questionAnswer: { questionId: "q-1", answer: ANSWER },
			});
			expect(runtime.snapshot()).toMatchObject({
				isSending: true,
				active: true,
				phase: "preparing",
				canRetry: false,
				lastUserMessage: "",
			});
			// It leaves what a send leaves behind alone: the composer's draft and files,
			// the page's sentence and Retry's memory.
			expect(made.adapters.clearDraft).not.toHaveBeenCalled();
			expect(made.adapters.clearAttachedArtifacts).not.toHaveBeenCalled();
			expect(made.adapters.setSendError).not.toHaveBeenCalled();
		});

		it("says the answer was accepted on the resume's first event, once", async () => {
			const made = onTheClock();
			const runtime = createNormalChatClientTurnRuntime(made.adapters);
			await runtime.answerQuestion(answerOf());
			// Nothing is known until the resume runs.
			expect(reported(made.onAskEvent)).toEqual([]);

			const { callbacks } = made.streamInvocations[0];
			callbacks.onToken("Plan ");
			callbacks.onToken("it");
			callbacks.onThinking("Hmm");
			callbacks.onToolCall?.("web_search", {}, "running");
			callbacks.onEnd("Plan it", { assistantMessageId: "seg-2" });

			expect(reported(made.onAskEvent)).toEqual([
				{ type: "answerAccepted", questionId: "q-1" },
			]);
		});

		it.each([
			[
				"a thought",
				(callbacks: StreamCallbacks) => callbacks.onThinking("Hmm"),
			],
			[
				"a tool call",
				(callbacks: StreamCallbacks) =>
					callbacks.onToolCall?.("web_search", {}, "running"),
			],
			[
				"a progress line",
				(callbacks: StreamCallbacks) =>
					callbacks.onResponseActivity?.({
						id: "context-ready",
						kind: "context",
						status: "done",
						contextPreparationClass: "context-retrieval",
						count: 2,
					}),
			],
		])("takes %s for the resume's first event as well", async (_name, firstEvent) => {
			const made = onTheClock();
			const runtime = createNormalChatClientTurnRuntime(made.adapters);
			await runtime.answerQuestion(answerOf());

			// Said on that event alone, before any text, and not again for the text.
			firstEvent(made.streamInvocations[0].callbacks);
			expect(reported(made.onAskEvent)).toEqual([
				{ type: "answerAccepted", questionId: "q-1" },
			]);
			made.streamInvocations[0].callbacks.onToken("Now the text");
			expect(reported(made.onAskEvent)).toHaveLength(1);
		});

		it("takes the end of a resume that streamed nothing for the answer being accepted", async () => {
			const made = onTheClock();
			const runtime = createNormalChatClientTurnRuntime(made.adapters);
			await runtime.answerQuestion(answerOf());

			made.streamInvocations[0].callbacks.onEnd("", {
				assistantMessageId: "seg-2",
			});

			expect(reported(made.onAskEvent)).toEqual([
				{ type: "answerAccepted", questionId: "q-1" },
			]);
			expect(runtime.snapshot()).toMatchObject({ isSending: false });
		});

		it("gives a queued message back to the draft when a reply ends paused, and sends nothing", async () => {
			const made = onTheClock({ restorePayloadToDraft: vi.fn() });
			const runtime = createNormalChatClientTurnRuntime(made.adapters);
			await runtime.send(words("Plan my trip"));
			made.streamInvocations[0].callbacks.onToken("Before I plan it,");
			// The person typed on while the reply ran, and asked for a compression too.
			runtime.queue(words("Also: no flights"));
			runtime.compact();

			made.streamInvocations[0].callbacks.onEnd("Before I plan it,", {
				assistantMessageId: "seg-1",
				waitingQuestionId: "q-1",
			});
			await vi.advanceTimersByTimeAsync(0);

			expect(reported(made.onAskEvent)).toEqual([
				{ type: "paused", questionId: "q-1", assistantMessageId: "seg-1" },
			]);
			// No new turn starts under an open question: the words go back where they
			// were typed, and the compression that waited runs.
			expect(made.adapters.restorePayloadToDraft).toHaveBeenCalledTimes(1);
			expect(made.adapters.restorePayloadToDraft).toHaveBeenCalledWith(
				expect.objectContaining({ message: "Also: no flights" }),
			);
			expect(made.adapters.runManualContextCompression).toHaveBeenCalledTimes(
				1,
			);
			expect(made.streamInvocations).toHaveLength(1);
			expect(runtime.snapshot()).toMatchObject({
				isSending: false,
				active: false,
				phase: "idle",
				canRetry: false,
				queuedTurn: null,
				queuedContextCompression: false,
			});
			// The segment is finalized like any turn's end, and the title is asked for.
			expect(
				made.messageListEvents.finalizeStreamingMessage,
			).toHaveBeenCalled();
			expect(made.adapters.maybeTriggerTitleGeneration).toHaveBeenCalledTimes(
				1,
			);
		});

		it("reports a pause when the end was a Stop too, and when a resume asks again", async () => {
			const stopped = onTheClock();
			const first = createNormalChatClientTurnRuntime(stopped.adapters);
			await first.send(words("Plan my trip"));
			first.queue(words("Later"));
			stopped.streamInvocations[0].callbacks.onEnd("Partial", {
				wasStopped: true,
				assistantMessageId: "seg-1",
				waitingQuestionId: "q-1",
			});
			expect(reported(stopped.onAskEvent)).toEqual([
				{ type: "paused", questionId: "q-1", assistantMessageId: "seg-1" },
			]);
			expect(stopped.adapters.restorePayloadToDraft).toHaveBeenCalledTimes(1);

			// A resume is a turn like any: it can end paused on its own new question.
			const again = onTheClock();
			const second = createNormalChatClientTurnRuntime(again.adapters);
			await second.answerQuestion(answerOf());
			again.streamInvocations[0].callbacks.onToken("Thanks. One more thing:");
			again.streamInvocations[0].callbacks.onEnd("Thanks. One more thing:", {
				assistantMessageId: "seg-2",
				waitingQuestionId: "q-2",
			});
			expect(reported(again.onAskEvent)).toEqual([
				{ type: "answerAccepted", questionId: "q-1" },
				{ type: "paused", questionId: "q-2", assistantMessageId: "seg-2" },
			]);
			expect(second.snapshot()).toMatchObject({ isSending: false });
		});

		it("names the placeholder's row when the end carries no id, and nothing when the list lost it", async () => {
			const made = onTheClock();
			const runtime = createNormalChatClientTurnRuntime(made.adapters);
			await runtime.send(words("Plan my trip"));
			made.streamInvocations[0].callbacks.onEnd("Before I plan it,", {
				waitingQuestionId: "q-1",
			});
			// The row keeps the id it was drawn under when the end does not name another.
			expect(reported(made.onAskEvent, "paused")).toEqual([
				{ type: "paused", questionId: "q-1", assistantMessageId: "id-2" },
			]);

			const lost = onTheClock({ getMessages: vi.fn(() => []) });
			const second = createNormalChatClientTurnRuntime(lost.adapters);
			await second.send(words("Plan my trip"));
			lost.streamInvocations[0].callbacks.onEnd("Before I plan it,", {
				waitingQuestionId: "q-1",
			});
			expect(reported(lost.onAskEvent, "paused")).toEqual([
				{ type: "paused", questionId: "q-1", assistantMessageId: null },
			]);
		});

		it("waits for an update, then sends the answer again when health says up", async () => {
			const made = onTheClock();
			const runtime = createNormalChatClientTurnRuntime(made.adapters);

			await runtime.answerQuestion(answerOf());
			made.streamInvocations[0].callbacks.onError(refusedAsDraining());

			// Not the capacity backoff and not an error: the placeholder waits, saying so,
			// and the card has been told nothing.
			expect(made.adapters.schedule).not.toHaveBeenCalledWith(
				expect.any(Function),
				500,
			);
			expect(made.messages.at(-1)).toMatchObject({
				continuesMessageId: "seg-1",
				runtimePhase: "awaiting_update",
			});
			expect(runtime.snapshot()).toMatchObject({
				phase: "awaiting_update",
				isSending: true,
				canRetry: false,
			});
			expect(made.adapters.onServerUpdateSign).toHaveBeenCalledTimes(1);
			expect(made.adapters.setTurnWaitingForUpdate).toHaveBeenLastCalledWith(
				true,
			);
			expect(reported(made.onAskEvent)).toEqual([]);
			expect(sentenceShown(made.adapters)).toEqual([]);

			// The server is still draining at the first look, and well at the second.
			await vi.advanceTimersByTimeAsync(POLL_MS);
			expect(made.streamInvocations).toHaveLength(1);
			made.server.health = WELL;
			await vi.advanceTimersByTimeAsync(POLL_MS);

			// The same answer goes again, under the same placeholder.
			expect(made.streamInvocations).toHaveLength(2);
			expect(made.streamInvocations[1].options).toBe(
				made.streamInvocations[0].options,
			);
			expect(made.streamInvocations[1].message).toBe("Plan my trip");
			expect(made.messages.filter((row) => row.isStreaming)).toHaveLength(1);
			expect(made.adapters.setTurnWaitingForUpdate).toHaveBeenLastCalledWith(
				false,
			);

			made.streamInvocations[1].callbacks.onToken("Plan");
			expect(reported(made.onAskEvent)).toEqual([
				{ type: "answerAccepted", questionId: "q-1" },
			]);
			expect(sentenceShown(made.adapters)).toEqual([]);
		});

		it("gives an answer up after the update wait with answerNotSent, and quietly on Stop", async () => {
			// Eight minutes of an update, and the server is still not back.
			const gaveUp = onTheClock({
				readChatMessages: vi.fn(async () => []),
			});
			const runtime = createNormalChatClientTurnRuntime(gaveUp.adapters);
			await runtime.answerQuestion(answerOf());
			gaveUp.streamInvocations[0].callbacks.onError(refusedAsDraining());
			// A message typed meanwhile waits in the queue.
			runtime.queue(words("Meanwhile"));

			await vi.advanceTimersByTimeAsync(EIGHT_MINUTES_MS);

			expect(reported(gaveUp.onAskEvent)).toEqual([
				{ type: "answerNotSent", questionId: "q-1", quiet: false },
			]);
			// The placeholder goes and the asking row stays. Neither the update sentence
			// nor Retry is shown: the chat's last message did not fail.
			expect(gaveUp.messages.map((row) => row.id)).toEqual(["user-1", "seg-1"]);
			expect(sentenceShown(gaveUp.adapters)).toEqual([]);
			expect(runtime.snapshot()).toMatchObject({
				isSending: false,
				active: false,
				canRetry: false,
			});
			expect(gaveUp.adapters.setTurnWaitingForUpdate).toHaveBeenLastCalledWith(
				false,
			);
			expect(gaveUp.adapters.restorePayloadToDraft).toHaveBeenCalledTimes(1);
			expect(gaveUp.adapters.restorePayloadToDraft).toHaveBeenCalledWith(
				expect.objectContaining({ message: "Meanwhile" }),
			);
			expect(gaveUp.streamInvocations).toHaveLength(1);
			// Nothing was read back: the reply the answer would have replaced was never taken off.
			expect(gaveUp.adapters.readChatMessages).not.toHaveBeenCalled();

			// Stop ends the wait, and the card comes back without an error line.
			const stopped = onTheClock({
				readChatMessages: vi.fn(async () => []),
			});
			const second = createNormalChatClientTurnRuntime(stopped.adapters);
			await second.answerQuestion(answerOf());
			stopped.streamInvocations[0].callbacks.onError(refusedAsDraining());
			expect(second.stop()).toBe(true);
			await vi.advanceTimersByTimeAsync(0);

			expect(reported(stopped.onAskEvent)).toEqual([
				{ type: "answerNotSent", questionId: "q-1", quiet: true },
			]);
			expect(stopped.messages.map((row) => row.id)).toEqual([
				"user-1",
				"seg-1",
			]);
			expect(sentenceShown(stopped.adapters)).toEqual([]);
			expect(second.snapshot()).toMatchObject({
				isSending: false,
				canRetry: false,
			});
			expect(stopped.adapters.readChatMessages).not.toHaveBeenCalled();
			expect(stopped.streamInvocations).toHaveLength(1);
		});

		it("sends an answer again only a few times when the server calls itself well and keeps refusing it as an update, then settles it", async () => {
			const made = onTheClock();
			made.server.health = WELL;
			const runtime = createNormalChatClientTurnRuntime(made.adapters);
			await runtime.answerQuestion(answerOf());

			// Refused, waited, sent again: three times over.
			for (let sent = 0; sent < 3; sent += 1) {
				made.streamInvocations[sent].callbacks.onError(refusedByTheProxy());
				await vi.advanceTimersByTimeAsync(POLL_MS);
				expect(made.streamInvocations).toHaveLength(sent + 2);
			}
			// The fourth is not waited for: it is a give-up like any other.
			made.streamInvocations[3].callbacks.onError(refusedByTheProxy());
			await vi.advanceTimersByTimeAsync(0);

			expect(made.adapters.onServerUpdateSign).toHaveBeenCalledTimes(3);
			expect(reported(made.onAskEvent)).toEqual([
				{ type: "answerNotSent", questionId: "q-1", quiet: false },
			]);
			expect(sentenceShown(made.adapters)).toEqual([]);
		});

		it("backs an answer off three times when another reply is running, then says answerNotSent", async () => {
			const made = onTheClock();
			const runtime = createNormalChatClientTurnRuntime(made.adapters);
			await runtime.answerQuestion(answerOf());

			// The old three-step backoff, as for a send: no wait, no sign for the shell.
			made.streamInvocations[0].callbacks.onError(refusedAsFull("user_limit"));
			expect(made.adapters.schedule).toHaveBeenCalledWith(
				expect.any(Function),
				500,
			);
			expect(made.adapters.onServerUpdateSign).not.toHaveBeenCalled();
			expect(made.messages.at(-1)?.runtimePhase).not.toBe("awaiting_update");
			await vi.advanceTimersByTimeAsync(500);
			made.streamInvocations[1].callbacks.onError(refusedAsFull("user_limit"));
			await vi.advanceTimersByTimeAsync(1000);
			made.streamInvocations[2].callbacks.onError(
				refusedAsFull("global_limit"),
			);
			await vi.advanceTimersByTimeAsync(2000);
			expect(made.streamInvocations).toHaveLength(4);
			expect(reported(made.onAskEvent)).toEqual([]);

			made.streamInvocations[3].callbacks.onError(refusedAsFull("user_limit"));
			await vi.advanceTimersByTimeAsync(0);

			expect(made.streamInvocations).toHaveLength(4);
			expect(reported(made.onAskEvent)).toEqual([
				{ type: "answerNotSent", questionId: "q-1", quiet: false },
			]);
			// The capacity sentence is a send's: the card says the answer was not sent.
			expect(sentenceShown(made.adapters)).toEqual([]);
			expect(made.messages.map((row) => row.id)).toEqual(["user-1", "seg-1"]);
			expect(runtime.snapshot()).toMatchObject({
				isSending: false,
				canRetry: false,
			});
		});

		it("says alreadyAnswered to a 409 and takes the placeholder away", async () => {
			const made = onTheClock({
				checkForOrphanedStream: vi.fn(async () => "stream-1"),
			});
			const runtime = createNormalChatClientTurnRuntime(made.adapters);
			await runtime.answerQuestion(answerOf());
			runtime.queue(words("Meanwhile"));

			made.streamInvocations[0].callbacks.onError(alreadyAnswered());
			await vi.advanceTimersByTimeAsync(0);

			expect(reported(made.onAskEvent)).toEqual([
				{ type: "alreadyAnswered", questionId: "q-1" },
			]);
			expect(made.messages.map((row) => row.id)).toEqual(["user-1", "seg-1"]);
			// The winner's reply is not looked for here, and nothing is joined: the page
			// reads the questions and joins it, from a turn that has ended.
			expect(made.adapters.checkForOrphanedStream).not.toHaveBeenCalled();
			expect(made.streamInvocations).toHaveLength(1);
			expect(runtime.snapshot()).toMatchObject({
				isSending: false,
				active: false,
				canRetry: false,
				queuedTurn: null,
			});
			expect(sentenceShown(made.adapters)).toEqual([]);
			// What waited in the queue goes back to the composer: nothing drains it.
			expect(made.adapters.restorePayloadToDraft).toHaveBeenCalledWith(
				expect.objectContaining({ message: "Meanwhile" }),
			);
		});

		describe("when the answer did not land", () => {
			/** The server still runs the resume: its stream is found, and it says whose message it runs. */
			const resumeRunning =
				(): Partial<NormalChatClientTurnRuntimeAdapters> => ({
					checkForOrphanedStream: vi.fn(async () => "stream-1"),
					getStreamBufferInfo: vi.fn(async () => ({
						exists: true,
						userMessage: "Plan my trip",
						reasoningDepth: "thorough" as ReasoningDepth,
						createdAt: Date.now() - 2000,
					})),
				});

			it("joins the chat's running stream when a resume's connection died, else says answerNotSent", async () => {
				// The server runs the resume: the connection died, not the reply.
				const running = onTheClock(resumeRunning());
				const runtime = createNormalChatClientTurnRuntime(running.adapters);
				await runtime.answerQuestion(answerOf());
				const placeholderId = running.messages.at(-1)?.id;

				running.streamInvocations[0].callbacks.onError(
					new TypeError("network error"),
				);
				await vi.advanceTimersByTimeAsync(0);

				expect(running.streamInvocations).toHaveLength(2);
				expect(running.streamInvocations[1].options).toMatchObject({
					reconnectToStreamId: "stream-1",
				});
				// The old placeholder is replaced by the join's, which continues the same
				// row. The person's message is not drawn a second time.
				const streaming = running.messages.filter((row) => row.isStreaming);
				expect(streaming).toHaveLength(1);
				expect(streaming[0]).toMatchObject({ continuesMessageId: "seg-1" });
				expect(streaming[0].id).not.toBe(placeholderId);
				expect(
					running.messages.filter((row) => row.content === "Plan my trip"),
				).toHaveLength(1);
				// The resume runs, so the answer was taken up; nothing says it failed.
				expect(reported(running.onAskEvent)).toEqual([
					{ type: "answerAccepted", questionId: "q-1" },
				]);
				expect(sentenceShown(running.adapters)).toEqual([]);
				expect(runtime.snapshot()).toMatchObject({
					isSending: true,
					active: true,
					canRetry: false,
				});
				// The joined stream carries the rest of the reply like any other.
				running.streamInvocations[1].callbacks.onToken("Day one");
				running.streamInvocations[1].callbacks.onEnd("Day one", {
					assistantMessageId: "seg-2",
				});
				expect(reported(running.onAskEvent)).toHaveLength(1);

				// No stream of the chat: the answer did not land.
				const none = onTheClock();
				const second = createNormalChatClientTurnRuntime(none.adapters);
				await second.answerQuestion(answerOf());
				none.streamInvocations[0].callbacks.onError(
					new TypeError("network error"),
				);
				await vi.advanceTimersByTimeAsync(0);

				expect(none.adapters.checkForOrphanedStream).toHaveBeenCalledWith(
					"conv-1",
				);
				expect(none.streamInvocations).toHaveLength(1);
				expect(reported(none.onAskEvent)).toEqual([
					{ type: "answerNotSent", questionId: "q-1", quiet: false },
				]);
				expect(none.messages.map((row) => row.id)).toEqual(["user-1", "seg-1"]);
				expect(sentenceShown(none.adapters)).toEqual([]);
				expect(second.snapshot()).toMatchObject({
					isSending: false,
					canRetry: false,
				});
			});

			it.each([
				[
					"a 500 the server could not carry the answer on",
					500,
					"ANSWER_FAILED",
				],
				["a 409 that gave the claim back", 409, "QUESTION_NOT_WAITING"],
				["a 404 for a question that is gone", 404, "QUESTION_NOT_FOUND"],
				["a 400 for a body it cannot read", 400, "INVALID_ANSWER"],
				["a preflight refusal", 422, "attachment_not_ready"],
				// The answer route never says this (a message does not wait behind an
				// answer), but if it did the answer would still need an outcome for its
				// card: it is not a message turned away.
				["a 409 that says a question waits", 409, "QUESTION_WAITING"],
			])("settles %s the same way: nothing to join, so the card is told", async (_name, status, code) => {
				const made = onTheClock({ readChatMessages: vi.fn(async () => []) });
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await runtime.answerQuestion(answerOf());
				runtime.queue(words("Meanwhile"));

				made.streamInvocations[0].callbacks.onError(
					refused(status, code, "The server's English"),
				);
				await vi.advanceTimersByTimeAsync(0);

				expect(reported(made.onAskEvent)).toEqual([
					{ type: "answerNotSent", questionId: "q-1", quiet: false },
				]);
				// No sentence, no Retry, nothing asked of the chat about a message, and the
				// words that waited behind the answer are in the composer.
				expect(sentenceShown(made.adapters)).toEqual([]);
				expect(made.adapters.readChatMessages).not.toHaveBeenCalled();
				expect(made.adapters.restorePayloadToDraft).toHaveBeenCalledWith(
					expect.objectContaining({ message: "Meanwhile" }),
				);
				expect(made.messages.map((row) => row.id)).toEqual(["user-1", "seg-1"]);
				expect(runtime.snapshot()).toMatchObject({
					isSending: false,
					canRetry: false,
				});
				// A refusal the server named is not a connection to ask after twice.
				expect(made.streamInvocations).toHaveLength(1);
				// An answer is not a message the server turned away: the only words given
				// back are the ones that waited behind it.
				expect(made.adapters.restorePayloadToDraft).toHaveBeenCalledTimes(1);
			});

			it("recovers a resume that dropped after some text as a send does: the joined stream continues the asking row", async () => {
				const made = onTheClock(resumeRunning());
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await runtime.answerQuestion(answerOf());
				made.streamInvocations[0].callbacks.onToken("Day one, ");

				made.streamInvocations[0].callbacks.onError(
					new TypeError("network error"),
				);
				expect(made.adapters.schedule).toHaveBeenCalledWith(
					expect.any(Function),
					500,
				);
				await vi.advanceTimersByTimeAsync(500);

				expect(made.streamInvocations).toHaveLength(2);
				expect(made.streamInvocations[1].options).toMatchObject({
					reconnectToStreamId: "stream-1",
				});
				const streaming = made.messages.filter((row) => row.isStreaming);
				expect(streaming).toHaveLength(1);
				expect(streaming[0]).toMatchObject({ continuesMessageId: "seg-1" });
				// Accepted when the first text came, and not again for the join.
				expect(reported(made.onAskEvent)).toEqual([
					{ type: "answerAccepted", questionId: "q-1" },
				]);
				expect(sentenceShown(made.adapters)).toEqual([]);
			});

			it("gives a resume up when its stream cannot be found after a drop, without asking the server about a message", async () => {
				const made = onTheClock({ readChatMessages: vi.fn(async () => []) });
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await runtime.answerQuestion(answerOf());
				made.streamInvocations[0].callbacks.onToken("Day one, ");
				made.streamInvocations[0].callbacks.onError(
					new TypeError("network error"),
				);

				// The three looks of the recovery, then its give-up.
				await vi.advanceTimersByTimeAsync(500 + 1000 + 2000);

				expect(reported(made.onAskEvent)).toEqual([
					{ type: "answerAccepted", questionId: "q-1" },
					{ type: "answerNotSent", questionId: "q-1", quiet: false },
				]);
				// A resume's reply is not "a reply after the person's message": the chat is
				// not read for it, and no sentence or Retry is offered.
				expect(made.adapters.readChatMessages).not.toHaveBeenCalled();
				expect(sentenceShown(made.adapters)).toEqual([]);
				expect(made.messages.map((row) => row.id)).toEqual(["user-1", "seg-1"]);
				expect(runtime.snapshot()).toMatchObject({
					isSending: false,
					canRetry: false,
				});
			});

			it("leaves a turn that started meanwhile alone when a dropped resume is given up", async () => {
				const made = onTheClock();
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await runtime.answerQuestion(answerOf());
				made.streamInvocations[0].callbacks.onToken("Day one, ");
				made.streamInvocations[0].callbacks.onError(
					new TypeError("network error"),
				);
				// The composer is free after a drop: a message sent meanwhile is a turn.
				await runtime.send(words("Hello again"));
				expect(made.streamInvocations).toHaveLength(2);

				await vi.advanceTimersByTimeAsync(500 + 1000 + 2000);

				expect(reported(made.onAskEvent, "answerNotSent")).toEqual([]);
				expect(runtime.snapshot()).toMatchObject({
					isSending: true,
					active: true,
				});
			});

			// A hidden tab can lose its stream to the browser while the server goes on
			// with the resume. What became of the answer is not known then, and a look
			// from a hidden tab says little, so the answer stays pending: the runtime
			// tells the page nothing until the tab is visible and the recovery has looked.
			describe("when the browser cuts the stream off in the background", () => {
				const cutOffByTheBrowser = () =>
					Object.assign(new Error("The operation was aborted."), {
						name: "AbortError",
					});
				const beforeAndAfterTheResumeSpoke = [
					["before the resume has spoken", false],
					["after the resume has spoken", true],
				] as const;

				it.each(
					beforeAndAfterTheResumeSpoke,
				)("keeps the answer pending, then joins the resume as the answer's once the tab is visible, %s", async (_when, spoke) => {
					const made = onTheClock({
						isBrowserHidden: vi.fn(() => true),
						...resumeRunning(),
					});
					const runtime = createNormalChatClientTurnRuntime(made.adapters);
					await runtime.answerQuestion(answerOf());
					if (spoke) made.streamInvocations[0].callbacks.onToken("Day one, ");

					made.streamInvocations[0].callbacks.onError(cutOffByTheBrowser());
					await vi.advanceTimersByTimeAsync(0);

					// Nothing new is told: the answer is neither sent nor lost as far as the
					// tab knows (what the resume said before the cut is all the page heard).
					expect(made.adapters.onBackgroundInterrupted).toHaveBeenCalledTimes(
						1,
					);
					expect(runtime.snapshot()).toMatchObject({
						streamInterruptedByBackground: true,
						isSending: false,
						canRetry: false,
					});
					expect(reported(made.onAskEvent)).toEqual(
						spoke ? [{ type: "answerAccepted", questionId: "q-1" }] : [],
					);
					expect(made.adapters.checkForOrphanedStream).not.toHaveBeenCalled();
					expect(made.messages.map((row) => row.id)).toEqual([
						"user-1",
						"seg-1",
					]);
					expect(sentenceShown(made.adapters)).toEqual([]);

					// The tab is visible: the server still runs the resume, its stream is
					// joined, and the placeholder continues the asking row although the page
					// knows nothing of an answer on its way (no `getAnsweringQuestionMessageId`).
					await runtime.handleVisibilityVisible();

					expect(made.streamInvocations).toHaveLength(2);
					expect(made.streamInvocations[1].options).toMatchObject({
						reconnectToStreamId: "stream-1",
					});
					const streaming = made.messages.filter((row) => row.isStreaming);
					expect(streaming).toHaveLength(1);
					expect(streaming[0]).toMatchObject({ continuesMessageId: "seg-1" });
					// The answer was taken up, said once however the cut came.
					expect(reported(made.onAskEvent)).toEqual([
						{ type: "answerAccepted", questionId: "q-1" },
					]);
					expect(made.adapters.loadPersistedData).not.toHaveBeenCalled();
					expect(sentenceShown(made.adapters)).toEqual([]);
				});

				it.each(
					beforeAndAfterTheResumeSpoke,
				)("tells the card quietly, and reads the chat, when the recovery finds no stream of the resume, %s", async (_when, spoke) => {
					const made = onTheClock({ isBrowserHidden: vi.fn(() => true) });
					const runtime = createNormalChatClientTurnRuntime(made.adapters);
					await runtime.answerQuestion(answerOf());
					if (spoke) made.streamInvocations[0].callbacks.onToken("Day one, ");
					made.streamInvocations[0].callbacks.onError(cutOffByTheBrowser());

					await runtime.handleVisibilityVisible();

					// Not a failure: the resume may have finished meanwhile. After the
					// acceptance it still follows it, and the page reads the questions and
					// the chat to learn which.
					expect(reported(made.onAskEvent)).toEqual([
						...(spoke
							? [{ type: "answerAccepted", questionId: "q-1" } as const]
							: []),
						{ type: "answerNotSent", questionId: "q-1", quiet: true },
					]);
					expect(made.adapters.loadPersistedData).toHaveBeenCalledTimes(1);
					expect(made.streamInvocations).toHaveLength(1);
					expect(sentenceShown(made.adapters)).toEqual([]);
					expect(runtime.snapshot()).toMatchObject({
						isSending: false,
						canRetry: false,
					});
				});

				it("does not lend a pending answer to a later stream that was no resume", async () => {
					const made = onTheClock({
						isBrowserHidden: vi.fn(() => true),
						...resumeRunning(),
					});
					const runtime = createNormalChatClientTurnRuntime(made.adapters);
					await runtime.answerQuestion(answerOf());
					made.streamInvocations[0].callbacks.onError(cutOffByTheBrowser());

					// Before the recovery has run, a message is sent (the composer is free
					// after the cut) and the browser cuts its stream off too.
					await runtime.send(words("Hello"));
					made.streamInvocations[1].callbacks.onError(cutOffByTheBrowser());
					await runtime.handleVisibilityVisible();

					// Its stream is joined as the ordinary reply it is: no row to continue,
					// and nothing is said of the answer that was left behind.
					expect(made.streamInvocations).toHaveLength(3);
					const streaming = made.messages.filter((row) => row.isStreaming);
					expect(streaming).toHaveLength(1);
					expect(streaming[0]).not.toHaveProperty("continuesMessageId");
					expect(reported(made.onAskEvent)).toEqual([]);
				});

				// The page is told the stream was interrupted (`onBackgroundInterrupted`)
				// before the resume that was cut off is stashed. A callback that runs the
				// visibility recovery at once reads the stash in that very call, so it has
				// to be there already: read empty, the recovery joined the stream as an
				// ordinary reply, never said the answer was taken up, and drew the
				// continuation as a reply of its own.
				it("has the cut-off resume stashed before the page is told the stream was interrupted", async () => {
					let runtime: ReturnType<typeof createNormalChatClientTurnRuntime>;
					const made = onTheClock({
						isBrowserHidden: vi.fn(() => true),
						...resumeRunning(),
						onBackgroundInterrupted: vi.fn(() => {
							void runtime.handleVisibilityVisible();
						}),
					});
					runtime = createNormalChatClientTurnRuntime(made.adapters);
					await runtime.answerQuestion(answerOf());

					made.streamInvocations[0].callbacks.onError(cutOffByTheBrowser());
					await vi.advanceTimersByTimeAsync(0);

					// The recovery the callback started found the resume: its stream is joined
					// as the answer's, under the row that asked, and the answer was taken up.
					expect(made.adapters.onBackgroundInterrupted).toHaveBeenCalledTimes(
						1,
					);
					expect(made.streamInvocations).toHaveLength(2);
					const streaming = made.messages.filter((row) => row.isStreaming);
					expect(streaming).toHaveLength(1);
					expect(streaming[0]).toMatchObject({ continuesMessageId: "seg-1" });
					expect(reported(made.onAskEvent)).toEqual([
						{ type: "answerAccepted", questionId: "q-1" },
					]);
				});
			});

			it("treats a joined resume that is cut again as the answer's: its row goes on, and no message is drawn or offered for Retry", async () => {
				let streamRunning: string | null = "stream-1";
				const made = onTheClock({
					...resumeRunning(),
					checkForOrphanedStream: vi.fn(async () => streamRunning),
					readChatMessages: vi.fn(async () => []),
				});
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await runtime.answerQuestion(answerOf());
				runtime.queue(words("Meanwhile"));

				// The answer's request dies and the server runs the resume: it is joined.
				made.streamInvocations[0].callbacks.onError(
					new TypeError("network error"),
				);
				await vi.advanceTimersByTimeAsync(0);
				expect(made.streamInvocations).toHaveLength(2);

				// The joined stream is cut too, while the server still runs the resume:
				// joined again, under the same row.
				made.streamInvocations[1].callbacks.onToken("Day one, ");
				made.streamInvocations[1].callbacks.onError(
					new TypeError("network error"),
				);
				await vi.advanceTimersByTimeAsync(0);
				expect(made.streamInvocations).toHaveLength(3);
				expect(made.streamInvocations[2].options).toMatchObject({
					reconnectToStreamId: "stream-1",
				});
				const streaming = made.messages.filter((row) => row.isStreaming);
				expect(streaming).toHaveLength(1);
				expect(streaming[0]).toMatchObject({ continuesMessageId: "seg-1" });

				// Then the resume is gone from the server: the card gets its answer back.
				streamRunning = null;
				made.streamInvocations[2].callbacks.onError(
					new TypeError("network error"),
				);
				await vi.advanceTimersByTimeAsync(0);

				expect(reported(made.onAskEvent)).toEqual([
					{ type: "answerAccepted", questionId: "q-1" },
					{ type: "answerNotSent", questionId: "q-1", quiet: false },
				]);
				// The person's message is on screen once, no sentence and no Retry are
				// offered, and the chat is not read for "a reply to a message".
				expect(made.messages.map((row) => row.id)).toEqual(["user-1", "seg-1"]);
				expect(made.messageListEvents.appendUserMessage).not.toHaveBeenCalled();
				expect(sentenceShown(made.adapters)).toEqual([]);
				expect(made.adapters.readChatMessages).not.toHaveBeenCalled();
				expect(runtime.snapshot()).toMatchObject({
					isSending: false,
					canRetry: false,
					lastUserMessage: "",
				});
				// What waited behind the answer is in the composer; the person's own
				// message, which the server holds, is not.
				const restored = vi.mocked(made.adapters.restorePayloadToDraft).mock
					.calls;
				expect(restored.map(([payload]) => payload.message)).toEqual([
					"Meanwhile",
				]);
				await runtime.retry();
				expect(made.streamInvocations).toHaveLength(3);
			});

			it("rejoins a joined resume at most three times over, then gives the answer up", async () => {
				const made = onTheClock(resumeRunning());
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await runtime.answerQuestion(answerOf());
				made.streamInvocations[0].callbacks.onError(
					new TypeError("network error"),
				);
				await vi.advanceTimersByTimeAsync(0);

				// The server goes on running the resume; every joined stream is cut.
				for (let joined = 1; joined <= 4; joined += 1) {
					expect(made.streamInvocations).toHaveLength(joined + 1);
					made.streamInvocations[joined].callbacks.onError(
						new TypeError("network error"),
					);
					await vi.advanceTimersByTimeAsync(0);
				}

				// The answer's own stream, the first join and three rejoins, and then the
				// limit: the fourth joined stream's cut is the last the runtime follows.
				expect(made.streamInvocations).toHaveLength(5);
				expect(reported(made.onAskEvent)).toEqual([
					{ type: "answerAccepted", questionId: "q-1" },
					{ type: "answerNotSent", questionId: "q-1", quiet: false },
				]);
				expect(made.messages.map((row) => row.id)).toEqual(["user-1", "seg-1"]);
				expect(sentenceShown(made.adapters)).toEqual([]);
			});

			it("keeps the row when a joined resume is refused for capacity and joined again", async () => {
				const made = onTheClock(resumeRunning());
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await runtime.answerQuestion(answerOf());
				made.streamInvocations[0].callbacks.onError(
					new TypeError("network error"),
				);
				await vi.advanceTimersByTimeAsync(0);
				expect(made.streamInvocations).toHaveLength(2);

				made.streamInvocations[1].callbacks.onError(
					refusedAsFull("user_limit"),
				);
				await vi.advanceTimersByTimeAsync(500);

				expect(made.streamInvocations).toHaveLength(3);
				const streaming = made.messages.filter((row) => row.isStreaming);
				expect(streaming).toHaveLength(1);
				expect(streaming[0]).toMatchObject({ continuesMessageId: "seg-1" });
				expect(reported(made.onAskEvent)).toEqual([
					{ type: "answerAccepted", questionId: "q-1" },
				]);
			});

			it.each([
				[
					"a provider error",
					() =>
						Object.assign(new Error("The model refused."), {
							code: "model_error",
						}),
				],
				["a lost connection", () => new TypeError("network error")],
			])("does not draw the person's message again or offer Retry when %s ends a resume the page joined with no answer in hand", async (_name, failure) => {
				const refreshQuestions = vi.fn();
				const made = onTheClock({
					getAnsweringQuestionMessageId: vi.fn(() => "seg-1"),
					refreshQuestions,
				});
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				// A reload during the resume: the page joins its stream.
				await runtime.reconnectToOrphanedStream("stream-1", "Plan my trip");
				runtime.queue(words("Meanwhile"));
				made.streamInvocations[0].callbacks.onToken("Day one, ");

				made.streamInvocations[0].callbacks.onError(failure());
				await vi.advanceTimersByTimeAsync(0);

				// The chat is read back and the page reads the question again: the server
				// has it back as waiting, or as answered.
				expect(made.adapters.loadPersistedData).toHaveBeenCalledTimes(1);
				expect(refreshQuestions).toHaveBeenCalledTimes(1);
				// The message on screen is not drawn a second time, no sentence is shown and
				// Retry is not offered (the server would refuse it while a question waits).
				expect(made.messageListEvents.appendUserMessage).not.toHaveBeenCalled();
				expect(made.messages.map((row) => row.id)).toEqual(["user-1", "seg-1"]);
				expect(sentenceShown(made.adapters)).toEqual([]);
				expect(runtime.snapshot()).toMatchObject({
					canRetry: false,
					lastUserMessage: "",
					isSending: false,
				});
				// What waited behind it is the person's to send again.
				expect(made.adapters.restorePayloadToDraft).toHaveBeenCalledTimes(1);
				expect(made.adapters.restorePayloadToDraft).toHaveBeenCalledWith(
					expect.objectContaining({ message: "Meanwhile" }),
				);
				expect(reported(made.onAskEvent)).toEqual([]);
				await runtime.retry();
				expect(made.streamInvocations).toHaveLength(1);
			});
		});

		it("gives the card back quietly when Stop is pressed before the resume has streamed anything", async () => {
			const made = onTheClock();
			const runtime = createNormalChatClientTurnRuntime(made.adapters);
			await runtime.answerQuestion(answerOf());
			runtime.queue(words("Meanwhile"));

			expect(runtime.stop()).toBe(true);
			// The transport ends a stopped stream like this, and does not wait for the
			// server's own end: no message id.
			made.streamInvocations[0].callbacks.onEnd("", { wasStopped: true });
			await vi.advanceTimersByTimeAsync(0);

			expect(reported(made.onAskEvent)).toEqual([
				{ type: "answerNotSent", questionId: "q-1", quiet: true },
			]);
			// The empty placeholder goes instead of turning into a "Stopped" row under a
			// card that has not folded.
			expect(made.messages.map((row) => row.id)).toEqual(["user-1", "seg-1"]);
			expect(
				made.messageListEvents.finalizeStreamingMessage,
			).not.toHaveBeenCalled();
			expect(made.adapters.restorePayloadToDraft).toHaveBeenCalledWith(
				expect.objectContaining({ message: "Meanwhile" }),
			);
			expect(runtime.snapshot()).toMatchObject({
				isSending: false,
				canRetry: false,
			});
		});

		it("ends a resume that was stopped after it began like any stopped turn", async () => {
			const made = onTheClock();
			const runtime = createNormalChatClientTurnRuntime(made.adapters);
			await runtime.answerQuestion(answerOf());
			made.streamInvocations[0].callbacks.onToken("Day one");

			made.streamInvocations[0].callbacks.onEnd("Day one", {
				wasStopped: true,
			});

			expect(reported(made.onAskEvent)).toEqual([
				{ type: "answerAccepted", questionId: "q-1" },
			]);
			expect(
				made.messageListEvents.finalizeStreamingMessage,
			).toHaveBeenCalledTimes(1);
			expect(runtime.snapshot()).toMatchObject({ isSending: false });
		});

		it("gives a refused send's words back when a question waits", async () => {
			const made = onTheClock();
			const runtime = createNormalChatClientTurnRuntime(made.adapters);
			await runtime.send({ ...words("Hello"), attachmentIds: ["file-1"] });
			runtime.queue(words("And this"));
			expect(made.messages.map((row) => row.role)).toEqual([
				"user",
				"assistant",
				"user",
				"assistant",
			]);

			made.streamInvocations[0].callbacks.onError(questionWaiting());
			await vi.advanceTimersByTimeAsync(0);

			// Both bubbles go; the words return to the composer, then the queued ones.
			expect(made.messages.map((row) => row.id)).toEqual(["user-1", "seg-1"]);
			const restored = vi.mocked(made.adapters.restorePayloadToDraft).mock
				.calls;
			expect(restored.map(([payload]) => payload.message)).toEqual([
				"Hello",
				"And this",
			]);
			expect(restored[0][0].attachmentIds).toEqual(["file-1"]);
			// No sentence and no Retry, and the page is told to read the questions and the chat.
			expect(sentenceShown(made.adapters)).toEqual([]);
			expect(reported(made.onAskEvent)).toEqual([
				{ type: "refusedWhileWaiting" },
			]);
			expect(runtime.snapshot()).toMatchObject({
				isSending: false,
				active: false,
				canRetry: false,
			});
			// Not a capacity refusal, and not an update: nothing waits or backs off.
			expect(made.adapters.schedule).not.toHaveBeenCalled();
			expect(made.adapters.onServerUpdateSign).not.toHaveBeenCalled();
			expect(made.streamInvocations).toHaveLength(1);
			// Retry has nothing to send.
			await runtime.retry();
			expect(made.streamInvocations).toHaveLength(1);
		});

		it("takes a refused Retry away quietly when a question waits", async () => {
			const made = onTheClock();
			made.messages.length = 0;
			const runtime = createNormalChatClientTurnRuntime(made.adapters);
			await runtime.send(words("Plan my trip"));
			made.streamInvocations[0].callbacks.onError(new Error("Network failed"));
			// The server did keep the turn, and the page read it back.
			made.messages.length = 0;
			made.messages.push(
				{
					id: "user-saved",
					role: "user",
					content: "Plan my trip",
					timestamp: 1,
				},
				{
					id: "assistant-saved",
					role: "assistant",
					content: "A",
					timestamp: 2,
				},
			);
			vi.mocked(made.adapters.setSendError).mockClear();
			await runtime.retry();
			expect(made.streamInvocations[1].options).toMatchObject({
				retryAssistantMessageId: "assistant-saved",
			});

			// A stale page: a question waits, and the retry route turns the request away.
			made.streamInvocations[1].callbacks.onError(questionWaiting());
			await vi.advanceTimersByTimeAsync(0);

			// The placeholder goes; the person's message is the server's, and its words
			// are not the composer's to get back.
			expect(made.messages.map((row) => row.id)).toEqual(["user-saved"]);
			expect(made.adapters.restorePayloadToDraft).not.toHaveBeenCalled();
			expect(sentenceShown(made.adapters)).toEqual([]);
			expect(reported(made.onAskEvent)).toEqual([
				{ type: "refusedWhileWaiting" },
			]);
			expect(runtime.snapshot()).toMatchObject({
				isSending: false,
				active: false,
				canRetry: false,
			});
			expect(made.streamInvocations).toHaveLength(2);
			// Retry is not on offer after it.
			await runtime.retry();
			expect(made.streamInvocations).toHaveLength(2);
		});

		it("takes a refused regenerate away the same way, leaving the person's message", async () => {
			const made = onTheClock();
			made.messages.length = 0;
			made.messages.push({
				id: "user-saved",
				role: "user",
				content: "Plan my trip",
				timestamp: 1,
			});
			const runtime = createNormalChatClientTurnRuntime(made.adapters);
			await runtime.send(words("Plan my trip"), {
				skipUserMessage: true,
				skipPersistUserMessage: true,
				retryAssistantMessageId: "assistant-old",
				retryUserMessageId: "user-saved",
			});
			runtime.queue(words("Meanwhile"));

			made.streamInvocations[0].callbacks.onError(questionWaiting());
			await vi.advanceTimersByTimeAsync(0);

			expect(made.messages.map((row) => row.id)).toEqual(["user-saved"]);
			// The regenerate has no words to give back (the server holds the message);
			// what waited behind it returns to the composer, as for any turn that ends.
			expect(made.adapters.restorePayloadToDraft).toHaveBeenCalledTimes(1);
			expect(made.adapters.restorePayloadToDraft).toHaveBeenCalledWith(
				expect.objectContaining({ message: "Meanwhile" }),
			);
			expect(sentenceShown(made.adapters)).toEqual([]);
			expect(reported(made.onAskEvent)).toEqual([
				{ type: "refusedWhileWaiting" },
			]);
			expect(runtime.snapshot()).toMatchObject({
				isSending: false,
				canRetry: false,
				queuedTurn: null,
			});
		});

		it("keeps the bubble of a message the server holds when its Retry is refused because a question waits", async () => {
			const made = onTheClock({
				// The server holds the message and no reply, as a regenerate that failed in
				// the model leaves it.
				readChatMessages: vi.fn(async () => [
					{
						id: "user-saved",
						role: "user" as const,
						content: "Plan my trip",
						timestamp: 1,
					},
				]),
			});
			made.messages.length = 0;
			const runtime = createNormalChatClientTurnRuntime(made.adapters);
			await runtime.send(words("Plan my trip"));
			made.streamInvocations[0].callbacks.onError(new Error("Network failed"));
			await runtime.retry();
			expect(made.streamInvocations[1].options).toMatchObject({
				retryUserMessageId: "user-saved",
			});
			vi.mocked(made.adapters.setSendError).mockClear();

			made.streamInvocations[1].callbacks.onError(questionWaiting());
			await vi.advanceTimersByTimeAsync(0);

			// The message is the server's: its bubble stays and only the placeholder
			// goes, with no words to give back.
			expect(made.messages.map((row) => row.id)).toEqual(["id-1"]);
			expect(made.adapters.restorePayloadToDraft).not.toHaveBeenCalled();
			expect(sentenceShown(made.adapters)).toEqual([]);
			expect(reported(made.onAskEvent)).toEqual([
				{ type: "refusedWhileWaiting" },
			]);
			expect(runtime.snapshot()).toMatchObject({
				isSending: false,
				canRetry: false,
			});
		});

		it("gives a refused Retry's words back when the server never got the message and a question waits", async () => {
			const made = onTheClock();
			made.messages.length = 0;
			const runtime = createNormalChatClientTurnRuntime(made.adapters);
			await runtime.send({
				...words("Plan my trip"),
				attachmentIds: ["file-1"],
			});
			made.streamInvocations[0].callbacks.onError(new Error("Network failed"));
			// The list ends in the message that failed: the server never got it, and
			// Retry sends it again as a message (not as a regenerate of a reply).
			expect(made.messages.map((row) => row.id)).toEqual(["id-1"]);
			await runtime.retry();
			expect(made.streamInvocations).toHaveLength(2);
			expect(
				made.streamInvocations[1].options?.retryAssistantMessageId,
			).toBeUndefined();
			runtime.queue(words("Meanwhile"));
			vi.mocked(made.adapters.setSendError).mockClear();

			// A stale page: a question waits, and the server turns the message away.
			made.streamInvocations[1].callbacks.onError(questionWaiting());
			await vi.advanceTimersByTimeAsync(0);

			// The bubble goes with the placeholder, and its words return to the
			// composer with their files, before the ones that waited behind them.
			expect(made.messages).toEqual([]);
			const restored = vi
				.mocked(made.adapters.restorePayloadToDraft)
				.mock.calls.map(([payload]) => payload);
			expect(restored.map((payload) => payload.message)).toEqual([
				"Plan my trip",
				"Meanwhile",
			]);
			expect(restored[0].attachmentIds).toEqual(["file-1"]);
			// No sentence and no Retry: the words are in the composer now.
			expect(sentenceShown(made.adapters)).toEqual([]);
			expect(reported(made.onAskEvent)).toEqual([
				{ type: "refusedWhileWaiting" },
			]);
			expect(runtime.snapshot()).toMatchObject({
				isSending: false,
				active: false,
				canRetry: false,
				queuedTurn: null,
			});
			await runtime.retry();
			expect(made.streamInvocations).toHaveLength(2);
		});

		it("takes an Atlas kickoff that is refused because a question waits back to the composer without a sentence", async () => {
			const made = onTheClock({
				submitAtlasTurn: vi.fn(async () => {
					throw questionWaiting();
				}),
			});
			const runtime = createNormalChatClientTurnRuntime(made.adapters);

			await runtime.send({
				...words("Research the market"),
				atlasMode: true,
				atlasProfile: "in-depth",
				atlasAction: "create",
			});
			await vi.advanceTimersByTimeAsync(0);

			expect(made.messages.map((row) => row.id)).toEqual(["user-1", "seg-1"]);
			expect(made.adapters.restorePayloadToDraft).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "Research the market",
					atlasMode: true,
				}),
			);
			expect(sentenceShown(made.adapters)).toEqual([]);
			expect(reported(made.onAskEvent)).toEqual([
				{ type: "refusedWhileWaiting" },
			]);
			expect(runtime.snapshot()).toMatchObject({
				isSending: false,
				canRetry: false,
			});
		});

		it("asks the page to read the questions when an ask_user call is done", async () => {
			const refreshQuestions = vi.fn();
			const made = onTheClock({ refreshQuestions });
			const runtime = createNormalChatClientTurnRuntime(made.adapters);
			await runtime.send(words("Plan my trip"));
			const { callbacks } = made.streamInvocations[0];

			// Running is not yet a question on the server; other tools are not asks.
			callbacks.onToolCall?.("ask_user", { questions: [] }, "running");
			callbacks.onToolCall?.("web_search", { query: "x" }, "done");
			expect(refreshQuestions).not.toHaveBeenCalled();

			callbacks.onToolCall?.("ask_user", { questions: [] }, "done");
			expect(refreshQuestions).toHaveBeenCalledTimes(1);
			callbacks.onToolCall?.("ask_user", { questions: [] }, "failed");
			expect(refreshQuestions).toHaveBeenCalledTimes(2);

			// A page that does not listen is not asked to.
			const quiet = onTheClock();
			const second = createNormalChatClientTurnRuntime(quiet.adapters);
			await second.send(words("Plan my trip"));
			expect(() =>
				quiet.streamInvocations[0].callbacks.onToolCall?.(
					"ask_user",
					{},
					"done",
				),
			).not.toThrow();
		});

		it("continues the answering question's row with a reconnect's placeholder", async () => {
			let answering: string | null = "seg-1";
			const made = onTheClock({
				getAnsweringQuestionMessageId: vi.fn(() => answering),
			});
			const runtime = createNormalChatClientTurnRuntime(made.adapters);

			// A reload during the resume joins its stream: the replay continues the
			// asking row, under the person's message that is on screen.
			await runtime.reconnectToOrphanedStream("stream-1", "Plan my trip");
			expect(
				made.messageListEvents.appendAssistantPlaceholder.mock.calls.at(
					-1,
				)?.[0],
			).toMatchObject({ role: "assistant", continuesMessageId: "seg-1" });
			expect(made.messageListEvents.appendUserMessage).not.toHaveBeenCalled();
			expect(made.streamInvocations[0].options).toMatchObject({
				reconnectToStreamId: "stream-1",
			});

			// With no answer on its way, the same reconnect starts an ordinary reply.
			const ordinary = onTheClock({
				getAnsweringQuestionMessageId: vi.fn(() => answering),
			});
			answering = null;
			const second = createNormalChatClientTurnRuntime(ordinary.adapters);
			await second.reconnectToOrphanedStream("stream-2", "Plan my trip");
			const placeholder =
				ordinary.messageListEvents.appendAssistantPlaceholder.mock.calls.at(
					-1,
				)?.[0];
			expect(placeholder).toMatchObject({ role: "assistant" });
			expect(placeholder).not.toHaveProperty("continuesMessageId");
		});

		it("sends nothing for an answer while a turn runs or an edit's resend is pending, tells the page it was not sent, and clears detached when it starts", async () => {
			// The page raised its card to busy before it handed the answer over, and its own
			// checks passed; a runtime that turns the answer away must say so, quietly
			// (nothing failed), or the card stays busy until a reload.
			const notSent: AskRuntimeEvent = {
				type: "answerNotSent",
				questionId: "q-1",
				quiet: true,
			};

			// A turn runs.
			const running = onTheClock();
			const busy = createNormalChatClientTurnRuntime(running.adapters);
			await busy.send(words("Hello"));
			await busy.answerQuestion(answerOf());
			expect(running.streamInvocations).toHaveLength(1);
			expect(
				running.messageListEvents.appendAssistantPlaceholder,
			).toHaveBeenCalledTimes(1);
			expect(reported(running.onAskEvent)).toEqual([notSent]);

			// The chat is sealed, an edit is open, or an edit's resend is on its way.
			for (const guard of [
				{ isReadOnly: vi.fn(() => true) },
				{ isEditOpen: vi.fn(() => true) },
				{ isEditResendPending: vi.fn(() => true) },
			] satisfies Partial<NormalChatClientTurnRuntimeAdapters>[]) {
				const held = onTheClock(guard);
				const idle = createNormalChatClientTurnRuntime(held.adapters);
				await idle.answerQuestion(answerOf());
				expect(held.streamInvocations).toHaveLength(0);
				expect(
					held.messageListEvents.appendAssistantPlaceholder,
				).not.toHaveBeenCalled();
				expect(idle.snapshot()).toMatchObject({ isSending: false });
				expect(reported(held.onAskEvent)).toEqual([notSent]);
			}

			// A page that was left is back when it answers: what a backoff scheduled by
			// this answer does is not dropped as the work of a page nobody sees.
			const left = onTheClock();
			const runtime = createNormalChatClientTurnRuntime(left.adapters);
			runtime.detach();
			await runtime.answerQuestion(answerOf());
			expect(left.streamInvocations).toHaveLength(1);
			left.streamInvocations[0].callbacks.onError(refusedAsFull("user_limit"));
			await vi.advanceTimersByTimeAsync(500);
			expect(left.streamInvocations).toHaveLength(2);
		});

		describe("when the page is left", () => {
			it("sends nothing from an update wait once the page is left, and keeps no words", async () => {
				const made = onTheClock();
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await runtime.answerQuestion(answerOf());
				made.streamInvocations[0].callbacks.onError(refusedAsDraining());

				// The page is destroyed: it detaches, then takes the wait. An answer has no
				// words to keep: the card holds them, and the question still waits.
				runtime.detach();
				expect(runtime.takeWaitingRequest()).toBeNull();
				made.server.health = WELL;
				await vi.advanceTimersByTimeAsync(EIGHT_MINUTES_MS);

				expect(made.streamInvocations).toHaveLength(1);
				expect(reported(made.onAskEvent)).toEqual([]);
				expect(made.adapters.setTurnWaitingForUpdate).toHaveBeenLastCalledWith(
					false,
				);
			});

			it("tells the page nothing once the chat on screen is another", async () => {
				let conversationId = "conv-1";
				const made = onTheClock({
					getConversationId: vi.fn(() => conversationId),
				});
				const runtime = createNormalChatClientTurnRuntime(made.adapters);
				await runtime.answerQuestion(answerOf());

				conversationId = "conv-2";
				made.streamInvocations[0].callbacks.onToken("Plan");
				made.streamInvocations[0].callbacks.onEnd("Plan", {
					assistantMessageId: "seg-2",
					waitingQuestionId: "q-2",
				});
				expect(reported(made.onAskEvent)).toEqual([]);

				// And a refusal that comes back for the chat that was left reaches no one.
				const refusedLater = onTheClock({
					getConversationId: vi.fn(() => conversationId),
				});
				conversationId = "conv-1";
				const second = createNormalChatClientTurnRuntime(refusedLater.adapters);
				await second.answerQuestion(answerOf());
				conversationId = "conv-2";
				refusedLater.streamInvocations[0].callbacks.onError(alreadyAnswered());
				await vi.advanceTimersByTimeAsync(0);
				expect(reported(refusedLater.onAskEvent)).toEqual([]);
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

describe("Stop terminal handoff", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	function fixture(outcome: "stopped" | "answered" = "stopped") {
		const output = createNormalChatOutputAccumulator();
		const scope = {
			version: 1,
			turnId: "stop-turn",
			segmentId: "stop-segment",
			attemptId: "attempt",
			stepId: "working",
			phase: "working",
		} as const;
		output.apply({
			...scope,
			sequence: 1,
			type: "block_start",
			blockId: "work",
			nativeId: "work",
			kind: "text",
			role: "activity",
		});
		output.apply({
			...scope,
			sequence: 2,
			type: "block_delta",
			blockId: "work",
			text: "Retained working activity",
		});
		const live = output.getProjection();
		const completion = {
			version: 1,
			turnId: scope.turnId,
			segmentId: scope.segmentId,
			phase: "working",
			outcome,
			stopCause: "user_stop",
			workingStopCause: "user_stop",
			closingAttempted: false,
		} as const;
		output.apply({ ...scope, sequence: 3, type: "completion", completion });
		const terminal = output.getProjection();
		const saved = applyNormalChatOutputView(
			[{ id: "saved-stop", role: "assistant", content: "", timestamp: 1 }],
			"saved-stop",
			terminal,
		)[0];
		return { live, terminal, saved, completion };
	}

	async function stopped(
		overrides: Partial<NormalChatClientTurnRuntimeAdapters> = {},
		beforeStop?: (
			runtime: ReturnType<typeof createNormalChatClientTurnRuntime>,
			original: StreamInvocation,
		) => void,
		live = true,
	) {
		const facts = fixture();
		const made = makeAdapters({
			schedule: vi.fn((cb, ms) => setTimeout(cb, ms)),
			readChatMessages: vi.fn(async () => [facts.saved]),
			...overrides,
		});
		const stream = made.adapters.streamChat;
		made.adapters.streamChat = vi.fn((...args: Parameters<typeof stream>) =>
			Object.assign(stream(...args), {
				streamId: args[3]?.reconnectToStreamId ?? "stop-stream",
			}),
		);
		const runtime = createNormalChatClientTurnRuntime(made.adapters);
		await runtime.send({
			message: "A",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});
		const original = made.streamInvocations[0];
		if (live) original.callbacks.onNormalChatOutput?.(facts.live);
		beforeStop?.(runtime, original);
		expect(runtime.stop()).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		return { ...made, runtime, facts, original };
	}

	it("reconciles authoritative stopped activity after immediate composer release", async () => {
		const made = await stopped();
		expect(made.original.handle.stop).toHaveBeenCalledOnce();
		expect(made.runtime.snapshot()).toMatchObject({
			active: false,
			isSending: false,
			canStop: false,
		});
		expect(made.streamInvocations).toHaveLength(2);
		const observer = made.streamInvocations[1];
		expect(observer.options).toMatchObject({
			reconnectToStreamId: made.original.handle.streamId,
		});
		observer.callbacks.onEnd("", {
			observation: {
				version: 1,
				state: "terminal",
				streamId: made.original.handle.streamId ?? "missing",
				conversationId: "conv-1",
				assistantMessageId: "saved-stop",
				completion: made.facts.completion,
			},
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(
			normalChatOutputView(
				made.messages.at(-1) ?? {
					id: "missing",
					role: "assistant",
					content: "",
					timestamp: 0,
				},
			),
		).toMatchObject({
			answer: "",
			completion: { outcome: "stopped" },
			activity: [{ text: "Retained working activity" }],
		});
		expect(made.adapters.refreshMessageCost).toHaveBeenCalledWith("saved-stop");
		expect(observer.handle.stop).not.toHaveBeenCalled();
		expect(observer.handle.detach).toHaveBeenCalled();
	});
	function terminalObservation(made: Awaited<ReturnType<typeof stopped>>) {
		return {
			version: 1,
			state: "terminal",
			streamId: made.original.handle.streamId ?? "missing",
			conversationId: "conv-1",
			assistantMessageId: "saved-stop",
			completion: made.facts.completion,
		} as const;
	}
	function terminalReceipt(
		made: Awaited<ReturnType<typeof stopped>>,
		overrides: Partial<StreamMetadata> = {},
	) {
		return {
			observation: terminalObservation(made),
			...overrides,
		} satisfies StreamMetadata;
	}

	it.each([
		"retained replay",
		"replay-to-live",
	])("accepts explicit completion and exact receipt from %s without replaying effects", async () => {
		const made = await stopped();
		const observer = made.streamInvocations[1];
		const before = vi.mocked(made.adapters.applyMessageListEvent).mock.calls
			.length;
		observer.callbacks.onToken("Must not append");
		observer.callbacks.onThinking("Must not append");
		observer.callbacks.onToolCall?.("make_image", {}, "done");
		observer.callbacks.onNormalChatOutput?.(made.facts.terminal);
		expect(
			vi.mocked(made.adapters.applyMessageListEvent).mock.calls,
		).toHaveLength(before);
		observer.callbacks.onEnd("Must not append", {
			assistantMessageId: "saved-stop",
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(
			normalChatOutputView(
				made.messages.at(-1) ?? {
					id: "missing",
					role: "assistant",
					content: "",
					timestamp: 0,
				},
			)?.completion?.outcome,
		).toBe("stopped");
		expect(made.messages.at(-1)?.content).toBe("");
		expect(made.adapters.hydrateConversationDetail).not.toHaveBeenCalled();
		expect(made.streamInvocations).toHaveLength(2);
	});

	it("applies already answered truth without draining a queued message or completing twice", async () => {
		const answered = fixture("answered");
		const made = await stopped({
			readChatMessages: vi.fn(async () => [answered.saved]),
		});
		// A post-Stop queue is still owned by its caller, never this background read.
		made.runtime.queue({
			message: "queued",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});
		const state = made.runtime.snapshot();
		const observer = made.streamInvocations[1];
		observer.callbacks.onNormalChatOutput?.(answered.terminal);
		observer.callbacks.onEnd("", { assistantMessageId: "saved-stop" });
		await vi.advanceTimersByTimeAsync(0);
		expect(made.runtime.snapshot()).toEqual(state);
		expect(
			normalChatOutputView(
				made.messages.at(-1) ?? {
					id: "missing",
					role: "assistant",
					content: "",
					timestamp: 0,
				},
			)?.completion?.outcome,
		).toBe("answered");
		expect(made.streamInvocations).toHaveLength(2);
	});

	it.each([
		"send",
		"resume",
		"detach",
		"reset",
		"chat",
	])("drops late observer callbacks after %s", async (action) => {
		let chat = "conv-1";
		const made = await stopped({ getConversationId: () => chat });
		const observer = made.streamInvocations[1];
		if (action === "send")
			await made.runtime.send({
				message: "B",
				attachmentIds: [],
				attachments: [],
				pendingAttachments: [],
			});
		if (action === "resume")
			await made.runtime.answerQuestion({
				questionId: "new-question",
				answer: { kind: "left_to_alfy" },
				continuesMessageId: "asking",
				userMessage: "B",
			});
		if (action === "detach") made.runtime.detach();
		if (action === "reset") made.runtime.reset();
		if (action === "chat") chat = "conv-2";
		const state = made.runtime.snapshot();
		vi.mocked(made.adapters.applyMessageListEvent).mockClear();
		vi.mocked(made.adapters.setSendError).mockClear();
		observer.callbacks.onNormalChatOutput?.(made.facts.terminal);
		observer.callbacks.onEnd("", terminalReceipt(made));
		await vi.advanceTimersByTimeAsync(10_000);
		expect(made.adapters.applyMessageListEvent).not.toHaveBeenCalled();
		expect(made.adapters.setSendError).not.toHaveBeenCalled();
		expect(made.adapters.refreshMessageCost).not.toHaveBeenCalled();
		expect(made.runtime.snapshot()).toEqual(state);
		expect(observer.handle.detach).toHaveBeenCalled();
		expect(observer.handle.stop).not.toHaveBeenCalled();
	});

	it.each([
		"send",
		"detach",
		"chat",
	])("fences the saved-row read after %s", async (action) => {
		let resolve: (rows: ChatMessage[]) => void = () => {
			throw new Error("read not started");
		};
		let chat = "conv-1";
		const made = await stopped({
			getConversationId: () => chat,
			readChatMessages: () =>
				new Promise((done) => {
					resolve = done;
				}),
		});
		made.streamInvocations[1].callbacks.onEnd("", terminalReceipt(made));
		await Promise.resolve();
		if (action === "send")
			await made.runtime.send({
				message: "B",
				attachmentIds: [],
				attachments: [],
				pendingAttachments: [],
			});
		if (action === "detach") made.runtime.detach();
		if (action === "chat") chat = "conv-2";
		const state = made.runtime.snapshot();
		vi.mocked(made.adapters.applyMessageListEvent).mockClear();
		vi.mocked(made.adapters.setSendError).mockClear();
		resolve([made.facts.saved]);
		await vi.advanceTimersByTimeAsync(0);
		expect(made.adapters.applyMessageListEvent).not.toHaveBeenCalled();
		expect(made.adapters.setSendError).not.toHaveBeenCalled();
		expect(made.adapters.refreshMessageCost).not.toHaveBeenCalled();
		expect(made.runtime.snapshot()).toEqual(state);
	});

	it.each([
		"hung",
		"unavailable",
		"missing receipt",
		"missing completion",
		"wrong stream",
		"wrong segment",
		"missing row",
		"wrong saved identity",
	])("keeps %s explicitly unavailable without inventing completion", async (mode) => {
		const made = await stopped(
			mode === "missing row"
				? { readChatMessages: async () => [] }
				: mode === "wrong saved identity"
					? {
							readChatMessages: async () =>
								applyNormalChatOutputView([fixture().saved], "saved-stop", {
									...fixture().terminal,
									completion: { ...fixture().completion, segmentId: "other" },
								}),
						}
					: {},
		);
		const observer = made.streamInvocations[1];
		if (mode === "unavailable")
			observer.callbacks.onEnd("", {
				observation: {
					version: 1,
					state: "unavailable",
					streamId: "stop-stream",
					conversationId: "conv-1",
				},
			});
		else if (mode === "missing receipt") {
			observer.callbacks.onNormalChatOutput?.(made.facts.terminal);
			observer.callbacks.onEnd("");
		} else if (mode === "missing completion")
			observer.callbacks.onEnd("", {
				assistantMessageId: "saved-stop",
				wasStopped: true,
			});
		else if (mode === "wrong stream")
			observer.callbacks.onEnd(
				"",
				terminalReceipt(made, {
					observation: {
						...terminalObservation(made),
						streamId: "other",
					},
				}),
			);
		else if (mode === "wrong segment")
			observer.callbacks.onEnd(
				"",
				terminalReceipt(made, {
					observation: {
						...terminalObservation(made),
						completion: { ...made.facts.completion, segmentId: "other" },
					},
				}),
			);
		else if (mode !== "hung")
			observer.callbacks.onEnd("", terminalReceipt(made));
		await vi.advanceTimersByTimeAsync(10_000);
		expect(
			normalChatOutputView(
				made.messages.at(-1) ?? {
					id: "missing",
					role: "assistant",
					content: "",
					timestamp: 0,
				},
			)?.completion,
		).toBeUndefined();
		expect(
			normalChatOutputView(
				made.messages.at(-1) ?? {
					id: "missing",
					role: "assistant",
					content: "",
					timestamp: 0,
				},
			)?.activity[0].text,
		).toBe("Retained working activity");
		expect(made.adapters.setSendError).toHaveBeenCalledWith(
			"chat.observationUnavailable",
		);
		expect(made.runtime.snapshot().isSending).toBe(false);
		expect(observer.handle.detach).toHaveBeenCalled();
	});

	it("bounds pending reads and includes hung detail in the total deadline", async () => {
		const made = await stopped({
			readChatMessages: () => new Promise(() => {}),
		});
		for (let i = 1; i < 5; i++) {
			made.streamInvocations[i].callbacks.onWaiting?.({
				version: 1,
				state: "pending",
				streamId: "stop-stream",
				conversationId: "conv-1",
				turnId: "stop-turn",
				segmentId: "stop-segment",
			});
			await vi.advanceTimersByTimeAsync(250);
		}
		made.streamInvocations[5].callbacks.onEnd("", terminalReceipt(made));
		await vi.advanceTimersByTimeAsync(9000);
		expect(made.streamInvocations).toHaveLength(6);
		expect(made.adapters.setSendError).toHaveBeenCalledWith(
			"chat.observationUnavailable",
		);
		expect(
			normalChatOutputView(
				made.messages.at(-1) ?? {
					id: "missing",
					role: "assistant",
					content: "",
					timestamp: 0,
				},
			)?.completion,
		).toBeUndefined();
	});

	it("does not invalidate settlement on repeated Stop", async () => {
		const made = await stopped();
		expect(made.runtime.stop()).toBe(false);
		const observer = made.streamInvocations[1];
		observer.callbacks.onEnd("", terminalReceipt(made));
		observer.callbacks.onEnd("", terminalReceipt(made));
		await vi.advanceTimersByTimeAsync(0);
		expect(made.original.handle.stop).toHaveBeenCalledOnce();
		expect(made.adapters.refreshMessageCost).toHaveBeenCalledOnce();
	});
	it("restores the pre-Stop queue immediately and never drains it on late success", async () => {
		const made = await stopped({}, (runtime) =>
			runtime.queue({
				message: "queued-before-Stop",
				attachmentIds: [],
				attachments: [],
				pendingAttachments: [],
			}),
		);
		expect(made.adapters.restorePayloadToDraft).toHaveBeenCalledWith(
			expect.objectContaining({ message: "queued-before-Stop" }),
		);
		expect(made.runtime.snapshot().queuedTurn).toBeNull();
		made.streamInvocations[1].callbacks.onEnd("", terminalReceipt(made));
		await vi.advanceTimersByTimeAsync(0);
		expect(made.adapters.restorePayloadToDraft).toHaveBeenCalledOnce();
		expect(made.streamInvocations).toHaveLength(2);
	});

	it("uses the handle identity when Stop precedes all output and metadata", async () => {
		const made = await stopped({}, undefined, false);
		made.streamInvocations[1].callbacks.onEnd("", terminalReceipt(made));
		await vi.advanceTimersByTimeAsync(0);
		expect(
			normalChatOutputView(made.messages.at(-1) ?? made.facts.saved)?.completion
				?.outcome,
		).toBe("stopped");
		expect(made.adapters.readChatMessages).toHaveBeenCalledOnce();
	});

	it.each([
		"pending",
		"cut",
	])("hands %s Stop to the same private terminal application seam", async (mode) => {
		const made = await stopped(
			{ askServerUpdate: () => new Promise(() => {}) },
			(_runtime, original) => {
				if (mode === "pending")
					original.callbacks.onWaiting?.({
						version: 1,
						state: "pending",
						streamId: "stop-stream",
						conversationId: "conv-1",
						turnId: "stop-turn",
						segmentId: "stop-segment",
					});
				else original.callbacks.onError(new TypeError("Failed to fetch"));
			},
			false,
		);
		made.streamInvocations[1].callbacks.onEnd("", terminalReceipt(made));
		await vi.advanceTimersByTimeAsync(10_000);
		expect(made.streamInvocations).toHaveLength(2);
		expect(made.original.handle.stop).toHaveBeenCalledOnce();
		expect(made.adapters.checkForOrphanedStream).not.toHaveBeenCalled();
		expect(
			normalChatOutputView(made.messages.at(-1) ?? made.facts.saved)?.completion
				?.outcome,
		).toBe("stopped");
	});

	it("ends perpetual pending after five reads without a completion fact", async () => {
		const made = await stopped();
		for (let i = 1; i <= 5; i++) {
			made.streamInvocations[i].callbacks.onWaiting?.({
				version: 1,
				state: "pending",
				streamId: "stop-stream",
				conversationId: "conv-1",
				turnId: "stop-turn",
				segmentId: "stop-segment",
			});
			await vi.advanceTimersByTimeAsync(250);
		}
		await vi.advanceTimersByTimeAsync(10_000);
		expect(made.streamInvocations).toHaveLength(6);
		expect(made.adapters.setSendError).toHaveBeenCalledWith(
			"chat.observationUnavailable",
		);
		expect(
			normalChatOutputView(made.messages.at(-1) ?? made.facts.saved)
				?.completion,
		).toBeUndefined();
	});

	it("retains partial answer and authoritative unsaved terminal without claiming a durable row", async () => {
		const made = await stopped({}, (_runtime, original) =>
			original.callbacks.onToken("Partial answer"),
		);
		made.streamInvocations[1].callbacks.onEnd(
			"",
			terminalReceipt(made, {
				observation: {
					...terminalObservation(made),
					assistantMessageId: null,
				},
			}),
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(
			normalChatOutputView(made.messages.at(-1) ?? made.facts.saved),
		).toMatchObject({
			answer: "Partial answer",
			completion: { outcome: "stopped" },
		});
		expect(made.messages.at(-1)?.id).toBe("id-2");
		expect(made.adapters.readChatMessages).not.toHaveBeenCalled();
		expect(made.adapters.refreshMessageCost).not.toHaveBeenCalled();
	});

	it("preserves finalization failure and the underlying model outcome when the row cannot be saved", async () => {
		const { projectNormalChatFinalization } = await import(
			"$lib/shared/normal-chat-completion"
		);
		const made = await stopped({ readChatMessages: async () => [] });
		const marker = {
			version: 1,
			status: "failed",
			cause: "file_association_failed",
			wasStopped: true,
		} as const;
		const completion = projectNormalChatFinalization(
			made.facts.completion,
			marker,
		);
		expect(completion).toBeDefined();
		if (!completion) throw new Error("missing projected failure");
		made.streamInvocations[1].callbacks.onEnd("", {
			observation: {
				...terminalObservation(made),
				completion,
				modelCompletion: made.facts.completion,
				normalChatFinalization: marker,
			},
			finalContent: "Partial unsaved answer",
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(
			normalChatOutputView(made.messages.at(-1) ?? made.facts.saved),
		).toMatchObject({
			answer: "Partial unsaved answer",
			normalChatFinalization: marker,
			modelCompletion: made.facts.completion,
		});
		expect(made.runtime.snapshot().canRetry).toBe(false);
		expect(made.adapters.refreshMessageCost).not.toHaveBeenCalled();
	});

	it("observes a real transport after abort without dispatching a second generation", async () => {
		const { streamChat } = await import("$lib/services/streaming");
		const { uiFrame } = await import("$lib/services/streaming.test-helpers");
		const facts = fixture();
		const scope = {
			version: 1,
			turnId: "stop-turn",
			segmentId: "stop-segment",
			attemptId: "attempt",
			stepId: "working",
			phase: "working",
		} as const;
		const working = [
			{
				...scope,
				sequence: 1,
				type: "block_start",
				blockId: "work",
				nativeId: "work",
				kind: "text",
				role: "activity",
			},
			{
				...scope,
				sequence: 2,
				type: "block_delta",
				blockId: "work",
				text: "Retained working activity",
			},
		];
		const frames = (events: unknown[]) =>
			events
				.map((event) =>
					uiFrame({ type: "data-normal-chat-output", data: event }),
				)
				.join("");
		const bodies: Record<string, unknown>[] = [];
		const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			if (url === "/api/chat/stream/stop") return new Response("{}");
			const body = JSON.parse(String(init?.body));
			bodies.push(body);
			if (!body.reconnectToStreamId)
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode(frames(working)));
							init?.signal?.addEventListener(
								"abort",
								() =>
									controller.error(new DOMException("Aborted", "AbortError")),
								{ once: true },
							);
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			return new Response(
				frames([
					...working,
					{
						...scope,
						sequence: 3,
						type: "completion",
						completion: facts.completion,
					},
				]) +
					uiFrame({
						type: "data-stream-metadata",
						data: { assistantMessageId: "saved-stop" },
					}) +
					uiFrame({ type: "finish", finishReason: "stop" }) +
					uiFrame("[DONE]"),
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		});
		vi.stubGlobal("fetch", fetch);
		const made = makeAdapters({
			streamChat,
			schedule: (cb, ms) => setTimeout(cb, ms),
			readChatMessages: async () => [facts.saved],
		});
		const runtime = createNormalChatClientTurnRuntime(made.adapters);
		try {
			await runtime.send({
				message: "A",
				attachmentIds: [],
				attachments: [],
				pendingAttachments: [],
			});
			await vi.waitFor(() =>
				expect(
					normalChatOutputView(made.messages.at(-1) ?? facts.saved)?.activity[0]
						?.text,
				).toBe("Retained working activity"),
			);
			runtime.queue({
				message: "B",
				attachmentIds: [],
				attachments: [],
				pendingAttachments: [],
			});
			expect(runtime.stop()).toBe(true);
			expect(runtime.snapshot()).toMatchObject({
				active: false,
				isSending: false,
			});
			await vi.waitFor(() =>
				expect(
					normalChatOutputView(made.messages.at(-1) ?? facts.saved)?.completion
						?.outcome,
				).toBe("stopped"),
			);
			expect(bodies).toHaveLength(2);
			expect(bodies[1]).toMatchObject({
				reconnectToStreamId: bodies[0].streamId,
				conversationId: "conv-1",
				message: "",
			});
			expect(
				fetch.mock.calls.filter(([url]) => url === "/api/chat/stream/stop"),
			).toHaveLength(1);
			expect(made.adapters.restorePayloadToDraft).toHaveBeenCalledOnce();
			expect(made.adapters.refreshMessageCost).toHaveBeenCalledWith(
				"saved-stop",
			);
		} finally {
			runtime.detach();
			vi.unstubAllGlobals();
		}
	});
	it("resolves a renamed row through its retained renderKey before applying terminal output", async () => {
		const made = await stopped();
		const held = made.messages.at(-1);
		if (!held) throw new Error("missing placeholder");
		held.id = "saved-stop";
		expect(held.renderKey).toBe("id-2");
		made.streamInvocations[1].callbacks.onEnd("", terminalReceipt(made));
		await vi.advanceTimersByTimeAsync(0);
		expect(
			normalChatOutputView(made.messages.at(-1) ?? made.facts.saved)?.completion
				?.outcome,
		).toBe("stopped");
		expect(made.adapters.applyMessageListEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "finalize",
				canonicalMessage: made.facts.saved,
				placeholderId: "saved-stop",
			}),
		);
		expect(made.adapters.refreshMessageCost).toHaveBeenCalledWith("saved-stop");
	});
	it("rejects contradictory normal replay receipt evidence", async () => {
		const made = await stopped();
		const observer = made.streamInvocations[1];
		observer.callbacks.onNormalChatOutput?.(made.facts.terminal);
		observer.callbacks.onEnd("", {
			assistantMessageId: "saved-stop",
			wasStopped: false,
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(
			normalChatOutputView(made.messages.at(-1) ?? made.facts.saved)
				?.completion,
		).toBeUndefined();
		expect(made.adapters.setSendError).toHaveBeenCalledWith(
			"chat.observationUnavailable",
		);
	});
	it("settles late original identity without granting structural completion", async () => {
		const made = await stopped();
		const pending = made.runtime.settleStoppedAction({
			purpose: "regenerate",
			messageId: "id-2",
		});
		let ready = false;
		void pending.then(() => {
			ready = true;
		});
		await Promise.resolve();
		expect(ready).toBe(false);
		made.original.callbacks.onEnd("Untrusted receipt prose", {
			wasStopped: true,
			assistantMessageId: "server-a",
			userMessageId: "server-u",
		});
		const permit = await pending;
		expect(permit).toMatchObject({
			status: "ready",
			assistantMessageId: "server-a",
			userMessageId: "server-u",
		});
		expect(made.messages.at(-1)?.id).toBe("server-a");
		expect(
			normalChatOutputView(made.messages.at(-1) ?? made.facts.saved)
				?.completion,
		).toBeUndefined();
		expect(made.messages.at(-1)?.content).not.toBe("Untrusted receipt prose");
		expect(made.original.handle.stop).toHaveBeenCalledOnce();
	});

	it("uses canonical identity when the original abort receipt contains no IDs", async () => {
		const made = await stopped();
		const pending = made.runtime.settleStoppedAction({
			purpose: "regenerate",
			messageId: "id-2",
		});
		made.original.callbacks.onEnd("", { wasStopped: true });
		let ready = false;
		void pending.then(() => {
			ready = true;
		});
		await Promise.resolve();
		expect(ready).toBe(false);
		made.streamInvocations[1].callbacks.onEnd("", terminalReceipt(made));
		await vi.advanceTimersByTimeAsync(0);
		expect(await pending).toMatchObject({
			status: "ready",
			assistantMessageId: "saved-stop",
		});
	});

	it("permits navigation but retains unavailable facts for the stopped reply", async () => {
		const made = await stopped();
		const pending = made.runtime.settleStoppedAction({ purpose: "navigate" });
		made.streamInvocations[1].callbacks.onError(new Error("unavailable"));
		await vi.advanceTimersByTimeAsync(0);
		const navigation = await pending;
		expect(navigation).toMatchObject({ status: "ready", purpose: "navigate" });
		if (navigation.status === "ready") navigation.release();
		expect(made.runtime.stop()).toBe(false);
		const laterNavigation = await made.runtime.settleStoppedAction({
			purpose: "navigate",
		});
		expect(laterNavigation).toMatchObject({
			status: "ready",
			purpose: "navigate",
		});
		if (laterNavigation.status === "ready") laterNavigation.release();
		expect(
			await made.runtime.settleStoppedAction({
				purpose: "regenerate",
				messageId: "id-2",
			}),
		).toEqual({ status: "unavailable" });
		expect(made.streamInvocations).toHaveLength(2);
		made.original.callbacks.onEnd("", {
			wasStopped: true,
			assistantMessageId: "late-a",
		});
		const permit = await made.runtime.settleStoppedAction({
			purpose: "regenerate",
			messageId: "id-2",
		});
		expect(permit).toMatchObject({
			status: "ready",
			assistantMessageId: "late-a",
		});
	});

	it("invalidates a ready permit when a same-chat newer turn begins and ends", async () => {
		const made = await stopped();
		made.original.callbacks.onEnd("", {
			wasStopped: true,
			assistantMessageId: "old-a",
		});
		const permit = await made.runtime.settleStoppedAction({
			purpose: "regenerate",
			messageId: "id-2",
		});
		if (permit.status !== "ready") throw new Error("expected permit");
		expect(permit.isCurrent()).toBe(true);
		await made.runtime.send({
			message: "New turn",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});
		made.streamInvocations
			.at(-1)
			?.callbacks.onEnd("New answer", { assistantMessageId: "new-a" });
		expect(made.runtime.snapshot().isSending).toBe(false);
		expect(permit.isCurrent()).toBe(false);
		const before = structuredClone(made.messages);
		made.original.callbacks.onEnd("Late prose", {
			assistantMessageId: "wrong-late-a",
		});
		expect(made.messages).toEqual(before);
		permit.release();
	});

	it("reserves command priority only for actual navigation and rejects duplicate regeneration", async () => {
		const made = await stopped();
		const regen = made.runtime.settleStoppedAction({
			purpose: "regenerate",
			messageId: "id-2",
		});
		expect(
			await made.runtime.settleStoppedAction({
				purpose: "regenerate",
				messageId: "id-2",
			}),
		).toEqual({ status: "superseded" });
		const navigation = made.runtime.settleStoppedAction({
			purpose: "navigate",
		});
		expect(await regen).toEqual({ status: "superseded" });
		made.original.callbacks.onEnd("", { wasStopped: true });
		const permit = await navigation;
		expect(permit.status).toBe("ready");
		if (permit.status === "ready") permit.release();
		expect(made.original.handle.stop).toHaveBeenCalledOnce();
	});

	it("captures synchronous original abort receipt before releasing stream ownership", async () => {
		const made = await stopped({}, (_runtime, original) => {
			vi.mocked(original.handle.stop).mockImplementation(() =>
				original.callbacks.onEnd("", {
					wasStopped: true,
					assistantMessageId: "sync-a",
				}),
			);
		});
		expect(
			await made.runtime.settleStoppedAction({
				purpose: "regenerate",
				messageId: "id-2",
			}),
		).toMatchObject({ status: "ready", assistantMessageId: "sync-a" });
	});

	it("ignores duplicate original receipts after accepting identity", async () => {
		const made = await stopped();
		made.original.callbacks.onEnd("", {
			assistantMessageId: "original-a",
			wasStopped: true,
		});
		vi.mocked(made.adapters.applyMessageListEvent).mockClear();
		made.original.callbacks.onEnd("wrong prose", {
			assistantMessageId: "original-a",
			wasStopped: true,
		});
		expect(made.adapters.applyMessageListEvent).not.toHaveBeenCalled();
	});

	it("does not replace original authoritative identity with contradictory canonical identity", async () => {
		const made = await stopped();
		made.original.callbacks.onEnd("", {
			assistantMessageId: "original-a",
			wasStopped: true,
		});
		made.streamInvocations[1].callbacks.onEnd("", terminalReceipt(made));
		await vi.advanceTimersByTimeAsync(0);
		expect(made.messages.at(-1)?.id).toBe("original-a");
		expect(
			normalChatOutputView(made.messages.at(-1) ?? made.facts.saved)
				?.completion,
		).toBeUndefined();
	});

	it.each([
		"detach",
		"reset",
		"conversation",
	] as const)("supersedes a pending command on %s", async (action) => {
		const made = await stopped();
		const pending = made.runtime.settleStoppedAction({ purpose: "navigate" });
		if (action === "conversation")
			vi.mocked(made.adapters.getConversationId).mockReturnValue("other");
		else made.runtime[action]();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await pending).toEqual({ status: "superseded" });
		const before = structuredClone(made.messages);
		made.original.callbacks.onEnd("late", { assistantMessageId: "late-a" });
		expect(made.messages).toEqual(before);
	});

	it("permits an independent saved historical target despite unresolved Stop", async () => {
		const made = await stopped();
		made.messages.unshift(
			{ id: "old-user", role: "user", content: "Earlier", timestamp: 0 },
			{
				id: "old-assistant",
				role: "assistant",
				content: "Earlier answer",
				timestamp: 0,
			},
		);
		const pending = made.runtime.settleStoppedAction({
			purpose: "regenerate",
			messageId: "old-assistant",
		});
		let ready = false;
		void pending.then(() => {
			ready = true;
		});
		await Promise.resolve();
		expect(ready).toBe(true);
		made.streamInvocations[1].callbacks.onError(new Error("Unavailable"));
		await vi.advanceTimersByTimeAsync(0);
		const permit = await pending;
		expect(permit).toMatchObject({
			status: "ready",
			assistantMessageId: "old-assistant",
		});
		if (permit.status === "ready") {
			expect(permit.isCurrent()).toBe(true);
			permit.release();
		}
	});
	it("never promotes an unresolved old placeholder to retry identity after a newer turn", async () => {
		const made = await stopped();
		made.streamInvocations[1].callbacks.onError(new Error("Unavailable"));
		await vi.advanceTimersByTimeAsync(0);
		await made.runtime.send({
			message: "New turn",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});
		made.streamInvocations
			.at(-1)
			?.callbacks.onEnd("New answer", { assistantMessageId: "new-a" });
		expect(
			await made.runtime.settleStoppedAction({
				purpose: "regenerate",
				messageId: "id-2",
			}),
		).toEqual({ status: "unavailable" });
	});
	it.each([
		"removed",
		"conflicting canonical ID",
	] as const)("invalidates a ready permit when its target is %s without notifying the runtime", async (change) => {
		const made = await stopped();
		made.original.callbacks.onEnd("", {
			assistantMessageId: "ready-a",
			userMessageId: "ready-u",
			wasStopped: true,
		});
		const permit = await made.runtime.settleStoppedAction({
			purpose: "regenerate",
			messageId: "id-2",
		});
		if (permit.status !== "ready") throw new Error("expected ready permit");
		expect(permit.isCurrent()).toBe(true);
		const targetIndex = made.messages.findIndex((row) => row.id === "ready-a");
		if (change === "removed") made.messages.splice(targetIndex, 1);
		else
			made.messages[targetIndex] = {
				...made.messages[targetIndex],
				id: "different-canonical-a",
			};
		vi.mocked(made.adapters.applyMessageListEvent).mockClear();
		const before = structuredClone(made.messages);
		expect(permit.isCurrent()).toBe(false);
		expect(made.messages).toEqual(before);
		expect(made.adapters.applyMessageListEvent).not.toHaveBeenCalled();
		permit.release();
	});

	it("keeps a ready permit valid when the exact authoritative row is reloaded without its render key", async () => {
		const made = await stopped();
		made.original.callbacks.onEnd("", {
			assistantMessageId: "ready-a",
			wasStopped: true,
		});
		const permit = await made.runtime.settleStoppedAction({
			purpose: "regenerate",
			messageId: "id-2",
		});
		if (permit.status !== "ready") throw new Error("expected ready permit");
		const targetIndex = made.messages.findIndex((row) => row.id === "ready-a");
		made.messages[targetIndex] = {
			...made.messages[targetIndex],
			renderKey: undefined,
		};
		expect(permit.isCurrent()).toBe(true);
		permit.release();
	});
});

describe("canonical observation through the real message-list finalizer", () => {
	afterEach(() => vi.useRealTimers());
	function required<T>(value: T | null | undefined): T {
		if (value == null) throw new Error("Missing canonical test fixture");
		return value;
	}
	function savedReply(): ChatMessage {
		const scope = {
			version: 1,
			turnId: "canonical-turn",
			segmentId: "canonical-segment",
			attemptId: "a",
			stepId: "s",
			phase: "working",
		} as const;
		const completion = {
			version: 1,
			turnId: scope.turnId,
			segmentId: scope.segmentId,
			phase: "working",
			outcome: "stopped",
			stopCause: "user_stop",
			workingStopCause: "user_stop",
			closingAttempted: false,
		} as const;
		return {
			id: "canonical-assistant",
			role: "assistant",
			timestamp: 2,
			content: "Saved partial answer",
			thinking: "Canonical native reasoning.",
			thoughtSteps: [
				{
					id: "anchored",
					source: "deterministic",
					activityClass: "understanding-request",
					impliesExternalAction: false,
					anchor: { start: 0, end: 9 },
				},
			],
			thinkingSegments: [
				{ type: "text", content: "Canonical native reasoning." },
			],
			railSummary: "Canonical summary",
			projectFilesRead: 3,
			normalChatOutput: {
				version: 1,
				events: [{ ...scope, sequence: 1, type: "completion", completion }],
			},
		};
	}
	async function observing(mode: "stop" | "normal", saved = savedReply()) {
		vi.useFakeTimers();
		const made = makeAdapters({
			schedule: vi.fn((cb, ms) => setTimeout(cb, ms)),
			readChatMessages: vi.fn(async () => [saved]),
		});
		made.messageListEvents.finalizeStreamingMessage.mockImplementation(
			(params) => {
				made.messages.splice(
					0,
					made.messages.length,
					...finalizeStreamingMessageList(made.messages, params),
				);
			},
		);
		const stream = made.adapters.streamChat;
		made.adapters.streamChat = vi.fn((...args: Parameters<typeof stream>) =>
			Object.assign(stream(...args), {
				streamId: args[3]?.reconnectToStreamId ?? "canonical-stream",
			}),
		);
		const runtime = createNormalChatClientTurnRuntime(made.adapters);
		if (mode === "normal")
			await runtime.reconnectToOrphanedStream("canonical-stream", "A");
		else
			await runtime.send({
				message: "A",
				attachmentIds: [],
				attachments: [],
				pendingAttachments: [],
			});
		const held = required(made.messages.at(-1));
		held.thinking = "Stale streamed trace";
		held.followUps = ["Stale follow-up"];
		held.costUsd = 99;
		const key = held.renderKey ?? held.id;
		if (mode === "stop") {
			runtime.stop();
			await vi.advanceTimersByTimeAsync(0);
		}
		const observer = required(made.streamInvocations.at(-1));
		const completion = required(normalChatOutputView(savedReply())?.completion);
		const receipt = {
			observation: {
				version: 1,
				state: "terminal",
				streamId: "canonical-stream",
				conversationId: "conv-1",
				assistantMessageId: "canonical-assistant",
				completion,
			},
		} as const;
		return { ...made, runtime, observer, saved, key, receipt };
	}
	it.each([
		"stop",
		"normal",
	] as const)("adopts the complete saved row atomically with durable anchors through %s", async (mode) => {
		const made = await observing(mode);
		const before = made.messages.slice(0, -1);
		const eventStart = vi.mocked(made.adapters.applyMessageListEvent).mock.calls
			.length;
		made.observer.callbacks.onEnd("", made.receipt);
		await vi.advanceTimersByTimeAsync(0);
		expect(made.messages.at(-1)?.thoughtSteps).toEqual(made.saved.thoughtSteps);
		expect(made.messages.at(-1)).toEqual({
			...made.saved,
			renderKey: made.key,
			isStreaming: false,
			isThinkingStreaming: false,
			runtimePhase: undefined,
			responseActivity: undefined,
			evidencePending: true,
		});
		expect(made.messages.slice(0, -1)).toEqual(before);
		expect(
			vi
				.mocked(made.adapters.applyMessageListEvent)
				.mock.calls.slice(eventStart)
				.map(([e]) => e.type),
		).toEqual(["finalize"]);
		expect(made.adapters.refreshMessageCost).toHaveBeenCalledWith(
			made.saved.id,
		);
		expect(made.adapters.pollMessageEvidence).toHaveBeenCalledWith(
			made.saved.id,
		);
		if (mode === "stop") {
			const permit = await made.runtime.settleStoppedAction({
				purpose: "regenerate",
				messageId: made.saved.id,
			});
			expect(permit.status).toBe("ready");
			if (permit.status === "ready") {
				expect(permit.isCurrent()).toBe(true);
				permit.release();
			}
		}
		made.runtime.detach();
	});
	it.each([
		"stop",
		"normal",
	] as const)("rejects a same-ID saved row from another segment through %s", async (mode) => {
		const saved = savedReply();
		const event = required(saved.normalChatOutput).events[0];
		if (event.type === "completion")
			event.completion = {
				...event.completion,
				segmentId: "different-segment",
			};
		const made = await observing(mode, saved);
		made.observer.callbacks.onEnd("", made.receipt);
		await vi.advanceTimersByTimeAsync(0);
		expect(made.messages.at(-1)?.id).not.toBe(saved.id);
		expect(made.adapters.setSendError).toHaveBeenCalledWith(
			"chat.observationUnavailable",
		);
		expect(made.adapters.refreshMessageCost).not.toHaveBeenCalled();
		made.runtime.detach();
	});
	it.each([
		"stop",
		"normal",
	] as const)("keeps a newer finalization failure honest through %s", async (mode) => {
		const saved = savedReply();
		const event = required(saved.normalChatOutput).events[0];
		if (event.type !== "completion")
			throw new Error("Fixture lacks completion");
		event.completion = {
			...event.completion,
			outcome: "answered",
			stopCause: "natural_stop",
			workingStopCause: "natural_stop",
		};
		const made = await observing(mode, saved);
		const marker = {
			version: 1,
			status: "failed",
			cause: "file_association_failed",
			wasStopped: true,
		} as const;
		const modelCompletion = required(normalChatOutputView(saved)?.completion);
		made.observer.callbacks.onEnd("", {
			observation: {
				...made.receipt.observation,
				modelCompletion,
				normalChatFinalization: marker,
				completion: required(
					projectNormalChatFinalization(modelCompletion, marker),
				),
			},
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(made.messages.at(-1)?.normalChatFinalization).toEqual(marker);
		expect(
			normalChatOutputView(required(made.messages.at(-1)))?.completion?.outcome,
		).toBe("stopped");
		expect(saved.normalChatFinalization).toBeUndefined();
		made.runtime.detach();
	});
	it.each([
		"stop",
		"normal",
	] as const)("ignores a detail read superseded by a new turn through %s", async (mode) => {
		const made = await observing(mode);
		let resolve!: (rows: ChatMessage[]) => void;
		vi.mocked(required(made.adapters.readChatMessages)).mockReturnValueOnce(
			new Promise((r) => {
				resolve = r;
			}),
		);
		made.observer.callbacks.onEnd("", made.receipt);
		await vi.advanceTimersByTimeAsync(0);
		made.runtime.reset();
		await made.runtime.send({
			message: "New turn",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		});
		const rows = structuredClone(made.messages);
		vi.mocked(made.adapters.applyMessageListEvent).mockClear();
		resolve([made.saved]);
		await vi.advanceTimersByTimeAsync(0);
		expect(made.messages).toEqual(rows);
		expect(made.adapters.applyMessageListEvent).not.toHaveBeenCalled();
		expect(made.adapters.refreshMessageCost).not.toHaveBeenCalled();
		expect(made.runtime.snapshot().isSending).toBe(true);
		made.runtime.detach();
	});

	it.each([
		"stop",
		"normal",
	] as const)("rejects missing structure and wrong durable identity through %s", async (mode) => {
		for (const defect of [
			"structure",
			"role",
			"id",
			"outcome",
			"finalization",
		] as const) {
			const saved = savedReply();
			if (defect === "structure") saved.normalChatOutput = undefined;
			if (defect === "role") saved.role = "user";
			if (defect === "id") saved.id = "another-assistant";
			if (defect === "outcome") {
				const event = required(saved.normalChatOutput).events[0];
				if (event.type === "completion")
					event.completion = { ...event.completion, outcome: "answered" };
			}
			if (defect === "finalization")
				saved.normalChatFinalization = {
					version: 1,
					status: "failed",
					cause: "file_association_failed",
					wasStopped: false,
				};
			const made = await observing(mode, saved);
			if (defect === "structure") {
				const held = required(made.messages.at(-1));
				Object.assign(
					held,
					applyNormalChatOutputView([held], held.id, {
						answer: "",
						activity: [],
						blocks: [],
						completion: made.receipt.observation.completion,
					})[0],
				);
			}
			const receipt: StreamMetadata =
				defect === "finalization"
					? {
							observation: {
								...made.receipt.observation,
								normalChatFinalization: {
									version: 1,
									status: "failed",
									cause: "file_association_failed",
									wasStopped: true,
								},
							},
						}
					: made.receipt;
			made.observer.callbacks.onEnd("", receipt);
			await vi.advanceTimersByTimeAsync(0);
			expect(made.messages.at(-1)?.id, defect).not.toBe("canonical-assistant");
			expect(made.adapters.setSendError, defect).toHaveBeenCalledWith(
				"chat.observationUnavailable",
			);
			made.runtime.detach();
		}
	});

	it.each([
		"none",
		"live",
		"model",
	] as const)("adopts a legacy normal receipt only without structural evidence: %s", async (evidence) => {
		const saved = savedReply();
		saved.normalChatOutput = undefined;
		const made = await observing("normal", saved);
		if (evidence === "live")
			made.observer.callbacks.onNormalChatOutput?.({
				answer: "",
				activity: [],
				blocks: [],
				completion: made.receipt.observation.completion,
			});
		const receipt: StreamMetadata =
			evidence === "model"
				? {
						observation: {
							...made.receipt.observation,
							modelCompletion: made.receipt.observation.completion,
						},
					}
				: made.receipt;
		made.observer.callbacks.onEnd("", receipt);
		await vi.advanceTimersByTimeAsync(0);
		if (evidence === "none") {
			expect(made.messages.at(-1)).toEqual({
				...saved,
				renderKey: made.key,
				isStreaming: false,
				isThinkingStreaming: false,
				runtimePhase: undefined,
				responseActivity: undefined,
				evidencePending: true,
			});
			expect(
				normalChatOutputView(required(made.messages.at(-1))),
			).toBeUndefined();
			expect(made.adapters.refreshMessageCost).toHaveBeenCalledWith(saved.id);
		} else {
			expect(made.messages.at(-1)?.id).not.toBe(saved.id);
			expect(made.adapters.setSendError).toHaveBeenCalledWith(
				"chat.observationUnavailable",
			);
		}
		made.runtime.detach();
	});
	it.each([
		false,
		true,
	])("observes a pending turn beyond 120 seconds until its saved answer arrives (server budget=%s)", async (serverBudget) => {
		const saved = savedReply();
		const made = await observing("normal", saved);
		const deadlineAt = Date.now() + 500_000;
		for (let count = 0; count < (serverBudget ? 200 : 70); count++) {
			required(made.streamInvocations.at(-1)).callbacks.onWaiting?.({
				version: 1,
				state: "pending",
				streamId: "canonical-stream",
				conversationId: "conv-1",
				turnId: "canonical-turn",
				segmentId: "canonical-segment",
				...(serverBudget ? { deadlineAt } : {}),
			});
			await vi.advanceTimersByTimeAsync(2000);
			expect(made.runtime.snapshot().isSending).toBe(true);
			expect(made.streamInvocations).toHaveLength(count + 2);
		}
		expect(
			made.streamInvocations.every(
				(entry) => entry.options?.reconnectToStreamId === "canonical-stream",
			),
		).toBe(true);
		required(made.streamInvocations.at(-1)).callbacks.onEnd("", made.receipt);
		await vi.advanceTimersByTimeAsync(0);
		expect(made.messages.at(-1)?.id).toBe(saved.id);
		expect(made.runtime.snapshot().isSending).toBe(false);
		made.runtime.detach();
	});
	it("keeps observing a pending turn through the server's finalization window after the deadline it published", async () => {
		const saved = savedReply();
		const made = await observing("normal", saved);
		// The model deadline passes after 4 s. The server then still has its
		// finalization window to save the reply (or to fail explicitly), so the
		// browser must not give up before the window has passed.
		const deadlineAt = Date.now() + 4_000;
		for (
			let time = 0;
			time < 4_000 + TURN_FINALIZATION_WINDOW_MS + 2_000;
			time += 2000
		) {
			required(made.streamInvocations.at(-1)).callbacks.onWaiting?.({
				version: 1,
				state: "pending",
				streamId: "canonical-stream",
				conversationId: "conv-1",
				turnId: "canonical-turn",
				segmentId: "canonical-segment",
				deadlineAt,
			});
			await vi.advanceTimersByTimeAsync(2000);
			expect(made.runtime.snapshot().isSending).toBe(true);
		}
		expect(made.adapters.setSendError).not.toHaveBeenCalledWith(
			"chat.observationUnavailable",
		);
		// The server finished at the end of its window: the saved answer arrives.
		required(made.streamInvocations.at(-1)).callbacks.onEnd("", made.receipt);
		await vi.advanceTimersByTimeAsync(0);
		expect(made.messages.at(-1)?.id).toBe(saved.id);
		expect(made.runtime.snapshot().isSending).toBe(false);
		made.runtime.detach();
	});
	it.each([
		false,
		true,
	])("bounds pending observation through persistence grace (server budget=%s)", async (serverBudget) => {
		const made = await observing("normal", savedReply());
		const deadlineAt = Date.now() + 4_000;
		// A server that publishes its deadline gets the browser's patience for its
		// finalization window after it (the test above), and no more than a margin
		// beyond: well within two windows it is given up.
		const elapsed = serverBudget
			? 4_000 + 2 * TURN_FINALIZATION_WINDOW_MS
			: 330_000;
		for (let time = 0; time < elapsed; time += 2000) {
			required(made.streamInvocations.at(-1)).callbacks.onWaiting?.({
				version: 1,
				state: "pending",
				streamId: "canonical-stream",
				conversationId: "conv-1",
				turnId: "canonical-turn",
				segmentId: "canonical-segment",
				...(serverBudget ? { deadlineAt } : {}),
			});
			await vi.advanceTimersByTimeAsync(2000);
		}
		expect(made.runtime.snapshot().isSending).toBe(false);
		expect(made.adapters.setSendError).toHaveBeenCalledWith(
			"chat.observationUnavailable",
		);
		expect(
			made.streamInvocations.every(
				(entry) => entry.options?.reconnectToStreamId === "canonical-stream",
			),
		).toBe(true);
		made.runtime.detach();
	});
	it.each([
		false,
		true,
	])("reconciles a legacy receipt after the actual pending reconnect schedule (mismatched=%s)", async (mismatched) => {
		const saved = savedReply();
		saved.normalChatOutput = undefined;
		const made = await observing("normal", saved);
		made.observer.callbacks.onWaiting?.({
			version: 1,
			state: "pending",
			streamId: "canonical-stream",
			conversationId: "conv-1",
			turnId: "canonical-turn",
			segmentId: "canonical-segment",
		});
		expect(made.streamInvocations).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(2000);
		expect(made.streamInvocations).toHaveLength(2);
		const reconnect = made.streamInvocations[1];
		expect(reconnect.options?.reconnectToStreamId).toBe("canonical-stream");
		reconnect.callbacks.onEnd("", {
			observation: {
				...made.receipt.observation,
				completion: {
					...made.receipt.observation.completion,
					segmentId: mismatched ? "wrong-segment" : "canonical-segment",
				},
			},
		});
		await vi.advanceTimersByTimeAsync(0);
		if (mismatched) {
			expect(made.messages.at(-1)?.id).not.toBe(saved.id);
			expect(made.adapters.setSendError).toHaveBeenCalledWith(
				"chat.observationUnavailable",
			);
			expect(made.adapters.refreshMessageCost).not.toHaveBeenCalled();
		} else {
			expect(made.messages.at(-1)).toEqual({
				...saved,
				renderKey: made.key,
				isStreaming: false,
				isThinkingStreaming: false,
				runtimePhase: undefined,
				responseActivity: undefined,
				evidencePending: true,
			});
			expect(
				normalChatOutputView(required(made.messages.at(-1))),
			).toBeUndefined();
			expect(made.adapters.refreshMessageCost).toHaveBeenCalledWith(saved.id);
		}
		expect(made.adapters.readChatMessages).toHaveBeenCalledTimes(1);
		expect(made.runtime.snapshot().isSending).toBe(false);
		made.runtime.detach();
	});
});

// A model outcome that succeeded, observed with no saved reply: the reply (and for
// `delivered`, the file card with it) was never saved. The browser must show an
// explicit failure and keep the queued follow-up instead of sending it into a
// chat that has neither.
async function expectUnsavedSuccessIsAFailure(
	outcome: "answered" | "delivered",
	message: string,
	projected: boolean,
) {
	vi.useFakeTimers();
	const made = makeAdapters({
		schedule: vi.fn((cb, ms) => setTimeout(cb, ms)),
		readChatMessages: vi.fn(async () => []),
	});
	const runtime = createNormalChatClientTurnRuntime(made.adapters);
	await runtime.reconnectToOrphanedStream("observer", message);
	runtime.queue({
		message: "Queued follow-up",
		attachmentIds: [],
		attachments: [],
		pendingAttachments: [],
	});
	expect(runtime.snapshot().queuedTurn?.message).toBe("Queued follow-up");
	const modelCompletion = {
		version: 1,
		turnId: "t",
		segmentId: "s",
		phase: "working",
		outcome,
		stopCause: "natural_stop",
		workingStopCause: "natural_stop",
		closingAttempted: false,
	} as const;
	made.streamInvocations[0].callbacks.onEnd("", {
		observation: {
			version: 1,
			streamId: "observer",
			conversationId: "conv-1",
			state: "terminal",
			assistantMessageId: null,
			completion: projected
				? {
						...modelCompletion,
						outcome: "failed",
						stopCause: "uncertain_execution",
					}
				: modelCompletion,
			...(projected ? { modelCompletion } : {}),
		},
	});
	await vi.advanceTimersByTimeAsync(0);
	const errors = (
		made.adapters.setSendError as ReturnType<typeof vi.fn>
	).mock.calls.map((c) => c[0]);
	// A finalization failure must stay a failure: no queued follow-up is sent
	// on top of a reply that does not exist, and an error is shown.
	expect(made.streamInvocations.map((s) => s.message)).not.toContain(
		"Queued follow-up",
	);
	expect(errors.at(-1)).toBe("chat.observationUnavailable");
	const failedRow = made.messages.at(-1);
	if (!failedRow) throw new Error("Missing failed reply");
	expect(normalChatOutputView(failedRow)?.completion?.outcome).toBe("failed");
	expect(made.adapters.restorePayloadToDraft).toHaveBeenCalledWith(
		expect.objectContaining({ message: "Queued follow-up" }),
	);
	vi.useRealTimers();
}

describe("REVIEW-B unsaved answered terminal", () => {
	it.each([
		["A", false],
		["", false],
		["", true],
	])("does not settle an answered terminal with no saved row (original message=%s)", async (message, projected) => {
		await expectUnsavedSuccessIsAFailure("answered", message, projected);
	});
});

// A file turn's outcome is `delivered`, not `answered`: its unsaved reply was
// still taken for a success (the queued follow-up was sent, no error shown).
describe("REVIEW2-T unsaved delivered terminal", () => {
	it.each([
		["A", false],
		["", false],
		["", true],
	])("does not settle a delivered terminal with no saved row (original message=%s)", async (message, projected) => {
		await expectUnsavedSuccessIsAFailure("delivered", message, projected);
	});
});
