import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatFile } from "$lib/server/services/chat-files";
import { getArtifactsForUser } from "$lib/server/services/knowledge";
import { recordMemoryEvent } from "$lib/server/services/memory-events";
import { buildAssistantEvidenceSummary } from "$lib/server/services/message-evidence";
import { commitSkillNoteOperationsAfterAssistantMessage } from "$lib/server/services/skills/notes";
import { applySkillControlOperations } from "$lib/server/services/skills/sessions";
import { getProjectReferenceContext } from "$lib/server/services/task-state";
import { resolveWorkingDocumentSelection } from "$lib/server/services/working-document-selection";
import type { ChatMessage } from "$lib/types";

const {
	mockMirrorMessage,
	mockMirrorWorkCapsuleConclusion,
	mockMemoryIntake,
	mockIsCurrentMemoryResetGeneration,
	mockRefreshConversationSummary,
	mockResolveWorkingDocumentSelection,
	mockRunUserMemoryMaintenance,
} = vi.hoisted(() => ({
	mockMirrorMessage: vi.fn(async () => undefined),
	mockMirrorWorkCapsuleConclusion: vi.fn(async () => undefined),
	mockMemoryIntake: vi.fn(async () => ({ status: "rejected" })),
	mockIsCurrentMemoryResetGeneration: vi.fn(async () => true),
	mockRefreshConversationSummary: vi.fn(async () => undefined),
	mockResolveWorkingDocumentSelection: vi.fn(() => ({
		documentFocused: false,
		currentDocument: null,
		latestGeneratedDocumentIds: [],
		activeFocus: { artifactIds: [] },
		correction: { hasSignal: false, targetArtifactIds: [] },
		recentRefinement: { familyId: null, artifactIds: [] },
		reset: { hasSignal: false, suppressCarryover: false },
		currentTurnReasonCodesByArtifactId: new Map(),
		prompt: { reasonCodesByArtifactId: new Map() },
		workingSet: {
			candidateArtifactIds: [],
			candidateSignalsByArtifactId: new Map(),
		},
		retrieval: {
			preferredArtifactId: null,
			preferredGeneratedFamilyId: null,
			suppressGeneratedCarryover: false,
			hasExplicitResetSignal: false,
		},
		taskEvidence: {
			protectedArtifactIds: [],
			workingDocumentProtectedArtifactIds: [],
		},
	})),
	mockRunUserMemoryMaintenance: vi.fn(async () => undefined),
}));

vi.mock("$lib/server/services/analytics", () => ({
	recordMessageAnalytics: vi.fn(async () => undefined),
}));

vi.mock("$lib/server/services/messages", () => ({
	createMessage: vi.fn(async () => ({ id: "message-1" })),
	updateMessageEvidence: vi.fn(async () => undefined),
	updateMessageHonchoMetadata: vi.fn(async () => undefined),
	updateMessageWebCitationAudit: vi.fn(async () => undefined),
}));

vi.mock("$lib/server/services/conversation-drafts", () => ({
	clearConversationDraft: vi.fn(async () => undefined),
}));

vi.mock("$lib/server/services/conversation-summaries", () => ({
	refreshConversationSummary: mockRefreshConversationSummary,
}));

vi.mock("$lib/server/services/honcho", () => ({
	mirrorMessage: mockMirrorMessage,
	mirrorWorkCapsuleConclusion: mockMirrorWorkCapsuleConclusion,
}));

vi.mock("$lib/server/services/knowledge", () => ({
	attachArtifactsToMessage: vi.fn(async () => undefined),
	createGeneratedOutputArtifact: vi.fn(async () => null),
	getArtifactsForUser: vi.fn(async () => []),
	getConversationWorkingSet: vi.fn(async () => []),
	listConversationSourceArtifactIds: vi.fn(async () => []),
	refreshConversationWorkingSet: vi.fn(async () => []),
	upsertWorkCapsule: vi.fn(async () => null),
}));

vi.mock("$lib/server/services/knowledge/store", () => ({
	parseWorkingDocumentMetadata: vi.fn(() => ({})),
}));

vi.mock("$lib/server/services/memory-events", () => ({
	recordMemoryEvent: vi.fn(async () => undefined),
}));

vi.mock("$lib/server/services/memory-maintenance", () => ({
	runUserMemoryMaintenance: mockRunUserMemoryMaintenance,
}));

vi.mock("$lib/server/services/memory-profile", () => ({
	isCurrentMemoryResetGeneration: mockIsCurrentMemoryResetGeneration,
}));

vi.mock("$lib/server/services/memory-profile/intake", () => ({
	intakePostTurnMemory: mockMemoryIntake,
}));

