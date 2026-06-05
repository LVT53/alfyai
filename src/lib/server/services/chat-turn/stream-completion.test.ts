import { describe, expect, it, vi } from "vitest";
import { commitSkillNoteOperationsAfterAssistantMessage } from "$lib/server/services/skills/notes";
import { applySkillControlOperations } from "$lib/server/services/skills/sessions";
import { getProjectReferenceContext } from "$lib/server/services/task-state";
import type { ArtifactSummary, ContextDebugState, TaskState } from "$lib/types";
import { decodeUiMessageStreamParts } from "./stream";
import { completeStreamTurn } from "./stream-completion";

vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(() => ({ contextDiagnosticsDebug: false })),
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

describe("completeStreamTurn", () => {
	const mockCreateMessage = vi.fn();
	const mockPersistUserTurnAttachments = vi.fn();
	const mockPersistAssistantTurnState = vi.fn();
	const mockPersistAssistantEvidence = vi.fn();
	const mockRunPostTurnTasks = vi.fn();
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
	const mockGetProjectReferenceContext =
		getProjectReferenceContext as ReturnType<typeof vi.fn>;
	const mockApplySkillControlOperations =
		applySkillControlOperations as ReturnType<typeof vi.fn>;
	const mockCommitSkillNoteOperations =
		commitSkillNoteOperationsAfterAssistantMessage as ReturnType<typeof vi.fn>;

	function getLatestEndPayload(): Record<string, unknown> {
		const endEvent = mockEnqueueChunk.mock.calls
			.flatMap((call: string[]) => decodeUiMessageStreamParts(call[0] ?? ""))
			.find(
				(event) => event !== "[DONE]" && event.type === "data-stream-metadata",
			);

		expect(endEvent).toBeDefined();
		return endEvent !== "[DONE]"
			? ((endEvent?.data ?? {}) as Record<string, unknown>)
			: {};
	}

	function getLatestFinishPayload(): Record<string, unknown> {
		const finishEvent = mockEnqueueChunk.mock.calls
			.flatMap((call: string[]) => decodeUiMessageStreamParts(call[0] ?? ""))
			.find((event) => event !== "[DONE]" && event.type === "finish");

		expect(finishEvent).toBeDefined();
		return finishEvent !== "[DONE]"
			? (finishEvent as Record<string, unknown>)
			: {};
	}

	function getContextSourceGroups(payload: Record<string, unknown>): unknown[] {
		const contextSources = payload.contextSources as
			| { groups?: unknown[] }
			| undefined;
		return contextSources?.groups ?? [];
	}

	const defaultUserMsg = { id: "user-msg-1" };
	const defaultAssistantMsg = { id: "asst-msg-1" };
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
		mockGetFileProductionJobs.mockResolvedValue([]);
		mockAssignFileProductionJobs.mockResolvedValue(undefined);
		mockEnqueueChunk.mockReturnValue(true);
		mockEstimateTokenCount.mockReturnValue(100);
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
		latestContextStatus: null as unknown,
		latestActiveWorkingSet: null as unknown,
		latestTaskState: null as unknown,
		latestContextDebug: null as unknown,
		latestHonchoContext: null as unknown,
		latestHonchoSnapshot: null as unknown,
		latestContextTraceSections: [
			{
				name: "Project Folder Sibling Context",
				source: "memory",
				body: "Title: Font options",
				inclusionLevel: "legacy_full",
				itemIds: ["conversation:conv-fonts"],
				itemTitles: ["Font options"],
				signalReasons: ["project_folder_sibling:query_match"],
			},
		],
		latestProviderUsage: null as unknown,
		initialContextStatus: null as unknown,
		initialTaskState: null as unknown,
		initialContextDebug: null as unknown,
		createMessage: mockCreateMessage,
		persistUserTurnAttachments: mockPersistUserTurnAttachments,
		persistAssistantTurnState: mockPersistAssistantTurnState,
		persistAssistantEvidence: mockPersistAssistantEvidence,
		runPostTurnTasks: mockRunPostTurnTasks,
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
		honcho: null,
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
			{ evidenceStatus: "pending", modelDisplayName: "Model One" },
		);
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
		});
		expect(getLatestFinishPayload()).toMatchObject({
			type: "finish",
			finishReason: "error",
		});
	});

	it("persists the user message before the assistant response for the same turn", async () => {
		const persistedRoles: string[] = [];
		let resolveUserMessage: (() => void) | undefined;
		const createMessage = vi.fn(
			async (
				_conversationId: string,
				role: "user" | "assistant",
			): Promise<{ id: string }> => {
				if (role === "user") {
					return new Promise((resolve) => {
						resolveUserMessage = () => {
							persistedRoles.push("user");
							resolve({ id: "user-msg-1" });
						};
					});
				}

				persistedRoles.push("assistant");
				return { id: "asst-msg-1" };
			},
		);

		const completion = completeStreamTurn({
			...defaultParams,
			createMessage,
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
				continuitySource: "stream",
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

	it("appends a source-check notice when web research citations fail", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		await completeStreamTurn({
			...defaultParams,
			fullResponse: "The current price is $799.",
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
		expect(noticeCall).toBeDefined();
		expect(noticeCall?.[0]).not.toContain("Official Product");
		expect(noticeCall?.[0]).not.toContain("https://example.com/product");
		const assistantCreateCall = mockCreateMessage.mock.calls.find(
			(call: unknown[]) => call[1] === "assistant",
		);
		expect(assistantCreateCall?.[2]).toEqual(
			expect.stringContaining("Source check:"),
		);
		expect(assistantCreateCall?.[2]).not.toContain("Official Product");
		expect(assistantCreateCall?.[2]).not.toContain(
			"https://example.com/product",
		);
		expect(mockPersistAssistantTurnState).toHaveBeenCalledWith(
			expect.objectContaining({
				assistantResponse: expect.stringContaining("Source check:"),
			}),
		);
		const evidencePayload = mockPersistAssistantEvidence.mock.calls.at(-1)?.[0];
		expect(evidencePayload?.assistantResponse).toContain("Source check:");
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
					noticeAppended: true,
				}),
			}),
		);

		warnSpy.mockRestore();
	});

	it("starts a text part before a source-check notice when the original visible response is empty", async () => {
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
		const noticeParts = decodeUiMessageStreamParts(noticeCall?.[0] ?? "");

		expect(partTypes.indexOf("text-start")).toBeLessThan(
			partTypes.indexOf("text-delta"),
		);
		expect(noticeParts).toEqual([
			expect.objectContaining({ type: "text-delta" }),
		]);
		expect(partTypes).toEqual(expect.arrayContaining(["text-end", "finish"]));

		warnSpy.mockRestore();
	});

	it("persists a source-failure notice when zero-source web research is followed by a citation", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		await completeStreamTurn({
			...defaultParams,
			fullResponse:
				"Reuters says this is current: https://www.reuters.com/world/example.",
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
		expect(noticeCall).toBeDefined();
		const assistantCreateCall = mockCreateMessage.mock.calls.find(
			(call: unknown[]) => call[1] === "assistant",
		);
		expect(assistantCreateCall?.[2]).toContain(
			"were not verified by the web research tool",
		);
		expect(mockPersistAssistantEvidence).toHaveBeenCalledWith(
			expect.objectContaining({
				webCitationAudit: expect.objectContaining({
					status: "unsupported_citations",
					retrievedSourceCount: 0,
					citedUrlCount: 1,
					unsupportedCitationCount: 1,
					noticeAppended: true,
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

	it("sends UI stream metadata with the old end payload shape", async () => {
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
				generatedFiles: [],
			}),
		);
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

	it("builds end metadata contextSources from persisted turn state and attached artifacts", async () => {
		const staleWorkingSet = [
			artifact("artifact-stale-working", "Stale working"),
		];
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

		await completeStreamTurn({
			...defaultParams,
			latestActiveWorkingSet: staleWorkingSet,
			latestTaskState: taskState("task-stale"),
			latestContextDebug: contextDebug(
				"artifact-stale-evidence",
				"Stale evidence",
			),
		});

		const data = getLatestEndPayload();

		expect(data.activeWorkingSet).toEqual(persistedWorkingSet);
		expect(data.taskState).toEqual(persistedTaskState);
		expect(data.contextDebug).toEqual(persistedContextDebug);
		expect(getContextSourceGroups(data)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "attachments",
					items: [
						expect.objectContaining({
							artifactId: "artifact-attached",
							title: "Attached source",
						}),
					],
				}),
				expect.objectContaining({
					kind: "working_set",
					items: [
						expect.objectContaining({
							artifactId: "artifact-persisted-working",
							title: "Persisted working",
						}),
					],
				}),
				expect.objectContaining({
					kind: "task_evidence",
					items: [
						expect.objectContaining({
							artifactId: "artifact-persisted-evidence",
							title: "Persisted evidence",
						}),
					],
				}),
			]),
		);
		expect(JSON.stringify(data.contextSources)).not.toContain("Stale");
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
		expect(getContextSourceGroups(data)).toEqual([
			expect.objectContaining({
				kind: "project_folder",
				state: "inferred",
				items: [
					expect.objectContaining({
						title: "Launch folder",
						sourceType: "conversation",
					}),
				],
			}),
		]);

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
		expect(getContextSourceGroups(fallbackData)).toEqual([]);
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
	});

	it("does not persist an assistant message for stopped streams without visible text", async () => {
		await completeStreamTurn({
			...defaultParams,
			wasStopped: true,
			fullResponse: "",
			thinkingContent: "",
		});

		expect(mockCreateMessage).toHaveBeenCalledTimes(1);
		expect(mockCreateMessage).toHaveBeenCalledWith(
			"conv-1",
			"user",
			"user message",
		);
		expect(mockPersistAssistantTurnState).not.toHaveBeenCalled();
		const data = getLatestEndPayload();
		expect(data.assistantMessageId).toBeUndefined();
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
			{ id: "job-existing", files: [{ id: "gf-existing" }] },
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
			toolCallRecords: [{ name: "produce_file", status: "done" }],
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
		expect(data.generatedFiles).toEqual([
			expect.objectContaining({
				id: "gf-new",
				conversationId: "conv-1",
				assistantMessageId: "asst-msg-1",
				artifactId: "artifact-generated",
				filename: "reconnect-output.pdf",
				mimeType: "application/pdf",
				sizeBytes: 456,
				createdAt: 1_777_140_200,
			}),
		]);
		expect(JSON.stringify(data.generatedFiles)).not.toContain("storagePath");
		expect(JSON.stringify(data.generatedFiles)).not.toContain("user-1");
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
			toolCallRecords: [{ name: "produce_file", status: "done" }],
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
		expect(data.generatedFiles).toEqual([
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
				filename: "output.txt",
				mimeType: "text/plain",
				sizeBytes: 123,
				createdAt: 1_777_140_100,
			},
		]);
		expect(JSON.stringify(data.generatedFiles)).not.toContain("storagePath");
		expect(JSON.stringify(data.generatedFiles)).not.toContain("user-1");
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
			toolCallRecords: [{ name: "produce_file", status: "done" }],
		});

		expect(mockAssignFileProductionJobs).toHaveBeenCalledWith(
			"user-1",
			"conv-1",
			"asst-msg-1",
			["job-new"],
		);
	});

	it("attaches new file-production jobs from file-production tool aliases", async () => {
		mockGetFileProductionJobs.mockResolvedValue([{ id: "job-new" }]);

		await completeStreamTurn({
			...defaultParams,
			toolCallRecords: [{ name: "File Production", status: "done" }],
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
			toolCallRecords: [{ name: "produce_file", status: "done" }],
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
});
