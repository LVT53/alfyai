# Phase 1 — Shared file-type registry

Implementation spec. Target repo: `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai`, branch `dev`.
Audience: parallel dev sub-agents in separate worktrees, then an adversarial reviewer.

**Rule of the phase:** behaviour-preserving, except the three deliberate exceptions in §2.4 and the
resolved conflicts in §2.3. Every other observable output must be byte-identical before and after.

**Independence:** this phase does not depend on, and must not anticipate, the MinerU 4.x upgrade.
It only guarantees that every entry carries an `intake.route` so a later phase can switch routing
without touching call sites.

---

## 0. Module layout and why it is split this way

```
src/lib/shared/file-types/
  types.ts          type definitions only — fully erased at build time
  table.ts          FILE_TYPE_ENTRIES — the data. ZERO value imports (only `import type`)
  index.ts          client-safe accessors (lookup, preview, glyph, accept, allowlist)
  production.ts     file-production accessors (output tokens, validation class, document source)
  model-facing.ts   EN/HU model-facing format strings
src/lib/server/services/knowledge/upload-signature.ts   server-only magic-byte check (derives from table.ts)
```

Justification (this repo already has a precedent and a test that enforces it —
`src/lib/server/services/file-production/output-types.ts:1-5` and
`src/lib/server/services/file-production/output-types.test.ts:49-53`):

| Rule | Why |
| --- | --- |
| `table.ts` has **zero value imports** (`expect(source.match(/^import\s(?!type)/gm)).toBeNull()`) | The existing `output-types.ts` was split out precisely so `intake.ts` and `produce-file.ts` could reach the type table without dragging JSZip/pako into the chat server bundle. The registry inherits that constraint: a dependency-free data module can never drag anything anywhere. |
| `index.ts` imports only `./table` + `./types` | Any client chunk (composer chip, knowledge list, preview) gets the table + ~15 small `Map`s. Raw table ≈ 18 KB, ≈ 6 KB gzipped, in the shared vendor chunk that every route already loads. |
| `production.ts` is a **separate entry point**, not part of `index.ts` | Production token maps (~180 alias keys) and the XLSX validation class are server-only concerns. Keeping them out of `index.ts` keeps them out of every client chunk. `production.ts` still has zero deps, so `intake.ts`/`produce-file.ts` keep passing `output-types.test.ts`. |
| `model-facing.ts` is a **separate entry point** | It carries the Hungarian prose. Imported only by `$lib/server/prompts.ts` and `$lib/server/services/normal-chat-tools/index.ts`; never reachable from a client chunk. |
| magic-byte sniffing lives under `$lib/server/`, not in `shared/` | It takes a `Buffer`. Putting Node-only code in a `shared/` folder invites an accidental client import that only fails at runtime. |

`src/lib/shared/` does not exist yet — slice A creates it. `$lib` already aliases to `/src/lib`
(`vitest.config.ts:16`, `jsconfig.json`), so `$lib/shared/file-types` resolves with no config change.

---

## 1. Registry contract

### 1.1 `src/lib/shared/file-types/types.ts`

```ts
/** Glyph family. Surfaces map this to their own icon; the registry names no icons. */
export type FileTypeCategory =
	| "image"
	| "pdf"
	| "document"      // doc, docx, odt
	| "spreadsheet"   // csv, xls, xlsx, ods
	| "presentation"  // ppt, pptx, odp
	| "code"
	| "text"          // txt, md, rtf, log
	| "archive"
	| "media"         // audio + video
	| "other";

/** Mirrors `PreviewFileType` in src/lib/utils/file-preview.ts:1-10. Unchanged union. */
export type PreviewKind =
	| "pdf" | "docx" | "xlsx" | "pptx" | "odt"
	| "image" | "html" | "text" | "unsupported";

/**
 * Where an uploaded file's text comes from.
 *  - "direct-text": read the bytes as UTF-8 (today's `isDirectTextExtractionFile` path)
 *  - "mineru":      POST to the MinerU service
 *  - "reject":      refuse at /api/knowledge/upload/intent with `rejectReason`
 *  - "vision" | "archive": RESERVED. No entry may use them in Phase 1; the
 *    registry invariant test asserts the set of entries using them is empty.
 */
export type IntakeRoute = "direct-text" | "mineru" | "reject" | "vision" | "archive";

/** Optional MinerU tier hint. Absent = the backend's default tier. */
export type IntakeTierHint = "flash";

/** Keys into the i18n `knowledge.uploadRejected*` family. */
export type RejectReasonKey = "media" | "archive" | "formatNotEnabled" | "unknownType";

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
	 * Leading-byte signatures for the completion-time content check (§4.2).
	 * Absent = no check. Each entry is a byte sequence + the offset it starts at.
	 */
	readonly signatures?: readonly FileTypeSignature[];
}

export interface FileTypeSignature {
	readonly offset: number;
	/** Byte values. Use 0x??-style holes via `null` for "any byte". */
	readonly bytes: readonly (number | null)[];
}
```

### 1.2 `src/lib/shared/file-types/table.ts`

```ts
import type { FileTypeEntry } from "./types";

export const FILE_TYPE_ENTRIES: readonly FileTypeEntry[] = [ /* §2.1 */ ];
```

No other statement in the file. Enforced by `registry.test.ts`.

### 1.3 `src/lib/shared/file-types/index.ts` — client-safe accessors

```ts
import type {
	FileTypeCategory, FileTypeEntry, IntakeRoute, PreviewKind,
	RejectReasonKey, UploadSurface,
} from "./types";

export type { FileTypeCategory, FileTypeEntry, IntakeRoute, PreviewKind, RejectReasonKey, UploadSurface };
export { FILE_TYPE_ENTRIES } from "./table";

// ── normalisation ──────────────────────────────────────────────────────────
/** "REPORT.Final.PDF" -> "pdf"; "" when the name carries no dot. Mirrors `fileExtension`. */
export function fileExtension(filename: string): string;
/** "text/HTML; charset=utf-8" -> "text/html"; null when empty. Mirrors `normalizeMimeType`. */
export function normalizeMimeType(mimeType: string | null | undefined): string | null;
/** {"application/octet-stream", "application/download"} plus empty. */
export function isGenericMimeType(mimeType: string | null | undefined): boolean;
export const GENERIC_MIME_TYPES: ReadonlySet<string>;

// ── lookup ─────────────────────────────────────────────────────────────────
export function getEntryByExtension(extension: string): FileTypeEntry | null;
export function getEntryByFilename(filename: string): FileTypeEntry | null;
/** Canonical MIME first, then alias MIMEs; respects `ownsCanonicalMime`. */
export function getEntryByMimeType(mimeType: string | null | undefined): FileTypeEntry | null;
/** Extension wins; MIME is the fallback. The lookup order every call site should use. */
export function resolveEntry(filename: string, mimeType: string | null | undefined): FileTypeEntry | null;

// ── MIME ───────────────────────────────────────────────────────────────────
/** null when the extension is unknown. */
export function getCanonicalMimeForExtension(extension: string): string | null;
/** All MIMEs (canonical + aliases) a file with this extension may legitimately declare. */
export function getAcceptedMimeTypesForExtension(extension: string): readonly string[];
/** Replaces file-preview `getPreviewContentType`. Declared non-generic MIME wins; else canonical; else "application/octet-stream". */
export function getContentTypeForFile(filename: string, mimeType: string | null): string;

// ── preview ────────────────────────────────────────────────────────────────
export function getPreviewKind(filename: string, mimeType: string | null): PreviewKind;
export function getPreviewLanguage(filename: string, mimeType: string | null): string | undefined;
export function isPreviewable(filename: string, mimeType: string | null): boolean;

// ── glyphs ─────────────────────────────────────────────────────────────────
export function getCategory(filename: string, mimeType: string | null): FileTypeCategory;

// ── upload surfaces ────────────────────────────────────────────────────────
/** e.g. ".pdf,.doc,.docx,..." — exactly what an <input accept> wants. Memoised per surface. */
export function getAcceptAttribute(surface: UploadSurface): string;
export function getAcceptedExtensions(surface: UploadSurface): readonly string[];

// ── server allowlist (pure, so the client may pre-check identically) ────────
export type UploadAdmission =
	| { readonly allowed: true; readonly entry: FileTypeEntry }
	| { readonly allowed: false; readonly reason: RejectReasonKey; readonly entry: FileTypeEntry | null };
/** The single decision function for §4.1. Surface-independent. */
export function admitUpload(filename: string, mimeType: string | null): UploadAdmission;

// ── intake (consumed by document-extraction; later phases switch on this) ───
export function getIntakeRoute(filename: string, mimeType: string | null): IntakeRoute;
export function getIntakeTierHint(filename: string, mimeType: string | null): "flash" | undefined;

// ── limits ─────────────────────────────────────────────────────────────────
/** 104857600. The client-side fallback until the intent response or SSR payload lands. */
export const DEFAULT_MAX_FILE_UPLOAD_SIZE_BYTES: number;
```

### 1.4 `src/lib/shared/file-types/production.ts` — server-side production accessors

```ts
import type { DocumentRenderKind, FileTypeEntry, ProductionValidationClass } from "./types";

export function normalizeRequestedOutputType(type: string): string;          // unchanged semantics
export function getExpectedExtensionForOutputType(type: string): string | null;
export function isSupportedFileProductionOutputType(type: string): boolean;
export function getRequestableOutputTokens(): readonly string[];             // sorted, for tests/diagnostics
export function getEntryForOutputType(type: string): FileTypeEntry | null;

/** `shouldUseDocumentSourceForOutputs` — true iff EVERY token is documentSource. */
export function shouldUseDocumentSourceForOutputs(types: readonly string[]): boolean;
/** `normalizeDocumentOutput` — pdf | docx | html | markdown | null. */
export function normalizeDocumentOutput(type: string): DocumentRenderKind | null;

/** Dotted extension (".py") -> class. Unknown -> "none". */
export function getProductionValidationClass(dottedExtension: string): ProductionValidationClass;
export function isTextLikeExtension(dottedExtension: string): boolean;        // class === "text"
export function requiresFullContentValidation(dottedExtension: string): boolean; // class === "text" || "xlsx"
/** Allowed MIMEs for a produced file with this dotted extension; [] = unconstrained. */
export function getAllowedMimeTypesForProducedExtension(dottedExtension: string): readonly string[];
/** Dotted extension -> MIME for sandbox output labelling. null = unknown. */
export function getSandboxMimeTypeForExtension(dottedExtension: string): string | null;

/** "xlsx, docx, pptx, pdf, csv, zip" — derived, asserted byte-identical to today's literal. */
export const FILE_PRODUCTION_OUTPUT_TYPE_EXAMPLES: string;
```

### 1.5 `src/lib/shared/file-types/model-facing.ts`

```ts
export type ModelFacingLocale = "en" | "hu";

/** Comma-joined upper-case tokens of every requestable type, ranked. For prompt/tool prose. */
export function getProducibleFormatList(locale: ModelFacingLocale): string;
/** "text, HTML, JSON, PDF, DOCX, PPTX, XLSX, and common image formats (...)" — the attachments.ts string. */
export function getSupportedExtractionSummary(locale: ModelFacingLocale): string;
```

---

## 2. Initial entry table

### 2.1 Entries

Columns: `req?` = `production.requestable`. `val` = `production.validation`. `srf` = `surfaces`
(**K** = knowledge, **C** = chat, `—` = neither). Category `code` unless noted.
`preview` `text*` means `extensionAuthoritative` is **not** set (MIME may still override).

#### Text / code — `intake: direct-text`, `textLike: true`, `val: text`

