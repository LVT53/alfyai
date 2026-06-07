import { z } from "zod";

import type { FileProductionIntakeResult } from "$lib/server/services/file-production";
import type { ToolCallEntry } from "$lib/types";

import { isRecord, shortHash, stableStringify } from "./shared";

// ── Input schema ───────────────────────────────────────────────

export const requestedOutputSchema = z.object({
	type: z.string().min(1),
});

export const produceFileInputSchema = z
	.object({
		idempotencyKey: z.string().min(1).optional(),
		requestTitle: z.string().min(1).optional(),
		title: z.string().min(1).optional(),
		requestedOutputs: z.array(requestedOutputSchema).min(1).optional(),
		outputs: z.array(requestedOutputSchema).min(1).optional(),
		outputType: z.string().min(1).optional(),
		fileType: z.string().min(1).optional(),
		filename: z.string().min(1).optional(),
		sourceMode: z.enum(["program", "document_source"]).optional(),
		documentIntent: z.string().min(1).optional(),
		templateHint: z.string().min(1).optional(),
		content: z.string().min(1).optional(),
		markdown: z.string().min(1).optional(),
		text: z.string().min(1).optional(),
		program: z
			.object({
				language: z.enum(["python", "javascript"]),
				sourceCode: z.string().min(1),
				filename: z.string().min(1).optional(),
			})
			.optional(),
		documentSource: z.record(z.string(), z.unknown()).optional(),
	})
	.passthrough();

// ── Types ──────────────────────────────────────────────────────

export type ProduceFileInput = z.infer<typeof produceFileInputSchema>;
export type NormalizedProduceFileInput = {
	idempotencyKey?: string;
	requestTitle: string;
	requestedOutputs: Array<{ type: string }>;
	sourceMode: "program" | "document_source";
	documentIntent?: string;
	templateHint?: string;
	program?: {
		language: "python" | "javascript";
		sourceCode: string;
		filename?: string;
	};
	documentSource?: Record<string, unknown>;
};
export type SafeProduceFileInput = Record<string, unknown>;

// ── File production detection ──────────────────────────────────

const FILE_PRODUCTION_ACTION_RE =
	/\b(create|make|generate|prepare|produce|build|write|export|convert|save|download|summari[sz]e)\b/i;
const FILE_PRODUCTION_TARGET_RE =
	/\b(downloadable|download|file|pdf|docx?|xlsx?|csv|pptx?|powerpoint|spreadsheet|excel|word document|slide deck|presentation|html|markdown|md|txt|json|zip|archive)\b|\.[a-z0-9]{2,5}\b/i;