vi.mock("$lib/server/services/message-evidence", () => ({
	buildAssistantEvidenceSummary: vi.fn(async () => null),
}));

vi.mock("$lib/server/services/skills/notes", () => ({
	commitSkillNoteOperationsAfterAssistantMessage: vi.fn(async () => null),
}));

vi.mock("$lib/server/services/skills/sessions", () => ({
	applySkillControlOperations: vi.fn(async () => null),
}));

vi.mock("$lib/server/services/task-state", () => ({
	applyProjectContinuitySignalFromMessage: vi.fn(async () => undefined),
	attachContinuityToTaskState: vi.fn(async (_userId, taskState) => taskState),
	getContextDebugState: vi.fn(async () => null),
	getConversationTaskState: vi.fn(async () => null),
	getProjectReferenceContext: vi.fn(async () => null),
	syncTaskContinuityFromTaskState: vi.fn(async () => undefined),
	updateTaskStateCheckpoint: vi.fn(async () => null),
}));

vi.mock("$lib/server/services/web-citation-audit", () => ({
	buildWebCitationAudit: vi.fn(() => null),
}));

vi.mock("$lib/server/services/working-document-selection", () => ({
	resolveWorkingDocumentSelection: mockResolveWorkingDocumentSelection,
}));

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

function makeChatFile(params: {
	id: string;
	conversationId: string;
	assistantMessageId: string;
	artifactId: string;
	filename: string;
	mimeType: string;
	sizeBytes: number;
	createdAt: number;
}): ChatFile {
	return {
		...params,
		userId: "user-1",
		storagePath: "/tmp/generated/report.pdf",
		documentFamilyId: null,
		documentFamilyStatus: null,
		documentLabel: null,
		documentRole: null,
		versionNumber: null,
		originConversationId: null,
		originAssistantMessageId: null,
		sourceChatFileId: null,
	};
}

describe("runPostTurnTasks", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockIsCurrentMemoryResetGeneration.mockResolvedValue(true);
	});

	it("logs summary refresh failures without rejecting post-turn tasks", async () => {
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		mockRefreshConversationSummary.mockRejectedValueOnce(
			new Error("summary offline"),
		);
		const { runPostTurnTasks } = await import("./finalize");

		await expect(
			runPostTurnTasks({
				logPrefix: "[SEND]",
				userId: "user-1",
				conversationId: "conv-1",
				upstreamMessage: "upstream prompt payload",
				userMessage: "normalized user message",
				assistantResponse: "visible assistant response",
				assistantMirrorContent: "assistant mirror text",
				maintenanceReason: "chat_send",
			}),
		).resolves.toBeUndefined();

		expect(mockRefreshConversationSummary).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			userMessage: "normalized user message",
			assistantResponse: "visible assistant response",
		});
		expect(mockRunUserMemoryMaintenance).toHaveBeenCalledWith(
			"user-1",
			"chat_send",
		);
		expect(errorSpy).toHaveBeenCalledWith(
			"[SEND] Conversation summary refresh failed:",
			expect.any(Error),
		);

		errorSpy.mockRestore();
	});

	it("routes user and assistant post-turn text through memory intake without raw Honcho transcript mirroring", async () => {
		const { runPostTurnTasks } = await import("./finalize");

		await runPostTurnTasks({
			logPrefix: "[SEND]",
			userId: "user-1",
			conversationId: "conv-1",
			upstreamMessage: "upstream prompt payload",
			userMessage: "Please remember that I prefer concise answers.",
			userMessageId: "user-message-1",
			assistantResponse: "I will keep that in mind.",
			assistantMirrorContent: "assistant mirror text",
			assistantMessageId: "assistant-message-1",
			workCapsule: {
				workflowSummary: "Finished the brief.",
				taskSummary: "Brief update",
				artifact: { name: "brief.md" },
			},
			maintenanceReason: "chat_send",
		});

		expect(mockMemoryIntake).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				conversationId: "conv-1",
				userMessage: "Please remember that I prefer concise answers.",
				assistantMessage: "assistant mirror text",
				userMessageId: "user-message-1",
				assistantMessageId: "assistant-message-1",
			}),
		);
		expect(mockMirrorMessage).not.toHaveBeenCalled();
		expect(mockMirrorWorkCapsuleConclusion).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			content: "Brief update\nFinished the brief.",
		});
		expect(mockRefreshConversationSummary).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			userMessage: "Please remember that I prefer concise answers.",
			assistantResponse: "I will keep that in mind.",
		});
		expect(mockRunUserMemoryMaintenance).toHaveBeenCalledWith(
			"user-1",
			"chat_send",
		);
	});

	it("passes the started reset generation to intake and skips work-capsule mirroring after reset", async () => {
		mockIsCurrentMemoryResetGeneration.mockResolvedValueOnce(false);
		const { runPostTurnTasks } = await import("./finalize");

		await runPostTurnTasks({
			logPrefix: "[SEND]",
			userId: "user-1",
			conversationId: "conv-1",
			upstreamMessage: "upstream prompt payload",
			userMessage: "Please remember that I prefer concise answers.",
			userMessageId: "user-message-1",
			assistantResponse: "I will keep that in mind.",
			assistantMirrorContent: "assistant mirror text",
			assistantMessageId: "assistant-message-1",
			workCapsule: {
				workflowSummary: "Finished the brief.",
				taskSummary: "Brief update",
				artifact: { name: "brief.md" },
			},
			maintenanceReason: "chat_send",
			startedResetGeneration: 7,
		});

		expect(mockMemoryIntake).toHaveBeenCalledWith(
			expect.objectContaining({
				startedResetGeneration: 7,
			}),
		);
		expect(mockIsCurrentMemoryResetGeneration).toHaveBeenCalledWith({
			userId: "user-1",
			resetGeneration: 7,
		});
		expect(mockMirrorWorkCapsuleConclusion).not.toHaveBeenCalled();
		expect(mockRunUserMemoryMaintenance).toHaveBeenCalledWith(
			"user-1",
			"chat_send",
		);
	});
});

