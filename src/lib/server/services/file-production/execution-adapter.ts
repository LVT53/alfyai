import { extname } from "node:path";
import type {
	FileProductionInlineTextFile,
	FileProductionInlineTextRequest,
} from "$lib/server/services/file-production/types";
import type { Artifact } from "$lib/server/services/knowledge/types";
import {
	executeCode as executeSandboxCode,
	SANDBOX_TIMEOUT_ERROR,
} from "$lib/server/services/sandbox-execution";
import {
	getSandboxMimeTypeForExtension,
	normalizeDocumentOutput,
} from "$lib/shared/file-types/production";
import type { DocumentRenderKind } from "$lib/shared/file-types/types";
import { createDefaultGeneratedDocumentImageLoader } from "./image-loader";
import { type FileProductionLimits, getFileProductionLimits } from "./limits";
import {
	validateGeneratedOutputFile,
	validateProducedFileSignature,
} from "./output-validation";
import {
	FileProductionRenderAbortedError,
	RenderBudget,
} from "./render-budget";
import { renderStandardReportDocx } from "./renderers/standard-report-docx";
import { renderStandardReportHtml } from "./renderers/standard-report-html";
import { renderStandardReportMarkdown } from "./renderers/standard-report-markdown";
import {
	renderStandardReportPdf,
	StandardReportPdfRenderError,
} from "./renderers/standard-report-pdf";
import { resolveReportFavicons } from "./report-favicons";
import {
	markGeneratedDocumentSourceArtifactFailed,
	persistGeneratedDocumentSourceArtifact,
} from "./source-persistence";
import {
	type GeneratedDocumentSource,
	validateGeneratedDocumentSource,
} from "./source-schema";

export interface ProgramExecutionFile {
	filename: string;
	mimeType?: string;
	content: Buffer | Uint8Array;
	sizeBytes?: number;
}

export interface ProgramExecutionResult {
	files: ProgramExecutionFile[];
	stdout: string;
	stderr: string;
	error?: string | null;
}

export type ParsedFileProductionJobRequest =
	| {
			sourceMode: "program";
			language: "python" | "javascript";
			sourceCode: string;
			filename?: string;
			outputs: string[];
	  }
	| {
			sourceMode: "document_source";
			documentSource: GeneratedDocumentSource;
			outputs: Array<DocumentRenderKind>;
	  }
	| FileProductionInlineTextRequest;

export interface ExecutePersistedFileProductionRequestInput {
	requestJson: string | null;
	userId: string;
	conversationId: string;
	assistantMessageId: string | null;
	fileProductionJobId: string;
	title: string;
	documentIntent: string | null;
	executeCode?: (
		sourceCode: string,
		language: "python" | "javascript",
		options?: { signal?: AbortSignal },
	) => Promise<ProgramExecutionResult>;
	/**
	 * Aborted when this ATTEMPT should stop: the user cancelled, the claim was
	 * taken by a stale sweep, or the process is going away. Every renderer, the
	 * inline_text writer and the sandbox honour it; the ledger's CAS refuses the
	 * late verdict either way, so this is about not burning CPU on a job nobody
	 * is waiting for rather than about correctness.
	 */
	signal?: AbortSignal;
	/** Overrides individual configured limits. Test seam. */
	limits?: Partial<FileProductionLimits>;
}

export type ExecutePersistedFileProductionRequestResult =
	| {
			ok: true;
			request: ParsedFileProductionJobRequest;
			execution: ProgramExecutionResult;
			sourceArtifact: Artifact | null;
	  }
	| {
			ok: false;
			errorCode: string;
			errorMessage: string;
			retryable: boolean;
	  };

class GeneratedDocumentSourcePersistenceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GeneratedDocumentSourcePersistenceError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function normalizeOutputTypes(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((output): output is Record<string, unknown> => isRecord(output))
		.map((output) =>
			typeof output.type === "string" ? output.type.trim().toLowerCase() : "",
		)
		.filter(Boolean);
}

function selectDocumentOutputs(
	outputs: string[],
): Array<DocumentRenderKind> | null {
	if (outputs.length === 0) return ["pdf"];
	const normalized = outputs.map(normalizeDocumentOutput);
	if (normalized.some((output) => output === null)) return null;
	return Array.from(new Set(normalized)) as Array<DocumentRenderKind>;
}

