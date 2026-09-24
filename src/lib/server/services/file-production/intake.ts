import type {
	FileProductionInlineTextFile,
	FileProductionJob,
} from "$lib/server/services/file-production/types";
import { fileExtension } from "$lib/shared/file-types";
import {
	getExpectedExtensionForOutputType,
	isInlineTextOutputType,
} from "$lib/shared/file-types/production";
import { validateFileProductionStaticLimits } from "./limits";
import { refuseMixedOutputGroups } from "./mixed-output-groups";
import {
	FILE_PRODUCTION_OUTPUT_TYPE_EXAMPLES,
	isSupportedFileProductionOutputType,
} from "./output-types";
import {
	type GeneratedDocumentSource,
	validateGeneratedDocumentSource,
} from "./source-schema";

type ProduceProgramLanguage = "python" | "javascript";

interface NormalizedIntakeBase {
	conversationId: string;
	assistantMessageId: string | null;
	idempotencyKey: string;
	requestTitle: string;
	outputs: Array<{ type: string }>;
	documentIntent: string | null;
	templateHint: string | null;
}

interface NormalizedProgramIntake extends NormalizedIntakeBase {
	sourceMode: "program";
	program: {
		language: ProduceProgramLanguage;
		sourceCode: string;
		filename?: string;
	};
	/** Decisions intake made on the caller's behalf, e.g. an output type
	 * taken from program.filename. Reported with the accepted result. */
	warnings: string[];
}

interface NormalizedDocumentSourceIntake extends NormalizedIntakeBase {
	sourceMode: "document_source";
	documentSource: GeneratedDocumentSource;
}

interface NormalizedInlineTextIntake extends NormalizedIntakeBase {
	sourceMode: "inline_text";
	inlineText: {
		content: string;
		files: FileProductionInlineTextFile[];
	};
}

type NormalizedFileProductionIntake =
	| NormalizedProgramIntake
	| NormalizedDocumentSourceIntake
	| NormalizedInlineTextIntake;

interface CreateOrReuseFileProductionJobInput {
	userId: string;
	conversationId: string;
	assistantMessageId?: string | null;
	title: string;
	origin: string;
	idempotencyKey: string;
	requestJson: unknown;
	sourceMode: string;
	documentIntent?: string | null;
	now?: Date;
}

interface CreateOrReuseFileProductionJobResult {
	job: FileProductionJob;
	reused: boolean;
}

interface CreateFailedFileProductionJobInput {
	userId: string;
	conversationId: string;
	assistantMessageId?: string | null;
	title: string;
	origin: string;
	idempotencyKey?: string | null;
	requestJson?: unknown;
	sourceMode?: string | null;
	documentIntent?: string | null;
	errorCode: string;
	errorMessage: string;
	retryable: boolean;
	now?: Date;
}

export interface SubmitFileProductionIntakeInput {
	userId: string;
	body: unknown;
	now?: Date;
	wakeWorker?: () => void | Promise<void>;
	signal?: AbortSignal;
}

export interface FileProductionIntakeDependencies {
	createOrReuseFileProductionJob: (
		input: CreateOrReuseFileProductionJobInput,
	) => Promise<CreateOrReuseFileProductionJobResult>;
	createFailedFileProductionJob: (
		input: CreateFailedFileProductionJobInput,
	) => Promise<FileProductionJob>;
	wakeFileProductionWorker: () => void | Promise<void>;
}

export type FileProductionIntakeResult =
	| {
			ok: true;
			status: 202;
			job: FileProductionJob;
			reused: boolean;
			/** Present only when intake changed something the caller sent. */
			warnings?: string[];
	  }
	| {
			ok: false;
			status: number;
			code: string;
			error: string;
			job?: FileProductionJob;
	  };

export type FileProductionIntakeConversationIdResult =
	| { ok: true; conversationId: string }
	| { ok: false; status: number; code: string; error: string };

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) {
		throw signal.reason;
	}
	if (typeof signal.reason === "string" && signal.reason.trim()) {
		throw new Error(signal.reason.trim());
	}
	throw new Error("file production intake aborted");
}

