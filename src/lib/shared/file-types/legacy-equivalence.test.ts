// Behaviour preservation (spec section 6.2).
//
// Every map this phase replaces is inlined below as a FROZEN LITERAL under a
// header naming its original path and line. They are copies on purpose: slices
// B-E delete the originals, and this file must keep proving the registry says
// the same thing afterwards.
//
// DO NOT "fix" a frozen copy to match the registry. If a frozen copy and the
// registry disagree, either the registry is wrong or the difference belongs in
// KNOWN_DELTAS with a pointer to the spec section that sanctions it.

import { describe, expect, it } from "vitest";

import {
	FILE_TYPE_ENTRIES,
	fileExtension,
	getAcceptAttribute,
	getCanonicalMimeForExtension,
	getCategory,
	getContentTypeForFile,
	getEntryByFilename,
	getEntryByMimeType,
	getIntakeRoute,
	getPreviewKind,
	getPreviewLanguage,
} from "./index";
import {
	buildOutputTokenMap,
	FILE_PRODUCTION_OUTPUT_TYPE_EXAMPLES,
	getAllowedMimeTypesForProducedExtension,
	getProductionValidationClass,
	getSandboxMimeTypeForExtension,
	isTextLikeExtension,
	normalizeDocumentOutput,
	requiresFullContentValidation,
	shouldUseDocumentSourceForOutputs,
} from "./production";
import type { FileTypeCategory, PreviewKind } from "./types";

// ───────────────────────────────────────────────────────────────────────────
// KNOWN_DELTAS — every way the registry deliberately differs from the maps it
// replaces. The reviewer's first check is this object.
//
// The spec (section 6.2) predicted THREE groups. There are FIVE: the two glyph
// groups below are forced by the spec's own design — `category` is a per-ENTRY
// field, so an alias extension inherits its entry's category, while the old
// `getFileType` / `getFileIcon` listed extensions one by one and answered
// "unsupported" for everything it had not listed. Spec conflict 8's claim that
// both surfaces "reproduce today's outputs exactly" does not hold. Every
// member of both groups is a file that previously drew the GENERIC glyph and
// now draws a real one; no file moves between two real glyphs.
// ───────────────────────────────────────────────────────────────────────────

const KNOWN_DELTAS = {
	/**
	 * Spec conflict 1. `.js`/`.mjs`/`.cjs` canonical MIME moves from
	 * `application/javascript` (file-preview) to `text/javascript` (RFC 9239,
	 * and what document-extraction + sandbox-execution already emit).
	 * `application/javascript` remains an accepted alias.
	 */
	javascriptCanonicalMime: ["js", "mjs", "cjs"] as const,

	/**
	 * Spec conflict 2. `.jfif` had no MIME in any extension->MIME map and fell
	 * back to `application/octet-stream`. It is JPEG.
	 */
	jfifCanonicalMime: ["jfif"] as const,

	/**
	 * Spec section 2.4a. These previewed as text but were posted to MinerU,
	 * which cannot read them. The spec's prose says "33 extensions" and then
	 * lists 34; 34 is correct.
	 */
	directTextExpansion: [
		"scss",
		"sass",
		"less",
		"mjs",
		"cjs",
		"jsx",
		"tsx",
		"sh",
		"bash",
		"zsh",
		"sql",
		"graphql",
		"gql",
		"toml",
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
		"c",
		"h",
		"hpp",
		"php",
		"r",
	] as const,

	/**
	 * NOT in the spec. `attachment-file-type.getFileType` answered
	 * "unsupported" for these; the registry gives them their entry's category.
	 * `tsv` is a brand-new entry (spec open question 12).
	 */
	attachmentGlyphExpansion: {
		markdown: ["unsupported", "text"],
		scss: ["unsupported", "code"],
		sass: ["unsupported", "code"],
		less: ["unsupported", "code"],
		mjs: ["unsupported", "code"],
		cjs: ["unsupported", "code"],
		bash: ["unsupported", "code"],
		zsh: ["unsupported", "code"],
		yaml: ["unsupported", "code"],
		yml: ["unsupported", "code"],
		toml: ["unsupported", "code"],
		sql: ["unsupported", "code"],
		graphql: ["unsupported", "code"],
		gql: ["unsupported", "code"],
		ini: ["unsupported", "code"],
		env: ["unsupported", "code"],
		conf: ["unsupported", "code"],
		kt: ["unsupported", "code"],
		kts: ["unsupported", "code"],
		swift: ["unsupported", "code"],
		cs: ["unsupported", "code"],
		cpp: ["unsupported", "code"],
		cxx: ["unsupported", "code"],
		cc: ["unsupported", "code"],
		hpp: ["unsupported", "code"],
		c: ["unsupported", "code"],
		h: ["unsupported", "code"],
		php: ["unsupported", "code"],
		r: ["unsupported", "code"],
		tsv: ["unsupported", "xlsx"],
	} as Readonly<Record<string, readonly [string, string]>>,

	/** NOT in the spec. The same expansion for `DocumentsList.getFileIcon`. */
	knowledgeIconExpansion: {
		markdown: ["FileIcon", "FileText"],
		htm: ["FileIcon", "Code"],
		scss: ["FileIcon", "Code"],
		sass: ["FileIcon", "Code"],
		less: ["FileIcon", "Code"],
		mjs: ["FileIcon", "Code"],
		cjs: ["FileIcon", "Code"],
		sh: ["FileIcon", "Code"],
		bash: ["FileIcon", "Code"],
		zsh: ["FileIcon", "Code"],
		yaml: ["FileIcon", "Code"],
		yml: ["FileIcon", "Code"],
		toml: ["FileIcon", "Code"],
		sql: ["FileIcon", "Code"],
		graphql: ["FileIcon", "Code"],
		gql: ["FileIcon", "Code"],
		ini: ["FileIcon", "Code"],
		env: ["FileIcon", "Code"],
		conf: ["FileIcon", "Code"],
		rb: ["FileIcon", "Code"],
		kt: ["FileIcon", "Code"],
		kts: ["FileIcon", "Code"],
		swift: ["FileIcon", "Code"],
		cs: ["FileIcon", "Code"],
		cpp: ["FileIcon", "Code"],
		cxx: ["FileIcon", "Code"],
		cc: ["FileIcon", "Code"],
		hpp: ["FileIcon", "Code"],
		c: ["FileIcon", "Code"],
		h: ["FileIcon", "Code"],
		php: ["FileIcon", "Code"],
		r: ["FileIcon", "Code"],
		tsv: ["FileIcon", "Table"],
	} as Readonly<Record<string, readonly [string, string]>>,

	/**
	 * NOT in the spec. The same expansion for a file with NO usable extension
	 * whose declared MIME belongs to a registry entry. `getFileType`'s step-4
	 * sniffing was substring-based and accidental — `text/x-scss` matched
	 * because "scss" contains "css", while `text/x-sass` did not and fell
	 * through to the `text/` prefix. The registry answers from the entry
	 * instead, so the two agree.
	 */
	mimeOnlyGlyphExpansion: [
		"application/graphql: unsupported -> code",
		"application/rtf: unsupported -> text",
		"application/sql: unsupported -> code",
		"application/toml: unsupported -> code",
		"application/vnd.ms-powerpoint: unsupported -> pptx",
		"application/vnd.rar: unsupported -> archive",
		"application/x-httpd-php: unsupported -> code",
		"application/x-sh: unsupported -> code",
		"application/x-tar: unsupported -> archive",
		"application/x-yaml: unsupported -> code",
		"application/yaml: unsupported -> code",
		"text/jsx: text -> code",
		"text/rust: text -> code",
		"text/tab-separated-values: text -> xlsx",
		"text/tsx: text -> code",
		"text/x-c++src: text -> code",
		"text/x-csharp: text -> code",
		"text/x-csrc: text -> code",
		"text/x-go: text -> code",
		"text/x-java-source: text -> code",
		"text/x-kotlin: text -> code",
		"text/x-less: text -> code",
		"text/x-python: text -> code",
		"text/x-r-source: text -> code",
		"text/x-ruby: text -> code",
		"text/x-sass: text -> code",
		"text/x-shellscript: text -> code",
		"text/x-swift: text -> code",
		"text/yaml: text -> code",
	] as readonly string[],
} as const;

