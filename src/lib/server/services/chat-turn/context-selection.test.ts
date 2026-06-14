import { beforeEach, describe, expect, it, vi } from "vitest";
import { estimateTokenCount } from "$lib/utils/tokens";
import {
	buildConstructedContext,
	selectPromptContext,
} from "./context-selection";

const mocks = vi.hoisted(() => ({
	loadHonchoPromptContext: vi.fn(),
	getConfig: vi.fn(),
	resolvePromptAttachmentArtifacts: vi.fn(),
	listConversationSourceArtifactIds: vi.fn(),
	listConversationSourceArtifactNames: vi.fn(async () => []),
	listConversationLinkedContextSources: vi.fn(),
	selectWorkingSetArtifactsForPrompt: vi.fn(),
	findRelevantKnowledgeArtifacts: vi.fn(),
	getArtifactsForUser: vi.fn(),
	getCompactionUiThreshold: vi.fn(),
	getMaxModelContext: vi.fn(),
	getTargetConstructedContext: vi.fn(),
	updateConversationContextStatus: vi.fn(),
	getConversationProjectLabel: vi.fn(),
	getConversationForkOrigin: vi.fn(),
	getProjectReferenceContext: vi.fn(),
	selectProjectFolderSiblingPromotion: vi.fn(),
	prepareTaskContext: vi.fn(),
	formatTaskStateForPrompt: vi.fn(),
	getPromptArtifactSnippets: vi.fn(),
	getContextDebugState: vi.fn(),
	embedTexts: vi.fn(),
	canUseTeiReranker: vi.fn(),
	rerankItems: vi.fn(),
	resolveWorkingDocumentSelection: vi.fn(),
	getLatestValidContextCompressionSnapshot: vi.fn(),
}));

vi.mock("../honcho", () => ({
	loadHonchoPromptContext: mocks.loadHonchoPromptContext,
}));

vi.mock("../../config-store", () => ({
	getConfig: mocks.getConfig,
}));

vi.mock("../knowledge", () => ({
	AttachmentReadinessError: class AttachmentReadinessError extends Error {
		artifactIds: string[];

		constructor(message: string, artifactIds: string[]) {
			super(message);
			this.artifactIds = artifactIds;
		}
	},
	findRelevantKnowledgeArtifacts: mocks.findRelevantKnowledgeArtifacts,
	getArtifactsForUser: mocks.getArtifactsForUser,
	getCompactionUiThreshold: mocks.getCompactionUiThreshold,
	getMaxModelContext: mocks.getMaxModelContext,
	getTargetConstructedContext: mocks.getTargetConstructedContext,
	listConversationSourceArtifactIds: mocks.listConversationSourceArtifactIds,
	listConversationSourceArtifactNames:
		mocks.listConversationSourceArtifactNames,
	resolvePromptAttachmentArtifacts: mocks.resolvePromptAttachmentArtifacts,
	selectWorkingSetArtifactsForPrompt: mocks.selectWorkingSetArtifactsForPrompt,
	updateConversationContextStatus: mocks.updateConversationContextStatus,
	WORKING_SET_DOCUMENT_TOKEN_BUDGET: 4_000,
	WORKING_SET_OUTPUT_TOKEN_BUDGET: 2_000,
	WORKING_SET_PROMPT_TOKEN_BUDGET: 20_000,
}));

vi.mock("../linked-context-sources", () => ({
	listConversationLinkedContextSources:
		mocks.listConversationLinkedContextSources,
}));

vi.mock("../messages", () => ({
	getLatestHonchoMetadata: vi.fn(),
	listMessages: vi.fn(),
}));

vi.mock("../projects", () => ({
	getConversationProjectLabel: mocks.getConversationProjectLabel,
}));

vi.mock("../conversation-forks", () => ({
	getConversationForkOrigin: mocks.getConversationForkOrigin,
}));

vi.mock("../task-state", () => ({
	formatTaskStateForPrompt: mocks.formatTaskStateForPrompt,
	getContextDebugState: mocks.getContextDebugState,
	getProjectReferenceContext: mocks.getProjectReferenceContext,
	getPromptArtifactSnippets: mocks.getPromptArtifactSnippets,
	prepareTaskContext: mocks.prepareTaskContext,
	selectProjectFolderSiblingPromotion:
		mocks.selectProjectFolderSiblingPromotion,
}));

vi.mock("../tei-embedder", () => ({
	embedTexts: mocks.embedTexts,
}));

vi.mock("../tei-reranker", () => ({
	canUseTeiReranker: mocks.canUseTeiReranker,
	rerankItems: mocks.rerankItems,
}));

