import { resolveWorkingDocumentIdentity } from "$lib/services/working-document-identity";
import type { DocumentWorkspaceItem, KnowledgeDocumentItem } from "$lib/types";

export type LibraryModal = "documents" | null;

export function getLibraryBulkKey(): string {
	return "forget-all-documents";
}

export function getLibraryBulkLabel(): string {
	return "Forget all documents";
}

export function getLibraryItemCount(params: {
	documents: KnowledgeDocumentItem[];
}): number {
	return params.documents.length;
}

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
