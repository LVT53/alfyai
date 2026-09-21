import { readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "$lib/server/db";
import { artifacts, chatGeneratedFiles } from "$lib/server/db/schema";
import {
	readStoredOutline,
	readStoredPageCountKind,
} from "$lib/server/services/knowledge/outline";
import { getSourceArtifactIdForNormalizedArtifact } from "$lib/server/services/knowledge/store/core";
import { parseWorkingDocumentMetadata } from "$lib/server/services/knowledge/store/document-metadata";
import type {
	Artifact,
	ArtifactRetrievalClass,
	ArtifactType,
	DocumentOutlineEntry,
} from "$lib/server/services/knowledge/types";
import { readMineruPageIndex } from "$lib/server/services/mineru/bundle";
import { selectDocumentPassages } from "$lib/server/services/task-state/artifacts";
import { parseJsonRecord } from "$lib/server/utils/json";
import { getEntryByMimeType } from "$lib/shared/file-types";
import { type PageCountUnit, pageCountUnit } from "$lib/shared/page-count";
import {
	buildToolResultCacheKey,
	getCachedToolResult,
	setCachedToolResult,
} from "./tool-result-cache";

// ── Memory‑text extraction ─────────────────────────────────────

/**
 * Strip the memory‑formatted wrapper added by
 * {@link buildGeneratedFileMemoryContent} (chat‑files.ts) and return
 * only the extracted file content section.
 *
 * When the artifact was copied into a forked conversation the
 * memory wrapper still references the source conversation id and
 * embeds the original assistant response text — both of which
 * confuse models that use {@link read_generated_file} as a "file
 * recall" mechanism.  Returning only the extracted content avoids
 * leaking that fork‑specific metadata.
 */
const EXTRACTED_CONTENT_MARKER = "\nExtracted file content:\n";
const NO_EXTRACTION_TEXT =
	"No readable text could be extracted from this file. Use the filename, file type, and surrounding chat context when continuing it.";

export function extractContentFromMemoryText(
	memoryText: string | null,
): string | null {
	if (!memoryText) return null;
	const markerIndex = memoryText.lastIndexOf(EXTRACTED_CONTENT_MARKER);
	if (markerIndex < 0) {
		// No standard marker — return the full text as a fallback.
		const trimmed = memoryText.trim();
		return trimmed || null;
	}
	const extracted = memoryText
		.slice(markerIndex + EXTRACTED_CONTENT_MARKER.length)
		.trim();
	if (!extracted || extracted === NO_EXTRACTION_TEXT) {
		// Extraction produced nothing usable.
		return null;
	}
	return extracted;
}

// ── Optional disk read ─────────────────────────────────────────

const CHAT_FILES_DIR = join(process.cwd(), "data", "chat-files");

/**
 * Try to read the generated file bytes directly from disk so we
 * return the actual file content rather than the memory‑formatted
 * wrapper text.
 *
 * Falls back to `null` when the file is not on disk, is binary, or
 * cannot be decoded as UTF‑8.
 */
async function readGeneratedFileBinaryContent(
	userId: string,
	originalChatFileId: string,
): Promise<string | null> {
	try {
		const [fileRow] = await db
			.select({
				storagePath: chatGeneratedFiles.storagePath,
				mimeType: chatGeneratedFiles.mimeType,
			})
			.from(chatGeneratedFiles)
			.where(
				and(
					eq(chatGeneratedFiles.id, originalChatFileId),
					eq(chatGeneratedFiles.userId, userId),
				),
			)
			.limit(1);

		if (!fileRow) return null;

		const fullPath = join(CHAT_FILES_DIR, fileRow.storagePath);
		const buffer = await readFile(fullPath);

		const mimeType = fileRow.mimeType?.toLowerCase() ?? "";
		// Every member of the old inline list is a registry MIME on a text-like
		// entry, including "application/x-yaml", which is carried as a yaml alias
		// for exactly this call site (spec open question 7).
		const isTextBased =
			mimeType.startsWith("text/") ||
			getEntryByMimeType(mimeType)?.textLike === true;

		if (
			isTextBased ||
			mimeType === "" ||
			mimeType === "application/octet-stream"
		) {
			return buffer.toString("utf-8").trim() || null;
		}
		return null;
	} catch (error) {
		console.warn(
			"[READ_GENERATED_FILE] Disk read failed, falling back to memory text",
			{ originalChatFileId, userId, error },
		);
		return null;
	}
}

/**
 * Resolve the best available content for a generated‑output artifact,
 * preferring disk bytes over memory‑wrapper text.
 */
async function resolveBestContent(
	userId: string,
	artifactContentText: string | null,
	artifactMetadataJson: string | null,
): Promise<string | null> {
	const metadataRecord = parseJsonRecord(artifactMetadataJson);
	if (!metadataRecord) {
		return (
			extractContentFromMemoryText(artifactContentText) ??
			artifactContentText?.trim() ??
			null
		);
	}
	const originalChatFileId =
		typeof metadataRecord.originalChatFileId === "string"
			? metadataRecord.originalChatFileId
			: null;

	if (originalChatFileId) {
		const diskContent = await readGeneratedFileBinaryContent(
			userId,
			originalChatFileId,
		);
		if (diskContent) return diskContent;
	}

	const extracted = extractContentFromMemoryText(artifactContentText);
	if (extracted) return extracted;

	return artifactContentText?.trim() ?? null;
}

// ── Input schema ───────────────────────────────────────────────

const MAX_QUERY_LENGTH = 300;

/** The four fields the model is told about. */
const readGeneratedFileAdvertisedFields = {
	filename: z.string().min(1).optional(),
	requestTitle: z.string().min(1).optional(),
	from: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe(
			"Character offset to continue from. Pass the previous result's nextFrom to read the next window.",
		),
	query: z
		.string()
		.min(1)
		.max(MAX_QUERY_LENGTH)
		.optional()
		.describe(
			"Instead of the text window, return up to 3 passages of this one file about the query.",
		),
};

/**
 * The schema the model sees. It is what `tool()` serialises into the request's
 * tool list, which sits inside the CACHED PROMPT PREFIX: the local model
 * caches in 1 600-token blocks, so a byte added here invalidates every block
 * from that offset onward and costs a full re-warm.
 *
 * Adding `page` to it measures at +180 bytes of JSON Schema, and the
 * orchestrator's OQ5 ruling is that every model-facing prose and schema change
 * of this migration ships together in ONE release (Phase 6) so that eviction is
 * paid once. So `page` is implemented, accepted and tested — and NOT advertised
 * yet.
 *
 * `looseObject` rather than `object` is what makes "accepted" true: a strict
 * object strips unknown keys during the SDK's tool-call validation, so a `page`
 * would never reach `execute`. A loose one keeps it, and — measured against
 * `asSchema` from the AI SDK, the same conversion the request uses — serialises
 * BYTE-IDENTICALLY to the strict object it replaced. `read-generated-file.test.ts`
 * pins that byte string, so the day someone adds a field here, the test says so.
 */
export const readGeneratedFileInputSchema = z.looseObject(
	readGeneratedFileAdvertisedFields,
);

/**
 * What `execute` actually reads: the advertised fields plus the undocumented
 * `page`. A `page` that is not a 1-based integer is dropped rather than
 * failing the call — an undocumented parameter must never be the reason a tool
 * call errors.
 */
export const readGeneratedFileExecutionInputSchema = z.object({
	...readGeneratedFileAdvertisedFields,
	page: z.number().int().min(1).optional().catch(undefined),
});

export type ReadGeneratedFileInput = z.infer<
	typeof readGeneratedFileExecutionInputSchema
>;

// ── Target resolution ──────────────────────────────────────────

type ArtifactRow = typeof artifacts.$inferSelect;

export type ReadGeneratedFileSource = "generated" | "document";
export type ReadGeneratedFileConversation = "this" | "library";

export interface ReadGeneratedFileCandidate {
	filename: string;
	updatedAt: string;
	conversation: ReadGeneratedFileConversation;
}

type ResolvedTarget = {
	row: ArtifactRow;
	source: ReadGeneratedFileSource;
	conversation: ReadGeneratedFileConversation;
};

type TargetLookup =
	| { status: "match"; target: ResolvedTarget }
	| { status: "ambiguous"; candidates: ReadGeneratedFileCandidate[] }
	| { status: "none" };

function normalizeName(value: string | null | undefined): string {
	return (value ?? "").trim().toLowerCase();
}

function stemOf(value: string): string {
	const trimmed = value.trim();
	const ext = extname(trimmed);
	return normalizeName(ext ? basename(trimmed, ext) : trimmed);
}

async function listGeneratedOutputRows(params: {
	userId: string;
	conversationId: string;
	filename?: string | null;
}): Promise<ArtifactRow[]> {
	const conditions = [
		eq(artifacts.userId, params.userId),
		eq(artifacts.conversationId, params.conversationId),
		eq(artifacts.type, "generated_output"),
		eq(artifacts.retrievalClass, "durable"),
	];

	if (params.filename) {
		const trimmed = params.filename.trim();
		if (trimmed) {
			conditions.push(eq(artifacts.name, trimmed));
		}
	}

	return db
		.select()
		.from(artifacts)
		.where(and(...conditions))
		.orderBy(desc(artifacts.updatedAt))
		.limit(8);
}

type GeneratedPick = {
	row: ArtifactRow;
	/**
	 * True when the only thing that matched was the file's BODY mentioning
	 * the request title. Too weak to shadow a document that matches by
	 * name — a summary the assistant wrote about "the lease" must not be
	 * served when the user asks for the lease itself.
	 */
	contentOnly: boolean;
};

/**
 * The pre-existing generated_output lookup: exact filename, then a
 * filename "contains", then requestTitle against name / label / content.
 * Returns null instead of falling back to the newest file so the document
 * lookup gets its turn first; the newest-file fallback runs last.
 */
function pickGeneratedOutputRow(
	rows: ArtifactRow[],
	params: { filename?: string | null; requestTitle?: string | null },
): GeneratedPick | null {
	const filenameLower = normalizeName(params.filename);
	const requestTitleLower = normalizeName(params.requestTitle);

	let bestMatch: ArtifactRow | undefined;

	if (filenameLower) {
		bestMatch = rows.find((row) => normalizeName(row.name) === filenameLower);
		if (!bestMatch) {
			bestMatch = rows.find((row) =>
				normalizeName(row.name).includes(filenameLower),
			);
		}
	}
	if (bestMatch) return { row: bestMatch, contentOnly: false };

	if (requestTitleLower) {
		const labelOf = (row: ArtifactRow) =>
			parseWorkingDocumentMetadata(
				parseJsonRecord(row.metadataJson),
			).documentLabel?.toLowerCase();
		bestMatch = rows.find(
			(row) =>
				normalizeName(row.name).includes(requestTitleLower) ||
				labelOf(row)?.includes(requestTitleLower),
		);
		if (bestMatch) return { row: bestMatch, contentOnly: false };
		bestMatch = rows.find(
			(row) =>
				row.contentText?.toLowerCase().includes(requestTitleLower) ?? false,
		);
		if (bestMatch) return { row: bestMatch, contentOnly: true };
	}

	return null;
}

/**
 * The columns name matching needs. The full row (with `contentText`) is
 * loaded only for the winner, so matching against a large Knowledge
 * Library never pulls every document body into memory.
 */
type DocumentNameRow = Pick<
	ArtifactRow,
	"id" | "name" | "metadataJson" | "updatedAt" | "conversationId"
>;

/**
 * Names a normalized document answers to. Ingestion stores the normalized
 * artifact as `<stem>.md` and keeps the uploaded filename in
 * `metadata.normalizedFrom`; the model sees the uploaded filename under
 * "Conversation Files", so both must match.
 */
function documentNamesOf(row: DocumentNameRow): string[] {
	const metadata = parseJsonRecord(row.metadataJson);
	const normalizedFrom =
		typeof metadata?.normalizedFrom === "string"
			? metadata.normalizedFrom
			: null;
	return [row.name, normalizedFrom].filter((value): value is string =>
		Boolean(value?.trim()),
	);
}

/**
 * A "contains" match needs this much needle: "a" or "pd" is in almost
 * every name, and a lone document containing it would otherwise be served
 * as a confident unique match.
 */
const MIN_CONTAINS_NEEDLE_LENGTH = 3;

/**
 * Match tiers, strongest first. Two candidates in the same winning tier
 * are ambiguous; never fuzzy-pick between them.
 */
function documentMatchTier(row: DocumentNameRow, needle: string): number {
	const needleLower = normalizeName(needle);
	const needleStem = stemOf(needle);
	if (!needleLower) return 0;
	const names = documentNamesOf(row);
	if (names.some((name) => normalizeName(name) === needleLower)) return 3;
	if (needleStem && names.some((name) => stemOf(name) === needleStem)) return 2;
	if (
		needleLower.length >= MIN_CONTAINS_NEEDLE_LENGTH &&
		names.some((name) => normalizeName(name).includes(needleLower))
	)
		return 1;
	return 0;
}

function toCandidate(
	row: DocumentNameRow,
	conversation: ReadGeneratedFileConversation,
): ReadGeneratedFileCandidate {
	const metadata = parseJsonRecord(row.metadataJson);
	const filename =
		typeof metadata?.normalizedFrom === "string" &&
		metadata.normalizedFrom.trim()
			? metadata.normalizedFrom.trim()
			: row.name;
	return {
		filename,
		updatedAt: row.updatedAt.toISOString(),
		conversation,
	};
}

type DocumentPick =
	| {
			status: "match";
			row: DocumentNameRow;
			conversation: ReadGeneratedFileConversation;
	  }
	| { status: "ambiguous"; candidates: ReadGeneratedFileCandidate[] }
	| { status: "none" };

function pickDocumentRows(
	rows: DocumentNameRow[],
	needle: string,
	conversation: ReadGeneratedFileConversation,
): DocumentPick {
	let bestTier = 0;
	let best: DocumentNameRow[] = [];
	for (const row of rows) {
		const tier = documentMatchTier(row, needle);
		if (tier === 0) continue;
		if (tier > bestTier) {
			bestTier = tier;
			best = [row];
		} else if (tier === bestTier) {
			best.push(row);
		}
	}
	if (best.length === 0) return { status: "none" };
	if (best.length === 1) {
		return { status: "match", row: best[0], conversation };
	}
	return {
		status: "ambiguous",
		candidates: best.map((row) => toCandidate(row, conversation)),
	};
}

/**
 * Indexed uploads the user owns: first the ones attached to THIS
 * conversation, then the rest of the Knowledge Library. Every query is
 * scoped by `artifacts.userId`.
 */
async function findNormalizedDocument(params: {
	userId: string;
	conversationId: string;
	needle: string;
}): Promise<TargetLookup> {
	const rows = await db
		.select({
			id: artifacts.id,
			name: artifacts.name,
			metadataJson: artifacts.metadataJson,
			updatedAt: artifacts.updatedAt,
			conversationId: artifacts.conversationId,
		})
		.from(artifacts)
		.where(
			and(
				eq(artifacts.userId, params.userId),
				eq(artifacts.type, "normalized_document"),
				eq(artifacts.retrievalClass, "durable"),
			),
		)
		.orderBy(desc(artifacts.updatedAt));

	const inConversation = rows.filter(
		(row) => row.conversationId === params.conversationId,
	);
	let pick = pickDocumentRows(inConversation, params.needle, "this");
	if (pick.status === "none") {
		const library = rows.filter(
			(row) => row.conversationId !== params.conversationId,
		);
		pick = pickDocumentRows(library, params.needle, "library");
	}
	if (pick.status !== "match") return pick;

	const [row] = await db
		.select()
		.from(artifacts)
		.where(
			and(eq(artifacts.id, pick.row.id), eq(artifacts.userId, params.userId)),
		)
		.limit(1);
	if (!row) return { status: "none" };
	return {
		status: "match",
		target: { row, source: "document", conversation: pick.conversation },
	};
}

async function resolveReadTarget(params: {
	userId: string;
	conversationId: string;
	filename?: string | null;
	requestTitle?: string | null;
}): Promise<TargetLookup> {
	const generatedRows = await listGeneratedOutputRows(params);
	const generated = pickGeneratedOutputRow(generatedRows, params);
	const asGenerated = (row: ArtifactRow): TargetLookup => ({
		status: "match",
		target: { row, source: "generated", conversation: "this" },
	});
	if (generated && !generated.contentOnly) return asGenerated(generated.row);

	const needle = params.filename?.trim() || params.requestTitle?.trim() || "";
	if (needle) {
		const document = await findNormalizedDocument({
			userId: params.userId,
			conversationId: params.conversationId,
			needle,
		});
		if (document.status !== "none") return document;
	}

	// A generated file whose body merely mentions the title outranks only
	// the newest-file fallback.
	if (generated) return asGenerated(generated.row);

	// Pre-existing fallback: the newest generated file of this conversation.
	if (generatedRows.length > 0) {
		return {
			status: "match",
			target: {
				row: generatedRows[0],
				source: "generated",
				conversation: "this",
			},
		};
	}
	return { status: "none" };
}

// ── Passages ───────────────────────────────────────────────────

const PASSAGE_LIMIT = 3;
const PASSAGE_CHAR_BUDGET = 1200 * PASSAGE_LIMIT;

export interface ReadGeneratedFilePassage {
	chunkIndex: number;
	text: string;
	/** Character offset of the chunk in the file, when it can be located. */
	charOffset: number | null;
	/** Nearest preceding outline heading, when the document has an outline. */
	section: string | null;
	/**
	 * 1-based inclusive pages this passage spans, for a document parsed with
	 * structure. Null for direct text, for legacy rows and for a document too
	 * small to be chunked. The same pair the prompt cites as `[p. N]`.
	 */
	pageStart: number | null;
	pageEnd: number | null;
	/** The file continues past this passage. */
	hasMore: boolean;
	/** Offset to pass as `from` to read on from this passage. */
	nextFrom: number | null;
}

function rowToArtifact(row: ArtifactRow, contentText: string | null): Artifact {
	const metadata = parseJsonRecord(row.metadataJson);
	const outline = readStoredOutline(metadata?.outline);
	return {
		id: row.id,
		type: row.type as ArtifactType,
		retrievalClass: (row.retrievalClass ?? "durable") as ArtifactRetrievalClass,
		name: row.name,
		mimeType: row.mimeType,
		sizeBytes: row.sizeBytes ?? null,
		conversationId: row.conversationId ?? null,
		summary: row.summary ?? null,
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime(),
		...(outline.length > 0 ? { outline } : {}),
		userId: row.userId,
		extension: row.extension ?? null,
		storagePath: row.storagePath ?? null,
		contentText,
		metadata,
	};
}

/** An offset in CRLF-normalized text, mapped back into the original. */
function toRawOffset(contentText: string, normalizedIndex: number): number {
	let extra = 0;
	let crlf = contentText.indexOf("\r\n");
	while (crlf !== -1 && crlf < normalizedIndex + extra) {
		extra += 1;
		crlf = contentText.indexOf("\r\n", crlf + 2);
	}
	return normalizedIndex + extra;
}

/**
 * Where a chunk sits in the document, as offsets into the ORIGINAL text
 * (what a `from` window slices): `start` of the chunk and `end` of its
 * first `servedLength` characters. chunk-sync.ts normalizes CRLF before
 * slicing, so a chunk that is not found verbatim is looked up in the
 * normalized text and both offsets mapped back.
 */
function locateChunk(
	contentText: string,
	chunkText: string,
	servedLength: number,
): { start: number; end: number } | null {
	if (!chunkText) return null;
	const direct = contentText.indexOf(chunkText);
	if (direct >= 0) return { start: direct, end: direct + servedLength };
	const normalized = contentText.replace(/\r\n/g, "\n");
	const found = normalized.indexOf(chunkText);
	if (found < 0) return null;
	return {
		start: toRawOffset(contentText, found),
		end: toRawOffset(contentText, found + servedLength),
	};
}

function sectionTitleAt(
	outline: DocumentOutlineEntry[] | undefined,
	charOffset: number | null,
): string | null {
	if (!outline || outline.length === 0 || charOffset === null) return null;
	let current: DocumentOutlineEntry | null = null;
	for (const entry of outline) {
		if (entry.offset <= charOffset) {
			if (!current || entry.offset >= current.offset) current = entry;
		}
	}
	return current?.title ?? null;
}

async function buildPassages(params: {
	userId: string;
	artifact: Artifact;
	query: string;
	useStoredChunks: boolean;
}): Promise<{ passages: ReadGeneratedFilePassage[]; hasMore: boolean }> {
	const selected = await selectDocumentPassages({
		userId: params.userId,
		artifact: params.artifact,
		query: params.query,
		limit: PASSAGE_LIMIT,
		charBudget: PASSAGE_CHAR_BUDGET,
		useStoredChunks: params.useStoredChunks,
	});
	const contentText = params.artifact.contentText ?? "";
	const passages = selected.passages.map((passage) => {
		// `text` is a verbatim prefix of the chunk, so its length is exactly
		// how far the served text reaches into the document.
		const located = contentText
			? locateChunk(contentText, passage.chunkText, passage.text.length)
			: null;
		const charOffset = located?.start ?? null;
		const hasMore =
			passage.truncated || passage.chunkIndex < selected.chunkCount - 1;
		const nextFrom = located?.end ?? null;
		return {
			chunkIndex: passage.chunkIndex,
			text: passage.text,
			charOffset,
			section: sectionTitleAt(params.artifact.outline, charOffset),
			pageStart: passage.pageStart,
			pageEnd: passage.pageEnd,
			hasMore,
			nextFrom:
				nextFrom !== null && nextFrom < contentText.length ? nextFrom : null,
		};
	});
	return {
		passages,
		hasMore: selected.chunkCount > passages.length,
	};
}

// ── Composable query ───────────────────────────────────────────

const MAX_CONTENT_LENGTH = 24000;

/**
 * The window's end, nudged one code unit past a surrogate pair so an emoji
 * or CJK-extension character on the boundary is never split into a lone
 * surrogate (which JSON-encodes as garbage the model then copies).
 */
function windowEnd(text: string, end: number): number {
	if (end >= text.length) return text.length;
	const last = text.charCodeAt(end - 1);
	return last >= 0xd800 && last <= 0xdbff ? end + 1 : end;
}

export interface ReadGeneratedFileResult {
	filename: string | null;
	documentLabel: string | null;
	versionNumber: number | null;
	/** The requested window of the text (null in passage mode / not found). */
	contentText: string | null;
	summary: string | null;
	mimeType: string | null;
	/** Length of the whole text, not of the window. */
	contentLength: number;
	notFound: boolean;
	ambiguous: boolean;
	candidates: ReadGeneratedFileCandidate[];
	source: ReadGeneratedFileSource | null;
	conversation: ReadGeneratedFileConversation | null;
	from: number;
	to: number;
	hasMore: boolean;
	nextFrom: number | null;
	query: string | null;
	passages: ReadGeneratedFilePassage[] | null;
	/** The 1-based page the window was started at, when `page` was honoured. */
	page: number | null;
	/** Pages the document has, when it has a parse bundle to say so. */
	pageCount: number | null;
	/** What `page`/`pageCount` count: pages, slides or sheets. */
	pageUnit: PageCountUnit | null;
	/** Why a requested `page` was ignored. One line, for the model. */
	pageNote: string | null;
}

/** The word for each unit in the one-line tool summary. */
const PAGE_WORDS: Readonly<Record<PageCountUnit, string>> = {
	page: "p.",
	slide: "slide",
	sheet: "sheet",
};

const NO_PAGE_INFORMATION_NOTE =
	"This document has no page information, so `page` was ignored; the text is shown from the start. Use `from` or `query` instead.";

function emptyResult(
	overrides: Partial<ReadGeneratedFileResult> & { notFound: boolean },
): ReadGeneratedFileResult {
	return {
		filename: null,
		documentLabel: null,
		versionNumber: null,
		contentText: null,
		summary: null,
		mimeType: null,
		contentLength: 0,
		ambiguous: false,
		candidates: [],
		source: null,
		conversation: null,
		from: 0,
		to: 0,
		hasMore: false,
		nextFrom: null,
		query: null,
		passages: null,
		page: null,
		pageCount: null,
		pageUnit: null,
		pageNote: null,
		...overrides,
	};
}

function normalizeFrom(value: number | null | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.floor(value));
}

