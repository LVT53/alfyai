import { describe, expect, it } from "vitest";
import type { KnowledgeDocumentItem } from "$lib/server/services/knowledge/types";
import {
	getWorkspaceDocumentForArtifact,
	toWorkspaceDocument,
} from "./_helpers";

function makeKnowledgeDocument(
	overrides: Partial<KnowledgeDocumentItem> = {},
): KnowledgeDocumentItem {
	return {
		id: overrides.id ?? overrides.displayArtifactId ?? "artifact-source",
		type: overrides.type ?? "source_document",
		displayArtifactId: overrides.displayArtifactId ?? "artifact-source",
		promptArtifactId: overrides.promptArtifactId ?? "artifact-normalized",
		familyArtifactIds: overrides.familyArtifactIds ?? [
			"artifact-source",
			"artifact-normalized",
		],
		name: overrides.name ?? "Brief.pdf",
		mimeType: overrides.mimeType ?? "application/pdf",
		sizeBytes: overrides.sizeBytes ?? 1234,
		conversationId: overrides.conversationId ?? null,
		summary: overrides.summary ?? null,
		normalizedAvailable: overrides.normalizedAvailable ?? true,
		documentOrigin: overrides.documentOrigin ?? "uploaded",
		documentFamilyId: overrides.documentFamilyId ?? null,
		documentFamilyStatus: overrides.documentFamilyStatus ?? null,
		documentLabel: overrides.documentLabel ?? null,
		documentRole: overrides.documentRole ?? null,
		versionNumber: overrides.versionNumber ?? null,
		isOriginal: overrides.isOriginal ?? null,
		originConversationId: overrides.originConversationId ?? null,
		originAssistantMessageId: overrides.originAssistantMessageId ?? null,
		sourceChatFileId: overrides.sourceChatFileId ?? null,
		createdAt: overrides.createdAt ?? 1,
		updatedAt: overrides.updatedAt ?? 2,
	};
}

describe("workspace document helpers", () => {
	it("uses source preview identity for source documents that have normalized prompt content", () => {
		const document = makeKnowledgeDocument({
			id: "source-pdf",
			displayArtifactId: "source-pdf",
			promptArtifactId: "normalized-pdf",
			familyArtifactIds: ["source-pdf", "normalized-pdf"],
			name: "Benefits.pdf",
			mimeType: "application/pdf",
			normalizedAvailable: true,
		});

		expect(toWorkspaceDocument(document)).toMatchObject({
			id: "artifact:source-pdf",
			filename: "Benefits.pdf",
			title: "Benefits.pdf",
			artifactId: "source-pdf",
			sourceChatFileId: null,
		});
	});

	it("opens a source workspace document from its normalized prompt artifact id", () => {
		const document = makeKnowledgeDocument({
			id: "source-docx",
			displayArtifactId: "source-docx",
			promptArtifactId: "normalized-docx",
			familyArtifactIds: ["source-docx", "normalized-docx"],
			name: "Contract.docx",
			mimeType:
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			normalizedAvailable: true,
		});

		expect(
			getWorkspaceDocumentForArtifact([document], "normalized-docx"),
		).toMatchObject({
			id: "artifact:source-docx",
			artifactId: "source-docx",
			filename: "Contract.docx",
		});
	});

	it("opens the current generated workspace document from a historical family artifact id", () => {
		const document = makeKnowledgeDocument({
			id: "generated-v2",
			type: "generated_output",
			displayArtifactId: "generated-v2",
			promptArtifactId: "generated-v2",
			familyArtifactIds: ["generated-v1", "generated-v2"],
			name: "Report v2.docx",
			mimeType:
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			documentOrigin: "generated",
			documentFamilyId: "family-report",
			sourceChatFileId: "chat-file-v2",
		});

		expect(
			getWorkspaceDocumentForArtifact([document], "generated-v1"),
		).toMatchObject({
			id: "artifact:generated-v2",
			artifactId: "generated-v2",
			sourceChatFileId: "chat-file-v2",
			documentFamilyId: "family-report",
		});
	});
});