const ALL_EXTENSIONS = FILE_TYPE_ENTRIES.flatMap((entry) => [
	...entry.extensions,
]);

// ───────────────────────────────────────────────────────────────────────────
// FROZEN: src/lib/server/services/file-production/output-types.ts:7-113
// ───────────────────────────────────────────────────────────────────────────
const FROZEN_OUTPUT_TYPE_EXTENSIONS: Record<string, string> = {
	pdf: ".pdf",
	"application/pdf": ".pdf",
	txt: ".txt",
	text: ".txt",
	"text/plain": ".txt",
	md: ".md",
	markdown: ".md",
	"text/markdown": ".md",
	csv: ".csv",
	"text/csv": ".csv",
	html: ".html",
	"text/html": ".html",
	css: ".css",
	"text/css": ".css",
	scss: ".scss",
	"text/x-scss": ".scss",
	sass: ".sass",
	"text/x-sass": ".sass",
	less: ".less",
	"text/x-less": ".less",
	js: ".js",
	javascript: ".js",
	"application/javascript": ".js",
	"text/javascript": ".js",
	mjs: ".mjs",
	cjs: ".cjs",
	jsx: ".jsx",
	"text/jsx": ".jsx",
	ts: ".ts",
	typescript: ".ts",
	"application/typescript": ".ts",
	"text/typescript": ".ts",
	tsx: ".tsx",
	"text/tsx": ".tsx",
	py: ".py",
	python: ".py",
	"text/x-python": ".py",
	sh: ".sh",
	shell: ".sh",
	bash: ".sh",
	zsh: ".zsh",
	"application/x-sh": ".sh",
	"text/x-shellscript": ".sh",
	json: ".json",
	"application/json": ".json",
	xml: ".xml",
	"application/xml": ".xml",
	yaml: ".yaml",
	"application/yaml": ".yaml",
	yml: ".yml",
	toml: ".toml",
	"application/toml": ".toml",
	sql: ".sql",
	"application/sql": ".sql",
	graphql: ".graphql",
	gql: ".gql",
	"application/graphql": ".graphql",
	ini: ".ini",
	env: ".env",
	conf: ".conf",
	log: ".log",
	rb: ".rb",
	ruby: ".rb",
	"text/x-ruby": ".rb",
	rs: ".rs",
	rust: ".rs",
	"text/rust": ".rs",
	go: ".go",
	"text/x-go": ".go",
	java: ".java",
	"text/x-java-source": ".java",
	kt: ".kt",
	kotlin: ".kt",
	"text/x-kotlin": ".kt",
	swift: ".swift",
	"text/x-swift": ".swift",
	cs: ".cs",
	csharp: ".cs",
	"text/x-csharp": ".cs",
	cpp: ".cpp",
	cxx: ".cxx",
	cc: ".cc",
	"text/x-c++src": ".cpp",
	c: ".c",
	"text/x-csrc": ".c",
	h: ".h",
	hpp: ".hpp",
	php: ".php",
	"application/x-httpd-php": ".php",
	r: ".r",
	"text/x-r-source": ".r",
	svg: ".svg",
	"image/svg+xml": ".svg",
	xlsx: ".xlsx",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
	docx: ".docx",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document":
		".docx",
	pptx: ".pptx",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation":
		".pptx",
	odt: ".odt",
	"application/vnd.oasis.opendocument.text": ".odt",
	zip: ".zip",
	"application/zip": ".zip",
};