/** A 1-based page, or null when the caller did not ask for one. */
function normalizePage(value: number | null | undefined): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	const page = Math.floor(value);
	return page >= 1 ? page : null;
}

/**
 * Where a page starts in the document's text, from the parse bundle's page
 * index.
 *
 * The bundle is keyed on the SOURCE artifact while the text belongs to its
 * normalized half, so this makes the same hop the figure endpoint and
 * `working-document-file-serving.ts` make. `pages.json` is a small file read
 * only on a tool call that actually passes `page` — never on the prompt
 * assembly path.
 *
 * `offset: null` means the document has no page index at all (direct text, a
 * legacy row, a generated file): the caller says so and reads from the start.
 * A page past the end resolves to the end of the text, which lands on the
 * existing "nothing further to read" note rather than inventing an error.
 */
async function resolvePageOffset(params: {
	userId: string;
	row: ArtifactRow;
	page: number;
	contentLength: number;
	/** The text the offsets will be applied to, for the staleness check. */
	contentText: string | null;
}): Promise<{
	offset: number | null;
	pageCount: number | null;
	unit: PageCountUnit | null;
}> {
	if (params.row.type !== "normalized_document") {
		return { offset: null, pageCount: null, unit: null };
	}
	// The same honesty rule the prompt citation applies: a `declared` DOCX
	// count, a `logical` CSV count or a kind we never learned is not a page a
	// reader could turn to, and handing the model "page 3" for one of them is
	// an invention rather than a citation. `artifacts.ts` refused to cite them;
	// this path reported them anyway.
	const unit = pageCountUnit(
		readStoredPageCountKind(
			parseJsonRecord(params.row.metadataJson ?? null)?.pageCountKind,
		) ?? null,
	);
	if (!unit) return { offset: null, pageCount: null, unit: null };
	const sourceArtifactId = await getSourceArtifactIdForNormalizedArtifact(
		params.userId,
		params.row.id,
	);
	if (!sourceArtifactId) return { offset: null, pageCount: null, unit: null };

	// The text is handed in so the bundle's own `markdownSha256` can be checked
	// against it. The bundle is written by the extractor BEFORE the artifact
	// text is rewritten, so an attempt that parsed and then failed to persist
	// leaves an index one parse ahead of the document — and every page it
	// resolves would land somewhere else in the text, silently, with a citation
	// on it. A mismatch reads as "no page index", which is the existing
	// read-from-the-start path.
	const pages = await readMineruPageIndex(params.userId, sourceArtifactId, {
		expectedMarkdown: params.contentText,
	});
	if (!pages || pages.length === 0) {
		return { offset: null, pageCount: null, unit: null };
	}

	const entry = pages.find((page) => page.page === params.page);
	if (!entry) {
		// Past the last page: the end-of-content note is the honest answer.
		return { offset: params.contentLength, pageCount: pages.length, unit };
	}
	const offset = Math.max(0, Math.min(params.contentLength, entry.start));
	return { offset, pageCount: pages.length, unit };
}

