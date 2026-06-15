export type PreviewFileType =
	| "pdf"
	| "docx"
	| "xlsx"
	| "pptx"
	| "odt"
	| "image"
	| "html"
	| "text"
	| "unsupported";

const TEXT_EXTENSIONS = new Set([
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
]);

const PREVIEWABLE_TEXT_MIME_TYPES = new Set([
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
]);

const GENERIC_MIME_TYPES = new Set([
	"application/octet-stream",
	"application/download",
]);

const IMAGE_EXTENSIONS = new Set([
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
]);

const EXTENSION_CONTENT_TYPES: Record<string, string> = {
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

const TRUSTED_PREVIEW_EXTENSIONS: Record<string, PreviewFileType> = {
	pdf: "pdf",
	docx: "docx",
	xlsx: "xlsx",
	pptx: "pptx",
	odt: "odt",
	html: "html",
	htm: "html",
};

const MIME_TO_PREVIEW_TYPE: Array<{
	readonly type: PreviewFileType;
	readonly test: (mime: string) => boolean;
}> = [
	{
		type: "pdf",
		test: (mime) => mime.includes("pdf"),
	},
	{
		type: "docx",
		test: (mime) => mime.includes("wordprocessingml"),
	},
	{
		type: "xlsx",
		test: (mime) => mime.includes("spreadsheetml"),
	},
	{
		type: "pptx",
		test: (mime) => mime.includes("presentationml"),
	},
	{
		type: "odt",
		test: (mime) => mime === "application/vnd.oasis.opendocument.text",
	},
	{
		type: "image",
		test: (mime) => mime.startsWith("image/"),
	},
	{
		type: "html",
		test: (mime) => mime === "text/html",
	},
	{
		type: "text",
		test: (mime) =>
			mime.startsWith("text/") || PREVIEWABLE_TEXT_MIME_TYPES.has(mime),
	},
];

const EXTENSION_TO_PREVIEW_LANGUAGE: Record<string, string> = {
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

const MIME_TO_PREVIEW_LANGUAGE: Record<string, string> = {
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

function getTrustedPreviewTypeFromExtension(
	ext: string | null,
): PreviewFileType | null {
	if (!ext) return null;
	if (TRUSTED_PREVIEW_EXTENSIONS[ext]) return TRUSTED_PREVIEW_EXTENSIONS[ext];
	if (IMAGE_EXTENSIONS.has(ext)) return "image";
	return null;
}

function getExtension(name: string): string | null {
	const ext = name.split(".").pop()?.toLowerCase().trim();
	return ext ? ext : null;
}

function isExtensionPreviewableAsText(ext: string | null): boolean {
	return Boolean(ext && TEXT_EXTENSIONS.has(ext));
}

function normalizeMimeType(mimeType: string | null): string | null {
	const normalized = mimeType?.split(";")[0]?.trim().toLowerCase() ?? "";
	return normalized || null;
}

function isGenericMimeType(mimeType: string | null): boolean {
	const normalized = normalizeMimeType(mimeType);
	return !normalized || GENERIC_MIME_TYPES.has(normalized);
}

function resolvePreviewContentTypeFromFilename(ext: string | null): string {
	if (!ext) return "application/octet-stream";
	return EXTENSION_CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export function getPreviewContentType(
	filename: string,
	mimeType: string | null,
): string {
	const normalizedMimeType = normalizeMimeType(mimeType);
	if (normalizedMimeType && !isGenericMimeType(normalizedMimeType)) {
		return normalizedMimeType;
	}
	const ext = getExtension(filename);
	return resolvePreviewContentTypeFromFilename(ext);
}

export function determinePreviewFileType(
	mimeType: string | null,
	filename: string,
): PreviewFileType {
	const ext = getExtension(filename);
	const mime = normalizeMimeType(mimeType);
	const trustedType = getTrustedPreviewTypeFromExtension(ext);
	if (trustedType) return trustedType;

	if (!mime) {
		if (isExtensionPreviewableAsText(ext)) return "text";
		return "unsupported";
	}

	for (const rule of MIME_TO_PREVIEW_TYPE) {
		if (rule.test(mime)) return rule.type;
	}

	if (isExtensionPreviewableAsText(ext)) return "text";
	return "unsupported";
}

export function isPreviewableFile(
	mimeType: string | null,
	filename: string,
): boolean {
	return determinePreviewFileType(mimeType, filename) !== "unsupported";
}

export function getPreviewLanguage(
	mimeType: string | null,
	filename: string,
): string | undefined {
	const ext = getExtension(filename);

	if (ext && EXTENSION_TO_PREVIEW_LANGUAGE[ext]) {
		return EXTENSION_TO_PREVIEW_LANGUAGE[ext];
	}

	const mime = normalizeMimeType(mimeType);
	if (mime && MIME_TO_PREVIEW_LANGUAGE[mime]) {
		return MIME_TO_PREVIEW_LANGUAGE[mime];
	}

	return undefined;
}
