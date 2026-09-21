// The file-production job contract projected to clients (conversation
// detail, FileProductionCard.svelte), plus the legacy ChatGeneratedFile
// shape file-production/read-model.ts backfills into it. Relocated out of
// the former src/lib/types.ts god-module (architecture-deepening T1); this
// file carries no behavior change, only a new home. ChatGeneratedFile is
// deliberately kept HERE rather than in chat-files.ts — the "obsolete
// surfaces" architecture-boundary test forbids read-model.ts from eagerly
// importing chat-files.ts (which pulls in document-extraction), so
// chat-files.ts imports this pure, dependency-light type back from here.
import type { WorkingDocumentFamilyStatus } from "$lib/server/services/knowledge/types";

// Generated file from chat (AI-generated files)
export interface ChatGeneratedFile {
	id: string;
	conversationId: string;
	assistantMessageId?: string | null;
	artifactId?: string | null;
	documentFamilyId?: string | null;
	documentFamilyStatus?: WorkingDocumentFamilyStatus | null;
	documentLabel?: string | null;
	documentRole?: string | null;
	versionNumber?: number | null;
	originConversationId?: string | null;
	originAssistantMessageId?: string | null;
	sourceChatFileId?: string | null;
	filename: string;
	mimeType: string | null;
	sizeBytes: number;
	createdAt: number;
}

/**
 * Phase 6 D8 — the `inline_text` production mode.
 *
 * Bytes we already hold, written straight to storage: no Docker container, no
 * renderer, no sandbox timeout. Restricted at intake to outputs whose registry
 * entry is text-validated and is not a document source (`isInlineTextOutputType`),
 * which is precisely the set `buildTextFileProgram` was being used for. A
 * PDF/DOCX/HTML request still goes to the report renderers; an XLSX/PPTX/ZIP
 * request still goes to the sandbox.
 *
 * It travels the SAME durable job ledger as every other mode — same storage
 * adapter, same `validateGeneratedOutputFile`, same limits, same idempotency,
 * same memory sync — so the card, retry/cancel/dismiss, download/preview and
 * readback behave identically.
 *
 * `content` is one string shared by every entry in `files`: a request may ask
 * for the same text as both `.md` and `.txt`.
 */
export interface FileProductionInlineTextFile {
	readonly filename: string;
	readonly outputType: string;
}

export interface FileProductionInlineTextRequest {
	readonly sourceMode: "inline_text";
	/** Verbatim. The tool has already trimmed it; nothing else rewrites it. */
	readonly content: string;
	readonly files: readonly FileProductionInlineTextFile[];
}

/**
 * The value `file_production_jobs.source_mode` carries for an inline_text job.
 * The column is a plain `text` with no CHECK constraint and no enum, so the new
 * mode needs no migration; `read-model.ts` reads it as `string | null` and the
 * only consumer that branches on its value is
 * `generated-file-serving.resolvePreviewProfile`, which asks about
 * `document_source` for `text/html` previews only — an output type inline_text
 * can never produce.
 */
export const FILE_PRODUCTION_INLINE_TEXT_SOURCE_MODE = "inline_text" as const;

export type FileProductionJobStatus =
	| "queued"
	| "running"
	| "succeeded"
	| "failed"
	| "cancelled";

export interface FileProductionJobFile {
	id: string;
	filename: string;
	mimeType: string | null;
	sizeBytes: number;
	downloadUrl: string;
	previewUrl: string | null;
	artifactId?: string | null;
	documentFamilyId?: string | null;
	documentFamilyStatus?: WorkingDocumentFamilyStatus | null;
	documentLabel?: string | null;
	documentRole?: string | null;
	versionNumber?: number | null;
	originConversationId?: string | null;
	originAssistantMessageId?: string | null;
	sourceChatFileId?: string | null;
}

export interface FileProductionJob {
	id: string;
	conversationId: string;
	assistantMessageId?: string | null;
	title: string;
	status: FileProductionJobStatus;
	stage?: string | null;
	createdAt: number;
	updatedAt: number;
	files: FileProductionJobFile[];
	warnings: string[];
	dismissed: boolean;
	error?: {
		code: string;
		message: string;
		retryable: boolean;
	} | null;
}
