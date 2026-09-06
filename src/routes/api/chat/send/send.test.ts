import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	baseResolvedSkillDefinition,
	baseSkillSummary,
	baseUserSkillDefinition,
	buildInvalidJsonEvent,
	buildReasoningDepthMetadata,
	linkedSourceFixture,
	makeEvent,
	missingPendingSkill,
	seedConversation,
	seedConversationTurn,
	skillControlEnvelope,
	skillDraftOperation,
} from "./send.test-helpers";

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

vi.mock("$lib/server/services/atlas", () => ({
	cancelAtlasJob: vi.fn(async () => null),
	linkAtlasJobAssistantMessage: vi.fn(),
	submitAtlasJobIntake: vi.fn(),
	wakeAtlasWorker: vi.fn(),
}));

vi.mock("$lib/server/services/chat-turn/active-streams", () => ({
	checkStreamCapacity: vi.fn(() => ({ allowed: true })),
}));

vi.mock("$lib/server/services/chat-turn/depth-selection", () => ({
	resolveReasoningDepthSelection: vi.fn(async ({ request }) => ({
		metadata: buildReasoningDepthMetadata(request),
	})),
}));

vi.mock("$lib/server/services/file-production", () => ({
	assignFileProductionJobsToAssistantMessage: vi.fn(async () => undefined),
	listConversationFileProductionJobs: vi.fn(async () => []),
}));

// Issue 7.5 — snapshotConversationPendingWrites/finalizeChatTurn's pending
// write reconciliation (chat-turn/finalize.ts) load/write real rows via
// these two functions with no override param on the SEND path, mirroring
// the file-production mock immediately above. Previously unmocked here,
// which meant every send.test.ts run silently hit the real
// $lib/server/db default (./data/chat.db) for these calls.
vi.mock("$lib/server/services/connections/pending-writes", () => ({
	assignPendingWritesToAssistantMessage: vi.fn(async () => undefined),
	listPendingWritesForConversation: vi.fn(async () => []),
}));

vi.mock("$lib/server/services/chat-files", () => ({
	getChatFilesForAssistantMessage: vi.fn(async () => []),
	syncGeneratedFilesToMemory: vi.fn(async () => undefined),
}));

vi.mock("$lib/server/services/analytics", () => ({
	recordMessageAnalytics: vi.fn(async () => undefined),
}));

vi.mock("$lib/server/services/conversation-summaries", () => ({
	refreshConversationSummary: vi.fn(async () => undefined),
}));

vi.mock("$lib/server/services/memory-maintenance", () => ({
	runUserMemoryMaintenance: vi.fn(async () => undefined),
}));

vi.mock("$lib/server/services/messages", () => ({
	createMessage: vi.fn(),
	listMessages: vi.fn(async () => []),
	getLastMessage: vi.fn(async () => null),
	updateMessageEvidence: vi.fn(async () => undefined),
	updateMessageWebCitationAudit: vi.fn(async () => undefined),
}));

vi.mock("$lib/server/services/knowledge", () => ({
	assertPromptReadyAttachments: vi.fn(async () => ({
		displayArtifacts: [],
		promptArtifacts: [],
	})),
	attachArtifactsToMessage: vi.fn(),
	createArtifactLink: vi.fn(async () => null),
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
	recordConversationPromptUsage: vi.fn(async () => null),
	refreshConversationWorkingSet: vi.fn(async () => []),
	upsertWorkCapsule: vi.fn(async () => null),
}));

vi.mock("$lib/server/services/linked-context-sources", () => ({
	addConversationLinkedContextSources: vi.fn(async () => []),
	isLinkedContextSourceError: vi.fn(() => false),
}));

vi.mock("$lib/server/services/skills/user-skills", () => ({
	getAvailableSkillDefinition: vi.fn(async () => baseUserSkillDefinition),
	getAvailableSkillSummary: vi.fn(async () => baseSkillSummary),
	resolveEffectiveSkillDefinition: vi.fn(
		async () => baseResolvedSkillDefinition,
	),
}));

vi.mock("$lib/server/services/task-state", () => ({
	attachContinuityToTaskState: vi.fn(
		async (_userId: string, taskState: unknown) => taskState,
	),
	getContextDebugState: vi.fn(async () => null),
	getConversationTaskState: vi.fn(async () => null),
	getProjectReferenceContext: vi.fn(async () => null),
	updateTaskStateCheckpoint: vi.fn(async () => null),
}));

