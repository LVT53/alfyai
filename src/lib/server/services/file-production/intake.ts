import type { FileProductionJob } from "$lib/types";
import { validateFileProductionStaticLimits } from "./limits";
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
		.map((output) => ({
			type: trimString(output.type) || "file",
		}));
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

	return {
		ok: true,
		value: {
			conversationId,
			assistantMessageId: optionalTrimmedString(body.assistantMessageId),
			idempotencyKey,
			requestTitle,
			sourceMode: "program",
			outputs: normalizeOutputs(body),
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
	const normalized = normalizeFileProductionIntake(input.body);
	if (!normalized.ok) {
		if (normalized.failureDraft) {
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
		await dependencies.wakeFileProductionWorker();
	}

	return {
		ok: true,
		status: 202,
		job: result.job,
		reused: result.reused,
	};
}
