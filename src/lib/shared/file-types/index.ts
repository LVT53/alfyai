// Client-safe accessors over the file-type table.
//
// This module imports ONLY `./table` and `./types`, so any client chunk that
// touches a file pays for the table plus the small lookup maps below and
// nothing else. Production token maps live in `./production` and the
// model-facing prose in `./model-facing`; neither is reachable from here.

import { FILE_TYPE_ENTRIES } from "./table";
import type {
	FileTypeCategory,
	FileTypeEntry,
	IntakeRoute,
	PreviewKind,
	RejectReasonKey,
	UploadSurface,
} from "./types";

export { FILE_TYPE_ENTRIES } from "./table";
export type {
	FileTypeCategory,
	FileTypeEntry,
	IntakeRoute,
	PreviewKind,
	RejectReasonKey,
	UploadSurface,
};

// ── normalisation ──────────────────────────────────────────────────────────

/**
 * "REPORT.Final.PDF" -> "pdf"; "" when the name carries no dot.
 *
 * Byte-for-byte the behaviour of `attachment-file-type.ts:76`, which the spec
 * (open question 13) names as the one true parser. Note `.env` -> "env":
 * `".env".split(".")` has length 2, so the guard does not fire. `extname(".env")`
 * returns "" instead, which is why the `extname`-based copies in `chat-files.ts`
 * and `conversation-forks.ts` disagree with this one on dotfiles.
 */
export function fileExtension(filename: string): string {
	const parts = filename.split(".");
	if (parts.length < 2) return "";
	return (parts.pop() ?? "").toLowerCase().trim();
}

/** "text/HTML; charset=utf-8" -> "text/html"; null when empty. */
export function normalizeMimeType(
	mimeType: string | null | undefined,
): string | null {
	const normalized = mimeType?.split(";")[0]?.trim().toLowerCase() ?? "";
	return normalized || null;
}

/** {"application/octet-stream", "application/download"} plus empty. */
export const GENERIC_MIME_TYPES: ReadonlySet<string> = new Set([
	"application/octet-stream",
	"application/download",
]);

export function isGenericMimeType(
	mimeType: string | null | undefined,
): boolean {
	const normalized = normalizeMimeType(mimeType);
	return !normalized || GENERIC_MIME_TYPES.has(normalized);
}

// ── lookup indexes ─────────────────────────────────────────────────────────

const ENTRY_BY_EXTENSION = new Map<string, FileTypeEntry>();
/** mimeTypes[0] of each entry. `ownsCanonicalMime` breaks a tie regardless of table order. */
const ENTRY_BY_CANONICAL_MIME = new Map<string, FileTypeEntry>();
/** mimeTypes[1..]. Consulted only after the canonical index misses. First entry wins. */
const ENTRY_BY_ALIAS_MIME = new Map<string, FileTypeEntry>();

for (const entry of FILE_TYPE_ENTRIES) {
	for (const extension of entry.extensions) {
		ENTRY_BY_EXTENSION.set(extension, entry);
	}
	const canonical = entry.mimeTypes[0];
	if (!ENTRY_BY_CANONICAL_MIME.has(canonical) || entry.ownsCanonicalMime) {
		ENTRY_BY_CANONICAL_MIME.set(canonical, entry);
	}
}
for (const entry of FILE_TYPE_ENTRIES) {
	for (const alias of entry.mimeTypes.slice(1)) {
		if (ENTRY_BY_CANONICAL_MIME.has(alias)) continue;
		if (ENTRY_BY_ALIAS_MIME.has(alias)) continue;
		ENTRY_BY_ALIAS_MIME.set(alias, entry);
	}
}

export function getEntryByExtension(extension: string): FileTypeEntry | null {
	const normalized = extension.trim().toLowerCase().replace(/^\./, "");
	if (!normalized) return null;
	return ENTRY_BY_EXTENSION.get(normalized) ?? null;
}