function normalizeQuery(value: unknown): string | null {
	const trimmed = typeof value === "string" ? value.trim() : "";
	return trimmed ? trimmed.slice(0, MAX_QUERY_LENGTH) : null;
}

export async function readGeneratedFileContent(params: {
	userId: string;
	conversationId: string;
	filename?: string | null;
	requestTitle?: string | null;
	from?: number | null;
	query?: string | null;
	/**
	 * 1-based page of a parsed document to start the window at. Lowest
	 * precedence: `query` wins, then an explicit `from`, then this.
	 */
	page?: number | null;
	/** Scopes the per-turn cache; omit to bypass caching. */
	turnId?: string | null;
}): Promise<ReadGeneratedFileResult> {
	const from = normalizeFrom(params.from);
	const query = normalizeQuery(params.query);
	const requestedPage = normalizePage(params.page);
	// `from: 0` is a real instruction ("start at the beginning"), so precedence
	// turns on whether `from` was PASSED, not on its value.
	const fromWasPassed =
		typeof params.from === "number" && Number.isFinite(params.from);
	const pageRequested = requestedPage !== null && !query && !fromWasPassed;

	const lookup = await resolveReadTarget(params);
	if (lookup.status === "none") {
		return emptyResult({ filename: params.filename ?? null, notFound: true });
	}
	if (lookup.status === "ambiguous") {
		return emptyResult({
			filename: params.filename ?? params.requestTitle ?? null,
			notFound: false,
			ambiguous: true,
			candidates: lookup.candidates,
		});
	}

	const { row, source, conversation } = lookup.target;
	// Keyed on the resolved artifact (plus its updatedAt, so a rewritten
	// file is never served stale) and the turn, so a repeat call for the
	// same window or query inside one turn is answered from memory.
	const cacheKey = params.turnId
		? buildToolResultCacheKey({
				conversationId: params.conversationId,
				toolName: "read_generated_file",
				input: {
					artifactId: row.id,
					updatedAt: row.updatedAt.getTime(),
					from,
					query,
					page: pageRequested ? requestedPage : null,
					turnId: params.turnId,
				},
			})
		: null;
	if (cacheKey) {
		const cached = getCachedToolResult<ReadGeneratedFileResult>(cacheKey);
		if (cached) return cached;
	}

	const metadata = parseWorkingDocumentMetadata(
		parseJsonRecord(row.metadataJson),
	);
	const resolvedContent =
		source === "generated"
			? await resolveBestContent(
					params.userId,
					row.contentText,
					row.metadataJson,
				)
			: (row.contentText?.trim() ?? null);
	const contentLength = resolvedContent?.length ?? 0;
	const displayName =
		source === "document" ? toCandidate(row, conversation).filename : row.name;

	const base: ReadGeneratedFileResult = {
		filename: displayName,
		documentLabel: metadata.documentLabel ?? null,
		versionNumber: metadata.versionNumber ?? null,
		contentText: null,
		summary: row.summary?.trim() ?? null,
		mimeType: row.mimeType,
		contentLength,
		notFound: false,
		ambiguous: false,
		candidates: [],
		source,
		conversation,
		from: 0,
		to: 0,
		hasMore: false,
		nextFrom: null,
		query,
		passages: null,
		page: null,
		pageCount: null,
		pageUnit: null,
		pageNote: null,
	};

	// One small JSON read, and only when `page` is both passed and not
	// outranked by `query`/`from`.
	const pageLookup = pageRequested
		? await resolvePageOffset({
				userId: params.userId,
				row,
				page: requestedPage as number,
				contentLength,
				contentText: resolvedContent ?? null,
			})
		: null;

	let result: ReadGeneratedFileResult;
	if (query) {
		const artifact = rowToArtifact(row, resolvedContent);
		const { passages, hasMore } = await buildPassages({
			userId: params.userId,
			artifact,
			query,
			// A generated file's stored chunks were cut from the memory
			// wrapper (header + assistant reply + extracted content), not from
			// the text resolved above; offsets into it would not line up and
			// the wrapper metadata would leak into a passage.
			useStoredChunks: source !== "generated",
		});
		result = { ...base, passages, hasMore };
	} else {
		const pageOffset = pageLookup?.offset ?? null;
		const start = Math.min(pageOffset ?? from, contentLength);
		const window = resolvedContent
			? resolvedContent.slice(
					start,
					windowEnd(resolvedContent, start + MAX_CONTENT_LENGTH),
				)
			: null;
		const to = start + (window?.length ?? 0);
		const hasMore = to < contentLength;
		result = {
			...base,
			contentText: window,
			from: start,
			to,
			hasMore,
			nextFrom: hasMore ? to : null,
			page: pageOffset === null ? null : requestedPage,
			pageCount: pageLookup?.pageCount ?? null,
			pageUnit: pageLookup?.unit ?? null,
			pageNote:
				pageRequested && pageOffset === null ? NO_PAGE_INFORMATION_NOTE : null,
		};
	}

	if (cacheKey) setCachedToolResult(cacheKey, result);
	return result;
}

