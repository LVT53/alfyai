import { beforeEach, describe, expect, it, vi } from "vitest";
import { estimateTokenCount } from "$lib/utils/tokens";
import {
	buildConstructedContext,
	selectPromptContext,
} from "./context-selection";

const mocks = vi.hoisted(() => ({
	listMessages: vi.fn(),
	listContextCompressionSourceMessages: vi.fn<
		(
			conversationId: string,
		) => Promise<Array<{ id: string; messageSequence: number }>>
	>(async () => []),
	getConversationSummary: vi.fn(),
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
	getConversationProjectId: vi.fn(),
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
	getActiveMemoryProfileContext: vi.fn(),
	recordMemoryReworkTelemetry: vi.fn(),
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
	WORKING_SET_DOCUMENT_TOKEN_BUDGET: 1_200,
	WORKING_SET_OUTPUT_TOKEN_BUDGET: 1_000,
	WORKING_SET_PROMPT_TOKEN_BUDGET: 3_000,
}));

vi.mock("../linked-context-sources", () => ({
	listConversationLinkedContextSources:
		mocks.listConversationLinkedContextSources,
}));

vi.mock("../messages", () => ({
	listMessages: mocks.listMessages,
}));

vi.mock("../conversation-summaries", () => ({
	getConversationSummary: mocks.getConversationSummary,
}));

