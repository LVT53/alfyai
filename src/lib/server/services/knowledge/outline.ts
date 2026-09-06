// "Long-document comfort" (owner-approved mockup, 2026-09-06): derives a
// lightweight section outline from a document's extracted text so a user who
// attaches a long file can jump straight to a section instead of
// re-describing it. Runs purely on the already-extracted text (MinerU
// normalizes PDF/DOCX/PPTX/XLSX to Markdown before this ever sees it — see
// ../document-extraction.ts — and plain text/Markdown files are extracted
// directly), so one heuristic set covers every supported format:
//
//   1. Markdown ATX headings (`#` .. `######`) — the common case, since
//      MinerU emits these for most structured documents.
//   2. Numbered headings ("2.3 Break clause") — matched everywhere in
//      addition to (1), because MinerU sometimes keeps numbered legal/
//      contract-style headings as body lines rather than demoting them to
//      `#`. The numbering's dot-depth becomes the heading level.
//   3. Short Title-Case lines followed by a paragraph — a last-resort
//      fallback used only when neither (1) nor (2) found anything, for
//      unstructured plain-text uploads.
//
// Entries are capped at MAX_OUTLINE_ENTRIES for storage; the UI applies its
// own, smaller display cap on top of that.

import { estimateTokenCount } from "$lib/utils/tokens";
import type { DocumentOutlineEntry } from "./types";

export const MAX_OUTLINE_ENTRIES = 200;
const PREVIEW_LENGTH = 300;

const MARKDOWN_HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const NUMBERED_HEADING_RE =
	/^(\d{1,3}(?:\.\d{1,3}){0,3})[.):]?\s+(\S.{1,140})$/;
const TITLE_CASE_HEADING_RE =
	/^[A-Z][\w'&/-]*(?:\s+(?:[A-Z][\w'&/-]*|of|the|and|for|to|in|on|a|an))*$/;

interface HeadingCandidate {
	level: number;
	title: string;
	offset: number;
	bodyStart: number;
}

// One source line plus its real character positions in the original text.
// `offset` is where the line starts and `bodyStart` where the NEXT line
// starts, both measured against `text` itself. Line endings are measured
// rather than assumed to be one character: plain .txt/.md uploads bypass
// MinerU and are read straight off disk (see ../document-extraction.ts), so
// a Windows-authored file arrives with CRLF endings, and charging every
// separator a single character would drift every offset and preview further
// out of alignment with each line consumed.
interface SourceLine {
	text: string;
	offset: number;
	bodyStart: number;
}

function splitSourceLines(text: string): SourceLine[] {
	const lines: SourceLine[] = [];
	const separator = /\r\n|\r|\n/g;
	let start = 0;
	let match = separator.exec(text);
	while (match !== null) {
		const bodyStart = match.index + match[0].length;
		lines.push({
			text: text.slice(start, match.index),
			offset: start,
			bodyStart,
		});
		start = bodyStart;
		match = separator.exec(text);
	}
	lines.push({
		text: text.slice(start),
		offset: start,
		bodyStart: text.length,
	});
	return lines;
}

function numberedHeadingLevel(numbering: string): number {
	return Math.min(6, numbering.split(".").length);
}

function buildPreview(text: string, bodyStart: number): string {
	const rest = text.slice(bodyStart, bodyStart + PREVIEW_LENGTH * 2);
	const trimmed = rest.replace(/^\s+/, "");
	return trimmed.slice(0, PREVIEW_LENGTH).trimEnd();
}

function looksLikeTitleCaseHeading(line: string): boolean {
	return (
		line.length >= 3 &&
		line.length <= 80 &&
		!line.endsWith(".") &&
		!line.endsWith(",") &&
		TITLE_CASE_HEADING_RE.test(line)
	);
}

/**
 * Extracts a bounded, best-effort section outline from a document's
 * extracted text. Pure and synchronous — safe to call at ingestion time
 * right after extraction, with no external dependencies.
 */
export function extractDocumentOutline(
	text: string | null | undefined,
): DocumentOutlineEntry[] {
	if (!text?.trim()) return [];

	const lines = splitSourceLines(text);
	const structuredCandidates: HeadingCandidate[] = [];

	for (const { text: line, offset, bodyStart } of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		const mdMatch = MARKDOWN_HEADING_RE.exec(trimmed);
		if (mdMatch) {
			structuredCandidates.push({
				level: mdMatch[1].length,
				title: mdMatch[2].trim(),
				offset,
				bodyStart,
			});
			continue;
		}

		const numberedMatch = NUMBERED_HEADING_RE.exec(trimmed);
		if (numberedMatch) {
			structuredCandidates.push({
				level: numberedHeadingLevel(numberedMatch[1]),
				title: trimmed,
				offset,
				bodyStart,
			});
		}
	}

	let candidates = structuredCandidates;

	if (candidates.length === 0) {
		// Fallback: a short Title-Case line immediately followed by a
		// non-blank paragraph line reads as an unmarked heading.
		const fallbackCandidates: HeadingCandidate[] = [];
		for (let index = 0; index < lines.length; index++) {
			const { text: line, offset, bodyStart } = lines[index];
			const trimmed = line.trim();
			const nextLine = lines[index + 1]?.text.trim() ?? "";

			if (
				trimmed &&
				looksLikeTitleCaseHeading(trimmed) &&
				nextLine.length > 0 &&
				nextLine.length > trimmed.length
			) {
				fallbackCandidates.push({
					level: 1,
					title: trimmed,
					offset,
					bodyStart,
				});
			}
		}
		candidates = fallbackCandidates;
	}

	return candidates.slice(0, MAX_OUTLINE_ENTRIES).map((candidate) => ({
		level: candidate.level,
		title: candidate.title,
		offset: candidate.offset,
		preview: buildPreview(text, candidate.bodyStart),
	}));
}

/** Thin wrapper kept alongside the outline extractor so ingestion has a
 * single import for both "long-document comfort" fields it derives from
 * extracted text. */
export function estimateDocumentTokenCount(
	text: string | null | undefined,
): number {
	return text ? estimateTokenCount(text) : 0;
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Validates and normalizes an `outline` value read back from stored
 * artifact metadata (JSON round-tripped, so nothing is trusted). */
export function readStoredOutline(value: unknown): DocumentOutlineEntry[] {
	if (!Array.isArray(value)) return [];
	const result: DocumentOutlineEntry[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		const level = isFiniteNonNegativeInteger(record.level)
			? Math.max(1, Math.trunc(record.level))
			: null;
		const title = typeof record.title === "string" ? record.title : null;
		const offset = isFiniteNonNegativeInteger(record.offset)
			? Math.trunc(record.offset)
			: null;
		if (level === null || !title || offset === null) continue;
		result.push({
			level,
			title,
			offset,
			preview: typeof record.preview === "string" ? record.preview : "",
		});
		if (result.length >= MAX_OUTLINE_ENTRIES) break;
	}
	return result;
}

export function readStoredTokenEstimate(value: unknown): number | undefined {
	return isFiniteNonNegativeInteger(value) ? Math.trunc(value) : undefined;
}

export function readStoredPageCount(value: unknown): number | undefined {
	return isFiniteNonNegativeInteger(value) && value > 0
		? Math.trunc(value)
		: undefined;
}
