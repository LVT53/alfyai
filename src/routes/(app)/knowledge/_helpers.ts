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
	// The artifact family (Feature 2, ADR-0066) has no source/normalized
	// pairing and no "What AI sees" duality, so it skips
	// `resolveWorkingDocumentIdentity` entirely — one row, one artifact id.
	// This is the entire client-side "open" change this slice needs: the
	// panel itself dispatches on `kind` per slice 0's own contract.
	if (document.kind) {
		return {
			id: `artifact:${document.displayArtifactId}`,
			source: "knowledge_artifact",
			filename: document.name,
			title: document.name,
			kind: document.kind,
			mimeType: null,
			artifactId: document.displayArtifactId,
			conversationId: document.conversationId,
		};
	}

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
