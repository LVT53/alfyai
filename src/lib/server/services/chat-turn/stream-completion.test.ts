import { describe, expect, it, vi } from "vitest";
import type { ArtifactSummary, ContextDebugState, TaskState } from "$lib/types";
import { getProjectFolderReferenceContext } from "$lib/server/services/task-state";
import { completeStreamTurn } from "./stream-completion";

vi.mock("$lib/server/services/task-state", () => ({
	getProjectFolderReferenceContext: vi.fn(async () => null),
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
	const mockGetProjectFolderReferenceContext =
		getProjectFolderReferenceContext as ReturnType<typeof vi.fn>;

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
		mockGetChatFilesForMsg.mockResolvedValue([]);
		mockGetFileProductionJobs.mockResolvedValue([]);
		mockAssignFileProductionJobs.mockResolvedValue(undefined);
		mockEnqueueChunk.mockReturnValue(true);
		mockEstimateTokenCount.mockReturnValue(100);
		mockGetProjectFolderReferenceContext.mockResolvedValue(null);
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
		serverSegments: [],
		attachmentIds: ["att-1"],
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
		const assistantCreateCall = mockCreateMessage.mock.calls.find(
			(call: unknown[]) => call[1] === "assistant",
		);
		expect(assistantCreateCall?.[2]).toEqual(
			expect.stringContaining("Source check:"),
		);
		expect(mockPersistAssistantTurnState).toHaveBeenCalledWith(
			expect.objectContaining({
				assistantResponse: expect.stringContaining("Source check:"),
			}),
		);
		expect(mockPersistAssistantEvidence).toHaveBeenCalledWith(
			expect.objectContaining({
				assistantResponse: expect.stringContaining("Source check:"),
				webCitationAudit: expect.objectContaining({
					status: "missing_citations",
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

	it("sends SSE event:end with correct payload shape", async () => {
		await completeStreamTurn(defaultParams);

		const endCall = mockEnqueueChunk.mock.calls.find((call: string[]) =>
			call[0]?.startsWith("event: end"),
		);
		expect(endCall).toBeDefined();
		const data = JSON.parse(endCall[0].replace("event: end\ndata: ", ""));
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

		const endCall = mockEnqueueChunk.mock.calls.find((call: string[]) =>
			call[0]?.startsWith("event: end"),
		);
		expect(endCall).toBeDefined();
		const data = JSON.parse(endCall[0].replace("event: end\ndata: ", ""));

		expect(data.activeWorkingSet).toEqual(persistedWorkingSet);
		expect(data.taskState).toEqual(persistedTaskState);
		expect(data.contextDebug).toEqual(persistedContextDebug);
		expect(data.contextSources.groups).toEqual(
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
		mockGetProjectFolderReferenceContext.mockResolvedValueOnce({
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

		const endCall = mockEnqueueChunk.mock.calls.find((call: string[]) =>
			call[0]?.startsWith("event: end"),
		);
		expect(endCall).toBeDefined();
		const data = JSON.parse(endCall[0].replace("event: end\ndata: ", ""));

		expect(mockGetProjectFolderReferenceContext).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
		});
		expect(data.contextSources.groups).toEqual([
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
		mockGetProjectFolderReferenceContext.mockRejectedValueOnce(
			new Error("folder lookup failed"),
		);

		await completeStreamTurn(defaultParams);

		const fallbackEndCall = mockEnqueueChunk.mock.calls.find((call: string[]) =>
			call[0]?.startsWith("event: end"),
		);
		expect(fallbackEndCall).toBeDefined();
		const fallbackData = JSON.parse(
			fallbackEndCall[0].replace("event: end\ndata: ", ""),
		);
		expect(fallbackData.contextSources.groups).toEqual([]);
	});

	it("sets wasStopped to true in the end event when requested", async () => {
		await completeStreamTurn({ ...defaultParams, wasStopped: true });

		const endCall = mockEnqueueChunk.mock.calls.find((call: string[]) =>
			call[0]?.startsWith("event: end"),
		);
		expect(endCall).toBeDefined();
		const data = JSON.parse(endCall[0].replace("event: end\ndata: ", ""));
		expect(data.wasStopped).toBe(true);
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

		expect(mockGetStreamBuffer).toHaveBeenCalledWith("stream-1");
		expect(mockCreateMessage).toHaveBeenCalledWith(
			"conv-1",
			"user",
			"buffered message",
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

	it("handles produced generated files from produce_file tool calls", async () => {
		mockGetFileProductionJobs.mockResolvedValue([
			{ id: "job-new", files: [{ id: "gf-new" }] },
		]);
		mockGetChatFilesForMsg.mockResolvedValue([
			{ id: "gf-new", name: "output.txt" },
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