const FILE_PRODUCTION_NEGATION_RE =
	/\b(no file needed|no downloadable file|without (?:a )?(?:file|download)|do not (?:create|make|generate|produce|export|download).*file|don't (?:create|make|generate|produce|export|download).*file)\b/i;
const INFORMATIONAL_FILE_QUESTION_RE = /^\s*(how|what|why|when|where|who)\b/i;
const REQUEST_FOR_ME_RE = /\b(for me|please|can you|could you|would you)\b/i;
const CONTEXT_DEPENDENT_FILE_SOURCE_RE =
	/\b(content from|project folder|folder|workspace|knowledge|memory|context|attached|uploaded|current document|existing document|library|notes?)\b/i;

export function isProduceFileRequest(message: string): boolean {
	const text = message.trim();
	if (!text) return false;
	if (FILE_PRODUCTION_NEGATION_RE.test(text)) return false;
	if (!FILE_PRODUCTION_ACTION_RE.test(text)) return false;
	if (!FILE_PRODUCTION_TARGET_RE.test(text)) return false;
	if (
		INFORMATIONAL_FILE_QUESTION_RE.test(text) &&
		!REQUEST_FOR_ME_RE.test(text)
	) {
		return false;
	}
	return true;
}

export function shouldForceProduceFileTool(message: string): boolean {
	const text = message.trim();
	if (!isProduceFileRequest(text)) return false;
	if (CONTEXT_DEPENDENT_FILE_SOURCE_RE.test(text)) return false;
	return true;
}

// ── Input normalization ────────────────────────────────────────

export function normalizeProduceFileInput(
	input: ProduceFileInput,
):
	| { ok: true; input: NormalizedProduceFileInput }
	| { ok: false; error: string } {
	const requestTitle =
		input.requestTitle?.trim() ||
		input.title?.trim() ||
		titleFromFilename(input.filename) ||
		"Generated file";
	const requestedOutputs = normalizeToolRequestedOutputs(input);
	const content = firstNonEmptyString(
		input.markdown,
		input.content,
		input.text,
	);
	const explicitMode = input.sourceMode;

	if (explicitMode === "program" || input.program) {
		if (!input.program) {
			if (!content) {
				return {
					ok: false,
					error: "program or content is required when sourceMode is program",
				};
			}
			return {
				ok: true,
				input: {
					idempotencyKey: input.idempotencyKey,
					requestTitle,
					requestedOutputs,
					sourceMode: "program",
					documentIntent: input.documentIntent,
					templateHint: input.templateHint,
					program: buildTextFileProgram({
						content,
						filename: resolveTextFilename({
							filename: input.filename,
							requestTitle,
							outputType: requestedOutputs[0]?.type,
						}),
					}),
				},
			};
		}
		return {
			ok: true,
			input: {
				idempotencyKey: input.idempotencyKey,
				requestTitle,
				requestedOutputs,
				sourceMode: "program",
				documentIntent: input.documentIntent,
				templateHint: input.templateHint,
				program: input.program,
			},
		};
	}

	if (explicitMode === "document_source" || input.documentSource) {
		if (!input.documentSource && !content) {
			return {
				ok: false,
				error:
					"documentSource or content is required when sourceMode is document_source",
			};
		}
		if (
			input.documentSource &&
			!hasSubstantiveDocumentSource(input.documentSource)
		) {
			return {
				ok: false,
				error:
					"documentSource must contain substantive content when sourceMode is document_source",
			};
		}
		const documentSource = input.documentSource
			? normalizeDocumentSourceEnvelope(input.documentSource, requestTitle)
			: buildDocumentSourceFromText({
					title: requestTitle,
					text: content ?? "",
				});
		if (!hasSubstantiveDocumentSource(documentSource)) {
			return {
				ok: false,
				error:
					"documentSource must contain substantive content when sourceMode is document_source",
			};
		}
		return {
			ok: true,
			input: {
				idempotencyKey: input.idempotencyKey,
				requestTitle,
				requestedOutputs,
				sourceMode: "document_source",
				documentIntent: input.documentIntent,
				templateHint: input.templateHint,
				documentSource,
			},
		};
	}

	if (content) {
		if (!hasSubstantiveContent(content)) {
			return {
				ok: false,
				error:
					"Content is too short or appears to be a template. Provide substantive content with actual data, or use explicit sourceMode with program.sourceCode or documentSource. Do not call produce_file with placeholder or template content.",
			};
		}
		if (shouldUseDocumentSourceForOutputs(requestedOutputs)) {
			return {
				ok: true,
				input: {
					idempotencyKey: input.idempotencyKey,
					requestTitle,
					requestedOutputs,
					sourceMode: "document_source",
					documentIntent: input.documentIntent ?? "document",
					templateHint: input.templateHint,
					documentSource: buildDocumentSourceFromText({
						title: requestTitle,
						text: content,
					}),
				},
			};
		}
		return {
			ok: true,
			input: {
				idempotencyKey: input.idempotencyKey,
				requestTitle,
				requestedOutputs,
				sourceMode: "program",
				documentIntent: input.documentIntent ?? "data export",
				templateHint: input.templateHint,
				program: buildTextFileProgram({
					content,
					filename: resolveTextFilename({
						filename: input.filename,
						requestTitle,
						outputType: requestedOutputs[0]?.type,
					}),
				}),
			},
		};
	}

	return {
		ok: false,
		error:
			"produce_file requires content, markdown, text, documentSource, or program",
	};
}

// ── Internal normalization helpers ─────────────────────────────

function normalizeDocumentSourceEnvelope(
	documentSource: Record<string, unknown>,
	requestTitle: string,
): Record<string, unknown> {
	return {
		...documentSource,
		version: 1,
		template: "alfyai_standard_report",
		title:
			typeof documentSource.title === "string" &&
			documentSource.title.trim().length > 0
				? documentSource.title
				: requestTitle,
		blocks:
			Array.isArray(documentSource.blocks) && documentSource.blocks.length > 0
				? documentSource.blocks
				: [
						{
							type: "paragraph",
							text: `Generated file request: ${requestTitle}`,
						},
					],
	};
}

function normalizeToolRequestedOutputs(
	input: ProduceFileInput,
): Array<{ type: string }> {
	const explicitOutputs = input.requestedOutputs ?? input.outputs;
	if (Array.isArray(explicitOutputs) && explicitOutputs.length > 0) {
		return explicitOutputs.map((output) => ({
			type: output.type.trim() || "file",
		}));
	}
	const directType =
		input.outputType?.trim() ||
		input.fileType?.trim() ||
		outputTypeFromFilename(input.filename);
	if (directType) return [{ type: directType }];
	if (input.markdown) return [{ type: "md" }];
	if (input.text || input.content) return [{ type: "txt" }];
	if (input.documentSource) return [{ type: "pdf" }];
	return [{ type: "file" }];
}

function firstNonEmptyString(
	...values: Array<string | undefined>
): string | null {
	for (const value of values) {
		const trimmed = value?.trim();
		if (trimmed) return trimmed;
	}
	return null;
}

function outputTypeFromFilename(filename?: string): string | null {
	const trimmed = filename?.trim();
	if (!trimmed) return null;
	const match = /\.([a-z0-9]+)$/i.exec(trimmed);
	return match?.[1]?.toLowerCase() ?? null;
}

function titleFromFilename(filename?: string): string | null {
	const trimmed = filename?.trim();
	if (!trimmed) return null;
	const withoutExtension = trimmed.replace(/\.[a-z0-9]+$/i, "");
	const title = withoutExtension
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return title || null;
}

function shouldUseDocumentSourceForOutputs(
	outputs: Array<{ type: string }>,
): boolean {
	const documentTypes = new Set(["pdf", "docx", "html"]);
	return outputs.every((output) =>
		documentTypes.has(output.type.trim().toLowerCase()),
	);
}

// ── Filename / program helpers ─────────────────────────────────

const OUTPUT_TYPE_EXTENSIONS: Record<string, string> = {
	markdown: "md",
	"text/markdown": "md",
	md: "md",
	txt: "txt",
	text: "txt",
	"text/plain": "txt",
	json: "json",
	"application/json": "json",
	csv: "csv",
	"text/csv": "csv",
	html: "html",
	"text/html": "html",
	css: "css",
	js: "js",
	javascript: "js",
	ts: "ts",
	typescript: "ts",
	sh: "sh",
	shell: "sh",
	svg: "svg",
	xml: "xml",
	yaml: "yaml",
	yml: "yml",
};

function resolveTextFilename(params: {
	filename?: string;
	requestTitle: string;
	outputType?: string;
}): string {
	const explicit = sanitizeFilename(params.filename);
	if (explicit) return explicit;
	const normalizedType =
		OUTPUT_TYPE_EXTENSIONS[params.outputType?.trim().toLowerCase() ?? ""] ??
		params.outputType?.trim().toLowerCase() ??
		"txt";
	const extension = normalizedType.replace(/^\./, "") || "txt";
	const basename =
		params.requestTitle
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 80) || "generated-file";
	return `${basename}.${extension}`;
}