export function getEntryByFilename(filename: string): FileTypeEntry | null {
	return getEntryByExtension(fileExtension(filename));
}

/** Canonical MIME first, then alias MIMEs; respects `ownsCanonicalMime`. */
export function getEntryByMimeType(
	mimeType: string | null | undefined,
): FileTypeEntry | null {
	const normalized = normalizeMimeType(mimeType);
	if (!normalized) return null;
	// `application/octet-stream` is an accepted ALIAS of `zip`
	// (output-validation.ts:75-79). It must never resolve an unknown file to a
	// zip, so generic MIMEs never reverse-resolve.
	if (GENERIC_MIME_TYPES.has(normalized)) return null;
	return (
		ENTRY_BY_CANONICAL_MIME.get(normalized) ??
		ENTRY_BY_ALIAS_MIME.get(normalized) ??
		null
	);
}

/** Extension wins; MIME is the fallback. The lookup order every call site should use. */
export function resolveEntry(
	filename: string,
	mimeType: string | null | undefined,
): FileTypeEntry | null {
	return getEntryByFilename(filename) ?? getEntryByMimeType(mimeType);
}

// ── MIME ───────────────────────────────────────────────────────────────────

/** null when the extension is unknown. */
export function getCanonicalMimeForExtension(extension: string): string | null {
	return getEntryByExtension(extension)?.mimeTypes[0] ?? null;
}

/** All MIMEs (canonical + aliases) a file with this extension may legitimately declare. */
export function getAcceptedMimeTypesForExtension(
	extension: string,
): readonly string[] {
	return getEntryByExtension(extension)?.mimeTypes ?? [];
}

/**
 * Replaces file-preview `getPreviewContentType`. Declared non-generic MIME
 * wins; else the extension's canonical MIME; else "application/octet-stream".
 */
export function getContentTypeForFile(
	filename: string,
	mimeType: string | null,
): string {
	const normalized = normalizeMimeType(mimeType);
	if (normalized && !isGenericMimeType(normalized)) return normalized;
	return (
		getCanonicalMimeForExtension(fileExtension(filename)) ??
		"application/octet-stream"
	);
}

// ── preview ────────────────────────────────────────────────────────────────

/**
 * Every MIME that belongs to an entry previewed as text. Replaces
 * `PREVIEWABLE_TEXT_MIME_TYPES`; it is a superset, and every extra member
 * starts with "text/" (so it was already matched by the prefix rule) apart
 * from `application/x-yaml`, which is carried for `read-generated-file.ts`.
 */
const PREVIEWABLE_TEXT_MIME_TYPES: ReadonlySet<string> = new Set(
	FILE_TYPE_ENTRIES.filter((entry) => entry.preview.kind === "text").flatMap(
		(entry) => [...entry.mimeTypes],
	),
);

/**
 * The unknown-extension fallback chain, kept from
 * `file-preview.MIME_TO_PREVIEW_TYPE` and rebuilt against the registry. It
 * still uses `includes(...)` on the OOXML tokens on purpose: deleting the
 * heuristics would regress a file uploaded with a vendor MIME and no
 * extension (spec conflict 9).
 */
const PREVIEW_MIME_FALLBACKS: ReadonlyArray<{
	readonly kind: PreviewKind;
	readonly test: (mime: string) => boolean;
}> = [
	{ kind: "pdf", test: (mime) => mime.includes("pdf") },
	{ kind: "docx", test: (mime) => mime.includes("wordprocessingml") },
	{ kind: "xlsx", test: (mime) => mime.includes("spreadsheetml") },
	{ kind: "pptx", test: (mime) => mime.includes("presentationml") },
	{
		kind: "odt",
		test: (mime) => mime === getCanonicalMimeForExtension("odt"),
	},
	{ kind: "image", test: (mime) => mime.startsWith("image/") },
	{
		kind: "html",
		test: (mime) => mime === getCanonicalMimeForExtension("html"),
	},
	{
		kind: "text",
		test: (mime) =>
			mime.startsWith("text/") || PREVIEWABLE_TEXT_MIME_TYPES.has(mime),
	},
];

