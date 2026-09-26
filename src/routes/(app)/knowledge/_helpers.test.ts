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
		kind: overrides.kind,
		artifactVersionNumber: overrides.artifactVersionNumber,
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

	// Slice 7 (Feature 2, ADR-0066): a Document/App/Canvas/Slides row carries
	// `kind`, and opening it is the entire client-side "open" change this
	// slice needs — the panel itself dispatches on `item.kind` per slice 0.
	it("carries kind straight through for an artifact-family row, tried before the existing mapping", () => {
		const document = makeKnowledgeDocument({
			id: "art-canvas-1",
			type: "artifact",
			displayArtifactId: "art-canvas-1",
			promptArtifactId: null,
			familyArtifactIds: ["art-canvas-1"],
			name: "Vienna trip board",
			mimeType: null,
			sizeBytes: null,
			conversationId: "conv-1",
			summary: null,
			normalizedAvailable: false,
			documentOrigin: undefined,
			kind: "canvas",
			artifactVersionNumber: 7,
		});

		expect(toWorkspaceDocument(document)).toEqual({
			id: "artifact:art-canvas-1",
			source: "knowledge_artifact",
			filename: "Vienna trip board",
			title: "Vienna trip board",
			kind: "canvas",
			mimeType: null,
			artifactId: "art-canvas-1",
			conversationId: "conv-1",
		});
	});

	it("still maps every existing row exactly as before when kind is unset", () => {
		const document = makeKnowledgeDocument({
			id: "source-pdf",
			displayArtifactId: "source-pdf",
			promptArtifactId: "normalized-pdf",
			familyArtifactIds: ["source-pdf", "normalized-pdf"],
			name: "Benefits.pdf",
			normalizedAvailable: true,
		});

		expect(toWorkspaceDocument(document)).not.toHaveProperty("kind");
	});
});
