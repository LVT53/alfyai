import { describe, expect, it } from "vitest";
import type { Artifact } from "$lib/types";
import {
	isGeneratedDocumentPromptEligible,
	resolveCurrentGeneratedDocumentSelection,
	resolveRelevantGeneratedDocumentArtifacts,
	resolveRelevantGeneratedDocumentSelection,
} from "./document-resolution";

function makeArtifact(params: {
	id: string;
	name: string;
	summary?: string | null;
	conversationId?: string | null;
	updatedAt?: number;
	metadata?: Record<string, unknown> | null;
}): Artifact {
	return {
		id: params.id,
		userId: "user-1",
		type: "generated_output",
		retrievalClass: "durable",
		name: params.name,
		mimeType: "application/pdf",
		sizeBytes: 1024,
		conversationId: params.conversationId ?? null,
		summary: params.summary ?? null,
		createdAt: params.updatedAt ?? 1,
		updatedAt: params.updatedAt ?? 1,
		extension: "pdf",
		storagePath: null,
		contentText: null,
		metadata: params.metadata ?? null,
	};
}

describe("document resolution", () => {
	it("dedupes generated outputs by family and prefers explicit label/name matches", () => {
		const resolved = resolveRelevantGeneratedDocumentArtifacts({
			query: "continue the project brief",
			limit: 4,
			artifacts: [
				makeArtifact({
					id: "artifact-1",
					name: "brief-v1.pdf",
					updatedAt: 1,
					metadata: {
						documentFamilyId: "family-brief",
						documentLabel: "Project brief",
						versionNumber: 1,
						generatedFilename: "brief-v1.pdf",
					},
				}),
				makeArtifact({
					id: "artifact-2",
					name: "brief-v2.pdf",
					updatedAt: 2,
					metadata: {
						documentFamilyId: "family-brief",
						documentLabel: "Project brief",
						versionNumber: 2,
						generatedFilename: "brief-v2.pdf",
					},
				}),
				makeArtifact({
					id: "artifact-3",
					name: "slides-v1.pdf",
					updatedAt: 3,
					metadata: {
						documentFamilyId: "family-slides",
						documentLabel: "Investor slides",
						versionNumber: 1,
						generatedFilename: "slides-v1.pdf",
					},
				}),
			],
		});

		expect(resolved).toHaveLength(1);
		expect(resolved[0]).toMatchObject({
			familyId: "family-brief",
		});
		expect(resolved[0]?.artifact.id).toBe("artifact-2");
	});

	it("boosts same-conversation generated documents when relevance is otherwise similar", () => {
		const resolved = resolveRelevantGeneratedDocumentArtifacts({
			query: "continue the report",
			currentConversationId: "conv-2",
			limit: 4,
			artifacts: [
				makeArtifact({
					id: "artifact-1",
					name: "report-v1.pdf",
					conversationId: "conv-1",
					updatedAt: 1,
					metadata: {
						documentFamilyId: "family-old",
						documentLabel: "Report",
						versionNumber: 1,
					},
				}),
				makeArtifact({
					id: "artifact-2",
					name: "report-v2.pdf",
					conversationId: "conv-2",
					updatedAt: 2,
					metadata: {
						documentFamilyId: "family-current",
						documentLabel: "Report",
						versionNumber: 1,
					},
				}),
			],
		});

		expect(resolved[0]?.artifact.id).toBe("artifact-2");
		expect(resolved[0]?.reasonCodes).toContain("same_conversation");
	});

	it("keeps the explicitly preferred generated artifact first without duplicating its family", () => {
		const selection = resolveRelevantGeneratedDocumentSelection({
			query: "continue the project brief",
			limit: 4,
			preferredArtifactId: "artifact-1",
			artifacts: [
				makeArtifact({
					id: "artifact-1",
					name: "brief-v1.pdf",
					updatedAt: 1,
					metadata: {
						documentFamilyId: "family-brief",
						documentLabel: "Project brief",
						versionNumber: 1,
					},
				}),
				makeArtifact({
					id: "artifact-2",
					name: "brief-v2.pdf",
					updatedAt: 2,
					metadata: {
						documentFamilyId: "family-brief",
						documentLabel: "Project brief",
						versionNumber: 2,
					},
				}),
				makeArtifact({
					id: "artifact-3",
					name: "slides-v1.pdf",
					updatedAt: 3,
					metadata: {
						documentFamilyId: "family-slides",
						documentLabel: "Investor slides",
						versionNumber: 1,
					},
				}),
			],
		});

		expect(selection.orderedArtifacts.map((artifact) => artifact.id)).toEqual([
			"artifact-1",
		]);
		expect(selection.primaryArtifactId).toBe("artifact-1");
		expect(selection.primaryReasonCodes).toEqual(["preferred_artifact"]);
	});

	it("keeps the latest artifact from a preferred family first without carrying unrelated families", () => {
		const selection = resolveRelevantGeneratedDocumentSelection({
			query: "please keep refining it",
			limit: 4,
			preferredFamilyId: "family-brief",
			artifacts: [
				makeArtifact({
					id: "artifact-1",
					name: "brief-v1.pdf",
					updatedAt: 1,
					metadata: {
						documentFamilyId: "family-brief",
						documentLabel: "Project brief",
						versionNumber: 1,
					},
				}),
				makeArtifact({
					id: "artifact-2",
					name: "brief-v2.pdf",
					updatedAt: 2,
					metadata: {
						documentFamilyId: "family-brief",
						documentLabel: "Project brief",
						versionNumber: 2,
					},
				}),
				makeArtifact({
					id: "artifact-3",
					name: "slides-v1.pdf",
					updatedAt: 3,
					metadata: {
						documentFamilyId: "family-slides",
						documentLabel: "Investor slides",
						versionNumber: 1,
					},
				}),
			],
		});

		expect(selection.orderedArtifacts.map((artifact) => artifact.id)).toEqual([
			"artifact-2",
		]);
		expect(selection.primaryReasonCodes).toEqual([
			"recently_refined_document_family",
		]);
	});

	it("boosts recently refined document families in retrieval ordering", () => {
		const selection = resolveRelevantGeneratedDocumentSelection({
			query: "please keep refining it",
			limit: 4,
			behaviorScoresByKey: new Map([["family-brief", 3]]),
			artifacts: [
				makeArtifact({
					id: "artifact-brief",
					name: "brief-v2.pdf",
					updatedAt: 2,
					metadata: {
						documentFamilyId: "family-brief",
						documentLabel: "Project brief",
						versionNumber: 2,
					},
				}),
				makeArtifact({
					id: "artifact-slides",
					name: "slides-v3.pdf",
					updatedAt: 3,
					metadata: {
						documentFamilyId: "family-slides",
						documentLabel: "Investor slides",
						versionNumber: 3,
					},
				}),
			],
		});

		expect(selection.orderedArtifacts.map((artifact) => artifact.id)).toEqual([
			"artifact-brief",
		]);
		expect(selection.resolutions[0]?.reasonCodes).toContain(
			"recent_refinement_behavior",
		);
	});

	it("boosts recently reopened document families in retrieval ordering", () => {
		const selection = resolveRelevantGeneratedDocumentSelection({
			query: "open the draft again",
			limit: 4,
			reopenScoresByKey: new Map([["family-brief", 3]]),
			artifacts: [
				makeArtifact({
					id: "artifact-brief",
					name: "brief-v2.pdf",
					updatedAt: 2,
					metadata: {
						documentFamilyId: "family-brief",
						documentLabel: "Project brief",
						versionNumber: 2,
					},
				}),
				makeArtifact({
					id: "artifact-slides",
					name: "slides-v3.pdf",
					updatedAt: 3,
					metadata: {
						documentFamilyId: "family-slides",
						documentLabel: "Investor slides",
						versionNumber: 3,
					},
				}),
			],
		});

		expect(selection.orderedArtifacts.map((artifact) => artifact.id)).toEqual([
			"artifact-brief",
		]);
		expect(selection.resolutions[0]?.reasonCodes).toContain(
			"recent_document_open",
		);
	});

	it("incorporates semantic and rerank boosts for generated document families", () => {
		const selection = resolveRelevantGeneratedDocumentSelection({
			query: "continue the forecast",
			limit: 4,
			semanticScoresByArtifactId: new Map([["artifact-forecast", 0.91]]),
			rerankScoresByArtifactId: new Map([["artifact-forecast", 0.83]]),
			artifacts: [
				makeArtifact({
					id: "artifact-brief",
					name: "brief-v2.pdf",
					updatedAt: 2,
					metadata: {
						documentFamilyId: "family-brief",
						documentLabel: "Project brief",
						versionNumber: 2,
					},
				}),
				makeArtifact({
					id: "artifact-forecast",
					name: "forecast-v1.pdf",
					updatedAt: 1,
					metadata: {
						documentFamilyId: "family-forecast",
						documentLabel: "Revenue forecast",
						versionNumber: 1,
					},
				}),
			],
		});

		expect(selection.orderedArtifacts[0]?.id).toBe("artifact-forecast");
		expect(selection.resolutions[0]?.reasonCodes).toEqual(
			expect.arrayContaining([
				"semantic_document_match",
				"reranked_document_match",
			]),
		);
	});

	it("downranks historical document families for generic carryover retrieval", () => {
		const selection = resolveRelevantGeneratedDocumentSelection({
			query: "draft",
			limit: 4,
			artifacts: [
				makeArtifact({
					id: "artifact-historical",
					name: "old-draft.pdf",
					updatedAt: 2,
					metadata: {
						documentFamilyId: "family-brief",
						documentLabel: "Project draft",
						documentFamilyStatus: "historical",
						versionNumber: 2,
					},
				}),
				makeArtifact({
					id: "artifact-active",
					name: "current-draft.pdf",
					updatedAt: 3,
					metadata: {
						documentFamilyId: "family-slides",
						documentLabel: "Current draft",
						versionNumber: 3,
					},
				}),
			],
		});

		expect(selection.orderedArtifacts.map((artifact) => artifact.id)).toEqual([
			"artifact-active",
			"artifact-historical",
		]);
	});

	it("still returns explicit generated-document query matches outside the preferred family", () => {
		const selection = resolveRelevantGeneratedDocumentSelection({
			query: "compare it with the investor slides",
			limit: 4,
			preferredFamilyId: "family-brief",
			artifacts: [
				makeArtifact({
					id: "artifact-1",
					name: "brief-v1.pdf",
					updatedAt: 1,
					metadata: {
						documentFamilyId: "family-brief",
						documentLabel: "Project brief",
						versionNumber: 1,
					},
				}),
				makeArtifact({
					id: "artifact-2",
					name: "brief-v2.pdf",
					updatedAt: 2,
					metadata: {
						documentFamilyId: "family-brief",
						documentLabel: "Project brief",
						versionNumber: 2,
					},
				}),
				makeArtifact({
					id: "artifact-3",
					name: "slides-v1.pdf",
					updatedAt: 3,
					metadata: {
						documentFamilyId: "family-slides",
						documentLabel: "Investor slides",
						versionNumber: 1,
					},
				}),
			],
		});

		expect(selection.orderedArtifacts.map((artifact) => artifact.id)).toEqual([
			"artifact-2",
			"artifact-3",
		]);
	});

	it("selects the latest artifact per generated document family for current-document context", () => {
		const selection = resolveCurrentGeneratedDocumentSelection({
			artifacts: [
				makeArtifact({
					id: "artifact-1",
					name: "brief-v1.pdf",
					updatedAt: 1,
					metadata: {
						documentFamilyId: "family-brief",
						documentLabel: "Project brief",
						versionNumber: 1,
					},
				}),
				makeArtifact({
					id: "artifact-2",
					name: "brief-v2.pdf",
					updatedAt: 2,
					metadata: {
						documentFamilyId: "family-brief",
						documentLabel: "Project brief",
						versionNumber: 2,
					},
				}),
				makeArtifact({
					id: "artifact-3",
					name: "slides-v1.pdf",
					updatedAt: 3,
					metadata: {
						documentFamilyId: "family-slides",
						documentLabel: "Investor slides",
						versionNumber: 1,
					},
				}),
			],
		});

		expect(selection.latestArtifactIds).toEqual(["artifact-3", "artifact-2"]);
		expect(selection.primaryArtifactId).toBe("artifact-3");
	});

	it("excludes failed source-first generated documents from current and preferred selection", () => {
		const selection = resolveCurrentGeneratedDocumentSelection({
			preferredArtifactId: "artifact-failed",
			artifacts: [
				makeArtifact({
					id: "artifact-failed",
					name: "failed-report.pdf",
					updatedAt: 3,
					metadata: {
						documentFamilyId: "family-failed",
						documentLabel: "Failed report",
						generatedDocumentSourceStatus: "failed",
					},
				}),
				makeArtifact({
					id: "artifact-ready",
					name: "ready-report.pdf",
					updatedAt: 2,
					metadata: {
						documentFamilyId: "family-ready",
						documentLabel: "Ready report",
						sourceChatFileId: "chat-file-ready",
						generatedDocumentSourceStatus: "succeeded",
					},
				}),
			],
		});

		expect(selection.primaryArtifactId).toBe("artifact-ready");
		expect(selection.latestArtifactIds).toEqual(["artifact-ready"]);

		expect(
			isGeneratedDocumentPromptEligible({
				artifact: makeArtifact({
					id: "artifact-failed",
					name: "failed-report.pdf",
					conversationId: "conv-1",
					metadata: {
						documentFamilyId: "family-failed",
						documentLabel: "Failed report",
						generatedDocumentSourceStatus: "failed",
					},
				}),
				conversationId: "conv-1",
				reasonCodes: ["current_generated_document"],
				messageMatchScore: 10,
				explicitlyRequested: true,
			}),
		).toBe(false);
	});

	it("preserves an explicitly preferred artifact id for current-document context", () => {
		const selection = resolveCurrentGeneratedDocumentSelection({
			preferredArtifactId: "artifact-1",
			artifacts: [
				makeArtifact({
					id: "artifact-1",
					name: "brief-v1.pdf",
					updatedAt: 1,
					metadata: {
						documentFamilyId: "family-brief",
						documentLabel: "Project brief",
						versionNumber: 1,
					},
				}),
				makeArtifact({
					id: "artifact-2",
					name: "brief-v2.pdf",
					updatedAt: 2,
					metadata: {
						documentFamilyId: "family-brief",
						documentLabel: "Project brief",
						versionNumber: 2,
					},
				}),
			],
		});

		expect(selection.latestArtifactIds).toEqual(["artifact-2"]);
		expect(selection.primaryArtifactId).toBe("artifact-1");
		expect(selection.primaryReasonCodes).toEqual(["preferred_artifact"]);
	});

	it("uses explicit query matches to choose the current generated document family over raw recency", () => {
		const selection = resolveCurrentGeneratedDocumentSelection({
			query: "continue the project brief",
			currentConversationId: "conv-1",
			artifacts: [
				makeArtifact({
					id: "artifact-brief",
					name: "brief-v2.pdf",
					conversationId: "conv-1",
					updatedAt: 2,
					metadata: {
						documentFamilyId: "family-brief",
						documentLabel: "Project brief",
						versionNumber: 2,
					},
				}),
				makeArtifact({
					id: "artifact-slides",
					name: "slides-v3.pdf",
					conversationId: "conv-1",
					updatedAt: 3,
					metadata: {
						documentFamilyId: "family-slides",
						documentLabel: "Investor slides",
						versionNumber: 3,
					},
				}),
			],
		});

		expect(selection.latestArtifactIds).toEqual([
			"artifact-slides",
			"artifact-brief",
		]);
		expect(selection.primaryArtifactId).toBe("artifact-brief");
		expect(selection.primaryReasonCodes).toContain("matched_document_label");
	});

	it("falls back to recency when there is no preferred artifact or explicit query match", () => {
		const selection = resolveCurrentGeneratedDocumentSelection({
			query: "please keep refining it",
			artifacts: [
				makeArtifact({
					id: "artifact-brief",
					name: "brief-v2.pdf",
					updatedAt: 2,
					metadata: {
						documentFamilyId: "family-brief",
						documentLabel: "Project brief",
						versionNumber: 2,
					},
				}),
				makeArtifact({
					id: "artifact-slides",
					name: "slides-v3.pdf",
					updatedAt: 3,
					metadata: {
						documentFamilyId: "family-slides",
						documentLabel: "Investor slides",
						versionNumber: 3,
					},
				}),
			],
		});

		expect(selection.primaryArtifactId).toBe("artifact-slides");
		expect(selection.primaryReasonCodes).toEqual([
			"current_generated_document",
		]);
	});

	it("prefers the most recently refined family over raw recency for generic follow-up turns", () => {
		const selection = resolveCurrentGeneratedDocumentSelection({
			query: "Please make it shorter.",
			preferredFamilyId: "family-brief",
			artifacts: [
				makeArtifact({
					id: "artifact-brief",
					name: "brief-v2.pdf",
					updatedAt: 2,
					metadata: {
						documentFamilyId: "family-brief",
						documentLabel: "Project brief",
						versionNumber: 2,
					},
				}),
				makeArtifact({
					id: "artifact-slides",
					name: "slides-v3.pdf",
					updatedAt: 3,
					metadata: {
						documentFamilyId: "family-slides",
						documentLabel: "Investor slides",
						versionNumber: 3,
					},
				}),
			],
		});

		expect(selection.primaryArtifactId).toBe("artifact-brief");
		expect(selection.primaryReasonCodes).toEqual([
			"recently_refined_document_family",
		]);
	});

	it("treats active/current generated documents as prompt-eligible even when ephemeral", () => {
		const artifact = makeArtifact({
			id: "artifact-1",
			name: "brief-v2.pdf",
			conversationId: "conv-1",
			updatedAt: 2,
			metadata: {
				documentFamilyId: "family-brief",
				documentLabel: "Project brief",
				versionNumber: 2,
			},
		});
		artifact.retrievalClass = "ephemeral";

		expect(
			isGeneratedDocumentPromptEligible({
				artifact,
				conversationId: "conv-1",
				reasonCodes: ["current_generated_document"],
				messageMatchScore: 0,
				explicitlyRequested: false,
			}),
		).toBe(true);
	});

	it("suppresses generic generated-document carryover when carryover is explicitly disabled", () => {
		const selection = resolveRelevantGeneratedDocumentSelection({
			query: "let's talk about something else",
			limit: 4,
			suppressCarryoverWhenUnfocused: true,
			artifacts: [
				makeArtifact({
					id: "artifact-brief",
					name: "brief-v2.pdf",
					updatedAt: 2,
					metadata: {
						documentFamilyId: "family-brief",
						documentLabel: "Project brief",
						versionNumber: 2,
					},
				}),
			],
		});

		expect(selection.orderedArtifacts).toEqual([]);
		expect(selection.primaryArtifactId).toBeNull();
	});

	it("does not re-add an exact generated-output filename match after carryover is suppressed", () => {
		const selection = resolveRelevantGeneratedDocumentSelection({
			query: "Create a new one-page PDF file called context-sweep-summary.pdf",
			limit: 4,
			suppressCarryoverWhenUnfocused: true,
			artifacts: [
				makeArtifact({
					id: "artifact-summary",
					name: "context-sweep-summary.pdf",
					updatedAt: 4,
					metadata: {
						documentFamilyId: "family-summary",
						documentLabel: "context-sweep-summary",
						versionNumber: 1,
						generatedFilename: "context-sweep-summary.pdf",
					},
				}),
			],
		});

		expect(selection.orderedArtifacts).toEqual([]);
		expect(selection.primaryArtifactId).toBeNull();
	});

	it("treats a recently corrected generated document as prompt-eligible even when ephemeral", () => {
		const artifact = makeArtifact({
			id: "artifact-1",
			name: "brief-v2.pdf",
			conversationId: "conv-1",
			updatedAt: 2,
			metadata: {
				documentFamilyId: "family-brief",
				documentLabel: "Project brief",
				versionNumber: 2,
			},
		});
		artifact.retrievalClass = "ephemeral";

		expect(
			isGeneratedDocumentPromptEligible({
				artifact,
				conversationId: "conv-1",
				reasonCodes: ["recent_user_correction"],
				messageMatchScore: 0,
				explicitlyRequested: false,
			}),
		).toBe(true);
	});

	it("treats a recently refined generated document family as prompt-eligible even when ephemeral", () => {
		const artifact = makeArtifact({
			id: "artifact-1",
			name: "brief-v2.pdf",
			conversationId: "conv-1",
			updatedAt: 2,
			metadata: {
				documentFamilyId: "family-brief",
				documentLabel: "Project brief",
				versionNumber: 2,
			},
		});
		artifact.retrievalClass = "ephemeral";

		expect(
			isGeneratedDocumentPromptEligible({
				artifact,
				conversationId: "conv-1",
				reasonCodes: ["recently_refined_document_family"],
				messageMatchScore: 0,
				explicitlyRequested: false,
			}),
		).toBe(true);
	});

	it("keeps unrelated ephemeral generated outputs out of prompt selection", () => {
		const artifact = makeArtifact({
			id: "artifact-1",
			name: "brief-v2.pdf",
			conversationId: "conv-1",
			updatedAt: 2,
			metadata: {
				documentFamilyId: "family-brief",
				documentLabel: "Project brief",
				versionNumber: 2,
			},
		});
		artifact.retrievalClass = "ephemeral";

		expect(
			isGeneratedDocumentPromptEligible({
				artifact,
				conversationId: "conv-1",
				reasonCodes: [],
				messageMatchScore: 0,
				explicitlyRequested: false,
			}),
		).toBe(false);
	});
});