function parseFileProductionJobRequest(requestJson: string | null):
	| {
			ok: true;
			value: ParsedFileProductionJobRequest;
	  }
	| {
			ok: false;
			errorCode: string;
			errorMessage: string;
	  } {
	if (!requestJson) {
		return {
			ok: false,
			errorCode: "missing_file_production_request",
			errorMessage: "File production request details are missing.",
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(requestJson) as unknown;
	} catch {
		return {
			ok: false,
			errorCode: "invalid_file_production_request",
			errorMessage: "File production request details are invalid.",
		};
	}

	if (!isRecord(parsed)) {
		return {
			ok: false,
			errorCode: "unsupported_file_production_request",
			errorMessage: "File production request mode is not supported.",
		};
	}

	if (parsed.sourceMode === "inline_text") {
		const inlineText = parseInlineTextRequest(parsed.inlineText);
		if (!inlineText) {
			return {
				ok: false,
				errorCode: "invalid_file_production_request",
				errorMessage:
					"Inline text file production request details are invalid.",
			};
		}
		return { ok: true, value: inlineText };
	}

	if (parsed.sourceMode === "document_source") {
		const documentValidation = validateGeneratedDocumentSource(
			parsed.documentSource,
		);
		if (!documentValidation.ok) {
			return {
				ok: false,
				errorCode: documentValidation.code,
				errorMessage: documentValidation.message,
			};
		}
		const outputs = normalizeOutputTypes(parsed.outputs);
		const documentOutputs = selectDocumentOutputs(outputs);
		if (!documentOutputs) {
			return {
				ok: false,
				errorCode: "unsupported_output_type",
				errorMessage:
					"AlfyAI Standard Report rendering supports PDF, DOCX, HTML, and Markdown outputs.",
			};
		}

		return {
			ok: true,
			value: {
				sourceMode: "document_source",
				documentSource: documentValidation.source,
				outputs: documentOutputs,
			},
		};
	}

	if (parsed.sourceMode !== "program" || !isRecord(parsed.program)) {
		return {
			ok: false,
			errorCode: "unsupported_file_production_request",
			errorMessage: "File production request mode is not supported.",
		};
	}

	const language = parsed.program.language;
	const sourceCode = parsed.program.sourceCode;
	if (
		(language !== "python" && language !== "javascript") ||
		typeof sourceCode !== "string"
	) {
		return {
			ok: false,
			errorCode: "invalid_file_production_request",
			errorMessage: "Program file production request details are invalid.",
		};
	}

	const outputs = normalizeOutputTypes(parsed.outputs);
	if (outputs.length === 0) {
		return {
			ok: false,
			errorCode: "missing_program_requested_outputs",
			errorMessage:
				"Program file production requires at least one requested output type.",
		};
	}

	return {
		ok: true,
		value: {
			sourceMode: "program",
			language,
			sourceCode,
			filename:
				typeof parsed.program.filename === "string" &&
				parsed.program.filename.trim()
					? parsed.program.filename.trim()
					: undefined,
			outputs,
		},
	};
}

/**
 * Re-reads what intake already validated. The persisted request is the source
 * of truth for a retry, and a job row can outlive the rules that accepted it,
 * so the shape is checked again rather than trusted.
 */
function parseInlineTextRequest(
	value: unknown,
): FileProductionInlineTextRequest | null {
	if (!isRecord(value)) return null;
	if (typeof value.content !== "string" || value.content.length === 0) {
		return null;
	}
	if (!Array.isArray(value.files) || value.files.length === 0) return null;

	const files: FileProductionInlineTextFile[] = [];
	for (const file of value.files) {
		if (!isRecord(file)) return null;
		const filename =
			typeof file.filename === "string" ? file.filename.trim() : "";
		const outputType =
			typeof file.outputType === "string"
				? file.outputType.trim().toLowerCase()
				: "";
		if (!filename || !outputType) return null;
		files.push({ filename, outputType });
	}

	return { sourceMode: "inline_text", content: value.content, files };
}

class InlineTextOutputError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "InlineTextOutputError";
		this.code = code;
	}
}

/**
 * Phase 6 D8 — the whole of "produce a text file" when the model already sent
 * the bytes. No container, no renderer, and `sandboxTimeoutMs` is deliberately
 * never consulted: there is nothing to time out.
 *
 * The buffer goes through the SAME `validateGeneratedOutputFile` every other
 * produced file does, so a text output still gets the NUL and fatal-UTF-8
 * check, and the produced-file signature check still refuses bytes that do not
 * match their extension. Storage, limits, linking and memory sync are then the
 * storage adapter's, unchanged.
 */