describe("finalizeChatTurn", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("reconciles new generated outputs during turn completion", async () => {
		const createMessage = vi.fn(
			async (
				_conversationId: string,
				role: "user" | "assistant",
			): Promise<ChatMessage> =>
				makeChatMessage(
					`${role}-message`,
					role,
					role === "user" ? "user message" : "assistant response",
				),
		);
		const persistAssistantTurnState = vi.fn(async () => ({
			activeWorkingSet: [],
			taskState: null,
			contextDebug: null,
			workCapsule: {} as unknown as undefined,
		}));
		const assignGeneratedOutputJobs = vi.fn(async () => undefined);
		const syncGeneratedFilesToMemory = vi.fn(async () => undefined);
		const getGeneratedFilesForAssistantMessage = vi.fn(async () => [
			makeChatFile({
				id: "file-new",
				conversationId: "conv-1",
				assistantMessageId: "assistant-message",
				artifactId: "artifact-generated",
				filename: "report.pdf",
				mimeType: "application/pdf",
				sizeBytes: 456,
				createdAt: 1_777_140_200,
			}),
		]);
		const { finalizeChatTurn } = await import("./finalize");

		const completion = await finalizeChatTurn({
			logPrefix: "[SEND]",
			userId: "user-1",
			conversationId: "conv-1",
			userMessageContent: "Create a report",
			persistUserMessage: true,
			normalizedMessage: "Create a report",
			upstreamMessage: "Create a report",
			assistantResponse: "Done.",
			assistantMetadata: { evidenceStatus: "pending" },
			skillControlOperations: [],
			skillControlSessionId: null,
			attachmentIds: [],
			activeDocumentArtifactId: null,
			contextStatus: null,
			initialTaskState: null,
			initialContextDebug: null,
			analytics: {
				model: "model-1",
				modelDisplayName: "Model One",
				promptTokens: 8,
				completionTokens: 2,
				generationTimeMs: undefined,
				providerUsage: null,
			},
			continuitySource: "send",
			honchoContext: null,
			honchoSnapshot: null,
			assistantMirrorContent: "Done.",
			maintenanceReason: "chat_send",
			createMessage,
			persistAssistantTurnState,
			generatedOutputReconciliation: {
				fileProductionJobIdsAtStart: new Set(["job-existing"]),
				getFileProductionJobs: vi.fn(async () => [
					{ id: "job-existing", files: [{ id: "file-existing" }] },
					{ id: "job-new", files: [{ id: "file-new" }] },
				]),
				assignFileProductionJobsToAssistantMessage: assignGeneratedOutputJobs,
				syncGeneratedFilesToMemory,
				getChatFilesForAssistantMessage: getGeneratedFilesForAssistantMessage,
			},
		});

		expect(assignGeneratedOutputJobs).toHaveBeenCalledWith(
			"user-1",
			"conv-1",
			"assistant-message",
			["job-new"],
		);
		expect(syncGeneratedFilesToMemory).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-message",
			fileIds: ["file-new"],
			assistantResponse: "Done.",
		});
		expect(completion.generatedFiles).toEqual([
			expect.objectContaining({
				id: "file-new",
				assistantMessageId: "assistant-message",
				filename: "report.pdf",
			}),
		]);
	});

	it("persists completed control-only turns with empty visible assistant text", async () => {
		const createMessage = vi.fn(
			async (
				_conversationId: string,
				role: "user" | "assistant",
			): Promise<ChatMessage> =>
				makeChatMessage(
					`${role}-message`,
					role,
					role === "user" ? "normalized user message" : "",
				),
		);
		const persistAssistantTurnState = vi.fn(async () => ({
			activeWorkingSet: [],
			taskState: null,
			contextDebug: null,
			workCapsule: {} as unknown as undefined,
		}));
		const mockApplySkillControlOperations =
			applySkillControlOperations as ReturnType<typeof vi.fn>;
		const { finalizeChatTurn } = await import("./finalize");

		const completion = await finalizeChatTurn({
			logPrefix: "[SEND]",
			userId: "user-1",
			conversationId: "conv-1",
			userMessageContent: "normalized user message",
			persistUserMessage: true,
			normalizedMessage: "normalized user message",
			upstreamMessage: "upstream prompt payload",
			assistantResponse: "",
			assistantMetadata: {
				evidenceStatus: "pending",
				skillQuestion: true,
			},
			skillControlOperations: [
				{
					operationId: "control-only-question",
					kind: "session_transition",
					transition: "awaiting_user",
				} as never,
			],
			skillControlSessionId: "session-1",
			attachmentIds: [],
			activeDocumentArtifactId: null,
			contextStatus: null,
			initialTaskState: null,
			initialContextDebug: null,
			analytics: {
				model: "model-1",
				modelDisplayName: "Model One",
				promptTokens: 8,
				completionTokens: 0,
				generationTimeMs: undefined,
				providerUsage: null,
			},
			continuitySource: "send",
			honchoContext: null,
			honchoSnapshot: null,
			assistantMirrorContent: "",
			maintenanceReason: "chat_send",
			createMessage,
			persistAssistantTurnState,
		});

		expect(completion.assistantMessage).toEqual(
			expect.objectContaining({
				id: "assistant-message",
				role: "assistant",
				content: "",
			}),
		);
		expect(createMessage).toHaveBeenCalledWith(
			"conv-1",
			"assistant",
			"",
			undefined,
			undefined,
			expect.objectContaining({ skillQuestion: true }),
		);
		expect(mockApplySkillControlOperations).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-message",
			operations: [
				expect.objectContaining({ operationId: "control-only-question" }),
			],
		});
		expect(persistAssistantTurnState).toHaveBeenCalledWith(
			expect.objectContaining({
				assistantMessageId: "assistant-message",
				assistantResponse: "",
			}),
		);
	});

	it("includes streamId in skill control warnings when present", async () => {
		const warnSpy = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);
		const mockCommitSkillNoteOperations =
			commitSkillNoteOperationsAfterAssistantMessage as ReturnType<
				typeof vi.fn
			>;
		const mockApplySkillControlOperations =
			applySkillControlOperations as ReturnType<typeof vi.fn>;
		mockCommitSkillNoteOperations.mockRejectedValueOnce(
			new Error("notes offline"),
		);
		mockApplySkillControlOperations.mockRejectedValueOnce(
			new Error("sessions offline"),
		);
		const { finalizeChatTurn } = await import("./finalize");

		await finalizeChatTurn({
			logPrefix: "[STREAM]",
			streamId: "stream-1",
			userId: "user-1",
			conversationId: "conv-1",
			userMessageContent: "normalized user message",
			persistUserMessage: true,
			normalizedMessage: "normalized user message",
			upstreamMessage: "upstream prompt payload",
			assistantResponse: "visible assistant response",
			assistantMetadata: { evidenceStatus: "pending" },
			skillControlOperations: [{ operationId: "op-1" } as never],
			skillControlSessionId: null,
			attachmentIds: [],
			activeDocumentArtifactId: null,
			contextStatus: null,
			initialTaskState: null,
			initialContextDebug: null,
			analytics: {
				model: "model-1",
				modelDisplayName: "Model One",
				promptTokens: 8,
				completionTokens: 5,
				generationTimeMs: undefined,
				providerUsage: null,
			},
			continuitySource: "stream",
			honchoContext: null,
			honchoSnapshot: null,
			assistantMirrorContent: "assistant mirror text",
			maintenanceReason: "chat_stream",
			persistenceMode: "best_effort",
			persistUserAttachmentsBeforeAssistantMessage: false,
		});

		expect(warnSpy).toHaveBeenCalledWith(
			"[STREAM] Failed to apply Skill Note Operations",
			expect.objectContaining({
				streamId: "stream-1",
				conversationId: "conv-1",
			}),
		);
		expect(warnSpy).toHaveBeenCalledWith(
			"[STREAM] Failed to apply Skill Control Envelope",
			expect.objectContaining({
				streamId: "stream-1",
				conversationId: "conv-1",
			}),
		);
		warnSpy.mockRestore();
	});

	it("creates the assistant message before attachment persistence in stream mode", async () => {
		const callOrder: string[] = [];
		const createMessage = vi.fn(
			async (
				_conversationId: string,
				role: "user" | "assistant",
			): Promise<ChatMessage> => {
				callOrder.push(`${role}:create`);
				return makeChatMessage(
					`${role}-message`,
					role,
					role === "user"
						? "normalized user message"
						: "visible assistant response",
				);
			},
		);
		const persistUserTurnAttachments = vi.fn(async () => {
			callOrder.push("attachments:persist");
			return [];
		});
		const persistAssistantTurnState = vi.fn(async () => ({
			activeWorkingSet: [],
			taskState: null,
			contextDebug: null,
			workCapsule: {} as unknown as undefined,
		}));
		const { finalizeChatTurn } = await import("./finalize");

		await finalizeChatTurn({
			logPrefix: "[STREAM]",
			userId: "user-1",
			conversationId: "conv-1",
			userMessageContent: "normalized user message",
			persistUserMessage: true,
			normalizedMessage: "normalized user message",
			upstreamMessage: "upstream prompt payload",
			assistantResponse: "visible assistant response",
			assistantMetadata: { evidenceStatus: "pending" },
			skillControlOperations: [],
			skillControlSessionId: null,
			attachmentIds: ["att-1"],
			activeDocumentArtifactId: null,
			contextStatus: null,
			initialTaskState: null,
			initialContextDebug: null,
			analytics: {
				model: "model-1",
				modelDisplayName: "Model One",
				promptTokens: 8,
				completionTokens: 5,
				generationTimeMs: undefined,
				providerUsage: null,
			},
			continuitySource: "stream",
			honchoContext: null,
			honchoSnapshot: null,
			assistantMirrorContent: "assistant mirror text",
			maintenanceReason: "chat_stream",
			persistenceMode: "best_effort",
			persistUserAttachmentsBeforeAssistantMessage: false,
			createMessage,
			persistUserTurnAttachments,
			persistAssistantTurnState,
		});

		expect(callOrder).toEqual([
			"user:create",
			"assistant:create",
			"attachments:persist",
		]);
	});

	it("adds baseline Depth Metadata when persisting a completed assistant message", async () => {
		const createMessage = vi.fn(
			async (
				_conversationId: string,
				role: "user" | "assistant",
			): Promise<ChatMessage> =>
				makeChatMessage(
					`${role}-message`,
					role,
					role === "user"
						? "normalized user message"
						: "visible assistant response",
				),
		);
		const persistAssistantTurnState = vi.fn(async () => ({
			activeWorkingSet: [],
			taskState: null,
			contextDebug: null,
			workCapsule: {} as unknown as undefined,
		}));
		const { finalizeChatTurn } = await import("./finalize");

		await finalizeChatTurn({
			logPrefix: "[SEND]",
			userId: "user-1",
			conversationId: "conv-1",
			userMessageContent: "normalized user message",
			persistUserMessage: true,
			normalizedMessage: "normalized user message",
			upstreamMessage: "upstream prompt payload",
			assistantResponse: "visible assistant response",
			assistantMetadata: {
				evidenceStatus: "pending",
				modelDisplayName: "Model One",
			},
			reasoningDepth: "max",
			skillControlOperations: [],
			skillControlSessionId: null,
			attachmentIds: [],
			activeDocumentArtifactId: null,
			contextStatus: null,
			initialTaskState: null,
			initialContextDebug: null,
			analytics: {
				model: "provider:local:model-a",
				modelDisplayName: "Model One",
				promptTokens: 8,
				completionTokens: 5,
				generationTimeMs: undefined,
				providerUsage: null,
			},
			continuitySource: "send",
			honchoContext: null,
			honchoSnapshot: null,
			assistantMirrorContent: "assistant mirror text",
			maintenanceReason: "chat_send",
			createMessage,
			persistAssistantTurnState,
		});

		expect(createMessage).toHaveBeenCalledWith(
			"conv-1",
			"assistant",
			"visible assistant response",
			undefined,
			undefined,
			expect.objectContaining({
				depthMetadata: {
					requested: "max",
					appliedProfile: "maximum",
					fallback: false,
					modelId: "provider:local:model-a",
					modelDisplayName: "Model One",
				},
			}),
		);
	});

	it("persists resolved Auto Depth Metadata from preflight instead of rebuilding the baseline", async () => {
		const createMessage = vi.fn(
			async (
				_conversationId: string,
				role: "user" | "assistant",
			): Promise<ChatMessage> =>
				makeChatMessage(
					`${role}-message`,
					role,
					role === "user"
						? "normalized user message"
						: "visible assistant response",
				),
		);
		const persistAssistantTurnState = vi.fn(async () => ({
			activeWorkingSet: [],
			taskState: null,
			contextDebug: null,
			workCapsule: {} as unknown as undefined,
		}));
		const { finalizeChatTurn } = await import("./finalize");

		await finalizeChatTurn({
			logPrefix: "[SEND]",
			userId: "user-1",
			conversationId: "conv-1",
			userMessageContent: "normalized user message",
			persistUserMessage: true,
			normalizedMessage: "normalized user message",
			upstreamMessage: "upstream prompt payload",
			assistantResponse: "visible assistant response",
			assistantMetadata: {
				evidenceStatus: "pending",
				modelDisplayName: "Provider Model A",
				providerDisplayName: "Provider One",
			},
			reasoningDepth: "auto",
			depthMetadata: {
				requested: "auto",
				appliedProfile: "extended",
				fallback: false,
				classifierSource: "control_model",
				modelId: "model1",
				modelDisplayName: "Model One",
			},
			skillControlOperations: [],
			skillControlSessionId: null,
			attachmentIds: [],
			activeDocumentArtifactId: null,
			contextStatus: null,
			initialTaskState: null,
			initialContextDebug: null,
			analytics: {
				model: "provider:local:model-a",
				modelDisplayName: "Provider Model A",
				promptTokens: 8,
				completionTokens: 5,
				generationTimeMs: undefined,
				providerUsage: null,
			},
			continuitySource: "send",
			honchoContext: null,
			honchoSnapshot: null,
			assistantMirrorContent: "assistant mirror text",
			maintenanceReason: "chat_send",
			createMessage,
			persistAssistantTurnState,
		});

		expect(createMessage).toHaveBeenCalledWith(
			"conv-1",
			"assistant",
			"visible assistant response",
			undefined,
			undefined,
			expect.objectContaining({
				depthMetadata: {
					requested: "auto",
					appliedProfile: "extended",
					fallback: false,
					classifierSource: "control_model",
					modelId: "provider:local:model-a",
					modelDisplayName: "Provider Model A",
					providerDisplayName: "Provider One",
				},
			}),
		);
	});

	it("swallows attachment persistence failures in stream mode", async () => {
		const createMessage = vi.fn(
			async (
				_conversationId: string,
				role: "user" | "assistant",
			): Promise<ChatMessage> =>
				makeChatMessage(
					`${role}-message`,
					role,
					role === "user"
						? "normalized user message"
						: "visible assistant response",
				),
		);
		const persistUserTurnAttachments = vi.fn(async () => {
			throw new Error("attachment offline");
		});
		const persistAssistantTurnState = vi.fn(async () => ({
			activeWorkingSet: [],
			taskState: null,
			contextDebug: null,
			workCapsule: {} as unknown as undefined,
		}));
		const { finalizeChatTurn } = await import("./finalize");

		const completion = await finalizeChatTurn({
			logPrefix: "[STREAM]",
			userId: "user-1",
			conversationId: "conv-1",
			userMessageContent: "normalized user message",
			persistUserMessage: true,
			normalizedMessage: "normalized user message",
			upstreamMessage: "upstream prompt payload",
			assistantResponse: "visible assistant response",
			assistantMetadata: { evidenceStatus: "pending" },
			skillControlOperations: [],
			skillControlSessionId: null,
			attachmentIds: ["att-1"],
			activeDocumentArtifactId: null,
			contextStatus: null,
			initialTaskState: null,
			initialContextDebug: null,
			analytics: {
				model: "model-1",
				modelDisplayName: "Model One",
				promptTokens: 8,
				completionTokens: 5,
				generationTimeMs: undefined,
				providerUsage: null,
			},
			continuitySource: "stream",
			honchoContext: null,
			honchoSnapshot: null,
			assistantMirrorContent: "assistant mirror text",
			maintenanceReason: "chat_stream",
			persistenceMode: "best_effort",
			persistUserAttachmentsBeforeAssistantMessage: false,
			createMessage,
			persistUserTurnAttachments,
			persistAssistantTurnState,
		});

		await expect(completion.attachmentTask).resolves.toBeUndefined();
	});

	it("returns the durable completion result while the follow-up work runs in the background", async () => {
		const evidenceDeferred = (() => {
			let resolve!: () => void;
			const promise = new Promise<void>((res) => {
				resolve = res;
			});
			return { promise, resolve };
		})();
		const mockBuildAssistantEvidenceSummary =
			buildAssistantEvidenceSummary as ReturnType<typeof vi.fn>;
		mockBuildAssistantEvidenceSummary.mockImplementationOnce(
			async () => evidenceDeferred.promise,
		);
		const { finalizeChatTurn } = await import("./finalize");

		const postTurnDeferred = (() => {
			let resolve!: () => void;
			const promise = new Promise<void>((res) => {
				resolve = res;
			});
			return { promise, resolve };
		})();
		const mockPersistAssistantEvidence = vi.fn(
			async () => evidenceDeferred.promise,
		);
		const mockRunPostTurnTasks = vi.fn(async () => postTurnDeferred.promise);
		const completion = await finalizeChatTurn({
			logPrefix: "[SEND]",
			userId: "user-1",
			conversationId: "conv-1",
			userMessageContent: "normalized user message",
			persistUserMessage: true,
			normalizedMessage: "normalized user message",
			upstreamMessage: "upstream prompt payload",
			assistantResponse: "visible assistant response",
			assistantMetadata: {
				evidenceStatus: "pending",
				modelDisplayName: "Model One",
			},
			skillControlOperations: [],
			skillControlSessionId: null,
			attachmentIds: [],
			activeDocumentArtifactId: null,
			contextStatus: null,
			initialTaskState: null,
			initialContextDebug: null,
			analytics: {
				model: "model-1",
				modelDisplayName: "Model One",
				promptTokens: 8,
				completionTokens: 5,
				generationTimeMs: undefined,
				providerUsage: null,
			},
			continuitySource: "send",
			honchoContext: null,
			honchoSnapshot: null,
			assistantMirrorContent: "assistant mirror text",
			maintenanceReason: "chat_send",
			waitForEvidenceBeforePostTurnTasks: false,
			persistAssistantEvidence: mockPersistAssistantEvidence,
			runPostTurnTasks: mockRunPostTurnTasks,
		});

		expect(completion.userMessage).toEqual({ id: "message-1" });
		expect(completion.assistantMessage).toEqual({ id: "message-1" });
		expect(mockRunUserMemoryMaintenance).not.toHaveBeenCalled();

		const postTurnTask = completion.createPostTurnTask();
		expect(mockPersistAssistantEvidence).toHaveBeenCalledTimes(1);
		expect(mockRunPostTurnTasks).toHaveBeenCalledTimes(1);
		evidenceDeferred.resolve();
		postTurnDeferred.resolve();
		await postTurnTask;
	});

	it("returns context sources assembled by the completion boundary", async () => {
		const mockGetProjectReferenceContext =
			getProjectReferenceContext as ReturnType<typeof vi.fn>;
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
		const persistAssistantTurnState = vi.fn(async () => ({
			activeWorkingSet: [
				{
					id: "working-1",
					type: "generated_output",
					name: "Working output",
					mimeType: null,
					sizeBytes: null,
					conversationId: "conv-1",
					summary: null,
					createdAt: 0,
					updatedAt: 0,
				},
			],
			taskState: null,
			contextDebug: null,
			workCapsule: {} as unknown as undefined,
		}));
		const { finalizeChatTurn } = await import("./finalize");

		const completion = await finalizeChatTurn({
			logPrefix: "[SEND]",
			userId: "user-1",
			conversationId: "conv-1",
			userMessageContent: "normalized user message",
			persistUserMessage: true,
			normalizedMessage: "normalized user message",
			upstreamMessage: "upstream prompt payload",
			assistantResponse: "visible assistant response",
			assistantMetadata: {
				evidenceStatus: "pending",
				modelDisplayName: "Model One",
			},
			skillControlOperations: [],
			skillControlSessionId: null,
			attachmentIds: [],
			activeDocumentArtifactId: null,
			contextStatus: null,
			initialTaskState: null,
			initialContextDebug: null,
			analytics: {
				model: "model-1",
				modelDisplayName: "Model One",
				promptTokens: 8,
				completionTokens: 5,
				generationTimeMs: undefined,
				providerUsage: null,
			},
			continuitySource: "send",
			honchoContext: null,
			honchoSnapshot: null,
			assistantMirrorContent: "assistant mirror text",
			maintenanceReason: "chat_send",
			linkedSources: [
				{
					displayArtifactId: "display-1",
					promptArtifactId: "prompt-1",
					familyArtifactIds: [],
					name: "Linked source.pdf",
					type: "document",
					documentOrigin: "uploaded",
				},
			],
			persistAssistantTurnState,
		});

		expect(completion.contextSources.groups).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "linked_source",
					items: [
						expect.objectContaining({
							artifactId: "display-1",
							title: "Linked source.pdf",
						}),
					],
				}),
				expect.objectContaining({
					kind: "working_set",
					items: [
						expect.objectContaining({
							artifactId: "working-1",
							title: "Working output",
						}),
					],
				}),
				expect.objectContaining({
					kind: "project_folder",
					items: [
						expect.objectContaining({
							title: "Launch folder",
						}),
					],
				}),
			]),
		);
	});

	it("records document refinement correction from Working Document Selection", async () => {
		const mockGetArtifactsForUser = getArtifactsForUser as ReturnType<
			typeof vi.fn
		>;
		const mockRecordMemoryEvent = recordMemoryEvent as ReturnType<typeof vi.fn>;
		const mockResolveSelection = resolveWorkingDocumentSelection as ReturnType<
			typeof vi.fn
		>;
		mockGetArtifactsForUser.mockResolvedValueOnce([
			{
				id: "brief-v1",
				userId: "user-1",
				type: "generated_output",
				retrievalClass: "durable",
				name: "brief-v1.pdf",
				mimeType: "application/pdf",
				sizeBytes: 100,
				conversationId: "conv-1",
				summary: null,
				createdAt: 1,
				updatedAt: 1,
				extension: "pdf",
				storagePath: null,
				contentText: null,
				metadata: {
					documentFamilyId: "family-brief",
					documentLabel: "Project brief",
				},
			},
		]);
		mockResolveSelection.mockReturnValueOnce({
			documentFocused: true,
			currentDocument: {
				artifactId: "brief-v1",
				familyId: "family-brief",
				reasonCodes: ["recent_user_correction"],
				source: "active_focus",
			},
			latestGeneratedDocumentIds: [],
			activeFocus: { artifactIds: ["brief-v1"] },
			correction: { hasSignal: true, targetArtifactIds: ["brief-v1"] },
			recentRefinement: { familyId: null, artifactIds: [] },
			reset: { hasSignal: false, suppressCarryover: false },
			currentTurnReasonCodesByArtifactId: new Map([
				["brief-v1", ["recent_user_correction"]],
			]),
			prompt: {
				reasonCodesByArtifactId: new Map([
					["brief-v1", ["recent_user_correction"]],
				]),
			},
			workingSet: {
				candidateArtifactIds: ["brief-v1"],
				candidateSignalsByArtifactId: new Map(),
			},
			retrieval: {
				preferredArtifactId: "brief-v1",
				preferredGeneratedFamilyId: null,
				suppressGeneratedCarryover: false,
				hasExplicitResetSignal: false,
			},
			taskEvidence: {
				protectedArtifactIds: ["brief-v1"],
				workingDocumentProtectedArtifactIds: ["brief-v1"],
			},
		});
		const { persistAssistantTurnState } = await import("./finalize");

		await persistAssistantTurnState({
			userId: "user-1",
			conversationId: "conv-1",
			normalizedMessage: "Please use the alternate tone.",
			assistantResponse: "Updated brief.",
			attachmentIds: [],
			activeDocumentArtifactId: "brief-v1",
			contextStatus: null,
			initialTaskState: null,
			initialContextDebug: null,
			userMessageId: "user-message-1",
			assistantMessageId: "assistant-message-1",
			analytics: null,
			continuitySource: "send",
			honchoContext: null,
			honchoSnapshot: null,
		});

		expect(mockRecordMemoryEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				eventType: "document_refined",
				payload: expect.objectContaining({
					explicitCorrection: true,
				}),
			}),
		);
	});

	it("does not record document refinement when Working Document Selection ignores a stale active document", async () => {
		const mockGetArtifactsForUser = getArtifactsForUser as ReturnType<
			typeof vi.fn
		>;
		const mockRecordMemoryEvent = recordMemoryEvent as ReturnType<typeof vi.fn>;
		mockGetArtifactsForUser.mockResolvedValueOnce([
			{
				id: "brief-v1",
				userId: "user-1",
				type: "generated_output",
				retrievalClass: "durable",
				name: "brief-v1.pdf",
				mimeType: "application/pdf",
				sizeBytes: 100,
				conversationId: "conv-1",
				summary: null,
				createdAt: 1,
				updatedAt: 1,
				extension: "pdf",
				storagePath: null,
				contentText: null,
				metadata: {
					documentFamilyId: "family-brief",
					documentLabel: "Project brief",
				},
			},
		]);
		const { persistAssistantTurnState } = await import("./finalize");

		await persistAssistantTurnState({
			userId: "user-1",
			conversationId: "conv-1",
			normalizedMessage: "What is the capital of France?",
			assistantResponse: "Paris.",
			attachmentIds: [],
			activeDocumentArtifactId: "brief-v1",
			contextStatus: null,
			initialTaskState: null,
			initialContextDebug: null,
			userMessageId: "user-message-1",
			assistantMessageId: "assistant-message-1",
			analytics: null,
			continuitySource: "send",
			honchoContext: null,
			honchoSnapshot: null,
		});

		expect(mockRecordMemoryEvent).not.toHaveBeenCalled();
	});
});