// ───────────────────────────────────────────────────────────────────────────
// FROZEN: src/lib/server/services/file-production/output-validation.ts:14-80
// ───────────────────────────────────────────────────────────────────────────
const FROZEN_EXTENSION_MIME_TYPES: Record<string, string[]> = {
	".pdf": ["application/pdf"],
	".txt": ["text/plain"],
	".md": ["text/markdown", "text/plain"],
	".markdown": ["text/markdown", "text/plain"],
	".csv": ["text/csv", "text/plain"],
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

// FROZEN: src/lib/server/services/file-production/output-validation.ts:87-136
const FROZEN_TEXT_LIKE_EXTENSIONS = [
	".txt",
	".md",
	".markdown",
	".csv",
	".html",
	".htm",
	".css",
	".scss",
	".sass",
	".less",
	".js",
	".mjs",
	".cjs",
	".jsx",
	".ts",
	".tsx",
	".py",
	".sh",
	".bash",
	".zsh",
	".json",
	".xml",
	".yaml",
	".yml",
	".toml",
	".sql",
	".graphql",
	".gql",
	".ini",
	".env",
	".conf",
	".log",
	".rb",
	".rs",
	".go",
	".java",
	".kt",
	".kts",
	".swift",
	".cs",
	".cpp",
	".cxx",
	".cc",
	".c",
	".h",
	".hpp",
	".php",
	".r",
];

// FROZEN: src/lib/server/services/generated-file-serving.ts:45-95
const FROZEN_FULL_VALIDATION_EXTENSIONS = [
	...FROZEN_TEXT_LIKE_EXTENSIONS,
	".xlsx",
];

// ───────────────────────────────────────────────────────────────────────────
// FROZEN: src/lib/server/services/sandbox-execution.ts:30-93
// ───────────────────────────────────────────────────────────────────────────
const FROZEN_SANDBOX_MIME_TYPES: Record<string, string> = {
	".pdf": "application/pdf",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".xls": "application/vnd.ms-excel",
	".pptx":
		"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".docx":
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".odt": "application/vnd.oasis.opendocument.text",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".js": "text/javascript",
	".mjs": "text/javascript",
	".cjs": "text/javascript",
	".jsx": "text/jsx",
	".py": "text/x-python",
	".ts": "application/typescript",
	".tsx": "text/tsx",
	".css": "text/css",
	".scss": "text/x-scss",
	".sass": "text/x-sass",
	".less": "text/x-less",
	".csv": "text/csv",
	".json": "application/json",
	".zip": "application/zip",
	".txt": "text/plain",
	".md": "text/markdown",
	".markdown": "text/markdown",
	".xml": "application/xml",
	".rtf": "application/rtf",
	".svg": "image/svg+xml",
	".html": "text/html",
	".htm": "text/html",
	".yaml": "application/yaml",
	".yml": "application/yaml",
	".sh": "application/x-sh",
	".bash": "application/x-sh",
	".zsh": "application/x-sh",
	".sql": "application/sql",
	".graphql": "application/graphql",
	".gql": "application/graphql",
	".toml": "application/toml",
	".ini": "text/plain",
	".env": "text/plain",
	".conf": "text/plain",
	".log": "text/plain",
	".rb": "text/x-ruby",
	".rs": "text/rust",
	".go": "text/x-go",
	".java": "text/x-java-source",
	".kt": "text/x-kotlin",
	".kts": "text/x-kotlin",
	".swift": "text/x-swift",
	".cs": "text/x-csharp",
	".cpp": "text/x-c++src",
	".cxx": "text/x-c++src",
	".cc": "text/x-c++src",
	".c": "text/x-csrc",
	".h": "text/x-csrc",
	".hpp": "text/x-c++src",
	".php": "application/x-httpd-php",
	".r": "text/x-r-source",
};

// ───────────────────────────────────────────────────────────────────────────
// FROZEN: src/lib/utils/file-preview.ts
// ───────────────────────────────────────────────────────────────────────────

// :119-190
const FROZEN_EXTENSION_CONTENT_TYPES: Record<string, string> = {
	pdf: "application/pdf",
	doc: "application/msword",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xls: "application/vnd.ms-excel",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	ppt: "application/vnd.ms-powerpoint",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	odt: "application/vnd.oasis.opendocument.text",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	bmp: "image/bmp",
	tif: "image/tiff",
	tiff: "image/tiff",
	heic: "image/heic",
	heif: "image/heif",
	avif: "image/avif",
	txt: "text/plain",
	md: "text/markdown",
	markdown: "text/markdown",
	csv: "text/csv",
	html: "text/html",
	htm: "text/html",
	css: "text/css",
	scss: "text/x-scss",
	sass: "text/x-sass",
	less: "text/x-less",
	js: "application/javascript",
	mjs: "application/javascript",
	cjs: "application/javascript",
	jsx: "text/jsx",
	json: "application/json",
	xml: "application/xml",
	rtf: "application/rtf",
	py: "text/x-python",
	ts: "application/typescript",
	tsx: "text/tsx",
	yaml: "application/yaml",
	yml: "application/yaml",
	sh: "application/x-sh",
	bash: "application/x-sh",
	zsh: "application/x-sh",
	sql: "application/sql",
	graphql: "application/graphql",
	gql: "application/graphql",
	toml: "application/toml",
	ini: "text/plain",
	env: "text/plain",
	conf: "text/plain",
	log: "text/plain",
	rb: "text/x-ruby",
	rs: "text/rust",
	go: "text/x-go",
	java: "text/x-java-source",
	kt: "text/x-kotlin",
	kts: "text/x-kotlin",
	swift: "text/x-swift",
	cs: "text/x-csharp",
	cpp: "text/x-c++src",
	cxx: "text/x-c++src",
	cc: "text/x-c++src",
	c: "text/x-csrc",
	h: "text/x-csrc",
	hpp: "text/x-c++src",
	php: "application/x-httpd-php",
	r: "text/x-r-source",
	zip: "application/zip",
};

// :12-62
const FROZEN_TEXT_EXTENSIONS = [
	"txt",
	"md",
	"markdown",
	"csv",
	"json",
	"html",
	"htm",
	"xml",
	"rtf",
	"css",
	"scss",
	"sass",
	"less",
	"js",
	"mjs",
	"cjs",
	"jsx",
	"py",
	"ts",
	"tsx",
	"yaml",
	"yml",
	"sh",
	"bash",
	"zsh",
	"sql",
	"graphql",
	"gql",
	"toml",
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
	"c",
	"h",
	"hpp",
	"php",
	"r",
];

// :103-117 (and the same list at attachment-file-type.ts:31-45, reordered)
const FROZEN_IMAGE_EXTENSIONS = [
	"jpg",
	"jpeg",
	"jfif",
	"png",
	"gif",
	"webp",
	"svg",
	"bmp",
	"tif",
	"tiff",
	"heic",
	"heif",
	"avif",
];

// :192-200
const FROZEN_TRUSTED_PREVIEW_EXTENSIONS: Record<string, PreviewKind> = {
	pdf: "pdf",
	docx: "docx",
	xlsx: "xlsx",
	pptx: "pptx",
	odt: "odt",
	html: "html",
	htm: "html",
};

// :64-96
const FROZEN_PREVIEWABLE_TEXT_MIME_TYPES = [
	"text/markdown",
	"application/json",
	"application/csv",
	"application/xml",
	"application/rtf",
	"application/javascript",
	"text/javascript",
	"text/jsx",
	"text/x-python",
	"application/typescript",
	"text/tsx",
	"application/yaml",
	"application/x-sh",
	"text/x-shellscript",
	"application/sql",
	"application/graphql",
	"application/toml",
	"text/x-scss",
	"text/x-sass",
	"text/x-less",
	"text/x-ruby",
	"text/rust",
	"text/x-go",
	"text/x-java-source",
	"text/x-kotlin",
	"text/x-swift",
	"text/x-csharp",
	"text/x-c++src",
	"text/x-csrc",
	"application/x-httpd-php",
	"text/x-r-source",
];

// :241-288
const FROZEN_EXTENSION_TO_PREVIEW_LANGUAGE: Record<string, string> = {
	py: "python",
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	jsx: "jsx",
	ts: "typescript",
	tsx: "tsx",
	json: "json",
	html: "html",
	htm: "html",
	css: "css",
	scss: "scss",
	sass: "sass",
	less: "less",
	md: "markdown",
	markdown: "markdown",
	xml: "xml",
	svg: "xml",
	yaml: "yaml",
	yml: "yaml",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	sql: "sql",
	graphql: "graphql",
	gql: "graphql",
	toml: "toml",
	ini: "ini",
	env: "ini",
	conf: "ini",
	rb: "ruby",
	rs: "rust",
	go: "go",
	java: "java",
	kt: "kotlin",
	kts: "kotlin",
	swift: "swift",
	cs: "csharp",
	cpp: "cpp",
	cxx: "cpp",
	cc: "cpp",
	hpp: "cpp",
	c: "c",
	h: "c",
	php: "php",
	r: "r",
};

// :290-322
const FROZEN_MIME_TO_PREVIEW_LANGUAGE: Record<string, string> = {
	"application/json": "json",
	"application/xml": "xml",
	"text/html": "html",
	"text/css": "css",
	"text/x-scss": "scss",
	"text/x-sass": "sass",
	"text/x-less": "less",
	"application/javascript": "javascript",
	"text/javascript": "javascript",
	"text/jsx": "jsx",
	"text/markdown": "markdown",
	"text/x-python": "python",
	"application/typescript": "typescript",
	"text/tsx": "tsx",
	"application/yaml": "yaml",
	"application/x-sh": "bash",
	"text/x-shellscript": "bash",
	"application/sql": "sql",
	"application/graphql": "graphql",
	"application/toml": "toml",
	"text/x-ruby": "ruby",
	"text/rust": "rust",
	"text/x-go": "go",
	"text/x-java-source": "java",
	"text/x-kotlin": "kotlin",
	"text/x-swift": "swift",
	"text/x-csharp": "csharp",
	"text/x-c++src": "cpp",
	"text/x-csrc": "c",
	"application/x-httpd-php": "php",
	"text/x-r-source": "r",
};

// ───────────────────────────────────────────────────────────────────────────
// FROZEN: src/lib/components/chat/attachment-file-type.ts:31-138
// ───────────────────────────────────────────────────────────────────────────
const FROZEN_ATTACHMENT_IMAGE = [
	"png",
	"jpg",
	"jpeg",
	"jfif",
	"gif",
	"bmp",
	"tiff",
	"tif",
	"svg",
	"webp",
	"heic",
	"heif",
	"avif",
];
const FROZEN_ATTACHMENT_SPREADSHEET = ["csv", "xls", "xlsx", "ods"];
const FROZEN_ATTACHMENT_PRESENTATION = ["ppt", "pptx", "odp"];
const FROZEN_ATTACHMENT_DOCUMENT = [
	"txt",
	"md",
	"rtf",
	"log",
	"odt",
	"doc",
	"docx",
];
const FROZEN_ATTACHMENT_CODE = [
	"js",
	"ts",
	"tsx",
	"jsx",
	"json",
	"xml",
	"html",
	"htm",
	"css",
	"py",
	"java",
	"go",
	"rs",
	"sh",
	"rb",
];
const FROZEN_ATTACHMENT_ARCHIVE = ["zip", "rar", "7z", "tar", "gz"];

function frozenFileExtension(filename: string): string {
	const parts = filename.split(".");
	if (parts.length < 2) return "";
	return (parts.pop() ?? "").toLowerCase().trim();
}

function frozenGetFileType(mimeType: string | null, filename: string): string {
	const mime = (mimeType ?? "").toLowerCase().trim();
	const ext = frozenFileExtension(filename);

	if (FROZEN_ATTACHMENT_IMAGE.includes(ext)) return "image";
	if (ext === "pdf") return "pdf";
	if (FROZEN_ATTACHMENT_SPREADSHEET.includes(ext)) return "xlsx";
	if (FROZEN_ATTACHMENT_PRESENTATION.includes(ext)) return "pptx";
	if (FROZEN_ATTACHMENT_DOCUMENT.includes(ext)) return "text";
	if (FROZEN_ATTACHMENT_CODE.includes(ext)) return "code";
	if (FROZEN_ATTACHMENT_ARCHIVE.includes(ext)) return "archive";

	if (mime.startsWith("image/")) return "image";
	if (mime === "application/pdf") return "pdf";

	if (mime.includes("wordprocessingml") || mime.includes("msword"))
		return "text";
	if (
		mime.includes("spreadsheetml") ||
		mime.includes("spreadsheet") ||
		mime.includes("excel") ||
		mime.includes("csv")
	) {
		return "xlsx";
	}
	if (mime.includes("presentationml") || mime.includes("presentation")) {
		return "pptx";
	}

	if (
		mime.includes("code") ||
		mime.includes("javascript") ||
		mime.includes("typescript") ||
		mime.includes("json") ||
		mime.includes("xml") ||
		mime.includes("html") ||
		mime.includes("css")
	) {
		return "code";
	}
	if (
		mime.includes("zip") ||
		mime.includes("compressed") ||
		mime.includes("archive")
	) {
		return "archive";
	}
	if (mime.startsWith("text/") || mime.includes("document")) return "text";

	return "unsupported";
}

/**
 * The 10-line map slice B adds next to `getFileType`. It lives here too so
 * this test proves the `FileTypeCategory` vocabulary is rich enough to
 * reproduce `AttachmentFileType`.
 */
const CATEGORY_TO_ATTACHMENT_TYPE: Record<FileTypeCategory, string> = {
	image: "image",
	pdf: "pdf",
	spreadsheet: "xlsx",
	presentation: "pptx",
	document: "text",
	text: "text",
	code: "code",
	archive: "archive",
	media: "unsupported",
	other: "unsupported",
};

// ───────────────────────────────────────────────────────────────────────────
// FROZEN: src/routes/(app)/knowledge/_components/DocumentsList.svelte
// ───────────────────────────────────────────────────────────────────────────

// :190 — the accept string the knowledge upload input publishes today.
const FROZEN_ACCEPT_STRING =
	".pdf,.doc,.docx,.txt,.md,.json,.csv,.xlsx,.xls,.pptx,.ppt,.html,.htm,.jpg,.jpeg,.jfif,.png,.gif,.bmp,.tiff,.tif,.webp,.svg,.heic,.heif,.avif";

// :556-558 — note it differs from `fileExtension`: no dot means "".
function frozenGetFileExtension(value: string): string {
	if (!value.includes(".")) return "";
	return value.split(".").pop()?.toLowerCase() ?? "";
}

// :623-730, with the Lucide components replaced by their import names.
function frozenGetFileIcon(mimeType: string | null, filename: string): string {
	const mime = (mimeType ?? "").toLowerCase().trim();
	const extension = frozenGetFileExtension(filename);

	if (
		mime.startsWith("image/") ||
		[
			"png",
			"jpg",
			"jpeg",
			"jfif",
			"gif",
			"bmp",
			"tiff",
			"tif",
			"svg",
			"webp",
			"heic",
			"heif",
			"avif",
		].includes(extension)
	) {
		return "Image";
	}
	if (mime === "application/pdf" || extension === "pdf") return "FileText";
	if (
		mime.includes("spreadsheet") ||
		mime.includes("excel") ||
		mime.includes("csv") ||
		["csv", "xls", "xlsx", "ods"].includes(extension)
	) {
		return "Table";
	}
	if (
		mime.includes("presentation") ||
		["ppt", "pptx", "odp"].includes(extension)
	) {
		return "Monitor";
	}
	if (
		mime.includes("wordprocessingml") ||
		mime.includes("opendocument.text") ||
		mime.includes("msword") ||
		["doc", "docx", "odt", "rtf"].includes(extension)
	) {
		return "FileText";
	}
	if (
		mime.includes("code") ||
		mime.includes("javascript") ||
		mime.includes("typescript") ||
		mime.includes("json") ||
		mime.includes("xml") ||
		mime.includes("html") ||
		mime.includes("css") ||
		[
			"js",
			"ts",
			"tsx",
			"jsx",
			"json",
			"xml",
			"html",
			"css",
			"py",
			"java",
			"go",
			"rs",
		].includes(extension)
	) {
		return "Code";
	}
	if (
		mime.includes("zip") ||
		mime.includes("compressed") ||
		mime.includes("archive") ||
		["zip", "rar", "7z", "tar", "gz"].includes(extension)
	) {
		return "Archive";
	}
	if (
		mime.includes("text/") ||
		["txt", "md", "rtf", "log", "odt", "doc", "docx"].includes(extension) ||
		mime.includes("document") ||
		mime.includes("word")
	) {
		return "FileText";
	}
	return "FileIcon";
}

/** The `CATEGORY_TO_ICON` record slice C replaces `getFileIcon` with. */
const CATEGORY_TO_ICON: Record<FileTypeCategory, string> = {
	image: "Image",
	pdf: "FileText",
	spreadsheet: "Table",
	presentation: "Monitor",
	document: "FileText",
	text: "FileText",
	code: "Code",
	archive: "Archive",
	media: "FileIcon",
	other: "FileIcon",
};

// :564-622
function frozenFormatFileType(
	mimeType: string | null,
	filename: string,
): string {
	const mime = (mimeType ?? "").toLowerCase();
	const ext = frozenGetFileExtension(filename);

	if (mime === "application/pdf") return "PDF";
	if (
		mime.startsWith("text/") ||
		ext === "txt" ||
		ext === "md" ||
		ext === "markdown"
	) {
		return ext.toUpperCase() || "TXT";
	}
	if (
		mime ===
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
		ext === "docx"
	)
		return "DOCX";
	if (mime === "application/msword" || ext === "doc") return "DOC";
	if (
		mime ===
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
		ext === "xlsx"
	)
		return "XLSX";
	if (mime === "application/vnd.ms-excel" || ext === "xls") return "XLS";
	if (
		mime ===
			"application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
		ext === "pptx"
	)
		return "PPTX";
	if (mime === "application/vnd.ms-powerpoint" || ext === "ppt") return "PPT";
	if (mime === "text/csv" || ext === "csv") return "CSV";
	if (mime === "application/json" || ext === "json") return "JSON";
	if (
		mime.startsWith("image/") ||
		[
			"png",
			"jpg",
			"jpeg",
			"gif",
			"bmp",
			"tiff",
			"tif",
			"webp",
			"svg",
			"heic",
			"heif",
			"avif",
		].includes(ext)
	) {
		return ext.toUpperCase() || "IMG";
	}
	if (mime === "text/html" || ext === "html" || ext === "htm") return "HTML";
	if (ext) return ext.toUpperCase();
	return "FILE";
}

/**
 * The registry-driven replacement for `formatFileType`. NOTE this is NOT
 * `getEntryByFilename(name)?.extensions[0].toUpperCase()` as spec checklist
 * row 19 suggests: canonicalising would turn `.jpeg` into "JPG", `.tiff` into
 * "TIF" and `.markdown` into "MD". The file's own extension is the label; the
 * canonical is only consulted for the one case the old code special-cased
 * (`.htm` displays "HTML") and for a file with no extension at all.
 */
function registryFormatFileType(
	mimeType: string | null,
	filename: string,
): string {
	const extension = fileExtension(filename);
	if (!extension) {
		const byMime = getEntryByMimeType(mimeType);
		return byMime ? byMime.extensions[0].toUpperCase() : "FILE";
	}
	if (getEntryByFilename(filename)?.preview.kind === "html") return "HTML";
	return extension.toUpperCase();
}

// ───────────────────────────────────────────────────────────────────────────
// FROZEN: src/lib/server/services/document-extraction.ts
// ───────────────────────────────────────────────────────────────────────────

// :15-69
const FROZEN_MIME_FROM_EXTENSION: Record<string, string> = {
	".pdf": "application/pdf",
	".docx":
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".pptx":
		"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".odt": "application/vnd.oasis.opendocument.text",
	".doc": "application/msword",
	".xls": "application/vnd.ms-excel",
	".ppt": "application/vnd.ms-powerpoint",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".bmp": "image/bmp",
	".webp": "image/webp",
	".tiff": "image/tiff",
	".tif": "image/tiff",
	".svg": "image/svg+xml",
	".heic": "image/heic",
	".heif": "image/heif",
	".avif": "image/avif",
	".txt": "text/plain",
	".md": "text/markdown",
	".html": "text/html",
	".htm": "text/html",
	".csv": "text/csv",
	".json": "application/json",
	".py": "text/x-python",
	".js": "text/javascript",
	".ts": "application/typescript",
	".css": "text/css",
	".yaml": "application/yaml",
	".yml": "application/yaml",
	".xml": "application/xml",
};

// :115-143
function frozenIsDirectTextExtractionFile(
	ext: string,
	mimeType: string | null,
): boolean {
	const normalizedMime = mimeType?.toLowerCase() ?? "";
	return (
		normalizedMime.startsWith("text/") ||
		normalizedMime === "application/json" ||
		normalizedMime === "application/xml" ||
		normalizedMime === "application/yaml" ||
		normalizedMime === "application/typescript" ||
		[
			".txt",
			".md",
			".markdown",
			".html",
			".htm",
			".csv",
			".json",
			".py",
			".js",
			".ts",
			".css",
			".yaml",
			".yml",
			".xml",
		].includes(ext)
	);
}

// ───────────────────────────────────────────────────────────────────────────
// FROZEN: produce-file.ts:675-681 and execution-adapter.ts:98-118
// ───────────────────────────────────────────────────────────────────────────
function frozenShouldUseDocumentSourceForOutputs(
	outputs: Array<{ type: string }>,
): boolean {
	const documentTypes = new Set(["pdf", "docx", "html"]);
	return outputs.every((output) =>
		documentTypes.has(output.type.trim().toLowerCase()),
	);
}

const FROZEN_NORMALIZE_DOCUMENT_OUTPUT: Record<string, string> = {
	pdf: "pdf",
	"application/pdf": "pdf",
	docx: "docx",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document":
		"docx",
	html: "html",
	"text/html": "html",
	markdown: "markdown",
	md: "markdown",
	"text/markdown": "markdown",
};

// ───────────────────────────────────────────────────────────────────────────
// FROZEN: image allowlists
// ───────────────────────────────────────────────────────────────────────────

// src/routes/api/settings/avatar/+server.ts:11-21
const FROZEN_AVATAR_ALLOWED_TYPES = [
	"image/jpeg",
	"image/png",
	"image/webp",
	"image/gif",
	"image/avif",
	"image/heic",
	"image/heif",
	"image/tiff",
	"image/bmp",
];

// src/lib/server/services/campaign-assets.ts:9-20
const FROZEN_CAMPAIGN_ALLOWED_IMAGE_TYPES = [
	...FROZEN_AVATAR_ALLOWED_TYPES,
	"image/svg+xml",
];

// src/lib/server/services/campaign-assets.ts:22-33
const FROZEN_CAMPAIGN_MIME_EXTENSIONS: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"image/gif": "gif",
	"image/avif": "avif",
	"image/heic": "heic",
	"image/heif": "heif",
	"image/tiff": "tiff",
	"image/bmp": "bmp",
	"image/svg+xml": "svg",
};