// ── Model payload ──────────────────────────────────────────────

export function buildReadGeneratedFileModelPayload(
	result: ReadGeneratedFileResult,
): Record<string, unknown> {
	if (result.notFound) {
		return {
			found: false,
			filename: result.filename,
			error:
				"No file matching the requested filename or title was found in this conversation or the user's documents.",
		};
	}
	if (result.ambiguous) {
		return {
			found: false,
			ambiguous: true,
			filename: result.filename,
			candidates: result.candidates,
			error:
				"Several files match; call again with one exact filename from candidates.",
		};
	}

	const base = {
		found: true,
		filename: result.filename,
		source: result.source,
		conversation: result.conversation,
		documentLabel: result.documentLabel,
		versionNumber: result.versionNumber,
		summary: result.summary,
		mimeType: result.mimeType,
		contentLength: result.contentLength,
	};

	if (result.passages) {
		return {
			...base,
			query: result.query,
			passages: result.passages,
			passageCount: result.passages.length,
			hasMore: result.hasMore,
			...(result.passages.length === 0
				? {
						note: `No passage of this file matches "${result.query ?? ""}". Read it with \`from\` instead, or try other words.`,
					}
				: {}),
		};
	}

	const pageFields = {
		...(result.page !== null ? { page: result.page } : {}),
		...(result.pageCount !== null ? { pageCount: result.pageCount } : {}),
	};
	const remaining = result.contentLength - result.to;
	// `from` at or past the end: found, but nothing to show — say so rather
	// than returning a bare `found: true` the model may read as empty file.
	if (result.contentLength > 0 && result.from >= result.contentLength) {
		return {
			...base,
			...pageFields,
			from: result.from,
			to: result.to,
			hasMore: false,
			nextFrom: null,
			truncated: false,
			note: `from (${result.from}) is at or past the end of the text (${result.contentLength} characters); there is nothing further to read.`,
		};
	}
	const content =
		result.contentText && result.contentText.length > 0
			? result.hasMore
				? `${result.contentText}...\n[Content truncated — ${remaining} more characters. Call again with from: ${result.nextFrom} to continue.]`
				: result.contentText
			: null;

	return {
		...base,
		...pageFields,
		content,
		from: result.from,
		to: result.to,
		hasMore: result.hasMore,
		nextFrom: result.nextFrom,
		truncated: result.hasMore,
		...(result.pageNote ? { note: result.pageNote } : {}),
	};
}

