import path from "node:path";
import JSZip from "jszip";

const EXTENSION_MIME_TYPES: Record<string, string[]> = {
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

const GENERIC_MIME_TYPES = new Set([
	"application/octet-stream",
	"application/download",
]);

const TEXT_LIKE_EXTENSIONS = new Set([
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
]);

const XLSX_MIME_TYPE =
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DEFAULT_XLSX_VALIDATION_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_XLSX_VALIDATION_MAX_ZIP_ENTRIES = 5000;
const REQUIRED_XLSX_ZIP_ENTRIES = [
	"[Content_Types].xml",
	"_rels/.rels",
	"xl/workbook.xml",
	"xl/_rels/workbook.xml.rels",
] as const;

interface GeneratedOutputFileForValidation {
	filename: string;
	mimeType?: string | null;
	content: Buffer | Uint8Array;
}

interface XlsxValidationOptions {
	maxBytes?: number;
	maxZipEntries?: number;
}

export type FileProductionOutputValidationResult =
	| { ok: true }
	| {
			ok: false;
			code: string;
			message: string;
			retryable: boolean;
	  };

function normalizeMimeType(mimeType: string | null | undefined): string {
	return mimeType?.toLowerCase().split(";")[0]?.trim() ?? "";
}

function isGenericMimeType(mimeType: string): boolean {
	return !mimeType || GENERIC_MIME_TYPES.has(mimeType);
}

function isTextLikeExtension(extension: string): boolean {
	return TEXT_LIKE_EXTENSIONS.has(extension);
}

function normalizeRequestedOutputType(type: string): string {
	return type.trim().toLowerCase();
}

function getExpectedExtensionForOutputType(type: string): string | null {
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

function outputTypeFromFilename(filename: string): string | null {
	const extension = path.extname(filename).toLowerCase().replace(/^\./, "");
	if (!extension) return null;
	return isSupportedFileProductionOutputType(extension) ? extension : null;
}

/**
 * Last-resort, POST-execution derivation: when the requested type cannot be
 * mapped to an extension (a job queued before intake demanded a real type
 * still carries the old `"file"` sentinel) but the program wrote exactly one
 * file, that file's extension IS the output type. Anything ambiguous — no
 * files, several files, an unknown extension — returns null and the normal
 * failure stands.
 */
function resolveOutputTypesFromSingleProducedFile(
	files: GeneratedOutputFileForValidation[],
): string[] | null {
	if (files.length !== 1) return null;
	const derived = outputTypeFromFilename(files[0].filename);
	return derived ? [derived] : null;
}

export function isGeneratedFileTypeAllowed(
	filename: string,
	mimeType: string | null,
): boolean {
	const extension = path.extname(filename).toLowerCase();
	if (!extension || !mimeType) {
		return true;
	}

	const allowedMimeTypes = EXTENSION_MIME_TYPES[extension];
	if (!allowedMimeTypes) {
		return true;
	}

	const normalizedMimeType = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
	return (
		allowedMimeTypes.includes(normalizedMimeType) ||
		(isGenericMimeType(normalizedMimeType) && isTextLikeExtension(extension))
	);
}

function fail(
	code: string,
	message: string,
	retryable = false,
): FileProductionOutputValidationResult {
	return { ok: false, code, message, retryable };
}

export async function validateXlsxBytes(
	content: Buffer | Uint8Array,
	options: XlsxValidationOptions = {},
): Promise<FileProductionOutputValidationResult> {
	const maxBytes = options.maxBytes ?? DEFAULT_XLSX_VALIDATION_MAX_BYTES;
	const maxZipEntries =
		options.maxZipEntries ?? DEFAULT_XLSX_VALIDATION_MAX_ZIP_ENTRIES;
	if (content.byteLength > maxBytes) {
		return fail(
			"xlsx_output_too_large",
			`XLSX output is too large to validate safely (${content.byteLength} bytes; limit ${maxBytes} bytes).`,
		);
	}

	let zip: JSZip;
	try {
		zip = await JSZip.loadAsync(
			Buffer.isBuffer(content) ? content : Buffer.from(content),
		);
	} catch {
		return fail(
			"invalid_xlsx_output",
			"XLSX output is not a readable OOXML ZIP package.",
		);
	}

	const zipEntries = Object.values(zip.files);
	if (zipEntries.length > maxZipEntries) {
		return fail(
			"xlsx_output_too_complex",
			`XLSX output contains too many ZIP entries (${zipEntries.length}; limit ${maxZipEntries}).`,
		);
	}

	for (const entry of REQUIRED_XLSX_ZIP_ENTRIES) {
		if (!zip.file(entry)) {
			return fail(
				"invalid_xlsx_output",
				`XLSX output is missing required OOXML entry: ${entry}.`,
			);
		}
	}

	const hasWorksheet = zipEntries.some(
		(entry) =>
			!entry.dir && /^xl\/worksheets\/sheet\d+\.xml$/u.test(entry.name),
	);
	if (!hasWorksheet) {
		return fail(
			"invalid_xlsx_output",
			"XLSX output does not contain a worksheet entry.",
		);
	}

	return { ok: true };
}

export async function validateGeneratedOutputFile(
	file: GeneratedOutputFileForValidation,
	options: { requireKnownMimeType?: boolean } = {},
): Promise<FileProductionOutputValidationResult> {
	const extension = path.extname(file.filename).toLowerCase();
	const mimeType = normalizeMimeType(file.mimeType);

	if (!isGeneratedFileTypeAllowed(file.filename, file.mimeType ?? null)) {
		return fail(
			"program_output_mime_mismatch",
			`Produced file ${file.filename} has MIME type ${file.mimeType ?? "unknown"}, which does not match its extension.`,
		);
	}

	if (isTextLikeExtension(extension)) {
		const textValidation = validateTextLikeOutputBytes(file.content);
		if (!textValidation.ok) {
			return textValidation;
		}
	}

	if (extension !== ".xlsx") {
		return { ok: true };
	}

	if (
		mimeType !== XLSX_MIME_TYPE &&
		(options.requireKnownMimeType || mimeType)
	) {
		return fail(
			"program_output_mime_mismatch",
			`Produced XLSX file ${file.filename} must use MIME type ${XLSX_MIME_TYPE}.`,
		);
	}

	return validateXlsxBytes(file.content);
}

function validateTextLikeOutputBytes(
	content: Buffer | Uint8Array,
): FileProductionOutputValidationResult {
	const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
	if (bytes.includes(0)) {
		return fail(
			"invalid_text_output",
			"Text/code output contains binary NUL bytes.",
		);
	}

	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return fail("invalid_text_output", "Text/code output is not valid UTF-8.");
	}

	return { ok: true };
}

export async function validateProgramOutputContract(params: {
	files: GeneratedOutputFileForValidation[];
	programFilename?: string;
	requestedOutputTypes: string[];
}): Promise<FileProductionOutputValidationResult> {
	const declaredOutputTypes = params.requestedOutputTypes
		.map(normalizeRequestedOutputType)
		.filter(Boolean);
	if (declaredOutputTypes.length === 0) {
		return fail(
			"missing_program_requested_outputs",
			"Program file production requires at least one requested output type.",
		);
	}

	// Intake now refuses an unresolvable type outright, so this only fires for
	// a job queued before that rule existed. Rather than waste the run that
	// already happened, take the type from the one file the program wrote.
	const requestedOutputTypes = declaredOutputTypes.every((type) =>
		isSupportedFileProductionOutputType(type),
	)
		? declaredOutputTypes
		: (resolveOutputTypesFromSingleProducedFile(params.files) ??
			declaredOutputTypes);

	const expectedExtensions = Array.from(
		new Map(
			requestedOutputTypes.map((type) => [
				type,
				{
					type,
					extension: getExpectedExtensionForOutputType(type),
				},
			]),
		).values(),
	);
	const unsupportedOutputType = expectedExtensions.find(
		(output) => !output.extension,
	);
	if (unsupportedOutputType) {
		return fail(
			"unsupported_program_output_type",
			`Program output type ${unsupportedOutputType.type} is not supported.`,
		);
	}

	if (params.programFilename) {
		if (params.files.length !== 1) {
			return fail(
				"unexpected_program_output_files",
				`Program output contract expected exactly one file named ${path.basename(params.programFilename)}, but found ${params.files.length}.`,
			);
		}

		const expectedFilename = path.basename(params.programFilename);
		const producedFilename = path.basename(params.files[0].filename);
		if (producedFilename !== expectedFilename) {
			return fail(
				"program_output_filename_mismatch",
				`Program output contract expected ${expectedFilename}, but the program produced ${producedFilename}.`,
			);
		}

		const expectedExtension = getExpectedExtensionForOutputType(
			requestedOutputTypes[0],
		);
		const declaredExtension = path.extname(expectedFilename).toLowerCase();
		if (expectedExtension && declaredExtension !== expectedExtension) {
			return fail(
				"program_output_type_mismatch",
				`Requested output type ${requestedOutputTypes[0]} must produce a ${expectedExtension} file.`,
			);
		}
	}

	const producedExtensions = new Set<string>();
	for (const file of params.files) {
		const extension = path.extname(file.filename).toLowerCase();
		if (extension) {
			producedExtensions.add(extension);
		}
		if (!expectedExtensions.some((output) => output.extension === extension)) {
			return fail(
				"program_output_type_mismatch",
				`Program output ${file.filename} does not match requested output type(s): ${requestedOutputTypes.join(", ")}.`,
			);
		}

		const validation = await validateGeneratedOutputFile(file, {
			requireKnownMimeType: true,
		});
		if (!validation.ok) {
			return validation;
		}
	}

	const missingExtension = expectedExtensions.find(
		(output) => output.extension && !producedExtensions.has(output.extension),
	);
	if (missingExtension) {
		return fail(
			"program_output_type_mismatch",
			`Requested output type ${missingExtension.type} did not produce a ${missingExtension.extension} file.`,
		);
	}

	return { ok: true };
}
