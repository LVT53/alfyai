/**
 * MinerU 4.x structured results: the zip reader, the parsed document model,
 * the renderers and the chunk planner.
 *
 * Everything here is written against `docs/plans/mineru4/phase0-local-spike.md`
 * and the recorded fixtures under `fixtures/mineru-v1/`, never against the
 * upstream Draft schema — the two describe different formats and only the
 * fixtures are real. The three facts that shape the whole module:
 *
 *   1. `structured_content` is `{pages:[{page_idx, blocks:[…]}], metadata,
 *      extensions, is_full_document}`. Blocks carry `type` and a Markdown
 *      string `content`; `bbox` is a flat array of four 0..1 floats whose key
 *      is ABSENT (never null) for Office/HTML/EPUB/CSV. There are no ids, no
 *      locators and no page numbers — the page number is the array index + 1.
 *   2. Only `flash` and `basic` output was ever captured. `standard` and
 *      `advanced` may emit block types nobody here has seen, so an unknown
 *      type is rendered as its `content` and treated as an atomic block. It is
 *      never an error, and it is counted into `stats.unknownTypes` so the
 *      GPU-box checklist has data to read.
 *   3. The prompt text is built FROM BLOCKS, not from the zip's `markdown.md`:
 *      `markdown.md` is a flat string with no page boundaries and no block
 *      types, and page-aware chunking needs both. `renderMineruMarkdown` is
 *      the proof that the block model loses nothing — it reproduces
 *      `markdown.md` byte for byte on eight of ten fixtures and differs only
 *      by `<a id="…"></a>` anchor lines on HTML and EPUB.
 */

import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { z } from "zod";
import { extractDocumentOutline } from "$lib/server/services/knowledge/outline";
import type { ExtractionErrorCode } from "$lib/shared/extraction-status";
import { resolveEntry } from "$lib/shared/file-types";
import {
	isPageCountKind,
	PAGE_COUNT_KINDS,
	type PageCountKind,
} from "$lib/shared/page-count";
import { MINERU_MAX_DOWNLOAD_BYTES } from "./config";

// ── version ────────────────────────────────────────────────────────────────

/**
 * Bumped whenever `renderPromptMarkdown` or `planStructuredChunks` changes its
 * output, so a reviewer can tell which rows were produced by which renderer.
 * Persisted as `metadata.extractionParserVersion`.
 */
export const MINERU_PARSER_VERSION = "mineru4/1";

// ── block vocabulary ───────────────────────────────────────────────────────

/** Exactly the vocabulary observed across the nine fixture inputs. */
export const KNOWN_BLOCK_TYPES = [
	"text",
	"paragraph_title",
	"doc_title",
	"list",
	"table",
	"image",
	"header",
	"footer",
	"page_number",
] as const;
export type KnownBlockType = (typeof KNOWN_BLOCK_TYPES)[number];

/**
 * Dropped before the prompt text is built. PDF-only in every fixture, emitted
 * once per page, and already excluded from MinerU's own `markdown.md` — a
 * client that concatenates block content without filtering these repeats the
 * running head on every page.
 */
export const RUNNING_HEAD_BLOCK_TYPES = [
	"header",
	"footer",
	"page_number",
] as const;

/**
 * Blocks a chunk boundary must never fall inside. `table` and `image` are the
 * only ones observed; the rest are the Draft names that `standard`/`advanced`
 * may emit and that must not be split if they appear. ANY UNKNOWN TYPE IS
 * ALSO ATOMIC — see `isAtomicBlockType`.
 */
export const ATOMIC_BLOCK_TYPES = [
	"table",
	"image",
	"code",
	"equation_interline",
	"chart",
	"algorithm",
] as const;

const KNOWN_BLOCK_TYPE_SET: ReadonlySet<string> = new Set(KNOWN_BLOCK_TYPES);
const RUNNING_HEAD_SET: ReadonlySet<string> = new Set(RUNNING_HEAD_BLOCK_TYPES);
const ATOMIC_SET: ReadonlySet<string> = new Set(ATOMIC_BLOCK_TYPES);
const HEADING_TYPES: ReadonlySet<string> = new Set([
	"doc_title",
	"paragraph_title",
]);

export function isKnownBlockType(type: string): type is KnownBlockType {
	return KNOWN_BLOCK_TYPE_SET.has(type);
}

export function isRunningHeadBlockType(type: string): boolean {
	return RUNNING_HEAD_SET.has(type);
}

/** Atomic when it is a known atomic type OR unknown entirely (§1.5). */
export function isAtomicBlockType(type: string): boolean {
	return ATOMIC_SET.has(type) || !KNOWN_BLOCK_TYPE_SET.has(type);
}

// ── typed errors ───────────────────────────────────────────────────────────

export type MineruResultErrorCode =
	/** The bytes are not a readable zip. */
	| "zip_unreadable"
	/** An entry is a traversal, an absolute path, a symlink or a duplicate. */
	| "zip_entry_rejected"
	/** Entry count, per-entry size or total uncompressed size over the cap. */
	| "zip_too_large"
	/** The zip has no `structured_content.json`. */
	| "structured_content_missing"
	/** `structured_content.json` is not JSON, or not the recorded shape. */
	| "structured_content_invalid"
	/** Parsed fine, but every block was dropped or empty. */
	| "empty_result";

const RESULT_ERROR_TAXONOMY: Readonly<
	Record<MineruResultErrorCode, ExtractionErrorCode>
> = {
	zip_unreadable: "protocol",
	zip_entry_rejected: "protocol",
	zip_too_large: "protocol",
	structured_content_missing: "protocol",
	structured_content_invalid: "protocol",
	empty_result: "empty_result",
};

/**
 * Everything this module refuses to do, with the Phase 3 taxonomy code the
 * extractor should surface. `retryable` follows
 * `RETRYABLE_EXTRACTION_ERROR_CODES` for `protocol` (a malformed zip may be a
 * half-written download) and is false for `empty_result` (re-parsing an empty
 * document yields an empty document).
 */
export class MineruResultError extends Error {
	readonly code: MineruResultErrorCode;
	readonly taxonomy: ExtractionErrorCode;
	readonly retryable: boolean;
	readonly details: Readonly<Record<string, unknown>>;

	constructor(
		code: MineruResultErrorCode,
		message: string,
		details: Readonly<Record<string, unknown>> = {},
	) {
		super(message);
		this.name = "MineruResultError";
		this.code = code;
		this.taxonomy = RESULT_ERROR_TAXONOMY[code];
		this.retryable = this.taxonomy === "protocol";
		this.details = details;
	}
}

// ── structured_content schemas ─────────────────────────────────────────────
//
// Every object is `.passthrough()`: a minor server upgrade that adds a key
// must not turn a working parse into a `protocol` failure.

export const structuredCaptionSchema = z
	.object({
		bbox: z.array(z.number()).length(4).optional(),
		content: z.string().default(""),
	})
	.passthrough();