// src/lib/server/services/file-production/output-types.ts:134
const FROZEN_OUTPUT_TYPE_EXAMPLES = "xlsx, docx, pptx, pdf, csv, zip";

// ───────────────────────────────────────────────────────────────────────────

function sorted(values: Iterable<string>): string[] {
	return [...values].sort();
}

describe("legacy equivalence — production tables", () => {
	it("reproduces OUTPUT_TYPE_EXTENSIONS exactly, both directions", () => {
		expect(buildOutputTokenMap()).toEqual(FROZEN_OUTPUT_TYPE_EXTENSIONS);
		expect(FROZEN_OUTPUT_TYPE_EXTENSIONS).toEqual(buildOutputTokenMap());
	});

	it("reproduces EXTENSION_MIME_TYPES key by key, order included", () => {
		for (const [extension, mimeTypes] of Object.entries(
			FROZEN_EXTENSION_MIME_TYPES,
		)) {
			expect(
				getAllowedMimeTypesForProducedExtension(extension),
				extension,
			).toEqual(mimeTypes);
		}
	});

	it("leaves a produced extension outside the frozen map unconstrained", () => {
		expect(getAllowedMimeTypesForProducedExtension(".doc")).toEqual([]);
		expect(getAllowedMimeTypesForProducedExtension(".mp4")).toEqual([]);
		expect(getAllowedMimeTypesForProducedExtension(".qqq")).toEqual([]);
	});

	it("reproduces TEXT_LIKE_EXTENSIONS", () => {
		const fromRegistry = ALL_EXTENSIONS.filter((extension) =>
			isTextLikeExtension(`.${extension}`),
		).map((extension) => `.${extension}`);
		expect(sorted(fromRegistry)).toEqual(sorted(FROZEN_TEXT_LIKE_EXTENSIONS));

		for (const extension of FROZEN_TEXT_LIKE_EXTENSIONS) {
			expect(getProductionValidationClass(extension), extension).toBe("text");
		}
		// The single documented difference from file-preview's TEXT_EXTENSIONS.
		expect(isTextLikeExtension(".rtf")).toBe(false);
		expect(isTextLikeExtension(".svg")).toBe(false);
	});

	it("derives FULL_VALIDATION_EXTENSIONS as textLike + xlsx", () => {
		const fromRegistry = ALL_EXTENSIONS.filter((extension) =>
			requiresFullContentValidation(`.${extension}`),
		).map((extension) => `.${extension}`);
		expect(sorted(fromRegistry)).toEqual(
			sorted(FROZEN_FULL_VALIDATION_EXTENSIONS),
		);
		expect(getProductionValidationClass(".xlsx")).toBe("xlsx");
	});

	it("reproduces the sandbox MIME_TYPES map", () => {
		for (const [extension, mimeType] of Object.entries(
			FROZEN_SANDBOX_MIME_TYPES,
		)) {
			expect(getSandboxMimeTypeForExtension(extension), extension).toBe(
				mimeType,
			);
		}
		expect(getSandboxMimeTypeForExtension(".qqq")).toBeNull();
	});

	it("reproduces shouldUseDocumentSourceForOutputs", () => {
		const tokens = [
			"pdf",
			"docx",
			"html",
			"md",
			"markdown",
			"csv",
			"xlsx",
			"zip",
		];
		const samples: string[][] = [[]];
		for (const token of tokens) {
			samples.push([token]);
			for (const other of tokens) samples.push([token, other]);
		}
		samples.push(tokens, ["pdf", "docx", "html"], ["PDF", " docx "]);

		for (const sample of samples) {
			expect(shouldUseDocumentSourceForOutputs(sample), sample.join("+")).toBe(
				frozenShouldUseDocumentSourceForOutputs(
					sample.map((type) => ({ type })),
				),
			);
		}
		// An empty request stays `true`, as `Array.every` always did.
		expect(shouldUseDocumentSourceForOutputs([])).toBe(true);
		// `application/pdf` was never in the frozen set and still is not.
		expect(shouldUseDocumentSourceForOutputs(["application/pdf"])).toBe(false);
	});

	it("reproduces normalizeDocumentOutput", () => {
		for (const [type, expected] of Object.entries(
			FROZEN_NORMALIZE_DOCUMENT_OUTPUT,
		)) {
			expect(normalizeDocumentOutput(type), type).toBe(expected);
		}
		expect(Object.keys(FROZEN_NORMALIZE_DOCUMENT_OUTPUT)).toHaveLength(9);
		for (const type of ["csv", "xlsx", "zip", "svg", "txt", "text/plain", ""]) {
			expect(normalizeDocumentOutput(type), type).toBeNull();
		}
	});

	it("reproduces FILE_PRODUCTION_OUTPUT_TYPE_EXAMPLES byte for byte", () => {
		expect(FILE_PRODUCTION_OUTPUT_TYPE_EXAMPLES).toBe(
			FROZEN_OUTPUT_TYPE_EXAMPLES,
		);
	});
});