export function getPreviewKind(
	filename: string,
	mimeType: string | null,
): PreviewKind {
	const entry = getEntryByFilename(filename);
	const previewsAsText = entry?.preview.kind === "text";

	// The extension is authoritative for the trusted set (pdf/office/html and
	// every image), exactly as `getTrustedPreviewTypeFromExtension` was.
	if (entry?.preview.extensionAuthoritative) return entry.preview.kind;

	const mime = normalizeMimeType(mimeType);
	if (!mime) return previewsAsText ? "text" : "unsupported";

	for (const rule of PREVIEW_MIME_FALLBACKS) {
		if (rule.test(mime)) return rule.kind;
	}

	return previewsAsText ? "text" : "unsupported";
}

export function getPreviewLanguage(
	filename: string,
	mimeType: string | null,
): string | undefined {
	const byExtension = getEntryByFilename(filename);
	if (byExtension?.preview.language) return byExtension.preview.language;
	return getEntryByMimeType(mimeType)?.preview.language;
}

export function isPreviewable(
	filename: string,
	mimeType: string | null,
): boolean {
	return getPreviewKind(filename, mimeType) !== "unsupported";
}

// ── glyphs ─────────────────────────────────────────────────────────────────

/**
 * The unknown-extension fallback chain shared by `attachment-file-type.getFileType`
 * and `DocumentsList.getFileIcon`. Order is load-bearing: the OOXML tokens are
 * matched whole and BEFORE the generic `includes("xml")` sniffing, which is the
 * bug attachment-file-type.ts's header comment documents.
 */
const CATEGORY_MIME_FALLBACKS: ReadonlyArray<{
	readonly category: FileTypeCategory;
	readonly test: (mime: string) => boolean;
}> = [
	{ category: "image", test: (mime) => mime.startsWith("image/") },
	{
		category: "pdf",
		test: (mime) => mime === getCanonicalMimeForExtension("pdf"),
	},
	{
		category: "document",
		test: (mime) =>
			mime.includes("wordprocessingml") || mime.includes("msword"),
	},
	{
		category: "spreadsheet",
		test: (mime) =>
			mime.includes("spreadsheetml") ||
			mime.includes("spreadsheet") ||
			mime.includes("excel") ||
			mime.includes("csv"),
	},
	{
		category: "presentation",
		test: (mime) =>
			mime.includes("presentationml") || mime.includes("presentation"),
	},
	{
		category: "code",
		test: (mime) =>
			mime.includes("code") ||
			mime.includes("javascript") ||
			mime.includes("typescript") ||
			mime.includes("json") ||
			mime.includes("xml") ||
			mime.includes("html") ||
			mime.includes("css"),
	},
	{
		category: "archive",
		test: (mime) =>
			mime.includes("zip") ||
			mime.includes("compressed") ||
			mime.includes("archive"),
	},
	{
		category: "text",
		test: (mime) => mime.startsWith("text/") || mime.includes("document"),
	},
];

export function getCategory(
	filename: string,
	mimeType: string | null,
): FileTypeCategory {
	const entry = getEntryByFilename(filename) ?? getEntryByMimeType(mimeType);
	if (entry) return entry.category;

	const mime = normalizeMimeType(mimeType);
	if (!mime) return "other";
	for (const rule of CATEGORY_MIME_FALLBACKS) {
		if (rule.test(mime)) return rule.category;
	}
	return "other";
}

// ── upload surfaces ────────────────────────────────────────────────────────

