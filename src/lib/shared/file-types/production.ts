// File-production accessors: output tokens, validation classes and document
// source selection.
//
// This is a SEPARATE entry point from `./index` on purpose. The token map below
// has ~180 alias keys and the produced-MIME table another ~54; neither belongs
// in a client chunk. Like `./table`, this module has zero heavy dependencies,
// so `intake.ts` and `produce-file.ts` keep passing `output-types.test.ts`'s
// "no JSZip on the request path" assertion.

import { FILE_TYPE_ENTRIES } from "./table";
import type {
	DocumentRenderKind,
	FileTypeEntry,
	ProductionValidationClass,
} from "./types";

export function normalizeRequestedOutputType(type: string): string {
	return type.trim().toLowerCase();
}

// ── output tokens ──────────────────────────────────────────────────────────

/**
 * Rebuilds `OUTPUT_TYPE_EXTENSIONS` (output-types.ts:7-113) from the table.
 * Exported so `legacy-equivalence.test.ts` can deep-equal it against the frozen
 * literal in both directions.
 */
export function buildOutputTokenMap(): Record<string, string> {
	const map: Record<string, string> = {};
	for (const entry of FILE_TYPE_ENTRIES) {
		for (const [token, extension] of Object.entries(entry.production.types)) {
			map[token] = extension;
		}
	}
	return map;
}

const OUTPUT_TOKEN_EXTENSIONS = buildOutputTokenMap();

const ENTRY_BY_OUTPUT_TOKEN = new Map<string, FileTypeEntry>();
for (const entry of FILE_TYPE_ENTRIES) {
	for (const token of Object.keys(entry.production.types)) {
		ENTRY_BY_OUTPUT_TOKEN.set(token, entry);
	}
}

export function getExpectedExtensionForOutputType(type: string): string | null {
	return OUTPUT_TOKEN_EXTENSIONS[normalizeRequestedOutputType(type)] ?? null;
}

/**
 * The single source of truth for "is this a file type the pipeline can
 * produce". Intake calls it so an unknown type is refused BEFORE a sandbox
 * program runs.
 */
export function isSupportedFileProductionOutputType(type: string): boolean {
	return getExpectedExtensionForOutputType(type) !== null;
}

/** Sorted, for tests and diagnostics. */
export function getRequestableOutputTokens(): readonly string[] {
	return Object.keys(OUTPUT_TOKEN_EXTENSIONS).sort();
}

export function getEntryForOutputType(type: string): FileTypeEntry | null {
	return ENTRY_BY_OUTPUT_TOKEN.get(normalizeRequestedOutputType(type)) ?? null;
}

// ── document source / render kind ──────────────────────────────────────────

/**
 * The ids of the three types `produce-file.shouldUseDocumentSourceForOutputs`
 * recognises. It matched the bare token only — `"application/pdf"` was never in
 * its set — so the check stays on the id, not on the whole token space.
 */
const DOCUMENT_SOURCE_IDS: ReadonlySet<string> = new Set(
	FILE_TYPE_ENTRIES.filter((entry) => entry.production.documentSource).map(
		(entry) => entry.id,
	),
);

/** True iff EVERY token is a document-source type. An empty list is `true`, as before. */
export function shouldUseDocumentSourceForOutputs(
	types: readonly string[],
): boolean {
	return types.every((type) =>
		DOCUMENT_SOURCE_IDS.has(normalizeRequestedOutputType(type)),
	);
}

/**
 * True iff a produced file of this type is just bytes we already hold: its
 * entry is text-validated (`production.validation === "text"`) and is NOT a
 * document source.
 *
 * Exactly the set `buildTextFileProgram` was being used for — the outputs that
 * spawn a Docker container whose only job is `write_text` — so it is the
 * registry half of Phase 6 D8's `inline_text` production mode. `html` is
 * excluded although it is text-validated, because a PDF/DOCX/HTML request
 * belongs to the report renderers.
 *
 * P6-B's `isInlineTextRequest(types)` is
 * `types.length > 0 && types.every(isInlineTextOutputType)` — an empty list is
 * false there, because the caller's default-type ladder has already run.
 */
export function isInlineTextOutputType(type: string): boolean {
	const entry = getEntryForOutputType(type);
	if (!entry) return false;
	return (
		entry.production.validation === "text" && !entry.production.documentSource
	);
}

/** `normalizeDocumentOutput` — pdf | docx | html | markdown | null. */
export function normalizeDocumentOutput(
	type: string,
): DocumentRenderKind | null {
	return getEntryForOutputType(type)?.production.documentRenderKind ?? null;
}

// ── produced-file validation ───────────────────────────────────────────────

function extensionOf(dottedExtension: string): string {
	return dottedExtension.trim().toLowerCase().replace(/^\./, "");
}

function entryForDottedExtension(
	dottedExtension: string,
): FileTypeEntry | null {
	const extension = extensionOf(dottedExtension);
	if (!extension) return null;
	return (
		FILE_TYPE_ENTRIES.find((entry) => entry.extensions.includes(extension)) ??
		null
	);
}

/** Dotted extension (".py") -> class. Unknown -> "none". */
export function getProductionValidationClass(
	dottedExtension: string,
): ProductionValidationClass {
	return (
		entryForDottedExtension(dottedExtension)?.production.validation ?? "none"
	);
}

export function isTextLikeExtension(dottedExtension: string): boolean {
	return getProductionValidationClass(dottedExtension) === "text";
}

export function requiresFullContentValidation(
	dottedExtension: string,
): boolean {
	const validationClass = getProductionValidationClass(dottedExtension);
	return validationClass === "text" || validationClass === "xlsx";
}