describe("legacy equivalence — preview tables", () => {
	it("reproduces EXTENSION_CONTENT_TYPES apart from the javascript conflict", () => {
		for (const [extension, mimeType] of Object.entries(
			FROZEN_EXTENSION_CONTENT_TYPES,
		)) {
			const actual = getCanonicalMimeForExtension(extension);
			if (
				(KNOWN_DELTAS.javascriptCanonicalMime as readonly string[]).includes(
					extension,
				)
			) {
				expect(mimeType, extension).toBe("application/javascript");
				expect(actual, extension).toBe("text/javascript");
				continue;
			}
			expect(actual, extension).toBe(mimeType);
		}
	});

	it("gives .jfif a real MIME where the old maps had none", () => {
		expect(FROZEN_EXTENSION_CONTENT_TYPES.jfif).toBeUndefined();
		expect(FROZEN_MIME_FROM_EXTENSION[".jfif"]).toBeUndefined();
		for (const extension of KNOWN_DELTAS.jfifCanonicalMime) {
			expect(getCanonicalMimeForExtension(extension)).toBe("image/jpeg");
			expect(getContentTypeForFile(`x.${extension}`, null)).toBe("image/jpeg");
		}
	});

	it("reproduces getPreviewContentType", () => {
		for (const [extension, mimeType] of Object.entries(
			FROZEN_EXTENSION_CONTENT_TYPES,
		)) {
			const expected = (
				KNOWN_DELTAS.javascriptCanonicalMime as readonly string[]
			).includes(extension)
				? "text/javascript"
				: mimeType;
			expect(getContentTypeForFile(`x.${extension}`, null), extension).toBe(
				expected,
			);
			// A declared, non-generic MIME always wins over the extension.
			expect(getContentTypeForFile(`x.${extension}`, "text/weird")).toBe(
				"text/weird",
			);
			// A generic one never does.
			expect(
				getContentTypeForFile(`x.${extension}`, "application/octet-stream"),
			).toBe(expected);
		}
		expect(getContentTypeForFile("mystery", null)).toBe(
			"application/octet-stream",
		);
	});

	it("reproduces TEXT_EXTENSIONS, modulo html/htm", () => {
		const previewsAsText = ALL_EXTENSIONS.filter(
			(extension) => getPreviewKind(`x.${extension}`, null) === "text",
		);
		// `html`/`htm` are in TEXT_EXTENSIONS but TRUSTED_PREVIEW_EXTENSIONS wins
		// for them, so they never resolved to "text" either. The registry stores
		// that directly: preview.kind === "html".
		expect(sorted(previewsAsText)).toEqual(
			sorted(
				FROZEN_TEXT_EXTENSIONS.filter(
					(extension) => extension !== "html" && extension !== "htm",
				),
			),
		);
		for (const extension of ["html", "htm"]) {
			expect(FROZEN_TEXT_EXTENSIONS).toContain(extension);
			expect(getPreviewKind(`x.${extension}`, null)).toBe("html");
		}
	});

	it("reproduces IMAGE_EXTENSIONS", () => {
		const images = ALL_EXTENSIONS.filter(
			(extension) => getCategory(`x.${extension}`, null) === "image",
		);
		expect(sorted(images)).toEqual(sorted(FROZEN_IMAGE_EXTENSIONS));
		expect(sorted(images)).toEqual(sorted(FROZEN_ATTACHMENT_IMAGE));
	});

	it("reproduces TRUSTED_PREVIEW_EXTENSIONS", () => {
		for (const [extension, kind] of Object.entries(
			FROZEN_TRUSTED_PREVIEW_EXTENSIONS,
		)) {
			expect(getPreviewKind(`x.${extension}`, null), extension).toBe(kind);
			// "Trusted" means the declared MIME cannot override it.
			expect(
				getPreviewKind(`x.${extension}`, "application/octet-stream"),
				extension,
			).toBe(kind);
			expect(getPreviewKind(`x.${extension}`, "text/plain"), extension).toBe(
				kind,
			);
		}
		for (const extension of FROZEN_IMAGE_EXTENSIONS) {
			expect(getPreviewKind(`x.${extension}`, "text/plain"), extension).toBe(
				"image",
			);
		}
	});

	it("reproduces both preview-language maps", () => {
		for (const [extension, language] of Object.entries(
			FROZEN_EXTENSION_TO_PREVIEW_LANGUAGE,
		)) {
			expect(getPreviewLanguage(`x.${extension}`, null), extension).toBe(
				language,
			);
		}
		for (const [mimeType, language] of Object.entries(
			FROZEN_MIME_TO_PREVIEW_LANGUAGE,
		)) {
			expect(getPreviewLanguage("mystery", mimeType), mimeType).toBe(language);
		}
	});

	it("keeps every PREVIEWABLE_TEXT_MIME_TYPE previewing as text", () => {
		for (const mimeType of FROZEN_PREVIEWABLE_TEXT_MIME_TYPES) {
			expect(getPreviewKind("mystery", mimeType), mimeType).toBe("text");
		}
	});
});