interface FailureDraft {
	conversationId: string;
	assistantMessageId: string | null;
	idempotencyKey: string;
	requestTitle: string;
	sourceMode: string;
	documentIntent: string | null;
	requestJson: unknown;
}

type IntakeValidationFailure = Extract<
	FileProductionIntakeResult,
	{ ok: false }
> & {
	failureDraft?: FailureDraft;
};

type IntakeNormalizationResult =
	| { ok: true; value: NormalizedFileProductionIntake }
	| IntakeValidationFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function trimString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function optionalTrimmedString(value: unknown): string | null {
	const trimmed = trimString(value);
	return trimmed ? trimmed : null;
}

// Third copy of extension -> output type (the others were
// output-validation.ts and produce-file.ts). The parser is the registry one
// now; the "is this producible" question stays where it was, on
// isSupportedFileProductionOutputType below. Deriving through
// getExpectedExtensionForOutputType instead would ADD a round-trip guard and
// start refusing "report.markdown", so it deliberately does not.
function outputTypeFromFilename(value: unknown): string | null {
	// The registry parser answers "everything after the last dot". `dev` used
	// /\.([a-z0-9]+)$/i, which is stricter in a load-bearing way: a tail that is
	// not purely alphanumeric named NO output type, so program mode answered
	// "nothing here names a file type" and the caller refused with
	// `missing output type`. Without the guard "data v1.2 draft" becomes the
	// output type "2 draft" and the request fails as an unsupported type
	// instead — a different, more confusing refusal.
	const extension = fileExtension(trimString(value));
	return /^[a-z0-9]+$/.test(extension) ? extension : null;
}

// A blank `type` is dropped rather than turned into a `"file"` placeholder:
// nothing downstream can map that to an extension, so it used to survive
// intake and only surface as `unsupported_program_output_type` in
// `validateProgramOutputContract` — after the sandbox run had been paid for.
function normalizeOutputs(
	body: Record<string, unknown>,
): Array<{ type: string }> {
	const rawOutputs = Array.isArray(body.requestedOutputs)
		? body.requestedOutputs
		: Array.isArray(body.outputs)
			? body.outputs
			: [];

	return rawOutputs
		.filter((output): output is Record<string, unknown> => isRecord(output))
		.map((output) => ({ type: trimString(output.type) }))
		.filter((output) => output.type.length > 0);
}

// Program mode resolves its type, highest first, from: explicit
// `requestedOutputs`/`outputs`, the top-level `filename`'s extension, then
// `program.filename`'s extension. An empty result is a real answer — nothing
// here names a file type — and the caller refuses the request.
// Document-source mode is left on `normalizeOutputs` alone: an empty list
// there already means "render the default PDF".
function normalizeProgramOutputs(
	body: Record<string, unknown>,
	program: Record<string, unknown> | null,
): Array<{ type: string }> {
	const explicit = normalizeOutputs(body);
	if (explicit.length > 0) return explicit;

	const derived =
		outputTypeFromFilename(body.filename) ??
		outputTypeFromFilename(program?.filename);
	return derived ? [{ type: derived }] : [];
}

/**
 * An explicit output type the registry cannot produce ("spreadsheet",
 * "excel file") used to refuse the whole request — after which the model
 * usually gave up — even when `program.filename` already said `budget.xlsx`.
 * When the filename's extension IS a producible type, that type is used
 * instead and the substitution is reported, so the model and the user can see
 * what was made. With no usable filename the unsupported type stays, and the
 * caller refuses it exactly as before.
 */
function fallBackToProgramFilenameType(
	outputs: Array<{ type: string }>,
	program: Record<string, unknown> | null,
): { outputs: Array<{ type: string }>; warnings: string[] } {
	const unsupported = outputs.filter(
		(output) => !isSupportedFileProductionOutputType(output.type),
	);
	if (unsupported.length === 0) return { outputs, warnings: [] };
	const filename = trimString(program?.filename);
	const filenameType = outputTypeFromFilename(filename);
	if (!filenameType || !isSupportedFileProductionOutputType(filenameType)) {
		return { outputs, warnings: [] };
	}
	const resolved: Array<{ type: string }> = [];
	for (const output of outputs) {
		const type = isSupportedFileProductionOutputType(output.type)
			? output.type
			: filenameType;
		if (!resolved.some((existing) => existing.type === type)) {
			resolved.push({ type });
		}
	}
	return {
		outputs: resolved,
		warnings: unsupported.map(
			(output) =>
				`Output type "${output.type}" is not supported, so the ${filenameType} type of program.filename "${filename}" was used instead.`,
		),
	};
}