/**
 * `EXTENSION_MIME_TYPES` (output-validation.ts:14-80), verbatim and in order.
 *
 * This is NOT derivable from `entry.mimeTypes`, and the difference is
 * load-bearing, so it stays an explicit table:
 *  - `.jsx` and `.tsx` accept `application/javascript` / `application/typescript`
 *    here although neither is a recognition MIME for those entries. Deriving
 *    would NARROW the check and start failing produced files that pass today.
 *  - `.csv` does NOT accept `application/csv` here although it is a recognition
 *    alias, and `.html`/`.htm` do NOT accept `text/plain` although they are
 *    text-like. Deriving would WIDEN the check.
 * Recognition ("what may this file claim to be") and production validation
 * ("what may a file we just wrote claim to be") are genuinely different sets.
 */
const PRODUCED_EXTENSION_MIME_TYPES: Readonly<
	Record<string, readonly string[]>
> = {
	".pdf": ["application/pdf"],
	".txt": ["text/plain"],
	".md": ["text/markdown", "text/plain"],
	".markdown": ["text/markdown", "text/plain"],
	".csv": ["text/csv", "text/plain"],
	// Phase 6 D7 — the one row this migration adds. Same shape as `.csv`:
	// the canonical MIME plus `text/plain`, because a program that writes a
	// tab-separated file very often labels it as plain text.
	".tsv": ["text/tab-separated-values", "text/plain"],
	".html": ["text/html"],
	".htm": ["text/html"],
	".css": ["text/css", "text/plain"],
	".scss": ["text/x-scss", "text/plain"],
	".sass": ["text/x-sass", "text/plain"],
	".less": ["text/x-less", "text/plain"],
	".js": ["application/javascript", "text/javascript", "text/plain"],
	".mjs": ["application/javascript", "text/javascript", "text/plain"],
	".cjs": ["application/javascript", "text/javascript", "text/plain"],
	".jsx": ["text/jsx", "application/javascript", "text/plain"],
	".ts": ["application/typescript", "text/typescript", "text/plain"],
	".tsx": ["text/tsx", "application/typescript", "text/plain"],
	".py": ["text/x-python", "text/plain"],
	".sh": ["application/x-sh", "text/x-shellscript", "text/plain"],
	".bash": ["application/x-sh", "text/x-shellscript", "text/plain"],
	".zsh": ["application/x-sh", "text/x-shellscript", "text/plain"],
	".json": ["application/json", "text/json", "text/plain"],
	".svg": ["image/svg+xml", "application/xml", "text/xml", "text/plain"],
	".xml": ["application/xml", "text/xml", "text/plain"],
	".yaml": ["application/yaml", "text/yaml", "text/plain"],
	".yml": ["application/yaml", "text/yaml", "text/plain"],
	".toml": ["application/toml", "text/plain"],
	".sql": ["application/sql", "text/plain"],
	".graphql": ["application/graphql", "text/plain"],
	".gql": ["application/graphql", "text/plain"],
	".ini": ["text/plain"],
	".env": ["text/plain"],
	".conf": ["text/plain"],
	".log": ["text/plain"],
	".rb": ["text/x-ruby", "text/plain"],
	".rs": ["text/rust", "text/plain"],
	".go": ["text/x-go", "text/plain"],
	".java": ["text/x-java-source", "text/plain"],
	".kt": ["text/x-kotlin", "text/plain"],
	".kts": ["text/x-kotlin", "text/plain"],
	".swift": ["text/x-swift", "text/plain"],
	".cs": ["text/x-csharp", "text/plain"],
	".cpp": ["text/x-c++src", "text/plain"],
	".cxx": ["text/x-c++src", "text/plain"],
	".cc": ["text/x-c++src", "text/plain"],
	".c": ["text/x-csrc", "text/plain"],
	".h": ["text/x-csrc", "text/plain"],
	".hpp": ["text/x-c++src", "text/plain"],
	".php": ["application/x-httpd-php", "text/plain"],
	".r": ["text/x-r-source", "text/plain"],
	".xlsx": [
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	],
	".docx": [
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	],
	".pptx": [
		"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	],
	".odt": ["application/vnd.oasis.opendocument.text"],
	".zip": [
		"application/zip",
		"application/x-zip-compressed",
		"application/octet-stream",
	],
};

/** Allowed MIMEs for a produced file with this dotted extension; [] = unconstrained. */
export function getAllowedMimeTypesForProducedExtension(
	dottedExtension: string,
): readonly string[] {
	const extension = extensionOf(dottedExtension);
	if (!extension) return [];
	return PRODUCED_EXTENSION_MIME_TYPES[`.${extension}`] ?? [];
}

/**
 * Dotted extension -> MIME for sandbox output labelling. null = unknown.
 *
 * Derived from the entry's canonical MIME, which reproduces every key of
 * `sandbox-execution.MIME_TYPES` (including `.js` -> "text/javascript", which
 * the sandbox already emitted before conflict 1 made it canonical). It answers
 * for a few extensions the frozen map omitted — `.gif`, `.webp`, `.doc` — where
 * the sandbox previously fell back to a generic type.
 */
export function getSandboxMimeTypeForExtension(
	dottedExtension: string,
): string | null {
	return entryForDottedExtension(dottedExtension)?.mimeTypes[0] ?? null;
}

// ── model-facing examples ──────────────────────────────────────────────────

/** "xlsx, docx, pptx, pdf, csv, zip" — derived from `production.exampleRank`. */
export const FILE_PRODUCTION_OUTPUT_TYPE_EXAMPLES: string =
	FILE_TYPE_ENTRIES.filter(
		(entry) => entry.production.exampleRank !== undefined,
	)
		.sort(
			(a, b) =>
				(a.production.exampleRank ?? 0) - (b.production.exampleRank ?? 0),
		)
		.map((entry) => entry.id)
		.join(", ");