| id | extensions | canonical MIME | cat | preview | lang | req? | production tokens | srf |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| txt | txt | text/plain ★ | text | text* | — | yes | txt,text,text/plain→.txt | K,C |
| md | md, markdown | text/markdown | text | text* | markdown | yes | md,markdown,text/markdown→.md | K,C |
| csv | csv | text/csv | spreadsheet | text* | — | yes | csv,text/csv→.csv | K,C |
| json | json | application/json | code | text* | json | yes | json,application/json→.json | K,C |
| xml | xml | application/xml | code | text* | xml | yes | xml,application/xml→.xml | C |
| html | html, htm | text/html | code | **html** ᴬ | html | yes | html,text/html→.html | K,C |
| css | css | text/css | code | text* | css | yes | css,text/css→.css | C |
| scss | scss | text/x-scss | code | text* | scss | yes | scss,text/x-scss→.scss | C |
| sass | sass | text/x-sass | code | text* | sass | yes | sass,text/x-sass→.sass | C |
| less | less | text/x-less | code | text* | less | yes | less,text/x-less→.less | C |
| js | js, mjs, cjs | text/javascript ⚠1 | code | text* | javascript | yes | js,javascript,application/javascript,text/javascript→.js; mjs→.mjs; cjs→.cjs | C |
| jsx | jsx | text/jsx | code | text* | jsx | yes | jsx,text/jsx→.jsx | C |
| ts | ts | application/typescript | code | text* | typescript | yes | ts,typescript,application/typescript,text/typescript→.ts | C |
| tsx | tsx | text/tsx | code | text* | tsx | yes | tsx,text/tsx→.tsx | C |
| py | py | text/x-python | code | text* | python | yes | py,python,text/x-python→.py | C |
| sh | sh, bash, zsh | application/x-sh | code | text* | bash | yes | sh,shell,bash,application/x-sh,text/x-shellscript→.sh; zsh→.zsh | C |
| yaml | yaml, yml | application/yaml | code | text* | yaml | yes | yaml,application/yaml→.yaml; yml→.yml | C |
| toml | toml | application/toml | code | text* | toml | yes | toml,application/toml→.toml | C |
| sql | sql | application/sql | code | text* | sql | yes | sql,application/sql→.sql | C |
| graphql | graphql, gql | application/graphql | code | text* | graphql | yes | graphql,application/graphql→.graphql; gql→.gql | C |
| ini | ini, env, conf | text/plain | code | text* | ini | yes | ini→.ini; env→.env; conf→.conf | C |
| log | log | text/plain | text | text* | — | yes | log→.log | C |
| rb | rb | text/x-ruby | code | text* | ruby | yes | rb,ruby,text/x-ruby→.rb | C |
| rs | rs | text/rust | code | text* | rust | yes | rs,rust,text/rust→.rs | C |
| go | go | text/x-go | code | text* | go | yes | go,text/x-go→.go | C |
| java | java | text/x-java-source | code | text* | java | yes | java,text/x-java-source→.java | C |
| kt | kt, kts | text/x-kotlin | code | text* | kotlin | yes | kt,kotlin,text/x-kotlin→.kt | C |
| swift | swift | text/x-swift | code | text* | swift | yes | swift,text/x-swift→.swift | C |
| cs | cs | text/x-csharp | code | text* | csharp | yes | cs,csharp,text/x-csharp→.cs | C |
| cpp | cpp, cxx, cc, hpp | text/x-c++src | code | text* | cpp | yes | cpp,text/x-c++src→.cpp; cxx→.cxx; cc→.cc; hpp→.hpp | C |
| c | c, h | text/x-csrc | code | text* | c | yes | c,text/x-csrc→.c; h→.h | C |
| php | php | application/x-httpd-php | code | text* | php | yes | php,application/x-httpd-php→.php | C |
| r | r | text/x-r-source | code | text* | r | yes | r,text/x-r-source→.r | C |

★ = `ownsCanonicalMime: true`. ᴬ = `extensionAuthoritative: true`.
MIME aliases to carry in `mimeTypes[1..]`: `csv` += `application/csv`; `js` += `application/javascript`;
`ts` += `text/typescript`; `yaml` += `text/yaml`; `json` += `text/json`; `sh` += `text/x-shellscript`;
`xml` += `text/xml`.
`kts` has **no** production token today — recognition-only (matches `output-types.ts`, which has no `kts` key).
`htm` has **no** production token today — recognition-only.

#### Documents — `intake: mineru`, `textLike: false`

| id | ext | canonical MIME | cat | preview | req? | val | production tokens | srf |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pdf | pdf | application/pdf | pdf | pdf ᴬ | yes | none | pdf,application/pdf→.pdf | K,C |
| docx | docx | …wordprocessingml.document | document | docx ᴬ | yes | none | docx,…wordprocessingml.document→.docx | K,C |
| doc | doc | application/msword | document | unsupported | no | none | — | K,C |
| xlsx | xlsx | …spreadsheetml.sheet | spreadsheet | xlsx ᴬ | yes | **xlsx** | xlsx,…spreadsheetml.sheet→.xlsx | K,C |
| xls | xls | application/vnd.ms-excel | spreadsheet | unsupported | no | none | — | K,C |
| pptx | pptx | …presentationml.presentation | presentation | pptx ᴬ | yes | none | pptx,…presentationml.presentation→.pptx | K,C |
| ppt | ppt | application/vnd.ms-powerpoint | presentation | unsupported | no | none | — | K,C |
| odt | odt | application/vnd.oasis.opendocument.text | document | odt ᴬ | yes | none | odt,application/vnd.oasis.opendocument.text→.odt | **C** |

`odt` is deliberately **not** in the knowledge accept string today (`DocumentsList.svelte:190`) — preserved.

#### Images — `intake: mineru`, `preview: image ᴬ`, `cat: image`, `textLike: false`, `val: none`

| id | extensions | canonical MIME | req? | srf |
| --- | --- | --- | --- | --- |
| jpg | jpg, jpeg, jfif | image/jpeg ⚠2 | no | K,C |
| png | png | image/png | no | K,C |
| gif | gif | image/gif | no | K,C |
| webp | webp | image/webp | no | K,C |
| bmp | bmp | image/bmp | no | K,C |
| tif | tif, tiff | image/tiff | no | K,C |
| heic | heic | image/heic | no | K,C |
| heif | heif | image/heif | no | K,C |
| avif | avif | image/avif | no | K,C |
| svg | svg | image/svg+xml | **yes** (svg,image/svg+xml→.svg) | K,C |

`svg` keeps `preview.language: "xml"` (from `EXTENSION_TO_PREVIEW_LANGUAGE`), `textLike: false`
(it was never in `TEXT_LIKE_EXTENSIONS`), and accepted MIME aliases
`application/xml`, `text/xml`, `text/plain` (from `EXTENSION_MIME_TYPES[".svg"]`).
Images route to `mineru`, not the RESERVED `vision`, because that is today's behaviour
(`document-extraction.ts:28-39` maps every image extension and posts it to MinerU).

#### Recognised, not ingestible — `intake: reject`

| id | ext | canonical MIME | cat | preview | req? | rejectReason | srf |
| --- | --- | --- | --- | --- | --- | --- | --- |
| rtf | rtf | application/rtf | text | text* | no | formatNotEnabled | — |
| ods | ods | …opendocument.spreadsheet | spreadsheet | unsupported | no | formatNotEnabled | — |
| odp | odp | …opendocument.presentation | presentation | unsupported | no | formatNotEnabled | — |
| zip | zip | application/zip | archive | unsupported | **yes** (zip,application/zip→.zip) | archive | — |
| rar | rar | application/vnd.rar | archive | unsupported | no | archive | — |
| 7z | 7z | application/x-7z-compressed | archive | unsupported | no | archive | — |
| tar | tar | application/x-tar | archive | unsupported | no | archive | — |
| gz | gz | application/gzip | archive | unsupported | no | archive | — |
| mp3 | mp3 | audio/mpeg | media | unsupported | no | media | — |
| wav | wav | audio/wav | media | unsupported | no | media | — |
| m4a | m4a | audio/mp4 | media | unsupported | no | media | — |
| aac | aac | audio/aac | media | unsupported | no | media | — |
| ogg | ogg | audio/ogg | media | unsupported | no | media | — |
| flac | flac | audio/flac | media | unsupported | no | media | — |
| mp4 | mp4 | video/mp4 | media | unsupported | no | media | — |
| mov | mov | video/quicktime | media | unsupported | no | media | — |
| avi | avi | video/x-msvideo | media | unsupported | no | media | — |
| mkv | mkv | video/x-matroska | media | unsupported | no | media | — |
| webm | webm | video/webm | media | unsupported | no | media | — |

`zip` keeps MIME aliases `application/x-zip-compressed`, `application/octet-stream`
(`output-validation.ts:75-79`). `rtf` keeps `preview.kind: "text"` because `rtf` is in
`file-preview.ts` `TEXT_EXTENSIONS` today; it is `textLike: false` because it is **not** in
`TEXT_LIKE_EXTENSIONS`. `rar/7z/tar/gz` and the media entries exist so the existing glyph
behaviour survives (`attachment-file-type.ts:66`, `DocumentsList.svelte:711-718`).

**Total: 80 entries, 92 extensions.**

### 2.2 Derived: exact reproduction of today's accept string

`getAcceptAttribute("knowledge")` must produce, byte-identically,
`DocumentsList.svelte:190`'s literal. The `surfaces` order used is **table order**, and the
knowledge-surface entries must therefore be ordered in `table.ts` so the join yields:

```
.pdf,.doc,.docx,.txt,.md,.json,.csv,.xlsx,.xls,.pptx,.ppt,.html,.htm,.jpg,.jpeg,.jfif,.png,.gif,.bmp,.tiff,.tif,.webp,.svg,.heic,.heif,.avif
```

Because table order cannot satisfy both that string and a readable grouping, add an explicit
per-surface ordering array in `index.ts`:

```ts
const SURFACE_ACCEPT_ORDER: Readonly<Record<UploadSurface, readonly string[] | null>> = {
	// Frozen to preserve the exact historical string. New knowledge types append at the end.
	knowledge: ["pdf","doc","docx","txt","md","json","csv","xlsx","xls","pptx","ppt","html","htm",
		"jpg","jpeg","jfif","png","gif","bmp","tiff","tif","webp","svg","heic","heif","avif"],
	chat: null, // null = table order
};
```
`registry.test.ts` asserts `SURFACE_ACCEPT_ORDER.knowledge` is exactly the set of extensions of
entries with `"knowledge"` in `surfaces` — so the two cannot drift.

### 2.3 Conflicts between existing maps, and the winner

| # | Extension / concept | Disagreeing sources | Winner | Why |
| --- | --- | --- | --- | --- |
| ⚠1 | `.js` / `.mjs` / `.cjs` canonical MIME | `file-preview.ts:150-152` → `application/javascript`; `document-extraction.ts:47` → `text/javascript`; `sandbox-execution.ts:42-44` → `text/javascript`; `output-validation.ts:26-28` accepts both | **`text/javascript`**, with `application/javascript` as an accepted alias | 2 of 3 producers already emit it; RFC 9239 obsoletes `application/javascript`; every consumer treats them identically (`MIME_TO_PREVIEW_LANGUAGE` maps both → `javascript`; `determinePreviewFileType` returns `text` for both; `EXTENSION_MIME_TYPES[".js"]` allows both; `getFileType` matches on `includes("javascript")`). **Only observable change:** `Content-Type` of a served `.js` generated file with no stored MIME. |
| ⚠2 | `.jfif` canonical MIME | Listed in `file-preview.ts:106` `IMAGE_EXTENSIONS` and `attachment-file-type.ts:36`, but **absent** from `EXTENSION_CONTENT_TYPES` and from `document-extraction.mimeFromExtension` → both fall back to `application/octet-stream` | **`image/jpeg`** | There is no competing value; `.jfif` *is* JPEG. Changes two outputs: `getPreviewContentType("x.jfif", null)` returns `image/jpeg` instead of `application/octet-stream`, and `extractDocumentText` posts `image/jpeg` to MinerU instead of `application/octet-stream`. Both are strict improvements; both are listed in the equivalence test's `KNOWN_DELTAS`. |
| ⚠3 | Text-like set: preview vs production | `file-preview.TEXT_EXTENSIONS` (49 members) vs `output-validation.TEXT_LIKE_EXTENSIONS` (48 members) | Two separate fields: `preview.kind === "text"` and `textLike` | The sets differ by exactly one member: `rtf` is in `TEXT_EXTENSIONS` and not in `TEXT_LIKE_EXTENSIONS`. Collapsing them would add a UTF-8/NUL check to produced `.rtf`. Keep both, document the single difference. |
| ⚠4 | Full-content validation set | `generated-file-serving.FULL_VALIDATION_EXTENSIONS` (49) vs `output-validation.TEXT_LIKE_EXTENSIONS` (48) | `FULL_VALIDATION = {textLike} ∪ {validation === "xlsx"}` | Verified: the two lists are identical except `FULL_VALIDATION` adds `.xlsx`. Derivation is exact. |
| ⚠5 | "is this a document-source output" | `produce-file.shouldUseDocumentSourceForOutputs` → `{pdf, docx, html}`; `execution-adapter.normalizeDocumentOutput` → `{pdf, docx, html, markdown/md}` | Two fields: `production.documentSource` (narrow) and `production.documentRenderKind` (wide) | They are genuinely different decisions — `md` can be *rendered* by the document pipeline but must never *trigger* documentSource selection at request time. Collapsing them would change which `produce_file` calls take the documentSource path. |
| ⚠6 | `markdown` token → extension | `output-types.ts:14` `markdown: ".md"`, but `.markdown` is also a real extension (`output-validation.ts:18`, `file-preview.ts:142`) | `production.types` is an **explicit** map; `markdown → ".md"`, and `.markdown` carries no production token | Mechanically deriving `ext → ".${ext}"` would make `markdown → ".markdown"` and break `outputTypeFromFilename`'s round-trip guard (`output-validation.ts:181-190`). Same reasoning forces explicit tokens for `yml→.yml`, `cxx→.cxx`, `cc→.cc`, `zsh→.zsh`, `gql→.gql`, `hpp→.hpp`, `h→.h`, `env→.env`, `conf→.conf`, `mjs→.mjs`, `cjs→.cjs`, `ini→.ini`, `log→.log`. |
| ⚠7 | `text/plain` owner | `txt`, `ini`/`env`/`conf`, `log` all declare it (`file-preview.ts:140,169-172`) | `txt` (`ownsCanonicalMime: true`) | Reverse MIME→entry lookup must be deterministic. `text/plain` → `txt` matches today's `getPreviewContentType` behaviour (it only goes extension→MIME, never back). |
| ⚠8 | Glyph category disagreements | `attachment-file-type.getFileType` returns `"xlsx"` for `csv`; `DocumentsList.getFileIcon` returns `Table` for `csv`. `getFileType` returns `"text"` for both `doc`-family and `txt`-family; `getFileIcon` returns `FileText` for both. | Registry stores a neutral `category`; each surface owns its category→glyph mapping (§3) | No behaviour changes: both surfaces' mappings are total and reproduce today's outputs exactly. |
| ⚠9 | OOXML detection | `attachment-file-type.ts:71-73` matches whole OOXML tokens; `DocumentsList.getFileIcon:672-681` matches `includes("wordprocessingml")`, `includes("spreadsheet")`, `includes("presentation")` | Registry MIME table is exact-match; the `includes(...)` heuristics stay as a **documented fallback chain** in `getCategory` for unknown extensions | Deleting the heuristics would regress files uploaded with a vendor MIME and no extension. See §3 note on fallback chains. |
| ⚠10 | `.zip` requestable but not ingestible | `output-types.ts:111` makes `zip` requestable; `DocumentsList` accept excludes it; `attachment-file-type` gives it an archive glyph | `production.requestable: true` **and** `intake.route: "reject"` with `rejectReason: "archive"` | The only entry that breaks the §6 invariant. Exempted by name in the invariant test with a comment that Phase ≥2 flips it to the RESERVED `archive` route. |

