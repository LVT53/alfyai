import type {
	DocumentWorkspaceItem,
	KnowledgeDocumentItem,
} from "$lib/server/services/knowledge/types";
import { resolveWorkingDocumentIdentity } from "$lib/services/working-document-identity";

// The library-modal helpers that used to live here went with
// KnowledgeLibraryModal: documents are a tab on the page now, and nothing
// imported them any more. One of them returned a hard-coded English label.

// Workspace document helpers

export function toWorkspaceDocument(
	document: KnowledgeDocumentItem,
): DocumentWorkspaceItem {
	const identity = resolveWorkingDocumentIdentity(document);
	const artifactId = identity.preview.artifactId;
	return {
		id: `artifact:${artifactId}`,
		source: "knowledge_artifact",
		filename: document.name,
		title: document.documentLabel ?? document.name,
		documentFamilyId: document.documentFamilyId ?? null,
		documentFamilyStatus: document.documentFamilyStatus ?? null,
		documentLabel: document.documentLabel ?? null,
		documentRole: document.documentRole ?? null,
		versionNumber: document.versionNumber ?? null,
		originConversationId: document.originConversationId ?? null,
		originAssistantMessageId: document.originAssistantMessageId ?? null,
		sourceChatFileId: identity.preview.sourceChatFileId,
		mimeType: document.mimeType,
		artifactId,
		conversationId: document.conversationId,
	};
}

export function getWorkspaceDocumentForArtifact(
	documents: KnowledgeDocumentItem[],
	artifactId: string,
): DocumentWorkspaceItem | null {
	const matchingDocument =
		documents.find((document) =>
			resolveWorkingDocumentIdentity(document).family.artifactIds.includes(
				artifactId,
			),
		) ?? null;
	if (!matchingDocument) {
		return null;
	}

	return toWorkspaceDocument(matchingDocument);
}
