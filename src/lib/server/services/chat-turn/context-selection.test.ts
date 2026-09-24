import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectKnowledgeItem } from "$lib/server/services/knowledge";
import { estimateTokenCount } from "$lib/utils/tokens";
import {
	buildConstructedContext,
	buildFileProductionJobStatusBody,
	inferDocumentContextIntent,
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
	resolveLinkedContextSourcesForConversation: vi.fn(),
	selectWorkingSetArtifactsForPrompt: vi.fn(),
	findRelevantKnowledgeArtifacts: vi.fn(),
	getArtifactsForUser: vi.fn(),
	getCompactionUiThreshold: vi.fn(),
	getMaxModelContext: vi.fn(),
	getTargetConstructedContext: vi.fn(),
	updateConversationContextStatus: vi.fn(),
	listProjectKnowledge: vi.fn(),
	resolveProjectFileMentions: vi.fn(),
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
	isMemoryActiveForConversation: vi.fn(),
	listConversationFileProductionJobStates: vi.fn<
		() => Promise<
			Array<
				import("$lib/server/services/file-production").FileProductionJobState
			>
		>
	>(async () => []),
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
	listProjectKnowledge: mocks.listProjectKnowledge,
	resolveProjectFileMentions: mocks.resolveProjectFileMentions,
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
	resolveLinkedContextSourcesForConversation:
		mocks.resolveLinkedContextSourcesForConversation,
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

vi.mock("../memory-controls", () => ({
	isMemoryActiveForConversation: mocks.isMemoryActiveForConversation,
}));

vi.mock("../file-production", () => ({
	listConversationFileProductionJobStates:
		mocks.listConversationFileProductionJobStates,
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
	mocks.listProjectKnowledge.mockResolvedValue([]);
	// Default: the turn names no project file, which is the ordinary turn.
	mocks.resolveProjectFileMentions.mockResolvedValue([]);
	// Validation returns the canonicals it was handed. The real one is tested
	// against a real database in project-knowledge.test.ts; here it is the seam
	// that lets a mention reach the prompt.
	mocks.resolveLinkedContextSourcesForConversation.mockImplementation(
		async ({ linkedSources }: { linkedSources: unknown[] }) => linkedSources,
	);
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
	// Default: memory is active for the conversation (non-incognito, master
	// toggle on). Individual gate tests override this to false.
	mocks.isMemoryActiveForConversation.mockResolvedValue(true);
	// Default: nothing the user asked for is still missing.
	mocks.listConversationFileProductionJobStates.mockResolvedValue([]);
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

	it("routes the baseline memory section through the master gate and injects it when memory is active (shallow tier)", async () => {
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

		expect(mocks.isMemoryActiveForConversation).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conversation-1",
		});
		expect(constructed.inputValue).toContain("## Baseline Memory Profile");
		expect(constructed.inputValue).toContain(
			"The user prefers projection-gated launch briefs.",
		);
	});

	it("omits the baseline memory section for an incognito conversation (shallow tier)", async () => {
		resetConstructedContextMocks();
		// Incognito ⇒ isMemoryActiveForConversation resolves false.
		mocks.isMemoryActiveForConversation.mockResolvedValue(false);

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

		expect(mocks.isMemoryActiveForConversation).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conversation-1",
		});
		expect(constructed.inputValue).not.toContain("## Baseline Memory Profile");
		expect(constructed.inputValue).not.toContain(
			"The user prefers projection-gated launch briefs.",
		);
		// Gate short-circuits before any projection retrieval.
		expect(mocks.getActiveMemoryProfileContext).not.toHaveBeenCalled();
	});

	it("omits the baseline memory section when the master toggle is off (deep tier)", async () => {
		resetConstructedContextMocks();
		// Master toggle off (users.memoryEnabled=false) ⇒ inactive.
		mocks.isMemoryActiveForConversation.mockResolvedValue(false);

		const constructed = await buildConstructedContext({
			userId: "user-1",
			conversationId: "conversation-1",
			// Deep-tier intent so buildConstructedContext takes the deep branch.
			message:
				"Summarize the attached document and cite the evidence from earlier.",
			attachmentIds: ["attachment-1"],
			modelId: "local-model",
			contextLimits: {
				maxModelContext: 16_000,
				compactionUiThreshold: 12_000,
				targetConstructedContext: 8_000,
			},
		});

		expect(constructed.inputValue).not.toContain("## Baseline Memory Profile");
		expect(mocks.getActiveMemoryProfileContext).not.toHaveBeenCalled();
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

	it("reports the native history window after the compression boundary, counting dropped turns", async () => {
		resetConstructedContextMocks();
		mocks.getConfig.mockReturnValue({
			contextDiagnosticsDebug: false,
			nativeHistoryEnabled: true,
		});
		const long = "detail ".repeat(3_000);
		mocks.listMessages.mockResolvedValue([
			{ id: "u1", role: "user", content: "COVERED_BY_SNAPSHOT", timestamp: 1 },
			{ id: "a1", role: "assistant", content: "Covered answer.", timestamp: 2 },
			{ id: "u2", role: "user", content: "OLDEST_KEPT_QUESTION", timestamp: 3 },
			{ id: "a2", role: "assistant", content: long, timestamp: 4 },
			{ id: "u3", role: "user", content: "MIDDLE_QUESTION", timestamp: 5 },
			{ id: "a3", role: "assistant", content: long, timestamp: 6 },
			{ id: "u4", role: "user", content: "NEWEST_QUESTION", timestamp: 7 },
			{ id: "a4", role: "assistant", content: long, timestamp: 8 },
		]);
		mocks.listContextCompressionSourceMessages.mockResolvedValue(
			["u1", "a1", "u2", "a2", "u3", "a3", "u4", "a4"].map((id, index) => ({
				id,
				messageSequence: index + 1,
			})),
		);
		mocks.getConversationSummary.mockResolvedValue(null);
		mocks.getLatestValidContextCompressionSnapshot.mockResolvedValue({
			id: "snapshot-1",
			conversationId: "conversation-1",
			userId: "user-1",
			trigger: "automatic",
			status: "valid",
			modelId: "model1",
			sourceStartMessageId: "u1",
			sourceEndMessageId: "a1",
			sourceStartMessageSequence: 1,
			sourceEndMessageSequence: 2,
			snapshot: {
				goal: "Keep compressed continuity.",
				currentState: "The first exchange is summarized.",
				importantFacts: ["SNAPSHOT_FACT"],
			},
			sourceCoverage: {},
			sourceRefs: [],
			estimatedTokens: 32,
			sourceTokenEstimate: 64,
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
				// History budget = 65% of 8,000 = 5,200 tokens: room for one
				// ~3,000-token assistant answer beyond the newest turn, not two.
				targetConstructedContext: 8_000,
			},
		});

		const history = JSON.stringify(constructed.historyMessages);
		expect(constructed.inputValue).toContain("SNAPSHOT_FACT");
		expect(history).not.toContain("COVERED_BY_SNAPSHOT");
		expect(history).toContain("NEWEST_QUESTION");
		expect(history).not.toContain("OLDEST_KEPT_QUESTION");
		expect(constructed.historyWindow).toEqual({
			includedTurnCount: 1,
			omittedTurnCount: 2,
		});
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

	it("caps each retrieved document at the per-artifact character budget even without a prepared snippet", async () => {
		resetConstructedContextMocks();
		const evidence = artifact({
			id: "long-evidence",
			name: "long-evidence.md",
			// Word-shaped text: the repo estimator counts ~2-3 chars per token,
			// so a character budget misread as tokens lets several times more
			// text through than the budget allows.
			contentText: "alpha beta gamma delta ".repeat(20_000),
		});
		mocks.resolvePromptAttachmentArtifacts.mockResolvedValue({
			displayArtifacts: [],
			promptArtifacts: [],
			items: [],
			unresolvedItems: [],
		});
		mocks.selectWorkingSetArtifactsForPrompt.mockResolvedValue([evidence]);
		mocks.prepareTaskContext.mockResolvedValue({
			taskState: null,
			routingStage: "deterministic",
			routingConfidence: 1,
			verificationStatus: "verified",
			selectedArtifacts: [evidence],
		});
		// Snippet preparation failing leaves the serializer to excerpt the raw
		// document text itself.
		mocks.getPromptArtifactSnippets.mockRejectedValue(
			new Error("chunk store unavailable"),
		);

		const constructed = await buildConstructedContext({
			userId: "user-1",
			conversationId: "conversation-1",
			message: "Compare the retrieved evidence and summarize the differences.",
			modelId: "local-model",
			contextLimits: {
				maxModelContext: 262_144,
				compactionUiThreshold: 209_715,
				targetConstructedContext: 157_286,
			},
		});

		const perArtifactChars = Number(
			constructed.contextTraceSections
				.flatMap((section) => section.signalReasons ?? [])
				.find((reason) =>
					reason.startsWith("document_context_per_artifact_chars:"),
				)
				?.split(":")[1],
		);
		expect(perArtifactChars).toBeGreaterThan(0);
		const retrievedEvidence =
			constructed.inputValue
				.split("## Retrieved Evidence\n")
				.at(1)
				?.split("\n\n## ")
				.at(0) ?? "";
		const excerpt = retrievedEvidence.replace(
			"Document: long-evidence.md\n",
			"",
		);
		expect(excerpt).toContain("alpha beta");
		expect(excerpt.length).toBeLessThanOrEqual(perArtifactChars);
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

	// produce_file's in-turn wait is bounded, so a slow job legitimately ends
	// its turn as "running", and a user-clicked Retry settles long after. The
	// persisted tool result is frozen at what was true then; this section is
	// what makes the NEXT turn work from the ledger instead.
	describe("File Jobs section", () => {
		const FAILED_JOB = {
			id: "job-failed",
			title: "Quarterly workbook",
			status: "failed" as const,
			errorCode: "program_execution_failed",
			errorMessage: "NameError: name 'wb' is not defined",
			retryable: true,
			updatedAt: 2,
		};
		const RUNNING_JOB = {
			id: "job-running",
			title: "Launch deck",
			status: "running" as const,
			errorCode: null,
			errorMessage: null,
			retryable: false,
			updatedAt: 1,
		};

		it("omits the section entirely when every requested file exists", async () => {
			resetConstructedContextMocks();

			const constructed = await buildConstructedContext({
				userId: "user-1",
				conversationId: "conversation-1",
				message: "Thanks, that helps.",
				modelId: "local-model",
			});

			expect(constructed.inputValue).not.toContain("## File Jobs");
		});

		// Both latency tiers, because "where is my file?" is exactly the kind of
		// short follow-up that takes the shallow path.
		it.each([
			["shallow", "Thanks, that helps."],
			[
				"deep",
				"Please summarise the whole launch plan document in detail, including every risk and open question we have discussed so far in this conversation.",
			],
		])("reports a job that failed after its own turn ended (%s tier)", async (tier, message) => {
			resetConstructedContextMocks();
			mocks.listConversationFileProductionJobStates.mockResolvedValue([
				FAILED_JOB,
			]);

			const constructed = await buildConstructedContext({
				userId: "user-1",
				conversationId: "conversation-1",
				message,
				modelId: "local-model",
			});

			// Guards the fixture: a "deep" case that silently fell back to the
			// shallow builder would make this a duplicate of the row above.
			expect(mocks.resolvePromptAttachmentArtifacts).toHaveBeenCalledTimes(
				tier === "deep" ? 1 : 0,
			);
			expect(constructed.inputValue).toContain("## File Jobs");
			expect(constructed.inputValue).toContain("Quarterly workbook");
			expect(constructed.inputValue).toContain("FAILED");
			expect(constructed.inputValue).toContain("program_execution_failed");
			expect(
				mocks.listConversationFileProductionJobStates,
			).toHaveBeenCalledWith({
				userId: "user-1",
				conversationId: "conversation-1",
				limit: 5,
			});
		});

		it("says a still-running job has produced no file yet", async () => {
			resetConstructedContextMocks();
			mocks.listConversationFileProductionJobStates.mockResolvedValue([
				RUNNING_JOB,
			]);

			const constructed = await buildConstructedContext({
				userId: "user-1",
				conversationId: "conversation-1",
				message: "Thanks, that helps.",
				modelId: "local-model",
			});

			expect(constructed.inputValue).toContain("Launch deck");
			expect(constructed.inputValue).toContain("still being produced");
			expect(constructed.inputValue).not.toContain("FAILED");
		});

		it("keeps the turn alive when the ledger lookup fails", async () => {
			resetConstructedContextMocks();
			mocks.listConversationFileProductionJobStates.mockRejectedValue(
				new Error("SQLITE_BUSY"),
			);

			const constructed = await buildConstructedContext({
				userId: "user-1",
				conversationId: "conversation-1",
				message: "Thanks, that helps.",
				modelId: "local-model",
			});

			expect(constructed.inputValue).not.toContain("## File Jobs");
			expect(constructed.inputValue).toContain("## Session Context");
		});
	});

	// Every turn in a project is told which files the project knows: names and
	// one-line summaries, nothing more. The section is `protected`, so the
	// packet compactor will never trim it — which is exactly why the caps have
	// to be the section's own job, or a big project would crowd out the answer.
	describe("Project Files section", () => {
		const DEEP_MESSAGE =
			"Please summarise the whole launch plan document in detail, including every risk and open question we have discussed so far in this conversation.";
		const SHALLOW_MESSAGE = "Thanks, that helps.";

		function projectFile(params: {
			name: string;
			summary?: string | null;
		}): ProjectKnowledgeItem {
			return {
				artifactId: `artifact-${params.name}`,
				name: params.name,
				mimeType: "text/markdown",
				type: "source_document",
				sizeBytes: 1_024,
				linkedAt: 1,
				summary:
					params.summary === undefined ? "A line about it." : params.summary,
			};
		}

		function filesSection(
			constructed: Awaited<ReturnType<typeof buildConstructedContext>>,
		) {
			const section = constructed.contextTraceSections.find(
				(candidate) => candidate.name === "Project Files",
			);
			return {
				section,
				lines: section?.body.split("\n") ?? [],
			};
		}

		it("lists a project's files on a deep turn", async () => {
			resetConstructedContextMocks();
			mocks.getConversationProjectId.mockResolvedValue("project-1");
			mocks.listProjectKnowledge.mockResolvedValue([
				projectFile({
					name: "launch-brief.md",
					summary: "Positioning and the 2.0 date.",
				}),
				projectFile({ name: "risk-register.md", summary: null }),
			]);

			const constructed = await buildConstructedContext({
				userId: "user-1",
				conversationId: "conversation-1",
				message: DEEP_MESSAGE,
				modelId: "local-model",
			});

			// Guards the fixture: a "deep" case that quietly fell back to the
			// shallow builder would assert nothing about the deep tier.
			expect(mocks.resolvePromptAttachmentArtifacts).toHaveBeenCalledTimes(1);
			expect(constructed.inputValue).toContain("## Project Files");
			expect(constructed.inputValue).toContain(
				"- launch-brief.md — Positioning and the 2.0 date.",
			);
			// A file with no summary gets no dash: an em dash with nothing after
			// it reads as a clipped line rather than a file the library could not
			// summarize.
			expect(constructed.inputValue).toContain("- risk-register.md");
			expect(constructed.inputValue).not.toContain("- risk-register.md —");
			// One read per turn, scoped to the caller's project — never a
			// project id on its own.
			expect(mocks.listProjectKnowledge).toHaveBeenCalledTimes(1);
			expect(mocks.listProjectKnowledge).toHaveBeenCalledWith({
				userId: "user-1",
				projectId: "project-1",
			});
			expect(constructed.contextTraceSections).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						name: "Project Files",
						source: "document",
						protected: true,
						trimmed: false,
						inclusionLevel: "legacy_full",
					}),
				]),
			);
		});

		it("lists a project's files on a shallow turn", async () => {
			resetConstructedContextMocks();
			mocks.getConversationProjectId.mockResolvedValue("project-1");
			mocks.listProjectKnowledge.mockResolvedValue([
				projectFile({
					name: "launch-brief.md",
					summary: "Positioning and the 2.0 date.",
				}),
			]);

			const constructed = await buildConstructedContext({
				userId: "user-1",
				conversationId: "conversation-1",
				message: SHALLOW_MESSAGE,
				modelId: "local-model",
			});

			expect(mocks.resolvePromptAttachmentArtifacts).not.toHaveBeenCalled();
			// "Short question" is exactly when naming a file still has to work.
			expect(constructed.inputValue).toContain("## Project Files");
			expect(constructed.inputValue).toContain(
				"- launch-brief.md — Positioning and the 2.0 date.",
			);
			expect(mocks.listProjectKnowledge).toHaveBeenCalledWith({
				userId: "user-1",
				projectId: "project-1",
			});
		});

		it("omits the section entirely when the project has no files", async () => {
			resetConstructedContextMocks();
			mocks.getConversationProjectId.mockResolvedValue("project-1");
			mocks.listProjectKnowledge.mockResolvedValue([]);

			const constructed = await buildConstructedContext({
				userId: "user-1",
				conversationId: "conversation-1",
				message: SHALLOW_MESSAGE,
				modelId: "local-model",
			});

			// Looked, found nothing: an empty heading would be a lie about the
			// project rather than a fact about it.
			expect(mocks.listProjectKnowledge).toHaveBeenCalledTimes(1);
			expect(constructed.inputValue).not.toContain("## Project Files");
		});

		it("does not read any files when the conversation has no project", async () => {
			resetConstructedContextMocks();
			mocks.getConversationProjectId.mockResolvedValue(null);

			const constructed = await buildConstructedContext({
				userId: "user-1",
				conversationId: "conversation-1",
				message: SHALLOW_MESSAGE,
				modelId: "local-model",
			});

			expect(mocks.listProjectKnowledge).not.toHaveBeenCalled();
			expect(constructed.inputValue).not.toContain("## Project Files");
		});

		it("lists a project's files in an incognito conversation in that project", async () => {
			resetConstructedContextMocks();
			mocks.getConversationProjectId.mockResolvedValue("project-1");
			mocks.isMemoryActiveForConversation.mockResolvedValue(false);
			mocks.listProjectKnowledge.mockResolvedValue([
				projectFile({ name: "launch-brief.md" }),
			]);

			const constructed = await buildConstructedContext({
				userId: "user-1",
				conversationId: "conversation-1",
				message: SHALLOW_MESSAGE,
				modelId: "local-model",
			});

			// Incognito means "this conversation teaches the user nothing", not
			// "the project forgets which files it holds".
			expect(constructed.inputValue).not.toContain(
				"## Baseline Memory Profile",
			);
			expect(constructed.inputValue).toContain("## Project Files");
			expect(constructed.inputValue).toContain("- launch-brief.md");
		});

		it("keeps the turn alive when the project files lookup fails", async () => {
			resetConstructedContextMocks();
			mocks.getConversationProjectId.mockResolvedValue("project-1");
			mocks.listProjectKnowledge.mockRejectedValue(new Error("SQLITE_BUSY"));

			const constructed = await buildConstructedContext({
				userId: "user-1",
				conversationId: "conversation-1",
				message: SHALLOW_MESSAGE,
				modelId: "local-model",
			});

			expect(constructed.inputValue).not.toContain("## Project Files");
			expect(constructed.inputValue).toContain("## Session Context");
		});

		it("stops at 30 entries and appends +N more", async () => {
			resetConstructedContextMocks();
			mocks.getConversationProjectId.mockResolvedValue("project-1");
			mocks.listProjectKnowledge.mockResolvedValue(
				Array.from({ length: 35 }, (_, index) =>
					projectFile({
						name: `doc-${String(index + 1).padStart(2, "0")}.md`,
						summary: null,
					}),
				),
			);

			const constructed = await buildConstructedContext({
				userId: "user-1",
				conversationId: "conversation-1",
				message: SHALLOW_MESSAGE,
				modelId: "local-model",
			});

			const { section, lines } = filesSection(constructed);
			expect(section).toBeDefined();
			expect(lines.filter((line) => line.startsWith("- "))).toHaveLength(30);
			expect(lines.at(-1)).toBe("+5 more");
			expect(section?.body.length).toBeLessThanOrEqual(1_500);
			// The 31st file is dropped rather than clipped: its name is nowhere in
			// the prompt, so the model cannot half-recognize it.
			expect(constructed.inputValue).not.toContain("doc-31.md");
			expect(constructed.inputValue).toContain("- doc-30.md");
		});

		it("stops at the character budget before the entry count and appends +N more", async () => {
			resetConstructedContextMocks();
			mocks.getConversationProjectId.mockResolvedValue("project-1");
			// Fixed-width lines: "- doc-01.md — " is 14 characters and the summary
			// is 38, so every entry is exactly 52 characters and the arithmetic
			// below is exact rather than approximate.
			const summary = "s".repeat(38);
			mocks.listProjectKnowledge.mockResolvedValue(
				Array.from({ length: 40 }, (_, index) =>
					projectFile({
						name: `doc-${String(index + 1).padStart(2, "0")}.md`,
						summary,
					}),
				),
			);

			const constructed = await buildConstructedContext({
				userId: "user-1",
				conversationId: "conversation-1",
				message: SHALLOW_MESSAGE,
				modelId: "local-model",
			});

			const { section, lines } = filesSection(constructed);
			// 28 entries + the +12 more tail is 1,492 characters; a 29th entry
			// would be 1,545. The character cap bites first, well under 30 entries.
			expect(lines.filter((line) => line.startsWith("- "))).toHaveLength(28);
			expect(lines.at(-1)).toBe("+12 more");
			expect(section?.body).toBe(
				[
					...Array.from(
						{ length: 28 },
						(_, index) =>
							`- doc-${String(index + 1).padStart(2, "0")}.md — ${summary}`,
					),
					"+12 more",
				].join("\n"),
			);
			expect(section?.body.length).toBeLessThanOrEqual(1_500);
		});

		it("never emits a partially truncated name", async () => {
			resetConstructedContextMocks();
			mocks.getConversationProjectId.mockResolvedValue("project-1");
			const enormousName = `${"n".repeat(1_600)}.md`;
			mocks.listProjectKnowledge.mockResolvedValue([
				projectFile({ name: enormousName, summary: null }),
				projectFile({ name: "after-it.md", summary: null }),
			]);

			const constructed = await buildConstructedContext({
				userId: "user-1",
				conversationId: "conversation-1",
				message: SHALLOW_MESSAGE,
				modelId: "local-model",
			});

			const { section } = filesSection(constructed);
			// A file that does not fit whole is dropped and counted — the walk
			// stops at it rather than skipping ahead to whatever fits after it,
			// so the list is always a prefix plus an honest remainder.
			expect(section?.body).toBe("+2 more");
			expect(section?.body.length).toBeLessThanOrEqual(1_500);
			expect(section?.body).not.toContain(enormousName.slice(0, 120));
			expect(constructed.inputValue).not.toContain(enormousName.slice(0, 120));
		});

		it("keeps the section whole when the packet is trimmed", async () => {
			resetConstructedContextMocks();
			mocks.getConversationProjectId.mockResolvedValue("project-1");
			// Nothing else in this packet is big enough to be squeezed, so the
			// session summary is the section the compactor has to cut.
			mocks.selectWorkingSetArtifactsForPrompt.mockResolvedValue([]);
			mocks.prepareTaskContext.mockResolvedValue({
				taskState: null,
				routingStage: "deterministic",
				routingConfidence: 1,
				verificationStatus: "verified",
				selectedArtifacts: [],
			});
			mocks.getConversationSummary.mockResolvedValue({
				summary: "SESSION_SUMMARY_FILLER ".repeat(8_000),
			});
			mocks.listProjectKnowledge.mockResolvedValue(
				Array.from({ length: 10 }, (_, index) =>
					projectFile({
						name: `doc-${String(index + 1).padStart(2, "0")}.md`,
						summary: "One line about this document.",
					}),
				),
			);

			const constructed = await buildConstructedContext({
				userId: "user-1",
				conversationId: "conversation-1",
				message: DEEP_MESSAGE,
				modelId: "local-model",
				contextLimits: {
					maxModelContext: 16_000,
					compactionUiThreshold: 12_000,
					targetConstructedContext: 600,
				},
			});

			const { section } = filesSection(constructed);
			expect(section).toEqual(
				expect.objectContaining({
					protected: true,
					trimmed: false,
					inclusionLevel: "legacy_full",
				}),
			);
			// Every name and summary made it, including the last one — a trim
			// would have left the body short without saying so.
			expect(section?.body.split("\n")).toHaveLength(10);
			expect(constructed.inputValue).toContain(
				"- doc-10.md — One line about this document.",
			);
			// The packet really was under pressure, or this proves nothing.
			const sessionSummary = constructed.contextTraceSections.find(
				(candidate) => candidate.name === "Session Summary",
			);
			expect(sessionSummary).toBeDefined();
			expect(sessionSummary?.inclusionLevel).not.toBe("legacy_full");
		});

		it("reflects an unlink on the next turn", async () => {
			resetConstructedContextMocks();
			mocks.getConversationProjectId.mockResolvedValue("project-1");
			mocks.listProjectKnowledge.mockResolvedValue([
				projectFile({ name: "kept.md" }),
				projectFile({ name: "unlinked.md" }),
			]);

			const before = await buildConstructedContext({
				userId: "user-1",
				conversationId: "conversation-1",
				message: SHALLOW_MESSAGE,
				modelId: "local-model",
			});
			expect(before.inputValue).toContain("- unlinked.md");

			// The unlink lands between turns. Nothing may carry the old list
			// forward: the prompt is the truth about the project as of now.
			mocks.listProjectKnowledge.mockResolvedValue([
				projectFile({ name: "kept.md" }),
			]);
			const after = await buildConstructedContext({
				userId: "user-1",
				conversationId: "conversation-1",
				message: SHALLOW_MESSAGE,
				modelId: "local-model",
			});

			expect(after.inputValue).not.toContain("unlinked.md");
			expect(after.inputValue).toContain("- kept.md");
			// One read per turn: no cross-turn cache to go stale.
			expect(mocks.listProjectKnowledge).toHaveBeenCalledTimes(2);
		});
	});

	describe("Project file mentions", () => {
		// Names the file, and long enough to match the deep-tier intent rules.
		const DEEP_MENTION_MESSAGE =
			"Please summarise wien-itinerary.md in detail, including every risk and open question we have discussed so far in this conversation.";
		// Short, and free of every word that would promote the turn to the deep
		// tier — this is the shallow case the review cares about.
		const SHALLOW_MENTION_MESSAGE = "What about wien-itinerary.md?";

		function mentionedFile(): {
			file: ProjectKnowledgeItem;
			source: import("$lib/server/services/linked-context-sources").LinkedContextSource;
		} {
			const artifactId = "artifact-wien";
			return {
				file: {
					artifactId,
					name: "wien-itinerary.md",
					mimeType: "text/markdown",
					type: "source_document",
					sizeBytes: 1_024,
					linkedAt: 1,
					summary: "Trains and hotels for October.",
				},
				source: {
					displayArtifactId: artifactId,
					promptArtifactId: artifactId,
					familyArtifactIds: [artifactId],
					name: "wien-itinerary.md",
					type: "document",
				},
			};
		}

		it("resolves a project file named in the message into the turn's linked sources", async () => {
			resetConstructedContextMocks();
			const { file, source } = mentionedFile();
			mocks.getConversationProjectId.mockResolvedValue("project-1");
			mocks.listProjectKnowledge.mockResolvedValue([file]);
			mocks.resolveProjectFileMentions.mockResolvedValue([source]);
			mocks.getArtifactsForUser.mockResolvedValue([
				artifact({
					id: source.displayArtifactId,
					name: source.name,
					contentText: "Wien, 10 October: Railjet 07:40, Hotel Motto.",
				}),
			]);
			mocks.getPromptArtifactSnippets.mockResolvedValue(
				new Map([
					[source.displayArtifactId, "Wien, 10 October: Railjet 07:40."],
				]),
			);

			const constructed = await buildConstructedContext({
				userId: "user-1",
				conversationId: "conversation-1",
				message: DEEP_MENTION_MESSAGE,
				modelId: "local-model",
			});

			// The name was matched against the list this turn already read — the
			// section and the mention can never disagree about what the project
			// holds, and the read stays one per turn.
			expect(mocks.resolveProjectFileMentions).toHaveBeenCalledWith({
				userId: "user-1",
				projectId: "project-1",
				message: DEEP_MENTION_MESSAGE,
				files: [file],
			});
			expect(mocks.listProjectKnowledge).toHaveBeenCalledTimes(1);
			// Naming a file is not a way around the linked-source rules: the
			// candidate goes through the same validation every linked source does.
			expect(
				mocks.resolveLinkedContextSourcesForConversation,
			).toHaveBeenCalledWith({
				userId: "user-1",
				conversationId: "conversation-1",
				linkedSources: [source],
				attachmentIds: [],
			});
			expect(constructed.inputValue).toContain("## Linked Sources");
			expect(constructed.inputValue).toContain("Wien, 10 October");
			expect(constructed.contextTraceSections).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						name: "Linked Sources",
						itemIds: [source.displayArtifactId],
						itemTitles: ["wien-itinerary.md"],
					}),
				]),
			);
		});

		it("gets the file's content into the prompt on a shallow turn when it is named", async () => {
			resetConstructedContextMocks();
			const { file, source } = mentionedFile();
			mocks.getConversationProjectId.mockResolvedValue("project-1");
			mocks.listProjectKnowledge.mockResolvedValue([file]);
			mocks.resolveProjectFileMentions.mockResolvedValue([source]);
			mocks.getArtifactsForUser.mockResolvedValue([
				artifact({
					id: source.displayArtifactId,
					name: source.name,
					contentText: "Wien, 10 October: Railjet 07:40, Hotel Motto.",
				}),
			]);
			mocks.getPromptArtifactSnippets.mockResolvedValue(
				new Map([
					[source.displayArtifactId, "Wien, 10 October: Railjet 07:40."],
				]),
			);

			const constructed = await buildConstructedContext({
				userId: "user-1",
				conversationId: "conversation-1",
				message: SHALLOW_MENTION_MESSAGE,
				modelId: "local-model",
			});

			// Guards the fixture: a "shallow" case that quietly ran the deep
			// builder would prove nothing about the shallow tier.
			expect(mocks.resolvePromptAttachmentArtifacts).not.toHaveBeenCalled();
			expect(constructed.inputValue).toContain("## Project Files");
			expect(constructed.inputValue).toContain("- wien-itinerary.md");
			// The list alone is not enough: the file the user named has to have
			// its content in the prompt, or naming it changed nothing.
			expect(constructed.inputValue).toContain("## Linked Sources");
			expect(constructed.inputValue).toContain("Wien, 10 October");
			expect(mocks.getPromptArtifactSnippets).toHaveBeenCalled();
		});

		it("fails the turn the way the linked-source path does when the named file is not prompt ready", async () => {
			resetConstructedContextMocks();
			const { file, source } = mentionedFile();
			mocks.getConversationProjectId.mockResolvedValue("project-1");
			mocks.listProjectKnowledge.mockResolvedValue([file]);
			mocks.resolveProjectFileMentions.mockResolvedValue([source]);
			mocks.resolveLinkedContextSourcesForConversation.mockRejectedValue(
				Object.assign(
					new Error("Linked source is not ready for prompt context"),
					{
						name: "LinkedContextSourceError",
						status: 409,
						code: "linked_source_not_prompt_ready",
					},
				),
			);

			// Not swallowed into a silent empty section: the user asked for a file
			// the library cannot serve, and that is the answer they get.
			await expect(
				buildConstructedContext({
					userId: "user-1",
					conversationId: "conversation-1",
					message: SHALLOW_MENTION_MESSAGE,
					modelId: "local-model",
				}),
			).rejects.toMatchObject({
				name: "LinkedContextSourceError",
				status: 409,
			});
		});
	});
});