### 2.4 Deliberate behaviour changes (the three sanctioned exceptions)

**(a) Code/text extensions that preview as text become `direct-text`.**
Today `isDirectTextExtractionFile` (`document-extraction.ts:115-143`) admits an extension only via
its 14-item list or via the MIME derived from `mimeFromExtension`. The effective set today is
`txt md markdown html htm csv json py js ts css yaml yml xml`. These 33 extensions preview as text
but currently go to MinerU (which fails on them) and become `direct-text`:

```
scss sass less mjs cjs jsx tsx sh bash zsh sql graphql gql toml ini env conf log
rb rs go java kt kts swift cs cpp cxx cc c h hpp php r
```

`.rtf` is **not** in that list — it is `reject` (see §2.4c / MinerU deferral).

**(b) A server-side allowlist is enforced at `/api/knowledge/upload/intent`.** §4.1. Today there is
no type check anywhere on the server; `MessageInput.svelte`'s file input has no `accept` attribute
(`:2742-2749`), so any file can be uploaded and silently fail extraction.

**(c) Audio and video get `reject`.** 13 new entries, `rejectReason: "media"`. Today they reach
MinerU and produce `promptReady: false` with the generic readiness error.

### 2.5 Deferred MinerU formats — how they are added later

`rtf`, `odt`, `ods`, `odp`, `epub`, `ofd`, `tsv` are **not** enabled in Phase 1.
`rtf`, `ods`, `odp` already exist as `intake: { route: "reject", rejectReason: "formatNotEnabled" }`.
`odt` already exists as `intake: { route: "mineru" }` but with `surfaces: ["chat"]` only.
`epub`, `ofd`, `tsv` have no entry at all.

Enabling one in a later phase is a **one-line-per-entry** edit and nothing else:

```ts
// before
{ id: "rtf", …, intake: { route: "reject", rejectReason: "formatNotEnabled" }, surfaces: [] },
// after
{ id: "rtf", …, intake: { route: "mineru", tierHint: "flash" },              surfaces: ["knowledge","chat"] },
```

plus appending `"rtf"` to `SURFACE_ACCEPT_ORDER.knowledge` (§2.2). A brand-new format is one new
object in `table.ts`. No call site changes, because every consumer reads the accessors.

---

## 3. Map-by-map replacement checklist

`DELETE` = symbol removed outright. `THIN` = symbol kept as a re-export/one-line wrapper so
importers do not change. `REWRITE` = function body rewritten against the registry, signature kept.

| # | File | Symbol | Replaced by | Disposition | Importers that must change |
| --- | --- | --- | --- | --- | --- |
| 1 | `src/lib/server/services/document-extraction.ts:15` | `mimeFromExtension` | `getCanonicalMimeForExtension` | DELETE (call site at `:167` takes the extension without the dot) | none (module-private) |
| 2 | `src/lib/server/services/document-extraction.ts:115` | `isDirectTextExtractionFile` | `getIntakeRoute(name, mime) === "direct-text"` | DELETE; `:168` becomes a `switch` on the route with `mineru` in the default arm and `reject` throwing (unreachable — intent already refused) | none (module-private) |
| 3 | `src/lib/utils/file-preview.ts:12` | `TEXT_EXTENSIONS` | `preview.kind === "text"` | DELETE | module-private |
| 4 | `src/lib/utils/file-preview.ts:64` | `PREVIEWABLE_TEXT_MIME_TYPES` | `mimeTypes` of `preview.kind === "text"` entries | DELETE | module-private |
| 5 | `src/lib/utils/file-preview.ts:98` | `GENERIC_MIME_TYPES` | `GENERIC_MIME_TYPES` from registry | DELETE | module-private |
| 6 | `src/lib/utils/file-preview.ts:103` | `IMAGE_EXTENSIONS` | `category === "image"` | DELETE | module-private |
| 7 | `src/lib/utils/file-preview.ts:119` | `EXTENSION_CONTENT_TYPES` | `getCanonicalMimeForExtension` | DELETE | module-private |
| 8 | `src/lib/utils/file-preview.ts:192` | `TRUSTED_PREVIEW_EXTENSIONS` | `preview.extensionAuthoritative` | DELETE | module-private |
| 9 | `src/lib/utils/file-preview.ts:202` | `MIME_TO_PREVIEW_TYPE` | **kept** as the unknown-extension fallback chain, but built from the registry (pdf/wordprocessingml/spreadsheetml/presentationml/odt/image-prefix/text-html/text-prefix) | REWRITE | module-private |
| 10 | `src/lib/utils/file-preview.ts:241,290` | `EXTENSION_TO_PREVIEW_LANGUAGE`, `MIME_TO_PREVIEW_LANGUAGE` | `preview.language` | DELETE | module-private |
| 11 | `src/lib/utils/file-preview.ts:1` | `PreviewFileType` | `PreviewKind` | THIN: `export type PreviewFileType = PreviewKind;` | — |
| 12 | `src/lib/utils/file-preview.ts:357,369,391,398` | `getPreviewContentType`, `determinePreviewFileType`, `isPreviewableFile`, `getPreviewLanguage` | `getContentTypeForFile`, `getPreviewKind`, `isPreviewable`, `getPreviewLanguage` | THIN (signatures unchanged; `file-preview.ts` becomes ~25 lines of re-exports) | **none** — `generated-file-serving.ts:20`, `knowledge/store/working-document-file-serving.ts:10`, `document-workspace/OpenDocumentsRail.svelte:4`, `preview-runtime/index.ts:5`, `DocumentPreviewRenderer.svelte:5`, `DocumentWorkspace.svelte:3` keep compiling unchanged |
| 13 | `src/lib/components/chat/attachment-file-type.ts:31-73` | `IMAGE/SPREADSHEET/PRESENTATION/DOCUMENT/CODE/ARCHIVE_EXTENSIONS`, `OOXML_*` | `getCategory` | DELETE | module-private |
| 14 | `src/lib/components/chat/attachment-file-type.ts:82` | `getFileType` | `getCategory` + a 10-line `CATEGORY_TO_ATTACHMENT_TYPE` map | REWRITE (signature + `AttachmentFileType` union unchanged) | **none** — `FileAttachment.svelte:12`, `composer-chip-presentation.ts:10` unchanged |
| 15 | `src/lib/components/chat/attachment-file-type.ts:76` | `fileExtension` | registry `fileExtension` | THIN re-export | `attachment-file-type.test.ts:2` keeps importing from here |
| 16 | `src/lib/utils/file-drag.ts:47` | `partitionUploadableFiles` | keep, but `options.acceptedTypes` becomes **optional**; default `getAcceptAttribute(options.surface ?? "knowledge")` | REWRITE (add `surface?: UploadSurface`) | `DocumentsList.svelte:4` (pass `surface: "knowledge"`), `+page.svelte:54` / `chat/[conversationId]/_helpers.ts:32` use only `isOsFileDropEvent` — unchanged |
| 17 | `src/routes/(app)/knowledge/_components/DocumentsList.svelte:190` | `acceptedFileTypes` | `getAcceptAttribute("knowledge")` | DELETE, inline the call | `:837` `accept={acceptedFileTypes}` |
| 18 | `…/DocumentsList.svelte:187` | `MAX_FILE_UPLOAD_SIZE_BYTES` | `$uploadLimits.maxFileUploadSize` (§4.3) | DELETE | — |
| 19 | `…/DocumentsList.svelte:564` | `formatFileType` | `getEntryByFilename(name)?.extensions[0].toUpperCase()` with the same fallbacks | REWRITE | — |
| 20 | `…/DocumentsList.svelte:623` | `getFileIcon` | `getCategory` + `CATEGORY_TO_ICON` record | REWRITE | — |
| 21 | `src/lib/components/chat/MessageInput.svelte:2483` | `MAX_FILE_SIZE` + `max: 100` at `:2487,:2499` | `$uploadLimits` | DELETE | — |
| 22 | `src/lib/components/chat/MessageInput.svelte:2742` | file input with no `accept` | `accept={getAcceptAttribute('chat')}` | ADD | — |
| 23 | `src/lib/components/chat/AttachmentPickerSheet.svelte:23` | `maxUploadMb = 100` | default from `$uploadLimits` | REWRITE | `MessageInput.svelte:3246` |
| 24 | `src/lib/components/chat/AttachmentPickerSheet.svelte:81,89` | `accept="image/*"` | `accept="image/*"` **kept** (photo-picker intent, not a type gate) | NO CHANGE | — |
| 25 | `src/lib/components/chat/ComposerToolsMenu.svelte:96` | `maxUploadMb = 100` | default from `$uploadLimits` | REWRITE | `MessageInput.svelte:2976` |
| 26 | `src/lib/server/services/file-production/output-types.ts:7` | `OUTPUT_TYPE_EXTENSIONS` | `production.types` | DELETE; module becomes a 6-line re-export of `$lib/shared/file-types/production` | **none** — `intake.ts:6`, `produce-file.ts:6`, `output-validation.ts:7,12`, `output-types.test.ts:10` unchanged |
| 27 | `…/output-types.ts:134` | `FILE_PRODUCTION_OUTPUT_TYPE_EXAMPLES` | derived from `exampleRank` | THIN re-export | — |
| 28 | `src/lib/server/services/normal-chat-tools/produce-file.ts:686` | duplicate `OUTPUT_TYPE_EXTENSIONS` | `getExpectedExtensionForOutputType` (strip the leading dot at `:722`) | DELETE | module-private |
| 29 | `…/produce-file.ts:675` | `shouldUseDocumentSourceForOutputs` | registry `shouldUseDocumentSourceForOutputs` | THIN wrapper (call site passes `outputs.map(o => o.type)`) | module-private |
| 30 | `src/lib/server/services/file-production/output-validation.ts:14` | `EXTENSION_MIME_TYPES` | `getAllowedMimeTypesForProducedExtension` | DELETE | module-private |
| 31 | `…/output-validation.ts:82` | `GENERIC_MIME_TYPES` | registry `isGenericMimeType` | DELETE | module-private |
| 32 | `…/output-validation.ts:87` | `TEXT_LIKE_EXTENSIONS` / `isTextLikeExtension` | registry `isTextLikeExtension` | DELETE / THIN | module-private |
| 33 | `…/output-validation.ts:138` | `XLSX_MIME_TYPE` | `getCanonicalMimeForExtension("xlsx")` | DELETE | module-private |
| 34 | `src/lib/server/services/file-production/execution-adapter.ts:98` | `normalizeDocumentOutput` | registry `normalizeDocumentOutput` | DELETE, import instead | `selectDocumentOutputs:117` |
| 35 | `src/lib/server/services/sandbox-execution.ts:30` | `MIME_TYPES` | `getSandboxMimeTypeForExtension` | DELETE | module-private |
| 36 | `src/lib/server/services/generated-file-serving.ts:45` | `FULL_VALIDATION_EXTENSIONS` | `requiresFullContentValidation` | DELETE | module-private |
| 37 | `src/lib/server/services/normal-chat-tools/read-generated-file.ts:98-103` | inline `isTextBased` MIME test | `getEntryByMimeType(mime)?.textLike === true` \|\| `mime.startsWith("text/")` | REWRITE — **must keep** `application/x-yaml` (a MIME that appears nowhere else); add it as a `yaml` alias | module-private |
| 38 | `src/lib/components/document-workspace/preview-runtime/office/index.ts:3` | `OfficePreviewKind` union | `Extract<PreviewKind, "docx"\|"xlsx"\|"pptx"\|"odt">` | THIN (type only) | `preview-runtime/index.ts:6`, `DocumentPreviewRenderer.svelte` |
| 39 | `…/preview-runtime/index.ts:164` | inline `{ kind: "docx"\|"xlsx"\|"pptx"\|"odt" }` | `OfficePreviewKind` | REWRITE | — |
| 40 | `…/DocumentPreviewRenderer.svelte:206-213,339` | the union restated twice | `isOfficePreviewKind(kind)` type guard exported from `preview-runtime/office` | REWRITE | — |
| 41 | `src/lib/server/services/knowledge/store/attachments.ts:234` | prose "Supported extraction currently works best for …" | `getSupportedExtractionSummary("en")` | REWRITE | module-private |
| 42 | `src/lib/server/prompts.ts:156` | `produce_file` row prose | **KEPT hand-written**; a test asserts every format token it names is `requestable` (§6.4) | NO CHANGE | — |
| 43 | `src/lib/server/services/normal-chat-tools/index.ts:285` (EN), `:377` (HU) | `produce_file` descriptions | **KEPT hand-written**; same token test | NO CHANGE | — |
| 44 | `src/routes/api/settings/avatar/+server.ts:11` | `ALLOWED_TYPES` | `FILE_TYPE_ENTRIES.filter(e => e.category === "image" && e.id !== "svg").map(canonical MIME)` — reproduces the 9 current values exactly | REWRITE | — |
| 45 | `src/lib/server/services/campaign-assets.ts:9` | `ALLOWED_IMAGE_TYPES` | `category === "image"` (includes svg) — reproduces the 10 current values exactly | REWRITE | — |
| 46 | `src/lib/server/services/campaign-assets.ts:22` | `MIME_EXTENSIONS` | `getEntryByMimeType(m)?.extensions[0] ?? "bin"` — **note** the current map has `"image/tiff" → "tiff"` while the registry canonical is `tif`; keep a 1-entry override or set `tif`'s canonical extension order to `["tiff","tif"]`. **Decision: leave `MIME_EXTENSIONS` in place** and add a test asserting every key is a registry image MIME. | NO CHANGE + test | — |
| 47 | `src/lib/server/services/file-production/image-loader.ts:14` | `IMAGE_MIME_TYPES` (png/jpeg/webp only) | **KEPT as-is** — it is a renderer capability list, not a file-type fact | NO CHANGE | — |
| 48 | `src/lib/server/services/knowledge/upload-intake.ts:53` | `resolveKnowledgeUploadLimits` | unchanged, but `KnowledgeUploadLimits` gains nothing; the **type allowlist** is enforced in the route (§4.1) | NO CHANGE | — |
| 49 | `src/routes/api/knowledge/upload/intent/+server.ts` | — | add the allowlist check (§4.1) | ADD | — |
| 50 | `src/lib/client/api/knowledge.ts:323` | `uploadKnowledgeAttachment` | publish `intent.maxFileUploadSize` into the `uploadLimits` store (§4.3) | ADD 2 lines | — |
| 51 | `src/lib/i18n/knowledge.ts:39` / `src/lib/i18n/chat.ts:20` | `"…(max 100MB per file)"` EN+HU | `{max}` placeholder fed from `$uploadLimits` | REWRITE | `DropZoneOverlay.test.ts:24,35` |

