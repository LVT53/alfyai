// Documents tab table logic (everyday-screens redesign, Knowledge board).
//
// Version and status move OUT of the file name and into columns of their own.
// Today a row can begin with "Original" or "v3" and end with "Historical", so
// no two file names start in the same place and the eye has to find the name
// inside the badges. Here the name is a column, the version is a column, and
// the status is a column that stays BLANK for a document that has no version
// family at all — an unversioned upload is neither current nor historical, and
// saying "Current" about it would be inventing a fact.

import type { KnowledgeDocumentItem } from "$lib/server/services/knowledge/types";

export type DocumentSortKey = "name" | "version" | "type" | "size" | "date";
export type SortDirection = "asc" | "desc";

/** Column order, owner-approved: name first, then version, type, status. */
export const DOCUMENT_COLUMN_ORDER = [
	"name",
	"version",
	"type",
	"status",
	"size",
	"date",
	"actions",
] as const;

export type DocumentVersionBadge =
	| { kind: "original" }
	| { kind: "version"; versionNumber: number }
	| { kind: "none" };

export type DocumentStatusBadge = "current" | "historical" | null;

export type DocumentKind = "generated" | "skill_note" | "uploaded";

/**
 * The Version cell. "Original" for the first member of a family, "v3" for a
 * later one, and nothing at all for a document that never joined a family.
 */
export function deriveDocumentVersion(
	document: KnowledgeDocumentItem,
): DocumentVersionBadge {
	if (document.isOriginal) return { kind: "original" };
	if (document.versionNumber != null && document.documentFamilyId) {
		return { kind: "version", versionNumber: document.versionNumber };
	}
	return { kind: "none" };
}

/**
 * The Status cell. `null` — drawn as an em dash — whenever the document has no
 * version family: there is no newer or older sibling for it to be current or
 * historical against.
 */
export function deriveDocumentStatus(
	document: KnowledgeDocumentItem,
): DocumentStatusBadge {
	if (!document.documentFamilyId) return null;
	return document.documentFamilyStatus === "historical"
		? "historical"
		: "current";
}

export function getDocumentKind(document: KnowledgeDocumentItem): DocumentKind {
	if (
		document.documentOrigin === "skill_note" ||
		document.type === "skill_note"
	) {
		return "skill_note";
	}
	return document.documentOrigin === "generated" ||
		document.type === "generated_output"
		? "generated"
		: "uploaded";
}

/**
 * "What AI sees" is only offered where a normalised version actually exists;
 * elsewhere the eye is drawn greyed rather than removed, so the row keeps the
 * same three action slots and the column never jitters between rows.
 */
export function hasNormalisedVersion(document: KnowledgeDocumentItem): boolean {
	return Boolean(document.normalizedAvailable && document.promptArtifactId);
}

function compareText(left: string, right: string): number {
	return left.localeCompare(right, undefined, {
		sensitivity: "base",
		numeric: true,
	});
}

/** Sort weight of a version badge, so "Original" precedes v1, v2, v3. */
export function documentVersionRank(document: KnowledgeDocumentItem): number {
	const version = deriveDocumentVersion(document);
	if (version.kind === "original") return 0;
	if (version.kind === "version") return version.versionNumber;
	return -1;
}

/**
 * The one comparison the table sorts by, in every direction. Ties break
 * deterministically (name, then newest, then id) so a re-render never
 * reshuffles equal rows.
 */
export function compareDocuments(
	left: KnowledgeDocumentItem,
	right: KnowledgeDocumentItem,
	sortKey: DocumentSortKey,
	sortDirection: SortDirection,
): number {
	const direction = sortDirection === "asc" ? 1 : -1;

	if (sortKey === "name") {
		const byName = compareText(left.name, right.name) * direction;
		if (byName !== 0) return byName;
	}

	if (sortKey === "version") {
		const byVersion =
			(documentVersionRank(left) - documentVersionRank(right)) * direction;
		if (byVersion !== 0) return byVersion;
	}

	if (sortKey === "size") {
		const bySize = ((left.sizeBytes ?? 0) - (right.sizeBytes ?? 0)) * direction;
		if (bySize !== 0) return bySize;
	}

	if (sortKey === "type") {
		const byType =
			compareText(getDocumentKind(left), getDocumentKind(right)) * direction;
		if (byType !== 0) return byType;
	}

	if (sortKey === "date") {
		const byDate = ((left.createdAt ?? 0) - (right.createdAt ?? 0)) * direction;
		if (byDate !== 0) return byDate;
	}

	const byNameTie = compareText(left.name, right.name);
	if (byNameTie !== 0) return byNameTie;
	const byDateTie = (right.createdAt ?? 0) - (left.createdAt ?? 0);
	if (byDateTie !== 0) return byDateTie;
	return compareText(left.id, right.id);
}

export function sortDocuments(
	documents: readonly KnowledgeDocumentItem[],
	sortKey: DocumentSortKey,
	sortDirection: SortDirection,
): KnowledgeDocumentItem[] {
	return [...documents].sort((left, right) =>
		compareDocuments(left, right, sortKey, sortDirection),
	);
}

/**
 * Clicking a sorted column flips it; clicking a new one picks the direction
 * that reads as "most useful first" for that column's type.
 */
export function nextSortDirection(
	activeSortKey: DocumentSortKey,
	activeSortDirection: SortDirection,
	nextSortKey: DocumentSortKey,
): SortDirection {
	if (activeSortKey === nextSortKey) {
		return activeSortDirection === "asc" ? "desc" : "asc";
	}
	return nextSortKey === "name" || nextSortKey === "type" ? "asc" : "desc";
}
