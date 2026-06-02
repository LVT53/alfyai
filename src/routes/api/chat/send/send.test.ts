import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/conversations", () => ({
	getConversation: vi.fn(),
	touchConversation: vi.fn(),
}));

vi.mock("$lib/server/services/chat-turn/plain-normal-chat-model-run", () => ({
	runPlainNormalChatSendModel: vi.fn(),
}));

vi.mock("$lib/server/services/file-production", () => ({
	assignFileProductionJobsToAssistantMessage: vi.fn(async () => undefined),
	listConversationFileProductionJobs: vi.fn(async () => []),
}));

vi.mock("$lib/server/services/chat-files", () => ({
	getChatFilesForAssistantMessage: vi.fn(async () => []),
	syncGeneratedFilesToMemory: vi.fn(async () => undefined),
}));

vi.mock("$lib/server/services/deep-research", () => ({
	assertCanStartDeepResearchJob: vi.fn(),
	isDeepResearchJobStartError: vi.fn(
		(error: unknown) =>
			typeof error === "object" &&
			error !== null &&
			"name" in error &&
			error.name === "DeepResearchJobStartError",
	),
	startDeepResearchJobShell: vi.fn(),
}));

vi.mock("$lib/server/services/deep-research/planning-context", () => ({
	buildDeepResearchPlanningContext: vi.fn(),
}));

vi.mock("$lib/server/services/messages", () => ({
	createMessage: vi.fn(),
	updateMessageEvidence: vi.fn(async () => undefined),
	updateMessageHonchoMetadata: vi.fn(async () => undefined),
	updateMessageWebCitationAudit: vi.fn(async () => undefined),
}));

vi.mock("$lib/server/services/knowledge", () => ({
	assertPromptReadyAttachments: vi.fn(async () => ({
		displayArtifacts: [],
		promptArtifacts: [],
	})),
	attachArtifactsToMessage: vi.fn(),
	createGeneratedOutputArtifact: vi.fn(),
	getConversationWorkingSet: vi.fn(async () => []),
	getArtifactsForUser: vi.fn(async () => []),
	isAttachmentReadinessError: vi.fn((error: unknown) => {
		return (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error as { code?: unknown }).code === "attachment_not_ready"
		);
	}),
	listConversationSourceArtifactIds: vi.fn(async () => []),
	refreshConversationWorkingSet: vi.fn(async () => []),
	upsertWorkCapsule: vi.fn(async () => null),
}));

vi.mock("$lib/server/services/linked-context-sources", () => ({
	addConversationLinkedContextSources: vi.fn(async () => []),
	isLinkedContextSourceError: vi.fn(() => false),
}));

vi.mock("$lib/server/services/skills/user-skills", () => ({
	getAvailableSkillDefinition: vi.fn(async () => ({
		id: "skill-1",
		ownership: "user",
		displayName: "Interview coach",
		description: "Asks useful questions.",
		instructions: "Ask one concise follow-up before answering.",
		activationExamples: ["interview me first"],
		enabled: true,
		durationPolicy: "next_message",
		questionPolicy: "ask_when_needed",
		notesPolicy: "none",
		sourceScope: "selected_sources_only",
		creationSource: "user_created",
		version: 1,
		createdAt: 1,
		updatedAt: 2,
	})),
	getAvailableSkillSummary: vi.fn(async () => ({
		id: "skill-1",
		ownership: "user",
		displayName: "Interview coach",
	})),
	resolveEffectiveSkillDefinition: vi.fn(async () => ({
		available: true,
		availabilityReason: "available",
		id: "skill-1",
		ownership: "user",
		skillKind: "user_skill",
		displayName: "Interview coach",
		description: "Asks useful questions.",
		effectiveInstructions: "Ask one concise follow-up before answering.",
		effectiveInstructionsHash: "test-hash",
		publicSummary: {
			id: "skill-1",
			ownership: "user",
			skillKind: "user_skill",
			baseSkillId: null,
			baseSkillVersion: null,
			displayName: "Interview coach",
			description: "Asks useful questions.",
			activationExamples: ["interview me first"],
			enabled: true,
			durationPolicy: "next_message",
			questionPolicy: "ask_when_needed",
			notesPolicy: "none",
			sourceScope: "selected_sources_only",
			creationSource: "user_created",
			version: 1,
			createdAt: 1,
			updatedAt: 2,
		},
		durationPolicy: "next_message",
		questionPolicy: "ask_when_needed",
		notesPolicy: "none",
		sourceScope: "selected_sources_only",
		sourceIds: {
			skillId: "skill-1",
			skillVersion: 1,
			packSkillId: null,
			packSkillVersion: null,
			variantSkillId: null,
			variantSkillVersion: null,
		},
	})),
}));

vi.mock("$lib/server/services/skills/sessions", () => ({
	applySkillControlOperations: vi.fn(async () => null),
	getActiveSkillSession: vi.fn(async () => null),
	startSkillSession: vi.fn(async () => null),
}));

vi.mock("$lib/server/services/skills/notes", () => ({
	commitSkillNoteOperationsAfterAssistantMessage: vi.fn(async () => null),
}));

vi.mock("$lib/server/services/task-state", () => ({
	attachContinuityToTaskState: vi.fn(
		async (_userId: string, taskState: unknown) => taskState,
	),
	getContextDebugState: vi.fn(async () => null),
	getConversationTaskState: vi.fn(async () => null),
	getProjectReferenceContext: vi.fn(async () => null),
	syncTaskContinuityFromTaskState: vi.fn(async () => null),
	updateTaskStateCheckpoint: vi.fn(async () => null),
}));

vi.mock("$lib/server/services/honcho", () => ({
	listPersonaMemories: vi.fn(async () => []),
	mirrorMessage: vi.fn(async () => undefined),
	mirrorWorkCapsuleConclusion: vi.fn(async () => undefined),
}));

vi.mock("$lib/server/env", () => ({
	getDatabasePath: () => "./data/test.db",
	config: {
		maxMessageLength: 10000,
		model1MaxMessageLength: 10000,
		model2MaxMessageLength: 10000,
	},
}));

const configMockState = vi.hoisted(() => ({
	deepResearchEnabled: true,
	composerCommandRegistryEnabled: true,
}));

vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(() => ({
		concurrentStreamLimit: 100,
		perUserStreamLimit: 10,
		deepResearchEnabled: configMockState.deepResearchEnabled,
		composerCommandRegistryEnabled:
			configMockState.composerCommandRegistryEnabled,
		model1: {
			displayName: "Model 1",
		},
		model2: {
			displayName: "Model 2",
		},
	})),
	getProviderById: vi.fn(async () => null),
	normalizeModelSelection: vi.fn((model: string) => model),
	getMaxMessageLength: vi.fn(() => 10000),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import {
	getChatFilesForAssistantMessage,
	syncGeneratedFilesToMemory,
} from "$lib/server/services/chat-files";
import { runPlainNormalChatSendModel } from "$lib/server/services/chat-turn/plain-normal-chat-model-run";
import {
	getConversation,
	touchConversation,
} from "$lib/server/services/conversations";
import {
	assertCanStartDeepResearchJob,
	startDeepResearchJobShell,
} from "$lib/server/services/deep-research";
import { buildDeepResearchPlanningContext } from "$lib/server/services/deep-research/planning-context";
import {
	assignFileProductionJobsToAssistantMessage,
	listConversationFileProductionJobs,
} from "$lib/server/services/file-production";
import { assertPromptReadyAttachments } from "$lib/server/services/knowledge";
import { addConversationLinkedContextSources } from "$lib/server/services/linked-context-sources";
import {
	createMessage,
	updateMessageEvidence,
	updateMessageHonchoMetadata,
} from "$lib/server/services/messages";
import { commitSkillNoteOperationsAfterAssistantMessage } from "$lib/server/services/skills/notes";
import {
	applySkillControlOperations,
	getActiveSkillSession,
	startSkillSession,
} from "$lib/server/services/skills/sessions";
import {
	getAvailableSkillDefinition,
	getAvailableSkillSummary,
	resolveEffectiveSkillDefinition,
} from "$lib/server/services/skills/user-skills";
import { getProjectReferenceContext } from "$lib/server/services/task-state";
import { POST } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockGetConversation = getConversation as ReturnType<typeof vi.fn>;
const mockTouchConversation = touchConversation as ReturnType<typeof vi.fn>;
const mockRunPlainNormalChatSendModel =
	runPlainNormalChatSendModel as ReturnType<typeof vi.fn>;
