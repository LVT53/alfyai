import { executeCode as executeSandboxCode } from "$lib/server/services/sandbox-execution";
import type { Artifact } from "$lib/types";
import { createDefaultGeneratedDocumentImageLoader } from "./image-loader";
import { renderStandardReportDocx } from "./renderers/standard-report-docx";
import { renderStandardReportHtml } from "./renderers/standard-report-html";
import { renderStandardReportMarkdown } from "./renderers/standard-report-markdown";
import {
	renderStandardReportPdf,
	StandardReportPdfRenderError,
} from "./renderers/standard-report-pdf";
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
			outputs: Array<"pdf" | "docx" | "html" | "markdown">;
	  };

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
	) => Promise<ProgramExecutionResult>;
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

function normalizeDocumentOutput(
	type: string,
): "pdf" | "docx" | "html" | "markdown" | null {
	switch (type) {
		case "pdf":
		case "application/pdf":
			return "pdf";
		case "docx":
		case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
			return "docx";
		case "html":
		case "text/html":
			return "html";
		case "markdown":
		case "md":
		case "text/markdown":
			return "markdown";
		default:
			return null;
	}
}

function selectDocumentOutputs(
	outputs: string[],
): Array<"pdf" | "docx" | "html" | "markdown"> | null {
	if (outputs.length === 0) return ["pdf"];
	const normalized = outputs.map(normalizeDocumentOutput);
	if (normalized.some((output) => output === null)) return null;
	return Array.from(new Set(normalized)) as Array<
		"pdf" | "docx" | "html" | "markdown"
	>;
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

async function renderDocumentSource(
	request: Extract<
		ParsedFileProductionJobRequest,
		{ sourceMode: "document_source" }
	>,
	input: ExecutePersistedFileProductionRequestInput,
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
			});
			files.push({
				filename: rendered.filename,
				mimeType: rendered.mimeType,
				content: rendered.content,
				sizeBytes: rendered.content.length,
			});
		}
		if (request.outputs.includes("docx")) {
			const rendered = await renderStandardReportDocx(request.documentSource);
			files.push({
				filename: rendered.filename,
				mimeType: rendered.mimeType,
				content: rendered.content,
				sizeBytes: rendered.content.length,
			});
		}
		if (request.outputs.includes("html")) {
			const rendered = renderStandardReportHtml(request.documentSource);
			files.push({
				filename: rendered.filename,
				mimeType: rendered.mimeType,
				content: rendered.content,
				sizeBytes: rendered.content.length,
			});
		}
		if (request.outputs.includes("markdown")) {
			const rendered = renderStandardReportMarkdown(request.documentSource);
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

	if (request.value.sourceMode === "program") {
		const executeCode = input.executeCode ?? executeSandboxCode;
		try {
			const execution = await executeCode(
				request.value.sourceCode,
				request.value.language,
			);
			if (execution.error) {
				return {
					ok: false,
					errorCode: "program_execution_failed",
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
		);
		return {
			ok: true,
			request: request.value,
			execution,
			sourceArtifact,
		};
	} catch (error) {
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