/**
 * Per-surface extension order for the `accept` attribute. `null` means "table
 * order".
 *
 * `knowledge` keeps its frozen 26-extension head, so the string
 * `DocumentsList.svelte:190` published before the registry existed is still a
 * readable PREFIX of what we publish now (`legacy-equivalence.test.ts` asserts
 * exactly that). Phase 5 D5 / OQ4 then appends every other non-reject
 * extension, in one deliberate block: the two surfaces now offer the same SET
 * and differ only in order (knowledge = frozen-then-appended, chat = table
 * order). New types append at the end.
 */
export const SURFACE_ACCEPT_ORDER: Readonly<
	Record<UploadSurface, readonly string[] | null>
> = {
	knowledge: [
		// — the frozen head, unchanged and unreordered —
		"pdf",
		"doc",
		"docx",
		"txt",
		"md",
		"json",
		"csv",
		"xlsx",
		"xls",
		"pptx",
		"ppt",
		"html",
		"htm",
		"jpg",
		"jpeg",
		"jfif",
		"png",
		"gif",
		"bmp",
		"tiff",
		"tif",
		"webp",
		"svg",
		"heic",
		"heif",
		"avif",
		// — Phase 5 D5: the alias the head omitted —
		"markdown",
		// — Phase 5 D1/D2: the newly ingestible document and data formats —
		"odt",
		"rtf",
		"ods",
		"odp",
		"epub",
		"tsv",
		// — Phase 5 OQ4: the code and config formats chat already offered —
		"xml",
		"css",
		"scss",
		"sass",
		"less",
		"js",
		"mjs",
		"cjs",
		"jsx",
		"ts",
		"tsx",
		"py",
		"sh",
		"bash",
		"zsh",
		"yaml",
		"yml",
		"toml",
		"sql",
		"graphql",
		"gql",
		"ini",
		"env",
		"conf",
		"log",
		"rb",
		"rs",
		"go",
		"java",
		"kt",
		"kts",
		"swift",
		"cs",
		"cpp",
		"cxx",
		"cc",
		"hpp",
		"c",
		"h",
		"php",
		"r",
	],
	chat: null,
};

/**
 * Extensions of a `knowledge` entry that the accept string deliberately omits.
 *
 * EMPTY since Phase 5 D5: `.markdown` was the single documented gap and is now
 * offered. The export stays (and stays frozen-empty) because `registry.test.ts`
 * asserts `SURFACE_ACCEPT_ORDER.knowledge` has no OTHER gap, so a new knowledge
 * entry still forces an explicit edit to the order above — and the next
 * deliberate omission has a home to be declared in.
 */
export const KNOWLEDGE_ACCEPT_OMISSIONS: ReadonlySet<string> = new Set<string>(
	[],
);

const acceptedExtensionsCache = new Map<UploadSurface, readonly string[]>();
const acceptAttributeCache = new Map<UploadSurface, string>();

export function getAcceptedExtensions(
	surface: UploadSurface,
): readonly string[] {
	const cached = acceptedExtensionsCache.get(surface);
	if (cached) return cached;

	const explicitOrder = SURFACE_ACCEPT_ORDER[surface];
	const extensions =
		explicitOrder ??
		FILE_TYPE_ENTRIES.filter((entry) =>
			entry.surfaces.includes(surface),
		).flatMap((entry) => [...entry.extensions]);

	acceptedExtensionsCache.set(surface, extensions);
	return extensions;
}

/** e.g. ".pdf,.doc,.docx,..." — exactly what an <input accept> wants. Memoised per surface. */
export function getAcceptAttribute(surface: UploadSurface): string {
	const cached = acceptAttributeCache.get(surface);
	if (cached !== undefined) return cached;

	const attribute = getAcceptedExtensions(surface)
		.map((extension) => `.${extension}`)
		.join(",");
	acceptAttributeCache.set(surface, attribute);
	return attribute;
}

