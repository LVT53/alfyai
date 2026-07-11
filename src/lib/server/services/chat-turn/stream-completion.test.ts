import { beforeEach, describe, expect, it, vi } from "vitest";
import { getConversationCostSummary } from "$lib/server/services/analytics";
import {
	assignPendingWritesToAssistantMessage,
	listPendingWritesForConversation,
} from "$lib/server/services/connections/pending-writes";
import { commitSkillNoteOperationsAfterAssistantMessage } from "$lib/server/services/skills/notes";
import { applySkillControlOperations } from "$lib/server/services/skills/sessions";
import { getProjectReferenceContext } from "$lib/server/services/task-state";
import type { UiMessageStreamPart } from "$lib/services/ai-sdk-ui-stream-contract";
import {
	SERVER_STREAM_TIMELINE_MARKS,
	STREAM_TIMELINE_PAYLOAD_VERSION,
	type StreamTimelineTerminalPayload,
} from "$lib/services/stream-timeline";
import type {
	ArtifactSummary,
	ChatMessage,
	ContextDebugState,
	TaskState,
} from "$lib/types";
import type { LegacyContextTraceSectionInput } from "./context-trace";
import { decodeUiMessageStreamParts } from "./stream";
import { completeStreamTurn } from "./stream-completion";

// The post-turn side effects finalize.ts fans out to now live in
// ./finalize-steps and message creation in $lib/server/services/messages;
// completeStreamTurn no longer injects them. Seam at those module boundaries so
// these glue tests can still assert on exactly what finalize hands each step.
const {
	mockCreateMessage,
	mockPersistUserTurnAttachments,
	mockPersistAssistantTurnState,
	mockPersistAssistantEvidence,
	mockRunPostTurnTasks,
} = vi.hoisted(() => ({
	mockCreateMessage: vi.fn(),
	mockPersistUserTurnAttachments: vi.fn(),
	mockPersistAssistantTurnState: vi.fn(),
	mockPersistAssistantEvidence: vi.fn(),
	mockRunPostTurnTasks: vi.fn(),
}));

vi.mock("$lib/server/services/messages", () => ({
	createMessage: mockCreateMessage,
	updateMessageEvidence: vi.fn(async () => undefined),
	updateMessageWebCitationAudit: vi.fn(async () => undefined),
	listConversationMessagesForExport: vi.fn(async () => []),
}));

vi.mock("$lib/server/services/chat-turn/finalize-steps", () => ({
	persistUserTurnAttachments: mockPersistUserTurnAttachments,
	persistAssistantTurnState: mockPersistAssistantTurnState,
	persistAssistantEvidence: mockPersistAssistantEvidence,
	runPostTurnTasks: mockRunPostTurnTasks,
}));

vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(() => ({ contextDiagnosticsDebug: false })),
}));

vi.mock("$lib/server/services/analytics", () => ({
	getConversationCostSummary: vi.fn(async () => ({
		totalCostUsdMicros: 0,
		totalTokens: 0,
	})),
	recordMessageAnalytics: vi.fn(async () => undefined),
}));

vi.mock("$lib/server/services/task-state", () => ({
	getProjectReferenceContext: vi.fn(async () => null),
}));

vi.mock("$lib/server/services/skills/sessions", () => ({
	applySkillControlOperations: vi.fn(async () => null),
}));

vi.mock("$lib/server/services/skills/notes", () => ({
	commitSkillNoteOperationsAfterAssistantMessage: vi.fn(async () => null),
}));

// Issue 7.5 — finalize.ts's pending-write reconciliation falls back to these
// real store functions (no override param exists on completeStreamTurn,
// unlike the file-production job functions below which are injected
// directly). Mock the module so the stream-completion glue tests below can
// assert on the exact ids/assistantMessageId it stamps, without touching a
// real database.
vi.mock("$lib/server/services/connections/pending-writes", () => ({
	listPendingWritesForConversation: vi.fn(async () => []),
	assignPendingWritesToAssistantMessage: vi.fn(async () => undefined),
}));

const defaultLatestContextTraceSections: LegacyContextTraceSectionInput[] = [
	{
		name: "Project Folder Sibling Context",
		source: "memory",
		body: "Title: Font options",
		inclusionLevel: "legacy_full",
		itemIds: ["conversation:conv-fonts"],
		itemTitles: ["Font options"],
		signalReasons: ["project_folder_sibling:query_match"],
	},
];

function createDeferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("completeStreamTurn", () => {
	const mockTouchConversation = vi.fn();
	const mockEnqueueChunk = vi.fn();
	const mockCloseDownstream = vi.fn();
	const mockClearStreamBuffer = vi.fn();
	const mockGetStreamBuffer = vi.fn();
	const mockSyncGeneratedFiles = vi.fn();
	const mockGetChatFilesForMsg = vi.fn();
	const mockGetFileProductionJobs = vi.fn();
	const mockAssignFileProductionJobs = vi.fn();
	const mockEstimateTokenCount = vi.fn().mockReturnValue(100);
	const mockGetConversationCostSummary =
		getConversationCostSummary as ReturnType<typeof vi.fn>;
	const mockGetProjectReferenceContext =
		getProjectReferenceContext as ReturnType<typeof vi.fn>;
	const mockApplySkillControlOperations =
		applySkillControlOperations as ReturnType<typeof vi.fn>;
	const mockCommitSkillNoteOperations =
		commitSkillNoteOperationsAfterAssistantMessage as ReturnType<typeof vi.fn>;
	const mockListPendingWrites = listPendingWritesForConversation as ReturnType<
		typeof vi.fn
	>;
	const mockAssignPendingWrites =
		assignPendingWritesToAssistantMessage as ReturnType<typeof vi.fn>;

	function getLatestEndPayload(): Record<string, unknown> {
		const endEvent = mockEnqueueChunk.mock.calls
			.flatMap((call: string[]) => decodeUiMessageStreamParts(call[0] ?? ""))
			.find(isDataStreamMetadataEvent);

		expect(endEvent).toBeDefined();
		if (!endEvent) return {};
		return (endEvent.data ?? {}) as Record<string, unknown>;
	}

	function getLatestFinishPayload(): Record<string, unknown> {
		const finishEvent = mockEnqueueChunk.mock.calls
			.flatMap((call: string[]) => decodeUiMessageStreamParts(call[0] ?? ""))
			.find((event) => event !== "[DONE]" && event.type === "finish");

		expect(finishEvent).toBeDefined();
		if (!finishEvent) return {};
		return finishEvent as Record<string, unknown>;
	}

	function getStreamParts(): Array<UiMessageStreamPart | "[DONE]"> {
		return mockEnqueueChunk.mock.calls.flatMap((call: string[]) =>
			decodeUiMessageStreamParts(call[0] ?? ""),
		);
	}

	function expectModelSafeTerminalError() {
		const parts = getStreamParts();
		const errorIndex = parts.findIndex(
			(part) => part !== "[DONE]" && part.type === "data-stream-error",
		);
		expect(errorIndex).toBeGreaterThanOrEqual(0);
		expect(parts.some(isDataStreamMetadataEvent)).toBe(false);
		expect(parts.slice(errorIndex)).toEqual([
			expect.objectContaining({
				type: "data-stream-error",
				transient: true,
				data: expect.objectContaining({
					code: "backend_failure",
					message: expect.any(String),
				}),
			}),
			{ type: "finish", finishReason: "error" },
			"[DONE]",
		]);
	}

	function isDataStreamMetadataEvent(
		event: UiMessageStreamPart | "[DONE]",
	): event is UiMessageStreamPart & {
		type: "data-stream-metadata";
		data: unknown;
	} {
		return event !== "[DONE]" && event.type === "data-stream-metadata";
	}

	const defaultUserMsg = { id: "user-msg-1" };
	const defaultAssistantMsg = { id: "asst-msg-1" };
	const defaultServerTimeline: StreamTimelineTerminalPayload = {
		version: STREAM_TIMELINE_PAYLOAD_VERSION,
		server: {
			[SERVER_STREAM_TIMELINE_MARKS.ROUTE_PARSE]: 1,
			[SERVER_STREAM_TIMELINE_MARKS.PRELUDE]: 8,
			[SERVER_STREAM_TIMELINE_MARKS.MODEL_STREAM_REQUEST]: 35,
			[SERVER_STREAM_TIMELINE_MARKS.FIRST_UPSTREAM_EVENT]: 42,
			[SERVER_STREAM_TIMELINE_MARKS.FIRST_THINKING]: 44,
			[SERVER_STREAM_TIMELINE_MARKS.FIRST_VISIBLE_TOKEN]: 55,
			[SERVER_STREAM_TIMELINE_MARKS.END]: 89,
		},
	};
	const defaultTurnState = {
		activeWorkingSet: [],
		taskState: null,
		contextDebug: null,
		workCapsule: {} as unknown as undefined,
	};

	beforeEach(() => {
		vi.resetAllMocks();
		mockCreateMessage
			.mockResolvedValueOnce(defaultUserMsg)
			.mockResolvedValueOnce(defaultAssistantMsg);
		mockPersistUserTurnAttachments.mockResolvedValue(undefined);
		mockPersistAssistantTurnState.mockResolvedValue(defaultTurnState);
		mockPersistAssistantEvidence.mockResolvedValue(undefined);
		mockRunPostTurnTasks.mockResolvedValue(undefined);
		mockTouchConversation.mockResolvedValue(undefined);
		mockGetStreamBuffer.mockReturnValue(null);
		mockSyncGeneratedFiles.mockResolvedValue(undefined);
		mockGetChatFilesForMsg.mockResolvedValue([]);
		mockListPendingWrites.mockResolvedValue([]);
		mockAssignPendingWrites.mockResolvedValue(undefined);
		mockGetFileProductionJobs.mockResolvedValue([]);
		mockAssignFileProductionJobs.mockResolvedValue(undefined);
		mockEnqueueChunk.mockReturnValue(true);
		mockEstimateTokenCount.mockReturnValue(100);
		mockGetConversationCostSummary.mockResolvedValue({
			totalCostUsdMicros: 0,
			totalTokens: 0,
		});
		mockGetProjectReferenceContext.mockResolvedValue(null);
	});

	const defaultParams = {
		wasStopped: false,
		conversationId: "conv-1",
		streamId: "stream-1",
		modelId: "model-1",
		modelDisplayName: "Model One",
		userId: "user-1",
		normalizedMessage: "user message",
		upstreamMessage: "upstream message",
		skipPersistUserMessage: false,
		isReconnect: false,
		thinkingContent: "<thinking>reason</thinking>",
		fullResponse: "response text",
		toolCallRecords: [],
		skillControlEnvelopePayloads: [],
		serverSegments: [],
		attachmentIds: ["att-1"],
		linkedSources: [],
		activeSkillSessionId: null,
		activeDocumentArtifactId: "doc-1",
		requestStartTime: Date.now() - 5000,
		fileProductionJobIdsAtStart: new Set<string>(),
		preparedContext: {
			contextStatus: null,
			taskState: null,
			contextDebug: null,
			contextTraceSections: defaultLatestContextTraceSections,
		},
		latestProviderUsage: null,
		serverTimeline: defaultServerTimeline,
		touchConversation: mockTouchConversation,
		enqueueChunk: mockEnqueueChunk,
		closeDownstream: mockCloseDownstream,
		clearStreamBuffer: mockClearStreamBuffer,
		getStreamBuffer: mockGetStreamBuffer,
		syncGeneratedFilesToMemory: mockSyncGeneratedFiles,
		getChatFilesForAssistantMessage: mockGetChatFilesForMsg,
		getFileProductionJobs: mockGetFileProductionJobs,
		assignFileProductionJobsToAssistantMessage: mockAssignFileProductionJobs,
		estimateTokenCount: mockEstimateTokenCount,
	};

	const artifact = (id: string, name: string): ArtifactSummary => ({
		id,
		type: "source_document",
		retrievalClass: "durable",
		name,
		mimeType: "text/plain",
		sizeBytes: 12,
		conversationId: "conv-1",
		summary: null,
		createdAt: 1,
		updatedAt: 2,
	});

	function makeChatMessage(
		id: string,
		role: ChatMessage["role"],
		content: string,
	): ChatMessage {
		return {
			id,
			role,
			content,
			timestamp: 1_777_140_000_000,
		};
	}

	const contextDebug = (
		artifactId: string,
		name: string,
	): ContextDebugState => ({
		activeTaskId: "task-1",
		activeTaskObjective: "Use persisted context",
		taskLocked: false,
		routingStage: "evidence_rerank",
		routingConfidence: 0.9,
		verificationStatus: "passed",
		selectedEvidence: [
			{
				artifactId,
				name,
				artifactType: "source_document",
				sourceType: "document",
				role: "selected",
				origin: "system",
				confidence: 0.9,
				reason: "persisted evidence",
			},
		],
		selectedEvidenceBySource: [{ sourceType: "document", count: 1 }],
		pinnedEvidence: [],
		excludedEvidence: [],
	});

	const taskState = (taskId: string): TaskState => ({
		taskId,
		userId: "user-1",
		conversationId: "conv-1",
		status: "active",
		objective: "Persisted task",
		confidence: 0.9,
		locked: false,
		lastConfirmedTurnMessageId: null,
		constraints: [],
		factsToPreserve: [],
		decisions: [],
		openQuestions: [],
		activeArtifactIds: [],
		nextSteps: [],
		lastCheckpointAt: null,
		createdAt: 1,
		updatedAt: 2,
	});

	it("creates user and assistant messages", async () => {
		await completeStreamTurn(defaultParams);

		expect(mockCreateMessage).toHaveBeenCalledTimes(2);
		expect(mockCreateMessage).toHaveBeenCalledWith(
			"conv-1",
			"user",
			"user message",
		);
		expect(mockCreateMessage).toHaveBeenCalledWith(
			"conv-1",
			"assistant",
			"response text",
			"<thinking>reason</thinking>",
			undefined,
			expect.objectContaining({
				evidenceStatus: "pending",
				modelDisplayName: "Model One",
				depthMetadata: {
					requested: "auto",
					appliedProfile: "standard",
					fallback: false,
					modelId: "model-1",
					modelDisplayName: "Model One",
				},
			}),
		);
	});

	it("persists and emits Depth Metadata for stopped streams that save an assistant message", async () => {
		await completeStreamTurn({
			...defaultParams,
			wasStopped: true,
			reasoningDepth: "off",
			fullResponse: "partial answer",
			thinkingContent: "",
		});

		expect(mockCreateMessage).toHaveBeenCalledWith(
			"conv-1",
			"assistant",
			"partial answer",
			undefined,
			undefined,
			expect.objectContaining({
				wasStopped: true,
				depthMetadata: {
					requested: "off",
					appliedProfile: "off",
					fallback: false,
					modelId: "model-1",
					modelDisplayName: "Model One",
				},
			}),
		);
		expect(getLatestEndPayload()).toMatchObject({
			assistantMessageId: "asst-msg-1",
			depthMetadata: {
				requested: "off",
				appliedProfile: "off",
				fallback: false,
				modelId: "model-1",
				modelDisplayName: "Model One",
			},
		});
	});

	it("persists and emits classifier-resolved Auto Depth Metadata for completed streams", async () => {
		await completeStreamTurn({
			...defaultParams,
			modelId: "provider:local:model-a",
			modelDisplayName: "Provider Model A",
			depthMetadata: {
				requested: "auto",
				appliedProfile: "extended",
				fallback: false,
				classifierSource: "control_model",
				modelId: "model1",
				modelDisplayName: "Model One",
			},
		});

		expect(mockCreateMessage).toHaveBeenCalledWith(
			"conv-1",
			"assistant",
			"response text",
			"<thinking>reason</thinking>",
			undefined,
			expect.objectContaining({
				depthMetadata: {
					requested: "auto",
					appliedProfile: "extended",
					fallback: false,
					classifierSource: "control_model",
					modelId: "provider:local:model-a",
					modelDisplayName: "Provider Model A",
				},
			}),
		);
		expect(getLatestEndPayload()).toMatchObject({
			assistantMessageId: "asst-msg-1",
			depthMetadata: {
				requested: "auto",
				appliedProfile: "extended",
				fallback: false,
				classifierSource: "control_model",
				modelId: "provider:local:model-a",
				modelDisplayName: "Provider Model A",
			},
		});
	});

	it("emits a model-safe stream error when assistant persistence fails before a stable assistant id", async () => {
		mockCreateMessage
			.mockReset()
			.mockResolvedValueOnce({ id: "user-msg-1" })
			.mockRejectedValueOnce(new Error("assistant persistence offline"));

		await completeStreamTurn({
			...defaultParams,
			reasoningDepth: "max",
		});

		expectModelSafeTerminalError();
	});

	it("emits a model-safe stream error when required user persistence fails before a stable user id", async () => {
		mockCreateMessage
			.mockReset()
			.mockRejectedValueOnce(new Error("user persistence offline"))
			.mockResolvedValueOnce({ id: "asst-msg-1" });

		await completeStreamTurn(defaultParams);

		expectModelSafeTerminalError();
	});

	it("warns and preserves upstream length finish reasons", async () => {
		const warning =
			"Note: The model reached its output limit, so this answer may be incomplete.";

		await completeStreamTurn({
			...defaultParams,
			upstreamFinishReason: "length",
			upstreamRawFinishReason: "max_tokens",
		});

		const assistantCall = mockCreateMessage.mock.calls.find(
			(call) => call[1] === "assistant",
		);
		expect(assistantCall?.[2]).toBe(`response text\n\n${warning}`);
		expect(mockPersistAssistantTurnState).toHaveBeenCalledWith(
			expect.objectContaining({
				assistantResponse: `response text\n\n${warning}`,
			}),
		);
		expect(mockEnqueueChunk).toHaveBeenCalledWith(
			expect.stringContaining(warning),
		);
		expect(getLatestEndPayload()).toMatchObject({
			completionWarning: warning,
			upstreamFinishReason: "length",
			upstreamRawFinishReason: "max_tokens",
		});
		expect(getLatestFinishPayload()).toMatchObject({
			type: "finish",
			finishReason: "length",
		});
	});

	it("warns when the stream completed after a non-terminal upstream close", async () => {
		const warning =
			"Note: The upstream model stream ended before a normal completion signal, so this answer may be incomplete.";

		await completeStreamTurn({
			...defaultParams,
			streamClosedWithoutFinish: true,
		});

		const assistantCall = mockCreateMessage.mock.calls.find(
			(call) => call[1] === "assistant",
		);
		expect(assistantCall?.[2]).toBe(`response text\n\n${warning}`);
		expect(getLatestEndPayload()).toMatchObject({
			completionWarning: warning,
			streamClosedWithoutFinish: true,
			serverTimeline: defaultServerTimeline,
		});
		expect(getLatestFinishPayload()).toMatchObject({
			type: "finish",
			finishReason: "error",
		});
	});

	it("persists the user message before the assistant response for the same turn", async () => {
		const persistedRoles: string[] = [];
		let resolveUserMessage: (() => void) | undefined;
		mockCreateMessage
			.mockReset()
			.mockImplementation(
				async (
					_conversationId: string,
					role: "user" | "assistant",
				): Promise<ChatMessage> => {
					if (role === "user") {
						return new Promise((resolve) => {
							resolveUserMessage = () => {
								persistedRoles.push("user");
								resolve(makeChatMessage("user-msg-1", "user", "user message"));
							};
						});
					}

					persistedRoles.push("assistant");
					return makeChatMessage("asst-msg-1", "assistant", "response text");
				},
			);

		const completion = completeStreamTurn({
			...defaultParams,
			attachmentIds: [],
		});
		await Promise.resolve();

		resolveUserMessage?.();
		await completion;

		expect(persistedRoles).toEqual(["user", "assistant"]);
	});

	it("persists Skill Control metadata and applies stream operations after assistant persistence", async () => {
		await completeStreamTurn({
			...defaultParams,
			fullResponse: "What deadline should I use?",
			skillControlEnvelopePayloads: [
				JSON.stringify({
					version: 1,
					operations: [
						{
							operationId: "stream-question",
							kind: "session_transition",
							transition: "awaiting_user",
						},
					],
				}),
			],
		});

		expect(mockCreateMessage).toHaveBeenCalledWith(
			"conv-1",
			"assistant",
			"What deadline should I use?",
			"<thinking>reason</thinking>",
			undefined,
			expect.objectContaining({
				evidenceStatus: "pending",
				skillQuestion: true,
				skillControl: expect.objectContaining({
					operations: [
						expect.objectContaining({ operationId: "stream-question" }),
					],
				}),
			}),
		);
		expect(mockApplySkillControlOperations).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "asst-msg-1",
			operations: [
				{
					operationId: "stream-question",
					kind: "session_transition",
					transition: "awaiting_user",
				},
			],
		});
	});

	it("commits stream note operations after assistant persistence", async () => {
		await completeStreamTurn({
			...defaultParams,
			activeSkillSessionId: "session-1",
			fullResponse: "Captured.",
			skillControlEnvelopePayloads: [
				JSON.stringify({
					version: 1,
					operations: [
						{
							operationId: "stream-note-create",
							kind: "note_intent",
							action: "create",
							title: "Decision",
							body: "Use the short plan.",
						},
					],
				}),
			],
		});

		expect(mockCommitSkillNoteOperations).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			sessionId: "session-1",
			assistantMessageId: "asst-msg-1",
			operations: [
				{
					operationId: "stream-note-create",
					kind: "note_intent",
					action: "create",
					title: "Decision",
					body: "Use the short plan.",
				},
			],
		});
	});

	it("does not apply Skill Control operations for stopped streams", async () => {
		await completeStreamTurn({
			...defaultParams,
			wasStopped: true,
			fullResponse: "Partial answer",
			skillControlEnvelopePayloads: [
				JSON.stringify({
					version: 1,
					operations: [
						{
							operationId: "partial-question",
							kind: "session_transition",
							transition: "awaiting_user",
						},
					],
				}),
			],
		});

		expect(mockApplySkillControlOperations).not.toHaveBeenCalled();
	});

	it("persists user turn attachments when attachments exist", async () => {
		await completeStreamTurn(defaultParams);

		expect(mockPersistUserTurnAttachments).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			messageId: "user-msg-1",
			normalizedMessage: "user message",
			attachmentIds: ["att-1"],
		});
	});

	it("skips user message persistence when skipPersistUserMessage is true", async () => {
		await completeStreamTurn({
			...defaultParams,
			skipPersistUserMessage: true,
		});

		expect(mockCreateMessage).toHaveBeenCalledTimes(1);
		expect(mockCreateMessage).not.toHaveBeenCalledWith(
			expect.anything(),
			"user",
			expect.anything(),
		);
	});

	it("persists assistant turn state with analytics", async () => {
		await completeStreamTurn(defaultParams);

		expect(mockPersistAssistantTurnState).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				conversationId: "conv-1",
				analytics: expect.objectContaining({
					model: "model-1",
					modelDisplayName: "Model One",
				}),
			}),
		);
	});

	it("persists assistant evidence after turn state completes", async () => {
		await completeStreamTurn(defaultParams);

		expect(mockPersistAssistantEvidence).toHaveBeenCalledWith(
			expect.objectContaining({
				logPrefix: "[STREAM]",
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "asst-msg-1",
				contextTraceSections: [
					expect.objectContaining({
						name: "Project Folder Sibling Context",
						itemIds: ["conversation:conv-fonts"],
					}),
				],
			}),
		);
	});

	it("records source-check metadata when web research citations fail", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const response = "The current price is $799.";

		await completeStreamTurn({
			...defaultParams,
			fullResponse: response,
			toolCallRecords: [
				{
					name: "research_web",
					input: { query: "current price" },
					status: "done",
					sourceType: "web",
					candidates: [
						{
							id: "src-1",
							title: "Official Product",
							url: "https://example.com/product",
							sourceType: "web",
						},
					],
				},
			],
		});

		const noticeCall = mockEnqueueChunk.mock.calls.find((call: string[]) =>
			call[0]?.includes("Source check:"),
		);
		expect(noticeCall).toBeUndefined();
		const assistantCreateCall = mockCreateMessage.mock.calls.find(
			(call: unknown[]) => call[1] === "assistant",
		);
		expect(assistantCreateCall?.[2]).toBe(response);
		expect(assistantCreateCall?.[2]).not.toContain("Official Product");
		expect(assistantCreateCall?.[2]).not.toContain(
			"https://example.com/product",
		);
		expect(mockPersistAssistantTurnState).toHaveBeenCalledWith(
			expect.objectContaining({
				assistantResponse: response,
			}),
		);
		const evidencePayload = mockPersistAssistantEvidence.mock.calls.at(-1)?.[0];
		expect(evidencePayload?.assistantResponse).toBe(response);
		expect(evidencePayload?.assistantResponse).not.toContain(
			"Official Product",
		);
		expect(evidencePayload?.assistantResponse).not.toContain(
			"https://example.com/product",
		);
		expect(mockPersistAssistantEvidence).toHaveBeenCalledWith(
			expect.objectContaining({
				webCitationAudit: expect.objectContaining({
					status: "missing_citations",
					noticeAppended: false,
				}),
			}),
		);

		warnSpy.mockRestore();
	});

	it("does not stream a source-check notice when the original visible response is empty", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		await completeStreamTurn({
			...defaultParams,
			fullResponse: "",
			toolCallRecords: [
				{
					name: "research_web",
					input: { query: "current price" },
					status: "done",
					sourceType: "web",
					candidates: [
						{
							id: "src-1",
							title: "Official Product",
							url: "https://example.com/product",
							sourceType: "web",
						},
					],
				},
			],
		});

		const partTypes = mockEnqueueChunk.mock.calls
			.flatMap((call: string[]) => decodeUiMessageStreamParts(call[0] ?? ""))
			.map((event) => (event === "[DONE]" ? "[DONE]" : event.type));
		const noticeCall = mockEnqueueChunk.mock.calls.find((call: string[]) =>
			call[0]?.includes("Source check:"),
		);

		expect(noticeCall).toBeUndefined();
		expect(partTypes).not.toContain("text-delta");
		expect(partTypes).toContain("finish");

		warnSpy.mockRestore();
	});

	it("persists source-failure audit metadata when zero-source web research is followed by a citation", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const response =
			"Reuters says this is current: https://www.reuters.com/world/example.";

		await completeStreamTurn({
			...defaultParams,
			fullResponse: response,
			toolCallRecords: [
				{
					name: "research_web",
					input: { query: "current reuters headline" },
					status: "done",
					sourceType: "web",
					candidates: [],
				},
			],
		});

		const noticeCall = mockEnqueueChunk.mock.calls.find((call: string[]) =>
			call[0]?.includes("returned no retrievable sources"),
		);
		expect(noticeCall).toBeUndefined();
		const assistantCreateCall = mockCreateMessage.mock.calls.find(
			(call: unknown[]) => call[1] === "assistant",
		);
		expect(assistantCreateCall?.[2]).toBe(response);
		expect(mockPersistAssistantEvidence).toHaveBeenCalledWith(
			expect.objectContaining({
				webCitationAudit: expect.objectContaining({
					status: "unsupported_citations",
					retrievedSourceCount: 0,
					citedUrlCount: 1,
					unsupportedCitationCount: 1,
					noticeAppended: false,
				}),
			}),
		);

		warnSpy.mockRestore();
	});

	it("runs post-turn tasks after persistence", async () => {
		await completeStreamTurn(defaultParams);

		expect(mockRunPostTurnTasks).toHaveBeenCalledWith(
			expect.objectContaining({
				logPrefix: "[STREAM]",
				userId: "user-1",
				conversationId: "conv-1",
				maintenanceReason: "chat_stream",
			}),
		);
	});

	it("sends UI stream metadata with the fast receipt payload shape", async () => {
		await completeStreamTurn(defaultParams);

		const data = getLatestEndPayload();
		expect(data).toEqual(
			expect.objectContaining({
				thinkingTokenCount: 100,
				responseTokenCount: 100,
				totalTokenCount: 200,
				wasStopped: false,
				userMessageId: "user-msg-1",
				assistantMessageId: "asst-msg-1",
				modelId: "model-1",
				modelDisplayName: "Model One",
				serverTimeline: defaultServerTimeline,
				generationDurationMs: expect.any(Number),
			}),
		);
		expect(data).not.toHaveProperty("generatedFiles");
		expect(data).not.toHaveProperty("contextSources");
		expect(data).not.toHaveProperty("contextCompressionSnapshots");
		const partTypes = mockEnqueueChunk.mock.calls
			.flatMap((call: string[]) => decodeUiMessageStreamParts(call[0] ?? ""))
			.map((event) => (event === "[DONE]" ? "[DONE]" : event.type));
		expect(partTypes).toEqual(
			expect.arrayContaining([
				"text-end",
				"reasoning-end",
				"data-stream-metadata",
				"finish",
				"[DONE]",
			]),
		);
	});

	it("emits terminal receipt before broad post-turn projection resolves", async () => {
		const deferredTurnState = createDeferred<typeof defaultTurnState>();
		mockPersistAssistantTurnState.mockImplementationOnce(
			async () => deferredTurnState.promise,
		);

		const completion = completeStreamTurn(defaultParams);
		await flushMicrotasks();

		try {
			expect(mockCloseDownstream).toHaveBeenCalledTimes(1);
			const data = getLatestEndPayload();
			expect(data).toEqual(
				expect.objectContaining({
					thinkingTokenCount: 100,
					responseTokenCount: 100,
					totalTokenCount: 200,
					wasStopped: false,
					userMessageId: "user-msg-1",
					assistantMessageId: "asst-msg-1",
					modelId: "model-1",
					modelDisplayName: "Model One",
					serverTimeline: defaultServerTimeline,
					generationDurationMs: expect.any(Number),
				}),
			);
			expect(data).not.toHaveProperty("contextSources");
			expect(data).not.toHaveProperty("generatedFiles");
			expect(data).not.toHaveProperty("fileProductionJobs");
			expect(data).not.toHaveProperty("contextCompressionSnapshots");
			expect(data).not.toHaveProperty("totalCostUsdMicros");
			expect(data).not.toHaveProperty("activeWorkingSet");
			expect(data).not.toHaveProperty("taskState");
			expect(data).not.toHaveProperty("contextDebug");
		} finally {
			deferredTurnState.resolve(defaultTurnState);
			await completion.catch(() => undefined);
		}
	});

	it("continues deferred post-turn projection after the terminal receipt closes", async () => {
		const deferredTurnState = createDeferred<typeof defaultTurnState>();
		mockPersistAssistantTurnState.mockImplementationOnce(
			async () => deferredTurnState.promise,
		);

		const completion = completeStreamTurn(defaultParams);
		await flushMicrotasks();

		expect(mockCloseDownstream).toHaveBeenCalledTimes(1);
		expect(mockPersistAssistantEvidence).not.toHaveBeenCalled();
		expect(mockRunPostTurnTasks).not.toHaveBeenCalled();

		deferredTurnState.resolve(defaultTurnState);
		await completion;
		await flushMicrotasks();

		expect(mockPersistAssistantEvidence).toHaveBeenCalledWith(
			expect.objectContaining({
				assistantMessageId: "asst-msg-1",
			}),
		);
		expect(mockRunPostTurnTasks).toHaveBeenCalledWith(
			expect.objectContaining({
				assistantMessageId: "asst-msg-1",
				maintenanceReason: "chat_stream",
			}),
		);
	});

	it("logs deferred projection failures without preventing terminal stream success", async () => {
		const projectionError = new Error("projection offline");
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		mockPersistAssistantTurnState.mockRejectedValueOnce(projectionError);

		try {
			await completeStreamTurn(defaultParams);

			expect(mockCloseDownstream).toHaveBeenCalledTimes(1);
			expect(getLatestEndPayload()).toMatchObject({
				userMessageId: "user-msg-1",
				assistantMessageId: "asst-msg-1",
			});
			expect(getLatestFinishPayload()).toMatchObject({
				type: "finish",
				finishReason: "stop",
			});
			expect(errorSpy).toHaveBeenCalledWith(
				"[STREAM] Deferred post-turn projection failed",
				expect.objectContaining({
					conversationId: "conv-1",
					assistantMessageId: "asst-msg-1",
					error: projectionError,
				}),
			);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("sends terminal server timeline metadata for stopped streams", async () => {
		await completeStreamTurn({
			...defaultParams,
			wasStopped: true,
			fullResponse: "partial answer",
			thinkingContent: "",
		});

		expect(getLatestEndPayload()).toMatchObject({
			wasStopped: true,
			serverTimeline: defaultServerTimeline,
		});
	});

	it("omits conversation cost totals from fast receipt metadata", async () => {
		mockGetConversationCostSummary.mockResolvedValueOnce({
			totalCostUsdMicros: 420_000,
			totalTokens: 42,
		});

		await completeStreamTurn(defaultParams);

		expect(mockGetConversationCostSummary).not.toHaveBeenCalled();
		expect(getLatestEndPayload()).not.toHaveProperty("totalCostUsdMicros");
		expect(getLatestEndPayload()).not.toHaveProperty("totalTokens");
	});

	it("defers contextSources and turn-state projection outside fast receipt metadata", async () => {
		const persistedWorkingSet = [
			artifact("artifact-persisted-working", "Persisted working"),
		];
		const attachedArtifacts = [
			artifact("artifact-attached", "Attached source"),
		];
		const persistedContextDebug = contextDebug(
			"artifact-persisted-evidence",
			"Persisted evidence",
		);
		const persistedTaskState = taskState("task-persisted");

		mockPersistUserTurnAttachments.mockResolvedValueOnce(attachedArtifacts);
		mockPersistAssistantTurnState.mockResolvedValueOnce({
			activeWorkingSet: persistedWorkingSet,
			taskState: persistedTaskState,
			contextDebug: persistedContextDebug,
			workCapsule: undefined,
		});

		await completeStreamTurn(defaultParams);

		const data = getLatestEndPayload();

		expect(mockPersistAssistantTurnState).toHaveBeenCalledWith(
			expect.objectContaining({
				assistantMessageId: "asst-msg-1",
			}),
		);
		expect(mockGetProjectReferenceContext).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
		});
		expect(data).not.toHaveProperty("activeWorkingSet");
		expect(data).not.toHaveProperty("taskState");
		expect(data).not.toHaveProperty("contextDebug");
		expect(data).not.toHaveProperty("contextSources");
	});

	it("includes project folder awareness in end metadata and degrades lookup failures", async () => {
		mockGetProjectReferenceContext.mockResolvedValueOnce({
			source: "project_folder",
			projectId: "folder-1",
			projectName: "Launch folder",
			entries: [
				{
					conversationId: "conv-sibling-1",
					title: "Pricing notes",
					objective: null,
					summary: "Stable pricing brief.",
				},
			],
			omittedSiblingCount: 0,
		});

		await completeStreamTurn(defaultParams);

		const data = getLatestEndPayload();

		expect(mockGetProjectReferenceContext).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
		});
		expect(data).not.toHaveProperty("contextSources");

		vi.clearAllMocks();
		mockCreateMessage
			.mockResolvedValueOnce(defaultUserMsg)
			.mockResolvedValueOnce(defaultAssistantMsg);
		mockPersistUserTurnAttachments.mockResolvedValue(undefined);
		mockPersistAssistantTurnState.mockResolvedValue(defaultTurnState);
		mockTouchConversation.mockResolvedValue(undefined);
		mockGetStreamBuffer.mockReturnValue(null);
		mockGetChatFilesForMsg.mockResolvedValue([]);
		mockGetFileProductionJobs.mockResolvedValue([]);
		mockAssignFileProductionJobs.mockResolvedValue(undefined);
		mockEnqueueChunk.mockReturnValue(true);
		mockEstimateTokenCount.mockReturnValue(100);
		mockGetProjectReferenceContext.mockRejectedValueOnce(
			new Error("folder lookup failed"),
		);

		await completeStreamTurn(defaultParams);

		const fallbackData = getLatestEndPayload();
		expect(fallbackData).not.toHaveProperty("contextSources");
	});

	it("sets wasStopped to true in the end event when requested", async () => {
		await completeStreamTurn({ ...defaultParams, wasStopped: true });

		const data = getLatestEndPayload();
		expect(data.wasStopped).toBe(true);
	});

	it("persists stopped assistant responses with message metadata", async () => {
		await completeStreamTurn({ ...defaultParams, wasStopped: true });

		expect(mockCreateMessage).toHaveBeenNthCalledWith(
			2,
			"conv-1",
			"assistant",
			"response text",
			"<thinking>reason</thinking>",
			undefined,
			expect.objectContaining({ wasStopped: true }),
		);
		expect(mockPersistAssistantTurnState).not.toHaveBeenCalled();
		expect(mockRunPostTurnTasks).not.toHaveBeenCalled();
	});

	it("persists an assistant placeholder for stopped streams without visible text", async () => {
		await completeStreamTurn({
			...defaultParams,
			wasStopped: true,
			fullResponse: "",
			thinkingContent: "",
		});

		expect(mockCreateMessage).toHaveBeenNthCalledWith(
			1,
			"conv-1",
			"user",
			"user message",
		);
		expect(mockCreateMessage).toHaveBeenNthCalledWith(
			2,
			"conv-1",
			"assistant",
			"Stopped",
			undefined,
			undefined,
			expect.objectContaining({ wasStopped: true }),
		);
		expect(mockPersistAssistantTurnState).not.toHaveBeenCalled();
		expect(mockRunPostTurnTasks).not.toHaveBeenCalled();
		const data = getLatestEndPayload();
		expect(data.assistantMessageId).toBe("asst-msg-1");
	});

	it("touches conversation and clears stream buffer on completion", async () => {
		await completeStreamTurn(defaultParams);

		expect(mockTouchConversation).toHaveBeenCalledWith("user-1", "conv-1");
		expect(mockClearStreamBuffer).toHaveBeenCalledWith("stream-1");
		expect(mockCloseDownstream).toHaveBeenCalled();
	});

	it("handles reconnect by using buffer user message", async () => {
		mockGetStreamBuffer.mockReturnValue({ userMessage: "buffered message" });

		await completeStreamTurn({ ...defaultParams, isReconnect: true });

		expect(mockGetStreamBuffer).toHaveBeenCalledWith({
			streamId: "stream-1",
			userId: "user-1",
			conversationId: "conv-1",
		});
		expect(mockCreateMessage).toHaveBeenCalledWith(
			"conv-1",
			"user",
			"buffered message",
		);
	});

	it("keeps reconnect file-producing completion aligned with durable generated files", async () => {
		mockGetStreamBuffer.mockReturnValue({ userMessage: "buffered message" });
		mockGetFileProductionJobs.mockResolvedValue([
			{
				id: "job-existing",
				conversationId: "conv-1",
				assistantMessageId: null,
				title: "Existing",
				status: "succeeded",
				createdAt: 1,
				updatedAt: 2,
				files: [{ id: "gf-existing" }],
				warnings: [],
			},
			{
				id: "job-new",
				conversationId: "conv-1",
				assistantMessageId: "asst-msg-1",
				title: "Reconnect output",
				status: "succeeded",
				createdAt: 3,
				updatedAt: 4,
				files: [
					{
						id: "gf-new",
						filename: "reconnect-output.pdf",
						mimeType: "application/pdf",
						sizeBytes: 456,
						downloadUrl: "/api/chat/files/gf-new/download",
						previewUrl: "/api/chat/files/gf-new/preview",
					},
				],
				warnings: [],
			},
		]);
		mockGetChatFilesForMsg.mockResolvedValue([
			{
				id: "gf-new",
				conversationId: "conv-1",
				assistantMessageId: "asst-msg-1",
				artifactId: "artifact-generated",
				documentFamilyId: null,
				documentFamilyStatus: null,
				documentLabel: null,
				documentRole: null,
				versionNumber: null,
				originConversationId: null,
				originAssistantMessageId: null,
				sourceChatFileId: null,
				userId: "user-1",
				filename: "reconnect-output.pdf",
				mimeType: "application/pdf",
				sizeBytes: 456,
				storagePath: "private/conv-1/gf-new.pdf",
				createdAt: 1_777_140_200,
			},
		]);

		await completeStreamTurn({
			...defaultParams,
			isReconnect: true,
			fileProductionJobIdsAtStart: new Set(["job-existing"]),
			toolCallRecords: [{ name: "produce_file", input: {}, status: "done" }],
		});

		expect(mockCreateMessage).toHaveBeenCalledWith(
			"conv-1",
			"user",
			"buffered message",
		);
		expect(mockAssignFileProductionJobs).toHaveBeenCalledWith(
			"user-1",
			"conv-1",
			"asst-msg-1",
			["job-new"],
		);
		const data = getLatestEndPayload();
		expect(data).not.toHaveProperty("generatedFiles");
		expect(data).not.toHaveProperty("fileProductionJobs");
	});

	it("attaches produce_file jobs for completed streams with empty visible text", async () => {
		mockGetFileProductionJobs.mockResolvedValue([
			{ id: "job-new", files: [{ id: "gf-new" }] },
		]);
		mockGetChatFilesForMsg.mockResolvedValue([
			{
				id: "gf-new",
				conversationId: "conv-1",
				assistantMessageId: "asst-msg-1",
				artifactId: "artifact-generated",
				documentFamilyId: "family-1",
				documentFamilyStatus: "active",
				documentLabel: "Output",
				documentRole: "primary",
				versionNumber: 2,
				originConversationId: "conv-1",
				originAssistantMessageId: "asst-msg-1",
				sourceChatFileId: null,
				userId: "user-1",
				filename: "output.txt",
				mimeType: "text/plain",
				sizeBytes: 123,
				storagePath: "private/conv-1/gf-new.txt",
				createdAt: 1_777_140_100,
			},
		]);

		await completeStreamTurn({
			...defaultParams,
			fullResponse: "",
			toolCallRecords: [{ name: "produce_file", input: {}, status: "done" }],
		});

		expect(mockCreateMessage).toHaveBeenCalledWith(
			"conv-1",
			"assistant",
			"",
			"<thinking>reason</thinking>",
			undefined,
			expect.objectContaining({ evidenceStatus: "pending" }),
		);
		expect(mockPersistAssistantTurnState).toHaveBeenCalledWith(
			expect.objectContaining({
				assistantMessageId: "asst-msg-1",
				assistantResponse: "",
			}),
		);
		expect(mockAssignFileProductionJobs).toHaveBeenCalledWith(
			"user-1",
			"conv-1",
			"asst-msg-1",
			["job-new"],
		);
		const data = getLatestEndPayload();
		expect(data.assistantMessageId).toBe("asst-msg-1");
		expect(data).not.toHaveProperty("generatedFiles");
		expect(data).not.toHaveProperty("fileProductionJobs");
	});

	it("attaches failed produce_file jobs and emits a visible failure notice", async () => {
		const warning =
			"Note: File production failed. Check the file card for details or retry the job.";
		mockGetFileProductionJobs.mockResolvedValue([{ id: "job-new", files: [] }]);

		await completeStreamTurn({
			...defaultParams,
			fullResponse: "",
			toolCallRecords: [
				{
					name: "produce_file",
					input: {},
					status: "done",
					metadata: {
						ok: false,
						evidenceReady: false,
						error: "Renderer failed",
					},
				},
			],
		});

		const assistantCall = mockCreateMessage.mock.calls.find(
			(call) => call[1] === "assistant",
		);
		expect(assistantCall?.[2]).toBe(warning);
		expect(mockPersistAssistantTurnState).toHaveBeenCalledWith(
			expect.objectContaining({
				assistantResponse: warning,
			}),
		);
		expect(mockEnqueueChunk).toHaveBeenCalledWith(
			expect.stringContaining(warning),
		);
		expect(mockAssignFileProductionJobs).toHaveBeenCalledWith(
			"user-1",
			"conv-1",
			"asst-msg-1",
			["job-new"],
		);
	});

	it("attaches new file-production jobs from produce_file to the assistant message", async () => {
		mockGetFileProductionJobs.mockResolvedValue([
			{ id: "job-existing" },
			{ id: "job-new" },
		]);

		await completeStreamTurn({
			...defaultParams,
			fileProductionJobIdsAtStart: new Set(["job-existing"]),
			toolCallRecords: [{ name: "produce_file", input: {}, status: "done" }],
		});

		expect(mockAssignFileProductionJobs).toHaveBeenCalledWith(
			"user-1",
			"conv-1",
			"asst-msg-1",
			["job-new"],
		);
	});

	it("uses eager completion facts for reset generation and file-production reconciliation", async () => {
		mockGetFileProductionJobs.mockResolvedValue([
			{ id: "job-existing" },
			{ id: "job-new" },
		]);

		await completeStreamTurn({
			...defaultParams,
			startedResetGeneration: 7,
			fileProductionJobIdsAtStart: new Set(["job-existing"]),
			toolCallRecords: [{ name: "produce_file", input: {}, status: "done" }],
		});

		expect(mockAssignFileProductionJobs).toHaveBeenCalledWith(
			"user-1",
			"conv-1",
			"asst-msg-1",
			["job-new"],
		);
		expect(mockRunPostTurnTasks).toHaveBeenCalledWith(
			expect.objectContaining({
				startedResetGeneration: 7,
			}),
		);
	});

	it("resolves hot completion fact promises before persistence and file-production reconciliation", async () => {
		const startedResetGeneration = Promise.resolve(11);
		const fileProductionJobIdsAtStart = Promise.resolve(
			new Set(["job-existing"]),
		);
		mockGetFileProductionJobs.mockResolvedValue([
			{ id: "job-existing" },
			{ id: "job-new" },
		]);

		await completeStreamTurn({
			...defaultParams,
			startedResetGeneration,
			fileProductionJobIdsAtStart,
			toolCallRecords: [{ name: "produce_file", input: {}, status: "done" }],
		});

		expect(mockAssignFileProductionJobs).toHaveBeenCalledWith(
			"user-1",
			"conv-1",
			"asst-msg-1",
			["job-new"],
		);
		expect(mockRunPostTurnTasks).toHaveBeenCalledWith(
			expect.objectContaining({
				startedResetGeneration: 11,
			}),
		);
	});

	it("degrades rejected reset generation facts and still finalizes the stream", async () => {
		const resetGenerationError = new Error("reset generation unavailable");
		const startedResetGeneration = Promise.reject(resetGenerationError);
		startedResetGeneration.catch(() => undefined);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		try {
			await completeStreamTurn({
				...defaultParams,
				startedResetGeneration,
			});

			expect(mockCreateMessage).toHaveBeenCalledTimes(2);
			expect(mockCreateMessage).toHaveBeenCalledWith(
				"conv-1",
				"assistant",
				"response text",
				"<thinking>reason</thinking>",
				undefined,
				expect.objectContaining({ evidenceStatus: "pending" }),
			);
			expect(mockPersistAssistantTurnState).toHaveBeenCalledWith(
				expect.objectContaining({
					assistantMessageId: "asst-msg-1",
				}),
			);
			expect(
				(
					mockRunPostTurnTasks.mock.calls.at(-1)?.[0] as
						| { startedResetGeneration?: number }
						| undefined
				)?.startedResetGeneration,
			).toBeUndefined();
			expect(getLatestEndPayload()).toMatchObject({
				userMessageId: "user-msg-1",
				assistantMessageId: "asst-msg-1",
			});
			expect(getLatestFinishPayload()).toMatchObject({
				type: "finish",
				finishReason: "stop",
			});
			expect(warn).toHaveBeenCalledWith(
				"[CHAT_STREAM] Failed to resolve stream reset generation fact",
				expect.objectContaining({
					conversationId: "conv-1",
					streamId: "stream-1",
					error: resetGenerationError,
				}),
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("attaches a same-turn file-production job when a late start snapshot includes it", async () => {
		mockGetFileProductionJobs.mockResolvedValue([
			{ id: "job-existing", createdAt: 999 },
			{ id: "job-new", createdAt: 1001 },
		]);

		await completeStreamTurn({
			...defaultParams,
			fileProductionJobIdsAtStart: Promise.resolve({
				jobIds: new Set(["job-existing", "job-new"]),
				snapshotStartedAt: 1000,
			}),
			toolCallRecords: [
				{
					name: "produce_file",
					input: {},
					status: "done",
				},
			],
		});

		expect(mockAssignFileProductionJobs).toHaveBeenCalledWith(
			"user-1",
			"conv-1",
			"asst-msg-1",
			["job-new"],
		);
	});

	it("attaches a produce_file metadata job even when the late start snapshot includes it", async () => {
		mockGetFileProductionJobs.mockResolvedValue([
			{ id: "job-existing", createdAt: 999 },
			{ id: "job-new", createdAt: 999 },
		]);

		await completeStreamTurn({
			...defaultParams,
			fileProductionJobIdsAtStart: Promise.resolve({
				jobIds: new Set(["job-existing", "job-new"]),
				snapshotStartedAt: 1000,
			}),
			toolCallRecords: [
				{
					name: "produce_file",
					input: {},
					status: "done",
					metadata: {
						jobId: "job-new",
					},
				},
			],
		});

		expect(mockAssignFileProductionJobs).toHaveBeenCalledWith(
			"user-1",
			"conv-1",
			"asst-msg-1",
			["job-new"],
		);
	});

	it("does not attach current jobs when a hot file-production start snapshot rejects", async () => {
		const snapshotError = new Error("snapshot failed");
		const rejectedSnapshot = Promise.reject(snapshotError);
		rejectedSnapshot.catch(() => undefined);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		mockGetFileProductionJobs.mockResolvedValue([
			{ id: "job-existing" },
			{ id: "job-new" },
		]);

		try {
			await completeStreamTurn({
				...defaultParams,
				startedResetGeneration: 7,
				fileProductionJobIdsAtStart: rejectedSnapshot,
				toolCallRecords: [{ name: "produce_file", input: {}, status: "done" }],
			});

			expect(mockAssignFileProductionJobs).not.toHaveBeenCalled();
			expect(getLatestEndPayload()).toMatchObject({
				assistantMessageId: "asst-msg-1",
			});
			expect(getLatestEndPayload()).not.toHaveProperty("fileProductionJobs");
			expect(warn).toHaveBeenCalledWith(
				"[CHAT_STREAM] Failed to snapshot file-production jobs at stream start",
				expect.objectContaining({
					conversationId: "conv-1",
					streamId: "stream-1",
					error: snapshotError,
				}),
			);
		} finally {
			warn.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("attaches new file-production jobs from file-production tool aliases", async () => {
		mockGetFileProductionJobs.mockResolvedValue([{ id: "job-new" }]);

		await completeStreamTurn({
			...defaultParams,
			toolCallRecords: [{ name: "File Production", input: {}, status: "done" }],
		});

		expect(mockAssignFileProductionJobs).toHaveBeenCalledWith(
			"user-1",
			"conv-1",
			"asst-msg-1",
			["job-new"],
		);
	});

	it("handles produced generated files from produce_file tool calls", async () => {
		mockGetFileProductionJobs.mockResolvedValue([
			{ id: "job-new", files: [{ id: "gf-new" }] },
		]);
		mockGetChatFilesForMsg.mockResolvedValue([
			{
				id: "gf-new",
				conversationId: "conv-1",
				assistantMessageId: "asst-msg-1",
				artifactId: "artifact-generated",
				documentFamilyId: null,
				documentFamilyStatus: null,
				documentLabel: null,
				documentRole: null,
				versionNumber: null,
				originConversationId: null,
				originAssistantMessageId: null,
				sourceChatFileId: null,
				filename: "output.txt",
				mimeType: "text/plain",
				sizeBytes: 123,
				createdAt: 1_777_140_100,
			},
		]);

		await completeStreamTurn({
			...defaultParams,
			toolCallRecords: [{ name: "produce_file", input: {}, status: "done" }],
		});

		expect(mockAssignFileProductionJobs).toHaveBeenCalledWith(
			"user-1",
			"conv-1",
			"asst-msg-1",
			["job-new"],
		);
		expect(mockSyncGeneratedFiles).toHaveBeenCalledWith(
			expect.objectContaining({
				fileIds: ["gf-new"],
			}),
		);
	});

	// Issue 7.5 — the wiring reviewed as untested: does a connection-write-only
	// turn (no file-production call) widen the generatedOutputReconciliation
	// gate and stamp new pending writes onto the FINALIZED assistant message
	// id, does a no-op turn skip it cleanly, and does a rejected snapshot
	// degrade safely instead of crashing or mis-stamping.
	describe("pending-write reconciliation at stream completion", () => {
		it("stamps a new pending write onto the finalized assistant message id for a connection-write-only turn (no file production)", async () => {
			mockListPendingWrites.mockResolvedValue([
				{ id: "pw-existing" },
				{ id: "pw-new" },
			]);

			await completeStreamTurn({
				...defaultParams,
				pendingWriteIdsAtStart: new Set(["pw-existing"]),
				toolCallRecords: [{ name: "files", input: {}, status: "done" }],
			});

			expect(mockListPendingWrites).toHaveBeenCalledWith("user-1", "conv-1");
			expect(mockAssignPendingWrites).toHaveBeenCalledWith(
				"user-1",
				"conv-1",
				"asst-msg-1",
				["pw-new"],
			);
			// A connection-write-only turn must not spuriously stamp file-production
			// jobs — the gate widens for pending writes without pulling in
			// unrelated file-production behavior.
			expect(mockAssignFileProductionJobs).not.toHaveBeenCalled();
		});

		it("widens the reconciliation gate for any of the four connection tool names, not just files", async () => {
			mockListPendingWrites.mockResolvedValue([{ id: "pw-new" }]);

			await completeStreamTurn({
				...defaultParams,
				pendingWriteIdsAtStart: new Set(),
				toolCallRecords: [{ name: "calendar", input: {}, status: "done" }],
			});

			expect(mockAssignPendingWrites).toHaveBeenCalledWith(
				"user-1",
				"conv-1",
				"asst-msg-1",
				["pw-new"],
			);
		});

		it("does not stamp anything when a connection-write-only turn creates no new pending write", async () => {
			mockListPendingWrites.mockResolvedValue([{ id: "pw-existing" }]);

			await completeStreamTurn({
				...defaultParams,
				pendingWriteIdsAtStart: new Set(["pw-existing"]),
				toolCallRecords: [{ name: "email", input: {}, status: "done" }],
			});

			expect(mockListPendingWrites).toHaveBeenCalledWith("user-1", "conv-1");
			expect(mockAssignPendingWrites).not.toHaveBeenCalled();
		});

		it("never queries pending writes when the turn had no file-production or connection tool call", async () => {
			await completeStreamTurn({
				...defaultParams,
				pendingWriteIdsAtStart: new Set(["pw-existing"]),
				toolCallRecords: [{ name: "research_web", input: {}, status: "done" }],
			});

			expect(mockListPendingWrites).not.toHaveBeenCalled();
			expect(mockAssignPendingWrites).not.toHaveBeenCalled();
		});

		it("degrades pending-write reconciliation safely when the pendingWriteIdsAtStart fact rejects, without crashing the turn", async () => {
			const snapshotError = new Error("pending-write snapshot failed");
			const rejectedSnapshot = Promise.reject(snapshotError);
			rejectedSnapshot.catch(() => undefined);
			const warn = vi
				.spyOn(console, "warn")
				.mockImplementation(() => undefined);

			try {
				await completeStreamTurn({
					...defaultParams,
					pendingWriteIdsAtStart: rejectedSnapshot,
					toolCallRecords: [{ name: "files", input: {}, status: "done" }],
				});

				expect(mockListPendingWrites).not.toHaveBeenCalled();
				expect(mockAssignPendingWrites).not.toHaveBeenCalled();
				expect(getLatestEndPayload()).toMatchObject({
					assistantMessageId: "asst-msg-1",
				});
				expect(getLatestFinishPayload()).toMatchObject({
					type: "finish",
					finishReason: "stop",
				});
				expect(warn).toHaveBeenCalledWith(
					"[CHAT_STREAM] Failed to snapshot pending writes at stream start",
					expect.objectContaining({
						conversationId: "conv-1",
						streamId: "stream-1",
						error: snapshotError,
					}),
				);
			} finally {
				warn.mockRestore();
			}
		});

		it("resolves a hot (promise) pendingWriteIdsAtStart fact before stamping the finalized assistant message", async () => {
			mockListPendingWrites.mockResolvedValue([
				{ id: "pw-existing" },
				{ id: "pw-new" },
			]);

			await completeStreamTurn({
				...defaultParams,
				pendingWriteIdsAtStart: Promise.resolve(new Set(["pw-existing"])),
				toolCallRecords: [{ name: "photos", input: {}, status: "done" }],
			});

			expect(mockAssignPendingWrites).toHaveBeenCalledWith(
				"user-1",
				"conv-1",
				"asst-msg-1",
				["pw-new"],
			);
		});
	});
});
