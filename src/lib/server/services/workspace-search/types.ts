import type { Conversation } from "$lib/server/services/conversations";
import type {
	ArtifactType,
	KnowledgeDocumentItem,
	WorkingDocumentFamilyStatus,
} from "$lib/server/services/knowledge/types";
import type { ArtifactKind } from "$lib/shared/artifacts/kinds";

// The count cap lives in the shared module because the modal reads it too
// (100 shows as "99+"); the browser may not import anything under `$lib/server`.
export { SEARCH_COUNT_CAP } from "$lib/shared/workspace-search-text";

/** What "All" shows of each kind. */
export const SEARCH_ALL_PER_KIND = 3;
/** What a chip shows per page of its kind. */
export const SEARCH_PAGE_SIZE = 20;
/** A candidate read stops at this many rows of its own kind. */
export const SEARCH_CANDIDATE_CAP = 400;

// Relocated out of the former src/lib/types.ts god-module
// (architecture-deepening T1); these types carry no behavior change, only
// a new home next to the workspace-search service that owns them.

export type WorkspaceSearchMode = "default" | "query";

/** The kinds of result, one chip each. A chip's count is of its own kind. */
export type WorkspaceSearchKind =
	| "chats"
	| "memory"
	| "documents"
	| "media"
	| "apps";

export type WorkspaceSearchScope = "all" | WorkspaceSearchKind;

const SCOPES: readonly WorkspaceSearchScope[] = [
	"all",
	"chats",
	"memory",
	"documents",
	"media",
	"apps",
];

/** The scope a request names; anything that is not one of the six is "all". */
export function parseWorkspaceSearchScope(
	value: string | null | undefined,
): WorkspaceSearchScope {
	return SCOPES.find((scope) => scope === value) ?? "all";
}

/** The word on a document, picture, video or app row. */
export type WorkspaceSearchBadge =
	| "document"
	| "slides"
	| "canvas"
	| "app"
	| "image"
	| "video"
	| "uploaded"
	| "generated"
	| "report"
	| "skill_note";

export type WorkspaceSearchConversationMatchType =
	| "recent"
	| "title"
	| "project"
	| "body";

export type WorkspaceSearchDocumentMatchType =
	| "recent"
	| "name"
	| "label"
	| "role"
	| "summary"
	| "content";

export interface WorkspaceSearchConversationResult {
	id: string;
	title: string;
	projectId: string | null;
	projectName: string | null;
	status: Conversation["status"];
	sealedAt: number | null;
	updatedAt: number;
	href: string;
	match: {
		type: WorkspaceSearchConversationMatchType;
		snippet: string | null;
		messageId: string | null;
		messageRole: string | null;
	};
}

export interface WorkspaceSearchMemoryResult {
	/** The entry's row id on the Memory page. */
	id: string;
	scope: { kind: "personal" } | { kind: "project"; projectId: string };
	projectName: string | null;
	text: string;
	/** When the person last said it, ISO; null when no source has a date. */
	lastSaidAt: string | null;
	href: string;
}

export interface WorkspaceSearchDocumentResult {
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
	documentOrigin?: KnowledgeDocumentItem["documentOrigin"];
	documentFamilyId?: string | null;
	documentFamilyStatus?: WorkingDocumentFamilyStatus | null;
	documentLabel?: string | null;
	documentRole?: string | null;
	versionNumber?: number | null;
	originConversationId?: string | null;
	originAssistantMessageId?: string | null;
	sourceChatFileId?: string | null;
	updatedAt: number;
	href: string;
	sourceHref: string | null;
	/** The artifact family kind (ADR-0066). Present for a Document/App/Canvas/
	 *  Slides row, absent for every existing kind. */
	kind?: ArtifactKind;
	/** The chip this row belongs to, and the word on it. */
	searchKind: "documents" | "media" | "apps";
	badge: WorkspaceSearchBadge;
	/** The title of the chat it was made in, for "Made in …". */
	originConversationTitle: string | null;
	/** A picture's or a video's thumbnail. */
	preview: { src: string; width: number | null; height: number | null } | null;
	/** A video's length. */
	durationMs: number | null;
	match: {
		type: WorkspaceSearchDocumentMatchType;
		snippet: string | null;
	};
}

export interface WorkspaceSearchResponse {
	query: string;
	mode: WorkspaceSearchMode;
	scope: WorkspaceSearchScope;
	conversations: WorkspaceSearchConversationResult[];
	memories: WorkspaceSearchMemoryResult[];
	documents: WorkspaceSearchDocumentResult[];
	/** The true number of matches of each kind, counted up to the cap. */
	totals: Record<WorkspaceSearchKind, number>;
	/** False hides the Memory chip: Memory is off or the account is not native. */
	memorySearchable: boolean;
	/** The cursor for the next page of the chosen kind, null at the end. */
	nextCursor: string | null;
}