vi.mock("$lib/server/services/memory-profile/reset-generation", () => ({
	getCurrentMemoryResetGeneration: vi.fn(async () => 0),
	isCurrentMemoryResetGeneration: vi.fn(async () => true),
}));

vi.mock("$lib/server/env", async (importOriginal) => ({
	// Keep the real resolver so the db singleton opens the migrated throwaway
	// database provisioned by the vitest global setup, not a hard-coded ./data
	// path (gitignored local state, absent on a fresh clone).
	getDatabasePath: (await importOriginal<typeof import("$lib/server/env")>())
		.getDatabasePath,
	config: {
		maxMessageLength: 10000,
		model1MaxMessageLength: 10000,
		model2MaxMessageLength: 10000,
	},
}));

const configMockState = vi.hoisted(() => ({
	composerCommandRegistryEnabled: true,
}));

vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(() => ({
		concurrentStreamLimit: 100,
		perUserStreamLimit: 10,
		composerCommandRegistryEnabled:
			configMockState.composerCommandRegistryEnabled,
		atlasWorkerEnabled: true,
		parallelApiKey: "parallel-key",
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
	linkAtlasJobAssistantMessage,
	submitAtlasJobIntake,
	wakeAtlasWorker,
} from "$lib/server/services/atlas";
import {
	getChatFilesForAssistantMessage,
	syncGeneratedFilesToMemory,
} from "$lib/server/services/chat-files";
import { checkStreamCapacity } from "$lib/server/services/chat-turn/active-streams";
import { resolveReasoningDepthSelection } from "$lib/server/services/chat-turn/depth-selection";
import { runPlainNormalChatSendModel } from "$lib/server/services/chat-turn/plain-normal-chat-model-run";
import {
	assignPendingWritesToAssistantMessage,
	listPendingWritesForConversation,
} from "$lib/server/services/connections/pending-writes";
import {
	getConversation,
	touchConversation,
} from "$lib/server/services/conversations";
import {
	assignFileProductionJobsToAssistantMessage,
	listConversationFileProductionJobs,
} from "$lib/server/services/file-production";
import { assertPromptReadyAttachments } from "$lib/server/services/knowledge";
import { addConversationLinkedContextSources } from "$lib/server/services/linked-context-sources";
import {
	createMessage,
	updateMessageEvidence,
	updateMessageWebCitationAudit,
} from "$lib/server/services/messages";
import {
	getAvailableSkillDefinition,
	getAvailableSkillSummary,
	resolveEffectiveSkillDefinition,
} from "$lib/server/services/skills/user-skills";
import { getProjectReferenceContext } from "$lib/server/services/task-state";
import { POST } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockLinkAtlasJobAssistantMessage =
	linkAtlasJobAssistantMessage as ReturnType<typeof vi.fn>;
const mockSubmitAtlasJobIntake = submitAtlasJobIntake as ReturnType<
	typeof vi.fn
>;
const mockWakeAtlasWorker = wakeAtlasWorker as ReturnType<typeof vi.fn>;
const mockCheckStreamCapacity = checkStreamCapacity as ReturnType<typeof vi.fn>;
const mockGetConversation = getConversation as ReturnType<typeof vi.fn>;
const mockTouchConversation = touchConversation as ReturnType<typeof vi.fn>;
const mockRunPlainNormalChatSendModel =
	runPlainNormalChatSendModel as ReturnType<typeof vi.fn>;
const mockResolveReasoningDepthSelection =
	resolveReasoningDepthSelection as ReturnType<typeof vi.fn>;
const mockListFileProductionJobs =
	listConversationFileProductionJobs as ReturnType<typeof vi.fn>;
const mockAssignFileProductionJobs =
	assignFileProductionJobsToAssistantMessage as ReturnType<typeof vi.fn>;
const mockListPendingWrites = listPendingWritesForConversation as ReturnType<
	typeof vi.fn
>;
const mockAssignPendingWrites =
	assignPendingWritesToAssistantMessage as ReturnType<typeof vi.fn>;
const mockGetChatFilesForAssistantMessage =
	getChatFilesForAssistantMessage as ReturnType<typeof vi.fn>;
const mockSyncGeneratedFilesToMemory = syncGeneratedFilesToMemory as ReturnType<
	typeof vi.fn
>;
const mockCreateMessage = createMessage as ReturnType<typeof vi.fn>;
const mockUpdateMessageEvidence = updateMessageEvidence as ReturnType<
	typeof vi.fn
>;
const mockUpdateMessageWebCitationAudit =
	updateMessageWebCitationAudit as ReturnType<typeof vi.fn>;
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

describe("POST /api/chat/send", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		configMockState.composerCommandRegistryEnabled = true;
		mockRequireAuth.mockReturnValue(undefined);
		mockCheckStreamCapacity.mockReset();
		mockCheckStreamCapacity.mockReturnValue({ allowed: true });
		mockLinkAtlasJobAssistantMessage.mockRejectedValue(
			new Error("Unexpected Atlas link call"),
		);
		mockSubmitAtlasJobIntake.mockRejectedValue(
			new Error("Unexpected Atlas intake call"),
		);
		mockTouchConversation.mockImplementation(async () => null);
		mockRunPlainNormalChatSendModel.mockResolvedValue({
			text: "Hello from AI!",
			contextStatus: undefined,
			modelId: "model1",
			modelDisplayName: "Model 1",
			providerUsage: null,
		});
		mockResolveReasoningDepthSelection.mockImplementation(
			async ({ request }) => ({
				metadata: buildReasoningDepthMetadata(request),
			}),
		);
		mockGetProjectReferenceContext.mockResolvedValue(null);
		mockCreateMessage.mockImplementation(async () => ({
			id: crypto.randomUUID(),
			role: "user",
			content: "",
			timestamp: Date.now(),
		}));
		mockAssertPromptReadyAttachments.mockResolvedValue({
			displayArtifacts: [],
			promptArtifacts: [],
		});
		mockListFileProductionJobs.mockResolvedValue([]);
		mockAssignFileProductionJobs.mockResolvedValue(undefined);
		mockListPendingWrites.mockResolvedValue([]);
		mockAssignPendingWrites.mockResolvedValue(undefined);
		mockGetChatFilesForAssistantMessage.mockResolvedValue([]);
		mockSyncGeneratedFilesToMemory.mockResolvedValue(undefined);
		mockGetAvailableSkillSummary.mockResolvedValue(baseSkillSummary);
		mockResolveEffectiveSkillDefinition.mockResolvedValue(
			baseResolvedSkillDefinition,
		);
		mockGetAvailableSkillDefinition.mockResolvedValue(baseUserSkillDefinition);
	});

	it("returns AI response text for a valid request", async () => {
		seedConversationTurn(mockGetConversation, mockCreateMessage, {
			userMessage: { content: "Hello" },
			assistantMessage: { content: "Hello from AI!" },
		});
		mockRunPlainNormalChatSendModel.mockResolvedValue({
			text: "Hello from AI!",
			rawResponse: {},
			contextStatus: undefined,
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
	});

	it("short-circuits Atlas kickoff through the Atlas intake facade and persists the canned assistant message", async () => {
		mockSubmitAtlasJobIntake.mockResolvedValueOnce({
			job: {
				id: "atlas-job-1",
				conversationId: "conv-1",
				assistantMessageId: null,
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
				title: "Atlas research",
				profile: "overview",
				action: "create",
				parentAtlasJobId: null,
				createdAt: 1,
				updatedAt: 1,
				completedAt: null,
			},
			reused: false,
			idempotencyKey: "atlas-key",
			normalizedQueryHash: "query-hash",
		});
		seedConversationTurn(mockGetConversation, mockCreateMessage, {
			userMessage: { content: "Research Atlas transport" },
			assistantMessage: {
				content: "",
			},
		});

		const response = await POST(
			makeEvent({
				message: "Research Atlas transport",
				conversationId: "conv-1",
				atlasMode: true,
				atlasProfile: "overview",
				clientAtlasTurnId: "client-atlas-1",
				forceWebSearch: true,
				reasoningDepth: "max",
				pendingSkill: {
					id: "skill-1",
					ownership: "user",
					displayName: "Ignored skill",
				},
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data).toEqual(
			expect.objectContaining({
				response: {
					text: "",
				},
				conversationId: "conv-1",
				atlasJob: expect.objectContaining({
					id: "atlas-job-1",
					status: "queued",
					profile: "overview",
				}),
			}),
		);
		expect(mockSubmitAtlasJobIntake).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			query: "Research Atlas transport",
			profile: "overview",
			action: "create",
			parentAtlasJobId: null,
			clientAtlasTurnId: "client-atlas-1",
		});
		expect(mockRunPlainNormalChatSendModel).not.toHaveBeenCalled();
		expect(mockWakeAtlasWorker).toHaveBeenCalledOnce();
		expect(mockResolveReasoningDepthSelection).not.toHaveBeenCalled();
		expect(mockAssertPromptReadyAttachments).not.toHaveBeenCalled();
		expect(mockAddConversationLinkedContextSources).not.toHaveBeenCalled();
		expect(mockCreateMessage).toHaveBeenCalledWith(
			"conv-1",
			"assistant",
			"",
			undefined,
			undefined,
			expect.objectContaining({
				atlas: expect.objectContaining({ jobId: "atlas-job-1" }),
			}),
		);
	});

	it("reuses a linked Atlas kickoff without creating another assistant message or applying normal stream capacity", async () => {
		mockSubmitAtlasJobIntake.mockResolvedValueOnce({
			job: {
				id: "atlas-job-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-msg-existing",
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
				title: "Atlas research",
				profile: "overview",
				action: "create",
				parentAtlasJobId: null,
				createdAt: 1,
				updatedAt: 1,
				completedAt: null,
			},
			reused: true,
			idempotencyKey: "atlas-key",
			normalizedQueryHash: "query-hash",
		});

		const response = await POST(
			makeEvent({
				message: "Research Atlas transport",
				conversationId: "conv-1",
				atlasMode: true,
				atlasProfile: "overview",
				clientAtlasTurnId: "client-atlas-1",
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.atlasJob).toEqual(
			expect.objectContaining({
				id: "atlas-job-1",
				assistantMessageId: "assistant-msg-existing",
				action: "create",
			}),
		);
		expect(mockCheckStreamCapacity).not.toHaveBeenCalled();
		expect(mockCreateMessage).not.toHaveBeenCalled();
		expect(mockRunPlainNormalChatSendModel).not.toHaveBeenCalled();
	});

	it("persists requested Reasoning Depth metadata for non-stream sends, migrating the legacy 'max' wire value", async () => {
		seedConversationTurn(mockGetConversation, mockCreateMessage, {
			userMessage: { content: "Use max depth" },
			assistantMessage: { content: "Max-depth answer" },
		});
		mockRunPlainNormalChatSendModel.mockResolvedValue({
			text: "Max-depth answer",
			rawResponse: {},
			contextStatus: undefined,
			modelId: "provider:local:model-a",
			modelDisplayName: "Provider Model A",
			providerUsage: null,
		});

		const response = await POST(
			makeEvent({
				message: "Use max depth",
				conversationId: "conv-1",
				// Legacy wire value from an old client — ADR-0061 maps this to
				// the "thorough" toggle, applied as the "standard" profile.
				reasoningDepth: "max",
			}),
		);

		expect(response.status).toBe(200);
		expect(mockRunPlainNormalChatSendModel).toHaveBeenCalledWith(
			expect.objectContaining({
				depthMetadata: expect.objectContaining({
					requested: "thorough",
					appliedProfile: "standard",
				}),
			}),
		);
		expect(mockCreateMessage).toHaveBeenCalledWith(
			"conv-1",
			"assistant",
			"Max-depth answer",
			undefined,
			undefined,
			expect.objectContaining({
				depthMetadata: {
					requested: "thorough",
					appliedProfile: "standard",
					fallback: false,
					modelId: "provider:local:model-a",
					modelDisplayName: "Provider Model A",
				},
			}),
		);
	});

	it("persists classifier-resolved Auto Reasoning Depth metadata for non-stream sends", async () => {
		seedConversationTurn(mockGetConversation, mockCreateMessage, {
			userMessage: { content: "Compare migration strategies" },
			assistantMessage: { content: "Extended-depth answer" },
		});
		mockResolveReasoningDepthSelection.mockResolvedValueOnce({
			metadata: {
				requested: "auto",
				appliedProfile: "extended",
				fallback: false,
				classifierSource: "control_model",
				modelId: "model1",
				modelDisplayName: "Model 1",
			},
		});
		mockRunPlainNormalChatSendModel.mockResolvedValue({
			text: "Extended-depth answer",
			rawResponse: {},
			contextStatus: undefined,
			modelId: "provider:local:model-a",
			modelDisplayName: "Provider Model A",
			providerUsage: null,
			depthMetadata: {
				requested: "auto",
				appliedProfile: "extended",
				fallback: false,
				classifierSource: "control_model",
				modelId: "provider:local:model-a",
				modelDisplayName: "Provider Model A",
				appliedEffort: {
					dimensions: ["provider_reasoning", "tool_steps"],
					providerReasoning: {
						thinkingMode: "on",
						reasoningEffort: "medium",
						supported: true,
						constrained: false,
					},
					tools: {
						maxToolSteps: 18,
						maxWebSources: 6,
						sourceExpansion: false,
					},
				},
			},
		});

		const response = await POST(
			makeEvent({
				message: "Compare migration strategies",
				conversationId: "conv-1",
				reasoningDepth: "auto",
			}),
		);

		expect(response.status).toBe(200);
		expect(mockCreateMessage).toHaveBeenCalledWith(
			"conv-1",
			"assistant",
			"Extended-depth answer",
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
					appliedEffort: expect.objectContaining({
						providerReasoning: expect.objectContaining({
							reasoningEffort: "medium",
						}),
						tools: expect.objectContaining({
							maxToolSteps: 18,
							maxWebSources: 6,
						}),
					}),
				},
			}),
		);
	});

	it("assigns file-production jobs created during non-stream sends to the persisted assistant message", async () => {
		seedConversationTurn(mockGetConversation, mockCreateMessage, {
			userMessage: { content: "Create a report" },
			assistantMessage: { content: "Done." },
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
		seedConversationTurn(mockGetConversation, mockCreateMessage, {
			userMessage: { content: "What changed today?" },
			assistantMessage: { content: "Grounded answer" },
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

	it("returns the same visible web text that it persists while storing citation audit metadata", async () => {
		seedConversationTurn(mockGetConversation, mockCreateMessage, {
			userMessage: { content: "Check the current docs" },
			assistantMessage: { content: "Grounded answer without links" },
		});
		mockRunPlainNormalChatSendModel.mockResolvedValue({
			text: "Grounded answer without links",
			rawResponse: {},
			contextStatus: undefined,
			modelId: "model1",
			modelDisplayName: "Model 1",
			toolCalls: [
				{
					callId: "call-web",
					name: "research_web",
					input: { query: "Check the current docs" },
					status: "done",
					outputSummary: "Found 1 source.",
					sourceType: "web",
					candidates: [
						{
							id: "source-1",
							title: "Current Docs",
							url: "https://example.com/docs",
							snippet: "Current documentation excerpt",
							sourceType: "web",
							material: true,
						},
					],
				},
			],
		});

		const response = await POST(
			makeEvent({
				message: "Check the current docs",
				conversationId: "conv-1",
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.response.text).toContain("Grounded answer without links");
		expect(data.response.text).not.toContain("Source check:");
		expect(mockCreateMessage).toHaveBeenCalledWith(
			"conv-1",
			"assistant",
			data.response.text,
			undefined,
			undefined,
			expect.any(Object),
		);
		expect(mockUpdateMessageWebCitationAudit).toHaveBeenCalledWith(
			"assistant-msg",
			expect.objectContaining({
				status: "missing_citations",
				retrievedSourceCount: 1,
				noticeAppended: false,
			}),
		);
	});

	it("returns project folder awareness in send metadata and degrades lookup failures", async () => {
		seedConversationTurn(mockGetConversation, mockCreateMessage, {
			userMessage: { content: "Hello" },
			assistantMessage: { content: "Hello from AI!" },
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
		seedConversationTurn(mockGetConversation, mockCreateMessage, {
			userMessageId: "user-msg-2",
			assistantMessageId: "assistant-msg-2",
			userMessage: { content: "Hello again" },
			assistantMessage: { content: "Still works" },
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

	it("applies linked context sources to normal chat send turns", async () => {
		seedConversation(mockGetConversation);
		mockRunPlainNormalChatSendModel.mockResolvedValue({
			text: "Normal chat with linked source",
			rawResponse: {},
			contextStatus: undefined,
		});

		const linkedSources = [
			{ ...linkedSourceFixture, documentOrigin: "uploaded" },
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
		seedConversation(mockGetConversation);

		const response = await POST(
			makeEvent({
				message: "Use the linked source normally",
				conversationId: "conv-1",
				linkedSources: [linkedSourceFixture],
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
		seedConversation(mockGetConversation);

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
		seedConversation(mockGetConversation);
		mockResolveEffectiveSkillDefinition.mockResolvedValue({
			...missingPendingSkill,
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
		seedConversation(mockGetConversation);
		mockResolveEffectiveSkillDefinition.mockResolvedValue({
			...missingPendingSkill,
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

	it("forces the pending Skill's instructions into the packet without changing the visible user transcript", async () => {
		seedConversation(mockGetConversation);
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
				...linkedSourceFixture,
				name: "Discovery notes.pdf",
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
				pendingSkillInstructions: expect.stringContaining(
					"Ask one concise follow-up before answering.",
				),
			}),
		);
		const options = mockRunPlainNormalChatSendModel.mock.calls.at(-1)?.[0];
		expect(options.pendingSkillInstructions).toContain(
			'Skill "Interview coach" instructions',
		);
		expect(options.pendingSkillInstructions).not.toContain(
			"  Draft the plan  ",
		);
		expect(mockCreateMessage).toHaveBeenNthCalledWith(
			1,
			"conv-1",
			"user",
			"Draft the plan",
		);
	});

	it("treats Skill Control Envelopes as plain assistant output when Composer Command Registry is disabled", async () => {
		configMockState.composerCommandRegistryEnabled = false;
		seedConversation(mockGetConversation);
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
		const envelope = skillControlEnvelope([skillDraftOperation]);
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
				skillDrafts: expect.anything(),
			}),
		);
	});

	it("strips Skill Control Envelopes and persists Skill Draft metadata", async () => {
		seedConversation(mockGetConversation);
		mockCreateMessage
			.mockResolvedValueOnce({
				id: "user-msg",
				role: "user",
				content: "Make this a reusable skill",
				timestamp: Date.now(),
			})
			.mockResolvedValueOnce({
				id: "assistant-msg",
				role: "assistant",
				content: "I can make this reusable.",
				timestamp: Date.now(),
			});
		mockRunPlainNormalChatSendModel.mockResolvedValue({
			text: [
				"I can make this reusable.",
				skillControlEnvelope([skillDraftOperation]),
			].join("\n"),
			rawResponse: {},
			contextStatus: undefined,
		});

		const response = await POST(
			makeEvent({
				message: "Make this a reusable skill",
				conversationId: "conv-1",
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.response.text).toBe("I can make this reusable.");
		expect(mockCreateMessage).toHaveBeenCalledWith(
			"conv-1",
			"assistant",
			"I can make this reusable.",
			undefined,
			undefined,
			expect.objectContaining({
				evidenceStatus: "pending",
				skillDrafts: [
					expect.objectContaining({
						id: skillDraftOperation.draft.id,
						displayName: skillDraftOperation.draft.displayName,
						status: "proposed",
					}),
				],
				skillControl: expect.objectContaining({
					operations: [
						expect.objectContaining({
							operationId: skillDraftOperation.operationId,
						}),
					],
				}),
			}),
		);
	});

	it("passes messages through unchanged", async () => {
		seedConversation(mockGetConversation);
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
		seedConversation(mockGetConversation);
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
		seedConversation(mockGetConversation);
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

	it("returns 502 with a stable errorKey when the model run throws", async () => {
		// E1 — the hard-coded "Failed to get response from AI" sentence is
		// gone; the response now carries a stable `code` (errorKey) classified
		// from the actual cause, matching the stream path's StreamErrorCode
		// vocabulary. Localizing `code` into final copy is an E2 concern.
		seedConversation(mockGetConversation);
		mockRunPlainNormalChatSendModel.mockRejectedValue(
			new Error("Normal chat model run failed"),
		);

		const event = makeEvent({ message: "Hello", conversationId: "conv-1" });
		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(502);
		expect(data.code).toBe("backend_failure");
		expect(typeof data.error).toBe("string");
		expect(data.error.length).toBeGreaterThan(0);
	});

	it("classifies a network-shaped model run failure with the network errorKey", async () => {
		seedConversation(mockGetConversation);
		mockRunPlainNormalChatSendModel.mockRejectedValue(
			new Error("fetch failed: ECONNRESET"),
		);

		const event = makeEvent({ message: "Hello", conversationId: "conv-1" });
		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(502);
		expect(data.code).toBe("network");
	});

	it("returns 400 when request body is invalid JSON", async () => {
		const event = buildInvalidJsonEvent("not-valid-json") as Parameters<
			typeof POST
		>[0];

		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toMatch(/invalid json/i);
	});

	// Issue 7.5 — the SEND path's snapshotConversationPendingWrites +
	// finalizeChatTurn's generatedOutputReconciliation.pendingWriteIdsAtStart
	// wiring (routes/api/chat/send/+server.ts) had zero test coverage before
	// this: it's the non-streaming sibling of the STREAM path's
	// pendingWriteIdsAtStart fact (chat-turn/stream-completion.ts).
	describe("pending-write reconciliation", () => {
		it("stamps a new pending write onto the finalized assistant message id", async () => {
			seedConversationTurn(mockGetConversation, mockCreateMessage, {
				userMessage: { content: "Save this to Nextcloud" },
				assistantMessage: { content: "Saved." },
			});
			mockRunPlainNormalChatSendModel.mockResolvedValue({
				text: "Saved.",
				contextStatus: undefined,
			});
			mockListPendingWrites
				.mockResolvedValueOnce([{ id: "pw-existing" }])
				.mockResolvedValueOnce([{ id: "pw-existing" }, { id: "pw-new" }]);

			const event = makeEvent({
				message: "Save this to Nextcloud",
				conversationId: "conv-1",
			});
			const response = await POST(event);

			expect(response.status).toBe(200);
			expect(mockListPendingWrites).toHaveBeenCalledWith("user-1", "conv-1");
			expect(mockAssignPendingWrites).toHaveBeenCalledWith(
				"user-1",
				"conv-1",
				"assistant-msg",
				["pw-new"],
			);
		});

		it("does not stamp anything when the turn creates no new pending write", async () => {
			seedConversationTurn(mockGetConversation, mockCreateMessage, {
				userMessage: { content: "Hello" },
				assistantMessage: { content: "Hello from AI!" },
			});
			mockListPendingWrites.mockResolvedValue([{ id: "pw-existing" }]);

			const event = makeEvent({ message: "Hello", conversationId: "conv-1" });
			const response = await POST(event);

			expect(response.status).toBe(200);
			expect(mockAssignPendingWrites).not.toHaveBeenCalled();
		});

		it("never crashes the request when the pending-write start snapshot query fails", async () => {
			seedConversationTurn(mockGetConversation, mockCreateMessage, {
				userMessage: { content: "Hello" },
				assistantMessage: { content: "Hello from AI!" },
			});
			mockListPendingWrites.mockRejectedValueOnce(
				new Error("pending-write snapshot failed"),
			);
			const warn = vi
				.spyOn(console, "warn")
				.mockImplementation(() => undefined);

			try {
				const event = makeEvent({ message: "Hello", conversationId: "conv-1" });
				const response = await POST(event);
				const data = await response.json();

				expect(response.status).toBe(200);
				expect(data.response.text).toBe("Hello from AI!");
				expect(warn).toHaveBeenCalledWith(
					"[CHAT_SEND] Failed to snapshot pending writes at send start",
					expect.objectContaining({ conversationId: "conv-1" }),
				);
			} finally {
				warn.mockRestore();
			}
		});

		// When the start-of-turn snapshot query fails,
		// snapshotConversationPendingWrites (routes/api/chat/send/+server.ts)
		// now returns `undefined` (not an empty Set), so
		// reconcilePendingWritesForAssistantMessage (chat-turn/finalize.ts)'s
		// `if (!pendingWriteIdsAtStart) return;` guard trips and reconciliation
		// is SKIPPED — a pre-existing pending write from an unrelated earlier
		// turn is NOT mis-stamped onto this turn's assistant message. This
		// matches the STREAM path's undefined-on-unknown fallback
		// (resolvePendingWriteIdsAtStartFact in chat-turn/stream-completion.ts).
		it("does NOT mis-attribute a pre-existing pending write when the start snapshot query fails (fails safe)", async () => {
			seedConversationTurn(mockGetConversation, mockCreateMessage, {
				userMessage: { content: "Hello" },
				assistantMessage: { content: "Hello from AI!" },
			});
			mockListPendingWrites
				.mockRejectedValueOnce(new Error("pending-write snapshot failed"))
				.mockResolvedValueOnce([{ id: "pw-preexisting" }]);
			const warn = vi
				.spyOn(console, "warn")
				.mockImplementation(() => undefined);

			try {
				const event = makeEvent({ message: "Hello", conversationId: "conv-1" });
				const response = await POST(event);

				expect(response.status).toBe(200);
				// Fail-safe: no stamping happens at all when the snapshot is unknown.
				expect(mockAssignPendingWrites).not.toHaveBeenCalled();
			} finally {
				warn.mockRestore();
			}
		});
	});
});