vi.mock("../working-document-selection", () => ({
	resolveWorkingDocumentSelection: mocks.resolveWorkingDocumentSelection,
}));

vi.mock("../context-compression", () => ({
	getLatestValidContextCompressionSnapshot:
		mocks.getLatestValidContextCompressionSnapshot,
	formatContextCompressionSnapshotForPrompt: (snapshot: {
		snapshot: {
			goal?: string;
			currentState?: string;
			importantFacts?: string[];
		};
		sourceStartMessageSequence: number;
		sourceEndMessageSequence: number;
	}) =>
		[
			snapshot.snapshot.goal ? `Goal: ${snapshot.snapshot.goal}` : null,
			snapshot.snapshot.currentState
				? `Current State: ${snapshot.snapshot.currentState}`
				: null,
			snapshot.snapshot.importantFacts?.length
				? [
						"Important Facts:",
						...snapshot.snapshot.importantFacts.map((fact) => `- ${fact}`),
					].join("\n")
				: null,
			`Source Coverage: messages #${snapshot.sourceStartMessageSequence} through #${snapshot.sourceEndMessageSequence}`,
		]
			.filter((value): value is string => Boolean(value))
			.join("\n\n"),
}));

function artifact(overrides: {
	id: string;
	name: string;
	contentText?: string | null;
	conversationId?: string | null;
}) {
	return {
		id: overrides.id,
		userId: "user-1",
		conversationId: overrides.conversationId ?? "conversation-1",
		name: overrides.name,
		kind: "text",
		mimeType: "text/plain",
		sizeBytes: overrides.contentText?.length ?? 0,
		storagePath: null,
		contentText: overrides.contentText ?? null,
		metadata: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function resetConstructedContextMocks() {
	mocks.getConfig.mockReturnValue({
		contextDiagnosticsDebug: false,
	});
	mocks.getTargetConstructedContext.mockReturnValue(8_000);
	mocks.getCompactionUiThreshold.mockReturnValue(12_000);
	mocks.getMaxModelContext.mockReturnValue(16_000);
	mocks.loadHonchoPromptContext.mockResolvedValue({
		sessionMessages: [
			{
				role: "user",
				content: "Earlier question about the launch plan.",
				createdAt: 1,
			},
			{
				role: "assistant",
				content: "Earlier answer about the launch plan.",
				createdAt: 2,
			},
		],
		storedMessages: [
			{
				role: "user",
				content: "Earlier question about the launch plan.",
				createdAt: 1,
			},
			{
				role: "assistant",
				content: "Earlier answer about the launch plan.",
				createdAt: 2,
			},
		],
		summary: "The session is about launch readiness.",
		peerContext: "The user prefers concise operational plans.",
		honchoContext: {
			source: "live",
			waitedMs: 12,
			queuePendingWorkUnits: 0,
			queueInProgressWorkUnits: 0,
			fallbackReason: null,
			snapshotCreatedAt: null,
		},
		honchoSnapshot: null,
	});
	mocks.resolvePromptAttachmentArtifacts.mockResolvedValue({
		displayArtifacts: [
			artifact({
				id: "attachment-1",
				name: "launch-plan.md",
				contentText: "Launch plan body with release checklist.",
			}),
		],
		promptArtifacts: [
			artifact({
				id: "attachment-1",
				name: "launch-plan.md",
				contentText: "Launch plan body with release checklist.",
			}),
		],
		items: [],
		unresolvedItems: [],
	});
	mocks.listConversationSourceArtifactIds.mockResolvedValue([]);
	mocks.listConversationLinkedContextSources.mockResolvedValue([]);
	mocks.selectWorkingSetArtifactsForPrompt.mockResolvedValue([
		artifact({
			id: "evidence-1",
			name: "release-notes.md",
			contentText: "Evidence body with release risk notes.",
		}),
	]);
	mocks.findRelevantKnowledgeArtifacts.mockResolvedValue([]);
	mocks.getConversationProjectLabel.mockResolvedValue(null);
	mocks.getProjectReferenceContext.mockResolvedValue(null);
	mocks.selectProjectFolderSiblingPromotion.mockResolvedValue(null);
	mocks.getConversationForkOrigin.mockResolvedValue(null);
	mocks.prepareTaskContext.mockResolvedValue({
		taskState: {
			id: "task-1",
			objective: "Ship the launch plan",
		},
		routingStage: "deterministic",
		routingConfidence: 1,
		verificationStatus: "verified",
		selectedArtifacts: [
			artifact({
				id: "evidence-1",
				name: "release-notes.md",
				contentText: "Evidence body with release risk notes.",
			}),
		],
		pinnedArtifactIds: ["evidence-1"],
		excludedArtifactIds: [],
	});
	mocks.formatTaskStateForPrompt.mockReturnValue(
		"Task objective: Ship the launch plan",
	);
	mocks.getPromptArtifactSnippets.mockResolvedValue(
		new Map([
			["attachment-1", "Launch plan checklist excerpt."],
			["evidence-1", "Release risk evidence excerpt."],
		]),
	);
	mocks.getContextDebugState.mockResolvedValue(null);
	mocks.embedTexts.mockResolvedValue([]);
	mocks.canUseTeiReranker.mockReturnValue(false);
	mocks.getLatestValidContextCompressionSnapshot.mockResolvedValue(null);
	mocks.resolveWorkingDocumentSelection.mockReturnValue({
		documentFocused: true,
		retrieval: {
			hasExplicitResetSignal: false,
			suppressGeneratedCarryover: false,
			preferredArtifactId: null,
			preferredGeneratedFamilyId: null,
		},
	});
	mocks.updateConversationContextStatus.mockResolvedValue({
		estimatedTokens: 0,
		compactionApplied: false,
	});
}

describe("selectPromptContext", () => {
	it("assembles budgeted prompt context and trace sections from multiple sources", () => {
		const selected = selectPromptContext({
			intro: "Context bundle:",
			message: "What should I do next?",
			targetTokens: 140,
			candidates: [
				{
					title: "Task State",
					body: "Current task: Ship context selection.",
					source: "task_state",
					layer: "task_state",
					protected: true,
					signalReasons: ["active_task"],
				},
				{
					title: "Current Attachments",
					body: "Attachment: plan.md\nContext mode: Excerpt Context\nRelevant plan excerpt.",
					source: "attachment",
					layer: "documents",
					protected: true,
					itemIds: ["artifact-1"],
					itemTitles: ["plan.md"],
					signalReasons: ["attachment_context:excerpt"],
				},
				{
					title: "Honcho Session Context",
					body: "UNRELATED_HISTORY ".repeat(1_000),
					source: "session",
					layer: "session",
					signalReasons: ["recent_turn_context:budgeted"],
				},
			],
		});

		expect(selected.inputValue).toContain("## Task State");
		expect(selected.inputValue).toContain("## Current Attachments");
		expect(selected.inputValue).toContain("## Current User Message");
		expect(selected.inputValue).not.toContain("UNRELATED_HISTORY");
		expect(selected.estimatedTokens).toBeLessThanOrEqual(140);
		expect(estimateTokenCount(selected.inputValue)).toBe(
			selected.estimatedTokens,
		);
		expect(selected.contextTraceSections).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "Task State",
					source: "task_state",
					protected: true,
					inclusionLevel: "legacy_full",
					signalReasons: ["active_task"],
				}),
				expect.objectContaining({
					name: "Current Attachments",
					source: "attachment",
					itemIds: ["artifact-1"],
					itemTitles: ["plan.md"],
					protected: true,
				}),
				expect.objectContaining({
					name: "Honcho Session Context",
					source: "session",
					inclusionLevel: "omitted",
				}),
				expect.objectContaining({
					name: "Current User Message",
					source: "user",
				}),
			]),
		);
	});

	it("drops weaker awareness context before stronger core context under pressure", () => {
		const selected = selectPromptContext({
			intro: "Context bundle:",
			message: "Summarize the attached plan.",
			targetTokens: 70,
			candidates: [
				{
					title: "User Memory",
					body: "Weak preference memory. ".repeat(5),
					source: "memory",
					layer: "session",
					budgetPriority: "awareness",
				},
				{
					title: "Current Attachments",
					body: "Attachment: plan.md\nContext mode: Task Context\nCore attachment excerpt.",
					source: "attachment",
					layer: "documents",
					protected: true,
					budgetPriority: "core",
					signalReasons: ["attachment_context:task"],
				},
			],
		});

		expect(selected.inputValue).toContain("## Current Attachments");
		expect(selected.inputValue).not.toContain("## User Memory");
		expect(selected.contextTraceSections).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "Current Attachments",
					inclusionLevel: "legacy_full",
				}),
				expect.objectContaining({
					name: "User Memory",
					inclusionLevel: "omitted",
				}),
			]),
		);
	});
});