export function summarizeReadGeneratedFileResult(
	result: ReadGeneratedFileResult,
): string {
	if (result.notFound) {
		return "No matching file found.";
	}
	if (result.ambiguous) {
		const names = result.candidates.map((candidate) => candidate.filename);
		return `Several files match "${result.filename ?? ""}": ${names.join(", ")}.`;
	}
	const label = result.documentLabel ?? result.filename ?? "file";
	const version = result.versionNumber ? ` v${result.versionNumber}` : "";
	const length = result.contentLength ? ` (${result.contentLength} chars)` : "";
	if (result.passages) {
		return `Found "${label}"${version}${length}: ${result.passages.length} passage(s) for "${result.query ?? ""}".`;
	}
	const window =
		result.from > 0 || result.hasMore
			? `, chars ${result.from}–${result.to}${result.hasMore ? `, more from ${result.nextFrom}` : ""}`
			: "";
	// "p." was hardcoded, so a deck read "from p. 3" and a spreadsheet named a
	// page nobody can turn to. The unit comes from the same shared vocabulary
	// the chip and the citation use.
	const page =
		result.page !== null
			? `, from ${PAGE_WORDS[result.pageUnit ?? "page"]} ${result.page}`
			: "";
	return `Found "${label}"${version}${length}${page}${window}.`;
}

// ── Sanitization ───────────────────────────────────────────────

export function sanitizeReadGeneratedFileInput(
	input: ReadGeneratedFileInput,
): Record<string, unknown> {
	const safe: Record<string, unknown> = {};
	if (typeof input.filename === "string" && input.filename.trim()) {
		safe.filename = input.filename.trim();
	}
	if (typeof input.requestTitle === "string" && input.requestTitle.trim()) {
		safe.requestTitle = input.requestTitle.trim();
	}
	if (typeof input.from === "number" && Number.isFinite(input.from)) {
		safe.from = Math.max(0, Math.floor(input.from));
	}
	const query = normalizeQuery(input.query);
	if (query) {
		safe.query = query;
	}
	const page = normalizePage(input.page);
	if (page !== null) {
		safe.page = page;
	}
	return safe;
}
