import path from "node:path";
import JSZip from "jszip";
import {
	getCanonicalMimeForExtension,
	isGenericMimeType,
} from "$lib/shared/file-types";
import {
	getAllowedMimeTypesForProducedExtension,
	getExpectedExtensionForOutputType,
	isSupportedFileProductionOutputType,
	isTextLikeExtension,
	normalizeRequestedOutputType,
} from "$lib/shared/file-types/production";

export {
	FILE_PRODUCTION_OUTPUT_TYPE_EXAMPLES,
	isSupportedFileProductionOutputType,
} from "./output-types";

const XLSX_MIME_TYPE = getCanonicalMimeForExtension("xlsx") ?? "";
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

function outputTypeFromFilename(filename: string): string | null {
	const extension = path.extname(filename).toLowerCase();
	if (!extension) return null;
	const type = extension.replace(/^\./, "");
	// The derived type has to round-trip: a .markdown file resolves to the
	// type markdown, whose expected extension is .md, so deriving it would only
	// produce a `program_output_type_mismatch` against the very file it came
	// from. Only a type that validates this file is worth deriving.
	return getExpectedExtensionForOutputType(type) === extension ? type : null;
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

	// `[]` means "the registry constrains nothing for this extension", which is
	// the old `EXTENSION_MIME_TYPES[extension] === undefined` arm.
	const allowedMimeTypes = getAllowedMimeTypesForProducedExtension(extension);
	if (allowedMimeTypes.length === 0) {
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

	// Intake now refuses an unresolvable type outright, so an unresolvable one
	// here only comes from a job queued before that rule existed. Rather than
	// waste the run that already happened, take the type from the one file the
	// program wrote — but ONLY when the request named nothing resolvable at
	// all. A request naming pdf plus an unresolvable token still has to produce
	// a PDF; letting
	// the produced file redefine the whole request would turn "you asked for a
	// PDF and got a CSV" into a success.
	const resolvableOutputTypes = declaredOutputTypes.filter((type) =>
		isSupportedFileProductionOutputType(type),
	);
	const requestedOutputTypes =
		resolvableOutputTypes.length > 0
			? resolvableOutputTypes
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
