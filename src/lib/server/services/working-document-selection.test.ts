import { describe, expect, it } from "vitest";
import type { Artifact } from "$lib/types";
import { resolveWorkingDocumentSelection } from "./working-document-selection";

function generatedArtifact(
	id: string,
	metadata: Record<string, unknown>,
	updatedAt: number,
): Artifact {
	return {
		id,
		userId: "user-1",
		type: "generated_output",
		retrievalClass: "durable",
		name: `${id}.pdf`,
		mimeType: "application/pdf",
		sizeBytes: 100,
		conversationId: "conv-1",
		summary: null,
		createdAt: updatedAt,
		updatedAt,
		extension: "pdf",
		storagePath: null,
		contentText: null,
		metadata,
	};
}

describe("working document selection", () => {
	it("projects active focus and correction signals through the public contract", () => {
		const selection = resolveWorkingDocumentSelection({
			message: "Actually, refine this brief instead.",
			activeDocumentArtifactId: "brief-v1",
			currentConversationId: "conv-1",
			artifacts: [
				generatedArtifact(
					"brief-v1",
					{
						documentFamilyId: "family-brief",
						documentLabel: "Project brief",
						versionNumber: 1,
					},
					1,
				),
				generatedArtifact(
					"brief-v2",
					{
						documentFamilyId: "family-brief",
						documentLabel: "Project brief",
						versionNumber: 2,
					},
					2,
				),
			],
		});

		expect(selection.currentDocument).toMatchObject({
			artifactId: "brief-v1",
			familyId: "family-brief",
		});
		expect(selection.activeFocus.artifactIds).toEqual(["brief-v1"]);
		expect(selection.correction.targetArtifactIds).toEqual(["brief-v1"]);
		expect(selection.prompt.reasonCodesByArtifactId.get("brief-v1")).toEqual([
			"active_document_focus",
			"recent_user_correction",
			"preferred_artifact",
		]);
		expect(
			selection.workingSet.candidateSignalsByArtifactId.get("brief-v1"),
		).toMatchObject({
			isActiveDocumentFocus: true,
			isRecentUserCorrection: true,
		});
		expect(selection.retrieval.preferredArtifactId).toBe("brief-v1");
		expect(selection.taskEvidence.protectedArtifactIds).toEqual([
			"brief-v1",
			"brief-v2",
		]);
	});

	it("does not expose internal live-signal state through the public contract", () => {
		const selection = resolveWorkingDocumentSelection({
			message: "Please summarize this document.",
			currentConversationId: "conv-1",
			artifacts: [],
		});

		expect("activeDocumentState" in selection).toBe(false);
	});

	it("clears current, focus, correction, and refinement carryover on reset phrasing", () => {
		const selection = resolveWorkingDocumentSelection({
			message: "Actually, we are done with that document, move on.",
			activeDocumentArtifactId: "brief-v2",
			currentConversationId: "conv-1",
			artifacts: [
				generatedArtifact(
					"brief-v2",
					{
						documentFamilyId: "family-brief",
						documentLabel: "Project brief",
						versionNumber: 2,
						supersedesArtifactId: "brief-v1",
					},
					2,
				),
			],
		});

		expect(selection.reset).toEqual({
			hasSignal: true,
			suppressCarryover: true,
		});
		expect(selection.currentDocument).toBe(null);
		expect(selection.activeFocus.artifactIds).toEqual([]);
		expect(selection.correction).toEqual({
			hasSignal: false,
			targetArtifactIds: [],
		});
		expect(selection.recentRefinement).toEqual({
			familyId: null,
			artifactIds: [],
		});
		expect(selection.retrieval).toMatchObject({
			preferredArtifactId: null,
			preferredGeneratedFamilyId: null,
			suppressGeneratedCarryover: true,
		});
		expect(selection.taskEvidence.protectedArtifactIds).toEqual([]);
	});

	it("exposes the current generated document selected by the generated-document resolver", () => {
		const selection = resolveWorkingDocumentSelection({
			message: "Please summarize this document.",
			currentConversationId: "conv-1",
			artifacts: [
				generatedArtifact(
					"brief-v1",
					{
						documentFamilyId: "family-brief",
						documentLabel: "Project brief",
						versionNumber: 1,
					},
					1,
				),
			],
		});

		expect(selection.currentDocument).toMatchObject({
			artifactId: "brief-v1",
			familyId: "family-brief",
			source: "generated_document",
		});
		expect(selection.latestGeneratedDocumentIds).toEqual(["brief-v1"]);
		expect(selection.prompt.reasonCodesByArtifactId.get("brief-v1")).toEqual([
			"current_generated_document",
		]);
		expect(
			selection.workingSet.candidateSignalsByArtifactId.get("brief-v1"),
		).toMatchObject({
			isCurrentGeneratedDocument: true,
			isSelectedCurrentGeneratedDocument: true,
		});
		expect(selection.retrieval.preferredArtifactId).toBe("brief-v1");
		expect(selection.taskEvidence.protectedArtifactIds).toEqual(["brief-v1"]);
	});

	it("carries the recently refined generated-document family into follow-up turns", () => {
		const selection = resolveWorkingDocumentSelection({
			message: "Please make it shorter.",
			currentConversationId: "conv-1",
			artifacts: [
				generatedArtifact(
					"brief-v2",
					{
						documentFamilyId: "family-brief",
						documentLabel: "Project brief",
						versionNumber: 2,
						supersedesArtifactId: "brief-v1",
					},
					2,
				),
				generatedArtifact(
					"slides-v1",
					{
						documentFamilyId: "family-slides",
						documentLabel: "Investor slides",
						versionNumber: 1,
					},
					3,
				),
			],
		});

		expect(selection.recentRefinement).toEqual({
			familyId: "family-brief",
			artifactIds: ["brief-v2"],
		});
		expect(selection.currentDocument).toMatchObject({
			artifactId: "brief-v2",
			familyId: "family-brief",
		});
		expect(selection.prompt.reasonCodesByArtifactId.get("brief-v2")).toEqual([
			"recently_refined_document_family",
		]);
		expect(selection.retrieval).toMatchObject({
			preferredArtifactId: "brief-v2",
			preferredGeneratedFamilyId: "family-brief",
		});
		expect(selection.taskEvidence.protectedArtifactIds).toEqual(["brief-v2"]);
	});

	it("does not promote an unrelated open workspace document as current", () => {
		const selection = resolveWorkingDocumentSelection({
			message: "What is the capital of France?",
			activeDocumentArtifactId: "brief-v1",
			currentConversationId: "conv-1",
			artifacts: [
				generatedArtifact(
					"brief-v1",
					{
						documentFamilyId: "family-brief",
						documentLabel: "Project brief",
						versionNumber: 1,
					},
					1,
				),
			],
		});

		expect(selection.documentFocused).toBe(false);
		expect(selection.currentDocument).toBe(null);
		expect(selection.activeFocus.artifactIds).toEqual([]);
		expect(selection.correction.targetArtifactIds).toEqual([]);
		expect(selection.retrieval.preferredArtifactId).toBe(null);
		expect(selection.taskEvidence.protectedArtifactIds).toEqual([]);
		expect(
			selection.workingSet.candidateSignalsByArtifactId.get("brief-v1"),
		).toMatchObject({
			isActiveDocumentFocus: false,
			isRecentUserCorrection: false,
			isSelectedCurrentGeneratedDocument: false,
		});
	});

	it("suppresses generated-output carryover for new file creation requests", () => {
		const selection = resolveWorkingDocumentSelection({
			message: "Create a new one-page PDF file called brief-v1.pdf.",
			currentConversationId: "conv-1",
			artifacts: [
				generatedArtifact(
					"brief-v1",
					{
						documentFamilyId: "family-brief",
						documentLabel: "Project brief",
						versionNumber: 1,
						generatedFilename: "brief-v1.pdf",
					},
					1,
				),
			],
		});

		expect(selection.currentDocument).toBe(null);
		expect(selection.latestGeneratedDocumentIds).toEqual([]);
		expect(selection.retrieval).toMatchObject({
			preferredArtifactId: null,
			preferredGeneratedFamilyId: null,
			suppressGeneratedCarryover: true,
		});
		expect(selection.taskEvidence.protectedArtifactIds).toEqual([]);
	});

	it("keeps the active document focused when the request says the document", () => {
		const selection = resolveWorkingDocumentSelection({
			message: "Make the document shorter.",
			activeDocumentArtifactId: "brief-v1",
			currentConversationId: "conv-1",
			artifacts: [
				generatedArtifact(
					"brief-v1",
					{
						documentFamilyId: "family-brief",
						documentLabel: "Project brief",
						versionNumber: 1,
					},
					1,
				),
			],
		});

		expect(selection.currentDocument).toMatchObject({
			artifactId: "brief-v1",
			familyId: "family-brief",
			source: "active_focus",
		});
		expect(selection.activeFocus.artifactIds).toEqual(["brief-v1"]);
		expect(selection.prompt.reasonCodesByArtifactId.get("brief-v1")).toEqual([
			"active_document_focus",
			"preferred_artifact",
		]);
		expect(selection.taskEvidence.protectedArtifactIds).toEqual(["brief-v1"]);
	});

	it("keeps the active document focused when creating a file from the document", () => {
		const selection = resolveWorkingDocumentSelection({
			message: "Create a PDF from the document.",
			activeDocumentArtifactId: "brief-v1",
			currentConversationId: "conv-1",
			artifacts: [
				generatedArtifact(
					"brief-v1",
					{
						documentFamilyId: "family-brief",
						documentLabel: "Project brief",
						versionNumber: 1,
					},
					1,
				),
			],
		});

		expect(selection.currentDocument).toMatchObject({
			artifactId: "brief-v1",
			familyId: "family-brief",
			source: "active_focus",
		});
		expect(selection.retrieval).toMatchObject({
			preferredArtifactId: "brief-v1",
			preferredGeneratedFamilyId: null,
			suppressGeneratedCarryover: true,
		});
		expect(selection.taskEvidence.protectedArtifactIds).toEqual(["brief-v1"]);
	});
});