vi.mock("../projects", () => ({
	getConversationProjectId: mocks.getConversationProjectId,
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
	listContextCompressionSourceMessages:
		mocks.listContextCompressionSourceMessages,
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

vi.mock("../memory-profile/active-context", () => ({
	formatActiveMemoryProfileContextForPrompt: (
		context: {
			items: Array<{ id: string; statement: string; updatedAt: Date }>;
		},
		options: { maxTokens: number },
	) => {
		const ordered = [...context.items].sort(
			(a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
		);
		const included: string[] = [];
		const includedItemIds: string[] = [];
		let estimatedTokens = 0;
		for (const item of ordered) {
			const line = `- ${item.statement}`;
			const lineTokens = Math.ceil(line.length / 4);
			if (estimatedTokens + lineTokens > options.maxTokens) continue;
			included.push(line);
			includedItemIds.push(item.id);
			estimatedTokens += lineTokens;
		}
		const omittedCount = ordered.length - included.length;
		const content = [
			...included,
			omittedCount > 0
				? `Omitted active memory profile items: ${omittedCount}.`
				: null,
		]
			.filter((value): value is string => Boolean(value))
			.join("\n");
		return {
			content,
			estimatedTokens,
			includedCount: included.length,
			includedItemIds,
			omittedCount,
		};
	},
	getActiveMemoryProfileContext: mocks.getActiveMemoryProfileContext,
}));

vi.mock("../memory-profile/telemetry", () => ({
	recordMemoryReworkTelemetry: mocks.recordMemoryReworkTelemetry,
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
	mocks.listMessages.mockResolvedValue([
		{
			id: "message-user-1",
			role: "user",
			content: "Earlier question about the launch plan.",
			timestamp: 1,
		},
		{
			id: "message-assistant-1",
			role: "assistant",
			content: "Earlier answer about the launch plan.",
			timestamp: 2,
		},
	]);
	mocks.listContextCompressionSourceMessages.mockResolvedValue([]);
	mocks.getConversationSummary.mockResolvedValue({
		summary: "The session is about launch readiness.",
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
	mocks.getConversationProjectId.mockResolvedValue(null);
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
	mocks.getActiveMemoryProfileContext.mockResolvedValue({
		resetGeneration: 0,
		projectionRevision: 7,
		items: [
			{
				id: "memory-active-1",
				itemKey: "memory-profile-item:v1:preferences:global:active",
				category: "preferences",
				statement: "The user prefers projection-gated launch briefs.",
				scope: { type: "global" },
				revision: 1,
				updatedAt: new Date("2026-06-01T00:00:00.000Z"),
			},
		],
	});
	mocks.recordMemoryReworkTelemetry.mockResolvedValue({ id: "telemetry-1" });
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
					title: "Session Context",
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
		// The oversized session section is trimmed to fit rather than dropped
		// wholesale — some of it still makes it in, capped with a truncation marker.
		expect(selected.inputValue).toContain("## Session Context");
		expect(selected.inputValue).toContain("UNRELATED_HISTORY");
		expect(selected.inputValue).toContain("[truncated]");
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
					name: "Session Context",
					source: "session",
					inclusionLevel: "legacy_truncated",
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
		mocks.getConversationProjectId.mockResolvedValue("project-1");

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

		expect(constructed.inputValue).toContain("## Session Context");
		expect(constructed.inputValue).toContain(
			"Earlier question about the launch plan.",
		);
		expect(constructed.inputValue).toContain("## Baseline Memory Profile");
		expect(constructed.inputValue).toContain(
			"The user prefers projection-gated launch briefs.",
		);
		expect(constructed.inputValue).not.toContain(
			"The user prefers a suppressed raw internal preference.",
		);
		expect(mocks.getActiveMemoryProfileContext).toHaveBeenCalledWith({
			userId: "user-1",
			applicableScopes: [
				{ type: "project", id: "project-1" },
				{ type: "conversation", id: "conversation-1" },
			],
		});
		expect(constructed.taskState).toBeNull();
		expect(constructed.contextTraceSections).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "Baseline Memory Profile",
					source: "memory",
					itemIds: ["memory-active-1"],
					itemTitles: ["The user prefers projection-gated launch briefs."],
				}),
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

	it("keeps fresh active memory profile items before stale items when the profile budget is constrained", async () => {
		resetConstructedContextMocks();
		mocks.getActiveMemoryProfileContext.mockResolvedValue({
			resetGeneration: 0,
			projectionRevision: 8,
			items: [
				{
					id: "stale-memory",
					itemKey: "memory-profile-item:v1:preferences:global:stale",
					category: "preferences",
					statement: `STALE_MEMORY_SHOULD_NOT_SURVIVE ${"stale ".repeat(40_000)}`,
					scope: { type: "global" },
					revision: 1,
					updatedAt: new Date("2026-01-01T00:00:00.000Z"),
				},
				{
					id: "fresh-memory",
					itemKey: "memory-profile-item:v1:preferences:global:fresh",
					category: "preferences",
					statement: "FRESH_MEMORY_SHOULD_SURVIVE.",
					scope: { type: "global" },
					revision: 1,
					updatedAt: new Date("2026-06-01T00:00:00.000Z"),
				},
			],
		});

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

		expect(constructed.inputValue).toContain("FRESH_MEMORY_SHOULD_SURVIVE.");
		expect(constructed.inputValue).not.toContain(
			"STALE_MEMORY_SHOULD_NOT_SURVIVE",
		);
		expect(constructed.inputValue).toContain(
			"Omitted active memory profile items: 1.",
		);
		expect(mocks.recordMemoryReworkTelemetry).toHaveBeenCalledWith(
			expect.objectContaining({
				eventName: "active_memory_profile_included",
				count: 1,
				metadata: expect.objectContaining({
					totalItemCount: 2,
					omittedItemCount: 1,
				}),
			}),
		);
	});

	it("uses valid compression snapshots for terse shallow turns without replaying covered raw messages", async () => {
		resetConstructedContextMocks();
		mocks.listMessages.mockResolvedValue([
			{
				id: "old-user",
				role: "user",
				content: "OLD_RAW_SECRET_USER_CONTENT",
				timestamp: 1,
			},
			{
				id: "old-assistant",
				role: "assistant",
				content: "OLD_RAW_SECRET_ASSISTANT_CONTENT",
				timestamp: 2,
			},
			{
				id: "new-user",
				role: "user",
				content: "NEW_RAW_RECENT_CONTENT",
				timestamp: 3,
			},
		]);
		mocks.listContextCompressionSourceMessages.mockResolvedValue([
			{ id: "old-user", messageSequence: 1 },
			{ id: "old-assistant", messageSequence: 2 },
			{ id: "new-user", messageSequence: 3 },
		]);
		mocks.getConversationSummary.mockResolvedValue(null);
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

	it("preserves shallow fork provenance when compression filters inherited fork copies from the prompt", async () => {
		resetConstructedContextMocks();
		mocks.listMessages.mockResolvedValue([
			{
				id: "fork-user-1",
				role: "user",
				content: "INHERITED_RAW_SOURCE_QUESTION",
				timestamp: 1,
				forkCopy: {
					sourceMessageId: "source-user-1",
					sourceConversationId: "source-conv",
					sourceRole: "user",
					sourceCreatedAt: "2026-05-15T10:00:01.000Z",
				},
			},
			{
				id: "fork-assistant-1",
				role: "assistant",
				content: "INHERITED_RAW_SOURCE_ANSWER",
				timestamp: 2,
				forkCopy: {
					sourceMessageId: "source-assistant-1",
					sourceConversationId: "source-conv",
					sourceRole: "assistant",
					sourceCreatedAt: "2026-05-15T10:00:02.000Z",
				},
			},
			{
				id: "fork-user-2",
				role: "user",
				content: "Fork-local follow-up",
				timestamp: 3,
				forkCopy: null,
			},
		]);
		mocks.listContextCompressionSourceMessages.mockResolvedValue([
			{ id: "fork-user-1", messageSequence: 1 },
			{ id: "fork-assistant-1", messageSequence: 2 },
			{ id: "fork-user-2", messageSequence: 3 },
		]);
		mocks.getConversationSummary.mockResolvedValue(null);
		mocks.getLatestValidContextCompressionSnapshot.mockResolvedValue({
			id: "snapshot-1",
			conversationId: "fork-conv",
			userId: "user-1",
			trigger: "manual",
			status: "valid",
			modelId: "model-1",
			sourceStartMessageId: "fork-user-1",
			sourceEndMessageId: "fork-assistant-1",
			sourceStartMessageSequence: 1,
			sourceEndMessageSequence: 2,
			snapshot: {
				goal: "Keep inherited fork continuity.",
				currentState: "Inherited fork exchange is compressed.",
				importantFacts: ["COMPRESSED_FORK_FACT"],
			},
			sourceCoverage: {},
			sourceRefs: [],
			estimatedTokens: 64,
			sourceTokenEstimate: 128,
			failureReason: null,
			createdAt: new Date("2026-05-15T10:00:00.000Z"),
			updatedAt: new Date("2026-05-15T10:00:00.000Z"),
		});
		mocks.getConversationForkOrigin.mockResolvedValue({
			forkConversationId: "fork-conv",
			sourceConversationId: "source-conv",
			sourceAssistantMessageId: "source-assistant-1",
			sourceConversationIdAvailable: true,
			sourceAssistantMessageIdAvailable: true,
			copiedForkPointMessageId: "fork-assistant-1",
			sourceTitle: "Source title",
			forkSequence: 1,
			createdAt: Date.now(),
		});

		const constructed = await buildConstructedContext({
			userId: "user-1",
			conversationId: "fork-conv",
			message: "Thanks.",
			modelId: "local-model",
			contextLimits: {
				maxModelContext: 16_000,
				compactionUiThreshold: 12_000,
				targetConstructedContext: 8_000,
			},
		});

		expect(constructed.inputValue).toContain("COMPRESSED_FORK_FACT");
		expect(constructed.inputValue).toContain("Fork-local follow-up");
		expect(constructed.inputValue).not.toContain(
			"INHERITED_RAW_SOURCE_QUESTION",
		);
		expect(constructed.inputValue).not.toContain("INHERITED_RAW_SOURCE_ANSWER");
		expect(mocks.getConversationForkOrigin).toHaveBeenCalledWith("fork-conv");
		expect(constructed.contextDebug?.forkProvenance).toMatchObject({
			inheritedMessageCount: 2,
			inheritedTurnCount: 1,
			forkLocalMessageCount: 1,
			sourceConversationIds: ["source-conv"],
			sourceMessageIds: ["source-user-1", "source-assistant-1"],
			copiedForkPointMessageId: "fork-assistant-1",
		});
	});

	it("combines local session continuity, task, attachment, and evidence candidates from the chat-turn boundary", async () => {
		resetConstructedContextMocks();
		mocks.getConversationProjectId.mockResolvedValue("project-1");

		const constructed = await buildConstructedContext({
			userId: "user-1",
			conversationId: "conversation-1",
			message: "Review the launch plan against release risks.",
			attachmentIds: ["attachment-1"],
			activeDocumentArtifactId: "active-document-1",
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
		expect(constructed.inputValue).toContain("## Session Context");
		expect(constructed.inputValue).toContain(
			"Earlier question about the launch plan.",
		);
		expect(constructed.inputValue).toContain("## Baseline Memory Profile");
		expect(constructed.inputValue).toContain(
			"The user prefers projection-gated launch briefs.",
		);
		// The turn path sources local continuity from the conversation's own
		// messages and its maintained conversation summary.
		expect(constructed.inputValue).toContain("## Session Summary");
		expect(constructed.inputValue).toContain(
			"The session is about launch readiness.",
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
					name: "Session Context",
					source: "session",
				}),
				expect.objectContaining({
					name: "Baseline Memory Profile",
					source: "memory",
					itemIds: ["memory-active-1"],
					itemTitles: ["The user prefers projection-gated launch briefs."],
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
		expect(mocks.getActiveMemoryProfileContext).toHaveBeenCalledWith({
			userId: "user-1",
			applicableScopes: [
				{ type: "project", id: "project-1" },
				{ type: "conversation", id: "conversation-1" },
				{ type: "document", id: "active-document-1" },
				{ type: "document", id: "attachment-1" },
				{ type: "document", id: "evidence-1" },
			],
		});
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

	it("does not accept a memoryIncognito param — context assembly always runs persona/memory and project context", async () => {
		// Incognito is "saved-but-untracked": a fully normal, fully functional
		// chat that just isn't learned into memory or tracked in telemetry.
		// buildConstructedContext must no longer take a memoryIncognito param at
		// all, and its behavior must be identical to the non-incognito path.
		resetConstructedContextMocks();
		mocks.getConversationProjectId.mockResolvedValue("project-1");
		mocks.getConversationProjectLabel.mockResolvedValue("Launch Project");
		mocks.getProjectReferenceContext.mockResolvedValue({
			source: "project_folder",
			projectName: "Launch Project",
			omittedSiblingCount: 0,
			entries: [
				{
					title: "Sibling launch retro",
					objective: "SIBLING_PROJECT_OBJECTIVE",
					summary: "Sibling checkpoint details.",
				},
			],
		});
		mocks.selectProjectFolderSiblingPromotion.mockResolvedValue({
			projectName: "Launch Project",
			title: "Promoted sibling",
			objective: "PROMOTED_SIBLING",
			summary: "Promoted sibling summary.",
			score: 5,
			matchedTerms: ["launch"],
			messages: [{ role: "user", content: "Sibling turn content." }],
			omittedMessageCount: 0,
		});

		const params = {
			userId: "user-1",
			conversationId: "conversation-1",
			message: "Review the launch plan against release risks.",
			attachmentIds: ["attachment-1"],
			activeDocumentArtifactId: "active-document-1",
			modelId: "local-model",
			contextLimits: {
				maxModelContext: 16_000,
				compactionUiThreshold: 12_000,
				targetConstructedContext: 8_000,
			},
		};

		// memoryIncognito is not a valid buildConstructedContext param anymore —
		// an incognito conversation must go through the exact same
		// context-assembly path as a normal one.
		const constructed = await buildConstructedContext({
			...params,
			// @ts-expect-error memoryIncognito no longer exists on this param type.
			memoryIncognito: true,
		});

		// Persona/memory profile is still fetched and injected.
		expect(mocks.getActiveMemoryProfileContext).toHaveBeenCalled();
		expect(constructed.inputValue).toContain("## Baseline Memory Profile");
		expect(constructed.inputValue).toContain(
			"The user prefers projection-gated launch briefs.",
		);
		// Project reference / sibling / folder / working-set context is still
		// fetched and injected.
		expect(mocks.getProjectReferenceContext).toHaveBeenCalled();
		expect(mocks.selectProjectFolderSiblingPromotion).toHaveBeenCalled();
		expect(mocks.getConversationProjectLabel).toHaveBeenCalled();
		expect(mocks.selectWorkingSetArtifactsForPrompt).toHaveBeenCalled();
		expect(constructed.inputValue).toContain("## Project Folder");
		expect(
			constructed.contextTraceSections.some(
				(section) => section.source === "memory",
			),
		).toBe(true);
		// The rest of the context still flows too.
		expect(constructed.inputValue).toContain("## Session Context");
		expect(constructed.inputValue).toContain("## Current Attachments");
	});

	it("produces byte-for-byte identical constructed context whether or not a (now-ignored) memoryIncognito flag is passed", async () => {
		resetConstructedContextMocks();
		mocks.getConversationProjectId.mockResolvedValue("project-1");
		mocks.getConversationProjectLabel.mockResolvedValue("Launch Project");

		const baseParams = {
			userId: "user-1",
			conversationId: "conversation-1",
			message: "Review the launch plan against release risks.",
			attachmentIds: ["attachment-1"],
			activeDocumentArtifactId: "active-document-1",
			modelId: "local-model",
			contextLimits: {
				maxModelContext: 16_000,
				compactionUiThreshold: 12_000,
				targetConstructedContext: 8_000,
			},
		};

		const baseline = await buildConstructedContext(baseParams);

		resetConstructedContextMocks();
		mocks.getConversationProjectId.mockResolvedValue("project-1");
		mocks.getConversationProjectLabel.mockResolvedValue("Launch Project");

		const withStaleFlag = await buildConstructedContext({
			...baseParams,
			// @ts-expect-error memoryIncognito no longer exists on this param type.
			memoryIncognito: true,
		});

		expect(withStaleFlag.inputValue).toBe(baseline.inputValue);
		expect(withStaleFlag.inputValue).toContain("## Baseline Memory Profile");
		expect(withStaleFlag.inputValue).toContain(
			"The user prefers projection-gated launch briefs.",
		);
		expect(mocks.getActiveMemoryProfileContext).toHaveBeenCalled();
		expect(mocks.selectWorkingSetArtifactsForPrompt).toHaveBeenCalled();
	});

	it("does not clamp retrieved evidence to legacy working-set floors on large-context models", async () => {
		resetConstructedContextMocks();
		const evidenceArtifacts = Array.from({ length: 12 }, (_, index) =>
			artifact({
				id: `large-evidence-${index + 1}`,
				name: `large-evidence-${index + 1}.md`,
				contentText: [
					`Large evidence document ${index + 1}.`,
					`DETAIL_${index + 1} `.repeat(2_000),
				].join(" "),
			}),
		);
		mocks.resolvePromptAttachmentArtifacts.mockResolvedValue({
			displayArtifacts: [],
			promptArtifacts: [],
			items: [],
			unresolvedItems: [],
		});
		mocks.selectWorkingSetArtifactsForPrompt.mockResolvedValue(
			evidenceArtifacts,
		);
		mocks.prepareTaskContext.mockResolvedValue({
			taskState: null,
			routingStage: "deterministic",
			routingConfidence: 1,
			verificationStatus: "verified",
			selectedArtifacts: evidenceArtifacts,
			pinnedArtifactIds: [],
			excludedArtifactIds: [],
		});
		mocks.getPromptArtifactSnippets.mockResolvedValue(
			new Map(
				evidenceArtifacts.map((item, index) => [
					item.id,
					`${item.name} snippet. ${`SNIPPET_${index + 1} `.repeat(2_000)}`,
				]),
			),
		);

		const constructed = await buildConstructedContext({
			userId: "user-1",
			conversationId: "conversation-1",
			message: "Compare the retrieved evidence and summarize the differences.",
			modelId: "local-large-context-model",
			contextLimits: {
				maxModelContext: 1_000_000,
				compactionUiThreshold: 800_000,
				targetConstructedContext: 900_000,
			},
		});

		const retrievedEvidence = constructed.contextTraceSections.find(
			(section) => section.name === "Retrieved Evidence",
		);
		expect(retrievedEvidence).toEqual(
			expect.objectContaining({
				source: "working_set",
				inclusionLevel: "legacy_full",
				itemIds: evidenceArtifacts.map((item) => item.id),
			}),
		);
		const retrievedEvidencePromptSection =
			constructed.inputValue
				.split("## Retrieved Evidence\n")
				.at(1)
				?.split("\n\n## ")
				.at(0) ?? "";
		expect(estimateTokenCount(retrievedEvidencePromptSection)).toBeGreaterThan(
			3_000,
		);
		expect(constructed.inputValue).toContain("SNIPPET_12");
		expect(mocks.updateConversationContextStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				promptArtifactCount: 12,
				workingSetCount: 12,
			}),
		);
	});
});