/**
 * A produced filename must be a bare basename: it is joined onto the chat-file
 * storage directory and handed to `Content-Disposition`. Program mode gets this
 * from the sandbox, which can only report what it found in `/output`; the
 * inline_text mode is handed a name by the caller, so it is checked here.
 */
function sanitizedProducedFilename(value: unknown): string | null {
	const trimmed = trimString(value);
	if (!trimmed || trimmed.length > 120) return null;
	if (/[\\/]/.test(trimmed)) return null;
	if (trimmed === "." || trimmed === "..") return null;
	if (trimmed.startsWith(".")) return null;
	return trimmed;
}

type InlineTextNormalization =
	| { ok: true; content: string; files: FileProductionInlineTextFile[] }
	| { ok: false; code: string; error: string };

/**
 * Phase 6 D8. Everything that makes the bytes safe to write without a renderer
 * or a sandbox is decided here, before a job is queued:
 *  - the content must be a non-empty string (the bytes ARE the request);
 *  - every output type must be one `isInlineTextOutputType` accepts, so no
 *    document-source type and no binary container type can reach this mode;
 *  - every filename must be a bare basename whose extension is exactly the one
 *    its output type expects, which is what guarantees the stored bytes match
 *    the extension they are stored under.
 */
function normalizeInlineTextIntake(body: unknown): InlineTextNormalization {
	const inlineText = isRecord(body) ? body : null;
	if (!inlineText || !isRecord(inlineText.inlineText)) {
		return {
			ok: false,
			code: "invalid_inline_text_request",
			error: "inlineText is required when sourceMode is inline_text",
		};
	}

	const request = inlineText.inlineText;
	if (typeof request.content !== "string" || request.content.length === 0) {
		return {
			ok: false,
			code: "missing_inline_text_content",
			error: "inlineText.content is required and must be a non-empty string",
		};
	}

	const rawFiles = Array.isArray(request.files) ? request.files : [];
	if (rawFiles.length === 0) {
		return {
			ok: false,
			code: "invalid_inline_text_request",
			error: "inlineText.files must name at least one file to write",
		};
	}

	const files: FileProductionInlineTextFile[] = [];
	for (const rawFile of rawFiles) {
		if (!isRecord(rawFile)) {
			return {
				ok: false,
				code: "invalid_inline_text_request",
				error: "Each inlineText.files entry must be an object",
			};
		}
		const outputType = trimString(rawFile.outputType).toLowerCase();
		if (!outputType || !isInlineTextOutputType(outputType)) {
			return {
				ok: false,
				code: "unsupported_inline_text_output_type",
				error: `Output type ${outputType || "(missing)"} cannot be written as inline text. Use program mode for binary formats, or documentSource for PDF, DOCX and HTML.`,
			};
		}
		const filename = sanitizedProducedFilename(rawFile.filename);
		if (!filename) {
			return {
				ok: false,
				code: "invalid_inline_text_request",
				error:
					"Each inlineText.files entry needs a plain filename with no path separators",
			};
		}
		const expectedExtension = getExpectedExtensionForOutputType(outputType);
		if (
			!expectedExtension ||
			!filename.toLowerCase().endsWith(expectedExtension)
		) {
			return {
				ok: false,
				code: "invalid_inline_text_request",
				error: `Output type ${outputType} must produce a ${expectedExtension ?? "matching"} file, but the filename is ${filename}.`,
			};
		}
		if (files.some((existing) => existing.filename === filename)) {
			return {
				ok: false,
				code: "invalid_inline_text_request",
				error: `inlineText.files names ${filename} twice; one job cannot write the same file twice.`,
			};
		}
		files.push({ filename, outputType });
	}

	return { ok: true, content: request.content, files };
}

