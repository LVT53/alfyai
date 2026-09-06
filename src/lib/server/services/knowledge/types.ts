// The Artifact/Knowledge domain contract: artifact identity, the working
// document family (label/role/version/supersession) shared by uploaded and
// generated documents, work capsules, and the unified document-workspace
// view. Owned by the knowledge/ service boundary — relocated out of the
// former src/lib/types.ts god-module (architecture-deepening T1); this
// file carries no behavior change, only a new home.

export type ArtifactType =
	| "source_document"
	| "normalized_document"
	| "generated_output"
	| "skill_note"
	| "work_capsule";

export type ArtifactRetrievalClass =
	| "durable"
	| "ephemeral_followup"
	| "archived_duplicate";

export type ArtifactLinkType =
	| "attached_to_conversation"
	| "linked_context_source"
	| "derived_from"
	| "used_in_output"
	| "supersedes"
	| "captured_by_capsule";

export type MemoryLayer =
	| "session"
	| "capsule"
	| "documents"
	| "outputs"
	| "working_set"
	| "task_state";

// "Long-document comfort" (owner-approved mockup): one outline entry
// derived from a document heading. `offset` is the character offset of the
// heading's own line within the extracted document text; `preview` is the
// first ~300 chars of body text that follow it, used to build the quoted
// text inserted into the composer.
export interface DocumentOutlineEntry {
	level: number;
	title: string;
	offset: number;
	preview: string;
}

export interface ArtifactSummary {
	id: string;
	type: ArtifactType;
	retrievalClass: ArtifactRetrievalClass;
	name: string;
	mimeType: string | null;
	sizeBytes: number | null;
	conversationId: string | null;
	summary: string | null;
	createdAt: number;
	updatedAt: number;
	// Long-document comfort fields, populated at ingestion time when the
	// artifact's extracted text is available. Omitted (rather than null)
	// when never computed, so older artifacts/tests keep their existing
	// shape.
	tokenEstimate?: number;
	pageCount?: number;
	outline?: DocumentOutlineEntry[];
}

export type WorkingDocumentFamilyStatus = "active" | "historical";

export interface KnowledgeDocumentItem {
	id: string;
	type?: ArtifactType;
	displayArtifactId: string;
	promptArtifactId: string | null;
	familyArtifactIds: string[];
	name: string;
	mimeType: string | null;
	sizeBytes: number | null;
	conversationId: string | null;
	summary: string | null;
	normalizedAvailable: boolean;
	documentOrigin?: "uploaded" | "generated" | "skill_note";
	documentFamilyId?: string | null;
	documentFamilyStatus?: WorkingDocumentFamilyStatus | null;
	documentLabel?: string | null;
	documentRole?: string | null;
	versionNumber?: number | null;
	isOriginal?: boolean | null;
	originConversationId?: string | null;
	originAssistantMessageId?: string | null;
	sourceChatFileId?: string | null;
	tokenEstimate?: number;
	pageCount?: number;
	outline?: DocumentOutlineEntry[];
	createdAt: number;
	updatedAt: number;
}

export interface WorkingDocumentMetadata {
	documentFamilyId?: string | null;
	documentFamilyStatus?: WorkingDocumentFamilyStatus | null;
	documentLabel?: string | null;
	documentRole?: string | null;
	versionNumber?: number | null;
	supersedesArtifactId?: string | null;
	originConversationId?: string | null;
	originAssistantMessageId?: string | null;
	sourceChatFileId?: string | null;
}

export interface PendingAttachment {
	artifact: ArtifactSummary;
	promptReady: boolean;
	promptArtifactId?: string | null;
	readinessError?: string | null;
}

export interface KnowledgeUploadResponse {
	artifact: ArtifactSummary;
	normalizedArtifact: ArtifactSummary | null;
	reusedExistingArtifact: boolean;
	promptReady: boolean;
	promptArtifactId?: string | null;
	readinessError?: string | null;
	renameInfo?: {
		originalName: string;
		wasRenamed: boolean;
	};
}

export interface Artifact extends ArtifactSummary {
	userId: string;
	extension: string | null;
	storagePath: string | null;
	contentText: string | null;
	metadata: Record<string, unknown> | null;
}

export interface ArtifactChunk {
	id: string;
	artifactId: string;
	userId: string;
	conversationId: string | null;
	chunkIndex: number;
	contentText: string;
	tokenEstimate: number;
	createdAt: number;
	updatedAt: number;
}

export interface ArtifactLink {
	id: string;
	userId: string;
	artifactId: string;
	relatedArtifactId: string | null;
	conversationId: string | null;
	messageId: string | null;
	linkType: ArtifactLinkType;
	createdAt: number;
}

export interface WorkCapsule {
	artifact: ArtifactSummary;
	conversationId: string | null;
	taskSummary: string | null;
	workflowSummary: string | null;
	keyConclusions: string[];
	reusablePatterns: string[];
	sourceArtifactCount: number;
	outputArtifactCount: number;
}

export type DocumentWorkspaceSource =
	| "chat_generated_file"
	| "knowledge_artifact";

export interface DocumentWorkspaceItem {
	id: string;
	source: DocumentWorkspaceSource;
	filename: string;
	title: string;
	documentFamilyId?: string | null;
	documentFamilyStatus?: WorkingDocumentFamilyStatus | null;
	documentLabel?: string | null;
	documentRole?: string | null;
	versionNumber?: number | null;
	originConversationId?: string | null;
	originAssistantMessageId?: string | null;
	sourceChatFileId?: string | null;
	mimeType: string | null;
	previewUrl?: string | null;
	artifactId?: string | null;
	conversationId?: string | null;
	downloadUrl?: string | null;
}
