import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/conversations", () => ({
	getConversation: vi.fn(),
}));

vi.mock("$lib/server/services/conversation-drafts", () => ({
	getConversationDraft: vi.fn(),
}));

vi.mock("$lib/server/services/conversation-forks", () => ({
	getConversationForkOrigin: vi.fn(),
	listChildForksBySourceMessages: vi.fn(),
}));

vi.mock("$lib/server/services/skills/sessions", () => ({
	getActiveSkillSession: vi.fn(),
	serializePublicSkillSession: (
		session:
			| ({ skillInstructions?: unknown } & Record<string, unknown>)
			| null
			| undefined,
	) => {
		if (!session) return null;
		const { skillInstructions: _skillInstructions, ...publicSession } = session;
		return publicSession;
	},
}));

vi.mock("$lib/server/services/messages", () => ({
	listMessages: vi.fn(),
}));

vi.mock("$lib/server/services/knowledge", () => ({
	getConversationWorkingSet: vi.fn(),
	getConversationContextStatus: vi.fn(),
	listConversationArtifacts: vi.fn(),
}));

vi.mock("$lib/server/services/linked-context-sources", () => ({
	listConversationLinkedContextSources: vi.fn(),
}));

vi.mock("$lib/server/services/task-state", () => ({
	attachContinuityToTaskState: vi.fn(
		async (_userId: string, taskState: unknown) => taskState,
	),
	getContextDebugState: vi.fn(),
	getConversationTaskState: vi.fn(),
	getProjectReferenceContext: vi.fn(),
}));

vi.mock("$lib/server/services/file-production/read-model", () => ({
	listConversationGeneratedFiles: vi.fn(),
	listConversationFileProductionJobs: vi.fn(),
}));

vi.mock("$lib/server/services/atlas/read-model", () => ({
	listConversationAtlasJobs: vi.fn(),
}));

vi.mock("$lib/server/services/context-compression", () => ({
	listContextCompressionSnapshots: vi.fn(),
	serializeContextCompressionSnapshot: (snapshot: {
		id: string;
		trigger: string;
		status: string;
		sourceEndMessageId: string;
		createdAt: Date;
		updatedAt: Date;
		estimatedTokens: number;
		sourceTokenEstimate: number;
	}) => ({
		id: snapshot.id,
		trigger: snapshot.trigger,
		status: snapshot.status,
		sourceEndMessageId: snapshot.sourceEndMessageId,
		createdAt: snapshot.createdAt.getTime(),
		updatedAt: snapshot.updatedAt.getTime(),
		estimatedTokens: snapshot.estimatedTokens,
		sourceTokenEstimate: snapshot.sourceTokenEstimate,
	}),
}));

vi.mock("$lib/server/services/analytics", () => ({
	getConversationCostSummary: vi.fn(),
}));

import { getConversationCostSummary } from "$lib/server/services/analytics";
import { listConversationAtlasJobs } from "$lib/server/services/atlas/read-model";
import { listContextCompressionSnapshots } from "$lib/server/services/context-compression";
import { getConversationDraft } from "$lib/server/services/conversation-drafts";
import {
	getConversationForkOrigin,
	listChildForksBySourceMessages,
} from "$lib/server/services/conversation-forks";
import { getConversation } from "$lib/server/services/conversations";
import {
	listConversationFileProductionJobs,
	listConversationGeneratedFiles,
} from "$lib/server/services/file-production/read-model";
import {
	getConversationContextStatus,
	getConversationWorkingSet,
	listConversationArtifacts,
} from "$lib/server/services/knowledge";
import { listConversationLinkedContextSources } from "$lib/server/services/linked-context-sources";
import { listMessages } from "$lib/server/services/messages";
import { getActiveSkillSession } from "$lib/server/services/skills/sessions";
import {
	attachContinuityToTaskState,
	getContextDebugState,
	getConversationTaskState,
	getProjectReferenceContext,
} from "$lib/server/services/task-state";
import { getConversationDetail } from "./read-model";