export function getFileProductionIntakeConversationId(
	body: unknown,
): FileProductionIntakeConversationIdResult {
	if (!isRecord(body)) {
		return {
			ok: false,
			status: 400,
			code: "invalid_json_body",
			error: "JSON body is required",
		};
	}

	const conversationId = trimString(body.conversationId);
	if (!conversationId) {
		return {
			ok: false,
			status: 400,
			code: "missing_conversation_id",
			error: "conversationId is required",
		};
	}

	return { ok: true, conversationId };
}

function extractFailureDraft(body: unknown): FailureDraft | null {
	if (!isRecord(body)) return null;
	const conversationId = trimString(body.conversationId);
	const idempotencyKey = trimString(body.idempotencyKey);
	const requestTitle = trimString(body.requestTitle);
	if (!conversationId || !idempotencyKey || !requestTitle) return null;

	return {
		conversationId,
		assistantMessageId: optionalTrimmedString(body.assistantMessageId),
		idempotencyKey,
		requestTitle,
		sourceMode: trimString(body.sourceMode) || "unknown",
		documentIntent: optionalTrimmedString(body.documentIntent),
		requestJson: {
			sourceMode: typeof body.sourceMode === "string" ? body.sourceMode : null,
			outputs: Array.isArray(body.requestedOutputs)
				? body.requestedOutputs
				: Array.isArray(body.outputs)
					? body.outputs
					: [],
			documentIntent:
				typeof body.documentIntent === "string" ? body.documentIntent : null,
			templateHint:
				typeof body.templateHint === "string" ? body.templateHint : null,
			program: isRecord(body.program) ? body.program : null,
			documentSource: isRecord(body.documentSource)
				? body.documentSource
				: null,
		},
	};
}

function validationFailure(params: {
	body: unknown;
	status: number;
	code: string;
	error: string;
}): IntakeValidationFailure {
	return {
		ok: false,
		status: params.status,
		code: params.code,
		error: params.error,
		failureDraft:
			params.status >= 422
				? (extractFailureDraft(params.body) ?? undefined)
				: undefined,
	};
}