function sanitizeFilename(value?: string): string | null {
	const trimmed = value?.trim();
	if (!trimmed) return null;
	const basename = trimmed.split(/[\\/]/).filter(Boolean).pop() ?? "";
	const safe = basename.replace(/[^a-zA-Z0-9._ -]+/g, "-").trim();
	return safe && safe !== "." && safe !== ".." ? safe.slice(0, 120) : null;
}

function buildTextFileProgram(params: {
	content: string;
	filename: string;
}): NonNullable<NormalizedProduceFileInput["program"]> {
	const filename = sanitizeFilename(params.filename) ?? "generated-file.txt";
	return {
		language: "python",
		filename,
		sourceCode: [
			"from pathlib import Path",
			"output = Path('/output')",
			"output.mkdir(parents=True, exist_ok=True)",
			`(output / ${JSON.stringify(filename)}).write_text(${JSON.stringify(params.content)}, encoding='utf-8')`,
			"",
		].join("\n"),
	};
}

// ── Document source construction ───────────────────────────────

function buildDocumentSourceFromText(params: {
	title: string;
	text: string;
}): Record<string, unknown> {
	const blocks = markdownishTextToBlocks(params.text);
	return {
		version: 1,
		template: "alfyai_standard_report",
		title: params.title,
		blocks:
			blocks.length > 0
				? blocks
				: [{ type: "paragraph", text: params.text || params.title }],
	};
}