/**
 * `getAcceptAttribute` minus a set of disabled entry ids — every extension of a
 * disabled entry is dropped, order otherwise untouched.
 *
 * Pure and deliberately NOT memoised: the disabled set is a function of backend
 * health (`getMineru4GatedFileTypeIds` on a pre-4.x probe), which changes at
 * runtime, so it cannot be an option on the memoised accessor without making
 * that cache wrong. An empty or absent set is the memoised fast path.
 */
export function buildAcceptAttribute(
	surface: UploadSurface,
	disabledEntryIds?: ReadonlySet<string>,
): string {
	if (!disabledEntryIds || disabledEntryIds.size === 0) {
		return getAcceptAttribute(surface);
	}

	const disabledExtensions = new Set(
		FILE_TYPE_ENTRIES.filter((entry) => disabledEntryIds.has(entry.id)).flatMap(
			(entry) => [...entry.extensions],
		),
	);
	return getAcceptedExtensions(surface)
		.filter((extension) => !disabledExtensions.has(extension))
		.map((extension) => `.${extension}`)
		.join(",");
}

// ── server allowlist (pure, so the client may pre-check identically) ────────

/**
 * The four non-`text/*` MIMEs `document-extraction.isDirectTextExtractionFile`
 * read directly on `dev`. Each already has a table entry, so they are here only
 * so the fallback below states the whole of the old rule in one place.
 */
const DIRECT_TEXT_FALLBACK_MIME_TYPES: ReadonlySet<string> = new Set([
	"application/json",
	"application/xml",
	"application/yaml",
	"application/typescript",
]);

/**
 * True for a declared MIME that `dev` treated as readable text REGARDLESS of
 * the file's extension (`document-extraction.ts` on `dev`: `startsWith("text/")`
 * or one of the four application types above).
 *
 * The table cannot enumerate every text extension in the world — `.diff`,
 * `.patch`, `.rst`, `.tex`, `.srt`, `.vtt`, `.properties` and friends have no
 * entry — and on `dev` every one of them was read directly whenever the browser
 * declared a `text/*` MIME. Without this fallback the new allowlist refuses
 * them as `unknownType` and extraction would post them to MinerU, which is a
 * regression on both counts.
 *
 * A generic or absent MIME is deliberately NOT text: an unknown extension with
 * `application/octet-stream` went to MinerU on `dev` and still does.
 */
export function isDirectTextFallbackMimeType(
	mimeType: string | null | undefined,
): boolean {
	const normalized = normalizeMimeType(mimeType);
	if (!normalized) return false;
	return (
		normalized.startsWith("text/") ||
		DIRECT_TEXT_FALLBACK_MIME_TYPES.has(normalized)
	);
}

export type UploadAdmission =
	| { readonly allowed: true; readonly entry: FileTypeEntry | null }
	| {
			readonly allowed: false;
			readonly reason: RejectReasonKey;
			readonly entry: FileTypeEntry | null;
	  };

/**
 * The single upload decision. Surface-independent on purpose: a per-surface
 * server gate would let a caller widen it by lying (spec open question 10).
 *
 * `entry` is `null` on the allowed branch only for the text/* fallback above —
 * a file with no table entry that is still readable as text.
 */
export function admitUpload(
	filename: string,
	mimeType: string | null,
): UploadAdmission {
	const entry = resolveEntry(filename, mimeType);
	if (!entry) {
		// The extension is unknown AND the MIME resolved to nothing. It is still
		// admitted when the MIME says "text", which is what `dev` did.
		if (isDirectTextFallbackMimeType(mimeType)) {
			return { allowed: true, entry: null };
		}
		return { allowed: false, reason: "unknownType", entry: null };
	}
	if (entry.intake.route === "reject") {
		return {
			allowed: false,
			// The table invariant (`registry.test.ts`) guarantees a reject entry
			// carries a reason.
			reason: entry.intake.rejectReason ?? "unknownType",
			entry,
		};
	}
	return { allowed: true, entry };
}

// ── intake ─────────────────────────────────────────────────────────────────

