import { describe, expect, it } from "vitest";
import {
	buildGeneratedOutputDocumentMetadata,
	getArtifactDocumentOrigin,
	getGeneratedOutputFamilyKey,
	parseWorkingDocumentMetadata,
	resolveGeneratedDocumentFamilyContext,
	resolveGeneratedDocumentFamilyStatus,
	selectLatestGeneratedDocumentCandidatesByFamily,
} from "./document-metadata";

describe("document metadata helpers", () => {
	it("parses the canonical working-document metadata shape", () => {
		expect(
			parseWorkingDocumentMetadata({
				documentFamilyId: "family-1",
				documentFamilyStatus: "historical",
				documentLabel: "Project brief",
				documentRole: "brief",
				versionNumber: 3,
				supersedesArtifactId: "artifact-2",
				originConversationId: "conv-1",
				originAssistantMessageId: "assistant-1",
				sourceChatFileId: "chat-file-1",
			}),
		).toEqual({
			documentFamilyId: "family-1",
			documentFamilyStatus: "historical",
			documentLabel: "Project brief",
			documentRole: "brief",
			versionNumber: 3,
			supersedesArtifactId: "artifact-2",
			originConversationId: "conv-1",
			originAssistantMessageId: "assistant-1",
			sourceChatFileId: "chat-file-1",
		});
	});

	it("builds generated-output metadata in the canonical shape", () => {
		expect(
			buildGeneratedOutputDocumentMetadata({
				familyId: "family-1",
				familyStatus: "active",
				label: "Project brief",
				role: "brief",
				versionNumber: 2,
				supersedesArtifactId: "artifact-1",
				originConversationId: "conv-1",
				originAssistantMessageId: "assistant-1",
				sourceChatFileId: "chat-file-1",
			}),
		).toEqual({
			documentFamilyId: "family-1",
			documentFamilyStatus: "active",
			documentLabel: "Project brief",
			documentRole: "brief",
			versionNumber: 2,
			supersedesArtifactId: "artifact-1",
			originConversationId: "conv-1",
			originAssistantMessageId: "assistant-1",
			sourceChatFileId: "chat-file-1",
		});
	});

	it("maps generated outputs to generated origin, source documents to uploaded, normalized to null", () => {
		expect(getArtifactDocumentOrigin("generated_output")).toBe("generated");
		expect(getArtifactDocumentOrigin("source_document")).toBe("uploaded");
		expect(getArtifactDocumentOrigin("normalized_document")).toBeNull();
		expect(getArtifactDocumentOrigin("work_capsule")).toBeNull();
	});

	it("resolves generated-document family context by explicit family id even after rename", () => {
		const resolved = resolveGeneratedDocumentFamilyContext({
			filename: "new-name.pdf",
			candidates: [
				{
					artifactId: "artifact-2",
					artifactName: "new-name.pdf generated file",
					updatedAt: 2,
					metadata: {
						generatedFilename: "new-name.pdf",
						documentFamilyId: "family-1",
						documentLabel: "Original project brief",
						documentRole: "brief",
						versionNumber: 2,
					},
				},
				{
					artifactId: "artifact-1",
					artifactName: "old-name.pdf generated file",
					updatedAt: 1,
					metadata: {
						generatedFilename: "old-name.pdf",
						documentFamilyId: "family-1",
						documentLabel: "Original project brief",
						documentRole: "brief",
						versionNumber: 1,
					},
				},
			],
		});

		expect(resolved).toEqual({
			familyId: "family-1",
			documentLabel: "Original project brief",
			documentRole: "brief",
			matchingArtifactIds: ["artifact-2", "artifact-1"],
		});
	});

	it("falls back to the generated-output family key helper when metadata is present", () => {
		expect(
			getGeneratedOutputFamilyKey({
				id: "artifact-1",
				metadata: {
					documentFamilyId: "family-1",
				},
			}),
		).toBe("output_family:family-1");
	});

	it("marks dormant generated-document families as historical after the configured age window", () => {
		const now = Date.UTC(2026, 3, 4);
		expect(
			resolveGeneratedDocumentFamilyStatus({
				updatedAt: now - 10 * 86_400_000,
				now,
			}),
		).toBe("active");
		expect(
			resolveGeneratedDocumentFamilyStatus({
				updatedAt: now - 35 * 86_400_000,
				now,
			}),
		).toBe("historical");
	});

	it("keeps only the latest artifact per generated-document family for retrieval paths", () => {
		expect(
			selectLatestGeneratedDocumentCandidatesByFamily([
				{
					artifactId: "artifact-1",
					artifactName: "brief-v1.docx generated file",
					updatedAt: 1,
					metadata: {
						documentFamilyId: "family-1",
						versionNumber: 1,
					},
				},
				{
					artifactId: "artifact-2",
					artifactName: "brief-v2.docx generated file",
					updatedAt: 2,
					metadata: {
						documentFamilyId: "family-1",
						versionNumber: 2,
					},
				},
				{
					artifactId: "artifact-3",
					artifactName: "slides-v1.pptx generated file",
					updatedAt: 3,
					metadata: {
						documentFamilyId: "family-2",
						versionNumber: 1,
					},
				},
			]).map((candidate) => candidate.artifactId),
		).toEqual(["artifact-3", "artifact-2"]);
	});
});