describe("buildConstructedContext", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("uses a shallow latency tier for simple turns and skips deep retrieval work", async () => {
		resetConstructedContextMocks();

		const constructed = await buildConstructedContext({
			userId: "user-1",
			conversationId: "conversation-1",
			message: "Thanks, that helps.",
			modelId: "local-model",
			contextLimits: {
				maxModelContext: 16_000,
				compactionUiThreshold: 12_000,
				targetConstructedContext: 8_000,
			},
		});

		expect(constructed.inputValue).toContain("## Honcho Session Context");
		expect(constructed.inputValue).toContain(
			"Earlier question about the launch plan.",
		);
		expect(constructed.inputValue).toContain("## Baseline Memory Profile");
		expect(constructed.taskState).toBeNull();
		expect(constructed.contextTraceSections).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "Current User Message",
					signalReasons: expect.arrayContaining([
						"context_latency_tier:shallow",
					]),
				}),
			]),
		);
		expect(mocks.resolvePromptAttachmentArtifacts).not.toHaveBeenCalled();
		expect(mocks.listConversationSourceArtifactIds).not.toHaveBeenCalled();
		expect(mocks.listConversationLinkedContextSources).not.toHaveBeenCalled();
		expect(mocks.selectWorkingSetArtifactsForPrompt).not.toHaveBeenCalled();
		expect(mocks.findRelevantKnowledgeArtifacts).not.toHaveBeenCalled();
		expect(mocks.prepareTaskContext).not.toHaveBeenCalled();
		expect(mocks.getPromptArtifactSnippets).not.toHaveBeenCalled();
		expect(mocks.resolveWorkingDocumentSelection).not.toHaveBeenCalled();
		expect(mocks.canUseTeiReranker).not.toHaveBeenCalled();
		expect(mocks.rerankItems).not.toHaveBeenCalled();
		expect(mocks.getLatestValidContextCompressionSnapshot).toHaveBeenCalledWith(
			{
				userId: "user-1",
				conversationId: "conversation-1",
			},
		);
		expect(mocks.getConversationForkOrigin).not.toHaveBeenCalled();
		expect(mocks.updateConversationContextStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId: "conversation-1",
				userId: "user-1",
				routingStage: "deterministic",
				verificationStatus: "skipped",
				taskStateApplied: false,
				workingSetApplied: false,
				workingSetArtifactIds: [],
				promptArtifactCount: 0,
			}),
		);
	});

	it("uses valid compression snapshots for terse shallow turns without replaying covered raw messages", async () => {
		resetConstructedContextMocks();
		mocks.loadHonchoPromptContext.mockResolvedValue({
			sessionMessages: [
				{
					id: "old-user",
					role: "user",
					content: "OLD_RAW_SECRET_USER_CONTENT",
					createdAt: 1,
					messageSequence: 1,
				},
				{
					id: "old-assistant",
					role: "assistant",
					content: "OLD_RAW_SECRET_ASSISTANT_CONTENT",
					createdAt: 2,
					messageSequence: 2,
				},
				{
					id: "new-user",
					role: "user",
					content: "NEW_RAW_RECENT_CONTENT",
					createdAt: 3,
					messageSequence: 3,
				},
			],
			storedMessages: [
				{
					id: "old-user",
					role: "user",
					content: "OLD_RAW_SECRET_USER_CONTENT",
					createdAt: 1,
					messageSequence: 1,
				},
				{
					id: "old-assistant",
					role: "assistant",
					content: "OLD_RAW_SECRET_ASSISTANT_CONTENT",
					createdAt: 2,
					messageSequence: 2,
				},
				{
					id: "new-user",
					role: "user",
					content: "NEW_RAW_RECENT_CONTENT",
					createdAt: 3,
					messageSequence: 3,
				},
			],
			summary: null,
			peerContext: "",
			honchoContext: null,
			honchoSnapshot: null,
		});
		mocks.getLatestValidContextCompressionSnapshot.mockResolvedValue({
			id: "snapshot-1",
			conversationId: "conversation-1",
			userId: "user-1",
			trigger: "manual",
			status: "valid",
			modelId: "model-1",
			sourceStartMessageId: "old-user",
			sourceEndMessageId: "old-assistant",
			sourceStartMessageSequence: 1,
			sourceEndMessageSequence: 2,
			snapshot: {
				goal: "Keep compressed continuity.",
				currentState: "Old exchange is represented by the snapshot.",
				importantFacts: ["COMPRESSED_FACT_FROM_OLD_TURNS"],
			},
			sourceCoverage: {},
			sourceRefs: [],
			estimatedTokens: 64,
			sourceTokenEstimate: 128,
			failureReason: null,
			createdAt: new Date("2026-05-15T10:00:00.000Z"),
			updatedAt: new Date("2026-05-15T10:00:00.000Z"),
		});

		const constructed = await buildConstructedContext({
			userId: "user-1",
			conversationId: "conversation-1",
			message: "Thanks.",
			modelId: "local-model",
			contextLimits: {
				maxModelContext: 16_000,
				compactionUiThreshold: 12_000,
				targetConstructedContext: 8_000,
			},
		});

		expect(constructed.inputValue).toContain("## Context Compression Snapshot");
		expect(constructed.inputValue).toContain("COMPRESSED_FACT_FROM_OLD_TURNS");
		expect(constructed.inputValue).toContain("NEW_RAW_RECENT_CONTENT");
		expect(constructed.inputValue).not.toContain("OLD_RAW_SECRET_USER_CONTENT");
		expect(constructed.inputValue).not.toContain(
			"OLD_RAW_SECRET_ASSISTANT_CONTENT",
		);
		expect(constructed.contextTraceSections).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "Current User Message",
					signalReasons: expect.arrayContaining([
						"context_latency_tier:shallow",
					]),
				}),
			]),
		);
		expect(mocks.prepareTaskContext).not.toHaveBeenCalled();
		expect(mocks.selectWorkingSetArtifactsForPrompt).not.toHaveBeenCalled();
	});

	it("combines Honcho, task, attachment, and evidence candidates from the chat-turn boundary", async () => {
		resetConstructedContextMocks();

		const constructed = await buildConstructedContext({
			userId: "user-1",
			conversationId: "conversation-1",
			message: "Review the launch plan against release risks.",
			attachmentIds: ["attachment-1"],
			modelId: "local-model",
			contextLimits: {
				maxModelContext: 16_000,
				compactionUiThreshold: 12_000,
				targetConstructedContext: 8_000,
			},
		});

		expect(constructed.inputValue).toContain("## Task State");
		expect(constructed.inputValue).toContain(
			"Task objective: Ship the launch plan",
		);
		expect(constructed.inputValue).toContain("## Current Attachments");
		expect(constructed.inputValue).toContain("launch-plan.md");
		expect(constructed.inputValue).toContain("## Retrieved Evidence");
		expect(constructed.inputValue).toContain("release-notes.md");
		expect(constructed.inputValue).toContain("## Honcho Session Context");
		expect(constructed.inputValue).toContain(
			"Earlier question about the launch plan.",
		);
		expect(constructed.inputValue).toContain("## Baseline Memory Profile");
		expect(constructed.inputValue).toContain(
			"The user prefers concise operational plans.",
		);
		expect(constructed.honchoContext).toEqual(
			expect.objectContaining({ source: "live" }),
		);
		expect(constructed.taskState).toEqual(
			expect.objectContaining({ objective: "Ship the launch plan" }),
		);
		expect(constructed.contextTraceSections).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "Current Attachments",
					source: "attachment",
					itemIds: ["attachment-1"],
				}),
				expect.objectContaining({
					name: "Retrieved Evidence",
					source: "working_set",
					itemIds: ["evidence-1"],
					signalReasons: expect.arrayContaining(["pinned_evidence"]),
				}),
				expect.objectContaining({
					name: "Honcho Session Context",
					source: "session",
				}),
				expect.objectContaining({
					name: "Baseline Memory Profile",
					source: "memory",
				}),
				expect.objectContaining({
					name: "Current User Message",
					signalReasons: expect.arrayContaining([
						"context_latency_tier:deep",
						"context_latency_reason:current_attachment",
						"context_latency_reason:context_sensitive_intent",
					]),
				}),
			]),
		);
		expect(mocks.resolvePromptAttachmentArtifacts).toHaveBeenCalled();
		expect(mocks.listConversationSourceArtifactIds).toHaveBeenCalled();
		expect(mocks.listConversationLinkedContextSources).toHaveBeenCalled();
		expect(mocks.selectWorkingSetArtifactsForPrompt).toHaveBeenCalled();
		expect(mocks.findRelevantKnowledgeArtifacts).toHaveBeenCalled();
		expect(mocks.prepareTaskContext).toHaveBeenCalled();
		expect(mocks.getPromptArtifactSnippets).toHaveBeenCalled();
		expect(mocks.resolveWorkingDocumentSelection).toHaveBeenCalled();
		expect(mocks.canUseTeiReranker).toHaveBeenCalled();
		expect(mocks.updateConversationContextStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId: "conversation-1",
				userId: "user-1",
				taskStateApplied: true,
				workingSetApplied: true,
				workingSetArtifactIds: ["evidence-1"],
			}),
		);
	});
});
