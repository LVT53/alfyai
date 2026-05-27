import path from "node:path";
import JSZip from "jszip";

const EXTENSION_MIME_TYPES: Record<string, string[]> = {
	".pdf": ["application/pdf"],
	".txt": ["text/plain"],
	".md": ["text/markdown", "text/plain"],
	".markdown": ["text/markdown", "text/plain"],
	".csv": ["text/csv", "text/plain"],
	".html": ["text/html"],
	".json": ["application/json", "text/json", "text/plain"],
	".svg": ["image/svg+xml", "application/xml", "text/xml", "text/plain"],
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
	json: ".json",
	"application/json": ".json",
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

function normalizeRequestedOutputType(type: string): string {
	return type.trim().toLowerCase();
}

function getExpectedExtensionForOutputType(type: string): string | null {
	return OUTPUT_TYPE_EXTENSIONS[normalizeRequestedOutputType(type)] ?? null;
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
	return allowedMimeTypes.includes(normalizedMimeType);
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

export async function validateProgramOutputContract(params: {
	files: GeneratedOutputFileForValidation[];
	programFilename?: string;
	requestedOutputTypes: string[];
}): Promise<FileProductionOutputValidationResult> {
	const requestedOutputTypes = params.requestedOutputTypes
		.map(normalizeRequestedOutputType)
		.filter(Boolean);
	if (requestedOutputTypes.length === 0) {
		return fail(
			"missing_program_requested_outputs",
			"Program file production requires at least one requested output type.",
		);
	}

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
