import { describe, expect, it } from "vitest";
import type { KnowledgeDocumentItem } from "$lib/server/services/knowledge/types";
import { resolveWorkingDocumentIdentity } from "./working-document-identity";

function makeDocument(
	overrides: Partial<KnowledgeDocumentItem> = {},
): KnowledgeDocumentItem {
	return {
		id: overrides.id ?? overrides.displayArtifactId ?? "source-1",
		type: overrides.type ?? "source_document",
		displayArtifactId: overrides.displayArtifactId ?? "source-1",
		promptArtifactId: overrides.promptArtifactId ?? "normalized-1",
		familyArtifactIds: overrides.familyArtifactIds ?? [
			"source-1",
			"normalized-1",
		],
		name: overrides.name ?? "brief.pdf",
		mimeType: overrides.mimeType ?? "application/pdf",
		sizeBytes: overrides.sizeBytes ?? 1024,
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

describe("working document identity", () => {
	it("uses source identity for display and preview while using normalized identity for prompt context", () => {
		const identity = resolveWorkingDocumentIdentity(makeDocument());

		expect(identity).toEqual({
			display: { artifactId: "source-1" },
			prompt: { artifactId: "normalized-1" },
			preview: { artifactId: "source-1", sourceChatFileId: null },
			family: { artifactIds: ["source-1", "normalized-1"] },
		});
	});

	it("uses the normalized artifact for every purpose when no source artifact exists", () => {
		const identity = resolveWorkingDocumentIdentity(
			makeDocument({
				id: "normalized-only-1",
				type: "normalized_document",
				displayArtifactId: "normalized-only-1",
				promptArtifactId: "normalized-only-1",
				familyArtifactIds: ["normalized-only-1"],
				name: "standalone.txt",
				mimeType: "text/plain",
			}),
		);

		expect(identity).toEqual({
			display: { artifactId: "normalized-only-1" },
			prompt: { artifactId: "normalized-only-1" },
			preview: { artifactId: "normalized-only-1", sourceChatFileId: null },
			family: { artifactIds: ["normalized-only-1"] },
		});
	});

	it("keeps generated documents on generated artifact identity and exposes source chat file serving identity", () => {
		const identity = resolveWorkingDocumentIdentity(
			makeDocument({
				id: "generated-v2",
				type: "generated_output",
				displayArtifactId: "generated-v2",
				promptArtifactId: "generated-v2",
				familyArtifactIds: ["generated-v1", "generated-v2"],
				name: "report-v2.docx",
				mimeType:
					"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				documentOrigin: "generated",
				documentFamilyId: "family-report",
				sourceChatFileId: "chat-file-v2",
			}),
		);

		expect(identity).toEqual({
			display: { artifactId: "generated-v2" },
			prompt: { artifactId: "generated-v2" },
			preview: { artifactId: "generated-v2", sourceChatFileId: "chat-file-v2" },
			family: { artifactIds: ["generated-v1", "generated-v2"] },
		});
	});

	it("uses the Skill Note artifact as display, prompt, preview, and family identity", () => {
		const identity = resolveWorkingDocumentIdentity(
			makeDocument({
				id: "skill-note-1",
				type: "skill_note",
				displayArtifactId: "skill-note-1",
				promptArtifactId: "skill-note-1",
				familyArtifactIds: ["skill-note-1"],
				name: "Research note",
				mimeType: "text/markdown",
				documentOrigin: "skill_note",
			}),
		);

		expect(identity).toEqual({
			display: { artifactId: "skill-note-1" },
			prompt: { artifactId: "skill-note-1" },
			preview: { artifactId: "skill-note-1", sourceChatFileId: null },
			family: { artifactIds: ["skill-note-1"] },
		});
	});

	it("does not expose prompt identity for source documents without normalized prompt content", () => {
		const identity = resolveWorkingDocumentIdentity(
			makeDocument({
				promptArtifactId: null,
				familyArtifactIds: ["source-1"],
				normalizedAvailable: false,
			}),
		);

		expect(identity).toEqual({
			display: { artifactId: "source-1" },
			prompt: null,
			preview: { artifactId: "source-1", sourceChatFileId: null },
			family: { artifactIds: ["source-1"] },
		});
	});
});
