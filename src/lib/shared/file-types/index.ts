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
 * Per-surface extension order for the `accept` attribute. Frozen for
 * `knowledge` so `getAcceptAttribute("knowledge")` reproduces
 * `DocumentsList.svelte:190`'s literal byte for byte; new knowledge types
 * append at the end. `null` means "table order".
 */
export const SURFACE_ACCEPT_ORDER: Readonly<
	Record<UploadSurface, readonly string[] | null>
> = {
	knowledge: [
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
	],
	chat: null,
};

/**
 * Extensions of a `knowledge` entry that the frozen accept string deliberately
 * omits. `.md` is offered but `.markdown` is not; adding it is a visible
 * product change, deferred by spec open question 3. `registry.test.ts` asserts
 * this is the ONLY gap, so a new knowledge entry still forces an explicit edit
 * to `SURFACE_ACCEPT_ORDER`.
 */
export const KNOWLEDGE_ACCEPT_OMISSIONS: ReadonlySet<string> = new Set([
	"markdown",
]);

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

// ── server allowlist (pure, so the client may pre-check identically) ────────

export type UploadAdmission =
	| { readonly allowed: true; readonly entry: FileTypeEntry }
	| {
			readonly allowed: false;
			readonly reason: RejectReasonKey;
			readonly entry: FileTypeEntry | null;
	  };

/**
 * The single upload decision. Surface-independent on purpose: a per-surface
 * server gate would let a caller widen it by lying (spec open question 10).
 */
export function admitUpload(
	filename: string,
	mimeType: string | null,
): UploadAdmission {
	const entry = resolveEntry(filename, mimeType);
	if (!entry) return { allowed: false, reason: "unknownType", entry: null };
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
 * Unknown types answer "mineru", which is where they fall through today
 * (`document-extraction.ts` posts anything it cannot read directly). The intent
 * endpoint refuses them first, so in practice this arm is unreachable.
 */
export function getIntakeRoute(
	filename: string,
	mimeType: string | null,
): IntakeRoute {
	return resolveEntry(filename, mimeType)?.intake.route ?? "mineru";
}

export function getIntakeTierHint(
	filename: string,
	mimeType: string | null,
): "flash" | undefined {
	return resolveEntry(filename, mimeType)?.intake.tierHint;
}

// ── limits ─────────────────────────────────────────────────────────────────

/**
 * 104857600 — the client-side fallback until the intent response or the SSR
 * shell payload lands. Mirrors MAX_FILE_UPLOAD_SIZE's default in
 * `src/lib/server/env.ts`; `$lib/server/*` is server-only, so it cannot be
 * imported here.
 */
export const DEFAULT_MAX_FILE_UPLOAD_SIZE_BYTES = 104857600;