const mockListFileProductionJobs =
	listConversationFileProductionJobs as ReturnType<typeof vi.fn>;
const mockAssignFileProductionJobs =
	assignFileProductionJobsToAssistantMessage as ReturnType<typeof vi.fn>;
const mockGetChatFilesForAssistantMessage =
	getChatFilesForAssistantMessage as ReturnType<typeof vi.fn>;
const mockSyncGeneratedFilesToMemory = syncGeneratedFilesToMemory as ReturnType<
	typeof vi.fn
>;
const mockAssertCanStartDeepResearchJob =
	assertCanStartDeepResearchJob as ReturnType<typeof vi.fn>;
const mockStartDeepResearchJobShell = startDeepResearchJobShell as ReturnType<
	typeof vi.fn
>;
const mockBuildDeepResearchPlanningContext =
	buildDeepResearchPlanningContext as ReturnType<typeof vi.fn>;
const mockCreateMessage = createMessage as ReturnType<typeof vi.fn>;
const mockUpdateMessageEvidence = updateMessageEvidence as ReturnType<
	typeof vi.fn
>;
const mockUpdateMessageHonchoMetadata =
	updateMessageHonchoMetadata as ReturnType<typeof vi.fn>;
const mockAssertPromptReadyAttachments =
	assertPromptReadyAttachments as ReturnType<typeof vi.fn>;
const mockAddConversationLinkedContextSources =
	addConversationLinkedContextSources as ReturnType<typeof vi.fn>;
const mockGetProjectReferenceContext = getProjectReferenceContext as ReturnType<
	typeof vi.fn
>;
const mockGetAvailableSkillSummary = getAvailableSkillSummary as ReturnType<
	typeof vi.fn
>;
const mockGetAvailableSkillDefinition =
	getAvailableSkillDefinition as ReturnType<typeof vi.fn>;
const mockResolveEffectiveSkillDefinition =
	resolveEffectiveSkillDefinition as ReturnType<typeof vi.fn>;
const mockGetActiveSkillSession = getActiveSkillSession as ReturnType<
	typeof vi.fn
>;
const mockApplySkillControlOperations =
	applySkillControlOperations as ReturnType<typeof vi.fn>;
const mockStartSkillSession = startSkillSession as ReturnType<typeof vi.fn>;
const mockCommitSkillNoteOperations =
	commitSkillNoteOperationsAfterAssistantMessage as ReturnType<typeof vi.fn>;

