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
