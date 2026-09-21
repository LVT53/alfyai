// Type definitions for the shared file-type registry. Fully erased at build
// time — this module contributes zero bytes to any bundle.
//
// See docs/plans/mineru4/phase1-registry-spec.md section 1.1. The shapes here
// are a frozen contract: slices B-E are written against them in parallel.

/** Glyph family. Surfaces map this to their own icon; the registry names no icons. */
export type FileTypeCategory =
	| "image"
	| "pdf"
	| "document" // doc, docx, odt
	| "spreadsheet" // csv, xls, xlsx, ods
	| "presentation" // ppt, pptx, odp
	| "code"
	| "text" // txt, md, rtf, log
	| "archive"
	| "media" // audio + video
	| "other";

/** Mirrors `PreviewFileType` in src/lib/utils/file-preview.ts:1-10. Unchanged union. */
export type PreviewKind =
	| "pdf"
	| "docx"
	| "xlsx"
	| "pptx"
	| "odt"
	| "image"
	| "html"
	| "text"
	| "unsupported";

/**
 * Where an uploaded file's text comes from.
 *  - "direct-text": read the bytes as UTF-8 (today's `isDirectTextExtractionFile` path)
 *  - "mineru":      POST to the MinerU service
 *  - "reject":      refuse at /api/knowledge/upload/intent with `rejectReason`
 *  - "vision" | "archive": RESERVED. No entry may use them in Phase 1; the
 *    registry invariant test asserts the set of entries using them is empty.
 */
export type IntakeRoute =
	| "direct-text"
	| "mineru"
	| "reject"
	| "vision"
	| "archive";

/** Optional MinerU tier hint. Absent = the backend's default tier. */
export type IntakeTierHint = "flash";

/** Keys into the i18n `knowledge.uploadRejected*` family. */
export type RejectReasonKey =
	| "media"
	| "archive"
	| "formatNotEnabled"
	| "unknownType";

/** Post-production byte validation, in src/lib/server/services/file-production/output-validation.ts terms. */
export type ProductionValidationClass = "text" | "xlsx" | "none";

/** Which document renderer `execution-adapter.normalizeDocumentOutput` maps this type to. */
export type DocumentRenderKind = "pdf" | "docx" | "html" | "markdown";

/** Surfaces that publish an HTML `accept` attribute built from the registry. */
export type UploadSurface = "knowledge" | "chat";

export interface FileTypePreview {
	readonly kind: PreviewKind;
	/** Shiki/highlighter language id. Absent = no syntax highlighting. */
	readonly language?: string;
	/**
	 * True when the EXTENSION alone decides the preview kind, ignoring the declared MIME —
	 * i.e. this entry was in TRUSTED_PREVIEW_EXTENSIONS or IMAGE_EXTENSIONS.
	 * NOT related to `PreviewRuntimeAdapter.trustedRuntime`, which is a CSP flag
	 * (src/lib/components/document-workspace/preview-runtime/index.ts:242).
	 */
	readonly extensionAuthoritative?: true;
}

export interface FileTypeIntake {
	readonly route: IntakeRoute;
	readonly tierHint?: IntakeTierHint;
	/** Required iff route === "reject". */
	readonly rejectReason?: RejectReasonKey;
	/**
	 * True iff a pre-4.x MinerU cannot serve this entry the way `route` assumes
	 * (phase5-6 spec section 2.1, D6). The registry only LABELS the entry — the
	 * version probe and the refusal live in the upload path.
	 *
	 * Two shapes, told apart by `fallbackRoute`:
	 *  - WITHOUT `fallbackRoute` (rtf, odt, ods, odp, epub): the format never
	 *    worked before this migration, so a backend that positively answers
	 *    "major < 4" hides it from both accept strings and refuses it exactly
	 *    like `reject` / `formatNotEnabled`. See `getMineru4GatedFileTypeIds`.
	 *  - WITH `fallbackRoute` (html/htm): the format works TODAY and must never
	 *    become a refusal, so a pre-4 backend falls back to that route instead
	 *    (orchestrator ruling "OQ2, amended"). See
	 *    `getMineru4FallbackFileTypeIds` / `getIntakeFallbackRoute`.
	 */
	readonly requiresMineru4?: true;
	/**
	 * The route to use INSTEAD of `route` when the backend has positively
	 * probed as pre-4.x. Only meaningful together with `requiresMineru4`, and
	 * never `"reject"`: a refusal is expressed by leaving this absent.
	 * `registry.test.ts` asserts both halves of that pairing.
	 */
	readonly fallbackRoute?: IntakeRoute;
}