function stripInlineMarkdown(text: string): string {
	return text
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/_([^_]+)_/g, "$1")
		.replace(/~~([^~]+)~~/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function markdownishTextToBlocks(text: string): Array<Record<string, unknown>> {
	const blocks: Array<Record<string, unknown>> = [];
	const paragraph: string[] = [];
	let listItems: string[] = [];
	const flushParagraph = () => {
		if (paragraph.length === 0) return;
		blocks.push({
			type: "paragraph",
			text: stripInlineMarkdown(paragraph.join(" ")),
		});
		paragraph.length = 0;
	};
	const flushList = () => {
		if (listItems.length === 0) return;
		blocks.push({
			type: "list",
			style: "bullet",
			items: listItems.map(stripInlineMarkdown),
		});
		listItems = [];
	};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) {
			flushParagraph();
			flushList();
			continue;
		}
		const heading = /^(#{1,3})\s+(.+)$/.exec(line);
		if (heading) {
			flushParagraph();
			flushList();
			blocks.push({
				type: "heading",
				level: Math.min(3, Math.max(1, heading[1].length)),
				text: stripInlineMarkdown(heading[2].trim()),
			});
			continue;
		}
		const bullet = /^[-*]\s+(.+)$/.exec(line);
		if (bullet) {
			flushParagraph();
			listItems.push(bullet[1].trim());
			continue;
		}
		flushList();
		paragraph.push(line);
	}
	flushParagraph();
	flushList();
	return blocks;
}

// ── Content validation ─────────────────────────────────────────

