// Documents tab table logic (everyday-screens redesign, Knowledge board).
//
// Version and status move OUT of the file name and into columns of their own.
// Today a row can begin with "Original" or "v3" and end with "Historical", so
// no two file names start in the same place and the eye has to find the name
// inside the badges. Here the name is a column, the version is a column, and
// the status is a column that stays BLANK for a document that has no version
// family at all — an unversioned upload is neither current nor historical, and
// saying "Current" about it would be inventing a fact.

import type { I18nKey } from "$lib/i18n";
import type { KnowledgeLibraryDocumentItem } from "$lib/server/services/knowledge";
import type {
	DocumentExtractionJobDTO,
	DocumentExtractionStatus,
	ExtractionErrorCode,
} from "$lib/shared/extraction-status";
import { isTerminalExtractionStatus } from "$lib/shared/extraction-status";

/**
 * Every row of this table is a library row, so the extraction verdict the
 * library page attaches travels with it. The narrower
 * `KnowledgeDocumentItem` is still what the type extends, so nothing that
 * used to compile here stopped.
 */
export type KnowledgeDocumentItem = KnowledgeLibraryDocumentItem;

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

export type DocumentFamilyBadge = "current" | "historical";

/**
 * What the Status column draws. The extraction verdict outranks the version
 * family: a document the reader has not finished with is not yet "Current" —
 * it is not yet anything, and saying "Current" about a half-read PDF is the
 * same class of lie the blank cell for an unversioned upload avoids.
 */
export type DocumentStatusBadge =
	| { kind: "extraction"; job: DocumentExtractionJobDTO }
	| { kind: "family"; value: DocumentFamilyBadge }
	| null;

const EXTRACTION_STATUS_KEYS: Record<DocumentExtractionStatus, I18nKey> = {
	queued: "knowledge.extraction.status.queued",
	uploading: "knowledge.extraction.status.uploading",
	parsing: "knowledge.extraction.status.parsing",
	downloading: "knowledge.extraction.status.downloading",
	indexing: "knowledge.extraction.status.indexing",
	succeeded: "knowledge.extraction.status.succeeded",
	failed: "knowledge.extraction.status.failed",
	canceled: "knowledge.extraction.status.canceled",
};

const EXTRACTION_ERROR_KEYS: Record<ExtractionErrorCode, I18nKey> = {
	unavailable: "knowledge.extraction.error.unavailable",
	tier_unavailable: "knowledge.extraction.error.tier_unavailable",
	auth_failed: "knowledge.extraction.error.auth_failed",
	too_large: "knowledge.extraction.error.too_large",
	rate_limited: "knowledge.extraction.error.rate_limited",
	job_failed: "knowledge.extraction.error.job_failed",
	canceled: "knowledge.extraction.error.canceled",
	timeout: "knowledge.extraction.error.timeout",
	protocol: "knowledge.extraction.error.protocol",
	unsupported_type: "knowledge.extraction.error.unsupported_type",
	empty_result: "knowledge.extraction.error.empty_result",
	stale_worker: "knowledge.extraction.error.stale_worker",
	max_attempts: "knowledge.extraction.error.max_attempts",
	internal: "knowledge.extraction.error.internal",
	legacy_unknown: "knowledge.extraction.error.legacy_unknown",
};

/**
 * The short label for the Status cell. Totality is the point: both records
 * above are `Record<…, I18nKey>`, so a new status or error code added to the
 * shared vocabulary is a compile error here rather than a raw enum member
 * rendered at a user.
 */
export function extractionStatusKey(status: DocumentExtractionStatus): I18nKey {
	return EXTRACTION_STATUS_KEYS[status];
}

export function extractionErrorKey(code: ExtractionErrorCode): I18nKey {
	return EXTRACTION_ERROR_KEYS[code];
}

/**
 * The sentence under a failed row. A failure with no code at all is still a
 * failure, so it falls back to the generic one rather than rendering blank.
 */
export function extractionDetailKey(
	job: DocumentExtractionJobDTO,
): I18nKey | null {
	if (job.status !== "failed" && job.status !== "canceled") return null;
	if (!job.error) {
		return job.status === "canceled"
			? EXTRACTION_ERROR_KEYS.canceled
			: EXTRACTION_ERROR_KEYS.internal;
	}
	return (
		EXTRACTION_ERROR_KEYS[job.error.code] ?? EXTRACTION_ERROR_KEYS.internal
	);
}

/** True while the ledger still owes this document a verdict. */
export function isExtractionInProgress(
	document: KnowledgeDocumentItem,
): boolean {
	const job = document.extraction;
	return job !== undefined && !isTerminalExtractionStatus(job.status);
}

/**
 * A document nobody can read yet must not be openable as a linked source: the
 * workspace would show an empty AI-facing version and the user would conclude
 * the file was broken. A failed or canceled one stays openable — the original
 * bytes are there to download, and the Status cell explains the rest.
 */
export function canOpenDocument(document: KnowledgeDocumentItem): boolean {
	return !isExtractionInProgress(document);
}

export function canRetryExtraction(document: KnowledgeDocumentItem): boolean {
	return document.extraction?.retryable === true;
}

export function canCancelExtraction(document: KnowledgeDocumentItem): boolean {
	return document.extraction?.cancelable === true;
}

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
 * The Status cell, in precedence order.
 *
 * 1. The extraction ledger, whenever it has anything other than `succeeded`
 *    to report. A queued, parsing or failed document is that, first.
 * 2. The version family. `null` — drawn as an em dash — whenever the document
 *    has no family: there is no newer or older sibling for it to be current or
 *    historical against.
 *
 * A `succeeded` job deliberately falls through: extraction finishing is the
 * normal state of every readable document in the library, and a column that
 * said "Ready" on every row would say nothing.
 */
export function deriveDocumentStatus(
	document: KnowledgeDocumentItem,
): DocumentStatusBadge {
	const job = document.extraction;
	if (job && job.status !== "succeeded") {
		return { kind: "extraction", job };
	}
	if (!document.documentFamilyId) return null;
	return {
		kind: "family",
		value:
			document.documentFamilyStatus === "historical" ? "historical" : "current",
	};
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