function runInlineText(
	request: FileProductionInlineTextRequest,
	budget: RenderBudget,
): Promise<ProgramExecutionResult> {
	const content = Buffer.from(request.content, "utf8");
	return (async () => {
		const files: ProgramExecutionFile[] = [];
		for (const file of request.files) {
			// Per file: validation and the signature check are cheap, but a request
			// may name several outputs and a cancel has to land somewhere.
			await budget.yieldIfDue();
			const mimeType =
				getSandboxMimeTypeForExtension(extname(file.filename).toLowerCase()) ??
				undefined;
			const validation = await validateGeneratedOutputFile(
				{ filename: file.filename, mimeType, content },
				{ requireKnownMimeType: true },
			);
			if (!validation.ok) {
				throw new InlineTextOutputError(validation.code, validation.message);
			}
			const signature = validateProducedFileSignature({
				filename: file.filename,
				content,
			});
			if (!signature.ok) {
				throw new InlineTextOutputError(signature.code, signature.message);
			}
			files.push({
				filename: file.filename,
				mimeType,
				content,
				sizeBytes: content.length,
			});
		}
		return { files, stdout: "", stderr: "", error: null };
	})();
}

async function renderDocumentSource(
	request: Extract<
		ParsedFileProductionJobRequest,
		{ sourceMode: "document_source" }
	>,
	input: ExecutePersistedFileProductionRequestInput,
	budget: RenderBudget,
	limits: FileProductionLimits,
): Promise<{ execution: ProgramExecutionResult; sourceArtifact: Artifact }> {
	let sourceArtifact: Artifact;
	try {
		sourceArtifact = await persistGeneratedDocumentSourceArtifact({
			userId: input.userId,
			conversationId: input.conversationId,
			assistantMessageId: input.assistantMessageId,
			fileProductionJobId: input.fileProductionJobId,
			title: input.title,
			documentIntent: input.documentIntent,
			source: request.documentSource,
		});
	} catch (error) {
		throw new GeneratedDocumentSourcePersistenceError(
			error instanceof Error
				? error.message
				: "Generated document source persistence failed.",
		);
	}
	const files: ProgramExecutionFile[] = [];

	try {
		if (request.outputs.includes("pdf")) {
			const rendered = await renderStandardReportPdf(request.documentSource, {
				imageLoader: createDefaultGeneratedDocumentImageLoader({
					userId: input.userId,
					conversationId: input.conversationId,
				}),
				budget,
				maxPages: limits.maxPdfPages,
			});
			files.push({
				filename: rendered.filename,
				mimeType: rendered.mimeType,
				content: rendered.content,
				sizeBytes: rendered.content.length,
			});
		}
		if (request.outputs.includes("docx")) {
			const rendered = await renderStandardReportDocx(request.documentSource, {
				budget,
			});
			files.push({
				filename: rendered.filename,
				mimeType: rendered.mimeType,
				content: rendered.content,
				sizeBytes: rendered.content.length,
			});
		}
		if (request.outputs.includes("html")) {
			// Resolve the cited domains' icons HERE, server-side, so the rendered
			// file can inline them: the report is downloaded and opened outside the
			// app, where a remote icon URL would both fail to resolve and tell every
			// cited domain the reader opened this report. A failed lookup just means
			// that source keeps the neutral globe.
			await budget.yieldIfDue();
			const favicons = await resolveReportFavicons(request.documentSource);
			// HTML and Markdown lay out in microseconds and stay synchronous, so
			// their bound is a gate on either side rather than checks inside them:
			// a render already out of time never starts, and one that somehow
			// overshoots is caught before its bytes are kept.
			const rendered = renderStandardReportHtml(
				request.documentSource,
				favicons,
			);
			budget.checkpoint();
			files.push({
				filename: rendered.filename,
				mimeType: rendered.mimeType,
				content: rendered.content,
				sizeBytes: rendered.content.length,
			});
		}
		if (request.outputs.includes("markdown")) {
			await budget.yieldIfDue();
			const rendered = renderStandardReportMarkdown(request.documentSource);
			budget.checkpoint();
			files.push({
				filename: rendered.filename,
				mimeType: rendered.mimeType,
				content: rendered.content,
				sizeBytes: rendered.content.length,
			});
		}
	} catch (error) {
		await markGeneratedDocumentSourceArtifactFailed({
			artifactId: sourceArtifact.id,
			errorCode:
				error instanceof StandardReportPdfRenderError
					? error.code
					: "document_render_failed",
			errorMessage:
				error instanceof Error
					? error.message
					: "Generated document rendering failed.",
		});
		throw error;
	}

	return {
		sourceArtifact,
		execution: {
			files,
			stdout: "",
			stderr: "",
			error: null,
		},
	};
}