describe("legacy equivalence — glyph surfaces", () => {
	it("reproduces attachment-file-type.getFileType", () => {
		const observed: Record<string, readonly [string, string]> = {};
		for (const extension of ALL_EXTENSIONS) {
			const filename = `x.${extension}`;
			const before = frozenGetFileType(null, filename);
			const after = CATEGORY_TO_ATTACHMENT_TYPE[getCategory(filename, null)];
			if (before !== after) observed[extension] = [before, after];
		}
		expect(observed).toEqual(KNOWN_DELTAS.attachmentGlyphExpansion);
		// Every delta is a file that used to draw the generic glyph.
		for (const [before] of Object.values(
			KNOWN_DELTAS.attachmentGlyphExpansion,
		)) {
			expect(before).toBe("unsupported");
		}
	});

	it("reproduces getFileType for MIME-only inputs", () => {
		const mimeTypes = [
			...new Set(FILE_TYPE_ENTRIES.flatMap((entry) => [...entry.mimeTypes])),
			"text/weird",
			"application/whatever",
		].filter((mimeType) => mimeType !== "application/octet-stream");

		const observed: string[] = [];
		for (const mimeType of mimeTypes) {
			const before = frozenGetFileType(mimeType, "mystery");
			const after =
				CATEGORY_TO_ATTACHMENT_TYPE[getCategory("mystery", mimeType)];
			if (before !== after) observed.push(`${mimeType}: ${before} -> ${after}`);
		}
		expect(sorted(observed)).toEqual(
			sorted(KNOWN_DELTAS.mimeOnlyGlyphExpansion),
		);
	});

	it("reproduces DocumentsList.getFileIcon", () => {
		const observed: Record<string, readonly [string, string]> = {};
		for (const extension of ALL_EXTENSIONS) {
			const filename = `x.${extension}`;
			const before = frozenGetFileIcon(null, filename);
			const after = CATEGORY_TO_ICON[getCategory(filename, null)];
			if (before !== after) observed[extension] = [before, after];
		}
		expect(observed).toEqual(KNOWN_DELTAS.knowledgeIconExpansion);
		for (const [before] of Object.values(KNOWN_DELTAS.knowledgeIconExpansion)) {
			expect(before).toBe("FileIcon");
		}
	});

	it("reproduces DocumentsList.formatFileType exactly", () => {
		for (const extension of ALL_EXTENSIONS) {
			const filename = `x.${extension}`;
			expect(registryFormatFileType(null, filename), extension).toBe(
				frozenFormatFileType(null, filename),
			);
		}
		expect(registryFormatFileType(null, "mystery")).toBe("FILE");
		expect(registryFormatFileType("application/pdf", "mystery")).toBe("PDF");
		expect(registryFormatFileType(null, "x.htm")).toBe("HTML");
	});

	it("reproduces the knowledge accept string byte for byte", () => {
		expect(getAcceptAttribute("knowledge")).toBe(FROZEN_ACCEPT_STRING);
	});
});