describe("buildFileProductionJobStatusBody", () => {
	it("names the error code and message on a failed job", () => {
		expect(
			buildFileProductionJobStatusBody([
				{
					id: "job-1",
					title: "Budget",
					status: "failed",
					errorCode: "program_execution_failed",
					errorMessage: "SyntaxError: invalid syntax",
					retryable: true,
					updatedAt: 1,
				},
			]),
		).toContain(
			'- "Budget" — FAILED, no file was produced (program_execution_failed: SyntaxError: invalid syntax).',
		);
	});

	it("falls back to a placeholder title and omits an absent reason", () => {
		expect(
			buildFileProductionJobStatusBody([
				{
					id: "job-1",
					title: "   ",
					status: "failed",
					errorCode: null,
					errorMessage: null,
					retryable: false,
					updatedAt: 1,
				},
			]),
		).toContain('- "(untitled)" — FAILED, no file was produced.');
	});

	it("returns an empty body for an empty list so no section is pushed", () => {
		expect(buildFileProductionJobStatusBody([])).toBe("");
	});

	// The ledger stores the raw failure message, and the host-side render and
	// storage paths put absolute host paths in it. The prompt must not tell the
	// model where this deployment keeps its files.
	it("strips host filesystem paths out of the reason", () => {
		const body = buildFileProductionJobStatusBody([
			{
				id: "job-1",
				title: "Report",
				status: "failed",
				errorCode: "document_render_failed",
				errorMessage:
					"ENOENT: no such file or directory, open '/opt/alfyai/node_modules/pdfjs-dist/fonts/FoxitSans.pfb'",
				retryable: true,
				updatedAt: 1,
			},
		]);

		expect(body).not.toContain("/opt/alfyai");
		expect(body).not.toContain("node_modules");
		expect(body).toContain("document_render_failed");
	});
});