function normalizeFileProductionIntake(
	body: unknown,
): IntakeNormalizationResult {
	if (!isRecord(body)) {
		return {
			ok: false,
			status: 400,
			code: "invalid_json_body",
			error: "JSON body is required",
		};
	}

	const conversationId = trimString(body.conversationId);
	const idempotencyKey = trimString(body.idempotencyKey);
	const requestTitle = trimString(body.requestTitle);
	const sourceMode = body.sourceMode;
	const program = isRecord(body.program) ? body.program : null;
	const language = trimString(program?.language);
	const sourceCode = trimString(program?.sourceCode);

	if (!conversationId) {
		return validationFailure({
			body,
			status: 400,
			code: "missing_conversation_id",
			error: "conversationId is required",
		});
	}
	if (!idempotencyKey) {
		return validationFailure({
			body,
			status: 400,
			code: "missing_idempotency_key",
			error: "idempotencyKey is required",
		});
	}
	if (!requestTitle) {
		return validationFailure({
			body,
			status: 400,
			code: "missing_request_title",
			error: "requestTitle is required",
		});
	}
	// The mixed-output-family rule, for EVERY caller of this route and not just
	// the produce_file tool (which resolves the writer itself, in process,
	// before it ever calls here).
	//
	// Exempt, deliberately, are the two shapes where the caller — not this
	// module — owns the writer and may legitimately span both families:
	//   * a caller-authored `program.sourceCode`, which can write a PDF and a
	//     Markdown file in one run (`produce-file.ts` exempts it for the same
	//     reason);
	//   * `document_source`, where the renderers turn one source into `pdf`
	//     AND `markdown` — the spec's `document-markdown` live row.
	// `inline_text` derives its outputs from `inlineText.files`, each of which
	// is checked against `isInlineTextOutputType` with a more precise message,
	// so it is left to that check.
	//
	// What is left is exactly the shape with no resolved writer: the ambiguous
	// `{ markdown, requestedOutputs: [pdf, md] }` a direct caller sends, and
	// `sourceMode: "program"` with no program at all. Both used to be refused
	// generically (`unsupported_source_mode` / `invalid_program_language`),
	// which told the caller nothing about the real problem.
	if (sourceMode !== "document_source" && sourceMode !== "inline_text") {
		const callerAuthoredProgram =
			sourceCode.length > 0 &&
			(language === "python" || language === "javascript");
		if (!callerAuthoredProgram) {
			const mixed = refuseMixedOutputGroups(
				normalizeProgramOutputs(body, program).map((output) => output.type),
			);
			if (mixed) {
				return validationFailure({
					body,
					status: 422,
					code: mixed.code,
					error: mixed.error,
				});
			}
		}
	}
	if (
		sourceMode !== "program" &&
		sourceMode !== "document_source" &&
		sourceMode !== "inline_text"
	) {
		return validationFailure({
			body,
			status: 422,
			code: "unsupported_source_mode",
			error: "sourceMode must be program, document_source or inline_text",
		});
	}
	if (sourceMode === "inline_text") {
		const inlineText = normalizeInlineTextIntake(body);
		if (!inlineText.ok) {
			return validationFailure({
				body,
				status: 422,
				code: inlineText.code,
				error: inlineText.error,
			});
		}

		return {
			ok: true,
			value: {
				conversationId,
				assistantMessageId: optionalTrimmedString(body.assistantMessageId),
				idempotencyKey,
				requestTitle,
				sourceMode: "inline_text",
				// The files ARE the request: one output per file we are about to
				// write, so `maxRequestedOutputs` counts the real thing and no
				// declared output can go unproduced.
				outputs: inlineText.files.map((file) => ({ type: file.outputType })),
				documentIntent: optionalTrimmedString(body.documentIntent),
				templateHint: optionalTrimmedString(body.templateHint),
				inlineText: { content: inlineText.content, files: inlineText.files },
			},
		};
	}
	if (sourceMode === "document_source") {
		const documentValidation = validateGeneratedDocumentSource(
			body.documentSource,
		);
		if (!documentValidation.ok) {
			return validationFailure({
				body,
				status: 422,
				code: documentValidation.code,
				error: documentValidation.message,
			});
		}

		return {
			ok: true,
			value: {
				conversationId,
				assistantMessageId: optionalTrimmedString(body.assistantMessageId),
				idempotencyKey,
				requestTitle,
				sourceMode: "document_source",
				outputs: normalizeOutputs(body),
				documentIntent: optionalTrimmedString(body.documentIntent),
				templateHint: optionalTrimmedString(body.templateHint),
				documentSource: documentValidation.source,
			},
		};
	}
	if (language !== "python" && language !== "javascript") {
		return validationFailure({
			body,
			status: 422,
			code: "invalid_program_language",
			error: "program.language must be python or javascript",
		});
	}
	if (!sourceCode) {
		return validationFailure({
			body,
			status: 422,
			code: "missing_program_source",
			error: "program.sourceCode is required",
		});
	}

	const requestedProgramOutputs = normalizeProgramOutputs(body, program);
	const { outputs: programOutputs, warnings } = fallBackToProgramFilenameType(
		requestedProgramOutputs,
		program,
	);
	if (programOutputs.length === 0) {
		return validationFailure({
			body,
			status: 422,
			code: "missing_program_output_type",
			error: `outputType is required for program mode, e.g. ${FILE_PRODUCTION_OUTPUT_TYPE_EXAMPLES}`,
		});
	}
	const unsupportedOutput = programOutputs.find(
		(output) => !isSupportedFileProductionOutputType(output.type),
	);
	if (unsupportedOutput) {
		return validationFailure({
			body,
			status: 422,
			code: "unsupported_program_output_type",
			error: `Output type ${unsupportedOutput.type} is not supported. Use one of: ${FILE_PRODUCTION_OUTPUT_TYPE_EXAMPLES}`,
		});
	}

	return {
		ok: true,
		value: {
			conversationId,
			assistantMessageId: optionalTrimmedString(body.assistantMessageId),
			idempotencyKey,
			requestTitle,
			sourceMode: "program",
			outputs: programOutputs,
			documentIntent: optionalTrimmedString(body.documentIntent),
			templateHint: optionalTrimmedString(body.templateHint),
			program: {
				language,
				sourceCode,
				filename: optionalTrimmedString(program?.filename) ?? undefined,
			},
			warnings,
		},
	};
}

