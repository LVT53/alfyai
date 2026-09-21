// The file-type table. This module is DATA ONLY and must keep ZERO value
// imports (`import type` is fine, it is erased) — `registry.test.ts` asserts
// it. The rule is inherited from `output-types.ts`, which was split out of
// `output-validation.ts` precisely so the request path could reach the type
// table without dragging JSZip into the chat server bundle. A dependency-free
// data module can never drag anything anywhere.
//
// Every entry is a re-partition of maps that already exist in the tree; see
// docs/plans/mineru4/phase1-registry-spec.md section 2.1 for the source of each
// column and section 2.3 for the conflicts this table resolves.

import type { FileTypeEntry, FileTypeSignature } from "./types";

// ── Shared signature groups (spec section 4.2) ─────────────────────────────
// Local `const`s, not imports: they stay inside this module.

/** PK\x03\x04 / PK\x05\x06 (empty) / PK\x07\x08 (spanned) — every OOXML + ODF + zip. */
const ZIP_SIGNATURES: readonly FileTypeSignature[] = [
	{ offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] },
	{ offset: 0, bytes: [0x50, 0x4b, 0x05, 0x06] },
	{ offset: 0, bytes: [0x50, 0x4b, 0x07, 0x08] },
];

/** OLE2 Compound File Binary — legacy doc/xls/ppt. */
const OLE2_SIGNATURES: readonly FileTypeSignature[] = [
	{ offset: 0, bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
];

/** ISO-BMFF "ftyp" box at offset 4 — heic/heif/avif/mp4/mov. */
const FTYP_SIGNATURES: readonly FileTypeSignature[] = [
	{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
];

export const FILE_TYPE_ENTRIES: readonly FileTypeEntry[] = [
	// ── Text / code ────────────────────────────────────────────────────────
	// intake: direct-text, textLike: true, validation: "text".
	// Deliberate change (spec section 2.4a): 33 of these previously fell
	// through to MinerU, which cannot read them.
	//
	// Phase 5 (phase5-6 spec D5 / OQ4): every non-reject entry is now offered on
	// BOTH surfaces. The server gate (`admitUpload`) has always been
	// surface-independent, so a narrower knowledge list only hid types the
	// server already accepted — a `.py` dropped on the Knowledge page was
	// silently discarded while the identical file worked in chat.
	{
		id: "txt",
		extensions: ["txt"],
		mimeTypes: ["text/plain"],
		ownsCanonicalMime: true,
		category: "text",
		preview: { kind: "text" },
		intake: { route: "direct-text" },
		production: {
			requestable: true,
			types: { txt: ".txt", text: ".txt", "text/plain": ".txt" },
			validation: "text",
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
	},
	{
		id: "md",
		extensions: ["md", "markdown"],
		mimeTypes: ["text/markdown"],
		category: "text",
		preview: { kind: "text", language: "markdown" },
		intake: { route: "direct-text" },
		production: {
			requestable: true,
			// `markdown` maps to ".md", NOT ".markdown" — see spec conflict 6.
			types: { md: ".md", markdown: ".md", "text/markdown": ".md" },
			documentRenderKind: "markdown",
			validation: "text",
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
	},
	{
		id: "csv",
		extensions: ["csv"],
		mimeTypes: ["text/csv", "application/csv"],
		category: "spreadsheet",
		preview: { kind: "text" },
		intake: { route: "direct-text" },
		production: {
			requestable: true,
			types: { csv: ".csv", "text/csv": ".csv" },
			validation: "text",
			exampleRank: 4,
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
	},
	{
		// Phase 5 D2 / OQ1: `direct-text`, NOT MinerU. The spike's csv fixture
		// goes 89 chars in -> 148 chars out (+66.3 %) because pipes, padding and
		// the `| --- |` separator row cost more than the delimiters they
		// replace, and `run_python`/exceljs need the raw delimiters anyway.
		// Requestable as an OUTPUT from Phase 6 D7 — it is the one format added
		// there: plain text, zero libraries, and it closes the gap with the
		// shipped spreadsheet skill, which already advertises TSV.
		id: "tsv",
		extensions: ["tsv"],
		mimeTypes: ["text/tab-separated-values"],
		category: "spreadsheet",
		preview: { kind: "text" },
		intake: { route: "direct-text" },
		production: {
			requestable: true,
			types: { tsv: ".tsv", "text/tab-separated-values": ".tsv" },
			validation: "text",
			// No exampleRank on purpose: FILE_PRODUCTION_OUTPUT_TYPE_EXAMPLES
			// stays "xlsx, docx, pptx, pdf, csv, zip", so no prompt string moves
			// before the single prose release (D13 / slice P6-D).
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
		// No signature: delimited text is text, and text is never sniffed.
	},
	{
		id: "json",
		extensions: ["json"],
		mimeTypes: ["application/json", "text/json"],
		category: "code",
		preview: { kind: "text", language: "json" },
		intake: { route: "direct-text" },
		production: {
			requestable: true,
			types: { json: ".json", "application/json": ".json" },
			validation: "text",
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
	},
	{
		id: "xml",
		extensions: ["xml"],
		mimeTypes: ["application/xml", "text/xml"],
		category: "code",
		preview: { kind: "text", language: "xml" },
		intake: { route: "direct-text" },
		production: {
			requestable: true,
			types: { xml: ".xml", "application/xml": ".xml" },
			validation: "text",
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
	},
	{
		id: "html",
		extensions: ["html", "htm"],
		mimeTypes: ["text/html"],
		category: "code",
		// The extension decides: `html`/`htm` were in TRUSTED_PREVIEW_EXTENSIONS.
		preview: { kind: "html", language: "html", extensionAuthoritative: true },
		// Phase 5 D3. Measured on `fixtures/mineru-v1/html/`: 1 753 chars raw
		// against 1 152 through MinerU flash (-34.3 %, -43.2 % once the four
		// `<a id="html-…"></a>` anchors are stripped), with scripts, style, nav,
		// ad slots and the footer removed and the most faithful heading levels
		// of any input format. Two consequences the reader should know about:
		// the 8 MiB direct-text cap no longer applies to HTML, and HTML now
		// depends on the backend like every other MinerU type.
		//
		// `requiresMineru4` WITH a `fallbackRoute` (orchestrator ruling "OQ2,
		// amended"): HTML uploads work today, so a pre-4 backend must degrade
		// to reading the bytes, never refuse. It is the only entry of the two
		// shapes that keeps a route on an old backend.
		intake: {
			route: "mineru",
			tierHint: "flash",
			requiresMineru4: true,
			fallbackRoute: "direct-text",
		},
		production: {
			requestable: true,
			// `htm` carries no production token today — recognition only.
			types: { html: ".html", "text/html": ".html" },
			documentRenderKind: "html",
			documentSource: true,
			validation: "text",
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
	},
	{
		id: "css",
		extensions: ["css"],
		mimeTypes: ["text/css"],
		category: "code",
		preview: { kind: "text", language: "css" },
		intake: { route: "direct-text" },
		production: {
			requestable: true,
			types: { css: ".css", "text/css": ".css" },
			validation: "text",
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
	},
	{
		id: "scss",
		extensions: ["scss"],
		mimeTypes: ["text/x-scss"],
		category: "code",
		preview: { kind: "text", language: "scss" },
		intake: { route: "direct-text" },
		production: {
			requestable: true,
			types: { scss: ".scss", "text/x-scss": ".scss" },
			validation: "text",
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
	},
	{
		id: "sass",
		extensions: ["sass"],
		mimeTypes: ["text/x-sass"],
		category: "code",
		preview: { kind: "text", language: "sass" },
		intake: { route: "direct-text" },
		production: {
			requestable: true,
			types: { sass: ".sass", "text/x-sass": ".sass" },
			validation: "text",
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
	},
	{
		id: "less",
		extensions: ["less"],
		mimeTypes: ["text/x-less"],
		category: "code",
		preview: { kind: "text", language: "less" },
		intake: { route: "direct-text" },
		production: {
			requestable: true,
			types: { less: ".less", "text/x-less": ".less" },
			validation: "text",
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
	},
	{
		id: "js",
		extensions: ["js", "mjs", "cjs"],
		// Conflict 1: `text/javascript` wins (RFC 9239 obsoletes the other),
		// `application/javascript` stays an accepted alias.
		mimeTypes: ["text/javascript", "application/javascript"],
		category: "code",
		preview: { kind: "text", language: "javascript" },
		intake: { route: "direct-text" },
		production: {
			requestable: true,
			types: {
				js: ".js",
				javascript: ".js",
				"application/javascript": ".js",
				"text/javascript": ".js",
				mjs: ".mjs",
				cjs: ".cjs",
			},
			validation: "text",
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
	},
	{
		id: "jsx",
		extensions: ["jsx"],
		mimeTypes: ["text/jsx"],
		category: "code",
		preview: { kind: "text", language: "jsx" },
		intake: { route: "direct-text" },
		production: {
			requestable: true,
			types: { jsx: ".jsx", "text/jsx": ".jsx" },
			validation: "text",
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
	},
	{
		id: "ts",
		extensions: ["ts"],
		mimeTypes: ["application/typescript", "text/typescript"],
		category: "code",
		preview: { kind: "text", language: "typescript" },
		intake: { route: "direct-text" },
		production: {
			requestable: true,
			types: {
				ts: ".ts",
				typescript: ".ts",
				"application/typescript": ".ts",
				"text/typescript": ".ts",
			},
			validation: "text",
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
	},
	{
		id: "tsx",
		extensions: ["tsx"],
		mimeTypes: ["text/tsx"],
		category: "code",
		preview: { kind: "text", language: "tsx" },
		intake: { route: "direct-text" },
		production: {
			requestable: true,
			types: { tsx: ".tsx", "text/tsx": ".tsx" },
			validation: "text",
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
	},
	{
		id: "py",
		extensions: ["py"],
		mimeTypes: ["text/x-python"],
		category: "code",
		preview: { kind: "text", language: "python" },
		intake: { route: "direct-text" },
		production: {
			requestable: true,
			types: { py: ".py", python: ".py", "text/x-python": ".py" },
			validation: "text",
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
	},
	{
		id: "sh",
		extensions: ["sh", "bash", "zsh"],
		mimeTypes: ["application/x-sh", "text/x-shellscript"],
		category: "code",
		preview: { kind: "text", language: "bash" },
		intake: { route: "direct-text" },
		production: {
			requestable: true,
			// `bash` is a token that produces ".sh"; only `zsh` produces ".zsh".
			types: {
				sh: ".sh",
				shell: ".sh",
				bash: ".sh",
				"application/x-sh": ".sh",
				"text/x-shellscript": ".sh",
				zsh: ".zsh",
			},
			validation: "text",
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
	},
	{
		id: "yaml",
		extensions: ["yaml", "yml"],
		// `application/x-yaml` is kept because read-generated-file.ts:103 accepts
		// it and it appears nowhere else in the tree (spec open question 7).
		mimeTypes: ["application/yaml", "text/yaml", "application/x-yaml"],
		category: "code",
		preview: { kind: "text", language: "yaml" },
		intake: { route: "direct-text" },
		production: {
			requestable: true,
			// `yml` maps to ".yml", not ".yaml" — see spec conflict 6.
			types: { yaml: ".yaml", "application/yaml": ".yaml", yml: ".yml" },
			validation: "text",
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
	},
	{
		id: "toml",
		extensions: ["toml"],
		mimeTypes: ["application/toml"],
		category: "code",
		preview: { kind: "text", language: "toml" },
		intake: { route: "direct-text" },
		production: {
			requestable: true,
			types: { toml: ".toml", "application/toml": ".toml" },
			validation: "text",
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
	},
	{
		id: "sql",
		extensions: ["sql"],
		mimeTypes: ["application/sql"],
		category: "code",
		preview: { kind: "text", language: "sql" },
		intake: { route: "direct-text" },
		production: {
			requestable: true,
			types: { sql: ".sql", "application/sql": ".sql" },
			validation: "text",
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
	},
	{
		id: "graphql",
		extensions: ["graphql", "gql"],
		mimeTypes: ["application/graphql"],
		category: "code",
		preview: { kind: "text", language: "graphql" },
		intake: { route: "direct-text" },
		production: {
			requestable: true,
			types: {
				graphql: ".graphql",
				"application/graphql": ".graphql",
				gql: ".gql",
			},
			validation: "text",
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
	},
	{
		id: "ini",
		extensions: ["ini", "env", "conf"],
		// text/plain is claimed by `txt` for reverse lookup (conflict 7).
		mimeTypes: ["text/plain"],
		category: "code",
		preview: { kind: "text", language: "ini" },
		intake: { route: "direct-text" },
		production: {
			requestable: true,
			types: { ini: ".ini", env: ".env", conf: ".conf" },
			validation: "text",
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
	},
	{
		id: "log",
		extensions: ["log"],
		mimeTypes: ["text/plain"],
		category: "text",
		preview: { kind: "text" },
		intake: { route: "direct-text" },
		production: {
			requestable: true,
			types: { log: ".log" },
			validation: "text",
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
	},
	{
		id: "rb",
		extensions: ["rb"],
		mimeTypes: ["text/x-ruby"],
		category: "code",
		preview: { kind: "text", language: "ruby" },
		intake: { route: "direct-text" },
		production: {
			requestable: true,
			types: { rb: ".rb", ruby: ".rb", "text/x-ruby": ".rb" },
			validation: "text",
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
	},
	{
		id: "rs",
		extensions: ["rs"],
		mimeTypes: ["text/rust"],
		category: "code",
		preview: { kind: "text", language: "rust" },
		intake: { route: "direct-text" },
		production: {
			requestable: true,
			types: { rs: ".rs", rust: ".rs", "text/rust": ".rs" },
			validation: "text",
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
	},
	{
		id: "go",
		extensions: ["go"],
		mimeTypes: ["text/x-go"],
		category: "code",
		preview: { kind: "text", language: "go" },
		intake: { route: "direct-text" },
		production: {
			requestable: true,
			types: { go: ".go", "text/x-go": ".go" },
			validation: "text",
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
	},
	{
		id: "java",
		extensions: ["java"],
		mimeTypes: ["text/x-java-source"],
		category: "code",
		preview: { kind: "text", language: "java" },
		intake: { route: "direct-text" },
		production: {
			requestable: true,
			types: { java: ".java", "text/x-java-source": ".java" },
			validation: "text",
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
	},
	{
		id: "kt",
		extensions: ["kt", "kts"],
		mimeTypes: ["text/x-kotlin"],
		category: "code",
		preview: { kind: "text", language: "kotlin" },
		intake: { route: "direct-text" },
		production: {
			requestable: true,
			// `kts` carries no production token today — recognition only.
			types: { kt: ".kt", kotlin: ".kt", "text/x-kotlin": ".kt" },
			validation: "text",
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
	},
	{
		id: "swift",
		extensions: ["swift"],
		mimeTypes: ["text/x-swift"],
		category: "code",
		preview: { kind: "text", language: "swift" },
		intake: { route: "direct-text" },
		production: {
			requestable: true,
			types: { swift: ".swift", "text/x-swift": ".swift" },
			validation: "text",
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
	},
	{
		id: "cs",
		extensions: ["cs"],
		mimeTypes: ["text/x-csharp"],
		category: "code",
		preview: { kind: "text", language: "csharp" },
		intake: { route: "direct-text" },
		production: {
			requestable: true,
			types: { cs: ".cs", csharp: ".cs", "text/x-csharp": ".cs" },
			validation: "text",
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
	},
	{
		id: "cpp",
		extensions: ["cpp", "cxx", "cc", "hpp"],
		mimeTypes: ["text/x-c++src"],
		category: "code",
		preview: { kind: "text", language: "cpp" },
		intake: { route: "direct-text" },
		production: {
			requestable: true,
			types: {
				cpp: ".cpp",
				"text/x-c++src": ".cpp",
				cxx: ".cxx",
				cc: ".cc",
				hpp: ".hpp",
			},
			validation: "text",
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
	},
	{
		id: "c",
		extensions: ["c", "h"],
		mimeTypes: ["text/x-csrc"],
		category: "code",
		preview: { kind: "text", language: "c" },
		intake: { route: "direct-text" },
		production: {
			requestable: true,
			types: { c: ".c", "text/x-csrc": ".c", h: ".h" },
			validation: "text",
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
	},
	{
		id: "php",
		extensions: ["php"],
		mimeTypes: ["application/x-httpd-php"],
		category: "code",
		preview: { kind: "text", language: "php" },
		intake: { route: "direct-text" },
		production: {
			requestable: true,
			types: { php: ".php", "application/x-httpd-php": ".php" },
			validation: "text",
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
	},
	{
		id: "r",
		extensions: ["r"],
		mimeTypes: ["text/x-r-source"],
		category: "code",
		preview: { kind: "text", language: "r" },
		intake: { route: "direct-text" },
		production: {
			requestable: true,
			types: { r: ".r", "text/x-r-source": ".r" },
			validation: "text",
		},
		textLike: true,
		surfaces: ["knowledge", "chat"],
	},

	// ── Documents ──────────────────────────────────────────────────────────
	// intake: mineru, textLike: false.
	//
	// Phase 5 D4 / OQ11: every Office and ODF entry carries `tierHint: "flash"`.
	// The spike resolved docx/xlsx/pptx to `flash` file-level inside a `basic`
	// job anyway, and OMITTING the tier is a 503 on a flash-only server
	// (`decideTier` rule 2). `pdf` and every image stay UNHINTED on purpose:
	// they are the only inputs the fixtures show resolving to `basic`, and
	// hinting them would trade OCR quality for ~300 ms.
	{
		id: "pdf",
		extensions: ["pdf"],
		mimeTypes: ["application/pdf"],
		category: "pdf",
		preview: { kind: "pdf", extensionAuthoritative: true },
		intake: { route: "mineru" },
		production: {
			requestable: true,
			types: { pdf: ".pdf", "application/pdf": ".pdf" },
			documentRenderKind: "pdf",
			documentSource: true,
			validation: "none",
			exampleRank: 3,
		},
		textLike: false,
		surfaces: ["knowledge", "chat"],
		// `%PDF-`, within the first 1024 bytes rather than exactly at byte 0:
		// the PDF spec's implementation notes tell readers to look that far,
		// and real files carry a preamble often enough that every reader does.
		signatures: [
			{
				offset: 0,
				bytes: [0x25, 0x50, 0x44, 0x46, 0x2d],
				searchWithinBytes: 1024,
			},
		],
	},
	{
		id: "docx",
		extensions: ["docx"],
		mimeTypes: [
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		],
		category: "document",
		preview: { kind: "docx", extensionAuthoritative: true },
		intake: { route: "mineru", tierHint: "flash" },
		production: {
			requestable: true,
			types: {
				docx: ".docx",
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document":
					".docx",
			},
			documentRenderKind: "docx",
			documentSource: true,
			validation: "none",
			exampleRank: 1,
		},
		textLike: false,
		surfaces: ["knowledge", "chat"],
		signatures: ZIP_SIGNATURES,
	},
	{
		id: "doc",
		extensions: ["doc"],
		mimeTypes: ["application/msword"],
		category: "document",
		preview: { kind: "unsupported" },
		intake: { route: "mineru", tierHint: "flash" },
		production: { requestable: false, types: {}, validation: "none" },
		textLike: false,
		surfaces: ["knowledge", "chat"],
		signatures: OLE2_SIGNATURES,
	},
	{
		id: "xlsx",
		extensions: ["xlsx"],
		mimeTypes: [
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		],
		category: "spreadsheet",
		preview: { kind: "xlsx", extensionAuthoritative: true },
		intake: { route: "mineru", tierHint: "flash" },
		production: {
			requestable: true,
			types: {
				xlsx: ".xlsx",
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
					".xlsx",
			},
			validation: "xlsx",
			exampleRank: 0,
		},
		textLike: false,
		surfaces: ["knowledge", "chat"],
		signatures: ZIP_SIGNATURES,
	},
	{
		id: "xls",
		extensions: ["xls"],
		mimeTypes: ["application/vnd.ms-excel"],
		category: "spreadsheet",
		preview: { kind: "unsupported" },
		intake: { route: "mineru", tierHint: "flash" },
		production: { requestable: false, types: {}, validation: "none" },
		textLike: false,
		surfaces: ["knowledge", "chat"],
		signatures: OLE2_SIGNATURES,
	},
	{
		id: "pptx",
		extensions: ["pptx"],
		mimeTypes: [
			"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		],
		category: "presentation",
		preview: { kind: "pptx", extensionAuthoritative: true },
		intake: { route: "mineru", tierHint: "flash" },
		production: {
			requestable: true,
			types: {
				pptx: ".pptx",
				"application/vnd.openxmlformats-officedocument.presentationml.presentation":
					".pptx",
			},
			validation: "none",
			exampleRank: 2,
		},
		textLike: false,
		surfaces: ["knowledge", "chat"],
		signatures: ZIP_SIGNATURES,
	},
	{
		id: "ppt",
		extensions: ["ppt"],
		mimeTypes: ["application/vnd.ms-powerpoint"],
		category: "presentation",
		preview: { kind: "unsupported" },
		intake: { route: "mineru", tierHint: "flash" },
		production: { requestable: false, types: {}, validation: "none" },
		textLike: false,
		surfaces: ["knowledge", "chat"],
		signatures: OLE2_SIGNATURES,
	},
	{
		id: "odt",
		extensions: ["odt"],
		mimeTypes: ["application/vnd.oasis.opendocument.text"],
		category: "document",
		preview: { kind: "odt", extensionAuthoritative: true },
		// Already `mineru` before Phase 5; it gains the tier hint, the knowledge
		// surface and the MinerU-4 gate. No spike fixture covers ODF at any
		// tier, which is exactly what `requiresMineru4` is for.
		intake: { route: "mineru", tierHint: "flash", requiresMineru4: true },
		production: {
			requestable: true,
			types: {
				odt: ".odt",
				"application/vnd.oasis.opendocument.text": ".odt",
			},
			validation: "none",
		},
		textLike: false,
		surfaces: ["knowledge", "chat"],
		signatures: ZIP_SIGNATURES,
	},
	{
		// Phase 5 D1. No ODS preview renderer exists: `OfficePreviewKind` is
		// `Extract<PreviewKind, "docx"|"xlsx"|"pptx"|"odt">`, and naming a kind
		// with no renderer behind it is a compile error there by design.
		id: "ods",
		extensions: ["ods"],
		mimeTypes: ["application/vnd.oasis.opendocument.spreadsheet"],
		category: "spreadsheet",
		preview: { kind: "unsupported" },
		intake: { route: "mineru", tierHint: "flash", requiresMineru4: true },
		production: { requestable: false, types: {}, validation: "none" },
		textLike: false,
		surfaces: ["knowledge", "chat"],
		signatures: ZIP_SIGNATURES,
	},
	{
		// Phase 5 D1. Ditto — no ODP renderer.
		id: "odp",
		extensions: ["odp"],
		mimeTypes: ["application/vnd.oasis.opendocument.presentation"],
		category: "presentation",
		preview: { kind: "unsupported" },
		intake: { route: "mineru", tierHint: "flash", requiresMineru4: true },
		production: { requestable: false, types: {}, validation: "none" },
		textLike: false,
		surfaces: ["knowledge", "chat"],
		signatures: ZIP_SIGNATURES,
	},
	{
		// Phase 5 D1. No spike fixture; MinerU upstream lists RTF, and the live
		// matrix (spec section 5.1) is what has to confirm it. Gated.
		id: "rtf",
		extensions: ["rtf"],
		mimeTypes: ["application/rtf"],
		category: "text",
		// `rtf` IS in file-preview's TEXT_EXTENSIONS, but NOT in
		// output-validation's TEXT_LIKE_EXTENSIONS (spec conflict 3), and the
		// invariant `production.validation === "text" <=> textLike` forbids
		// moving one without the other. Phase 5 does not move either.
		preview: { kind: "text" },
		intake: { route: "mineru", tierHint: "flash", requiresMineru4: true },
		production: { requestable: false, types: {}, validation: "none" },
		textLike: false,
		surfaces: ["knowledge", "chat"],
		// `{\rtf` — the only non-container signature added by this phase.
		signatures: [{ offset: 0, bytes: [0x7b, 0x5c, 0x72, 0x74, 0x66] }],
	},
	{
		// Phase 5 D1. The cheapest input the spike measured: 10 ms, `spine`
		// paging, faithful headings. No EPUB renderer exists either.
		id: "epub",
		extensions: ["epub"],
		mimeTypes: ["application/epub+zip"],
		category: "document",
		preview: { kind: "unsupported" },
		intake: { route: "mineru", tierHint: "flash", requiresMineru4: true },
		production: { requestable: false, types: {}, validation: "none" },
		textLike: false,
		surfaces: ["knowledge", "chat"],
		signatures: ZIP_SIGNATURES,
	},

	// ── Images ─────────────────────────────────────────────────────────────
	// intake: mineru (today's behaviour — document-extraction posts images to
	// MinerU), preview: image + extensionAuthoritative, textLike: false.
	{
		id: "jpg",
		extensions: ["jpg", "jpeg", "jfif"],
		// Conflict 2: `.jfif` had no MIME anywhere and fell back to
		// application/octet-stream. It is JPEG.
		mimeTypes: ["image/jpeg"],
		category: "image",
		preview: { kind: "image", extensionAuthoritative: true },
		intake: { route: "mineru" },
		production: { requestable: false, types: {}, validation: "none" },
		textLike: false,
		surfaces: ["knowledge", "chat"],
		signatures: [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
	},
	{
		id: "png",
		extensions: ["png"],
		mimeTypes: ["image/png"],
		category: "image",
		preview: { kind: "image", extensionAuthoritative: true },
		intake: { route: "mineru" },
		production: { requestable: false, types: {}, validation: "none" },
		textLike: false,
		surfaces: ["knowledge", "chat"],
		signatures: [
			{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
		],
	},
	{
		id: "gif",
		extensions: ["gif"],
		mimeTypes: ["image/gif"],
		category: "image",
		preview: { kind: "image", extensionAuthoritative: true },
		intake: { route: "mineru" },
		production: { requestable: false, types: {}, validation: "none" },
		textLike: false,
		surfaces: ["knowledge", "chat"],
		signatures: [{ offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] }],
	},
	{
		id: "webp",
		extensions: ["webp"],
		mimeTypes: ["image/webp"],
		category: "image",
		preview: { kind: "image", extensionAuthoritative: true },
		intake: { route: "mineru" },
		production: { requestable: false, types: {}, validation: "none" },
		textLike: false,
		surfaces: ["knowledge", "chat"],
		signatures: [
			{
				offset: 0,
				// "RIFF" + 4 size bytes + "WEBP"
				bytes: [
					0x52,
					0x49,
					0x46,
					0x46,
					null,
					null,
					null,
					null,
					0x57,
					0x45,
					0x42,
					0x50,
				],
			},
		],
	},
	{
		id: "bmp",
		extensions: ["bmp"],
		mimeTypes: ["image/bmp"],
		category: "image",
		preview: { kind: "image", extensionAuthoritative: true },
		intake: { route: "mineru" },
		production: { requestable: false, types: {}, validation: "none" },
		textLike: false,
		surfaces: ["knowledge", "chat"],
		signatures: [{ offset: 0, bytes: [0x42, 0x4d] }],
	},
	{
		id: "tif",
		extensions: ["tif", "tiff"],
		mimeTypes: ["image/tiff"],
		category: "image",
		preview: { kind: "image", extensionAuthoritative: true },
		intake: { route: "mineru" },
		production: { requestable: false, types: {}, validation: "none" },
		textLike: false,
		surfaces: ["knowledge", "chat"],
		signatures: [
			{ offset: 0, bytes: [0x49, 0x49, 0x2a, 0x00] },
			{ offset: 0, bytes: [0x4d, 0x4d, 0x00, 0x2a] },
		],
	},
	{
		id: "heic",
		extensions: ["heic"],
		mimeTypes: ["image/heic"],
		category: "image",
		preview: { kind: "image", extensionAuthoritative: true },
		intake: { route: "mineru" },
		production: { requestable: false, types: {}, validation: "none" },
		textLike: false,
		surfaces: ["knowledge", "chat"],
		signatures: FTYP_SIGNATURES,
	},
	{
		id: "heif",
		extensions: ["heif"],
		mimeTypes: ["image/heif"],
		category: "image",
		preview: { kind: "image", extensionAuthoritative: true },
		intake: { route: "mineru" },
		production: { requestable: false, types: {}, validation: "none" },
		textLike: false,
		surfaces: ["knowledge", "chat"],
		signatures: FTYP_SIGNATURES,
	},
	{
		id: "avif",
		extensions: ["avif"],
		mimeTypes: ["image/avif"],
		category: "image",
		preview: { kind: "image", extensionAuthoritative: true },
		intake: { route: "mineru" },
		production: { requestable: false, types: {}, validation: "none" },
		textLike: false,
		surfaces: ["knowledge", "chat"],
		signatures: FTYP_SIGNATURES,
	},
	{
		id: "svg",
		extensions: ["svg"],
		// The alias list is EXTENSION_MIME_TYPES[".svg"].
		mimeTypes: ["image/svg+xml", "application/xml", "text/xml", "text/plain"],
		category: "image",
		// `xml` highlighting, from EXTENSION_TO_PREVIEW_LANGUAGE.
		preview: { kind: "image", language: "xml", extensionAuthoritative: true },
		intake: { route: "mineru" },
		production: {
			requestable: true,
			types: { svg: ".svg", "image/svg+xml": ".svg" },
			// textLike is false: `.svg` was never in TEXT_LIKE_EXTENSIONS, so a
			// produced `.svg` must not gain a UTF-8/NUL check.
			validation: "none",
		},
		textLike: false,
		surfaces: ["knowledge", "chat"],
		// No signature: SVG is text.
	},

	// ── Recognised, not ingestible ─────────────────────────────────────────
	//
	// Phase 5 emptied most of this section: `rtf`, `ods` and `odp` moved to the
	// Documents group and `tsv` to Text / code. What is left is `ofd`, the
	// archives and the media types.
	{
		// Recognised so an .ofd upload gets the "save it as PDF" message rather
		// than "that file type isn't supported". NOT enabled (OQ3): the
		// 2026-09-20 spike recorded nine inputs and OFD was not one of them, and
		// no fixture, latency figure or output sample exists for it anywhere in
		// the tree. Flipping it later is the same one-line edit `rtf` just had.
		// It is also the sole remaining user of `rejectReason: "formatNotEnabled"`
		// in the table, which keeps that reason and its EN/HU copy alive.
		id: "ofd",
		extensions: ["ofd"],
		// No IANA registration; `application/ofd` is what the GB/T 33190 tooling
		// emits. Alias `application/octet-stream` is NOT added — it is a `zip`
		// alias and generic MIMEs never reverse-resolve (`index.ts`).
		mimeTypes: ["application/ofd"],
		category: "document",
		preview: { kind: "unsupported" },
		intake: { route: "reject", rejectReason: "formatNotEnabled" },
		production: { requestable: false, types: {}, validation: "none" },
		textLike: false,
		surfaces: [],
		signatures: ZIP_SIGNATURES,
	},
	{
		id: "zip",
		extensions: ["zip"],
		// Aliases from output-validation.ts:75-79.
		mimeTypes: [
			"application/zip",
			"application/x-zip-compressed",
			"application/octet-stream",
		],
		category: "archive",
		preview: { kind: "unsupported" },
		// The one entry that is producible but never ingestible, exempted by
		// name from the "every requestable type has a non-reject route"
		// invariant. Phase 5 D11 keeps it: the `archive` route is described in
		// phase5-6-uploads-generation-spec.md section 3.4 and deliberately NOT
		// built, because flipping the route now would make `admitUpload` answer
		// `allowed: true` for a `.zip` with no extractor behind it — worse than
		// the honest refusal it gives today.
		intake: { route: "reject", rejectReason: "archive" },
		production: {
			requestable: true,
			types: { zip: ".zip", "application/zip": ".zip" },
			validation: "none",
			exampleRank: 5,
		},
		textLike: false,
		surfaces: [],
		signatures: ZIP_SIGNATURES,
	},
	{
		id: "rar",
		extensions: ["rar"],
		mimeTypes: ["application/vnd.rar"],
		category: "archive",
		preview: { kind: "unsupported" },
		intake: { route: "reject", rejectReason: "archive" },
		production: { requestable: false, types: {}, validation: "none" },
		textLike: false,
		surfaces: [],
		signatures: [{ offset: 0, bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07] }],
	},
	{
		id: "7z",
		extensions: ["7z"],
		mimeTypes: ["application/x-7z-compressed"],
		category: "archive",
		preview: { kind: "unsupported" },
		intake: { route: "reject", rejectReason: "archive" },
		production: { requestable: false, types: {}, validation: "none" },
		textLike: false,
		surfaces: [],
		signatures: [{ offset: 0, bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] }],
	},
	{
		id: "tar",
		extensions: ["tar"],
		mimeTypes: ["application/x-tar"],
		category: "archive",
		preview: { kind: "unsupported" },
		intake: { route: "reject", rejectReason: "archive" },
		production: { requestable: false, types: {}, validation: "none" },
		textLike: false,
		surfaces: [],
	},
	{
		id: "gz",
		extensions: ["gz"],
		mimeTypes: ["application/gzip"],
		category: "archive",
		preview: { kind: "unsupported" },
		intake: { route: "reject", rejectReason: "archive" },
		production: { requestable: false, types: {}, validation: "none" },
		textLike: false,
		surfaces: [],
		signatures: [{ offset: 0, bytes: [0x1f, 0x8b] }],
	},

	// Audio + video: deliberate change (spec section 2.4c). These reached
	// MinerU and produced a generic readiness error.
	{
		id: "mp3",
		extensions: ["mp3"],
		mimeTypes: ["audio/mpeg"],
		category: "media",
		preview: { kind: "unsupported" },
		intake: { route: "reject", rejectReason: "media" },
		production: { requestable: false, types: {}, validation: "none" },
		textLike: false,
		surfaces: [],
		signatures: [
			{ offset: 0, bytes: [0x49, 0x44, 0x33] },
			{ offset: 0, bytes: [0xff, 0xfb] },
		],
	},
	{
		id: "wav",
		extensions: ["wav"],
		mimeTypes: ["audio/wav"],
		category: "media",
		preview: { kind: "unsupported" },
		intake: { route: "reject", rejectReason: "media" },
		production: { requestable: false, types: {}, validation: "none" },
		textLike: false,
		surfaces: [],
	},
	{
		id: "m4a",
		extensions: ["m4a"],
		mimeTypes: ["audio/mp4"],
		category: "media",
		preview: { kind: "unsupported" },
		intake: { route: "reject", rejectReason: "media" },
		production: { requestable: false, types: {}, validation: "none" },
		textLike: false,
		surfaces: [],
	},
	{
		id: "aac",
		extensions: ["aac"],
		mimeTypes: ["audio/aac"],
		category: "media",
		preview: { kind: "unsupported" },
		intake: { route: "reject", rejectReason: "media" },
		production: { requestable: false, types: {}, validation: "none" },
		textLike: false,
		surfaces: [],
	},
	{
		id: "ogg",
		extensions: ["ogg"],
		mimeTypes: ["audio/ogg"],
		category: "media",
		preview: { kind: "unsupported" },
		intake: { route: "reject", rejectReason: "media" },
		production: { requestable: false, types: {}, validation: "none" },
		textLike: false,
		surfaces: [],
	},
	{
		id: "flac",
		extensions: ["flac"],
		mimeTypes: ["audio/flac"],
		category: "media",
		preview: { kind: "unsupported" },
		intake: { route: "reject", rejectReason: "media" },
		production: { requestable: false, types: {}, validation: "none" },
		textLike: false,
		surfaces: [],
	},
	{
		id: "mp4",
		extensions: ["mp4"],
		mimeTypes: ["video/mp4"],
		category: "media",
		preview: { kind: "unsupported" },
		intake: { route: "reject", rejectReason: "media" },
		production: { requestable: false, types: {}, validation: "none" },
		textLike: false,
		surfaces: [],
		signatures: FTYP_SIGNATURES,
	},
	{
		id: "mov",
		extensions: ["mov"],
		mimeTypes: ["video/quicktime"],
		category: "media",
		preview: { kind: "unsupported" },
		intake: { route: "reject", rejectReason: "media" },
		production: { requestable: false, types: {}, validation: "none" },
		textLike: false,
		surfaces: [],
		signatures: FTYP_SIGNATURES,
	},
	{
		id: "avi",
		extensions: ["avi"],
		mimeTypes: ["video/x-msvideo"],
		category: "media",
		preview: { kind: "unsupported" },
		intake: { route: "reject", rejectReason: "media" },
		production: { requestable: false, types: {}, validation: "none" },
		textLike: false,
		surfaces: [],
	},
	{
		id: "mkv",
		extensions: ["mkv"],
		mimeTypes: ["video/x-matroska"],
		category: "media",
		preview: { kind: "unsupported" },
		intake: { route: "reject", rejectReason: "media" },
		production: { requestable: false, types: {}, validation: "none" },
		textLike: false,
		surfaces: [],
	},
	{
		id: "webm",
		extensions: ["webm"],
		mimeTypes: ["video/webm"],
		category: "media",
		preview: { kind: "unsupported" },
		intake: { route: "reject", rejectReason: "media" },
		production: { requestable: false, types: {}, validation: "none" },
		textLike: false,
		surfaces: [],
	},
];