/**
 * An unknown type whose declared MIME says "text" is read directly — the same
 * answer `dev`'s `isDirectTextExtractionFile` gave it, and the same answer
 * `admitUpload` gives the upload gate, so the two can never disagree. Anything
 * else unknown answers "mineru", which is where it fell through before.
 */
export function getIntakeRoute(
	filename: string,
	mimeType: string | null,
): IntakeRoute {
	const entry = resolveEntry(filename, mimeType);
	if (entry) return entry.intake.route;
	return isDirectTextFallbackMimeType(mimeType) ? "direct-text" : "mineru";
}

export function getIntakeTierHint(
	filename: string,
	mimeType: string | null,
): "flash" | undefined {
	return resolveEntry(filename, mimeType)?.intake.tierHint;
}

// ── MinerU 4.x gating (phase5-6 spec D6 + the amended OQ2) ─────────────────
//
// The registry only LABELS entries. The probe (`/v1/health`, major >= 4), the
// cache, the fail-open policy and the 415 all live server-side in
// `knowledge/format-availability.ts`; nothing here knows what backend is
// running, which is why every accessor below is a pure function of the table.

/** `intake.requiresMineru4`, split on whether the entry declares a fallback. */
function mineru4Ids(hasFallback: boolean): readonly string[] {
	return FILE_TYPE_ENTRIES.filter(
		(entry) =>
			entry.intake.requiresMineru4 === true &&
			(entry.intake.fallbackRoute !== undefined) === hasFallback,
	)
		.map((entry) => entry.id)
		.sort();
}

// Memoised by construction: the table is a module-level constant.
const MINERU4_GATED_IDS = mineru4Ids(false);
const MINERU4_FALLBACK_IDS = mineru4Ids(true);

/**
 * Entry ids to REFUSE (and to hide from both accept strings) when the backend
 * has positively probed as pre-4.x: `["epub","odp","ods","odt","rtf"]`.
 *
 * These are the formats that never worked before this migration, so refusing
 * them costs a user nothing they had. Feed the set to `buildAcceptAttribute`
 * for the picker and compare `admission.entry.id` against it at intent.
 *
 * NOT every entry carrying `requiresMineru4`: `html` carries the flag too but
 * declares a `fallbackRoute`, so it degrades instead of disappearing.
 */
export function getMineru4GatedFileTypeIds(): readonly string[] {
	return MINERU4_GATED_IDS;
}

/**
 * Entry ids that stay OFFERED on a pre-4.x backend but change route:
 * `["html"]`. Sorted, memoised. The route to use is `intake.fallbackRoute`,
 * or `getIntakeFallbackRoute` for a filename.
 */
export function getMineru4FallbackFileTypeIds(): readonly string[] {
	return MINERU4_FALLBACK_IDS;
}

/**
 * The route to use for this file INSTEAD of `getIntakeRoute`'s answer when the
 * backend has positively probed as pre-4.x. `null` means "no fallback" — either
 * the entry is not gated at all (use `getIntakeRoute`) or it is one of the
 * gated ids above (refuse it).
 *
 * Callers must not apply this on an unknown or unreachable backend: the gate
 * fails OPEN (OQ9), so only a positive pre-4 answer may downgrade a route.
 */
export function getIntakeFallbackRoute(
	filename: string,
	mimeType: string | null,
): IntakeRoute | null {
	return resolveEntry(filename, mimeType)?.intake.fallbackRoute ?? null;
}

// ── limits ─────────────────────────────────────────────────────────────────

/**
 * 104857600 — the client-side fallback until the intent response or the SSR
 * shell payload lands. Mirrors MAX_FILE_UPLOAD_SIZE's default in
 * `src/lib/server/env.ts`; `$lib/server/*` is server-only, so it cannot be
 * imported here.
 */
export const DEFAULT_MAX_FILE_UPLOAD_SIZE_BYTES = 104857600;