export async function submitFileProductionIntakeWithDependencies(
	input: SubmitFileProductionIntakeInput,
	dependencies: FileProductionIntakeDependencies,
): Promise<FileProductionIntakeResult> {
	throwIfAborted(input.signal);
	const normalized = normalizeFileProductionIntake(input.body);
	if (!normalized.ok) {
		if (normalized.failureDraft) {
			throwIfAborted(input.signal);
			const job = await dependencies.createFailedFileProductionJob({
				userId: input.userId,
				conversationId: normalized.failureDraft.conversationId,
				assistantMessageId: normalized.failureDraft.assistantMessageId,
				title: normalized.failureDraft.requestTitle,
				origin: "unified_produce",
				idempotencyKey: normalized.failureDraft.idempotencyKey,
				sourceMode: normalized.failureDraft.sourceMode,
				documentIntent: normalized.failureDraft.documentIntent,
				requestJson: normalized.failureDraft.requestJson,
				errorCode: normalized.code,
				errorMessage: normalized.error,
				retryable: false,
				now: input.now,
			});
			const { failureDraft: _failureDraft, ...failure } = normalized;
			return { ...failure, job };
		}
		return normalized;
	}

	throwIfAborted(input.signal);
	const request = normalized.value;
	const requestJson = {
		sourceMode: request.sourceMode,
		outputs: request.outputs,
		documentIntent: request.documentIntent,
		templateHint: request.templateHint,
		program: request.sourceMode === "program" ? request.program : null,
		documentSource:
			request.sourceMode === "document_source" ? request.documentSource : null,
		// The content rides the same persisted request the other modes use, so a
		// retry re-runs the identical bytes and the static source-size limit
		// bounds it exactly as it bounds a documentSource.
		inlineText:
			request.sourceMode === "inline_text" ? request.inlineText : null,
	};
	const staticLimit = validateFileProductionStaticLimits({
		outputCount: request.outputs.length,
		sourceJsonBytes: Buffer.byteLength(JSON.stringify(requestJson), "utf8"),
	});
	if (!staticLimit.ok) {
		throwIfAborted(input.signal);
		const job = await dependencies.createFailedFileProductionJob({
			userId: input.userId,
			conversationId: request.conversationId,
			assistantMessageId: request.assistantMessageId,
			title: request.requestTitle,
			origin: "unified_produce",
			idempotencyKey: request.idempotencyKey,
			sourceMode: request.sourceMode,
			documentIntent: request.documentIntent,
			requestJson,
			errorCode: staticLimit.code,
			errorMessage: staticLimit.message,
			retryable: staticLimit.retryable,
			now: input.now,
		});
		console.warn("[FILE_PRODUCTION] Static limit failed", {
			jobId: job.id,
			code: staticLimit.code,
			limit: staticLimit.limit,
			actual: staticLimit.actual,
			unit: staticLimit.unit,
		});
		return {
			ok: false,
			status: 422,
			code: staticLimit.code,
			error: staticLimit.message,
			job,
		};
	}

	throwIfAborted(input.signal);
	const result = await dependencies.createOrReuseFileProductionJob({
		userId: input.userId,
		conversationId: request.conversationId,
		assistantMessageId: request.assistantMessageId,
		title: request.requestTitle,
		origin: "unified_produce",
		idempotencyKey: request.idempotencyKey,
		sourceMode: request.sourceMode,
		documentIntent: request.documentIntent,
		requestJson,
		now: input.now,
	});

	if (result.job.status === "queued" || result.job.status === "running") {
		throwIfAborted(input.signal);
		await dependencies.wakeFileProductionWorker();
	}

	throwIfAborted(input.signal);
	const warnings =
		request.sourceMode === "program" ? request.warnings : ([] as string[]);
	return {
		ok: true,
		status: 202,
		job: result.job,
		...(warnings.length > 0 ? { warnings } : {}),
		reused: result.reused,
	};
}