export interface FileTypeProduction {
	/** True iff `produce_file` may be asked for this type. */
	readonly requestable: boolean;
	/**
	 * Every type token the model / API may name, mapped to the extension the produced
	 * file MUST carry. Keys are already lowercased and trimmed.
	 * This is a verbatim re-partition of OUTPUT_TYPE_EXTENSIONS
	 * (src/lib/server/services/file-production/output-types.ts:7-113) grouped by entry,
	 * so `getExpectedExtensionForOutputType` round-trips exactly. `{}` when !requestable.
	 * NOTE: tokens are NOT mechanically derived from `extensions` — `markdown` must map
	 * to ".md" (not ".markdown") and `yml` must map to ".yml" (not ".yaml").
	 */
	readonly types: Readonly<Record<string, `.${string}`>>;
	/** Set iff `execution-adapter.normalizeDocumentOutput` recognises this type. */
	readonly documentRenderKind?: DocumentRenderKind;
	/**
	 * True iff this type is in `produce-file.shouldUseDocumentSourceForOutputs`'s
	 * {pdf, docx, html} set. Strictly narrower than `documentRenderKind` (md is
	 * renderable but never triggers documentSource).
	 */
	readonly documentSource?: true;
	readonly validation: ProductionValidationClass;
	/** Position in FILE_PRODUCTION_OUTPUT_TYPE_EXAMPLES. Absent = not an example. */
	readonly exampleRank?: number;
}

export interface FileTypeEntry {
	/** Stable id, unique. Equal to the canonical extension. */
	readonly id: string;
	/** Lowercase, no dot. First element is canonical. Globally unique across entries. */
	readonly extensions: readonly [string, ...string[]];
	/** First element is canonical. Later elements are accepted aliases. */
	readonly mimeTypes: readonly [string, ...string[]];
	/**
	 * True iff this entry owns its canonical MIME for reverse (MIME -> entry) lookup.
	 * Exactly one entry per canonical MIME string may set it. Only needed for
	 * "text/plain", claimed by `txt`, `ini` and `log`; owner is `txt`.
	 */
	readonly ownsCanonicalMime?: true;
	readonly category: FileTypeCategory;
	readonly preview: FileTypePreview;
	readonly intake: FileTypeIntake;
	readonly production: FileTypeProduction;
	/**
	 * True iff the bytes are UTF-8 text for the purposes of
	 * output-validation's TEXT_LIKE_EXTENSIONS / generated-file-serving's
	 * FULL_VALIDATION_EXTENSIONS. `.svg` is deliberately false (it is text but was
	 * never in TEXT_LIKE_EXTENSIONS). `.rtf` is deliberately false for the same reason.
	 */
	readonly textLike: boolean;
	/** Surfaces whose `accept` attribute lists this entry. [] = listed nowhere. */
	readonly surfaces: readonly UploadSurface[];
	/**
	 * Leading-byte signatures for the completion-time content check (spec section 4.2).
	 * Absent = no check. Each entry is a byte sequence + the offset it starts at.
	 */
	readonly signatures?: readonly FileTypeSignature[];
}

export interface FileTypeSignature {
	readonly offset: number;
	/** Byte values. Use 0x??-style holes via `null` for "any byte". */
	readonly bytes: readonly (number | null)[];
	/**
	 * How far past `offset` the run may start. Absent (the default) means the
	 * run must begin exactly at `offset`.
	 *
	 * Only `pdf` uses it. The PDF spec's implementation notes tell readers to
	 * look for `%PDF-` within the first 1024 bytes, and real files — out of
	 * mail gateways, scanners and "optimizers" — carry a preamble, so every
	 * reader accepts them. A container format may NOT have this: a ZIP or a
	 * PNG whose magic is one byte late is a genuine mismatch.
	 */
	readonly searchWithinBytes?: number;
}