describe("inferDocumentContextIntent — document continuation", () => {
	const NO_DOCUMENT = {
		documentFocused: false,
		hasCurrentAttachments: false,
		hasCarriedForwardAttachments: false,
		hasActiveDocument: false,
		hasLinkedSources: false,
		hasRetrievedEvidence: false,
	} as const;

	const EN_CONTINUATIONS = [
		"what else does it say?",
		"what else does the lease say",
		"and the rest?",
		"the rest of it please",
		"read on",
		"read further",
		"continue reading",
		"keep reading",
		"give me more of it",
		"more from the document",
		"quote the whole clause",
		"quote me the full section",
		"give it to me in full",
		"everything it says about deposits",
		"everything the policy says",
		"next section",
		"show me the next page",
		"show me all of it",
		"the entire document please",
	];

	const HU_CONTINUATIONS = [
		"mi van még benne?",
		"a többit is kérem",
		"olvasd tovább",
		"folytasd az olvasást",
		"idézd be az egészet",
		"idézd az egészet",
		"teljes egészében kérem",
		"a következő rész",
		"a következő oldal",
		"a következő fejezetet",
		"mutasd az egészet",
		"még többet belőle",
	];

	it.each(
		EN_CONTINUATIONS,
	)("promotes %j to task depth when a retrieved hit is in play", (message) => {
		expect(
			inferDocumentContextIntent({
				...NO_DOCUMENT,
				message,
				hasRetrievedEvidence: true,
			}),
		).toBe("task");
	});

	it.each(
		HU_CONTINUATIONS,
	)("promotes %j to task depth when a retrieved hit is in play", (message) => {
		expect(
			inferDocumentContextIntent({
				...NO_DOCUMENT,
				message,
				hasRetrievedEvidence: true,
			}),
		).toBe("task");
	});

	it("promotes to direct depth when the document selection is explicit", () => {
		expect(
			inferDocumentContextIntent({
				...NO_DOCUMENT,
				message: "what else does it say?",
				hasCurrentAttachments: true,
			}),
		).toBe("direct");
		expect(
			inferDocumentContextIntent({
				...NO_DOCUMENT,
				message: "olvasd tovább",
				hasActiveDocument: true,
			}),
		).toBe("direct");
	});

	it.each([
		["carried-forward attachments", { hasCarriedForwardAttachments: true }],
		["a focused document", { documentFocused: true }],
	] as const)("counts %s as a document in play", (_label, flags) => {
		expect(
			inferDocumentContextIntent({
				...NO_DOCUMENT,
				...flags,
				message: "keep reading",
			}),
		).not.toBe("reference");
	});

	it.each([
		"the rest of the team is on holiday",
		"the rest of the day is free",
		"what does the rest of the team say about it",
		"in full swing",
		"we're in full agreement",
		"pay the invoice in full by friday",
		"in full view of everyone",
		"read on the train",
		"keep reading the news",
		"continue reading the book i told you about",
		"next part of the plan",
		"next page of the calendar please",
		"the next chapter of my life",
		"next section of the exam",
		"more of the same",
		"more from the team",
		"a többi kolléga is jön",
		"vasárnap a többiek",
		"ha többi van",
		"a következő rész a filmből",
	])("leaves ordinary talk like %j alone even with a document in play", (message) => {
		expect(
			inferDocumentContextIntent({
				...NO_DOCUMENT,
				message,
				hasRetrievedEvidence: true,
			}),
		).toBe(
			inferDocumentContextIntent({
				...NO_DOCUMENT,
				message,
				hasRetrievedEvidence: false,
			}),
		);
		expect(
			inferDocumentContextIntent({
				...NO_DOCUMENT,
				message,
				hasRetrievedEvidence: true,
			}),
		).not.toBe("task");
	});

	it.each([
		"the rest",
		"the rest of the document",
		"read on please",
		"keep reading the document",
		"quote it in full.",
		"next section of the document",
		"next page please",
		"continue reading it",
		"a többi",
		"a többi részét is",
		"kérem a többit is",
	])("still promotes %j", (message) => {
		expect(
			inferDocumentContextIntent({
				...NO_DOCUMENT,
				message,
				hasRetrievedEvidence: true,
			}),
		).toBe("task");
	});

	it("does not promote depth when no document is in play", () => {
		for (const message of [
			"the rest of it",
			"read on",
			"a többit",
			"olvasd tovább",
			"mutasd az egészet",
		]) {
			expect(
				inferDocumentContextIntent({ ...NO_DOCUMENT, message }),
				message,
			).toBe("reference");
		}
		// "what" is a pre-existing answer-intent word; without a document in
		// play the continuation phrase must not lift it past that.
		expect(
			inferDocumentContextIntent({
				...NO_DOCUMENT,
				message: "what else does it say?",
			}),
		).toBe("answer");
	});

	it("leaves an ordinary 'continue' at its usual depth", () => {
		for (const message of ["continue", "folytasd", "go on", "ok"]) {
			expect(
				inferDocumentContextIntent({ ...NO_DOCUMENT, message }),
				message,
			).toBe("reference");
			expect(
				inferDocumentContextIntent({
					...NO_DOCUMENT,
					message,
					hasRetrievedEvidence: true,
				}),
				message,
			).toBe("reference");
		}
		// An explicit attachment plus a bare "continue" keeps the pre-existing
		// outcome (no document reference, no task verb → reference).
		expect(
			inferDocumentContextIntent({
				...NO_DOCUMENT,
				message: "continue",
				hasCurrentAttachments: true,
			}),
		).toBe("reference");
	});
});