export const structuredBlockSchema = z
	.object({
		/** NOT an enum — an unrecognised type is legal and must survive. */
		type: z.string(),
		/** Always a Markdown string. `""` for an `image` block. */
		content: z.string().default(""),
		/** Four 0..1 floats. ABSENT (not null) for Office/HTML/EPUB/CSV. */
		bbox: z.array(z.number()).length(4).optional(),
		/** A SIBLING of content, not a field inside it. */
		level: z.number().int().optional(),
		/** HTML/EPUB only. Never rendered. */
		anchor: z.string().optional(),
		/** PLURAL. Singular `caption` does not exist. */
		captions: z.array(structuredCaptionSchema).optional(),
		footnotes: z.array(structuredCaptionSchema).optional(),
		/** A bare string: `images/<name>.jpg` in the zip copy, a data: URI standalone. */
		image_source: z.string().optional(),
	})
	.passthrough();

export const structuredPageSchema = z
	.object({
		/** 0-based. The page number is this + 1; there is no `page_number` key. */
		page_idx: z.number().int(),
		blocks: z.array(structuredBlockSchema).default([]),
	})
	.passthrough();

export const structuredContentSchema = z
	.object({
		pages: z.array(structuredPageSchema).default([]),
		metadata: z
			.object({
				/** UNRELIABLE: a PNG reports the PDF suffix, because MinerU wraps
				 * the image in a PDF internally. Never derive the format from it. */
				file_suffix: z.string().optional(),
				producer: z
					.object({
						name: z.string().optional(),
						version: z.string().optional(),
					})
					.passthrough()
					.optional(),
				/** Sparse and format-dependent. `{}` for PNG/JPEG. Every key optional. */
				document: z
					.object({
						title: z.string().optional(),
						authors: z.array(z.string()).optional(),
						subject: z.string().optional(),
						description: z.string().optional(),
						languages: z.array(z.string()).optional(),
						identifiers: z.unknown().optional(),
						created_at: z.string().optional(),
						modified_at: z.string().optional(),
						creator_application: z.string().optional(),
						producer_application: z.string().optional(),
						page_count: z.number().int().optional(),
						page_count_kind: z.string().optional(),
					})
					.passthrough()
					.default({}),
			})
			.passthrough()
			.default({ document: {} }),
		extensions: z
			.object({
				/** THE tier to trust. The job's `tier` lies about what parsed the file. */
				mineru: z
					.object({
						tier: z.string().optional(),
						parse_mode: z.string().optional(),
					})
					.passthrough()
					.optional(),
				docvortex_layout: z
					.object({
						version: z.number().optional(),
						pages: z
							.array(
								z
									.object({
										page_idx: z.number().int(),
										width_pt: z.number().optional(),
										height_pt: z.number().optional(),
									})
									.passthrough(),
							)
							.default([]),
					})
					.passthrough()
					.optional(),
			})
			.passthrough()
			.default({}),
		is_full_document: z.boolean().optional(),
	})
	.passthrough();

export type StructuredContent = z.infer<typeof structuredContentSchema>;
export type StructuredBlock = z.infer<typeof structuredBlockSchema>;

// ── the parsed model ───────────────────────────────────────────────────────

// The vocabulary itself lives in `$lib/shared/page-count`, because the chip
// that renders the count and the citation that names it both need it and
// neither may reach into a server service. Re-exported so existing importers
// of this module keep working.
export { PAGE_COUNT_KINDS, type PageCountKind };

/**
 * The most pages a declared `metadata.document.page_count` may add.
 *
 * `page_count` is one integer in a JSON document the MinerU server chose, and
 * the offset table is padded out to it so a page lookup never misses. A server
 * that says `50000000` therefore asked this process to allocate fifty million
 * objects — 3.3 GB, in about a second, on the single Node process that serves
 * every request. One document was enough to OOM the box.
 *
 * MinerU's own `/v1/usage.limits.max_pages_per_file` is 1000. Fifty thousand is
 * fifty times that: far past anything real, small enough to be harmless. A
 * count beyond it is clamped rather than rejected — the pages that actually
 * came back are still readable, and refusing the whole parse over a silly
 * metadata field would be the worse failure.
 */
export const MAX_STRUCTURED_PAGE_COUNT = 50_000;

export interface RenderedFigure {
	/** 1-based across the document, in reading order. */
	index: number;
	/** The bundle-relative path, e.g. `images/page_2_image_body_3.jpg`. */
	path: string;
	caption: string | null;
	/** 1-based page. */
	page: number;
	bbox: readonly [number, number, number, number] | null;
}

/** One rendered block, with everything a chunker or a citation needs. */
export interface RenderedBlock {
	/** 1-based. The page's array index + 1. */
	page: number;
	/** 0-based ordinal within the page, BEFORE any filtering. */
	blockIndex: number;
	type: string;
	/** True when `type` is not in KNOWN_BLOCK_TYPES. */
	unknownType: boolean;
	atomic: boolean;
	/** Heading level after per-format normalisation; null for non-headings. */
	headingLevel: number | null;
	/** Heading text with a wrapping `**…**` stripped; null for non-headings. */
	headingTitle: string | null;
	/** Inclusive start offset into the normalized Markdown. */
	start: number;
	/** Exclusive end offset into the normalized Markdown. */
	end: number;
	/** The text as it appears in the normalized Markdown (no trailing separator). */
	text: string;
	figure: RenderedFigure | null;
}

export interface PageOffset {
	/** 1-based. */
	page: number;
	/** Inclusive. */
	start: number;
	/** Exclusive. */
	end: number;
}

/**
 * One outline entry. Structurally a `DocumentOutlineEntry`
 * (`knowledge/types.ts`) plus the optional 1-based `page` that P4-B adds to
 * that interface — declared here so P4-A does not have to edit a file it does
 * not own.
 */
export interface MineruOutlineEntry {
	level: number;
	title: string;
	/** Offset into the normalized Markdown — the heading's own `#`. */
	offset: number;
	preview: string;
	/** 1-based page the heading sits on. Absent when it cannot be established. */
	page?: number;
}

export interface StructuredExtractionStats {
	/** Every block in `structured_content`, including the dropped running heads. */
	blockCount: number;
	droppedRunningHeads: number;
	/** type → count, for types outside KNOWN_BLOCK_TYPES. The GPU-box signal. */
	unknownTypes: Readonly<Record<string, number>>;
	bboxPresent: boolean;
	anchorsPresent: boolean;
}

export interface StructuredExtractionResult {
	/** Ours, not MinerU's. Bumped when the renderer or the planner changes. */
	parserVersion: string;
	/** `metadata.producer.version`, e.g. "4.0.4". */
	producerVersion: string | null;
	/** `files[0].parse.parser_version`. Usually equal to the above; not guaranteed. */
	serverParserVersion: string | null;
	/** `extensions.mineru.tier` — the REAL per-file tier. */
	effectiveTier: string | null;
	/** The tier the JOB reported. Diagnostics only; it lies. */
	jobTier: string | null;
	parseMode: string | null;
	pageCount: number;
	pageCountKind: PageCountKind;
	/** normalized.md, byte-identical to the artifact's contentText. */
	markdown: string;
	/** Page → [start, end) offsets into the Markdown. A contiguous partition. */
	pages: readonly PageOffset[];
	blocks: readonly RenderedBlock[];
	figures: readonly RenderedFigure[];
	outline: readonly MineruOutlineEntry[];
	stats: StructuredExtractionStats;
}