const mockGetConversation = vi.mocked(getConversation);
const mockGetConversationDraft = vi.mocked(getConversationDraft);
const mockGetConversationForkOrigin = vi.mocked(getConversationForkOrigin);
const mockListChildForksBySourceMessages = vi.mocked(
	listChildForksBySourceMessages,
);
const mockGetActiveSkillSession = vi.mocked(getActiveSkillSession);
const mockListMessages = vi.mocked(listMessages);
const mockListConversationArtifacts = vi.mocked(listConversationArtifacts);
const mockListConversationLinkedContextSources = vi.mocked(
	listConversationLinkedContextSources,
);
const mockGetConversationWorkingSet = vi.mocked(getConversationWorkingSet);
const mockGetConversationContextStatus = vi.mocked(
	getConversationContextStatus,
);
const mockGetConversationTaskState = vi.mocked(getConversationTaskState);
const mockGetContextDebugState = vi.mocked(getContextDebugState);
const mockAttachContinuityToTaskState = vi.mocked(attachContinuityToTaskState);
const mockGetProjectReferenceContext = vi.mocked(getProjectReferenceContext);
const mockListConversationGeneratedFiles = vi.mocked(
	listConversationGeneratedFiles,
);
const mockListConversationFileProductionJobs = vi.mocked(
	listConversationFileProductionJobs,
);
const mockListContextCompressionSnapshots = vi.mocked(
	listContextCompressionSnapshots,
);
const mockGetConversationCostSummary = vi.mocked(getConversationCostSummary);
const mockListConversationAtlasJobs = vi.mocked(listConversationAtlasJobs);

