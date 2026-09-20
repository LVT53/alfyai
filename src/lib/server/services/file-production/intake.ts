import type { FileProductionJob } from "$lib/server/services/file-production/types";
import { fileExtension } from "$lib/shared/file-types";
import { validateFileProductionStaticLimits } from "./limits";
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
}

interface NormalizedDocumentSourceIntake extends NormalizedIntakeBase {
	sourceMode: "document_source";
	documentSource: GeneratedDocumentSource;
}

type NormalizedFileProductionIntake =
	| NormalizedProgramIntake
	| NormalizedDocumentSourceIntake;

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
	return fileExtension(trimString(value)) || null;
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
	if (sourceMode !== "program" && sourceMode !== "document_source") {
		return validationFailure({
			body,
			status: 422,
			code: "unsupported_source_mode",
			error: "sourceMode must be program or document_source",
		});
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

	const programOutputs = normalizeProgramOutputs(body, program);
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
	return {
		ok: true,
		status: 202,
		job: result.job,
		reused: result.reused,
	};
}