// ── the zip reader ─────────────────────────────────────────────────────────

export const MINERU_ZIP_STRUCTURED_CONTENT = "structured_content.json";
export const MINERU_ZIP_MARKDOWN = "markdown.md";
export const MINERU_ZIP_MIDDLE_JSON = "middle_json.json";
export const MINERU_ZIP_MODEL_OUTPUT = "model_output.json";
export const MINERU_ZIP_IMAGE_PREFIX = "images/";

/** The four artifacts the recorded zips carry, plus `images/`. */
const EXPECTED_ROOT_ENTRIES: ReadonlySet<string> = new Set([
	MINERU_ZIP_MARKDOWN,
	MINERU_ZIP_MIDDLE_JSON,
	MINERU_ZIP_STRUCTURED_CONTENT,
	MINERU_ZIP_MODEL_OUTPUT,
]);

/**
 * An image entry name, without the `images/` prefix. Deliberately stricter
 * than the zip format allows: MinerU names them
 * `page_<idx>_<subBlockType>_<index>.jpg`, and anything that is not a plain
 * one-segment filename is refused rather than sanitised.
 */
export const MINERU_IMAGE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface MineruZipLimits {
	/** Hard cap on the number of entries in the central directory. */
	maxEntries: number;
	/** Hard cap on one entry's uncompressed size. */
	maxEntryBytes: number;
	/** Hard cap on the sum of every entry's uncompressed size. */
	maxTotalBytes: number;
	/** Hard cap on the zip file itself. */
	maxCompressedBytes: number;
}

/**
 * Sized for the largest plausible parse result rather than for the recorded
 * fixtures (the 3-page PDF's zip is 71 kB): a 1000-page PDF — MinerU's own
 * `max_pages_per_file` — with one figure per page is still comfortably inside
 * these. A zip that exceeds any of them fails fast with `zip_too_large`,
 * before a single byte is inflated.
 */
export const DEFAULT_MINERU_ZIP_LIMITS: MineruZipLimits = {
	maxEntries: 4096,
	maxEntryBytes: 64 * 1024 * 1024,
	maxTotalBytes: 256 * 1024 * 1024,
	// The same number `client.ts` refuses to download past, so the two cannot
	// drift into a window where a zip is fetched and then never opened.
	maxCompressedBytes: MINERU_MAX_DOWNLOAD_BYTES,
};

export interface MineruResultZip {
	/** Entry name → declared uncompressed size, for the accepted entries only. */
	readonly entries: ReadonlyMap<string, number>;
	/** `images/<name>` entries, in central-directory order. */
	readonly imageNames: readonly string[];
	has(name: string): boolean;
	/** null when the entry is absent or was not accepted. */
	readText(name: string): Promise<string | null>;
	/** null when the entry is absent or was not accepted. */
	readBytes(name: string): Promise<Uint8Array | null>;
}

interface CentralDirectoryEntry {
	/** The name EXACTLY as the archive spells it, before any normalisation. */
	rawName: string;
	uncompressedSize: number;
	/** The high 16 bits of `externalFileAttributes`: the unix mode, or 0. */
	unixMode: number;
}

interface CentralDirectory {
	/** The EOCD's own entry count, which duplicate names do not collapse. */
	declaredEntries: number;
	entries: CentralDirectoryEntry[];
}

/**
 * Walks the zip's central directory directly.
 *
 * Not redundant with JSZip: `JSZip.loadAsync` runs every name through its own
 * `resolve()`, so `../../../../etc/passwd` arrives as `etc/passwd` and
 * `images/../../escape.jpg` as `escape.jpg` — the traversal is normalised away
 * before any of this code could see it. JSZip also keys `zip.files` by name,
 * so two entries called `images/a.jpg` collapse into one and a duplicate-name
 * attack becomes invisible. Reading the directory ourselves is the only way to
 * refuse either, and it also yields the declared uncompressed sizes needed to
 * fail a zip bomb before inflating a byte.
 *
 * Returns null for a zip64 archive or an unreadable directory; the caller then
 * falls back to JSZip's (already normalised, therefore already safe) view.
 */
function readCentralDirectory(bytes: Uint8Array): CentralDirectory | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	// The EOCD is at most 22 + 65535 bytes from the end.
	const earliest = Math.max(0, bytes.byteLength - (22 + 0xffff));
	let eocd = -1;
	for (let offset = bytes.byteLength - 22; offset >= earliest; offset--) {
		if (view.getUint32(offset, true) === 0x06054b50) {
			eocd = offset;
			break;
		}
	}
	if (eocd < 0) return null;

	const declaredEntries = view.getUint16(eocd + 10, true);
	// 0xffff in either field means "see the zip64 record", which this reader
	// does not implement.
	if (declaredEntries === 0xffff) return null;
	const directoryOffset = view.getUint32(eocd + 16, true);
	if (directoryOffset === 0xffffffff) return null;

	const decoder = new TextDecoder("utf-8");
	const entries: CentralDirectoryEntry[] = [];
	let cursor = directoryOffset;
	for (let index = 0; index < declaredEntries; index++) {
		if (cursor + 46 > bytes.byteLength) return null;
		if (view.getUint32(cursor, true) !== 0x02014b50) return null;
		const nameLength = view.getUint16(cursor + 28, true);
		const extraLength = view.getUint16(cursor + 30, true);
		const commentLength = view.getUint16(cursor + 32, true);
		const nameStart = cursor + 46;
		if (nameStart + nameLength > bytes.byteLength) return null;
		entries.push({
			rawName: decoder.decode(
				bytes.subarray(nameStart, nameStart + nameLength),
			),
			uncompressedSize: view.getUint32(cursor + 24, true),
			unixMode: view.getUint16(cursor + 40, true),
		});
		cursor = nameStart + nameLength + extraLength + commentLength;
	}
	return { declaredEntries, entries };
}

function rejectEntry(name: string, reason: string): never {
	throw new MineruResultError(
		"zip_entry_rejected",
		`MinerU result zip entry refused (${reason})`,
		{ entry: name, reason },
	);
}

/** True for a unix mode whose file-type nibble says "symbolic link". */
function isSymlinkMode(mode: number | null | undefined): boolean {
	return typeof mode === "number" && (mode & 0xf000) === 0xa000;
}

type JsZipInternalEntry = {
	dir?: boolean;
	unixPermissions?: number | string | null;
	_data?: { uncompressedSize?: number } | null;
};

function declaredUncompressedSize(entry: unknown): number | null {
	const data = (entry as JsZipInternalEntry)._data;
	const size = data?.uncompressedSize;
	return typeof size === "number" && Number.isFinite(size) && size >= 0
		? size
		: null;
}

/**
 * Opens a downloaded `result.zip` safely.
 *
 * Zip-slip proof by construction: nothing is ever written from the entry name.
 * The only names that survive are the four known root artifacts and
 * `images/<plain filename>`, and an absolute path, a `..` segment, a backslash
 * or a symlink entry is a hard refusal rather than a skip — a zip carrying one
 * is not a MinerU result, it is an attack.
 *
 * Entries that are merely UNRECOGNISED (a future MinerU artifact) are dropped,
 * not fatal: failing every extraction the day the server adds a fifth file
 * would be a worse outcome than ignoring it.
 */
