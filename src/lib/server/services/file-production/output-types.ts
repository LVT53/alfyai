// The output-type table, split out of `output-validation.ts` so the modules on
// the REQUEST path — `intake.ts` and the `produce_file` tool — can ask "is this
// a type we can produce?" without pulling `output-validation`'s JSZip (and its
// pako tree) into the chat server bundle. Only the worker, which actually
// unpacks an XLSX, should pay for that.

const OUTPUT_TYPE_EXTENSIONS: Record<string, string> = {
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

export function normalizeRequestedOutputType(type: string): string {
	return type.trim().toLowerCase();
}

export function getExpectedExtensionForOutputType(type: string): string | null {
	return OUTPUT_TYPE_EXTENSIONS[normalizeRequestedOutputType(type)] ?? null;
}

/**
 * The single source of truth for "is this a file type the pipeline can
 * produce". Intake calls it so an unknown type is refused BEFORE a sandbox
 * program runs — the old behaviour discovered it only in
 * `validateProgramOutputContract`, after the whole run had been paid for.
 */
export function isSupportedFileProductionOutputType(type: string): boolean {
	return getExpectedExtensionForOutputType(type) !== null;
}

/** A short, model-facing sample of the accepted types. */
export const FILE_PRODUCTION_OUTPUT_TYPE_EXAMPLES =
	"xlsx, docx, pptx, pdf, csv, zip";