describe("Conversation Detail Read Model", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetConversation.mockResolvedValue({
			id: "conv-1",
			title: "Bootstrap conversation",
			projectId: null,
			sidebarPinned: false,
			sidebarSortOrder: null,
			createdAt: 1_777_140_000,
			updatedAt: 1_777_140_001,
		});
		mockGetConversationDraft.mockResolvedValue({
			conversationId: "conv-1",
			draftText: "Continue from here",
			selectedAttachmentIds: ["artifact-1"],
			selectedAttachments: [],
			selectedLinkedSources: [],
			pendingSkill: null,
			updatedAt: 1_777_140_002,
		});
		mockGetConversationForkOrigin.mockResolvedValue({
			forkConversationId: "conv-1",
			sourceConversationId: "source-conv",
			sourceAssistantMessageId: "source-assistant-1",
			sourceConversationIdAvailable: true,
			sourceAssistantMessageIdAvailable: true,
			copiedForkPointMessageId: "fork-assistant-1",
			sourceTitle: "Source title",
			forkSequence: 1,
			createdAt: 1,
		});
		mockGetActiveSkillSession.mockResolvedValue({
			id: "skill-session-1",
			conversationId: "conv-1",
			userId: "user-1",
			status: "active",
			skillOwnership: "system",
			skillDisplayName: "Meeting critic",
			skillInstructions: "SYSTEM_SENTINEL: hidden system skill instructions",
		} as never);
		mockListMessages.mockResolvedValue([]);
		mockListChildForksBySourceMessages.mockResolvedValue({});
		mockListConversationArtifacts.mockResolvedValue([]);
		mockListConversationLinkedContextSources.mockResolvedValue([]);
		mockGetConversationWorkingSet.mockResolvedValue([]);
		mockGetConversationContextStatus.mockResolvedValue(null);
		mockGetConversationTaskState.mockResolvedValue(null);
		mockGetContextDebugState.mockResolvedValue(null);
		mockAttachContinuityToTaskState.mockImplementation(
			async (_userId, taskState) => taskState,
		);
		mockGetProjectReferenceContext.mockResolvedValue(null);
		mockListConversationGeneratedFiles.mockResolvedValue([]);
		mockListConversationFileProductionJobs.mockResolvedValue([]);
		mockListConversationAtlasJobs.mockResolvedValue([]);
		mockListContextCompressionSnapshots.mockResolvedValue([]);
		mockGetConversationCostSummary.mockResolvedValue({
			totalCostUsdMicros: 0,
			totalTokens: 0,
		});
	});

	it("returns the cheap bootstrap detail payload with stable defaults", async () => {
		const detail = await getConversationDetail({
			userId: "user-1",
			conversationId: "conv-1",
			view: "bootstrap",
		});

		expect(mockGetConversation).toHaveBeenCalledWith("user-1", "conv-1");
		expect(mockGetConversationDraft).toHaveBeenCalledWith("user-1", "conv-1");
		expect(mockGetConversationForkOrigin).toHaveBeenCalledWith("conv-1");
		expect(mockGetActiveSkillSession).toHaveBeenCalledWith("user-1", "conv-1");
		expect(mockListMessages).not.toHaveBeenCalled();
		expect(mockListConversationArtifacts).not.toHaveBeenCalled();
		expect(mockGetConversationTaskState).not.toHaveBeenCalled();
		expect(mockListConversationGeneratedFiles).not.toHaveBeenCalled();
		expect(mockListConversationFileProductionJobs).not.toHaveBeenCalled();
		expect(mockListConversationAtlasJobs).not.toHaveBeenCalled();
		expect(mockListContextCompressionSnapshots).not.toHaveBeenCalled();
		expect(mockGetConversationCostSummary).not.toHaveBeenCalled();
		expect(detail).toMatchObject({
			conversation: {
				id: "conv-1",
				title: "Bootstrap conversation",
			},
			messages: [],
			attachedArtifacts: [],
			activeWorkingSet: [],
			contextStatus: null,
			contextSources: null,
			taskState: null,
			contextDebug: null,
			fileProductionJobs: [],
			atlasJobs: [],
			contextCompressionSnapshots: [],
			bootstrap: true,
		});
		expect(detail?.draft?.draftText).toBe("Continue from here");
		expect(detail?.forkOrigin?.sourceTitle).toBe("Source title");
		expect(detail?.activeSkillSession).toMatchObject({
			id: "skill-session-1",
			status: "active",
			skillDisplayName: "Meeting critic",
		});
		expect(detail?.activeSkillSession).not.toHaveProperty("skillInstructions");
		expect(JSON.stringify(detail)).not.toContain("SYSTEM_SENTINEL");
	});

	it("returns first-render chat detail without waiting for sidecar depth", async () => {
		mockListMessages.mockResolvedValue([
			{
				id: "user-message-1",
				conversationId: "conv-1",
				role: "user",
				content: "Draft a report",
				createdAt: 1,
			},
			{
				id: "assistant-message-1",
				conversationId: "conv-1",
				role: "assistant",
				content: "Working on it",
				createdAt: 2,
			},
		] as never);
		mockListChildForksBySourceMessages.mockResolvedValue({
			"assistant-message-1": {
				count: 1,
				forks: [
					{
						conversationId: "fork-1",
						title: "Forked answer",
						forkSequence: 1,
						createdAt: 2,
					},
				],
			},
		});
		const detail = await getConversationDetail({
			userId: "user-1",
			conversationId: "conv-1",
			view: "first-render",
		});

		expect(mockListMessages).toHaveBeenCalledWith("conv-1");
		expect(mockListChildForksBySourceMessages).toHaveBeenCalledWith("user-1", [
			"assistant-message-1",
		]);
		expect(mockGetConversationDraft).toHaveBeenCalledWith("user-1", "conv-1");
		expect(mockGetConversationForkOrigin).toHaveBeenCalledWith("conv-1");
		expect(mockGetActiveSkillSession).toHaveBeenCalledWith("user-1", "conv-1");
		expect(mockListConversationArtifacts).not.toHaveBeenCalled();
		expect(mockListConversationLinkedContextSources).not.toHaveBeenCalled();
		expect(mockGetConversationWorkingSet).not.toHaveBeenCalled();
		expect(mockGetConversationContextStatus).not.toHaveBeenCalled();
		expect(mockGetConversationTaskState).not.toHaveBeenCalled();
		expect(mockGetContextDebugState).not.toHaveBeenCalled();
		expect(mockAttachContinuityToTaskState).not.toHaveBeenCalled();
		expect(mockGetProjectReferenceContext).not.toHaveBeenCalled();
		expect(mockListConversationGeneratedFiles).not.toHaveBeenCalled();
		expect(mockListConversationFileProductionJobs).not.toHaveBeenCalled();
		expect(mockListConversationAtlasJobs).not.toHaveBeenCalled();
		expect(mockListContextCompressionSnapshots).not.toHaveBeenCalled();
		expect(mockGetConversationCostSummary).not.toHaveBeenCalled();
		expect(detail).toMatchObject({
			conversation: {
				id: "conv-1",
			},
			messages: [
				expect.objectContaining({ id: "user-message-1" }),
				expect.objectContaining({
					id: "assistant-message-1",
					sourceForks: expect.objectContaining({ count: 1 }),
				}),
			],
			attachedArtifacts: [],
			activeWorkingSet: [],
			contextStatus: null,
			contextSources: null,
			taskState: null,
			contextDebug: null,
			fileProductionJobs: [],
			atlasJobs: [],
			contextCompressionSnapshots: [],
			bootstrap: false,
			sidecarPending: true,
		});
		expect(detail?.draft?.draftText).toBe("Continue from here");
		expect(detail?.activeSkillSession).toMatchObject({
			id: "skill-session-1",
			skillDisplayName: "Meeting critic",
		});
		expect(JSON.stringify(detail)).not.toContain("SYSTEM_SENTINEL");
	});

	it("returns full conversation detail payload pieces from read services", async () => {
		mockListMessages.mockResolvedValue([
			{
				id: "user-message-1",
				conversationId: "conv-1",
				role: "user",
				content: "Draft a report",
				createdAt: 1_777_140_010,
			},
		] as never);
		mockListConversationArtifacts.mockResolvedValue([
			{
				id: "artifact-attached-1",
				type: "source_document",
				retrievalClass: "durable",
				name: "Attached source",
				mimeType: "text/plain",
				sizeBytes: 1024,
				conversationId: "conv-1",
				summary: null,
				createdAt: 1_777_140_000,
				updatedAt: 1_777_140_001,
			},
		]);
		mockGetConversationWorkingSet.mockResolvedValue([
			{
				id: "artifact-working-1",
				type: "source_document",
				retrievalClass: "durable",
				name: "Working source",
				mimeType: "text/plain",
				sizeBytes: 2048,
				conversationId: "conv-1",
				summary: null,
				createdAt: 1_777_140_000,
				updatedAt: 1_777_140_001,
			},
		]);
		mockGetConversationTaskState.mockResolvedValue({
			id: "task-1",
			objective: "Draft the report",
		} as never);
		mockAttachContinuityToTaskState.mockResolvedValue({
			id: "task-1",
			objective: "Draft the report",
			continuityAttached: true,
		} as never);
		mockListConversationGeneratedFiles.mockResolvedValue([
			{
				id: "generated-file-1",
				filename: "report.docx",
				mimeType:
					"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				sizeBytes: 4096,
				downloadUrl: "/api/chat/files/generated-file-1/download",
			},
		] as never);
		mockListConversationFileProductionJobs.mockResolvedValue([
			{
				id: "job-1",
				conversationId: "conv-1",
				status: "succeeded",
				files: [],
				warnings: [],
				error: null,
			},
		] as never);
		mockListConversationAtlasJobs.mockResolvedValue([
			{
				id: "atlas-job-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-atlas-1",
				action: "create",
				parentAtlasJobId: null,
				profile: "in-depth",
				title: "Atlas research",
				status: "queued",
				stage: "queued",
				progress: {
					percent: 0,
					stage: "queued",
					details: { queries: [] },
				},
				sourceCounts: {
					local: 0,
					web: 0,
					accepted: 0,
					rejected: 0,
				},
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
				createdAt: 1_777_140_020,
				updatedAt: 1_777_140_021,
				completedAt: null,
			},
		]);
		mockListContextCompressionSnapshots.mockResolvedValue([
			{
				id: "snapshot-1",
				trigger: "automatic",
				status: "valid",
				sourceEndMessageId: "assistant-1",
				createdAt: new Date(1_777_140_020_000),
				updatedAt: new Date(1_777_140_021_000),
				estimatedTokens: 12_000,
				sourceTokenEstimate: 48_000,
			},
		] as never);
		mockGetConversationCostSummary.mockResolvedValue({
			totalCostUsdMicros: 123_456,
			totalTokens: 7890,
		});

		const detail = await getConversationDetail({
			userId: "user-1",
			conversationId: "conv-1",
		});

		expect(mockListMessages).toHaveBeenCalledWith("conv-1");
		expect(mockListConversationGeneratedFiles).toHaveBeenCalledWith("conv-1");
		expect(mockListConversationAtlasJobs).toHaveBeenCalledWith(
			"user-1",
			"conv-1",
		);
		expect(mockAttachContinuityToTaskState).toHaveBeenCalledWith("user-1", {
			id: "task-1",
			objective: "Draft the report",
		});
		expect(detail).toMatchObject({
			conversation: {
				id: "conv-1",
			},
			messages: [expect.objectContaining({ id: "user-message-1" })],
			attachedArtifacts: [
				expect.objectContaining({ id: "artifact-attached-1" }),
			],
			activeWorkingSet: [expect.objectContaining({ id: "artifact-working-1" })],
			taskState: {
				id: "task-1",
				continuityAttached: true,
			},
			generatedFiles: [
				expect.objectContaining({
					id: "generated-file-1",
					filename: "report.docx",
				}),
			],
			fileProductionJobs: [expect.objectContaining({ id: "job-1" })],
			atlasJobs: [
				expect.objectContaining({
					id: "atlas-job-1",
					profile: "in-depth",
					status: "queued",
				}),
			],
			contextCompressionSnapshots: [
				{
					id: "snapshot-1",
					trigger: "automatic",
					status: "valid",
					sourceEndMessageId: "assistant-1",
					createdAt: 1_777_140_020_000,
					updatedAt: 1_777_140_021_000,
					estimatedTokens: 12_000,
					sourceTokenEstimate: 48_000,
				},
			],
			activeSkillSession: expect.objectContaining({
				id: "skill-session-1",
			}),
			bootstrap: false,
			totalCostUsdMicros: 123_456,
			totalTokens: 7890,
		});
	});

	it("decorates only assistant messages with child fork metadata", async () => {
		mockListMessages.mockResolvedValue([
			{
				id: "user-message-1",
				conversationId: "conv-1",
				role: "user",
				content: "Question",
				createdAt: 1,
			},
			{
				id: "assistant-message-1",
				conversationId: "conv-1",
				role: "assistant",
				content: "Answer",
				createdAt: 2,
				depthMetadata: {
					requested: "auto",
					appliedProfile: "standard",
					fallback: false,
					modelId: "model1",
					modelDisplayName: "Model 1",
				},
			},
		] as never);
		mockListChildForksBySourceMessages.mockResolvedValue({
			"user-message-1": {
				count: 1,
				forks: [
					{
						conversationId: "invalid-user-fork",
						title: "Should not attach",
						forkSequence: 1,
						createdAt: 1,
					},
				],
			},
			"assistant-message-1": {
				count: 2,
				forks: [
					{
						conversationId: "fork-1",
						title: "Answer fork",
						forkSequence: 1,
						createdAt: 2,
					},
				],
			},
		});

		const detail = await getConversationDetail({
			userId: "user-1",
			conversationId: "conv-1",
		});

		expect(mockListChildForksBySourceMessages).toHaveBeenCalledWith("user-1", [
			"assistant-message-1",
		]);
		expect(detail?.messages).toEqual([
			expect.not.objectContaining({ sourceForks: expect.anything() }),
			expect.objectContaining({
				id: "assistant-message-1",
				depthMetadata: {
					requested: "auto",
					appliedProfile: "standard",
					fallback: false,
					modelId: "model1",
					modelDisplayName: "Model 1",
				},
				sourceForks: {
					count: 2,
					forks: [expect.objectContaining({ conversationId: "fork-1" })],
				},
			}),
		]);
	});

	it("keeps detail available with empty Context Sources when project reference lookup fails", async () => {
		mockGetProjectReferenceContext.mockRejectedValue(
			new Error("folder lookup failed"),
		);

		const detail = await getConversationDetail({
			userId: "user-1",
			conversationId: "conv-1",
		});

		expect(mockGetProjectReferenceContext).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
		});
		expect(detail?.contextSources).toMatchObject({
			conversationId: "conv-1",
			userId: "user-1",
			groups: [],
		});
	});

	it("returns project folder and selected source groups through Context Sources", async () => {
		mockGetConversationContextStatus.mockResolvedValue({
			conversationId: "conv-1",
			userId: "user-1",
			estimatedTokens: 70_000,
			maxContextTokens: 100_000,
			thresholdTokens: 80_000,
			targetTokens: 90_000,
			compactionApplied: true,
			compactionMode: "deterministic",
			routingStage: "semantic",
			routingConfidence: 0.82,
			verificationStatus: "passed",
			layersUsed: ["working_set"],
			workingSetCount: 1,
			workingSetArtifactIds: ["artifact-working-1"],
			workingSetApplied: true,
			taskStateApplied: false,
			promptArtifactCount: 1,
			recentTurnCount: 2,
			summary: null,
			updatedAt: 1_777_140_000,
		});
		mockListConversationArtifacts.mockResolvedValue([
			{
				id: "artifact-attached-1",
				type: "source_document",
				retrievalClass: "durable",
				name: "Attached source",
				mimeType: "text/plain",
				sizeBytes: 1024,
				conversationId: "conv-1",
				summary: null,
				createdAt: 1_777_140_000,
				updatedAt: 1_777_140_001,
			},
		]);
		mockGetConversationWorkingSet.mockResolvedValue([
			{
				id: "artifact-working-1",
				type: "source_document",
				retrievalClass: "durable",
				name: "Working source",
				mimeType: "text/plain",
				sizeBytes: 2048,
				conversationId: "conv-1",
				summary: null,
				createdAt: 1_777_140_000,
				updatedAt: 1_777_140_001,
			},
		]);
		mockGetContextDebugState.mockResolvedValue({
			activeTaskId: null,
			activeTaskObjective: null,
			taskLocked: false,
			routingStage: "semantic",
			routingConfidence: 0.82,
			verificationStatus: "passed",
			selectedEvidence: [],
			selectedEvidenceBySource: [],
			pinnedEvidence: [
				{
					artifactId: "artifact-pinned-1",
					name: "Pinned source",
					artifactType: "source_document",
					sourceType: "document",
					role: "pinned",
					origin: "user",
					confidence: 1,
					reason: "Pinned by user",
				},
			],
			excludedEvidence: [],
		});
		mockGetProjectReferenceContext.mockResolvedValue({
			source: "project_folder",
			projectId: "folder-1",
			projectName: "Launch folder",
			entries: [
				{
					conversationId: "conv-sibling-1",
					title: "Pricing notes",
					objective: "Compare pricing options",
					summary: "Stable pricing brief.",
				},
				{
					conversationId: "conv-sibling-2",
					title: "Rollout plan",
					objective: null,
					summary: null,
				},
			],
			omittedSiblingCount: 1,
		});

		const detail = await getConversationDetail({
			userId: "user-1",
			conversationId: "conv-1",
		});

		expect(detail?.contextSources).toMatchObject({
			conversationId: "conv-1",
			userId: "user-1",
			activeCount: 3,
			pinnedCount: 1,
			excludedCount: 0,
			reduced: true,
			compacted: true,
		});
		expect(
			detail?.contextSources?.groups.map(
				(group: { kind: string }) => group.kind,
			),
		).toEqual(["attachments", "working_set", "pinned", "project_folder"]);
		expect(detail?.contextSources?.groups.at(-1)).toMatchObject({
			kind: "project_folder",
			state: "inferred",
			totalCount: 3,
			items: [
				expect.objectContaining({
					title: "Launch folder",
					sourceType: "conversation",
					reason: "2 sibling conversations summarized, 1 more omitted",
					metadata: expect.objectContaining({
						siblingCount: 3,
						includedSiblingCount: 2,
						omittedSiblingCount: 1,
					}),
				}),
			],
		});
	});

	it("returns durable linked source groups through Context Sources after refresh", async () => {
		mockListConversationLinkedContextSources.mockResolvedValue([
			{
				displayArtifactId: "display-1",
				promptArtifactId: "prompt-1",
				familyArtifactIds: ["display-1", "prompt-1"],
				name: "Discovery notes.pdf",
				type: "document",
				mimeType: "application/pdf",
				documentOrigin: "uploaded",
			},
		]);

		const detail = await getConversationDetail({
			userId: "user-1",
			conversationId: "conv-1",
		});

		expect(mockListConversationLinkedContextSources).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
		});
		expect(detail?.contextSources?.groups).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "linked_source",
					state: "active",
					items: [
						expect.objectContaining({
							id: "linked_source:display-1",
							artifactId: "display-1",
							title: "Discovery notes.pdf",
							reason: "linked_context_source",
							metadata: expect.objectContaining({
								promptArtifactId: "prompt-1",
								documentOrigin: "uploaded",
							}),
						}),
					],
				}),
			]),
		);
	});
});