describe("legacy equivalence — intake", () => {
	it("reproduces mimeFromExtension", () => {
		for (const [extension, mimeType] of Object.entries(
			FROZEN_MIME_FROM_EXTENSION,
		)) {
			expect(getCanonicalMimeForExtension(extension), extension).toBe(mimeType);
		}
	});

	it("reproduces isDirectTextExtractionFile apart from the sanctioned expansion", () => {
		const gained: string[] = [];
		for (const extension of ALL_EXTENSIONS) {
			const before = frozenIsDirectTextExtractionFile(`.${extension}`, null);
			const after = getIntakeRoute(`x.${extension}`, null) === "direct-text";
			if (before === after) continue;
			expect(before, extension).toBe(false);
			gained.push(extension);
		}
		expect(sorted(gained)).toEqual(sorted(KNOWN_DELTAS.directTextExpansion));
		expect(KNOWN_DELTAS.directTextExpansion).toHaveLength(34);
		// `.rtf` is NOT part of the expansion — it stays refused.
		expect(gained).not.toContain("rtf");
		expect(getIntakeRoute("x.rtf", null)).toBe("reject");
	});

	it("keeps the direct-text MIME shortcuts working", () => {
		// The frozen function also admitted anything `text/*` plus four
		// application types, regardless of extension.
		for (const mimeType of [
			"text/plain",
			"text/csv",
			"application/json",
			"application/xml",
			"application/yaml",
			"application/typescript",
		]) {
			expect(frozenIsDirectTextExtractionFile(".qqq", mimeType)).toBe(true);
			expect(getIntakeRoute("mystery", mimeType), mimeType).toBe("direct-text");
		}
	});
});