export async function executePersistedFileProductionRequest(
	input: ExecutePersistedFileProductionRequestInput,
): Promise<ExecutePersistedFileProductionRequestResult> {
	const request = parseFileProductionJobRequest(input.requestJson);
	if (!request.ok) {
		return {
			ok: false,
			errorCode: request.errorCode,
			errorMessage: request.errorMessage,
			retryable: false,
		};
	}

	const limits: FileProductionLimits = {
		...getFileProductionLimits(),
		...input.limits,
	};
	// One budget for the whole attempt, not one per renderer: a request for a
	// PDF and a DOCX is one job, and giving each output its own full timeout
	// would let a two-output request run for twice the configured bound.
	const budget = new RenderBudget({
		timeoutMs: limits.rendererTimeoutMs,
		signal: input.signal,
	});

	if (request.value.sourceMode === "inline_text") {
		try {
			return {
				ok: true,
				request: request.value,
				execution: await runInlineText(request.value, budget),
				sourceArtifact: null,
			};
		} catch (error) {
			if (error instanceof FileProductionRenderAbortedError) {
				return {
					ok: false,
					errorCode: error.code,
					errorMessage: error.message,
					// A timeout is worth another go on a quieter box; a cancel is
					// not, and the ledger's CAS will refuse this verdict anyway.
					retryable: error.code === "renderer_timeout",
				};
			}
			// Bad bytes are the model's to fix, not the infrastructure's: an
			// inline_text failure is never retryable under the same request.
			return {
				ok: false,
				errorCode:
					error instanceof InlineTextOutputError
						? error.code
						: "inline_text_write_failed",
				errorMessage:
					error instanceof Error
						? error.message
						: "Inline text file production failed.",
				retryable: false,
			};
		}
	}

	if (request.value.sourceMode === "program") {
		const executeCode = input.executeCode ?? executeSandboxCode;
		try {
			// The sandbox has its own SIGKILL; the signal is what makes a CANCEL
			// reach the container instead of waiting out the full deadline on
			// work nobody wants.
			//
			// `limits.sandboxTimeoutMs` is the admin's
			// `FILE_PRODUCTION_SANDBOX_TIMEOUT_MS`, and passing it here is what
			// makes that key mean anything: until now the value was parsed,
			// clamped, surfaced in the health readout and then discarded, while
			// the container was killed on `getSandboxTimeout()`'s hard-coded 90 s
			// whatever the admin had set. Only file production passes it —
			// `run_python` shares `executeCode` but not this knob, and its own
			// envelope timeout is derived from the same hard-coded constant, so
			// raising the file-production deadline must not move it.
			const execution = await executeCode(
				request.value.sourceCode,
				request.value.language,
				{ signal: input.signal, timeoutMs: limits.sandboxTimeoutMs },
			);
			if (execution.error) {
				// A timeout and a crash are different things to a user: the card
				// has localized copy for each, and only the code chooses between
				// them. `sandbox_timeout` was declared in the limit vocabulary and
				// never emitted, so every timed-out program reached the card as
				// `program_execution_failed` with the raw English "Execution timed
				// out" beside it. Both are retryable for the Retry button — another
				// go on a quieter box is exactly what a deadline miss deserves —
				// and neither is model-correctable (`produce-file.ts` keeps "timed
				// out" out of the correctable set by message marker).
				const timedOut = execution.error === SANDBOX_TIMEOUT_ERROR;
				return {
					ok: false,
					errorCode: timedOut ? "sandbox_timeout" : "program_execution_failed",
					errorMessage: execution.error,
					retryable: true,
				};
			}
			return {
				ok: true,
				request: request.value,
				execution,
				sourceArtifact: null,
			};
		} catch (error) {
			return {
				ok: false,
				errorCode: "program_execution_threw",
				errorMessage:
					error instanceof Error ? error.message : "Program execution failed.",
				retryable: true,
			};
		}
	}

	try {
		const { execution, sourceArtifact } = await renderDocumentSource(
			request.value,
			input,
			budget,
			limits,
		);
		return {
			ok: true,
			request: request.value,
			execution,
			sourceArtifact,
		};
	} catch (error) {
		if (error instanceof FileProductionRenderAbortedError) {
			return {
				ok: false,
				errorCode: error.code,
				errorMessage: error.message,
				retryable: error.code === "renderer_timeout",
			};
		}
		if (error instanceof GeneratedDocumentSourcePersistenceError) {
			return {
				ok: false,
				errorCode: "generated_document_source_persistence_failed",
				errorMessage: error.message,
				retryable: true,
			};
		}
		if (error instanceof StandardReportPdfRenderError) {
			return {
				ok: false,
				errorCode: error.code,
				errorMessage: error.message,
				retryable: error.code === "pdf_font_missing",
			};
		}
		return {
			ok: false,
			errorCode: "document_render_failed",
			errorMessage:
				error instanceof Error
					? error.message
					: "Generated document rendering failed.",
			retryable: true,
		};
	}
}
