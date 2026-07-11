import { describe, expect, it } from "vitest";
import type {
	ArtifactSummary,
	ContextDebugState,
	ConversationContextStatus,
	LinkedContextSource,
} from "$lib/types";
import { buildContextSourcesState } from "./context-sources";

describe("buildContextSourcesState", () => {
	it("keeps linked source documents distinct from uploaded attachments", () => {
		const state = buildContextSourcesState({
			userId: "user-1",
			conversationId: "conv-1",
			attachedArtifacts: [artifact("attachment-1", "Uploaded attachment")],
			linkedSources: [linkedSource("display-1", "Linked plan.pdf")],
			now: new Date("2026-05-05T10:00:00.000Z"),
		});

		expect(state.activeCount).toBe(2);
		expect(state.groups.map((group) => group.kind)).toEqual([
			"attachments",
			"linked_source",
		]);
		expect(
			state.groups.find((group) => group.kind === "linked_source"),
		).toEqual(
			expect.objectContaining({
				kind: "linked_source",
				state: "active",
				totalCount: 1,
				items: [
					expect.objectContaining({
						id: "linked_source:display-1",
						artifactId: "display-1",
						title: "Linked plan.pdf",
						state: "active",
						sourceType: "document",
						reason: "linked_context_source",
						compacted: false,
						reduced: false,
						metadata: {
							promptArtifactId: "prompt-display-1",
							documentOrigin: "uploaded",
						},
					}),
				],
			}),
		);
	});

	it("treats selected message evidence as inferred instead of active carried-forward context", () => {
		const contextDebug: ContextDebugState = {
			activeTaskId: null,
			activeTaskObjective: null,
			taskLocked: false,
			routingStage: "deterministic",
			routingConfidence: 1,
			verificationStatus: "skipped",
			selectedEvidence: [
				{
					artifactId: "artifact-message-evidence",
					name: "Message evidence",
					artifactType: "source_document",
					sourceType: "document",
					role: "selected",
					origin: "system",
					confidence: 0.9,
					reason: "retrieved for this response",
				},
			],
			selectedEvidenceBySource: [{ sourceType: "document", count: 1 }],
			pinnedEvidence: [],
			excludedEvidence: [],
		};

		const state = buildContextSourcesState({
			userId: "user-1",
			conversationId: "conv-1",
			contextDebug,
			now: new Date("2026-05-05T10:00:00.000Z"),
		});

		expect(state.activeCount).toBe(0);
		expect(state.inferredCount).toBe(1);
		expect(state.selectedCount).toBe(1);
		expect(state.groups).toEqual([
			expect.objectContaining({
				kind: "task_evidence",
				state: "inferred",
				items: [
					expect.objectContaining({
						artifactId: "artifact-message-evidence",
						state: "inferred",
					}),
				],
			}),
		]);
	});

	it("exposes inherited fork history as conversation context provenance", () => {
		const contextDebug: ContextDebugState = {
			activeTaskId: null,
			activeTaskObjective: null,
			taskLocked: false,
			routingStage: "deterministic",
			routingConfidence: 1,
			verificationStatus: "skipped",
			selectedEvidence: [],
			selectedEvidenceBySource: [],
			pinnedEvidence: [],
			excludedEvidence: [],
			forkProvenance: {
				inheritedMessageCount: 2,
				inheritedTurnCount: 1,
				forkLocalMessageCount: 1,
				sourceConversationIds: ["source-conv"],
				sourceMessageIds: ["source-user-1", "source-assistant-1"],
				copiedForkPointMessageId: "fork-assistant-1",
			},
		};

		const state = buildContextSourcesState({
			userId: "user-1",
			conversationId: "fork-conv",
			contextDebug,
			now: new Date("2026-05-05T10:00:00.000Z"),
		});

		expect(state.inferredCount).toBe(1);
		expect(state.groups).toEqual([
			expect.objectContaining({
				kind: "conversation",
				state: "inferred",
				totalCount: 1,
				items: [
					expect.objectContaining({
						id: "conversation:fork-inherited-history",
						title: "Inherited fork history",
						sourceType: "conversation",
						reason: "fork_inherited_history",
						metadata: {
							inheritedMessageCount: 2,
							inheritedTurnCount: 1,
							forkLocalMessageCount: 1,
							sourceConversationCount: 1,
							sourceMessageCount: 2,
							copiedForkPointMessageId: "fork-assistant-1",
						},
					}),
				],
			}),
		]);
	});

	it("does not mark sources as reduced when extra tracked rows do not prove budget loss", () => {
		const contextStatus: ConversationContextStatus = {
			conversationId: "conv-1",
			userId: "user-1",
			estimatedTokens: 4_000,
			maxContextTokens: 100_000,
			thresholdTokens: 80_000,
			targetTokens: 90_000,
			compactionApplied: false,
			compactionMode: "none",
			routingStage: "deterministic",
			routingConfidence: 1,
			verificationStatus: "skipped",
			layersUsed: ["working_set", "task_state"],
			workingSetCount: 2,
			workingSetArtifactIds: ["artifact-selected", "artifact-related"],
			workingSetApplied: true,
			taskStateApplied: true,
			promptArtifactCount: 1,
			recentTurnCount: 1,
			summary: null,
			updatedAt: 1_777_140_000_000,
		};
		const contextDebug: ContextDebugState = {
			activeTaskId: null,
			activeTaskObjective: null,
			taskLocked: false,
			routingStage: "deterministic",
			routingConfidence: 1,
			verificationStatus: "skipped",
			selectedEvidence: [
				{
					artifactId: "artifact-selected",
					name: "Selected source",
					artifactType: "source_document",
					sourceType: "document",
					role: "selected",
					origin: "system",
					confidence: 0.9,
					reason: "matches the current request",
				},
			],
			selectedEvidenceBySource: [{ sourceType: "document", count: 1 }],
			pinnedEvidence: [],
			excludedEvidence: [],
		};

		const state = buildContextSourcesState({
			userId: "user-1",
			conversationId: "conv-1",
			contextStatus,
			contextDebug,
			activeWorkingSet: [
				artifact("artifact-selected", "Selected source"),
				artifact("artifact-related", "Related available source"),
			],
			now: new Date("2026-05-05T10:00:00.000Z"),
		});

		expect(state.activeCount).toBe(2);
		expect(state.inferredCount).toBe(1);
		expect(state.selectedCount).toBe(1);
		expect(state.compacted).toBe(false);
		expect(state.reduced).toBe(false);
		expect(state.groups.flatMap((group) => group.items)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ reduced: false, compacted: false }),
			]),
		);
	});

	it("exposes an omitted Baseline Memory Profile as reduced and compacted memory context", () => {
		const state = buildContextSourcesState({
			userId: "user-1",
			conversationId: "conv-1",
			contextTraceSections: [
				{
					name: "Baseline Memory Profile",
					source: "memory",
					body: "",
					inclusionLevel: "omitted",
					signalReasons: ["active_memory_profile:projection"],
					protected: true,
					trimmed: false,
				},
			],
			now: new Date("2026-05-05T10:00:00.000Z"),
		});

		// A section is only "compacted" (the severe state) once something was
		// truly dropped wholesale — an "omitted" trace section, as here.
		expect(state.reduced).toBe(true);
		expect(state.compacted).toBe(true);
		expect(state.groups).toEqual([
			expect.objectContaining({
				kind: "memory",
				state: "inferred",
				totalCount: 1,
				items: [
					expect.objectContaining({
						id: "memory:baseline-memory-profile",
						title: "Baseline Memory Profile",
						state: "inferred",
						sourceType: "memory",
						reason: "active_memory_profile:projection",
						reduced: true,
						compacted: true,
						metadata: {
							inclusionLevel: "omitted",
							omitted: true,
							protected: true,
							trimmed: false,
						},
					}),
				],
			}),
		]);
	});

	it("exposes memory_context applied limits and omitted counts when tool audit metadata is available", () => {
		const state = buildContextSourcesState({
			userId: "user-1",
			conversationId: "conv-1",
			toolCalls: [
				{
					name: "memory_context",
					input: { mode: "history", query: "bike" },
					status: "done",
					sourceType: "memory",
					metadata: {
						mode: "history",
						appliedMaxHistoryConversations: 3,
						omittedConversationCount: 2,
						appliedMaxMessages: 10,
						omittedMessageCount: 4,
					},
				},
			],
			now: new Date("2026-05-05T10:00:00.000Z"),
		});

		expect(state.reduced).toBe(true);
		expect(state.groups).toEqual([
			expect.objectContaining({
				kind: "memory",
				items: [
					expect.objectContaining({
						id: "memory:memory_context:history",
						title: "memory_context history",
						sourceType: "memory",
						reason: "memory_context_tool",
						reduced: true,
						metadata: {
							mode: "history",
							appliedMaxHistoryConversations: 3,
							omittedConversationCount: 2,
							appliedMaxMessages: 10,
							omittedMessageCount: 4,
						},
					}),
				],
			}),
		]);
	});

	it("marks selected document evidence as reduced when its trace section was truncated", () => {
		const contextDebug: ContextDebugState = {
			activeTaskId: null,
			activeTaskObjective: null,
			taskLocked: false,
			routingStage: "deterministic",
			routingConfidence: 1,
			verificationStatus: "skipped",
			selectedEvidence: [
				{
					artifactId: "doc-1",
					name: "Planning brief",
					artifactType: "source_document",
					sourceType: "document",
					role: "selected",
					origin: "system",
					confidence: 0.9,
					reason: "matched request",
				},
			],
			selectedEvidenceBySource: [{ sourceType: "document", count: 1 }],
			pinnedEvidence: [],
			excludedEvidence: [],
		};

		const state = buildContextSourcesState({
			userId: "user-1",
			conversationId: "conv-1",
			contextDebug,
			contextTraceSections: [
				{
					name: "Retrieved Evidence",
					source: "document",
					body: "truncated excerpt",
					inclusionLevel: "legacy_truncated",
					itemIds: ["doc-1"],
					itemTitles: ["Planning brief"],
					signalReasons: ["working_set_context:budgeted"],
					protected: false,
					trimmed: true,
				},
			],
			now: new Date("2026-05-05T10:00:00.000Z"),
		});

		expect(state.reduced).toBe(true);
		expect(state.groups).toEqual([
			expect.objectContaining({
				kind: "task_evidence",
				items: [
					expect.objectContaining({
						artifactId: "doc-1",
						title: "Planning brief",
						reduced: true,
						metadata: {
							inclusionLevel: "legacy_truncated",
							omitted: false,
							trimmed: true,
						},
					}),
				],
			}),
		]);
	});

	it("does not mark many available memories or documents as reduced without omission evidence", () => {
		const contextDebug: ContextDebugState = {
			activeTaskId: null,
			activeTaskObjective: null,
			taskLocked: false,
			routingStage: "deterministic",
			routingConfidence: 1,
			verificationStatus: "skipped",
			selectedEvidence: Array.from({ length: 12 }, (_, index) => ({
				artifactId: `doc-${index}`,
				name: `Document ${index}`,
				artifactType: "source_document" as const,
				sourceType: "document" as const,
				role: "selected" as const,
				origin: "system" as const,
				confidence: 0.8,
				reason: "matched request",
			})),
			selectedEvidenceBySource: [{ sourceType: "document", count: 12 }],
			pinnedEvidence: [],
			excludedEvidence: [],
		};

		const state = buildContextSourcesState({
			userId: "user-1",
			conversationId: "conv-1",
			contextDebug,
			activeWorkingSet: Array.from({ length: 24 }, (_, index) =>
				artifact(`work-${index}`, `Available document ${index}`),
			),
			toolCalls: [
				{
					name: "memory_context",
					input: { mode: "history", query: "bike" },
					status: "done",
					sourceType: "memory",
					metadata: {
						mode: "history",
						appliedMaxHistoryConversations: 8,
						omittedConversationCount: 0,
					},
				},
			],
			now: new Date("2026-05-05T10:00:00.000Z"),
		});

		expect(state.reduced).toBe(false);
		expect(state.groups.flatMap((group) => group.items)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ reduced: false, compacted: false }),
			]),
		);
	});

	it("summarizes active, pinned, excluded, reduced, and compacted context sources", () => {
		const contextStatus: ConversationContextStatus = {
			conversationId: "conv-1",
			userId: "user-1",
			estimatedTokens: 72_000,
			maxContextTokens: 100_000,
			thresholdTokens: 80_000,
			targetTokens: 90_000,
			compactionApplied: true,
			compactionMode: "deterministic",
			routingStage: "semantic",
			routingConfidence: 0.8,
			verificationStatus: "passed",
			layersUsed: ["working_set", "task_state"],
			workingSetCount: 1,
			workingSetArtifactIds: ["artifact-work"],
			workingSetApplied: true,
			taskStateApplied: true,
			promptArtifactCount: 1,
			recentTurnCount: 3,
			summary: null,
			updatedAt: 1_777_140_000_000,
		};
		const contextDebug: ContextDebugState = {
			activeTaskId: "task-1",
			activeTaskObjective: "Compare documents",
			taskLocked: false,
			routingStage: "semantic",
			routingConfidence: 0.8,
			verificationStatus: "passed",
			selectedEvidence: [
				{
					artifactId: "artifact-selected",
					name: "Selected source",
					artifactType: "source_document",
					sourceType: "document",
					role: "selected",
					origin: "system",
					confidence: 0.9,
					reason: "matches the current request",
				},
			],
			selectedEvidenceBySource: [{ sourceType: "document", count: 1 }],
			pinnedEvidence: [
				{
					artifactId: "artifact-pinned",
					name: "Pinned source",
					artifactType: "source_document",
					sourceType: "document",
					role: "pinned",
					origin: "user",
					confidence: 1,
					reason: "pinned by user",
				},
			],
			excludedEvidence: [
				{
					artifactId: "artifact-excluded",
					name: "Excluded source",
					artifactType: "source_document",
					sourceType: "document",
					role: "excluded",
					origin: "user",
					confidence: 1,
					reason: "excluded by user",
				},
			],
		};

		const state = buildContextSourcesState({
			userId: "user-1",
			conversationId: "conv-1",
			contextStatus,
			contextDebug,
			attachedArtifacts: [artifact("artifact-attachment", "Attached source")],
			activeWorkingSet: [artifact("artifact-work", "Working set source")],
			// A section truly dropped wholesale — "compacted" is now reserved for
			// this (or the LLM-fallback history compaction), not routine trimming.
			contextTraceSections: [
				{
					name: "Old Session History",
					source: "session",
					body: "",
					inclusionLevel: "omitted",
				},
			],
			now: new Date("2026-05-05T10:00:00.000Z"),
		});

		expect(state).toMatchObject({
			conversationId: "conv-1",
			userId: "user-1",
			selectedCount: 1,
			pinnedCount: 1,
			excludedCount: 1,
			reduced: true,
			compacted: true,
			updatedAt: new Date("2026-05-05T10:00:00.000Z").getTime(),
		});
		expect(state.activeCount).toBe(3);
		expect(state.groups.map((group) => group.kind)).toEqual([
			"attachments",
			"working_set",
			"task_evidence",
			"pinned",
			"excluded",
		]);
		expect(state.groups[0].items[0]).toMatchObject({
			artifactId: "artifact-attachment",
			title: "Attached source",
			state: "active",
			reduced: true,
			compacted: true,
		});
		expect(
			state.groups.find((group) => group.kind === "task_evidence"),
		).toMatchObject({
			state: "inferred",
			items: [
				expect.objectContaining({
					artifactId: "artifact-selected",
					state: "inferred",
				}),
			],
		});
	});

	it("adds compact project folder awareness as one inferred conversation source", () => {
		const state = buildContextSourcesState({
			userId: "user-1",
			conversationId: "conv-1",
			projectFolderReference: {
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
				omittedSiblingCount: 3,
			},
			now: new Date("2026-05-05T10:00:00.000Z"),
		});

		expect(state.activeCount).toBe(0);
		expect(state.inferredCount).toBe(1);
		expect(state.groups).toEqual([
			expect.objectContaining({
				kind: "project_folder",
				state: "inferred",
				totalCount: 5,
				items: [
					expect.objectContaining({
						id: "project_folder:folder-1",
						title: "Launch folder",
						state: "inferred",
						sourceType: "conversation",
						reason: "2 sibling conversations summarized, 3 more omitted",
						metadata: {
							projectId: "folder-1",
							projectName: "Launch folder",
							siblingCount: 5,
							includedSiblingCount: 2,
							omittedSiblingCount: 3,
							siblingSummary:
								"Pricing notes: Stable pricing brief. Rollout plan",
						},
					}),
				],
			}),
		]);
	});
});

function artifact(id: string, name: string): ArtifactSummary {
	return {
		id,
		name,
		type: "source_document",
		retrievalClass: "durable",
		mimeType: "text/plain",
		sizeBytes: 1024,
		conversationId: "conv-1",
		summary: null,
		createdAt: 1_777_140_000_000,
		updatedAt: 1_777_140_000_000,
	};
}

function linkedSource(
	displayArtifactId: string,
	name: string,
): LinkedContextSource {
	return {
		displayArtifactId,
		promptArtifactId: `prompt-${displayArtifactId}`,
		familyArtifactIds: [displayArtifactId, `prompt-${displayArtifactId}`],
		name,
		type: "document",
		mimeType: "application/pdf",
		documentOrigin: "uploaded",
	};
}