### 3b. Additional maps found by sweep — explicit scope decisions

These were not in the original brief. Each is either assigned to a slice or explicitly deferred;
a deferred one **must** be in the §6.3 allowlist with this row as its reason.

| # | File:line | Symbol | Decision | Slice |
| --- | --- | --- | --- | --- |
| 52 | `src/lib/components/ui/FileTypeIcon.svelte:28` | `iconMap` (`pdf/docx/xlsx/pptx/odt/image/text/html/code/archive` → Lucide) | **IN.** This is the canonical glyph vocabulary; `DocumentsList.getFileIcon` duplicates it. Rekey it on `FileTypeCategory` and make `DocumentsList` render `<FileTypeIcon>` instead of its own `getFileIcon`. Checklist row 20 folds into this. | **B** (component) + **C** (DocumentsList call site) |
| 53 | `src/lib/server/services/file-production/intake.ts:158` | `outputTypeFromFilename` + `:188 normalizeProgramOutputs` | **IN.** Third independent copy of extension→output-type (the others are `output-validation.ts:181`, `produce-file.ts:657`). All three collapse to `getEntryForOutputType` + `getExpectedExtensionForOutputType`. | **D** (add `intake.ts` to D's OWNS) |
| 54 | `src/lib/server/services/chat-files.ts:370` & `src/lib/server/services/conversation-forks.ts:439` | `getFileExtension` (byte-identical copies, `"bin"` fallback) | **IN, minimal.** Both become `fileExtension(name) || "bin"` from the registry. No table is involved — this is the third/fourth copy of the parser, and the architecture test would otherwise not catch it. | **D** |
| 55 | `src/lib/server/services/knowledge/store/core.ts:204` | `fileExtension` (extname→lowercase, null fallback) | **IN, minimal.** Re-export the registry `fileExtension`. Callers at `attachments.ts:402,479,583` unchanged. | **C** (C already owns the knowledge upload path; add `store/core.ts` to C's OWNS) |
| 56 | `src/lib/server/services/normal-chat-tools/files.ts:131` | `TEXT_LIKE_MIME_TYPES` + `:139 isTextLike()` | **IN.** Same decision as checklist row 37: `getEntryByMimeType(m)?.textLike === true \|\| m.startsWith("text/")`. Verify the current members (json/xml/javascript/yaml) all survive. | **D** |
| 57 | `src/lib/server/favicon/fetch.ts:31` | `IMAGE_TYPES` (9 favicon MIMEs incl. `image/x-icon`, `image/vnd.microsoft.icon`) | **DEFER.** `x-icon`/`vnd.microsoft.icon` have no registry entry and adding `.ico` would widen the upload allowlist for no reason. Allowlist it. | — |
| 58 | `src/lib/server/services/file-serving-response-policy.ts:32,36,48` | `hasSvgFilename`, `normalizeServedContentType`, `isRestrictedPreview` | **DEFER.** This is a CSP/sandbox policy keyed on exactly two values (`text/html`, `image/svg+xml`). It is a security decision, not a type table; rewriting it against the registry in the same phase as the registry itself is a reviewability risk. Allowlist with this reason. | — |
| 59 | `src/lib/server/services/generated-file-serving.ts:206` | `resolvePreviewProfile` (`text/html` branch) | **DEFER** for the same reason as #58, even though slice D owns the file. D must not touch `:206`. | — |
| 60 | `src/lib/server/services/file-production/image-loader.ts:55` | `detectImageMimeType` (hand-rolled PNG/JPEG/WebP magic bytes) | **READ-ONLY PRECEDENT.** Do not change it, but §4.2's signature matcher must follow its style (same byte-comparison helper shape) so a reviewer sees one idiom, not two. | — (cited by **C**) |
| 61 | `src/lib/server/services/working-document-selection.ts:6-18` | 4 regexes hardcoding `pdf\|docx\|xlsx\|pptx\|csv\|html` | **DEFER.** These are natural-language intent regexes over *user messages*, not file classification. Deriving an alternation from the registry would silently change intent detection. Allowlist. | — |
| 62 | `src/lib/server/services/skills/user-skills.ts:595,608,915-920` | EN/HU built-in skill instructions naming `.xlsx/.xls/.csv/.tsv` | **IN, verification only.** Same treatment as `prompts.ts` (row 42): prose stays, §6.4's token test extends to cover it. `.tsv` is named in prose but has **no registry entry** — see open question 12. | **E** |
| 63 | `scripts/skill-eval-fixtures.ts:138-140` | duplicated skill prose | **IN, verification only.** §6.4 asserts it is byte-identical to `user-skills.ts`'s copy. | **E** |
| 64 | `scripts/verify-live-file-production-types.ts:205-400` | full parallel `expectedExtension`/`expectedMimePrefix` table (12 types) | **IN.** This is a genuine second source of truth for production types. Rewrite against `getExpectedExtensionForOutputType` + `getCanonicalMimeForExtension`. It is a script, not shipped code, so it is low-risk and high-value. | **D** |
| 65 | `src/routes/api/admin/model-icons/upload/+server.ts:26` | `uploadMimeType` (infers `image/svg+xml` from `.svg`) | **DEFER.** Admin-only, single extension. Allowlist. | — |
| 66 | `src/routes/api/chat/import/+server.ts:29` | inline `.zip` gate | **DEFER.** ChatGPT-export import, a separate feature with its own endpoint; folding it in would make `.zip` look uploadable. Allowlist (pairs with `ImportChatGPTModal.svelte`). | — |
| 67 | `src/routes/api/map-tiles/[z]/[x]/[y]/+server.ts:31,36,49` | `Y_SEGMENT_RE`, `TILE_RESPONSE_HEADERS`, `isImageResponse` | **DEFER.** Map tiles are a fixed-format proxy, not user files. Allowlist. | — |
| 68 | `src/lib/components/ui/ProfilePictureEditor.svelte:57,61,317,403` | `image/` gate, 20 MB gate, `toBlob("image/webp")`, accept string | **DEFER** (open question 9). Allowlist. Note `:61`'s 20 MB gate pairs with `avatar/+server.ts:10` `MAX_FILE_SIZE` and `campaign-assets.ts:8` `MAX_IMAGE_BYTES` — **three** independent 20 MB image caps, out of scope here. | — |
| 69 | `src/lib/server/services/file-production/renderers/{standard-report-pdf,docx,html,markdown}.ts` | `slugifyFilename(title, ext)` / `filenameForTitle` hardcoding `.pdf`/`docx`/`html`/`.md` | **DEFER.** Each renderer produces exactly one format by construction; the literal is its identity, not a table. Under the §6.3 threshold anyway (1 extension each). | — |
| 70 | `src/lib/server/services/atlas/renderer-output.ts:2143-2196` | picks outputs by `text/html`/`application/pdf`/`text/markdown` | **DEFER.** Atlas is a separate pipeline; it has its own PR queue. Allowlist. | — |
| 71 | `src/lib/server/services/knowledge.ts:307`, `knowledge/capsules.ts:176,368`, `knowledge/store/documents.ts:341` | hardcoded `extension: "md"` / `"txt"` on artifact creation | **DEFER.** Each is a single literal naming the format that code *writes*, not a classification. Under threshold. | — |
| 72 | `src/lib/components/document-workspace/preview-runtime/text/index.ts:12,40` | `TextPreviewRenderResult` kinds, csv/markdown/highlighted dispatch | **IN.** Sibling of the preview-runtime files in checklist rows 38-40; `getTextPreviewKind` (`preview-runtime/index.ts:301-312`) should read `entry.id === "csv"` / `"md"`. | **B** (add to B's OWNS) |
| 73 | `src/lib/server/sandbox/config.ts:14` | `SANDBOX_MAX_FILE_MB = 100` (+ `:343` tmpfs `size=100m`) | **OUT OF SCOPE.** This is the sandbox *output* cap, unrelated to the upload cap (§4.3). It must **not** be folded into `maxFileUploadSize`. Named here so a reviewer does not flag its survival as an oversight. | — |
| 74 | `scripts/patch-body-size-limit.mjs:5` | `DEFAULT_BODY_SIZE_LIMIT = "100M"` | **OUT OF SCOPE.** Build-time adapter-node patch; `getAdapterBodySizeLimitBytes()` already reads the real value at runtime (`upload-intake.ts:47-52`). | — |
| 75 | `src/lib/i18n/settings.ts:267,2110` | admin help text "default 104857600 = 100MB" | **OUT OF SCOPE.** Describes the env-var default, not a live limit. Leave. | — |
| 76 | `.env.example:348`, `docs/configuration.md:23,35,286`, `docs/uploads.md:35`, `deploy/README.md:522`, `README.md:91` | restate 100 MB | **OUT OF SCOPE** (docs). | — |

**Importer sweep result** — every module that imports one of the replaced symbols:
`src/lib/server/services/generated-file-serving.ts:20`, `src/lib/server/services/knowledge/store/working-document-file-serving.ts:10`,
`src/lib/components/document-workspace/{OpenDocumentsRail.svelte:4, DocumentWorkspace.svelte:3, DocumentPreviewRenderer.svelte:5, preview-runtime/index.ts:5}`,
`src/lib/components/chat/{FileAttachment.svelte:12, composer-chip-presentation.ts:10}`,
`src/routes/(app)/{+page.svelte:54, chat/[conversationId]/_helpers.ts:32, knowledge/_components/DocumentsList.svelte:4}`,
`src/lib/server/services/file-production/{intake.ts:6, output-validation.ts:7,12}`,
`src/lib/server/services/normal-chat-tools/produce-file.ts:6`.
Because rows 11, 12, 14, 15, 26, 27, 38 are `THIN`, **none of these files needs an import change**.
That is deliberate: it keeps slice boundaries clean.

---

## 4. Server allowlist, magic bytes, and limits

### 4.1 `/api/knowledge/upload/intent` — exact behaviour

Insert a third check in `POST` (`src/routes/api/knowledge/upload/intent/+server.ts`), **after** the
existing `upload_size_required` (400) and `upload_file_too_large` (413) checks and **before**
`validateKnowledgeUploadConversation`. Order is load-bearing: `upload-intent.test.ts:165` posts an
oversized file with no `fileName` and expects 413.

```ts
const admission = admitUpload(intent.fileName ?? "", intent.mimeType);
if (!admission.allowed) {
	return json({
		error: UPLOAD_REJECT_MESSAGES_EN[admission.reason],
		code: "upload_unsupported_type",
		errorKey: UPLOAD_REJECT_I18N_KEYS[admission.reason],
		traceId,
		details: {
			fileName: intent.fileName,
			extension: fileExtension(intent.fileName ?? "") || null,
			reason: admission.reason,
		},
	}, { status: 415 });
}
```

- **Status:** `415`.
- **`code`:** `"upload_unsupported_type"` for every reason (one machine code; `details.reason` discriminates).
- **`errorKey`** (already plumbed to the client by `src/lib/client/api/http.ts:75-91` → `ApiError.errorKey`):

| `details.reason` | `errorKey` | EN | HU |
| --- | --- | --- | --- |
| `unknownType` | `knowledge.uploadUnsupportedType` | `We can't read {name} — that file type isn't supported.` | `A(z) {name} fájlt nem tudjuk olvasni — ez a fájltípus nem támogatott.` |
| `media` | `knowledge.uploadRejectedMedia` | `Audio and video files can't be read yet. Upload a document or an image instead.` | `Hang- és videofájlokat még nem tudunk olvasni. Tölts fel helyette dokumentumot vagy képet.` |
| `archive` | `knowledge.uploadRejectedArchive` | `Archives can't be opened on upload. Unpack it and upload the files inside.` | `Az archívumokat feltöltéskor nem tudjuk kibontani. Csomagold ki, és töltsd fel a benne lévő fájlokat.` |
| `formatNotEnabled` | `knowledge.uploadRejectedFormatNotEnabled` | `{ext} files aren't supported yet. Save it as PDF or DOCX and upload that.` | `A(z) {ext} fájlokat még nem támogatjuk. Mentsd el PDF- vagy DOCX-formátumban, és azt töltsd fel.` |
| (content mismatch, §4.2) | `knowledge.uploadContentMismatch` | `{name} doesn't look like a real {ext} file — its contents don't match its extension.` | `A(z) {name} nem valódi {ext} fájlnak tűnik — a tartalma nem illik a kiterjesztéséhez.` |

All 5 keys go in **both** `en` and `hu` blocks of `src/lib/i18n/knowledge.ts`.
**Required:** add `"knowledge.upload"` to `AUDITED_PREFIXES` in `src/lib/i18n.test-helpers.ts:21-45`
— `knowledge.` is **not** currently audited, so without this the EN/HU parity test
(`src/lib/i18n.test.ts:14-19`) would not notice a missing Hungarian key. Use the narrow
`"knowledge.upload"` prefix, not `"knowledge."`, to avoid surfacing pre-existing drift in this phase.

The `error` string stays English (the endpoint is not locale-aware today); the client renders
`$t(err.errorKey)` when present and falls back to `err.message`.

**Client side:** `DocumentsList.svelte`'s drop handler and `MessageInput.svelte`'s `uploadFiles`
must catch `ApiError` with `code === "upload_unsupported_type"` and show `$t(errorKey)`.
`partitionUploadableFiles` already pre-filters on the accept string, so a 415 in the knowledge
surface is only reachable via the OS picker's "All files" escape hatch.

### 4.2 Magic-byte check on upload completion

**Location:** a new `src/lib/server/services/knowledge/upload-signature.ts`, called from
`completeKnowledgeUploadFromStoredFile` and `completeKnowledgeUploadFromFile`
(`src/lib/server/services/knowledge/upload-intake.ts:243,275`) **before** `saveUploadedArtifact*`.

**Scope:** only entries that declare `signatures`. Text and text-like types are never sniffed
(any byte sequence is a legal text file). Signatures to declare:

| entries | offset | bytes |
| --- | --- | --- |
| `pdf` | 0 | `25 50 44 46 2D` (`%PDF-`) |
| `docx xlsx pptx odt ods odp zip` | 0 | `50 4B 03 04`, or `50 4B 05 06`, or `50 4B 07 08` |
| `doc xls ppt` | 0 | `D0 CF 11 E0 A1 B1 1A E1` (OLE2 CFB) |
| `png` | 0 | `89 50 4E 47 0D 0A 1A 0A` |
| `jpg` | 0 | `FF D8 FF` |
| `gif` | 0 | `47 49 46 38` (`GIF8`) |
| `webp` | 0 / 8 | `52 49 46 46` + any 4 + `57 45 42 50` → `[0x52,0x49,0x46,0x46,null,null,null,null,0x57,0x45,0x42,0x50]` |
| `bmp` | 0 | `42 4D` |
| `tif` | 0 | `49 49 2A 00` or `4D 4D 00 2A` |
| `heic heif avif` | 4 | `66 74 79 70` (`ftyp`) |
| `mp3` | 0 | `49 44 33` (`ID3`) or `FF FB` |
| `mp4 mov` | 4 | `66 74 79 70` |
| `rar` | 0 | `52 61 72 21 1A 07` |
| `7z` | 0 | `37 7A BC AF 27 1C` |
| `gz` | 0 | `1F 8B` |

Deliberately **no signature** for: `svg` (text), `rtf` (never ingested anyway), all text/code
entries, `wav`/`ogg`/`flac`/`avi`/`mkv`/`webm` (rejected at intent, never reach completion).

**Library: none.** `package.json` has no `file-type`/`mmmagic` dependency and must not gain one.
The table above is 16 signatures ≈ 60 lines of data and a 15-line matcher. `file-type` is
ESM-only with a large transitive tree; adding it for this would inflate the server bundle and
the `npm ci` surface (see the repo's Node-22/better-sqlite3 constraint) for no gain.

**Precedent to follow:** `src/lib/server/services/file-production/image-loader.ts:55`
`detectImageMimeType` already hand-rolls PNG/JPEG/WebP magic-byte detection in this codebase.
The new matcher must reuse its byte-comparison idiom (offset + `readUInt8` comparisons, `null`
for wildcard bytes) so a reviewer sees one style, not two. Do **not** refactor `image-loader.ts`
itself — it sniffs an already-trusted buffer for renderer dispatch, which is a different job.

**Implementation:** read the first 16 bytes with `fs.promises.open` + `read` (never the whole file;
uploads are up to 100 MB). Return `{ ok: true }` when the entry has no signatures or one matches.
On mismatch: `unlink` the temp file, then throw a `KnowledgeUploadContentMismatchError`
(`status = 415`, `code = "upload_content_mismatch"`, `errorKey = "knowledge.uploadContentMismatch"`),
handled in `raw/+server.ts`, `chunk/+server.ts` and `upload/+server.ts` alongside the existing
`isKnowledgeUploadConversationError` branches.

### 4.3 Replacing the four hardcoded 100 MB copies

The copies (all four are client-side defaults; there is no shared client constant today):

| # | Location | Today |
| --- | --- | --- |
| 1 | `src/routes/(app)/knowledge/_components/DocumentsList.svelte:187` | `const MAX_FILE_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024;` |
| 2 | `src/lib/components/chat/MessageInput.svelte:2483` (+ literal `max: 100` at `:2487`, `:2499`) | `const MAX_FILE_SIZE = 100 * 1024 * 1024;` |
| 3 | `src/lib/components/chat/AttachmentPickerSheet.svelte:23` | `maxUploadMb = 100` |
| 4 | `src/lib/components/chat/ComposerToolsMenu.svelte:96` | `maxUploadMb = 100` |

Plus 4 i18n literals: `knowledge.dropFiles` (EN `src/lib/i18n/knowledge.ts:39`, HU `:383`) and
`chat.dropZone.attach` (EN `src/lib/i18n/chat.ts:20`, HU).

**Replacement — new `src/lib/stores/upload-limits.ts`:**

```ts
import { writable, derived } from "svelte/store";
import { DEFAULT_MAX_FILE_UPLOAD_SIZE_BYTES } from "$lib/shared/file-types";

export const maxFileUploadSizeBytes = writable(DEFAULT_MAX_FILE_UPLOAD_SIZE_BYTES);
export const maxFileUploadSizeMb = derived(maxFileUploadSizeBytes, b => Math.round(b / (1024 * 1024)));
/** Called from the intent response and from the SSR shell payload. Ignores non-positive values. */
export function setMaxFileUploadSize(bytes: number | undefined): void;
```

Two writers, both required:

1. **SSR seed** — add `maxFileUploadSize: config.maxFileUploadSize` to `AppShellData`
   (`src/lib/server/services/app-shell.ts:33-52`, next to the existing `maxMessageLength: config.maxMessageLength`
   at `:85` — same pattern, same `getConfig()` call, no extra query) and call
   `setMaxFileUploadSize(data.maxFileUploadSize)` from `src/routes/(app)/+layout.svelte`.
   Needed because drag-and-drop partitioning happens *before* any intent request.
2. **Intent response (authoritative)** — in `uploadKnowledgeAttachment`
   (`src/lib/client/api/knowledge.ts:328-344`), after the intent resolves, call
   `setMaxFileUploadSize(intent.maxFileUploadSize)`. Also call it from the `413` error branch using
   `details.maxFileUploadSize` so a lowered admin limit propagates immediately.

Components then read `$maxFileUploadSizeBytes` / `$maxFileUploadSizeMb`, and `AttachmentPickerSheet`
and `ComposerToolsMenu` change their `maxUploadMb` prop default from `100` to `undefined` with
`maxUploadMb ?? $maxFileUploadSizeMb` at the use site. The two i18n strings become
`"Drop files here to upload (max {max}MB per file)"` / `"... (max {max} MB fájlonként)"` with
`$t('knowledge.dropFiles', { max: $maxFileUploadSizeMb })`.

---

## 5. Work slices

Five slices. **A must land first.** Every signature in §1 is frozen by this spec, so B–E can be
written against it before A merges: each of B–E starts by creating a local
`src/lib/shared/file-types/index.ts` stub returning the values in §2.1, then deletes the stub and
rebases onto A. No slice may edit a file owned by another slice.

### Slice A — the registry module *(blocking)*

**Goal:** `src/lib/shared/file-types/**` with the §1 contract and the §2.1 table, plus the
equivalence test that unblocks deletion everywhere else.

**OWNS (exclusive):**
- `src/lib/shared/file-types/types.ts` *(new)*
- `src/lib/shared/file-types/table.ts` *(new)*
- `src/lib/shared/file-types/index.ts` *(new)*
- `src/lib/shared/file-types/production.ts` *(new)*
- `src/lib/shared/file-types/model-facing.ts` *(new)*
- `src/lib/shared/file-types/registry.test.ts` *(new)*
- `src/lib/shared/file-types/legacy-equivalence.test.ts` *(new)*
- `src/lib/shared/file-types/no-ad-hoc-maps.test.ts` *(new)*

**READ-ONLY:** every file in §3 (to transcribe the tables).

**Depends on:** nothing. **Blocks:** B, C, D, E.

**Tests:** §6.1, §6.2, §6.3. `legacy-equivalence.test.ts` **inlines frozen copies** of the old
maps as literals, so it keeps passing after B–E delete the originals.

**Done when:** `npx vitest run src/lib/shared/file-types` is green; `table.ts` has zero value
imports; `getAcceptAttribute("knowledge")` returns the exact `DocumentsList` literal;
`FILE_PRODUCTION_OUTPUT_TYPE_EXAMPLES` is byte-identical to `"xlsx, docx, pptx, pdf, csv, zip"`;
the derived output-token map deep-equals the frozen `OUTPUT_TYPE_EXTENSIONS`.

---

### Slice B — client presentation (preview, glyphs, drag)

**Goal:** every client-side classification reads the registry. No visible change.

**OWNS (exclusive):**
- `src/lib/utils/file-preview.ts` + `src/lib/utils/file-preview.test.ts`
- `src/lib/utils/file-drag.ts` + `src/lib/utils/file-drag.test.ts`
- `src/lib/components/chat/attachment-file-type.ts` + `attachment-file-type.test.ts`
- `src/lib/components/chat/composer-chip-presentation.ts` + `composer-chip-presentation.test.ts`
- `src/lib/components/chat/FileAttachment.svelte` + `FileAttachment.test.ts`
- `src/lib/components/document-workspace/preview-runtime/index.ts`
- `src/lib/components/document-workspace/preview-runtime/office/index.ts`
- `src/lib/components/document-workspace/preview-runtime/text/index.ts`
- `src/lib/components/document-workspace/preview-runtime/preview-runtime.test.ts`
- `src/lib/components/document-workspace/DocumentPreviewRenderer.svelte` + `.test.ts`
- `src/lib/components/document-workspace/OpenDocumentsRail.svelte`
- `src/lib/components/document-workspace/DocumentWorkspace.svelte`
- `src/lib/components/ui/FileTypeIcon.svelte` *(rekey `iconMap` on `FileTypeCategory`; keep the current prop name working via a `PreviewKind | FileTypeCategory` union so `OpenDocumentsRail.svelte:117` and `FileAttachment.svelte:137` keep compiling)*

**READ-ONLY:** `src/lib/shared/file-types/**`, `DocumentsList.svelte` (owned by C).

**Checklist rows:** 3–16, 38–40, 52 (component half), 72.

**Depends on:** A. **Stub target:** `getPreviewKind`, `getPreviewLanguage`, `getContentTypeForFile`,
`getCategory`, `getAcceptAttribute`, `fileExtension`.

**Tests:**
- Update `src/lib/utils/file-preview.test.ts` — keep every existing case; add one per §2.3 ⚠1/⚠2 delta.
- Update `src/lib/utils/file-drag.test.ts` — replace the literal accept string with `getAcceptAttribute("knowledge")`; `SIZE_LIMIT` at `:10` stays a test constant.
- Update `src/lib/components/chat/attachment-file-type.test.ts` — unchanged expectations; the `.docx` regression guard in the file header must stay green.
- New `src/lib/components/chat/attachment-category-parity.test.ts` — for all 92 extensions, `getFileType` today == `getFileType` after (table of expectations transcribed from the frozen maps).

**Done when:** `npx vitest run src/lib/utils src/lib/components/chat src/lib/components/document-workspace` is green and `file-preview.ts` contains no extension or MIME string literal.

---

### Slice C — upload path, server allowlist, limits, i18n *(hot: i18n)*

**Goal:** exception (b) + (c) enforced; the four 100 MB copies gone.

**OWNS (exclusive):**
- `src/routes/api/knowledge/upload/intent/+server.ts` + `upload-intent.test.ts`
- `src/routes/api/knowledge/upload/raw/+server.ts`, `chunk/+server.ts`, `+server.ts`, `shared.ts`, `upload.test.ts`, `test-helpers.ts`
- `src/lib/server/services/knowledge/upload-intake.ts`
- `src/lib/server/services/knowledge/upload-signature.ts` *(new)* + `upload-signature.test.ts` *(new)*
- `src/lib/server/services/knowledge/store/core.ts` *(row 55: `fileExtension` becomes a re-export)*
- `src/lib/client/api/knowledge.ts`
- `src/lib/stores/upload-limits.ts` *(new)* + `upload-limits.test.ts` *(new)*
- `src/lib/server/services/app-shell.ts` + `src/routes/(app)/+layout.svelte`
- `src/lib/components/chat/MessageInput.svelte` + `MessageInput.test.ts`
- `src/lib/components/chat/AttachmentPickerSheet.svelte`
- `src/lib/components/chat/ComposerToolsMenu.svelte` + `ComposerToolsMenu.test.ts`
- `src/lib/components/chat/DropZoneOverlay.svelte` + `DropZoneOverlay.test.ts`
- `src/routes/(app)/knowledge/_components/DocumentsList.svelte` + `DocumentsList.test.ts` *(row 52: delete `getFileIcon`, render `<FileTypeIcon category={getCategory(...)}>`)*
- **`src/lib/i18n/knowledge.ts`** — HOT, sole owner
- **`src/lib/i18n/chat.ts`** — HOT, sole owner
- **`src/lib/i18n.test-helpers.ts`** — HOT, sole owner (adds `"knowledge.upload"` to `AUDITED_PREFIXES`)

**READ-ONLY:** `src/lib/shared/file-types/**`, `src/lib/utils/file-drag.ts` (owned by B — C calls
`partitionUploadableFiles({ surface: "knowledge", ... })`; if B has not landed, C passes
`acceptedTypes: getAcceptAttribute("knowledge")` and B removes the redundant argument on rebase).
`src/lib/server/config-store.ts` and `src/lib/server/env.ts` — **read-only, nobody owns them, no
change is needed**: `maxFileUploadSize` already exists (`env.ts:885`, `config-store.ts:1310`).

**Checklist rows:** 17, 18, 21–25, 48–51.

**Depends on:** A. **Tests:** §6.5.

**Done when:** `npx vitest run src/routes/api/knowledge src/lib/i18n src/lib/components/chat src/lib/stores` is green;
`grep -rn "100 \* 1024 \* 1024" src/lib/components src/routes/\(app\)` returns nothing;
the i18n parity test fails if a `knowledge.upload*` key is added to only one language.

---

### Slice D — server production, sandbox, serving, extraction

**Goal:** every server-side extension/MIME table reads the registry.

**OWNS (exclusive):**
- `src/lib/server/services/file-production/output-types.ts` + `output-types.test.ts`
- `src/lib/server/services/file-production/output-validation.ts` + `output-validation.test.ts`
- `src/lib/server/services/file-production/intake.ts` *(row 53)*
- `src/lib/server/services/file-production/execution-adapter.ts`
- `src/lib/server/services/normal-chat-tools/produce-file.ts`
- `src/lib/server/services/normal-chat-tools/read-generated-file.ts`
- `src/lib/server/services/normal-chat-tools/files.ts` *(row 56)*
- `src/lib/server/services/sandbox-execution.ts`
- `src/lib/server/services/generated-file-serving.ts` *(**not** `:206 resolvePreviewProfile` — row 59)*
- `src/lib/server/services/document-extraction.ts`
- `src/lib/server/services/chat-files.ts`, `src/lib/server/services/conversation-forks.ts` *(row 54, `getFileExtension` only)*
- `scripts/verify-live-file-production-types.ts` *(row 64)*
- `src/lib/server/services/file-production/obsolete-surfaces.test.ts`

**READ-ONLY:** `src/lib/shared/file-types/**`, `src/lib/server/services/file-production/image-loader.ts`.
**Must NOT touch:** `src/lib/server/services/normal-chat-tools/index.ts` (slice E),
`src/lib/server/services/file-serving-response-policy.ts` (row 58, deferred).

**Checklist rows:** 1, 2, 26–37, 53, 54, 56, 64.

**Depends on:** A. **Tests:** §6.4, §6.6.

**Done when:** `npx vitest run src/lib/server/services` is green;
`output-types.test.ts`'s "keeps output-types itself free of heavy dependencies" assertion is
updated to point at `src/lib/shared/file-types/table.ts` and still passes;
`intake.ts` and `produce-file.ts` still import no `output-validation`.

---

### Slice E — model-facing text, prose, image allowlists, architecture test *(hot: normal-chat-tools/index.ts)*

**Goal:** the model-facing and user-facing prose derive from, or are verified against, the registry;
the "no new ad-hoc maps" guard lands.

**OWNS (exclusive):**
- **`src/lib/server/services/normal-chat-tools/index.ts`** — HOT, sole owner
- `src/lib/server/prompts.ts`
- `src/lib/server/services/knowledge/store/attachments.ts` + `attachments.test.ts`
- `src/routes/api/settings/avatar/+server.ts`
- `src/lib/server/services/campaign-assets.ts` + its tests
- `src/lib/server/services/skills/user-skills.ts` *(row 62 — prose unchanged; only the §6.4 token test touches it)*
- `scripts/skill-eval-fixtures.ts` *(row 63 — prose unchanged)*
- `src/lib/shared/file-types/model-facing.test.ts` *(new)*
- `src/lib/shared/file-types/format-prose.test.ts` *(new)* — §6.4

**READ-ONLY:** `src/lib/shared/file-types/**`, `src/lib/server/services/file-production/image-loader.ts` (row 47: no change).

**Checklist rows:** 41–47, 62, 63.

**Depends on:** A. Independent of B, C, D.

**Done when:** `npx vitest run src/lib/server src/routes/api/settings` is green; the produce_file
tool descriptions and `prompts.ts:156` are **byte-identical** to their pre-change text
(prompt-prefix cache preservation, §7); `getSupportedExtractionSummary("en")` renders a string whose
format list is a superset of today's literal.

---

### Hot-file assignment summary

| File | Touched by concerns | Sole owner |
| --- | --- | --- |
| `src/lib/i18n/knowledge.ts` | upload errors, drop-zone limit text | **C** |
| `src/lib/i18n/chat.ts` | drop-zone limit text, size-exceeded text | **C** |
| `src/lib/i18n.test-helpers.ts` | parity audit prefixes | **C** |
| `src/lib/server/services/normal-chat-tools/index.ts` | EN + HU tool descriptions | **E** |
| `src/lib/server/services/normal-chat-tools/produce-file.ts` | output extensions, documentSource | **D** |
| `src/lib/server/config-store.ts` / `env.ts` | upload limit source | **nobody — no change needed** |
| `src/routes/(app)/knowledge/_components/DocumentsList.svelte` | accept string, limit, icons, labels | **C** |
| `src/lib/components/chat/MessageInput.svelte` | limit, accept attr | **C** |
| `src/lib/server/services/file-production/output-types.ts` | production tokens | **D** |
| `src/lib/components/ui/FileTypeIcon.svelte` | glyph vocabulary shared by chat + knowledge + workspace | **B** |
| `src/lib/server/services/file-production/intake.ts` | 3rd `outputTypeFromFilename` copy | **D** |
| `src/lib/server/services/knowledge/store/core.ts` | `fileExtension` parser | **C** |
| `src/lib/server/services/generated-file-serving.ts` | `FULL_VALIDATION_EXTENSIONS` (D) vs `resolvePreviewProfile` CSP (deferred) | **D**, `:206` frozen |

---

## 6. Tests

### 6.1 `src/lib/shared/file-types/registry.test.ts` — structural invariants

- `id` unique; `id === extensions[0]`.
- Every extension appears in exactly **one** entry (assert across all 92).
- Extensions are lowercase, no leading dot, no dots inside.
- `mimeTypes` non-empty; every MIME lowercase and `/`-shaped.
- For every canonical MIME claimed by >1 entry, exactly one entry sets `ownsCanonicalMime`.
- `intake.route === "reject"` ⟺ `intake.rejectReason` present.
- **No entry uses the RESERVED routes:** `entries.filter(e => e.intake.route === "vision" || e.intake.route === "archive")` is `[]`.
- `production.requestable === false` ⟹ `production.types` is `{}`.
- `production.requestable === true` ⟹ `production.types` non-empty and every value starts with `.`.
- Every `production.types` value's extension exists in some entry's `extensions`.
- `production.documentSource === true` ⟹ `production.documentRenderKind` is set.
- `preview.language` values are unique per entry and drawn from a fixed allowlist.
- `SURFACE_ACCEPT_ORDER.knowledge` set-equals `{extensions of entries whose surfaces include "knowledge"}`.
- `table.ts` source contains no value import: `expect(src.match(/^import\s+(?!type\b)/gm)).toBeNull()`.

### 6.2 `src/lib/shared/file-types/legacy-equivalence.test.ts` — behaviour preservation *(written in slice A, BEFORE any deletion)*

Frozen copies of the 20 old maps are inlined **as literals in the test file**, each under a header
comment naming its original path and line. Assertions:

| Old map | Assertion |
| --- | --- |
| `OUTPUT_TYPE_EXTENSIONS` | `deepEqual(buildOutputTokenMap(), FROZEN_OUTPUT_TYPE_EXTENSIONS)` — exact, both directions |
| `EXTENSION_MIME_TYPES` | for each key, `getAllowedMimeTypesForProducedExtension(k)` deep-equals the frozen array (order included) |
| `TEXT_LIKE_EXTENSIONS` | set-equal to `{".":ext | entry.textLike}` |
| `FULL_VALIDATION_EXTENSIONS` | set-equal to `{textLike} ∪ {".xlsx"}` |
| `sandbox MIME_TYPES` | for each key, `getSandboxMimeTypeForExtension(k)` equals the frozen value — **except** `.js/.mjs/.cjs` where it already equals the new canonical |
| `EXTENSION_CONTENT_TYPES` | for each key, `getCanonicalMimeForExtension(k)` equals the frozen value — `KNOWN_DELTAS` ⚠1 (`js/mjs/cjs`) |
| `TEXT_EXTENSIONS` | set-equal to `{ext | preview.kind === "text"}` |
| `IMAGE_EXTENSIONS` (both copies) | set-equal to `{ext | category === "image"}` |
| `TRUSTED_PREVIEW_EXTENSIONS` | for each key, `getPreviewKind("x."+k, null)` equals the frozen kind |
| `EXTENSION_TO_PREVIEW_LANGUAGE`, `MIME_TO_PREVIEW_LANGUAGE` | for each key, `getPreviewLanguage` equals the frozen value |
| `PREVIEWABLE_TEXT_MIME_TYPES` | every member resolves to `preview.kind === "text"` |
| `getFileType` | 92-row table: extension → today's `AttachmentFileType`; assert the new implementation matches |
| `getFileIcon` / `formatFileType` | same, against a frozen extension → icon-name / label table |
| `acceptedFileTypes` | `getAcceptAttribute("knowledge") === FROZEN_ACCEPT_STRING` (string identity) |
| `isDirectTextExtractionFile` | for each of the 92 extensions, `getIntakeRoute` matches the frozen result, **except** the 33 in `KNOWN_DELTAS.directTextExpansion` (§2.4a) |
| `mimeFromExtension` | for each key, `getCanonicalMimeForExtension` matches — `KNOWN_DELTAS` ⚠1 |
| `shouldUseDocumentSourceForOutputs` | frozen truth table over `{pdf,docx,html,md,markdown,csv,xlsx,zip}` powerset samples |
| `normalizeDocumentOutput` | frozen 9-key table |
| `avatar ALLOWED_TYPES`, `campaign ALLOWED_IMAGE_TYPES` | derived list set-equals the frozen list |
| `FILE_PRODUCTION_OUTPUT_TYPE_EXAMPLES` | string identity |

`KNOWN_DELTAS` is a single exported object at the top of the file with one comment line per delta
pointing at §2.3/§2.4. **The reviewer's first check should be that this object has exactly three
groups: ⚠1 (`js/mjs/cjs` MIME), ⚠2 (`jfif` MIME), and the 33-extension direct-text expansion.**

### 6.3 `src/lib/shared/file-types/no-ad-hoc-maps.test.ts` — the architecture guard

Modelled on `src/lib/server/services/file-production/obsolete-surfaces.test.ts` (source-text
assertions, no AST, no build step).

**Detection.** Walk `src/**/*.{ts,svelte}` excluding `*.test.ts` and `src/lib/shared/file-types/**`.
For each file count **distinct** matches of two regexes:

```ts
const EXT_LITERAL = /(["'`])\.?(pdf|docx?|xlsx?|pptx?|odt|ods|odp|csv|tsv|markdown|md|txt|rtf|json|xml|html?|png|jpe?g|jfif|gif|webp|svg|heic|heif|avif|tiff?|bmp|zip|rar|7z|tar|gz|py|rb|rs|go|java|kts?|swift|cs|cpp|cxx|cc|hpp|php|yaml|yml|toml|sql|graphql|gql|ini|env|conf|log|sh|bash|zsh|mjs|cjs|jsx?|tsx?|css|scss|sass|less|mp3|mp4|mov|wav|webm)\1/g;
const MIME_LITERAL = /(["'`])(?:text|image|audio|video|application)\/[a-z0-9.+-]+\1/g;
```

Fail a file when `distinct(EXT) >= 4 || distinct(MIME) >= 4`, unless the path is in `ALLOWLIST`.
The failure message prints the path and the matched tokens so the fix is obvious.

**`ALLOWLIST`** — a `Map<path, reason>`; adding to it requires the reason:

| path | reason |
| --- | --- |
| `src/lib/shared/file-types/table.ts` | the registry itself (also excluded by prefix) |
| `src/lib/server/services/campaign-assets.ts` | `MIME_EXTENSIONS` kept by decision row 46; covered by its own parity test |
| `src/lib/server/prompts.ts` | model-facing prose, verified by §6.4 instead |
| `src/lib/server/services/normal-chat-tools/index.ts` | EN/HU tool prose, verified by §6.4 |
| `src/lib/i18n/*.ts` | user-facing prose |
| `src/lib/components/chat/ImportChatGPTModal.svelte` + `src/routes/api/chat/import/+server.ts` | `.zip` gate — a distinct feature (ChatGPT export import), not knowledge upload (row 66) |
| `src/lib/components/ui/ProfilePictureEditor.svelte` | `accept="image/*,.heic,..."` — avatar picker; folded into the registry in a later phase (row 68) |
| `src/lib/server/favicon/fetch.ts` | favicon `IMAGE_TYPES` includes `image/x-icon`, which has no registry entry (row 57) |
| `src/lib/server/services/file-serving-response-policy.ts` | CSP/sandbox policy keyed on `text/html` + `image/svg+xml`; a security decision, not a type table (row 58) |
| `src/lib/server/services/working-document-selection.ts` | natural-language intent regexes over user messages, not file classification (row 61) |
| `src/lib/server/services/atlas/renderer-output.ts` | separate Atlas pipeline (row 70) |
| `src/routes/api/map-tiles/[z]/[x]/[y]/+server.ts` | fixed-format tile proxy (row 67) |
| `src/routes/api/admin/model-icons/upload/+server.ts` | admin-only single-extension inference (row 65) |
| `src/lib/server/services/skills/user-skills.ts` + `scripts/skill-eval-fixtures.ts` | model-facing skill prose, verified by §6.4 instead (rows 62–63) |
| `src/lib/server/sandbox/python-version.ts` | producer *library* names (`python-docx`, `openpyxl`), not file types |

A second assertion: **no file outside `src/lib/shared/file-types/**` and the allowlist may contain
`accept="` followed by a dotted extension list** (`/accept=["'{][^"'}]*\.[a-z0-9]{2,5}\s*,/`).

### 6.4 `src/lib/shared/file-types/format-prose.test.ts` — model-facing consistency

- Every token in `FILE_PRODUCTION_OUTPUT_TYPE_EXAMPLES.split(", ")` is `isSupportedFileProductionOutputType` *(this is today's `output-types.test.ts:21-28`, moved and kept)*.
- **Invariant:** every entry with `production.requestable === true` has `intake.route !== "reject"`, with a single named exemption:
  ```ts
  // `zip` is producible but never ingestible; Phase >= 2 moves it to the RESERVED
  // "archive" intake route. See spec section 2.3 conflict 10.
  const PRODUCTION_ONLY_TYPES = new Set(["zip"]);
  ```
- Extract every upper-case format token from `prompts.ts:156` and from the EN/HU `produce_file`
  descriptions (`normal-chat-tools/index.ts:285,377`) with
  `/\b(PDF|DOCX|XLSX|PPTX|CSV|ZIP|JSON|HTML|Markdown|Excel|PowerPoint)\b/g`, map the friendly names
  (`Excel→xlsx`, `PowerPoint→pptx`, `Markdown→md`), and assert each resolves to a requestable entry.
- Assert `prompts.ts:156` and both tool descriptions are **byte-identical to frozen copies** —
  they are part of a cached prompt prefix (§7).

### 6.5 Upload-path tests (slice C)

| file | change |
| --- | --- |
| `src/routes/api/knowledge/upload/intent/upload-intent.test.ts` | add: `.mp4` → 415 / `upload_unsupported_type` / `knowledge.uploadRejectedMedia`; `.zip` → 415 / `…Archive`; `.rtf` → 415 / `…FormatNotEnabled`; `.wat` (unknown) → 415 / `knowledge.uploadUnsupportedType`; `.py` → 200 (exception a); `.odt` → 200. **Keep** the existing oversize test passing (checks run size-first). |
| `src/lib/server/services/knowledge/upload-signature.test.ts` *(new)* | one pass + one mismatch per signature group; a text entry with no signature is always `ok`; the file is `unlink`ed on mismatch. |
| `src/routes/api/knowledge/upload/upload.test.ts` | add a 415 content-mismatch case (a `.png` whose bytes are `%PDF-`). |
| `src/lib/stores/upload-limits.test.ts` *(new)* | default is `DEFAULT_MAX_FILE_UPLOAD_SIZE_BYTES`; `setMaxFileUploadSize` ignores `0`/`NaN`/`undefined`; `maxFileUploadSizeMb` rounds. |
| `src/lib/components/chat/DropZoneOverlay.test.ts:24,35` | expected text now interpolates `{max}`. |
| `src/lib/components/chat/MessageInput.test.ts:2355` | the oversize assertion now reads the store, not `100`. |
| `src/lib/i18n.test.ts` | add an explicit assertion that all five `knowledge.upload*` keys exist in `en` and `hu`. |

### 6.6 Existing test files that need updating (full list)

`src/lib/utils/file-preview.test.ts`, `src/lib/utils/file-drag.test.ts`,
`src/lib/components/chat/attachment-file-type.test.ts`,
`src/lib/components/chat/composer-chip-presentation.test.ts`,
`src/lib/components/chat/FileAttachment.test.ts`,
`src/lib/components/chat/DropZoneOverlay.test.ts`,
`src/lib/components/chat/MessageInput.test.ts`,
`src/lib/components/chat/ComposerToolsMenu.test.ts`,
`src/lib/components/document-workspace/DocumentPreviewRenderer.test.ts`,
`src/lib/components/document-workspace/preview-runtime/preview-runtime.test.ts`,
`src/lib/server/services/file-production/output-types.test.ts` (its `read("lib/server/services/file-production/output-types.ts")` assertion at `:49` must repoint to `lib/shared/file-types/table.ts`),
`src/lib/server/services/file-production/output-validation.test.ts`,
`src/lib/server/services/file-production/image-loader.test.ts` (no change expected — verify),
`src/lib/server/services/knowledge/store/attachments.test.ts`,
`src/routes/api/knowledge/upload/upload.test.ts`,
`src/routes/api/knowledge/upload/intent/upload-intent.test.ts`,
`src/routes/api/knowledge/upload/raw/raw-upload.test.ts`,
`src/routes/api/knowledge/upload/chunk/chunk-upload.test.ts`,
`src/routes/(app)/knowledge/_components/DocumentsList.test.ts` (`:1348` asserts the 100 MB limit),
`src/lib/server/sandbox/config.test.ts:89` (verify only — `SANDBOX_MAX_FILE_MB` is out of scope, row 73),
`src/lib/i18n.test.ts`.

**E2E:** `tests/e2e/knowledge.spec.ts:217` asserts the 100 MB drop-zone copy. Slice C updates it.
E2E is not in the vitest run (`vitest.config.ts:12` excludes `tests/e2e/**`), so it will not fail
CI — **slice C must update it manually and say so in its PR description.**

**Also verify (expected: no change needed):** `src/lib/server/services/file-production/image-loader.test.ts`,
`src/lib/server/services/knowledge/store/working-document-file-serving.test.ts`,
`src/lib/server/services/file-production/fixtures.test.ts`.

---

## 7. Non-goals and risks

**Must not be touched in this phase:**

- The MinerU HTTP client, backend selection, or timeout handling (`document-extraction.ts:177-230`).
  Only the *route decision* moves; the request body, `backend: "hybrid-auto-engine"` and the response
  parsing stay byte-identical. `tierHint` is recorded in the registry and **read by nobody** in Phase 1.
- The extraction/normalisation flow: `createNormalizedArtifact`, `resolvePromptAttachmentArtifacts`,
  chunking, hashing, dedup.
- DB schema and Drizzle migrations. No column, table, or `drizzle/` file changes.
- Generation renderer behaviour: `renderStandardReportPdf`, docx/pptx builders, `source-schema.ts`,
  `limits.ts`. Only the *type tables* they consult move.
- `image-loader.ts` (renderer capability list, not a file-type fact — row 47).
- `config-store.ts` / `env.ts`. `MAX_FILE_UPLOAD_SIZE` already exists and already flows.
- Chunked-upload transport, `BODY_SIZE_LIMIT`, adapter limits, `scripts/patch-body-size-limit.mjs`.
- **CSP / sandbox policy**: `file-serving-response-policy.ts` and `generated-file-serving.ts:206`
  (rows 58–59). These key on `text/html` and `image/svg+xml` and decide whether a preview runs
  sandboxed. Changing them in the same phase as the registry would make the security diff
  unreviewable. Frozen, allowlisted, with a follow-up ticket.
- The sandbox output cap (`SANDBOX_MAX_FILE_MB`, row 73) and the three 20 MB image caps (row 68) —
  they are *not* the upload limit and must not be folded into §4.3.
- Atlas (`atlas/renderer-output.ts`), map tiles, favicon fetch, ChatGPT import, admin model-icon
  upload, avatar picker UI (rows 57, 65–70).

**Risks:**

| Risk | Why it matters here | Mitigation |
| --- | --- | --- |
| **Bundle size** | The 80-entry table lands in every client chunk that touches a file. ~18 KB raw / ~6 KB gzip. Worse: an accidental `import { getExpectedExtensionForOutputType } from "$lib/shared/file-types/production"` in a component would add ~180 alias keys, and an accidental `model-facing` import would add Hungarian prose. | Separate entry points (§0); a `no-ad-hoc-maps.test.ts` companion assertion that no file under `src/lib/components/**` or `src/routes/(app)/**` imports `file-types/production` or `file-types/model-facing`. |
| **Prompt-prefix cache invalidation** | Flash-Next caches on 1600-token blocks; `prompts.ts` and the tool descriptions sit in the cached prefix. A one-character change to derived prose evicts every cached prefix for every user. | Rows 42–43 keep the prose hand-written; §6.4 asserts byte-identity against frozen copies. Only `attachments.ts`'s *runtime error string* (not in any prompt) is derived. |
| **EN/HU drift** | 5 new i18n keys land in a namespace the parity test does **not** audit (`knowledge.` is absent from `AUDITED_PREFIXES`, `src/lib/i18n.test-helpers.ts:21-45`). | Slice C adds `"knowledge.upload"` to `AUDITED_PREFIXES` in the same commit as the keys, plus an explicit 5-key assertion in `i18n.test.ts`. |
| **HU tool description drift** | The HU `produce_file` description is a hand-translated 1,400-character string; the EN one is the reference. Nothing today checks they name the same formats. | §6.4 extracts format tokens from **both** and asserts the same set. |
| **Silent accept-string growth** | Adding an entry with `surfaces: ["knowledge"]` silently widens what the knowledge UI accepts. | `SURFACE_ACCEPT_ORDER.knowledge` is an explicit frozen array; §6.1 asserts set-equality, so a new knowledge entry *forces* an explicit array edit. |
| **415 on a legitimate upload** | A browser that reports no MIME and a file with an unusual extension now gets refused where it previously silently failed extraction. | `admitUpload` resolves by extension **first**, MIME second, and only refuses on a *known* reject entry or a *completely unknown* extension. The 33 direct-text expansions make the allowlist wider than today's effective support. |
| **Magic-byte false negatives** | A valid `.docx` written by an exotic tool with a `PK\x05\x06` header would be refused. | All three ZIP magic variants are accepted; text types are never sniffed; the check runs only at completion, so a failure is recoverable by re-upload. |
| **Parallel-slice merge conflicts** | Five worktrees, one shared new folder. | Only slice A writes `src/lib/shared/file-types/**` (except the two new test files owned by E, which are new paths). Every other file has exactly one owner (§5 table). |

---

## 8. Open questions

| # | Question | Recommended answer |
| --- | --- | --- |
| 1 | `.js` canonical MIME: is changing the served `Content-Type` of a generated `.js` file from `application/javascript` to `text/javascript` acceptable? | **Yes.** `text/javascript` is the only non-obsolete value, two of three producers already emit it, `EXTENSION_MIME_TYPES[".js"]` already accepts it, and no client parses this header. |
| 2 | Should the knowledge surface adopt the wider chat accept set (gaining `.py`, `.ts`, `.yaml`, `.odt`, …)? | **Not in this phase.** It is a visible product change. Phase 1 freezes the knowledge string; recommend flipping it in the same PR as the MinerU 4.x rollout so the change is announced once. |
| 3 | Should `.markdown` be added to the knowledge accept string (`.md` is there, `.markdown` is not)? | **Yes, but not now** — it is the same class of change as #2, and the registry already knows `.markdown` is an alias of `md`. |
| 4 | `zip` is requestable but `reject` at intake, breaking the §6.4 invariant. Flip it to the RESERVED `archive` route now? | **No.** The brief says nothing may use `archive` yet. Exempt `zip` by name in the invariant test with a pointer to §2.3 ⚠10. Revisit when `archive` gets a real handler. |
| 5 | Should `image/*` types route to the RESERVED `vision` intake instead of `mineru`? | **No, not in Phase 1.** Today images go to MinerU (`document-extraction.ts:28-39,177`). Changing it would be a behaviour change with no consumer. The registry makes it a one-line flip later. |
| 6 | `campaign-assets.MIME_EXTENSIONS` maps `image/tiff → "tiff"` but the registry canonicalises `tif`. Derive it and change the on-disk extension, or leave it? | **Leave it** (row 46) and add a parity test that every key is a registry image MIME. Changing the extension would rename existing stored campaign assets' paths. |
| 7 | `read-generated-file.ts:103` accepts `application/x-yaml`, a MIME that exists nowhere else in the codebase. Keep it? | **Keep it** as a `yaml` MIME alias. It costs one array element and dropping it would silently stop reading back any file stored with that MIME. |
| 8 | `AttachmentPickerSheet`'s `accept="image/*"` rows (`:81,:89`): fold into the registry? | **No.** Those are *intent* filters (Photos / Camera), not type gates — the Library row already opens the full picker. Listed in the `no-ad-hoc-maps` allowlist reasoning as "not an extension list". |
| 9 | `ProfilePictureEditor.svelte:403` has its own `accept="image/*,.heic,.heif,.avif,.tiff,.tif,.bmp"`. In scope? | **Out of scope for Phase 1**, allowlisted. It is the avatar flow, which has its own server allowlist (row 44). Fold both into `getAcceptAttribute("avatar")` in a follow-up. |
| 10 | Should the intent allowlist be **per-surface** (a `surface` field in the intent payload) rather than global? | **No.** `uploadKnowledgeAttachment` is the single client for both knowledge and chat, and a per-surface server gate would let a caller widen it by lying. Keep the server gate global (`intake.route !== "reject"`) and let `accept` strings differ per surface as a UX hint only. |
| 11 | Should the 33 direct-text expansions (§2.4a) also apply a size cap? A 100 MB `.log` read as UTF-8 goes straight into the prompt pipeline. | **Yes — flag for the reviewer.** Today's MinerU path had no such exposure because these types failed. Recommend a follow-up ticket; adding a cap in Phase 1 would be a fourth unsanctioned behaviour change. The existing chunking/truncation in `createNormalizedArtifact` may already bound it — **verify before merging slice D**. |
| 12 | `.tsv` is named in the built-in skill prose (`user-skills.ts:595,608,915-920`) and in `scripts/skill-eval-fixtures.ts:138-140`, but has **no map entry anywhere** and is a deferred MinerU format. §6.4's token test would fail on it. | **Add a `tsv` entry now with `intake: reject / formatNotEnabled`, `requestable: false`, `category: spreadsheet`.** That makes the prose token resolve (the test checks "is a known type", and a second assertion checks requestable tokens separately), preserves today's behaviour (`.tsv` is in no accept string and no output-type map), and makes the later MinerU enablement the same one-line edit as `rtf`. Raises the table to 81 entries / 93 extensions. |
| 13 | Three byte-identical `getFileExtension` copies (`chat-files.ts:370`, `conversation-forks.ts:439`, `file-drag.ts:30`) and three `outputTypeFromFilename` copies (`intake.ts:158`, `output-validation.ts:181`, `produce-file.ts:657`). Collapse all six in this phase? | **Yes** — rows 53–54 assign them. They are trivial, the architecture test would otherwise flag two of them, and leaving duplicate parsers next to a "single source of truth" module invites the exact drift this phase exists to end. Note `file-drag.ts:30` uses `lastIndexOf` while the other two use `extname`; they agree on every input that has a dot, and differ only for a leading-dot name (`.env`): `extname(".env")` is `""` while `lastIndexOf` yields `"env"`. **The registry `fileExtension` must match `attachment-file-type.ts:76`'s behaviour (`parts.length < 2 → ""`), i.e. `.env` → `""`.** Assert this explicitly in `registry.test.ts`. |
| 14 | Three independent 20 MB image caps: `avatar/+server.ts:10`, `campaign-assets.ts:8`, `ProfilePictureEditor.svelte:61`. Unify? | **No, not this phase** (row 68). They are different endpoints with different threat models. Worth a follow-up ticket alongside open question 9. |
| 15 | `FileTypeIcon.svelte:28`'s `iconMap` is keyed on a string vocabulary that is neither `PreviewKind` nor `AttachmentFileType` but overlaps both (`pdf/docx/xlsx/pptx/odt/image/text/html/code/archive`). Which does it become? | **`FileTypeCategory`**, with a compatibility union on the prop so `OpenDocumentsRail.svelte:117` (which passes a `PreviewFileType`) and `FileAttachment.svelte:137` (which passes an `AttachmentFileType`) both keep compiling. Collapse the prop to `FileTypeCategory` alone in a follow-up, once both call sites pass `getCategory(...)`. |

---

## 9. Orchestrator rulings (2026-09-20) — these override anything above that conflicts

- **Execution order.** Slice A runs alone first and is merged into the integration branch `mineru4/p1`. Slices B, C, D and E then start in parallel from `mineru4/p1`. Ignore the "create a local stub, then rebase onto A" instruction in §5; nobody writes a stub.
- **Branches.** Each slice commits on `mineru4/p1-a` … `mineru4/p1-e` in its own worktree. Nothing is pushed. The orchestrator merges into `mineru4/p1` after review.
- **Open questions.** Every recommended answer in §8 is adopted, including Q12 (add the `tsv` entry as `reject` / `formatNotEnabled`, not requestable).
- **Q11 (size of direct-text files).** No new cap in Phase 1. A large `.txt`, `.csv` or `.json` already takes this path today, so the exposure is not new in kind. Slice D must report what bounds a large direct-text file downstream (chunk count, embedding calls, prompt truncation). A cap is tracked for Phase 3, where the extraction ledger can enforce it.
- **Toolchain.** Use Homebrew `node@22` (`/opt/homebrew/opt/node@22/bin`) for every npm and vitest command. Node 26 breaks `better-sqlite3`.
- **Commits.** Stage files by explicit path. Never `git add -A` or `git add .`. Never commit `node_modules`, `data/`, or a symlink to either.
