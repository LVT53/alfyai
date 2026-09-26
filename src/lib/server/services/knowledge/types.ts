// The Artifact/Knowledge domain contract: artifact identity, the working
// document family (label/role/version/supersession) shared by uploaded and
// generated documents, work capsules, and the unified document-workspace
// view. Owned by the knowledge/ service boundary — relocated out of the
// former src/lib/types.ts god-module (architecture-deepening T1); this
// file carries no behavior change, only a new home.

import type { DocumentCardPreview } from "$lib/server/services/artifacts/types";
import type { ArtifactKind } from "$lib/shared/artifacts/kinds";
import type { AttachmentReadinessReason } from "$lib/shared/attachment-readiness";
import type { DocumentExtractionJobDTO } from "$lib/shared/extraction-status";
import type { PageCountKind } from "$lib/shared/page-count";

export type ArtifactType =
	| "source_document"
	| "normalized_document"
	| "generated_output"
	| "skill_note"
	| "work_capsule"
	// The artifact family (Feature 2, ADR-0066): Document/App/Canvas/Slides
	// rows write `type: "artifact"` (record.ts's ARTIFACT_ROW_TYPE). Knowledge
	// code previously excluded this type entirely — the rows exist in the
	// database, but nothing here could name them.
	| "artifact";

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
	/**
	 * 1-based page the heading sits on. Present only for a document whose
	 * extractor reported page boundaries (a structured parse); absent for the
	 * direct-text route and for every row written before that existed, which is
	 * why it is optional rather than nullable — a heading with no page is not a
	 * heading on page `null`.
	 */
	page?: number;
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
	/**
	 * What `pageCount` counts. Absent for a document parsed before the
	 * structured extractor existed, and that absence is the reason it is
	 * optional rather than defaulted: a surface that does not know whether a
	 * count is pages, slides or a DOCX's declared 1 must print no unit at all
	 * rather than guess "pages".
	 */
	pageCountKind?: PageCountKind;
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
	/** What `pageCount` counts. See `ArtifactSummary.pageCountKind`. */
	pageCountKind?: PageCountKind;
	outline?: DocumentOutlineEntry[];
	/**
	 * `metadata.extractionProducer` — `"mineru"` for a document parsed by the
	 * structured extractor, absent for a row that predates it. The Library row
	 * uses it to decide whether "Re-extract at a higher quality" is a promise
	 * the backend can keep.
	 */
	extractionProducer?: string;
	/** `metadata.extractionTier` — the REAL per-file tier, not the job's. */
	extractionTier?: string;
	/**
	 * Set only for the new artifact family (Document/App/Canvas/Slides — never
	 * "file": a produced file stays on the existing generated/uploaded path
	 * above, ruling 18). Undefined for every row this app already knew about.
	 * Read from `metadata_json.artifactType` via a local, defensive parse in
	 * `store/documents.ts` — never re-derived elsewhere.
	 */
	kind?: ArtifactKind;
	/**
	 * The artifact family's OWN version counter — sourced from the newest
	 * `artifact_versions` row for this artifact id. Populated only when `kind`
	 * is set. This is NOT the same concept as `versionNumber` above (the
	 * pre-existing extraction-quality re-parse family, paired with
	 * `documentFamilyId`/`isOriginal`) — the two must never be read
	 * interchangeably.
	 */
	artifactVersionNumber?: number | null;
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
	/**
	 * The machine-readable twin of `readinessError`, so the client can render
	 * the refusal in the user's own language instead of the server's English.
	 */
	readinessErrorCode?: AttachmentReadinessReason | null;
	/**
	 * Present for an attachment that came from a real upload in this session;
	 * absent for one restored from a saved draft, where the ledger row is
	 * fetched by the poller rather than carried in the draft payload.
	 */
	extraction?: DocumentExtractionJobDTO;
}

export interface KnowledgeUploadResponse {
	artifact: ArtifactSummary;
	/**
	 * `null` while extraction is still running — which, since Phase 3, is the
	 * normal case for anything that is not direct text. A consumer that reads
	 * this (or `promptReady: false`) as a permanent failure is wrong; consult
	 * `extraction.status` instead.
	 */
	normalizedArtifact: ArtifactSummary | null;
	reusedExistingArtifact: boolean;
	promptReady: boolean;
	promptArtifactId?: string | null;
	readinessError?: string | null;
	/** See `PendingAttachment.readinessErrorCode`. */
	readinessErrorCode?: AttachmentReadinessReason | null;
	renameInfo?: {
		originalName: string;
		wasRenamed: boolean;
	};
	/** Always present. The one row every surface renders readiness from. */
	extraction: DocumentExtractionJobDTO;
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
	/**
	 * 1-based inclusive page the chunk starts on, for a document parsed with
	 * structure. NULL for direct text and for every row written before
	 * structure-aware chunking existed — which is what a page citation checks
	 * before it prints anything.
	 */
	pageStart: number | null;
	/** 1-based inclusive page the chunk ends on. NULL when `pageStart` is. */
	pageEnd: number | null;
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
	/**
	 * The artifact family kind (ADR-0066). Optional and defaults to `"file"`:
	 * every item the three existing callers build today is a produced file or
	 * an uploaded library document, and the type-aware panel (Slice 0 Task S5)
	 * treats a missing `kind` exactly like `"file"` — the preview stack the
	 * panel already renders, with no behaviour change for those callers.
	 */
	kind?: ArtifactKind;
	/**
	 * `ArtifactCardSummary.updatedAt`, carried through so the "what this chat
	 * made" list can render each row's "made by Alfy {when}" line (mockup
	 * surface 2) via `formatRelativeTime`. Optional: the three existing
	 * callers never set it and never render it (only the artifact list body
	 * reads it), so this is not a behaviour change for them.
	 */
	updatedAt?: number;
	/**
	 * `ArtifactCardSummary.documentPreview`, carried through so the panel
	 * list's card can show the Document's subtitle/tickable checklist without
	 * fetching a full body (T9 steps 4/7). Only ever set for a `kind:
	 * "document"` item; every other caller/kind leaves it unset.
	 */
	documentPreview?: DocumentCardPreview;
}