function makeEvent(
	body: unknown,
	user = { id: "user-1", email: "test@example.com" },
) {
	return {
		request: new Request("http://localhost/api/chat/send", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: { user },
		params: {},
		url: new URL("http://localhost/api/chat/send"),
		route: { id: "/api/chat/send" },
	} as any;
}

describe("POST /api/chat/send", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		configMockState.deepResearchEnabled = true;
		configMockState.composerCommandRegistryEnabled = true;
		mockRequireAuth.mockReturnValue(undefined);
		mockTouchConversation.mockImplementation(async () => null);
		mockRunPlainNormalChatSendModel.mockResolvedValue({
			text: "Hello from AI!",
			contextStatus: undefined,
			modelId: "model1",
			modelDisplayName: "Model 1",
			providerUsage: null,
		});
		mockGetProjectReferenceContext.mockResolvedValue(null);
		mockAssertCanStartDeepResearchJob.mockResolvedValue(undefined);
		mockCreateMessage.mockImplementation(async () => ({
			id: crypto.randomUUID(),
			role: "user",
			content: "",
			timestamp: Date.now(),
		}));
		mockStartDeepResearchJobShell.mockResolvedValue({
			id: "research-job-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg",
			depth: "standard",
			status: "awaiting_approval",
			stage: "plan_drafted",
			title: "Compare EU and US AI copyright training data rules",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		mockAssertPromptReadyAttachments.mockResolvedValue({
			displayArtifacts: [],
			promptArtifacts: [],
		});
		mockListFileProductionJobs.mockResolvedValue([]);
		mockAssignFileProductionJobs.mockResolvedValue(undefined);
		mockGetChatFilesForAssistantMessage.mockResolvedValue([]);
		mockSyncGeneratedFilesToMemory.mockResolvedValue(undefined);
		mockBuildDeepResearchPlanningContext.mockResolvedValue([]);
		mockGetAvailableSkillSummary.mockResolvedValue({
			id: "skill-1",
			ownership: "user",
			displayName: "Interview coach",
		});
		mockResolveEffectiveSkillDefinition.mockResolvedValue({
			available: true,
			availabilityReason: "available",
			id: "skill-1",
			ownership: "user",
			skillKind: "user_skill",
			displayName: "Interview coach",
			description: "Asks useful questions.",
			effectiveInstructions: "Ask one concise follow-up before answering.",
			effectiveInstructionsHash: "test-hash",
			publicSummary: {
				id: "skill-1",
				ownership: "user",
				skillKind: "user_skill",
				baseSkillId: null,
				baseSkillVersion: null,
				displayName: "Interview coach",
				description: "Asks useful questions.",
				activationExamples: ["interview me first"],
				enabled: true,
				durationPolicy: "next_message",
				questionPolicy: "ask_when_needed",
				notesPolicy: "none",
				sourceScope: "selected_sources_only",
				creationSource: "user_created",
				version: 1,
				createdAt: 1,
				updatedAt: 2,
			},
			durationPolicy: "next_message",
			questionPolicy: "ask_when_needed",
			notesPolicy: "none",
			sourceScope: "selected_sources_only",
			sourceIds: {
				skillId: "skill-1",
				skillVersion: 1,
				packSkillId: null,
				packSkillVersion: null,
				variantSkillId: null,
				variantSkillVersion: null,
			},
		});
		mockGetAvailableSkillDefinition.mockResolvedValue({
			id: "skill-1",
			ownership: "user",
			displayName: "Interview coach",
			description: "Asks useful questions.",
			instructions: "Ask one concise follow-up before answering.",
			activationExamples: ["interview me first"],
			enabled: true,
			durationPolicy: "next_message",
			questionPolicy: "ask_when_needed",
			notesPolicy: "none",
			sourceScope: "selected_sources_only",
			creationSource: "user_created",
			version: 1,
			createdAt: 1,
			updatedAt: 2,
		});
		mockGetActiveSkillSession.mockResolvedValue(null);
		mockStartSkillSession.mockResolvedValue({
			id: "session-1",
			userId: "user-1",
			conversationId: "conv-1",
			skillId: "skill-1",
			skillOwnership: "user",
			status: "active",
			pauseReason: null,
			endReason: null,
			skillDisplayName: "Interview coach",
			skillDescription: "Asks useful questions.",
			skillInstructions: "Ask one concise follow-up before answering.",
			activationExamples: ["interview me first"],
			durationPolicy: "session",
			questionPolicy: "ask_when_needed",
			notesPolicy: "create_private_notes",
			sourceScope: "selected_sources_only",
			skillVersion: 1,
			startedFrom: "pending_skill",
			startedAt: 1,
			updatedAt: 1,
			pausedAt: null,
			endedAt: null,
			milestones: [],
		});
	});

	it("returns AI response text for a valid request", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockCreateMessage
			.mockResolvedValueOnce({
				id: "user-msg",
				role: "user",
				content: "Hello",
				timestamp: Date.now(),
			})
			.mockResolvedValueOnce({
				id: "assistant-msg",
				role: "assistant",
				content: "Hello from AI!",
				timestamp: Date.now(),
			});
		mockRunPlainNormalChatSendModel.mockResolvedValue({
			text: "Hello from AI!",
			rawResponse: {},
			contextStatus: undefined,
			honchoContext: {
				source: "live",
				waitedMs: 25,
				queuePendingWorkUnits: 0,
				queueInProgressWorkUnits: 0,
				fallbackReason: null,
				snapshotCreatedAt: 123,
			},
			honchoSnapshot: {
				createdAt: 123,
				summary: "Latest Honcho summary",
				messages: [
					{
						role: "assistant",
						content: "Hello from AI!",
						createdAt: Date.now(),
					},
				],
			},
		});

		const event = makeEvent({ message: "Hello", conversationId: "conv-1" });
		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.response.text).toBe("Hello from AI!");
		expect(data.conversationId).toBe("conv-1");
		expect(mockRunPlainNormalChatSendModel).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Hello",
				conversationId: "conv-1",
				modelId: "model1",
				user: {
					id: "user-1",
					displayName: undefined,
					email: "test@example.com",
				},
				attachmentIds: [],
			}),
		);
		expect(mockUpdateMessageHonchoMetadata).toHaveBeenCalledWith(
			"assistant-msg",
			{
				honchoContext: expect.objectContaining({ source: "live" }),
				honchoSnapshot: expect.objectContaining({
					summary: "Latest Honcho summary",
				}),
			},
		);
	});

	it("assigns file-production jobs created during non-stream sends to the persisted assistant message", async () => {
		mockGetConversation.mockResolvedValue({
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		});
		mockCreateMessage
			.mockResolvedValueOnce({
				id: "user-msg",
				role: "user",
				content: "Create a report",
				timestamp: Date.now(),
			})
			.mockResolvedValueOnce({
				id: "assistant-msg",
				role: "assistant",
				content: "Done.",
				timestamp: Date.now(),
			});
		mockListFileProductionJobs
			.mockResolvedValueOnce([{ id: "job-existing", files: [] }])
			.mockResolvedValueOnce([
				{ id: "job-existing", files: [] },
				{ id: "job-new", files: [{ id: "file-new" }] },
			]);
		mockGetChatFilesForAssistantMessage.mockResolvedValueOnce([
			{
				id: "file-new",
				name: "report.pdf",
				filename: "report.pdf",
			},
		]);
		mockRunPlainNormalChatSendModel.mockResolvedValue({
			text: "Done.",
			rawResponse: {},
			contextStatus: undefined,
		});

		const response = await POST(
			makeEvent({ message: "Create a report", conversationId: "conv-1" }),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(mockListFileProductionJobs).toHaveBeenNthCalledWith(
			1,
			"user-1",
			"conv-1",
		);
		expect(mockListFileProductionJobs.mock.invocationCallOrder[0]).toBeLessThan(
			mockRunPlainNormalChatSendModel.mock.invocationCallOrder[0],
		);
		expect(mockAssignFileProductionJobs).toHaveBeenCalledWith(
			"user-1",
			"conv-1",
			"assistant-msg",
			["job-new"],
		);
		expect(mockSyncGeneratedFilesToMemory).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-msg",
			fileIds: ["file-new"],
			assistantResponse: "Done.",
		});
		expect(data.generatedFiles).toEqual([
			expect.objectContaining({ id: "file-new", filename: "report.pdf" }),
		]);
	});

	it("persists prefetched forced web-search tool calls for send evidence", async () => {
		mockGetConversation.mockResolvedValue({
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		});
		mockCreateMessage
			.mockResolvedValueOnce({
				id: "user-msg",
				role: "user",
				content: "What changed today?",
				timestamp: Date.now(),
			})
			.mockResolvedValueOnce({
				id: "assistant-msg",
				role: "assistant",
				content: "Grounded answer",
				timestamp: Date.now(),
			});
		mockRunPlainNormalChatSendModel.mockResolvedValue({
			text: "Grounded answer",
			rawResponse: {},
			contextStatus: undefined,
			modelId: "model1",
			modelDisplayName: "Model 1",
			prefetchedToolCalls: [
				{
					callId: "server-prefetch:research_web:test",
					name: "research_web",
					input: { query: "What changed today?" },
					status: "done",
					outputSummary: "Server-prefetched 1 web source.",
					sourceType: "web",
					candidates: [
						{
							id: "source-1",
							title: "Source One",
							url: "https://example.com/source",
							snippet: "Fresh source snippet",
							sourceType: "web",
							material: true,
						},
					],
				},
			],
			toolCalls: [
				{
					callId: "server-prefetch:research_web:test",
					name: "research_web",
					input: { query: "What changed today?" },
					status: "done",
					outputSummary: "Server-prefetched 1 web source.",
					sourceType: "web",
					candidates: [
						{
							id: "source-1",
							title: "Source One",
							url: "https://example.com/source",
							snippet: "Fresh source snippet",
							sourceType: "web",
							material: true,
						},
					],
				},
				{
					callId: "call-produce-success",
					name: "produce_file",
					input: { requestTitle: "Successful report" },
					status: "done",
					outputSummary: "File production job job-success queued.",
					sourceType: "tool",
					metadata: {
						ok: true,
						jobId: "job-success",
					},
				},
				{
					callId: "call-produce-failed",
					name: "produce_file",
					input: { requestTitle: "Failed report" },
					status: "done",
					outputSummary: "FAILED_TOOL_OUTPUT_SHOULD_NOT_BE_EVIDENCE",
					sourceType: "tool",
					metadata: {
						ok: false,
						evidenceReady: false,
						intakeStatus: 500,
					},
				},
			],
		});

		const event = makeEvent({
			message: "What changed today?",
			conversationId: "conv-1",
			forceWebSearch: true,
		});
		const response = await POST(event);

		expect(response.status).toBe(200);
		expect(mockRunPlainNormalChatSendModel).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				message: "What changed today?",
				conversationId: "conv-1",
				modelId: "model1",
				forceWebSearch: true,
			}),
		);
		await vi.waitFor(() => {
			expect(mockUpdateMessageEvidence).toHaveBeenCalledWith(
				"assistant-msg",
				expect.objectContaining({
					evidenceStatus: "ready",
					evidenceSummary: expect.objectContaining({
						structuredWebSearch: true,
						groups: expect.arrayContaining([
							expect.objectContaining({
								sourceType: "web",
								items: expect.arrayContaining([
									expect.objectContaining({
										title: "Source One",
										url: "https://example.com/source",
									}),
								]),
							}),
						]),
					}),
				}),
			);
		});
		const evidencePayload = mockUpdateMessageEvidence.mock.calls.find(
			([messageId]) => messageId === "assistant-msg",
		)?.[1];
		expect(JSON.stringify(evidencePayload)).toContain(
			"File production job job-success queued.",
		);
		expect(JSON.stringify(evidencePayload)).not.toContain(
			"FAILED_TOOL_OUTPUT_SHOULD_NOT_BE_EVIDENCE",
		);
	});

	it("returns project folder awareness in send metadata and degrades lookup failures", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockCreateMessage
			.mockResolvedValueOnce({
				id: "user-msg",
				role: "user",
				content: "Hello",
				timestamp: Date.now(),
			})
			.mockResolvedValueOnce({
				id: "assistant-msg",
				role: "assistant",
				content: "Hello from AI!",
				timestamp: Date.now(),
			});
		mockRunPlainNormalChatSendModel.mockResolvedValue({
			text: "Hello from AI!",
			rawResponse: {},
			contextStatus: undefined,
		});
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

		const response = await POST(
			makeEvent({ message: "Hello", conversationId: "conv-1" }),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
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

		mockCreateMessage.mockClear();
		mockCreateMessage
			.mockResolvedValueOnce({
				id: "user-msg-2",
				role: "user",
				content: "Hello again",
				timestamp: Date.now(),
			})
			.mockResolvedValueOnce({
				id: "assistant-msg-2",
				role: "assistant",
				content: "Still works",
				timestamp: Date.now(),
			});
		mockRunPlainNormalChatSendModel.mockResolvedValueOnce({
			text: "Still works",
			rawResponse: {},
			contextStatus: undefined,
		});
		mockGetProjectReferenceContext.mockRejectedValueOnce(
			new Error("folder lookup failed"),
		);

		const fallbackResponse = await POST(
			makeEvent({ message: "Hello again", conversationId: "conv-1" }),
		);
		const fallbackData = await fallbackResponse.json();

		expect(fallbackResponse.status).toBe(200);
		expect(fallbackData.contextSources.groups).toEqual([]);
	});

	it("starts a Deep Research job shell instead of a normal assistant answer", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockCreateMessage.mockResolvedValueOnce({
			id: "user-msg",
			role: "user",
			content: "Compare EU and US AI copyright training data rules",
			timestamp: Date.now(),
		});

		const event = makeEvent({
			message: "Compare EU and US AI copyright training data rules",
			conversationId: "conv-1",
			deepResearch: { depth: "standard" },
		});
		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.response).toBeNull();
		expect(data.deepResearchJob).toMatchObject({
			conversationId: "conv-1",
			triggerMessageId: "user-msg",
			depth: "standard",
			status: "awaiting_approval",
		});
		expect(mockCreateMessage).toHaveBeenCalledTimes(1);
		expect(mockCreateMessage).toHaveBeenCalledWith(
			"conv-1",
			"user",
			"Compare EU and US AI copyright training data rules",
		);
		expect(mockStartDeepResearchJobShell).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				conversationId: "conv-1",
				triggerMessageId: "user-msg",
				userRequest: "Compare EU and US AI copyright training data rules",
				depth: "standard",
			}),
		);
		expect(mockRunPlainNormalChatSendModel).not.toHaveBeenCalled();
	});

	it("does not apply linked context sources to Deep Research job startup", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockCreateMessage.mockResolvedValueOnce({
			id: "user-msg",
			role: "user",
			content: "Research this with normal Deep Research behavior",
			timestamp: Date.now(),
		});

		const response = await POST(
			makeEvent({
				message: "Research this with normal Deep Research behavior",
				conversationId: "conv-1",
				deepResearch: { depth: "standard" },
				linkedSources: [
					{
						displayArtifactId: "display-1",
						promptArtifactId: "prompt-1",
						familyArtifactIds: ["display-1", "prompt-1"],
						name: "Linked source.pdf",
						type: "document",
					},
				],
			}),
		);

		expect(response.status).toBe(200);
		expect(mockAddConversationLinkedContextSources).not.toHaveBeenCalled();
		expect(mockStartDeepResearchJobShell).toHaveBeenCalledWith(
			expect.not.objectContaining({ linkedSources: expect.anything() }),
		);
	});

	it("applies linked context sources to normal chat send turns", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockRunPlainNormalChatSendModel.mockResolvedValue({
			text: "Normal chat with linked source",
			rawResponse: {},
			contextStatus: undefined,
		});

		const linkedSources = [
			{
				displayArtifactId: "display-1",
				promptArtifactId: "prompt-1",
				familyArtifactIds: ["display-1", "prompt-1"],
				name: "Linked source.pdf",
				type: "document",
				documentOrigin: "uploaded",
			},
		];
		mockAddConversationLinkedContextSources.mockResolvedValueOnce(
			linkedSources,
		);
		const response = await POST(
			makeEvent({
				message: "Use the linked source normally",
				conversationId: "conv-1",
				linkedSources,
			}),
		);

		expect(response.status).toBe(200);
		const data = await response.json();
		expect(mockAddConversationLinkedContextSources).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			linkedSources,
			attachmentIds: [],
		});
		expect(data.contextSources.groups).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "linked_source",
					state: "active",
					items: [
						expect.objectContaining({
							artifactId: "display-1",
							title: "Linked source.pdf",
							reason: "linked_context_source",
						}),
					],
				}),
			]),
		);
		expect(mockRunPlainNormalChatSendModel).toHaveBeenCalled();
	});

	it("rejects normal chat linked context sources when Composer Command Registry is disabled", async () => {
		configMockState.composerCommandRegistryEnabled = false;
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);

		const response = await POST(
			makeEvent({
				message: "Use the linked source normally",
				conversationId: "conv-1",
				linkedSources: [
					{
						displayArtifactId: "display-1",
						promptArtifactId: "prompt-1",
						familyArtifactIds: ["display-1", "prompt-1"],
						name: "Linked source.pdf",
						type: "document",
					},
				],
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(403);
		expect(data).toMatchObject({
			error: "Composer Command Registry is disabled.",
			code: "composer_commands_disabled",
		});
		expect(mockAddConversationLinkedContextSources).not.toHaveBeenCalled();
		expect(mockRunPlainNormalChatSendModel).not.toHaveBeenCalled();
	});

	it("rejects normal chat pending skills when Composer Command Registry is disabled", async () => {
		configMockState.composerCommandRegistryEnabled = false;
		mockGetConversation.mockResolvedValue({
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		});

		const response = await POST(
			makeEvent({
				message: "Use this skill",
				conversationId: "conv-1",
				pendingSkill: {
					id: "skill-1",
					ownership: "user",
					displayName: "Interview coach",
				},
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(403);
		expect(data).toMatchObject({
			error: "Composer Command Registry is disabled.",
			code: "composer_commands_disabled",
		});
		expect(mockResolveEffectiveSkillDefinition).not.toHaveBeenCalled();
		expect(mockRunPlainNormalChatSendModel).not.toHaveBeenCalled();
	});

	it("rejects normal chat when the pending skill is no longer available", async () => {
		mockGetConversation.mockResolvedValue({
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		});
		mockResolveEffectiveSkillDefinition.mockResolvedValue({
			available: false,
			availabilityReason: "not_found",
			id: "skill-1",
			ownership: "user",
			skillKind: null,
			displayName: null,
			description: null,
			effectiveInstructions: "",
			effectiveInstructionsHash: null,
			publicSummary: null,
			sourceIds: null,
		});

		const response = await POST(
			makeEvent({
				message: "Use this skill",
				conversationId: "conv-1",
				pendingSkill: {
					id: "skill-1",
					ownership: "user",
					displayName: "Interview coach",
				},
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(409);
		expect(data).toMatchObject({
			error: "Selected skill is no longer available.",
			code: "pending_skill_unavailable",
		});
		expect(mockResolveEffectiveSkillDefinition).toHaveBeenCalledWith("user-1", {
			id: "skill-1",
			ownership: "user",
		});
		expect(mockRunPlainNormalChatSendModel).not.toHaveBeenCalled();
	});

	it("rejects normal chat when the pending skill definition disappears after summary validation", async () => {
		mockGetConversation.mockResolvedValue({
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		});
		mockResolveEffectiveSkillDefinition.mockResolvedValue({
			available: false,
			availabilityReason: "not_found",
			id: "skill-1",
			ownership: "user",
			skillKind: null,
			displayName: null,
			description: null,
			effectiveInstructions: "",
			effectiveInstructionsHash: null,
			publicSummary: null,
			sourceIds: null,
		});

		const response = await POST(
			makeEvent({
				message: "Use this skill",
				conversationId: "conv-1",
				pendingSkill: {
					id: "skill-1",
					ownership: "user",
					displayName: "Interview coach",
				},
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(409);
		expect(data).toMatchObject({
			error: "Selected skill is no longer available.",
			code: "pending_skill_unavailable",
		});
		expect(mockRunPlainNormalChatSendModel).not.toHaveBeenCalled();
	});

	it("rejects normal chat when a different active skill session blocks the pending session skill", async () => {
		mockGetConversation.mockResolvedValue({
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		});
		mockGetAvailableSkillDefinition.mockResolvedValue({
			id: "skill-2",
			ownership: "user",
			displayName: "Code reviewer",
			description: "Reviews code.",
			instructions: "Review the code carefully.",
			activationExamples: [],
			enabled: true,
			durationPolicy: "session",
			questionPolicy: "none",
			notesPolicy: "none",
			sourceScope: "selected_sources_only",
			creationSource: "user_created",
			version: 1,
			createdAt: 1,
			updatedAt: 2,
		});
		mockResolveEffectiveSkillDefinition.mockResolvedValue({
			available: true,
			availabilityReason: "available",
			id: "skill-2",
			ownership: "user",
			skillKind: "user_skill",
			displayName: "Code reviewer",
			description: "Reviews code.",
			effectiveInstructions: "Review the code carefully.",
			effectiveInstructionsHash: "test-hash-2",
			publicSummary: {
				id: "skill-2",
				ownership: "user",
				skillKind: "user_skill",
				baseSkillId: null,
				baseSkillVersion: null,
				displayName: "Code reviewer",
				description: "Reviews code.",
				activationExamples: [],
				enabled: true,
				durationPolicy: "session",
				questionPolicy: "none",
				notesPolicy: "none",
				sourceScope: "selected_sources_only",
				creationSource: "user_created",
				version: 1,
				createdAt: 1,
				updatedAt: 2,
			},
			durationPolicy: "session",
			questionPolicy: "none",
			notesPolicy: "none",
			sourceScope: "selected_sources_only",
			sourceIds: {
				skillId: "skill-2",
				skillVersion: 1,
				packSkillId: null,
				packSkillVersion: null,
				variantSkillId: null,
				variantSkillVersion: null,
			},
		});
		mockStartSkillSession.mockRejectedValue(
			Object.assign(new Error("Another skill session is already active."), {
				code: "active_skill_session_conflict",
				status: 409,
			}),
		);

		const response = await POST(
			makeEvent({
				message: "Use this other skill",
				conversationId: "conv-1",
				pendingSkill: {
					id: "skill-2",
					ownership: "user",
					displayName: "Code reviewer",
				},
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(409);
		expect(data).toMatchObject({
			error: "Another skill session is already active.",
			code: "active_skill_session_conflict",
		});
		expect(mockRunPlainNormalChatSendModel).not.toHaveBeenCalled();
	});

	it("passes pending Skill instructions as a system appendix without changing the visible user transcript", async () => {
		mockGetConversation.mockResolvedValue({
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		});
		mockCreateMessage
			.mockResolvedValueOnce({
				id: "user-msg",
				role: "user",
				content: "Draft the plan",
				timestamp: Date.now(),
			})
			.mockResolvedValueOnce({
				id: "assistant-msg",
				role: "assistant",
				content: "Question first.",
				timestamp: Date.now(),
			});
		mockRunPlainNormalChatSendModel.mockResolvedValue({
			text: "Question first.",
			rawResponse: {},
			contextStatus: undefined,
		});
		const linkedSources = [
			{
				displayArtifactId: "display-1",
				promptArtifactId: "prompt-1",
				familyArtifactIds: ["display-1", "prompt-1"],
				name: "Discovery notes.pdf",
				type: "document" as const,
			},
		];
		mockAddConversationLinkedContextSources.mockResolvedValueOnce(
			linkedSources,
		);

		const response = await POST(
			makeEvent({
				message: "  Draft the plan  ",
				conversationId: "conv-1",
				pendingSkill: {
					id: "skill-1",
					ownership: "user",
					displayName: "Interview coach",
				},
				linkedSources,
			}),
		);

		expect(response.status).toBe(200);
		expect(mockRunPlainNormalChatSendModel).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Draft the plan",
				conversationId: "conv-1",
				modelId: "model1",
				systemPromptAppendix: expect.stringContaining(
					"Ask one concise follow-up before answering.",
				),
			}),
		);
		const options = mockRunPlainNormalChatSendModel.mock.calls.at(-1)?.[0];
		expect(options.systemPromptAppendix).toContain("Discovery notes.pdf");
		expect(options.systemPromptAppendix).toContain(
			"displayArtifactId: display-1",
		);
		expect(options.systemPromptAppendix).not.toContain("  Draft the plan  ");
		expect(mockCreateMessage).toHaveBeenNthCalledWith(
			1,
			"conv-1",
			"user",
			"Draft the plan",
		);
	});

	it("treats Skill Control Envelopes as plain assistant output when Composer Command Registry is disabled", async () => {
		configMockState.composerCommandRegistryEnabled = false;
		mockGetConversation.mockResolvedValue({
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		});
		mockCreateMessage
			.mockResolvedValueOnce({
				id: "user-msg",
				role: "user",
				content: "Hello",
				timestamp: Date.now(),
			})
			.mockResolvedValueOnce({
				id: "assistant-msg",
				role: "assistant",
				content: "Visible answer.",
				timestamp: Date.now(),
			});
		const envelope = [
			"<skill_control_v1>",
			JSON.stringify({
				version: 1,
				operations: [
					{
						operationId: "ask-deadline",
						kind: "session_transition",
						transition: "awaiting_user",
					},
				],
			}),
			"</skill_control_v1>",
		].join("\n");
		mockRunPlainNormalChatSendModel.mockResolvedValue({
			text: `Visible answer.\n${envelope}`,
			rawResponse: {},
			contextStatus: undefined,
		});

		const response = await POST(
			makeEvent({ message: "Hello", conversationId: "conv-1" }),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.response.text).toContain("<skill_control_v1>");
		expect(mockCreateMessage).toHaveBeenCalledWith(
			"conv-1",
			"assistant",
			expect.stringContaining("<skill_control_v1>"),
			undefined,
			undefined,
			expect.not.objectContaining({
				skillControl: expect.anything(),
				skillQuestion: expect.anything(),
			}),
		);
		expect(mockCommitSkillNoteOperations).not.toHaveBeenCalled();
		expect(mockApplySkillControlOperations).not.toHaveBeenCalled();
	});

	it("strips Skill Control Envelopes, persists metadata, and applies transitions after assistant persistence", async () => {
		mockGetConversation.mockResolvedValue({
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		});
		mockCreateMessage
			.mockResolvedValueOnce({
				id: "user-msg",
				role: "user",
				content: "Coach me",
				timestamp: Date.now(),
			})
			.mockResolvedValueOnce({
				id: "assistant-msg",
				role: "assistant",
				content: "What deadline should I use?",
				timestamp: Date.now(),
			});
		mockRunPlainNormalChatSendModel.mockResolvedValue({
			text: [
				"What deadline should I use?",
				"<skill_control_v1>",
				JSON.stringify({
					version: 1,
					operations: [
						{
							operationId: "ask-deadline",
							kind: "session_transition",
							transition: "awaiting_user",
						},
					],
				}),
				"</skill_control_v1>",
			].join("\n"),
			rawResponse: {},
			contextStatus: undefined,
		});

		const response = await POST(
			makeEvent({ message: "Coach me", conversationId: "conv-1" }),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.response.text).toBe("What deadline should I use?");
		expect(mockCreateMessage).toHaveBeenCalledWith(
			"conv-1",
			"assistant",
			"What deadline should I use?",
			undefined,
			undefined,
			expect.objectContaining({
				evidenceStatus: "pending",
				skillQuestion: true,
				skillControl: expect.objectContaining({
					operations: [
						expect.objectContaining({
							operationId: "ask-deadline",
							transition: "awaiting_user",
						}),
					],
				}),
			}),
		);
		expect(mockApplySkillControlOperations).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-msg",
			operations: [
				{
					operationId: "ask-deadline",
					kind: "session_transition",
					transition: "awaiting_user",
				},
			],
		});
	});

	it("commits note operations after the assistant message exists", async () => {
		mockGetConversation.mockResolvedValue({
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		});
		mockGetActiveSkillSession.mockResolvedValue({
			id: "session-1",
			userId: "user-1",
			conversationId: "conv-1",
			skillId: "skill-1",
			skillOwnership: "user",
			status: "active",
			pauseReason: null,
			endReason: null,
			skillDisplayName: "Meeting critic",
			skillDescription: "Reviews notes",
			skillInstructions: "Capture decisions.",
			activationExamples: [],
			durationPolicy: "session",
			questionPolicy: "none",
			notesPolicy: "create_private_notes",
			sourceScope: "selected_sources_only",
			skillVersion: 1,
			startedFrom: "pending_skill",
			startedAt: 1,
			updatedAt: 1,
			pausedAt: null,
			endedAt: null,
			milestones: [],
		});
		mockCreateMessage
			.mockResolvedValueOnce({
				id: "user-msg",
				role: "user",
				content: "Capture this",
				timestamp: Date.now(),
			})
			.mockResolvedValueOnce({
				id: "assistant-msg",
				role: "assistant",
				content: "Captured.",
				timestamp: Date.now(),
			});
		mockRunPlainNormalChatSendModel.mockResolvedValue({
			text: [
				"Captured.",
				"<skill_control_v1>",
				JSON.stringify({
					version: 1,
					operations: [
						{
							operationId: "note-create-1",
							kind: "note_intent",
							action: "create",
							title: "Decision",
							body: "Use the short plan.",
						},
					],
				}),
				"</skill_control_v1>",
			].join("\n"),
			rawResponse: {},
			contextStatus: undefined,
		});

		const response = await POST(
			makeEvent({ message: "Capture this", conversationId: "conv-1" }),
		);

		expect(response.status).toBe(200);
		expect(mockCommitSkillNoteOperations).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			sessionId: "session-1",
			assistantMessageId: "assistant-msg",
			operations: [
				{
					operationId: "note-create-1",
					kind: "note_intent",
					action: "create",
					title: "Decision",
					body: "Use the short plan.",
				},
			],
		});
	});

	it("commits first-response note operations to the session started from a pending skill", async () => {
		mockGetConversation.mockResolvedValue({
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		});
		mockGetAvailableSkillDefinition.mockResolvedValue({
			id: "skill-1",
			ownership: "user",
			displayName: "Meeting critic",
			description: "Reviews notes",
			instructions: "Capture decisions.",
			activationExamples: [],
			durationPolicy: "session",
			questionPolicy: "none",
			notesPolicy: "create_private_notes",
			sourceScope: "selected_sources_only",
			creationSource: "user_created",
			version: 1,
			createdAt: 1,
			updatedAt: 2,
		});
		mockStartSkillSession.mockResolvedValue({
			id: "started-session-1",
			userId: "user-1",
			conversationId: "conv-1",
			skillId: "skill-1",
			skillOwnership: "user",
			status: "active",
			pauseReason: null,
			endReason: null,
			skillDisplayName: "Meeting critic",
			skillDescription: "Reviews notes",
			skillInstructions: "Capture decisions.",
			activationExamples: [],
			durationPolicy: "session",
			questionPolicy: "none",
			notesPolicy: "create_private_notes",
			sourceScope: "selected_sources_only",
			skillVersion: 1,
			startedFrom: "pending_skill",
			startedAt: 1,
			updatedAt: 1,
			pausedAt: null,
			endedAt: null,
			milestones: [],
		});
		mockResolveEffectiveSkillDefinition.mockResolvedValue({
			available: true,
			availabilityReason: "available",
			id: "skill-1",
			ownership: "user",
			skillKind: "user_skill",
			displayName: "Meeting critic",
			description: "Reviews notes",
			effectiveInstructions: "Capture decisions.",
			effectiveInstructionsHash: "test-hash-session",
			publicSummary: {
				id: "skill-1",
				ownership: "user",
				skillKind: "user_skill",
				baseSkillId: null,
				baseSkillVersion: null,
				displayName: "Meeting critic",
				description: "Reviews notes",
				activationExamples: [],
				enabled: true,
				durationPolicy: "session",
				questionPolicy: "none",
				notesPolicy: "create_private_notes",
				sourceScope: "selected_sources_only",
				creationSource: "user_created",
				version: 1,
				createdAt: 1,
				updatedAt: 2,
			},
			durationPolicy: "session",
			questionPolicy: "none",
			notesPolicy: "create_private_notes",
			sourceScope: "selected_sources_only",
			sourceIds: {
				skillId: "skill-1",
				skillVersion: 1,
				packSkillId: null,
				packSkillVersion: null,
				variantSkillId: null,
				variantSkillVersion: null,
			},
		});
		mockCreateMessage
			.mockResolvedValueOnce({
				id: "user-msg",
				role: "user",
				content: "Capture this",
				timestamp: Date.now(),
			})
			.mockResolvedValueOnce({
				id: "assistant-msg",
				role: "assistant",
				content: "Captured.",
				timestamp: Date.now(),
			});
		mockRunPlainNormalChatSendModel.mockResolvedValue({
			text: [
				"Captured.",
				"<skill_control_v1>",
				JSON.stringify({
					version: 1,
					operations: [
						{
							operationId: "note-create-1",
							kind: "note_intent",
							action: "create",
							title: "Decision",
							body: "Use the short plan.",
						},
					],
				}),
				"</skill_control_v1>",
			].join("\n"),
			rawResponse: {},
			contextStatus: undefined,
		});

		const response = await POST(
			makeEvent({
				message: "Capture this",
				conversationId: "conv-1",
				pendingSkill: {
					id: "skill-1",
					ownership: "user",
					displayName: "Meeting critic",
				},
			}),
		);

		expect(response.status).toBe(200);
		expect(mockStartSkillSession).toHaveBeenCalledWith(
			"user-1",
			"conv-1",
			expect.objectContaining({
				id: "skill-1",
				ownership: "user",
				displayName: "Meeting critic",
			}),
		);
		expect(mockCommitSkillNoteOperations).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "started-session-1",
				assistantMessageId: "assistant-msg",
			}),
		);
	});

	it("preserves started variant session metadata and managed pack resources in the prompt appendix", async () => {
		mockGetConversation.mockResolvedValue({
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		});
		mockResolveEffectiveSkillDefinition.mockResolvedValue({
			available: true,
			availabilityReason: "available",
			id: "variant-1",
			ownership: "user",
			skillKind: "skill_variant",
			displayName: "Monthly workbook",
			description: "Uses the spreadsheet pack with user ratios.",
			effectiveInstructions:
				"Build the workbook.\n\nUse my daily ratio layout.",
			effectiveInstructionsHash: "variant-session-hash",
			publicSummary: {
				id: "variant-1",
				ownership: "user",
				skillKind: "skill_variant",
				baseSkillId: "system:spreadsheet-builder",
				baseSkillVersion: 7,
				baseSkillDisplayName: "Spreadsheet Builder",
				displayName: "Monthly workbook",
				description: "Uses the spreadsheet pack with user ratios.",
				activationExamples: [],
				enabled: true,
				durationPolicy: "session",
				questionPolicy: "ask_when_needed",
				notesPolicy: "none",
				sourceScope: "selected_sources_only",
				creationSource: "user_created",
				version: 3,
				createdAt: 1,
				updatedAt: 2,
			},
			durationPolicy: "session",
			questionPolicy: "ask_when_needed",
			notesPolicy: "none",
			sourceScope: "selected_sources_only",
			sourceIds: {
				skillId: "variant-1",
				skillVersion: 3,
				packSkillId: "system:spreadsheet-builder",
				packSkillVersion: 7,
				variantSkillId: "variant-1",
				variantSkillVersion: 3,
			},
			promptResources: [
				{
					id: "spreadsheet-style-quality",
					title: "Spreadsheet style and workbook quality",
					kind: "guidance",
					summary: "Workbook structure and quality checks.",
					whenToUse: "Use for every workbook request.",
					content:
						"Keep source, assumptions, calculations, checks, and dashboard sheets separate.",
					keywords: [],
				},
			],
		});
		mockStartSkillSession.mockResolvedValue({
			id: "started-variant-session",
			userId: "user-1",
			conversationId: "conv-1",
			skillId: "variant-1",
			skillOwnership: "user",
			skillKind: "skill_variant",
			status: "active",
			pauseReason: null,
			endReason: null,
			skillDisplayName: "Monthly workbook",
			skillDescription: "Uses the spreadsheet pack with user ratios.",
			skillInstructions: "Build the workbook.\n\nUse my daily ratio layout.",
			activationExamples: [],
			durationPolicy: "session",
			questionPolicy: "ask_when_needed",
			notesPolicy: "none",
			sourceScope: "selected_sources_only",
			skillVersion: 3,
			packSkillId: "system:spreadsheet-builder",
			packSkillVersion: 7,
			variantSkillId: "variant-1",
			variantSkillVersion: 3,
			effectiveInstructionsHash: "variant-session-hash",
			startedFrom: "pending_skill",
			startedAt: 1,
			updatedAt: 1,
			pausedAt: null,
			endedAt: null,
			milestones: [],
		});
		mockCreateMessage
			.mockResolvedValueOnce({
				id: "user-msg",
				role: "user",
				content: "Build this workbook",
				timestamp: Date.now(),
			})
			.mockResolvedValueOnce({
				id: "assistant-msg",
				role: "assistant",
				content: "Workbook queued.",
				timestamp: Date.now(),
			});
		mockRunPlainNormalChatSendModel.mockResolvedValue({
			text: "Workbook queued.",
			rawResponse: {},
			contextStatus: undefined,
		});

		const response = await POST(
			makeEvent({
				message: "Build this workbook",
				conversationId: "conv-1",
				pendingSkill: {
					id: "variant-1",
					ownership: "user",
					skillKind: "skill_variant",
					displayName: "Monthly workbook",
					baseSkillId: "system:spreadsheet-builder",
					baseSkillDisplayName: "Spreadsheet Builder",
				},
			}),
		);

		expect(response.status).toBe(200);
		const options = mockRunPlainNormalChatSendModel.mock.calls.at(-1)?.[0];
		expect(options.systemPromptAppendix).toContain(
			"Source: active skill session",
		);
		expect(options.systemPromptAppendix).toContain("Kind: skill_variant");
		expect(options.systemPromptAppendix).toContain(
			"Pack source: system:spreadsheet-builder, version 7",
		);
		expect(options.systemPromptAppendix).toContain(
			"Variant source: variant-1, version 3",
		);
		expect(options.systemPromptAppendix).toContain(
			"Effective instructions hash: variant-session-hash",
		);
		expect(options.systemPromptAppendix).toContain(
			"Managed pack resources included:",
		);
		expect(options.systemPromptAppendix).toContain("spreadsheet-style-quality");
	});

	it("does not apply pending skills to Deep Research job startup", async () => {
		mockGetConversation.mockResolvedValue({
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		});
		mockCreateMessage.mockResolvedValueOnce({
			id: "user-msg",
			role: "user",
			content: "Research this with normal Deep Research behavior",
			timestamp: Date.now(),
		});

		const response = await POST(
			makeEvent({
				message: "Research this with normal Deep Research behavior",
				conversationId: "conv-1",
				deepResearch: { depth: "standard" },
				pendingSkill: {
					id: "skill-1",
					ownership: "user",
					displayName: "Interview coach",
				},
			}),
		);

		expect(response.status).toBe(200);
		expect(mockResolveEffectiveSkillDefinition).not.toHaveBeenCalled();
		expect(mockStartDeepResearchJobShell).toHaveBeenCalled();
		expect(mockRunPlainNormalChatSendModel).not.toHaveBeenCalled();
	});

	it("rejects Deep Research when the runtime feature flag is disabled", async () => {
		configMockState.deepResearchEnabled = false;
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);

		const event = makeEvent({
			message: "Research this policy area deeply",
			conversationId: "conv-1",
			deepResearch: { depth: "standard" },
		});
		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(403);
		expect(data).toMatchObject({
			error: "Deep Research is disabled",
			code: "deep_research_disabled",
		});
		expect(mockAssertCanStartDeepResearchJob).not.toHaveBeenCalled();
		expect(mockCreateMessage).not.toHaveBeenCalled();
		expect(mockStartDeepResearchJobShell).not.toHaveBeenCalled();
		expect(mockRunPlainNormalChatSendModel).not.toHaveBeenCalled();
	});

	it("allows normal chat when Deep Research is disabled", async () => {
		configMockState.deepResearchEnabled = false;
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockRunPlainNormalChatSendModel.mockResolvedValue({
			text: "Normal chat still works",
			rawResponse: {},
			contextStatus: undefined,
		});

		const event = makeEvent({
			message: "Answer normally",
			conversationId: "conv-1",
		});
		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.response.text).toBe("Normal chat still works");
		expect(mockRunPlainNormalChatSendModel).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Answer normally",
				conversationId: "conv-1",
				modelId: "model1",
			}),
		);
		expect(mockStartDeepResearchJobShell).not.toHaveBeenCalled();
	});

	it("passes prompt-ready attachment planning context into the Deep Research job shell", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockAssertPromptReadyAttachments.mockResolvedValue({
			displayArtifacts: [{ id: "source-attachment-1" }],
			promptArtifacts: [{ id: "normalized-attachment-1" }],
		});
		mockBuildDeepResearchPlanningContext.mockResolvedValue([
			{
				type: "attachment",
				artifactId: "normalized-attachment-1",
				title: "Uploaded market brief.pdf",
				summary: "Prompt-ready attachment context for the research plan.",
				includeAsResearchSource: true,
			},
		]);
		mockCreateMessage.mockResolvedValueOnce({
			id: "user-msg",
			role: "user",
			content: "Research the market using my uploaded brief",
			timestamp: Date.now(),
		});
		mockStartDeepResearchJobShell.mockResolvedValueOnce({
			id: "research-job-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg",
			depth: "focused",
			status: "awaiting_approval",
			stage: "plan_drafted",
			title: "Research the market using my uploaded brief",
			currentPlan: {
				renderedPlan:
					"Research Plan\n\nPlanning context includes attached file: Uploaded market brief.pdf",
				rawPlan: {
					sourceScope: {
						includedSources: [
							{
								type: "attached_file",
								artifactId: "normalized-attachment-1",
								title: "Uploaded market brief.pdf",
								summary:
									"Prompt-ready attachment context for the research plan.",
							},
						],
					},
				},
			},
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

		const response = await POST(
			makeEvent({
				message: "  Research the market using my uploaded brief  ",
				conversationId: "conv-1",
				attachmentIds: ["source-attachment-1"],
				activeDocumentArtifactId: "active-doc-1",
				deepResearch: { depth: "focused" },
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.deepResearchJob.currentPlan.renderedPlan).toContain(
			"Uploaded market brief.pdf",
		);
		expect(
			data.deepResearchJob.currentPlan.rawPlan.sourceScope.includedSources,
		).toEqual([
			expect.objectContaining({
				type: "attached_file",
				artifactId: "normalized-attachment-1",
			}),
		]);
		expect(mockBuildDeepResearchPlanningContext).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			userRequest: "Research the market using my uploaded brief",
			attachmentIds: ["source-attachment-1"],
			activeDocumentArtifactId: "active-doc-1",
		});
		expect(mockStartDeepResearchJobShell).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				conversationId: "conv-1",
				triggerMessageId: "user-msg",
				userRequest: "Research the market using my uploaded brief",
				depth: "focused",
				planningContext: [
					expect.objectContaining({
						type: "attachment",
						artifactId: "normalized-attachment-1",
						includeAsResearchSource: true,
					}),
				],
			}),
		);
	});

	it("rejects Deep Research in a sealed conversation before persisting the triggering message", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		const error = {
			name: "DeepResearchJobStartError",
			code: "conversation_sealed",
			message: "Deep Research cannot be started in a sealed conversation",
			status: 409,
		};
		mockAssertCanStartDeepResearchJob.mockRejectedValue(error);

		const event = makeEvent({
			message: "Research this sealed topic",
			conversationId: "conv-1",
			deepResearch: { depth: "standard" },
		});
		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(409);
		expect(data).toMatchObject({
			error: "Deep Research cannot be started in a sealed conversation",
			code: "conversation_sealed",
		});
		expect(mockCreateMessage).not.toHaveBeenCalled();
		expect(mockStartDeepResearchJobShell).not.toHaveBeenCalled();
		expect(mockRunPlainNormalChatSendModel).not.toHaveBeenCalled();
	});

	it("rejects Deep Research when an active job exists before persisting the triggering message", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		const error = {
			name: "DeepResearchJobStartError",
			code: "active_job_exists",
			message: "This conversation already has an active Deep Research job",
			status: 409,
		};
		mockAssertCanStartDeepResearchJob.mockRejectedValue(error);

		const event = makeEvent({
			message: "Start another research pass",
			conversationId: "conv-1",
			deepResearch: { depth: "focused" },
		});
		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(409);
		expect(data).toMatchObject({
			error: "This conversation already has an active Deep Research job",
			code: "active_job_exists",
		});
		expect(mockCreateMessage).not.toHaveBeenCalled();
		expect(mockStartDeepResearchJobShell).not.toHaveBeenCalled();
		expect(mockRunPlainNormalChatSendModel).not.toHaveBeenCalled();
	});

	it("passes messages through unchanged", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockRunPlainNormalChatSendModel.mockResolvedValue({
			text: "Hello from AI!",
			rawResponse: {},
			contextStatus: undefined,
		});

		const event = makeEvent({ message: "Szia", conversationId: "conv-1" });
		const response = await POST(event);
		const data = await response.json();

		expect(mockRunPlainNormalChatSendModel).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Szia",
				conversationId: "conv-1",
				modelId: "model1",
			}),
		);
		expect(data.response.text).toBe("Hello from AI!");
	});

	it("returns 400 when message is empty", async () => {
		const event = makeEvent({ message: "", conversationId: "conv-1" });
		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toMatch(/non-empty/i);
		expect(mockRunPlainNormalChatSendModel).not.toHaveBeenCalled();
	});

	it("returns 400 when message is whitespace only", async () => {
		const event = makeEvent({ message: "   ", conversationId: "conv-1" });
		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toMatch(/non-empty/i);
		expect(mockRunPlainNormalChatSendModel).not.toHaveBeenCalled();
	});

	it("returns 400 when message exceeds max length", async () => {
		const longMessage = "a".repeat(10001);
		const event = makeEvent({ message: longMessage, conversationId: "conv-1" });
		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toMatch(/maximum length/i);
		expect(mockRunPlainNormalChatSendModel).not.toHaveBeenCalled();
	});

	it("returns 404 when conversation does not exist", async () => {
		mockGetConversation.mockResolvedValue(null);

		const event = makeEvent({
			message: "Hello",
			conversationId: "nonexistent-id",
		});
		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data.error).toMatch(/not found/i);
		expect(mockRunPlainNormalChatSendModel).not.toHaveBeenCalled();
	});

	it("returns 422 when a same-turn attachment is not prompt-ready", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockAssertPromptReadyAttachments.mockRejectedValue({
			name: "AttachmentReadinessError",
			message: "Attached file is not ready for chat.",
			code: "attachment_not_ready",
			status: 422,
			attachmentIds: ["artifact-1"],
		});

		const event = makeEvent({
			message: "Use this file",
			conversationId: "conv-1",
			attachmentIds: ["artifact-1"],
		});
		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(422);
		expect(data.code).toBe("attachment_not_ready");
		expect(data.error).toMatch(/not ready/i);
		expect(mockRunPlainNormalChatSendModel).not.toHaveBeenCalled();
	});

	it("returns 422 when prompt construction fails closed after preflight", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockRunPlainNormalChatSendModel.mockRejectedValue({
			name: "AttachmentReadinessError",
			message:
				"Attached file content was missing from the final prompt bundle.",
			code: "attachment_not_ready",
			status: 422,
			attachmentIds: ["artifact-1"],
		});

		const event = makeEvent({
			message: "Use this file",
			conversationId: "conv-1",
			attachmentIds: ["artifact-1"],
		});
		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(422);
		expect(data.code).toBe("attachment_not_ready");
		expect(data.error).toMatch(/final prompt bundle/i);
	});

	it("returns 502 when the model run throws", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockRunPlainNormalChatSendModel.mockRejectedValue(
			new Error("Normal chat model run failed"),
		);

		const event = makeEvent({ message: "Hello", conversationId: "conv-1" });
		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(502);
		expect(data.error).toMatch(/failed to get response/i);
	});

	it("returns 400 when request body is invalid JSON", async () => {
		const event = {
			request: new Request("http://localhost/api/chat/send", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "not-valid-json",
			}),
			locals: { user: { id: "user-1" } },
			params: {},
			url: new URL("http://localhost/api/chat/send"),
			route: { id: "/api/chat/send" },
		} as any;

		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toMatch(/invalid json/i);
	});
});
