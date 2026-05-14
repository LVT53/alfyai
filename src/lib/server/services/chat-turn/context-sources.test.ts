import { describe, expect, it } from "vitest";
import { buildContextSourcesState } from "./context-sources";
import type {
	ArtifactSummary,
	ContextDebugState,
	ConversationContextStatus,
	LinkedContextSource,
} from "$lib/types";

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
		expect(state.groups.find((group) => group.kind === "linked_source")).toEqual(
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
						artifactType: "document",
						reason: "linked_context_source",
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
					artifactType: "document",
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
			honcho: null,
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
					artifactType: "document",
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
			honcho: {
				source: "session_context",
				summary: "Memory exists but was not a lost prompt source.",
				latencyMs: 12,
				diagnostics: null,
			},
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
		expect(state.inferredCount).toBe(2);
		expect(state.selectedCount).toBe(1);
		expect(state.compacted).toBe(false);
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
					artifactType: "document",
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
					artifactType: "document",
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
					artifactType: "document",
					sourceType: "document",
					role: "excluded",
					origin: "user",
					confidence: 1,
					reason: "excluded by user",
				},
			],
			honcho: null,
		};

		const state = buildContextSourcesState({
			userId: "user-1",
			conversationId: "conv-1",
			contextStatus,
			contextDebug,
			attachedArtifacts: [artifact("artifact-attachment", "Attached source")],
			activeWorkingSet: [artifact("artifact-work", "Working set source")],
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
		expect(state.groups.find((group) => group.kind === "task_evidence")).toMatchObject({
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

	it("adds compact project continuity awareness as one lower-authority inferred conversation source", () => {
		const state = buildContextSourcesState({
			userId: "user-1",
			conversationId: "conv-1",
			projectReference: {
				source: "project_continuity",
				projectId: "memory-project-1",
				projectName: "Launch continuity",
				entries: [
					{
						conversationId: "conv-linked-1",
						title: "Linked launch brief",
						objective: "Prepare the linked brief",
						summary: "Stable linked checkpoint.",
					},
					{
						conversationId: "conv-linked-2",
						title: "Linked rollout notes",
						objective: null,
						summary: null,
					},
				],
				omittedSiblingCount: 1,
			},
			now: new Date("2026-05-05T10:00:00.000Z"),
		});

		expect(state.activeCount).toBe(0);
		expect(state.inferredCount).toBe(1);
		expect(state.groups).toEqual([
			expect.objectContaining({
				kind: "project_continuity",
				state: "inferred",
				totalCount: 3,
				items: [
					expect.objectContaining({
						id: "project_continuity:memory-project-1",
						title: "Launch continuity",
						state: "inferred",
						sourceType: "conversation",
						reason: "2 linked conversations summarized, 1 more omitted",
						metadata: {
							projectId: "memory-project-1",
							projectName: "Launch continuity",
							siblingCount: 3,
							includedSiblingCount: 2,
							omittedSiblingCount: 1,
							siblingSummary:
								"Linked launch brief: Stable linked checkpoint. Linked rollout notes",
							authority: "project_continuity",
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
		type: "document",
		retrievalClass: "durable",
		mimeType: "text/plain",
		sizeBytes: 1024,
		conversationId: "conv-1",
		summary: null,
		createdAt: 1_777_140_000_000,
		updatedAt: 1_777_140_000_000,
	};
}

function linkedSource(displayArtifactId: string, name: string): LinkedContextSource {
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