const TEMPLATE_MARKER_RE =
	/\b(TODO|placeholder|content (goes )?here|to be filled|\[placeholder\]|\.\.\.\s*$|^#\s+\w+(\s+\w+){0,3}\s*\.\.\.\s*$)/im;
const MIN_SUBSTANTIVE_CONTENT_LENGTH = 80;

function hasSubstantiveContent(content: string): boolean {
	const text = stripMarkdownFormatting(content).trim();
	if (text.length < MIN_SUBSTANTIVE_CONTENT_LENGTH) return false;
	if (TEMPLATE_MARKER_RE.test(text)) return false;
	return true;
}

function stripMarkdownFormatting(content: string): string {
	return content
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/```[\s\S]*?```/g, "")
		.replace(/`[^`\n]+`/g, "")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/[*_~]{1,3}/g, "")
		.replace(/^[\s]*[-*+]\s+/gm, "")
		.replace(/^[\s]*\d+\.\s+/gm, "")
		.replace(/^>\s*/gm, "")
		.replace(/\n{2,}/g, "\n")
		.replace(/\s+/g, " ");
}

const DOCUMENT_SOURCE_METADATA_KEYS = new Set([
	"template",
	"title",
	"type",
	"version",
]);

function hasSubstantiveDocumentSource(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return Object.entries(value).some(([key, item]) => {
		if (DOCUMENT_SOURCE_METADATA_KEYS.has(key)) return false;
		return hasSubstantiveDocumentValue(item);
	});
}

function hasSubstantiveDocumentValue(value: unknown): boolean {
	if (typeof value === "string") return value.trim().length > 0;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) {
		return value.some((item) => hasSubstantiveDocumentValue(item));
	}
	if (!isRecord(value)) return false;
	return Object.entries(value).some(([key, item]) => {
		if (DOCUMENT_SOURCE_METADATA_KEYS.has(key)) return false;
		return hasSubstantiveDocumentValue(item);
	});
}

// ── Idempotency ────────────────────────────────────────────────

export function buildScopedIdempotencyKey(params: {
	turnId: string;
	input: NormalizedProduceFileInput;
}): string {
	const idempotencySource =
		params.input.idempotencyKey ?? params.input.requestTitle;
	const parts = [
		slugifyIdempotencyPart(params.turnId, 48),
		"produce_file",
		slugifyIdempotencyPart(idempotencySource, 60),
		shortHash({
			idempotencyKey: params.input.idempotencyKey ?? null,
			requestTitle: params.input.requestTitle,
			inputHash: shortHash(params.input),
		}),
	];
	return parts.join(":").slice(0, 160);
}

export function buildSameTurnProduceFileDedupeKey(
	input: NormalizedProduceFileInput,
): string {
	const requestedOutputs = input.requestedOutputs
		.map((output) => output.type.trim().toLowerCase())
		.sort();
	const programFilename =
		input.sourceMode === "program" && input.program?.filename
			? input.program.filename.trim().toLowerCase()
			: null;

	return stableStringify({
		requestTitle: input.requestTitle.trim().toLowerCase(),
		requestedOutputs,
		sourceMode: input.sourceMode,
		documentIntent: input.documentIntent?.trim().toLowerCase() ?? null,
		templateHint: input.templateHint?.trim().toLowerCase() ?? null,
		programFilename,
	});
}

function slugifyIdempotencyPart(value: string, maxLength = 80): string {
	const slug = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return (slug || "request").slice(0, maxLength);
}

// ── Input sanitization for tool call recording ─────────────────

export function sanitizeProduceFileInput(
	input: NormalizedProduceFileInput,
): SafeProduceFileInput {
	const safe: SafeProduceFileInput = {
		...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
		requestTitle: input.requestTitle,
		requestedOutputs: input.requestedOutputs.map((output) => ({
			type: output.type,
		})),
		sourceMode: input.sourceMode,
		...(input.documentIntent ? { documentIntent: input.documentIntent } : {}),
		...(input.templateHint ? { templateHint: input.templateHint } : {}),
	};

	if (input.program) {
		safe.program = {
			language: input.program.language,
			...(input.program.filename ? { filename: input.program.filename } : {}),
			sourceCodeHash: shortHash(input.program.sourceCode),
			sourceCodeLength: input.program.sourceCode.length,
		};
	}

	if (input.documentSource) {
		const serializedDocumentSource = stableStringify(input.documentSource);
		safe.documentSource = {
			contentHash: shortHash(input.documentSource),
			topLevelKeyCount: Object.keys(input.documentSource).length,
			serializedLength: serializedDocumentSource.length,
		};
	}

	return safe;
}

export function sanitizeUnsafeProduceFileInput(
	input: unknown,
): SafeProduceFileInput {
	if (!isRecord(input)) return {};
	const safe: SafeProduceFileInput = {};
	if (typeof input.idempotencyKey === "string" && input.idempotencyKey) {
		safe.idempotencyKey = input.idempotencyKey;
	}
	if (typeof input.requestTitle === "string") {
		safe.requestTitle = input.requestTitle;
	}
	if (typeof input.title === "string") {
		safe.title = input.title;
	}
	if (Array.isArray(input.requestedOutputs)) {
		safe.requestedOutputs = input.requestedOutputs
			.filter(isRecord)
			.map((output) => ({
				...(typeof output.type === "string" ? { type: output.type } : {}),
			}));
	}
	if (Array.isArray(input.outputs)) {
		safe.outputs = input.outputs.filter(isRecord).map((output) => ({
			...(typeof output.type === "string" ? { type: output.type } : {}),
		}));
	}
	if (typeof input.outputType === "string") {
		safe.outputType = input.outputType;
	}
	if (typeof input.fileType === "string") {
		safe.fileType = input.fileType;
	}
	if (typeof input.filename === "string") {
		safe.filename = input.filename;
	}
	if (typeof input.sourceMode === "string") {
		safe.sourceMode = input.sourceMode;
	}
	if (typeof input.documentIntent === "string") {
		safe.documentIntent = input.documentIntent;
	}
	if (typeof input.templateHint === "string") {
		safe.templateHint = input.templateHint;
	}
	if (isRecord(input.program)) {
		safe.program = {
			...(typeof input.program.language === "string"
				? { language: input.program.language }
				: {}),
			...(typeof input.program.filename === "string"
				? { filename: input.program.filename }
				: {}),
			...(typeof input.program.sourceCode === "string"
				? {
						sourceCodeHash: shortHash(input.program.sourceCode),
						sourceCodeLength: input.program.sourceCode.length,
					}
				: {}),
		};
	}
	if (isRecord(input.documentSource)) {
		const serializedDocumentSource = stableStringify(input.documentSource);
		safe.documentSource = {
			contentHash: shortHash(input.documentSource),
			topLevelKeyCount: Object.keys(input.documentSource).length,
			serializedLength: serializedDocumentSource.length,
		};
	}
	for (const field of ["content", "markdown", "text"] as const) {
		if (typeof input[field] === "string") {
			safe[field] = {
				contentHash: shortHash(input[field]),
				contentLength: input[field].length,
			};
		}
	}
	return safe;
}

// ── Model payload / result compaction ──────────────────────────

export function compactProduceFileModelPayload(
	result: FileProductionIntakeResult,
) {
	if (result.ok) {
		return {
			ok: true as const,
			status: result.status,
			jobId: result.job.id,
			jobStatus: result.job.status,
			reused: result.reused,
		};
	}

	return {
		ok: false as const,
		status: result.status,
		code: result.code,
		error: result.error,
		...(result.job
			? {
					jobId: result.job.id,
					jobStatus: result.job.status,
				}
			: {}),
	};
}

export function summarizeProduceFileResult(
	payload: ReturnType<typeof compactProduceFileModelPayload>,
): string {
	if (payload.ok) {
		return `File production job ${payload.jobId} queued with status ${payload.jobStatus}.`;
	}
	return payload.jobId
		? `File production intake failed for job ${payload.jobId}: ${payload.error}`
		: `File production intake failed: ${payload.error}`;
}

// ── Tool call entry creation ───────────────────────────────────

export function createProduceFileToolCallEntry(params: {
	callId: string;
	input: SafeProduceFileInput;
	result: FileProductionIntakeResult;
	outputSummary: string;
	metadata?: Record<string, string | number | boolean | null>;
}): ToolCallEntry {
	const metadata: ToolCallEntry["metadata"] = {
		ok: params.result.ok,
		intakeStatus: params.result.status,
		...params.metadata,
	};
	if (params.result.ok) {
		metadata.jobId = params.result.job.id;
		metadata.jobStatus = params.result.job.status;
		metadata.reused = params.result.reused;
	} else {
		metadata.evidenceReady = false;
		metadata.code = params.result.code;
		if (params.result.job) {
			metadata.jobId = params.result.job.id;
			metadata.jobStatus = params.result.job.status;
		}
	}

	return {
		callId: params.callId,
		name: "produce_file",
		input: params.input,
		status: "done",
		outputSummary: params.outputSummary,
		sourceType: "tool",
		metadata,
	};
}