export async function openMineruResultZip(input: {
	zipPathAbsolute?: string;
	data?: Uint8Array;
	limits?: Partial<MineruZipLimits>;
}): Promise<MineruResultZip> {
	const limits: MineruZipLimits = {
		...DEFAULT_MINERU_ZIP_LIMITS,
		...(input.limits ?? {}),
	};

	let bytes: Uint8Array;
	if (input.data) {
		bytes = input.data;
	} else if (input.zipPathAbsolute) {
		bytes = new Uint8Array(await readFile(input.zipPathAbsolute));
	} else {
		throw new MineruResultError(
			"zip_unreadable",
			"openMineruResultZip needs zipPathAbsolute or data",
		);
	}

	if (bytes.byteLength > limits.maxCompressedBytes) {
		throw new MineruResultError(
			"zip_too_large",
			`MinerU result zip is ${bytes.byteLength} bytes, over the ${limits.maxCompressedBytes} byte cap`,
			{ compressedBytes: bytes.byteLength, limit: limits.maxCompressedBytes },
		);
	}

	let zip: JSZip;
	try {
		zip = await JSZip.loadAsync(bytes);
	} catch (error) {
		throw new MineruResultError(
			"zip_unreadable",
			`MinerU result zip could not be opened: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}

	const parsedNames = Object.keys(zip.files);
	const directory = readCentralDirectory(bytes);

	// The scan runs over the RAW central-directory names when they can be read,
	// because JSZip has already normalised traversals out of its own keys.
	const scanned: { name: string; declared: number | null; unixMode: number }[] =
		directory
			? directory.entries.map((entry) => ({
					name: entry.rawName,
					declared:
						entry.uncompressedSize === 0xffffffff
							? null
							: entry.uncompressedSize,
					unixMode: entry.unixMode,
				}))
			: parsedNames.map((name) => ({
					name,
					declared: declaredUncompressedSize(zip.files[name]),
					unixMode: Number(
						(zip.files[name] as unknown as JsZipInternalEntry)
							.unixPermissions ?? 0,
					),
				}));

	if (scanned.length > limits.maxEntries) {
		throw new MineruResultError(
			"zip_too_large",
			`MinerU result zip has ${scanned.length} entries, over the ${limits.maxEntries} cap`,
			{ entryCount: scanned.length, limit: limits.maxEntries },
		);
	}

	if (directory && directory.declaredEntries !== parsedNames.length) {
		rejectEntry(
			"<central-directory>",
			`duplicate-names (${directory.declaredEntries} entries, ${parsedNames.length} distinct names)`,
		);
	}

	const accepted = new Map<string, number>();
	const imageNames: string[] = [];
	let totalDeclared = 0;

	for (const { name, declared, unixMode } of scanned) {
		if (name.startsWith("/") || /^[A-Za-z]:[\\/]/.test(name)) {
			rejectEntry(name, "absolute-path");
		}
		if (name.includes("\\")) rejectEntry(name, "backslash");
		if (name.split("/").some((segment) => segment === "..")) {
			rejectEntry(name, "parent-traversal");
		}
		if (isSymlinkMode(unixMode)) rejectEntry(name, "symlink");
		if (name.endsWith("/")) continue;

		if (declared !== null) {
			if (declared > limits.maxEntryBytes) {
				throw new MineruResultError(
					"zip_too_large",
					`MinerU result zip entry "${name}" declares ${declared} bytes, over the ${limits.maxEntryBytes} cap`,
					{ entry: name, declaredBytes: declared },
				);
			}
			totalDeclared += declared;
			if (totalDeclared > limits.maxTotalBytes) {
				throw new MineruResultError(
					"zip_too_large",
					`MinerU result zip inflates to more than ${limits.maxTotalBytes} bytes`,
					{ totalDeclaredBytes: totalDeclared },
				);
			}
		}

		if (EXPECTED_ROOT_ENTRIES.has(name)) {
			accepted.set(name, declared ?? 0);
			continue;
		}
		if (name.startsWith(MINERU_ZIP_IMAGE_PREFIX)) {
			const leaf = name.slice(MINERU_ZIP_IMAGE_PREFIX.length);
			if (!MINERU_IMAGE_NAME_PATTERN.test(leaf)) {
				rejectEntry(name, "unsafe-image-name");
			}
			accepted.set(name, declared ?? 0);
			imageNames.push(name);
		}
		// Safe but unrecognised: dropped, never read, never written.
	}

	async function readEntry(
		name: string,
		kind: "string" | "uint8array",
	): Promise<string | Uint8Array | null> {
		if (!accepted.has(name)) return null;
		const file = zip.file(name);
		if (!file) return null;
		const value = (await file.async(kind as "string")) as unknown as
			| string
			| Uint8Array;
		const size =
			typeof value === "string"
				? Buffer.byteLength(value, "utf8")
				: value.byteLength;
		if (size > limits.maxEntryBytes) {
			throw new MineruResultError(
				"zip_too_large",
				`MinerU result zip entry "${name}" inflated to ${size} bytes, over the ${limits.maxEntryBytes} cap`,
				{ entry: name, inflatedBytes: size },
			);
		}
		return value;
	}

	return {
		entries: accepted,
		imageNames,
		has: (name) => accepted.has(name),
		readText: async (name) =>
			(await readEntry(name, "string")) as string | null,
		readBytes: async (name) =>
			(await readEntry(name, "uint8array")) as Uint8Array | null,
	};
}

// ── parsing ────────────────────────────────────────────────────────────────

/** Throws `structured_content_invalid` on bad JSON or an unrecognised shape. */
export function parseStructuredContent(
	raw: string | unknown,
): StructuredContent {
	let value: unknown = raw;
	if (typeof raw === "string") {
		try {
			value = JSON.parse(raw);
		} catch (error) {
			throw new MineruResultError(
				"structured_content_invalid",
				`structured_content.json is not valid JSON: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	const parsed = structuredContentSchema.safeParse(value);
	if (!parsed.success) {
		throw new MineruResultError(
			"structured_content_invalid",
			"structured_content.json does not match the recorded MinerU 4 shape",
			{
				zodIssues: parsed.error.issues.slice(0, 3).map((issue) => ({
					path: issue.path.join("."),
					message: issue.message,
				})),
			},
		);
	}
	return parsed.data;
}

// ── rendering ──────────────────────────────────────────────────────────────

export interface MineruRenderOptions {
	/**
	 * The name the user uploaded. Used ONLY to pick the heading normalisation
	 * (DOCX reports every heading one level too deep and wraps the title in
	 * `**…**`). Never `metadata.file_suffix`, which reports the PDF suffix for
	 * a PNG.
	 */
	sourceFilename?: string | null;
	sourceMimeType?: string | null;
}

export interface PromptMarkdownRender {
	markdown: string;
	pages: readonly PageOffset[];
	blocks: readonly RenderedBlock[];
	figures: readonly RenderedFigure[];
}

function clampHeadingLevel(level: number): number {
	if (!Number.isFinite(level)) return 1;
	return Math.min(6, Math.max(1, Math.trunc(level)));
}

/** Strips one wrapping `**…**`, the form every DOCX heading arrives in. */
function stripWrappingBold(title: string): string {
	const trimmed = title.trim();
	const match = /^\*\*([\s\S]+)\*\*$/.exec(trimmed);
	if (!match) return trimmed;
	const inner = match[1];
	// Only a SINGLE wrapping pair: `**a** and **b**` must stay as it is.
	return inner.includes("**") ? trimmed : inner.trim();
}

/** `docx` (and `doc`) report Heading1 as level 2. Nothing else shifts. */
function headingLevelOffsetForFormat(formatId: string | null): number {
	return formatId === "docx" || formatId === "doc" ? -1 : 0;
}

function resolveFormatId(options?: MineruRenderOptions): string | null {
	if (!options?.sourceFilename) return null;
	return (
		resolveEntry(options.sourceFilename, options.sourceMimeType ?? null)?.id ??
		null
	);
}

function captionTexts(
	entries: ReadonlyArray<{ content?: string }> | undefined,
): string[] {
	if (!entries) return [];
	const out: string[] = [];
	for (const entry of entries) {
		const content = typeof entry?.content === "string" ? entry.content : "";
		if (content.trim()) out.push(content);
	}
	return out;
}

function readBbox(
	block: StructuredBlock,
): readonly [number, number, number, number] | null {
	const bbox = block.bbox;
	if (!Array.isArray(bbox) || bbox.length !== 4) return null;
	const [a, b, c, d] = bbox;
	return [a, b, c, d];
}

/**
 * A bundle-relative image path, or null.
 *
 * The zip copy uses `images/<name>.jpg`; the STANDALONE download inlines a
 * `data:image/jpeg;base64,…` URI instead, which cannot become a bundle file.
 * Anything that is not a plain `images/<safe name>` is refused here so the
 * figure endpoint's allow-list can be "the manifest" and nothing else.
 */
export function resolveFigurePath(source: string | undefined): string | null {
	if (!source) return null;
	if (!source.startsWith(MINERU_ZIP_IMAGE_PREFIX)) return null;
	const leaf = source.slice(MINERU_ZIP_IMAGE_PREFIX.length);
	if (!MINERU_IMAGE_NAME_PATTERN.test(leaf)) return null;
	return `${MINERU_ZIP_IMAGE_PREFIX}${leaf}`;
}

/**
 * The FAITHFUL renderer: what MinerU itself writes into `markdown.md`.
 *
 * Exists to prove the block model is complete, and is asserted against the
 * real `markdown.md` of every fixture in `result.test.ts`. It is never used in
 * production — `renderPromptMarkdown` is.
 */
export function renderMineruMarkdown(
	sc: StructuredContent,
	options?: MineruRenderOptions,
): string {
	return renderInternal(sc, options, "faithful").markdown;
}

/**
 * The PRODUCTION renderer. Its output IS the normalized artifact's
 * contentText, and the page offsets it returns are what makes page-aware
 * chunking and `[p. N]` citations possible at all.
 *
 * It differs from the faithful renderer in exactly one rule: an `image` block
 * becomes `[Figure N]` / `[Figure N: <first caption>]` instead of an
 * `![](images/…)` link, which costs fewer tokens and gives the model a handle
 * it can actually ask about.
 */
export function renderPromptMarkdown(
	sc: StructuredContent,
	options?: MineruRenderOptions,
): PromptMarkdownRender {
	return renderInternal(sc, options, "prompt");
}

interface RenderDraft {
	page: number;
	blockIndex: number;
	type: string;
	unknownType: boolean;
	atomic: boolean;
	headingLevel: number | null;
	headingTitle: string | null;
	text: string;
	figure: RenderedFigure | null;
}

function renderInternal(
	sc: StructuredContent,
	options: MineruRenderOptions | undefined,
	mode: "faithful" | "prompt",
): PromptMarkdownRender {
	const levelOffset = headingLevelOffsetForFormat(resolveFormatId(options));
	const drafts: RenderDraft[] = [];
	const figures: RenderedFigure[] = [];

	for (let pageIndex = 0; pageIndex < sc.pages.length; pageIndex++) {
		const page = sc.pages[pageIndex];
		const pageNumber = pageIndex + 1;
		const blocks = page.blocks ?? [];

		for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
			const block = blocks[blockIndex];
			const type = block.type;
			if (isRunningHeadBlockType(type)) continue;

			const content = typeof block.content === "string" ? block.content : "";
			let text: string;
			let headingLevel: number | null = null;
			let headingTitle: string | null = null;
			let figure: RenderedFigure | null = null;

			if (HEADING_TYPES.has(type)) {
				const rawLevel = clampHeadingLevel(block.level ?? 1);
				text = `${"#".repeat(rawLevel)} ${content}`;
				headingLevel = Math.min(6, Math.max(1, rawLevel + levelOffset));
				headingTitle = stripWrappingBold(content);
			} else if (type === "table") {
				text = [
					...captionTexts(block.captions),
					content,
					...captionTexts(block.footnotes),
				]
					.filter((part) => part.trim())
					.join("\n\n");
			} else if (type === "image") {
				const path = resolveFigurePath(block.image_source);
				const captions = captionTexts(block.captions);
				const footnotes = captionTexts(block.footnotes);
				if (path) {
					figure = {
						index: figures.length + 1,
						path,
						caption: captions[0] ?? null,
						page: pageNumber,
						bbox: readBbox(block),
					};
					figures.push(figure);
				}
				if (mode === "faithful") {
					const source = block.image_source;
					text = [
						...(source ? [`![](${source})`] : []),
						...captions,
						...footnotes,
					].join("\n\n");
				} else {
					// The caption is already inside the label, so it is never
					// emitted twice. A figure with no resolvable path (a data: URI
					// from a standalone download) keeps its captions and loses only
					// the handle.
					const label = figure
						? figure.caption
							? `[Figure ${figure.index}: ${figure.caption}]`
							: `[Figure ${figure.index}]`
						: null;
					text = [...(label ? [label] : captions), ...footnotes]
						.filter((part) => part.trim())
						.join("\n\n");
				}
			} else {
				text = content;
			}

			if (!text.trim()) continue;

			drafts.push({
				page: pageNumber,
				blockIndex,
				type,
				unknownType: !isKnownBlockType(type),
				atomic: isAtomicBlockType(type),
				headingLevel,
				headingTitle,
				text,
				figure,
			});
		}
	}

	const markdown = drafts.map((draft) => draft.text).join("\n\n");

	const blocks: RenderedBlock[] = [];
	let cursor = 0;
	for (let index = 0; index < drafts.length; index++) {
		const draft = drafts[index];
		const start = cursor;
		const end = start + draft.text.length;
		blocks.push({ ...draft, start, end });
		cursor = end + (index < drafts.length - 1 ? 2 : 0);
	}

	return {
		markdown,
		pages: buildPageOffsets(sc.pages.length, blocks, markdown.length),
		blocks,
		figures,
	};
}

/**
 * A contiguous partition of the normalized Markdown, one range per page.
 *
 * Each page's range starts exactly at its first surviving block and runs to
 * the start of the next page's first surviving block, so the `"\n\n"`
 * separator is charged to the earlier page and
 * `pages[i].end === pages[i+1].start` holds for every i. A page whose blocks
 * were all dropped (a PDF page of nothing but a header and a footer) gets a
 * zero-length range rather than disappearing — the index must stay aligned
 * with the page numbers.
 */
function buildPageOffsets(
	pageCount: number,
	blocks: readonly RenderedBlock[],
	markdownLength: number,
): PageOffset[] {
	const offsets: PageOffset[] = [];
	let cursor = 0;
	let blockCursor = 0;
	for (let page = 1; page <= pageCount; page++) {
		while (blockCursor < blocks.length && blocks[blockCursor].page <= page) {
			blockCursor++;
		}
		const next = blocks[blockCursor];
		const end = Math.max(cursor, next ? next.start : markdownLength);
		offsets.push({ page, start: cursor, end });
		cursor = end;
	}
	return offsets;
}

// ── outline ────────────────────────────────────────────────────────────────

const OUTLINE_PREVIEW_LENGTH = 300;
const MAX_MINERU_OUTLINE_ENTRIES = 200;

function buildOutlinePreview(markdown: string, bodyStart: number): string {
	const rest = markdown.slice(
		bodyStart,
		bodyStart + OUTLINE_PREVIEW_LENGTH * 2,
	);
	return rest.replace(/^\s+/, "").slice(0, OUTLINE_PREVIEW_LENGTH).trimEnd();
}

/**
 * The block-derived outline, with the heuristic extractor as the fallback.
 *
 * Fallback chain (§4.5): block headings when there are any, otherwise
 * `extractDocumentOutline` over the rendered Markdown — which is what covers
 * CSV (zero title blocks in the only fixture that has none) and any producer
 * that types its headings as bold body text instead of a `paragraph_title`.
 */
export function buildMineruOutline(input: {
	markdown: string;
	blocks: readonly RenderedBlock[];
	pages: readonly PageOffset[];
}): MineruOutlineEntry[] {
	const fromBlocks: MineruOutlineEntry[] = [];
	for (const block of input.blocks) {
		if (block.headingLevel === null || !block.headingTitle) continue;
		fromBlocks.push({
			level: block.headingLevel,
			title: block.headingTitle,
			offset: block.start,
			preview: buildOutlinePreview(input.markdown, block.end),
			page: block.page,
		});
		if (fromBlocks.length >= MAX_MINERU_OUTLINE_ENTRIES) break;
	}
	if (fromBlocks.length > 0) return fromBlocks;

	return extractDocumentOutline(input.markdown).map((entry) => {
		const page = pageForOffset(input.pages, entry.offset);
		return page === null ? { ...entry } : { ...entry, page };
	});
}

/** The 1-based page an offset falls on, or null when the index cannot say. */
export function pageForOffset(
	pages: readonly PageOffset[],
	offset: number,
): number | null {
	for (const page of pages) {
		if (offset >= page.start && offset < page.end) return page.page;
	}
	const last = pages[pages.length - 1];
	return last && offset >= last.start ? last.page : null;
}

// ── the whole result ───────────────────────────────────────────────────────

function normalizePageCountKind(value: string | undefined): PageCountKind {
	return isPageCountKind(value) ? value : "unknown";
}

function collectStats(sc: StructuredContent): StructuredExtractionStats {
	const unknownTypes: Record<string, number> = {};
	let blockCount = 0;
	let droppedRunningHeads = 0;
	let bboxPresent = false;
	let anchorsPresent = false;

	for (const page of sc.pages) {
		for (const block of page.blocks ?? []) {
			blockCount++;
			if (isRunningHeadBlockType(block.type)) droppedRunningHeads++;
			if (!isKnownBlockType(block.type)) {
				unknownTypes[block.type] = (unknownTypes[block.type] ?? 0) + 1;
			}
			if (Array.isArray(block.bbox) && block.bbox.length === 4) {
				bboxPresent = true;
			}
			if (typeof block.anchor === "string" && block.anchor) {
				anchorsPresent = true;
			}
		}
	}

	return {
		blockCount,
		droppedRunningHeads,
		unknownTypes,
		bboxPresent,
		anchorsPresent,
	};
}

export interface BuildStructuredExtractionResultInput {
	content: StructuredContent;
	/** The job's `tier`. Kept for diagnostics only; it lies. */
	jobTier?: string | null;
	/** `files[0].parse.parser_version`. */
	serverParserVersion?: string | null;
	/** The uploaded filename — the ONLY trustworthy format signal. */
	sourceFilename?: string | null;
	sourceMimeType?: string | null;
}

/**
 * The pure half of the pipeline: a validated `structured_content` becomes a
 * `StructuredExtractionResult`. No I/O, so every fixture test can call it
 * directly.
 */
export function buildStructuredExtractionResult(
	input: BuildStructuredExtractionResultInput,
): StructuredExtractionResult {
	const sc = input.content;
	const options: MineruRenderOptions = {
		sourceFilename: input.sourceFilename ?? null,
		sourceMimeType: input.sourceMimeType ?? null,
	};
	const rendered = renderPromptMarkdown(sc, options);

	const document = sc.metadata?.document ?? {};
	const declaredPageCount =
		typeof document.page_count === "number" &&
		Number.isFinite(document.page_count) &&
		document.page_count > 0
			? Math.min(Math.trunc(document.page_count), MAX_STRUCTURED_PAGE_COUNT)
			: null;
	// PNG/JPEG carry no `page_count` at all — `metadata.document` is `{}`.
	const pageCount = declaredPageCount ?? sc.pages.length;

	// `pages` must cover every page the index can be asked about. The declared
	// count wins for `pageCount` (the spec's rule), but a page that really
	// exists is never dropped from the offset table.
	const offsets = [...rendered.pages];
	while (offsets.length < pageCount) {
		const previousEnd = offsets[offsets.length - 1]?.end ?? 0;
		offsets.push({
			page: offsets.length + 1,
			start: previousEnd,
			end: previousEnd,
		});
	}

	return {
		parserVersion: MINERU_PARSER_VERSION,
		producerVersion: sc.metadata?.producer?.version ?? null,
		serverParserVersion: input.serverParserVersion ?? null,
		effectiveTier: sc.extensions?.mineru?.tier ?? null,
		jobTier: input.jobTier ?? null,
		parseMode: sc.extensions?.mineru?.parse_mode ?? null,
		pageCount,
		pageCountKind: normalizePageCountKind(document.page_count_kind),
		markdown: rendered.markdown,
		pages: offsets,
		blocks: rendered.blocks,
		figures: rendered.figures,
		outline: buildMineruOutline({
			markdown: rendered.markdown,
			blocks: rendered.blocks,
			pages: offsets,
		}),
		stats: collectStats(sc),
	};
}

export interface ParsedMineruResult {
	result: StructuredExtractionResult;
	/**
	 * The zip's own `structured_content.json`, verbatim. This is the copy with
	 * relative image paths, which is what goes into the bundle — the standalone
	 * download inlines images as data URIs and is ~10× larger.
	 */
	structuredContentJson: string;
	/** The zip's `markdown.md`. The test oracle; never persisted. */
	mineruMarkdown: string | null;
}

/**
 * Zip on disk → `StructuredExtractionResult`.
 *
 * Throws `structured_content_missing` when the zip has no
 * `structured_content.json` (the one assumption behind requesting all four
 * output formats, §2.6) and `empty_result` when every block was a running head
 * or empty — an extraction that produced no text is a failure, not a document.
 */
export async function parseMineruResultZip(input: {
	zipPathAbsolute: string;
	jobTier?: string | null;
	serverParserVersion?: string | null;
	sourceFilename?: string | null;
	sourceMimeType?: string | null;
	limits?: Partial<MineruZipLimits>;
}): Promise<ParsedMineruResult> {
	const zip = await openMineruResultZip({
		zipPathAbsolute: input.zipPathAbsolute,
		...(input.limits ? { limits: input.limits } : {}),
	});

	const structuredContentJson = await zip.readText(
		MINERU_ZIP_STRUCTURED_CONTENT,
	);
	if (structuredContentJson === null) {
		throw new MineruResultError(
			"structured_content_missing",
			"MinerU result zip has no structured_content.json",
			{ entries: [...zip.entries.keys()] },
		);
	}

	const content = parseStructuredContent(structuredContentJson);
	const result = buildStructuredExtractionResult({
		content,
		jobTier: input.jobTier ?? null,
		serverParserVersion: input.serverParserVersion ?? null,
		sourceFilename: input.sourceFilename ?? null,
		sourceMimeType: input.sourceMimeType ?? null,
	});

	if (!result.markdown.trim()) {
		throw new MineruResultError(
			"empty_result",
			"MinerU returned a document with no renderable text",
			{ blockCount: result.stats.blockCount },
		);
	}

	return {
		result,
		structuredContentJson,
		mineruMarkdown: await zip.readText(MINERU_ZIP_MARKDOWN),
	};
}

// ── the chunk planner ──────────────────────────────────────────────────────

export interface ChunkPlanEntry {
	chunkIndex: number;
	text: string;
	/** 1-based inclusive. */
	pageStart: number;
	/** 1-based inclusive. */
	pageEnd: number;
}

export interface PlanStructuredChunksInput {
	blocks: readonly RenderedBlock[];
	/** 1400 in `chunk-sync.ts`. */
	charTarget: number;
	/** 220 in `chunk-sync.ts`. */
	charOverlap: number;
}

/**
 * The hard ceiling on one chunk, as a multiple of `charTarget`.
 *
 * An ATOMIC block is never split by the packer — that is the rule that keeps a
 * table whole — and `standard`/`advanced` may legitimately return an UNKNOWN
 * block type, which is atomic too. Without a ceiling, one such block became one
 * chunk row of its own size: a 5 MB table is a 5 MB row that is then lexically
 * ranked, sent to the reranker, and, if it wins, injected into a prompt.
 *
 * Eight is the largest multiple that is still safely inside everything
 * downstream:
 *
 *   - `chat-turn/context-budget.ts` gives one artifact between 1 400 chars
 *     (`DOCUMENT_REFERENCE_MAX_PER_ARTIFACT_CHARS`) and 18 000
 *     (`DOCUMENT_EXCERPT_MAX_PER_ARTIFACT_CHARS`) in the normal excerpt mode.
 *     8 × 1 400 = 11 200 fits inside the excerpt ceiling, so a maximal chunk is
 *     still a chunk the prompt can carry rather than one it can only truncate.
 *   - the embedding clip is 32 768 tokens × 4 chars
 *     (`semantic-embedding-refresh.ts`), so a maximal chunk is embedded whole
 *     rather than silently losing its tail.
 *
 * Smaller would start cutting real tables that fit today; larger would let one
 * row eat a whole artifact's budget.
 */
export const CHUNK_HARD_LIMIT_MULTIPLE = 8;

/** A GFM delimiter row: `| --- | :--: |`. Only pipes, dashes, colons, spaces. */
function isTableDelimiterLine(line: string): boolean {
	const trimmed = line.trim();
	return (
		trimmed.includes("|") && trimmed.includes("-") && /^[|\s:-]+$/.test(trimmed)
	);
}

/**
 * The header row + delimiter row a split table must repeat, and the index just
 * past them. `null` when the text is not a GFM table.
 *
 * Searched rather than assumed at line 0: a `table` block is rendered as its
 * captions, then the table, then its footnotes, so the header is usually a few
 * lines in.
 */
function tableHeaderLines(
	lines: readonly string[],
): { header: string[]; bodyStart: number } | null {
	for (let index = 1; index < lines.length; index++) {
		if (!isTableDelimiterLine(lines[index])) continue;
		if (!lines[index - 1].trim().startsWith("|")) continue;
		return { header: [lines[index - 1], lines[index]], bodyStart: index + 1 };
	}
	return null;
}

/**
 * One over-long block's text as a list of fragments, none longer than `limit`.
 *
 * Split on LINE boundaries, so a Markdown table breaks between rows and a
 * paragraph breaks between its lines; a single line that alone exceeds the
 * limit is the only case that is cut mid-line, because there is nothing else
 * to cut. For a GFM table the header row and the delimiter row are repeated at
 * the top of every continuation fragment, so each fragment is a table a model
 * can read rather than a run of anonymous cells.
 */
function splitOversizeText(text: string, limit: number): string[] {
	const lines = text.split("\n");
	const table = tableHeaderLines(lines);
	const header = table ? table.header : [];
	const headerLength = header.length
		? header.join("\n").length + 1 // + the newline before the first body line
		: 0;

	const fragments: string[] = [];
	let current: string[] = [];
	let currentLength = 0;
	let isContinuation = false;

	const budget = () => limit - (isContinuation ? headerLength : 0);
	const flush = () => {
		if (current.length === 0) return;
		const body = current.join("\n");
		fragments.push(isContinuation ? [...header, body].join("\n") : body);
		current = [];
		currentLength = 0;
		isContinuation = true;
	};

	for (const line of lines) {
		// A line that cannot fit even on its own: hard-split it. Whatever is
		// already open is flushed first so the pieces stay in order.
		if (line.length > budget()) {
			flush();
			for (let start = 0; start < line.length; start += budget()) {
				fragments.push(
					isContinuation
						? [...header, line.slice(start, start + budget())].join("\n")
						: line.slice(start, start + budget()),
				);
				isContinuation = true;
			}
			continue;
		}
		const projected =
			currentLength + (current.length > 0 ? 1 : 0) + line.length;
		if (current.length > 0 && projected > budget()) flush();
		currentLength += (current.length > 0 ? 1 : 0) + line.length;
		current.push(line);
	}
	flush();
	return fragments.filter((fragment) => fragment.length > 0);
}

/**
 * The blocks the packer actually sees: every block longer than `limit` replaced
 * by its fragments.
 *
 * A fragment is ATOMIC whatever its source was. Two reasons: the packer must
 * not then re-split it, and overlap must not be carried between two halves of
 * one block, which would duplicate the very text the split exists to bound.
 * Only the first fragment keeps the heading fields, so a continuation can never
 * be mistaken for a bare heading. Page attribution is the block's, unchanged —
 * a fragment is part of the same block and sits on the same page.
 *
 * `start`/`end` stay the WHOLE block's span on every fragment: the planner does
 * not read them, and a fragment has no honest span of its own once a table
 * header is repeated into it.
 */
function splitOversizeBlocks(
	blocks: readonly RenderedBlock[],
	limit: number,
): RenderedBlock[] {
	const out: RenderedBlock[] = [];
	for (const block of blocks) {
		if (block.text.length <= limit) {
			out.push(block);
			continue;
		}
		const fragments = splitOversizeText(block.text, limit);
		for (let index = 0; index < fragments.length; index++) {
			out.push({
				...block,
				text: fragments[index],
				atomic: true,
				headingLevel: index === 0 ? block.headingLevel : null,
				headingTitle: index === 0 ? block.headingTitle : null,
				figure: index === 0 ? block.figure : null,
			});
		}
	}
	return out;
}

interface OpenChunk {
	blocks: RenderedBlock[];
	/** The trailing text carried over from the previous chunk, or null. */
	overlap: string | null;
	/** The block the overlap came from, for the page range. */
	overlapSource: RenderedBlock | null;
}

function openChunkParts(chunk: OpenChunk): string[] {
	const parts = chunk.overlap ? [chunk.overlap] : [];
	for (const block of chunk.blocks) parts.push(block.text);
	return parts;
}

function openChunkLength(chunk: OpenChunk): number {
	const parts = openChunkParts(chunk);
	if (parts.length === 0) return 0;
	let length = 2 * (parts.length - 1);
	for (const part of parts) length += part.length;
	return length;
}

function openChunkText(chunk: OpenChunk): string {
	return openChunkParts(chunk).join("\n\n").trim();
}

/** The joined length of a run of blocks, separators included. */
function carriedLength(blocks: readonly RenderedBlock[]): number {
	if (blocks.length === 0) return 0;
	let length = 2 * (blocks.length - 1);
	for (const block of blocks) length += block.text.length;
	return length;
}

/**
 * The last `charOverlap` characters of a chunk, trimmed forward to the nearest
 * line start so the carried text never begins mid-sentence.
 */
function overlapTail(text: string, charOverlap: number): string {
	if (charOverlap <= 0) return "";
	let tail = text.slice(Math.max(0, text.length - charOverlap));
	const newline = tail.indexOf("\n");
	if (newline >= 0) tail = tail.slice(newline + 1);
	return tail.trim();
}

/**
 * Structure-aware packing: blocks are the atoms, a chunk is a run of blocks.
 *
 * Pure and side-effect free — `chunk-sync.ts` (P4-C) is what turns the plan
 * into rows. The four rules that matter:
 *
 *   - an ATOMIC block is never split, even when it alone exceeds the target,
 *     and `atomic` is true for every UNKNOWN type as well as for tables and
 *     images (§1.5), so a `standard`-tier equation is under-chunked rather
 *     than mangled;
 *   - overlap is applied only where neither side of the boundary is atomic, so
 *     a table is never half-duplicated into the next chunk;
 *   - a chunk never ends on a bare heading — the heading travels forward to
 *     the block it introduces;
 *   - `pageStart`/`pageEnd` span every block in the chunk INCLUDING the block
 *     the overlap text came from.
 *
 * And one ceiling on top of them: no chunk exceeds
 * `charTarget * CHUNK_HARD_LIMIT_MULTIPLE`. "Never split an atomic block" is
 * the right rule for a table that is a page long and the wrong one for a table
 * that is five megabytes long, so an over-long block is split on line
 * boundaries FIRST and the four rules then apply to its fragments.
 */
export function planStructuredChunks(
	input: PlanStructuredChunksInput,
): ChunkPlanEntry[] {
	const charTarget = Math.max(1, Math.trunc(input.charTarget));
	const charOverlap = Math.max(0, Math.trunc(input.charOverlap));
	const hardLimit = charTarget * CHUNK_HARD_LIMIT_MULTIPLE;
	const blocks = splitOversizeBlocks(
		input.blocks.filter((block) => block.text.trim().length > 0),
		hardLimit,
	);
	if (blocks.length === 0) return [];

	const plan: ChunkPlanEntry[] = [];
	let current: OpenChunk = { blocks: [], overlap: null, overlapSource: null };

	function emit(chunk: OpenChunk): void {
		const text = openChunkText(chunk);
		if (!text) return;
		const pageSources = [...chunk.blocks];
		if (chunk.overlapSource) pageSources.push(chunk.overlapSource);
		const pages = pageSources.map((block) => block.page);
		plan.push({
			chunkIndex: plan.length,
			text,
			pageStart: Math.min(...pages),
			pageEnd: Math.max(...pages),
		});
	}

	for (const block of blocks) {
		if (current.blocks.length === 0) {
			current.blocks.push(block);
			continue;
		}

		const projected = openChunkLength(current) + 2 + block.text.length;
		if (projected <= charTarget) {
			current.blocks.push(block);
			continue;
		}

		// Rule 4: never close on a bare heading. Carry the trailing headings
		// forward to the block they introduce.
		const carried: RenderedBlock[] = [];
		while (
			current.blocks.length > 1 &&
			current.blocks[current.blocks.length - 1].headingLevel !== null
		) {
			carried.unshift(current.blocks.pop() as RenderedBlock);
		}
		// The ceiling outranks rule 4. Carrying headings onto a block that is
		// already at the limit would be the one chunk that escapes it, so in
		// that case the headings stay where they are and the previous chunk
		// closes on them — ugly, and still bounded.
		while (
			carried.length > 0 &&
			carriedLength(carried) + 2 + block.text.length > hardLimit
		) {
			current.blocks.push(carried.shift() as RenderedBlock);
		}
		if (
			carried.length === 0 &&
			current.blocks.length === 1 &&
			current.blocks[0].headingLevel !== null &&
			// …but not past the ceiling. `block` is at most `hardLimit` after the
			// split above, so a heading plus a maximal block would otherwise be
			// the one chunk that escapes it.
			projected <= hardLimit
		) {
			// A lone heading would otherwise become a chunk of its own. Take the
			// overflow instead: one heading plus one block is bounded.
			current.blocks.push(block);
			continue;
		}

		const previousLast = current.blocks[current.blocks.length - 1];
		emit(current);

		// No overlap across an atomic boundary (rule 3), and none when a
		// heading was carried forward: the heading IS the context bridge, and
		// prefixing it with a tail of the previous paragraph buries it.
		//
		// The tail comes from `previousLast.text` and NOT from the whole closed
		// chunk. Taking it from the chunk only checked atomicity at the
		// boundary, so a SHORT last block — a caption, a one-line paragraph —
		// let the 220-character tail reach back across the separator into
		// whatever preceded it. When that was a table, the next chunk opened
		// with header-less table rows: the split-table fragment this whole
		// design exists to prevent, with a page range that claimed the short
		// block's page for text from the table's. Bounding the tail by the
		// block it is attributed to makes `overlapSource` honest by
		// construction.
		const boundaryIsAtomic = previousLast.atomic || block.atomic;
		const overlap =
			!boundaryIsAtomic && carried.length === 0 && charOverlap > 0
				? overlapTail(previousLast.text, charOverlap)
				: "";

		current = {
			blocks: [...carried, block],
			overlap: overlap || null,
			overlapSource: overlap ? previousLast : null,
		};
	}

	emit(current);
	return plan;
}