describe("legacy equivalence — image allowlists", () => {
	it("reproduces the avatar ALLOWED_TYPES list", () => {
		const derived = FILE_TYPE_ENTRIES.filter(
			(entry) => entry.category === "image" && entry.id !== "svg",
		).map((entry) => entry.mimeTypes[0]);
		expect(sorted(derived)).toEqual(sorted(FROZEN_AVATAR_ALLOWED_TYPES));
	});

	it("reproduces the campaign ALLOWED_IMAGE_TYPES list", () => {
		const derived = FILE_TYPE_ENTRIES.filter(
			(entry) => entry.category === "image",
		).map((entry) => entry.mimeTypes[0]);
		expect(sorted(derived)).toEqual(
			sorted(FROZEN_CAMPAIGN_ALLOWED_IMAGE_TYPES),
		);
	});

	it("keeps every campaign MIME_EXTENSIONS key a registry image MIME", () => {
		// Spec decision row 46: the map stays in place because it writes
		// "tiff" where the registry canonicalises "tif", and renaming stored
		// asset paths is out of scope. This is the parity test it asked for.
		for (const [mimeType, extension] of Object.entries(
			FROZEN_CAMPAIGN_MIME_EXTENSIONS,
		)) {
			const entry = getEntryByMimeType(mimeType);
			expect(entry?.category, mimeType).toBe("image");
			expect(entry?.extensions, mimeType).toContain(extension);
		}
		expect(FROZEN_CAMPAIGN_MIME_EXTENSIONS["image/tiff"]).toBe("tiff");
		expect(getEntryByMimeType("image/tiff")?.extensions[0]).toBe("tif");
	});
});

describe("KNOWN_DELTAS", () => {
	it("has exactly six groups", () => {
		// The spec (section 6.2) told the reviewer to expect THREE. The last
		// three are forced by the spec's own per-entry `category` field and are
		// documented on each group above; every member of them is a file that
		// used to draw a generic or over-broad glyph.
		expect(Object.keys(KNOWN_DELTAS)).toEqual([
			"javascriptCanonicalMime",
			"jfifCanonicalMime",
			"directTextExpansion",
			"attachmentGlyphExpansion",
			"knowledgeIconExpansion",
			"mimeOnlyGlyphExpansion",
		]);
	});

	it("keeps the glyph expansions purely additive", () => {
		// No file moves between two SPECIFIC glyphs: the only moves are out of
		// the generic bucket, or from the catch-all "text" into a real category.
		for (const line of KNOWN_DELTAS.mimeOnlyGlyphExpansion) {
			const before = line.split(": ")[1]?.split(" -> ")[0];
			expect(["unsupported", "text"], line).toContain(before);
		}
	});

	it("names only extensions the table knows", () => {
		const known = new Set(ALL_EXTENSIONS);
		const named = [
			...KNOWN_DELTAS.javascriptCanonicalMime,
			...KNOWN_DELTAS.jfifCanonicalMime,
			...KNOWN_DELTAS.directTextExpansion,
			...Object.keys(KNOWN_DELTAS.attachmentGlyphExpansion),
			...Object.keys(KNOWN_DELTAS.knowledgeIconExpansion),
		];
		for (const extension of named) {
			expect(known.has(extension), extension).toBe(true);
		}
	});
});
