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

vi.mock("$lib/server/services/messages", () => ({
	listMessageWindow: vi.fn(),
	artifactCallIdsFromMessages: vi.fn(),
	regenerableArtifactIdsFromMessages: vi.fn(),
	CONVERSATION_MESSAGE_WINDOW_DEFAULT_LIMIT: 100,
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

vi.mock("$lib/server/services/artifacts", () => ({
	listArtifactsForConversation: vi.fn(),
	listMissingArtifactIds: vi.fn(),
}));

import { getConversationCostSummary } from "$lib/server/services/analytics";
import {
	listArtifactsForConversation,
	listMissingArtifactIds,
} from "$lib/server/services/artifacts";
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
import {
	artifactCallIdsFromMessages,
	listMessageWindow,
	regenerableArtifactIdsFromMessages,
} from "$lib/server/services/messages";
import {
	attachContinuityToTaskState,
	getContextDebugState,
	getConversationTaskState,
	getProjectReferenceContext,
} from "$lib/server/services/task-state";
import {
	hasSourceHost,
	hasSourceThumbnail,
	resetUrlProvenanceForTests,
} from "$lib/server/services/url-provenance";
import {
	getConversationDetail,
	getOlderConversationMessages,
} from "./read-model";

const mockGetConversation = vi.mocked(getConversation);
const mockGetConversationDraft = vi.mocked(getConversationDraft);
const mockGetConversationForkOrigin = vi.mocked(getConversationForkOrigin);
const mockListChildForksBySourceMessages = vi.mocked(
	listChildForksBySourceMessages,
);
const mockListMessageWindow = vi.mocked(listMessageWindow);
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
const mockListArtifactsForConversation = vi.mocked(
	listArtifactsForConversation,
);
const mockArtifactCallIdsFromMessages = vi.mocked(artifactCallIdsFromMessages);
const mockRegenerableArtifactIdsFromMessages = vi.mocked(
	regenerableArtifactIdsFromMessages,
);
const mockListMissingArtifactIds = vi.mocked(listMissingArtifactIds);

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
		mockListMessageWindow.mockResolvedValue({
			messages: [],
			hasMoreBefore: false,
		});
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
		mockListArtifactsForConversation.mockResolvedValue([]);
		mockArtifactCallIdsFromMessages.mockReturnValue([]);
		mockRegenerableArtifactIdsFromMessages.mockReturnValue([]);
		mockListMissingArtifactIds.mockResolvedValue({
			deleted: [],
			unreachable: [],
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
		expect(mockListMessageWindow).not.toHaveBeenCalled();
		expect(mockListConversationArtifacts).not.toHaveBeenCalled();
		expect(mockGetConversationTaskState).not.toHaveBeenCalled();
		expect(mockListConversationGeneratedFiles).not.toHaveBeenCalled();
		expect(mockListConversationFileProductionJobs).not.toHaveBeenCalled();
		expect(mockListConversationAtlasJobs).not.toHaveBeenCalled();
		expect(mockListContextCompressionSnapshots).not.toHaveBeenCalled();
		expect(mockGetConversationCostSummary).not.toHaveBeenCalled();
		expect(mockListArtifactsForConversation).not.toHaveBeenCalled();
		expect(detail).toMatchObject({
			conversation: {
				id: "conv-1",
				title: "Bootstrap conversation",
			},
			messages: [],
			attachedArtifacts: [],
			activeWorkingSet: [],
			contextStatus: null,
			taskState: null,
			contextDebug: null,
			fileProductionJobs: [],
			atlasJobs: [],
			contextCompressionSnapshots: [],
			artifacts: [],
			bootstrap: true,
			hasMoreMessages: false,
		});
		expect(detail?.draft?.draftText).toBe("Continue from here");
		expect(detail?.forkOrigin?.sourceTitle).toBe("Source title");
	});

	it("returns full conversation detail payload pieces from read services", async () => {
		mockListMessageWindow.mockResolvedValue({
			messages: [
				{
					id: "user-message-1",
					conversationId: "conv-1",
					role: "user",
					content: "Draft a report",
					createdAt: 1_777_140_010,
				},
			] as never,
			hasMoreBefore: true,
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
				pipelineVersion: 1,
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
		mockListArtifactsForConversation.mockResolvedValue([
			{
				id: "artifact-doc-1",
				kind: "document",
				title: "Weekend checklist",
				conversationId: "conv-1",
				versionNumber: 2,
				commentCount: 1,
				updatedAt: 1_777_140_030,
			},
		]);

		const detail = await getConversationDetail({
			userId: "user-1",
			conversationId: "conv-1",
		});

		expect(mockListMessageWindow).toHaveBeenCalledWith("conv-1", {
			limit: 100,
		});
		expect(mockListArtifactsForConversation).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
		});
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
			artifacts: [
				expect.objectContaining({
					id: "artifact-doc-1",
					kind: "document",
					versionNumber: 2,
				}),
			],
			bootstrap: false,
			hasMoreMessages: true,
			totalCostUsdMicros: 123_456,
			totalTokens: 7890,
		});
	});

	// Ruling 20: the field is typed through ArtifactCardSummary, never the
	// knowledge-side ArtifactSummary aliased into place — this is exercised
	// implicitly above (the mock resolves ArtifactCardSummary-shaped rows,
	// which only satisfies the field's real type), and explicitly here: the
	// call itself carries the conversation scope the panel list and the
	// header count both need, not a second query shape.
	// Polish G2-A: a card that points at a deleted item must be able to say so.
	// The tool calls name the artifacts (messages.ts); the artifact service
	// says which of them are gone, under the ownership scope (never a second
	// scope of the read model's own).
	it("returns the ids of the artifacts this chat's tool calls named that no longer exist, and separately the ones that exist out of its reach", async () => {
		const loaded = [
			{
				id: "assistant-1",
				conversationId: "conv-1",
				role: "assistant" as const,
				content: "Made it.",
				timestamp: 1_777_140_010,
				createdAt: 1_777_140_010,
			},
		];
		mockListMessageWindow.mockResolvedValue({
			messages: loaded,
			hasMoreBefore: false,
		});
		mockArtifactCallIdsFromMessages.mockReturnValue([
			"doc-1",
			"doc-2",
			"doc-3",
		]);
		mockListMissingArtifactIds.mockResolvedValue({
			deleted: ["doc-2"],
			unreachable: ["doc-3"],
		});

		const detail = await getConversationDetail({
			userId: "user-1",
			conversationId: "conv-1",
		});

		// Read off the messages already loaded — no second look at the table.
		expect(mockArtifactCallIdsFromMessages).toHaveBeenCalledWith(loaded);
		expect(mockListMissingArtifactIds).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			artifactIds: ["doc-1", "doc-2", "doc-3"],
		});
		expect(detail?.deletedArtifactIds).toEqual(["doc-2"]);
		// Exists, but not from here (the parent of a forked incognito chat): the
		// card says where it was made instead of calling it deleted.
		expect(detail?.unreachableArtifactIds).toEqual(["doc-3"]);
	});

	// The security review's L2: an item the chat can make again says so (the
	// delete confirm reads it): the ones the loaded messages made or kept, and a
	// produced file whose one job kept its request.
	describe("regenerable artifacts", () => {
		const summary = (id: string, kind: "document" | "app" | "file") => ({
			id,
			kind,
			title: id,
			conversationId: "conv-1",
			versionNumber: 1,
			commentCount: 0,
			updatedAt: 1,
		});
		const fileJob = (
			id: string,
			files: Array<{ artifactId: string | null }>,
			canRegenerate?: true,
		) =>
			({
				id,
				conversationId: "conv-1",
				title: id,
				status: "succeeded",
				createdAt: 1,
				updatedAt: 1,
				files: files.map((file, index) => ({
					id: `${id}-file-${index}`,
					filename: `${id}-${index}.pdf`,
					mimeType: "application/pdf",
					sizeBytes: 1,
					downloadUrl: "",
					previewUrl: null,
					artifactId: file.artifactId,
				})),
				warnings: [],
				dismissed: false,
				...(canRegenerate ? { canRegenerate } : {}),
			}) as never;

		it("flags a Document or App a message can make again, and no other", async () => {
			const loaded = [
				{
					id: "assistant-1",
					conversationId: "conv-1",
					role: "assistant" as const,
					content: "Made it.",
					timestamp: 1,
					createdAt: 1,
				},
			];
			mockListMessageWindow.mockResolvedValue({
				messages: loaded,
				hasMoreBefore: false,
			});
			mockRegenerableArtifactIdsFromMessages.mockReturnValue([
				"doc-made",
				"doc-kept",
			]);
			mockListArtifactsForConversation.mockResolvedValue([
				summary("doc-made", "document"),
				summary("doc-kept", "document"),
				summary("doc-copy", "document"),
				summary("app-old", "app"),
			]);

			const detail = await getConversationDetail({
				userId: "user-1",
				conversationId: "conv-1",
			});

			expect(mockRegenerableArtifactIdsFromMessages).toHaveBeenCalledWith(
				loaded,
			);
			expect(
				detail?.artifacts?.map((row) => [row.id, row.regenerable]),
			).toEqual([
				["doc-made", true],
				["doc-kept", true],
				["doc-copy", undefined],
				["app-old", undefined],
			]);
		});

		it("flags a produced file only when the job that made it kept its request and made nothing else", async () => {
			mockListArtifactsForConversation.mockResolvedValue([
				summary("file-single", "file"),
				summary("file-legacy", "file"),
				summary("file-shared-a", "file"),
				summary("file-shared-b", "file"),
			]);
			mockListConversationFileProductionJobs.mockResolvedValue([
				fileJob("job-single", [{ artifactId: "file-single" }], true),
				fileJob("job-legacy", [{ artifactId: "file-legacy" }]),
				// Two artifacts from one job: deleting one leaves the other, and a job
				// with a file left cannot be made again.
				fileJob(
					"job-shared",
					[{ artifactId: "file-shared-a" }, { artifactId: "file-shared-b" }],
					true,
				),
			]);

			const detail = await getConversationDetail({
				userId: "user-1",
				conversationId: "conv-1",
			});

			expect(
				detail?.artifacts?.map((row) => [row.id, row.regenerable]),
			).toEqual([
				["file-single", true],
				["file-legacy", undefined],
				["file-shared-a", undefined],
				["file-shared-b", undefined],
			]);
		});

		it("leaves the list exactly as the artifact service gave it when nothing can be made again", async () => {
			const rows = [summary("doc-copy", "document")];
			mockListArtifactsForConversation.mockResolvedValue(rows);

			const detail = await getConversationDetail({
				userId: "user-1",
				conversationId: "conv-1",
			});

			expect(detail?.artifacts).toBe(rows);
		});
	});

	it("reports none deleted when no tool call named an artifact", async () => {
		const detail = await getConversationDetail({
			userId: "user-1",
			conversationId: "conv-1",
		});

		expect(detail?.deletedArtifactIds).toEqual([]);
		expect(detail?.unreachableArtifactIds).toEqual([]);
	});

	it("scopes the artifacts call to the same user and conversation as everything else", async () => {
		await getConversationDetail({
			userId: "user-2",
			conversationId: "conv-2",
		});

		expect(mockListArtifactsForConversation).toHaveBeenCalledWith({
			userId: "user-2",
			conversationId: "conv-2",
		});
		expect(mockListArtifactsForConversation).toHaveBeenCalledTimes(1);
	});

	it("decorates only assistant messages with child fork metadata", async () => {
		mockListMessageWindow.mockResolvedValue({
			messages: [
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
			] as never,
			hasMoreBefore: false,
		});
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

	it("does not expose contextSources and no longer fetches its projection-only sources", async () => {
		const detail = await getConversationDetail({
			userId: "user-1",
			conversationId: "conv-1",
		});

		expect(detail).not.toBeNull();
		// The retired Context Sources panel was the only consumer of the
		// projection, so the detail payload must stop assembling one.
		expect(detail).not.toHaveProperty("contextSources");
		// Linked sources and the project reference still feed chat-turn
		// selection, but the detail read model must no longer pay for the two
		// extra queries that existed only to feed the projection.
		expect(mockListConversationLinkedContextSources).not.toHaveBeenCalled();
		expect(mockGetProjectReferenceContext).not.toHaveBeenCalled();
	});

	it("carries the deleted-artifact ids of an older page too, read off that page's own messages", async () => {
		const older = [
			{
				id: "assistant-old",
				conversationId: "conv-1",
				role: "assistant" as const,
				content: "Made it a while ago.",
				timestamp: 1_777_100_000,
				createdAt: 1_777_100_000,
			},
		];
		mockListMessageWindow.mockResolvedValue({
			messages: older,
			hasMoreBefore: true,
		});
		mockArtifactCallIdsFromMessages.mockReturnValue(["doc-old", "doc-away"]);
		mockListMissingArtifactIds.mockResolvedValue({
			deleted: ["doc-old"],
			unreachable: ["doc-away"],
		});

		const page = await getOlderConversationMessages({
			userId: "user-1",
			conversationId: "conv-1",
			offset: 100,
		});

		expect(mockArtifactCallIdsFromMessages).toHaveBeenCalledWith(older);
		expect(page).toMatchObject({
			hasMoreBefore: true,
			deletedArtifactIds: ["doc-old"],
			unreachableArtifactIds: ["doc-away"],
		});
	});

	// The page asks for the icon and the picture of what a tool returned
	// (docs/plans/exfil-channels), and the server answers only for what the
	// user's source ledger holds. The ledger is in memory and empty after a
	// restart, so reading a conversation, or an older page of it, is what fills it
	// again: before the payload that names those hosts reaches the browser.
	describe("the user's source ledger", () => {
		const THUMB =
			"https://imgs.search.brave.com/Zq3s9x/rs:fit:500:0:0:0/g:ce/aHR0cHM6Ly9leGFtcGxlLmNvbS9jYXQuanBn";
		const assistantWithTools = (id: string, hostUrl: string) =>
			({
				id,
				conversationId: "conv-1",
				role: "assistant" as const,
				content: "Found it.",
				timestamp: 1_777_140_020,
				thinkingSegments: [
					{
						type: "tool_call" as const,
						name: "research_web",
						input: { query: "q" },
						status: "done" as const,
						candidates: [
							{
								id: "c1",
								title: "Source",
								url: hostUrl,
								sourceType: "web" as const,
							},
						],
					},
					{
						type: "tool_call" as const,
						name: "image_search",
						input: { query: "cat" },
						status: "done" as const,
						candidates: [
							{
								id: "c2",
								title: "Cat",
								url: "https://pics.example/cat.jpg",
								sourceType: "web" as const,
								metadata: { thumbnail: THUMB },
							},
						],
					},
				],
			}) as never;

		beforeEach(() => resetUrlProvenanceForTests());

		it("notes the hosts and thumbnails the loaded messages' tool calls returned, for that user only", async () => {
			mockListMessageWindow.mockResolvedValue({
				messages: [
					assistantWithTools("assistant-1", "https://stored.example/a"),
				],
				hasMoreBefore: false,
			});

			await getConversationDetail({
				userId: "user-1",
				conversationId: "conv-1",
			});

			expect(hasSourceHost("user-1", "stored.example")).toBe(true);
			expect(hasSourceHost("user-1", "pics.example")).toBe(true);
			expect(hasSourceThumbnail("user-1", THUMB)).toBe(true);
			expect(hasSourceHost("user-2", "stored.example")).toBe(false);
		});

		it("notes the web sources of the conversation's Atlas cards", async () => {
			mockListConversationAtlasJobs.mockResolvedValue([
				{
					id: "atlas-1",
					progress: {
						percent: 100,
						stage: "done",
						details: {
							pipelineVersion: 3,
							evidence: {
								sources: [
									{
										n: 1,
										title: "A",
										host: "atlas-source.example",
										kind: "web",
									},
									{ n: 2, title: "B", host: "", kind: "local" },
								],
							},
						},
					},
				},
			] as never);

			await getConversationDetail({
				userId: "user-1",
				conversationId: "conv-1",
			});

			expect(hasSourceHost("user-1", "atlas-source.example")).toBe(true);
		});

		it("notes nothing for a conversation the user does not own: it is not read at all", async () => {
			mockGetConversation.mockResolvedValue(null);
			mockListMessageWindow.mockResolvedValue({
				messages: [
					assistantWithTools("assistant-1", "https://stored.example/a"),
				],
				hasMoreBefore: false,
			});

			const detail = await getConversationDetail({
				userId: "user-1",
				conversationId: "conv-1",
			});
			const older = await getOlderConversationMessages({
				userId: "user-1",
				conversationId: "conv-1",
				offset: 100,
			});

			expect(detail).toBeNull();
			expect(older).toBeNull();
			expect(hasSourceHost("user-1", "stored.example")).toBe(false);
		});

		it("notes what an older page's tool calls returned too", async () => {
			mockListMessageWindow.mockResolvedValue({
				messages: [
					assistantWithTools("assistant-old", "https://older.example/a"),
				],
				hasMoreBefore: true,
			});

			await getOlderConversationMessages({
				userId: "user-1",
				conversationId: "conv-1",
				offset: 100,
			});

			expect(hasSourceHost("user-1", "older.example")).toBe(true);
			expect(hasSourceThumbnail("user-1", THUMB)).toBe(true);
		});
	});
});
