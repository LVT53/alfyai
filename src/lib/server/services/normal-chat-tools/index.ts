import { createHash } from "node:crypto";
import { type ToolExecutionOptions, tool } from "ai";
import { z } from "zod";

import type { FileProductionIntakeResult } from "$lib/server/services/file-production";
import { submitFileProductionIntake } from "$lib/server/services/file-production";
import {
	type ImageSearchResult,
	searchImages,
} from "$lib/server/services/image-search";
import {
	getMemoryContext,
	type MemoryContextResult,
} from "$lib/server/services/memory-context";
import {
	type ResearchResult,
	researchWeb,
} from "$lib/server/services/web-research";
import type { ToolCallEntry, ToolEvidenceCandidate } from "$lib/types";

const requestedOutputSchema = z.object({
	type: z.string().min(1),
});

const researchWebInputSchema = z.object({
	query: z.string().min(1),
	mode: z.enum(["quick", "research", "exact"]).optional(),
	freshness: z.enum(["auto", "live", "recent", "cache"]).optional(),
	sourcePolicy: z
		.enum([
			"general",
			"technical",
			"news",
			"commerce",
			"medical_legal_financial",
		])
		.optional(),
	maxSources: z.number().int().min(1).max(12).optional(),
	quoteRequired: z.boolean().optional(),
});

const memoryContextInputSchema = z.object({
	mode: z
		.enum(["persona", "project", "history"])
		.optional()
		.describe(
			"Memory scope. Use project for project folders/continuity, persona for user preferences/profile, and history for older account chats outside a project.",
		),
	query: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Specific lookup question or named entity. For named project folders, include the exact folder name, e.g. 'AlmaLinux Server'. Folder-wide report/export requests return bounded report context in one call.",
		),
	maxSiblings: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe(
			"Maximum project sibling conversations to return. For folder-wide reports, keep this at or below 16 and use the returned reportSiblings instead of one detail call per sibling.",
		),
	siblingConversationId: z
		.string()
		.min(1)
		.optional()
		.describe(
			"One conversation id returned by a previous project result when requesting deeper project detail.",
		),
	maxMessages: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe(
			"Maximum recent messages to return for a selected conversation, or per sibling for folder-wide report context.",
		),
	maxHistoryConversations: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe("Maximum older history conversations to return."),
	historyConversationId: z
		.string()
		.min(1)
		.optional()
		.describe(
			"One conversation id returned by history mode for deeper detail.",
		),
	selectedConversationId: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Alias for selecting one returned history conversation for detail.",
		),
	includeEvidenceCandidates: z
		.boolean()
		.optional()
		.describe(
			"Whether to include bounded evidence candidates for UI citations.",
		),
});

const imageSearchInputSchema = z.object({
	query: z.string().min(1),
});

const produceFileInputSchema = z
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

type ProduceFileInput = z.infer<typeof produceFileInputSchema>;
type NormalizedProduceFileInput = {
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
type SafeProduceFileInput = Record<string, unknown>;
type ResearchWebInput = z.infer<typeof researchWebInputSchema>;
type MemoryContextInput = z.infer<typeof memoryContextInputSchema>;
type ImageSearchInput = z.infer<typeof imageSearchInputSchema>;

export interface ToolCallRecorder {
	record(entry: ToolCallEntry): ToolCallEntry;
	getEntries(): ToolCallEntry[];
}

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

function normalizeProduceFileInput(input: ProduceFileInput):
	| { ok: true; input: NormalizedProduceFileInput }
	| { ok: false; error: string } {
	const requestTitle =
		input.requestTitle?.trim() ||
		input.title?.trim() ||
		titleFromFilename(input.filename) ||
		"Generated file";
	const requestedOutputs = normalizeToolRequestedOutputs(input);
	const content = firstNonEmptyString(input.markdown, input.content, input.text);
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
				error: "documentSource or content is required when sourceMode is document_source",
			};
		}
		if (input.documentSource && !hasSubstantiveDocumentSource(input.documentSource)) {
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

function markdownishTextToBlocks(text: string): Array<Record<string, unknown>> {
	const blocks: Array<Record<string, unknown>> = [];
	const paragraph: string[] = [];
	let listItems: string[] = [];
	const flushParagraph = () => {
		if (paragraph.length === 0) return;
		blocks.push({
			type: "paragraph",
			text: paragraph.join(" ").replace(/\s+/g, " ").trim(),
		});
		paragraph.length = 0;
	};
	const flushList = () => {
		if (listItems.length === 0) return;
		blocks.push({ type: "list", style: "bullet", items: listItems });
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
				text: heading[2].trim(),
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

const TEMPLATE_MARKER_RE = /\b(TODO|placeholder|content (goes )?here|to be filled|\[placeholder\]|\.\.\.\s*$|^#\s+\w+(\s+\w+){0,3}\s*\.\.\.\s*$)/im;
const MIN_SUBSTANTIVE_CONTENT_LENGTH = 80;

function hasSubstantiveContent(content: string): boolean {
	const text = stripMarkdownFormatting(content).trim();
	if (text.length < MIN_SUBSTANTIVE_CONTENT_LENGTH) return false;
	if (TEMPLATE_MARKER_RE.test(text)) return false;
	return true;
}

function stripMarkdownFormatting(content: string): string {
	return content
		.replace(/^#{1,6}\s+/gm, "")          // headings
		.replace(/```[\s\S]*?```/g, "")       // code blocks
		.replace(/`[^`\n]+`/g, "")            // inline code
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links → text
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
		.replace(/[*_~]{1,3}/g, "")           // bold/italic/strikethrough markers
		.replace(/^[\s]*[-*+]\s+/gm, "")       // unordered list markers
		.replace(/^[\s]*\d+\.\s+/gm, "")       // ordered list markers
		.replace(/^>\s*/gm, "")                // blockquotes
		.replace(/\n{2,}/g, "\n")             // collapse blank lines
		.replace(/\s+/g, " ");                 // normalize whitespace
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export interface CreateNormalChatToolsContext {
	userId: string;
	conversationId: string;
	turnId: string;
	recorder?: ToolCallRecorder;
}

export function createToolCallRecorder(
	initialEntries: ToolCallEntry[] = [],
): ToolCallRecorder {
	const entries = initialEntries;
	return {
		record(entry) {
			return recordToolCallEntry(entries, entry);
		},
		getEntries() {
			return [...entries];
		},
	};
}

export function recordToolCallEntry(
	entries: ToolCallEntry[],
	entry: ToolCallEntry,
): ToolCallEntry {
	const normalized: ToolCallEntry = {
		...entry,
		input: { ...entry.input },
		outputSummary: entry.outputSummary ?? null,
		metadata: entry.metadata ? { ...entry.metadata } : undefined,
	};
	entries.push(normalized);
	return normalized;
}

export function createNormalChatTools(ctx: CreateNormalChatToolsContext) {
	const recorder = ctx.recorder ?? createToolCallRecorder();
	const sameTurnProduceFileResults = new Map<
		string,
		Extract<FileProductionIntakeResult, { ok: true }>
	>();

	const tools = {
		research_web: tool({
			description:
				"Search and fetch current web sources, returning compact citation-ready evidence.",
			inputSchema: researchWebInputSchema,
			execute: async (
				input: ResearchWebInput,
				options: ToolExecutionOptions,
			) => {
				const safeInput = sanitizeResearchWebInput(input);
				try {
					const result = await researchWeb(safeInput);
					const modelPayload = compactResearchWebModelPayload(result);
					const candidates = createResearchWebCandidates(result);
					recorder.record({
						callId: options.toolCallId,
						name: "research_web",
						input: safeInput,
						status: "done",
						outputSummary: summarizeResearchWebResult(result),
						sourceType: "web",
						candidates,
						metadata: createResearchWebMetadata(result),
					});
					return modelPayload;
				} catch (error) {
					const modelPayload = {
						success: false as const,
						error:
							error instanceof Error ? error.message : "Web research failed",
					};
					recorder.record({
						callId: options.toolCallId,
						name: "research_web",
						input: safeInput,
						status: "done",
						outputSummary: modelPayload.error,
						sourceType: "web",
						candidates: [],
						metadata: {
							ok: false,
							evidenceReady: false,
							error: modelPayload.error,
						},
					});
					return modelPayload;
				}
			},
		}),
		memory_context: tool({
			description:
				"Retrieve bounded durable memory, named project-folder context, project continuity, persona memory, or account history for this conversation.",
			inputSchema: memoryContextInputSchema,
			execute: async (
				input: MemoryContextInput,
				options: ToolExecutionOptions,
			) => {
				const safeInput = sanitizeMemoryContextInput(input);
				try {
					const result = await getMemoryContext({
						userId: ctx.userId,
						conversationId: ctx.conversationId,
						...safeInput,
					});
					const candidates = compactMemoryContextCandidates(
						result,
						memoryContextCandidateLimit(input, result),
					);
					const modelPayload = compactMemoryContextModelPayload(
						result,
						candidates,
					);
					recorder.record({
						callId: options.toolCallId,
						name: "memory_context",
						input: safeInput,
						status: "done",
						outputSummary: summarizeMemoryContextResult(result),
						sourceType: "memory",
						candidates,
						metadata: createMemoryContextMetadata(result),
					});
					return modelPayload;
				} catch (error) {
					const modelPayload = {
						success: false as const,
						error:
							error instanceof Error
								? error.message
								: "Memory context lookup failed",
					};
					recorder.record({
						callId: options.toolCallId,
						name: "memory_context",
						input: safeInput,
						status: "done",
						outputSummary: modelPayload.error,
						sourceType: "memory",
						candidates: [],
						metadata: {
							ok: false,
							evidenceReady: false,
							error: modelPayload.error,
						},
					});
					return modelPayload;
				}
			},
		}),
		image_search: tool({
			description: "Search the web for image results for the current request.",
			inputSchema: imageSearchInputSchema,
			execute: async (
				input: ImageSearchInput,
				options: ToolExecutionOptions,
			) => {
				const safeInput = sanitizeImageSearchInput(input);
				try {
					const results = await searchImages(safeInput.query);
					const compactResults = compactImageSearchResults(results);
					const candidates = createImageSearchCandidates(compactResults);
					const modelPayload = {
						success: true as const,
						name: "image_search",
						sourceType: "web",
						message: `Found ${compactResults.length} ${compactResults.length === 1 ? "image" : "images"}`,
						results: compactResults,
					};
					recorder.record({
						callId: options.toolCallId,
						name: "image_search",
						input: safeInput,
						status: "done",
						outputSummary: `${modelPayload.message}.`,
						sourceType: "web",
						candidates,
						metadata: {
							ok: true,
							evidenceReady: true,
							resultCount: compactResults.length,
						},
					});
					return modelPayload;
				} catch (error) {
					const modelPayload = {
						success: false as const,
						error:
							error instanceof Error ? error.message : "Image search failed",
					};
					recorder.record({
						callId: options.toolCallId,
						name: "image_search",
						input: safeInput,
						status: "done",
						outputSummary: modelPayload.error,
						sourceType: "web",
						candidates: [],
						metadata: {
							ok: false,
							evidenceReady: false,
							error: modelPayload.error,
						},
					});
					return modelPayload;
				}
			},
		}),
		produce_file: tool({
			description:
				"Queue generation of downloadable files for the current conversation.",
			inputSchema: produceFileInputSchema,
			execute: async (
				input: ProduceFileInput,
				options: ToolExecutionOptions,
			) => {
				const parsedInput = produceFileInputSchema.safeParse(input);
				if (!parsedInput.success) {
					const safeInput = sanitizeUnsafeProduceFileInput(input);
					const error =
						parsedInput.error.issues[0]?.message ??
						"Invalid file production tool input";
					const result: Extract<FileProductionIntakeResult, { ok: false }> = {
						ok: false,
						status: 422,
						code: "invalid_tool_input",
						error,
					};
					const modelPayload = compactProduceFileModelPayload(result);
					recorder.record(
						createProduceFileToolCallEntry({
							callId: options.toolCallId,
							input: safeInput,
							result,
							outputSummary: summarizeProduceFileResult(modelPayload),
						}),
					);
					return modelPayload;
				}
				const normalized = normalizeProduceFileInput(parsedInput.data);
				if (!normalized.ok) {
					const safeInput = sanitizeUnsafeProduceFileInput(input);
					const result: Extract<FileProductionIntakeResult, { ok: false }> = {
						ok: false,
						status: 422,
						code: "invalid_tool_input",
						error: normalized.error,
					};
					const modelPayload = compactProduceFileModelPayload(result);
					recorder.record(
						createProduceFileToolCallEntry({
							callId: options.toolCallId,
							input: safeInput,
							result,
							outputSummary: summarizeProduceFileResult(modelPayload),
						}),
					);
					return modelPayload;
				}
				const normalizedInput = normalized.input;
				const safeInput = sanitizeProduceFileInput(normalizedInput);
				const intakeBody = {
					...normalizedInput,
					conversationId: ctx.conversationId,
					idempotencyKey: buildScopedIdempotencyKey({
						turnId: ctx.turnId,
						input: normalizedInput,
					}),
				};
				const sameTurnDedupeKey =
					buildSameTurnProduceFileDedupeKey(normalizedInput);
				const sameTurnResult =
					sameTurnProduceFileResults.get(sameTurnDedupeKey);
				if (sameTurnResult) {
					const result = { ...sameTurnResult, reused: true };
					const modelPayload = compactProduceFileModelPayload(result);
					recorder.record(
						createProduceFileToolCallEntry({
							callId: options.toolCallId,
							input: safeInput,
							result,
							outputSummary: summarizeProduceFileResult(modelPayload),
							metadata: { dedupedSameTurn: true },
						}),
					);
					return modelPayload;
				}

				try {
					const result = await submitFileProductionIntake({
						userId: ctx.userId,
						body: intakeBody,
					});
					if (result.ok) {
						sameTurnProduceFileResults.set(sameTurnDedupeKey, result);
					}
					const modelPayload = compactProduceFileModelPayload(result);
					recorder.record(
						createProduceFileToolCallEntry({
							callId: options.toolCallId,
							input: safeInput,
							result,
							outputSummary: summarizeProduceFileResult(modelPayload),
						}),
					);
					return modelPayload;
				} catch (error) {
					const modelPayload = {
						ok: false as const,
						status: 500,
						error: "File production intake failed",
					};
					recorder.record({
						callId: options.toolCallId,
						name: "produce_file",
						input: safeInput,
						status: "done",
						outputSummary: modelPayload.error,
						sourceType: "tool",
						metadata: {
							ok: false,
							evidenceReady: false,
							intakeStatus: 500,
							error: error instanceof Error ? error.message : String(error),
						},
					});
					return modelPayload;
				}
			},
		}),
	};

	return {
		tools,
		recorder,
		getToolCalls: () => recorder.getEntries(),
	};
}

function buildScopedIdempotencyKey(params: {
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

function buildSameTurnProduceFileDedupeKey(
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

function shortHash(value: unknown): string {
	return createHash("sha256")
		.update(stableStringify(value))
		.digest("hex")
		.slice(0, 12);
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

function truncateText(
	value: string | null | undefined,
	maxLength: number,
): string {
	const text = value ?? "";
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength).trimEnd()}...`;
}

function optionalScalarMetadata(
	value: string | number | boolean | null | undefined,
): string | number | boolean | null | undefined {
	return value === undefined ? undefined : value;
}

function sanitizeResearchWebInput(input: ResearchWebInput): ResearchWebInput {
	return {
		query: input.query,
		...(input.mode ? { mode: input.mode } : {}),
		...(input.freshness ? { freshness: input.freshness } : {}),
		...(input.sourcePolicy ? { sourcePolicy: input.sourcePolicy } : {}),
		...(input.maxSources ? { maxSources: input.maxSources } : {}),
		...(input.quoteRequired !== undefined
			? { quoteRequired: input.quoteRequired }
			: {}),
	};
}

function compactResearchWebModelPayload(result: ResearchResult) {
	const sources = result.sources.slice(0, 8).map((source) => ({
		id: source.id,
		title: truncateText(source.title, 180),
		url: truncateText(source.url, 500),
		provider: source.provider,
		authorityClass: source.authorityClass,
		authorityScore: source.authorityScore,
		publishedAt: source.publishedAt,
		updatedAt: source.updatedAt,
		...(source.snippet ? { snippet: truncateText(source.snippet, 500) } : {}),
		...(source.youtubeTranscript
			? { youtubeTranscript: source.youtubeTranscript }
			: {}),
	}));
	const evidence = result.evidence.slice(0, 12).map((item) => ({
		id: item.id,
		sourceId: item.sourceId,
		title: truncateText(item.title, 180),
		url: truncateText(item.url, 500),
		provider: item.provider,
		quote: truncateText(item.quote, 500),
		score: item.score,
	}));

	return {
		success: true as const,
		name: "research_web",
		sourceType: "web",
		query: result.query,
		queries: result.queries.slice(0, 6).map((query) => query.query),
		answerBrief: {
			instructions: result.answerBrief.instructions
				.slice(0, 8)
				.map((instruction) => truncateText(instruction, 240)),
			sourceCount: sources.length,
			evidenceCount: evidence.length,
		},
		answerBriefMarkdown: truncateText(result.answerBrief.markdown, 12000),
		sources,
		evidence,
		diagnostics: {
			mode: result.diagnostics.mode,
			freshness: result.diagnostics.freshness,
			sourcePolicy: result.diagnostics.sourcePolicy,
			plannedQueryCount: result.diagnostics.plannedQueryCount,
			fetchedSourceCount: result.diagnostics.fetchedSourceCount,
			fusedSourceCount: result.diagnostics.fusedSourceCount,
			selectedSourceCount: result.diagnostics.selectedSourceCount,
			openedPageCount: result.diagnostics.openedPageCount,
			evidenceCandidateCount: result.diagnostics.evidenceCandidateCount,
			exactEvidenceCandidateCount:
				result.diagnostics.exactEvidenceCandidateCount,
			reranked: result.diagnostics.reranked,
			sourceReranked: result.diagnostics.sourceReranked,
		},
		instructions:
			"Answer only from the returned answer brief, sources, and evidence. Use markdown links with returned source URLs, and never cite URLs outside the returned source list.",
	};
}

function createResearchWebCandidates(
	result: ResearchResult,
): ToolEvidenceCandidate[] {
	return result.sources.slice(0, 12).map((source) => ({
		id: source.id,
		title: truncateText(source.title, 180),
		url: source.url,
		snippet: source.snippet
			? truncateText(source.snippet, 500)
			: source.highlights[0]
				? truncateText(source.highlights[0], 500)
				: null,
		sourceType: "web",
		material: true,
		metadata: {
			provider: source.provider,
			authorityClass: source.authorityClass,
			authorityScore: source.authorityScore,
			providerRank: source.providerRank,
			...(optionalScalarMetadata(source.publishedAt)
				? { publishedAt: source.publishedAt }
				: {}),
			...(optionalScalarMetadata(source.updatedAt)
				? { updatedAt: source.updatedAt }
				: {}),
		},
	}));
}

function createResearchWebMetadata(
	result: ResearchResult,
): ToolCallEntry["metadata"] {
	return {
		ok: true,
		evidenceReady: true,
		sourceCount: result.sources.length,
		evidenceCount: result.evidence.length,
		mode: result.diagnostics.mode,
		freshness: result.diagnostics.freshness,
		sourcePolicy: result.diagnostics.sourcePolicy,
		selectedSourceCount: result.diagnostics.selectedSourceCount,
		openedPageCount: result.diagnostics.openedPageCount,
		reranked: result.diagnostics.reranked,
		sourceReranked: result.diagnostics.sourceReranked,
	};
}

function summarizeResearchWebResult(result: ResearchResult): string {
	const sourceLabel = result.sources.length === 1 ? "source" : "sources";
	const evidenceLabel =
		result.evidence.length === 1 ? "evidence snippet" : "evidence snippets";
	return `Web research returned ${result.sources.length} ${sourceLabel} and ${result.evidence.length} ${evidenceLabel}.`;
}

function sanitizeMemoryContextInput(
	input: MemoryContextInput,
): MemoryContextInput {
	return {
		...(input.mode ? { mode: input.mode } : {}),
		...(input.query ? { query: input.query } : {}),
		...(input.maxSiblings ? { maxSiblings: input.maxSiblings } : {}),
		...(input.siblingConversationId
			? { siblingConversationId: input.siblingConversationId }
			: {}),
		...(input.maxMessages ? { maxMessages: input.maxMessages } : {}),
		...(input.maxHistoryConversations
			? { maxHistoryConversations: input.maxHistoryConversations }
			: {}),
		...(input.historyConversationId
			? { historyConversationId: input.historyConversationId }
			: {}),
		...(input.selectedConversationId
			? { selectedConversationId: input.selectedConversationId }
			: {}),
		...(input.includeEvidenceCandidates !== undefined
			? { includeEvidenceCandidates: input.includeEvidenceCandidates }
			: {}),
	};
}

function memoryContextCandidateLimit(
	input: MemoryContextInput,
	result: MemoryContextResult,
): number {
	const isDetail = Boolean(
		input.siblingConversationId ||
			input.historyConversationId ||
			input.selectedConversationId,
	);
	if (result.mode === "history" && !isDetail) {
		return (
			input.maxHistoryConversations ??
			result.audit.appliedMaxHistoryConversations
		);
	}
	if (isDetail) {
		return (
			input.maxMessages ??
			("appliedMaxMessages" in result.audit
				? (result.audit.appliedMaxMessages ?? 6)
				: 6)
		);
	}
	if (result.mode === "project") {
		return input.maxSiblings ?? result.audit.appliedMaxSiblings;
	}
	return 5;
}

function compactMemoryContextCandidates(
	result: MemoryContextResult,
	limit: number,
): ToolEvidenceCandidate[] {
	return result.evidenceCandidates.slice(0, limit).map((candidate) => ({
		id: candidate.id,
		title: truncateText(candidate.title, 180),
		...(candidate.url ? { url: candidate.url } : {}),
		...(candidate.snippet
			? { snippet: truncateText(candidate.snippet, 500) }
			: {}),
		sourceType: "memory",
		...(candidate.selected !== undefined
			? { selected: candidate.selected }
			: {}),
		...(candidate.material !== undefined
			? { material: candidate.material }
			: {}),
		...(candidate.status ? { status: candidate.status } : {}),
		...(candidate.metadata
			? { metadata: sanitizeMetadata(candidate.metadata) }
			: {}),
	}));
}

function compactMemoryContextModelPayload(
	result: MemoryContextResult,
	evidenceCandidates: ToolEvidenceCandidate[],
) {
	return {
		success: true as const,
		name: "memory_context",
		sourceType: "memory",
		mode: result.mode,
		status: "status" in result ? result.status : undefined,
		hasProjectContext:
			"hasProjectContext" in result ? result.hasProjectContext : false,
		source: result.source,
		content: "content" in result ? result.content : undefined,
		project: "project" in result ? result.project : undefined,
		siblings: "siblings" in result ? result.siblings : [],
		reportSiblings: "reportSiblings" in result ? result.reportSiblings : [],
		selectedSibling:
			"selectedSibling" in result ? result.selectedSibling : null,
		omittedSiblingCount:
			"omittedSiblingCount" in result ? result.omittedSiblingCount : 0,
		conversations: "conversations" in result ? result.conversations : [],
		selectedConversation:
			"selectedConversation" in result ? result.selectedConversation : null,
		omittedConversationCount:
			"omittedConversationCount" in result
				? result.omittedConversationCount
				: 0,
		evidenceCandidates,
		audit: result.audit,
		instructions:
			"Use this as memory context only. Do not claim details that are not present in the returned payload.",
	};
}

function createMemoryContextMetadata(
	result: MemoryContextResult,
): ToolCallEntry["metadata"] {
	const metadata: NonNullable<ToolCallEntry["metadata"]> = {
		ok: true,
		evidenceReady: true,
		mode: result.mode,
		status: "status" in result ? result.status : null,
		hasProjectContext:
			"hasProjectContext" in result ? result.hasProjectContext : false,
		omittedSiblingCount:
			"omittedSiblingCount" in result ? result.omittedSiblingCount : 0,
		omittedConversationCount:
			"omittedConversationCount" in result
				? result.omittedConversationCount
				: 0,
	};
	for (const key of [
		"requestedMaxSiblings",
		"appliedMaxSiblings",
		"requestedMaxHistoryConversations",
		"appliedMaxHistoryConversations",
		"requestedMaxMessages",
		"appliedMaxMessages",
	] as const) {
		if (!(key in result.audit)) continue;
		const value = result.audit[key as keyof typeof result.audit];
		if (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean" ||
			value === null
		) {
			metadata[key] = value;
		}
	}
	const selectedConversation =
		"selectedConversation" in result ? result.selectedConversation : null;
	if (selectedConversation) {
		metadata.omittedMessageCount = selectedConversation.omittedMessageCount;
	}
	const selectedSibling =
		"selectedSibling" in result ? result.selectedSibling : null;
	if (selectedSibling) {
		metadata.omittedMessageCount = selectedSibling.omittedMessageCount;
	}
	return metadata;
}

function sanitizeMetadata(
	metadata: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> {
	return Object.fromEntries(
		Object.entries(metadata).filter(
			([, value]) =>
				["string", "number", "boolean"].includes(typeof value) ||
				value === null,
		),
	);
}

function summarizeMemoryContextResult(result: MemoryContextResult): string {
	if (result.mode === "persona") {
		return `Persona memory status: ${result.status}`;
	}
	if (result.mode === "history") {
		return `History memory status: ${result.status}; conversations: ${result.conversations.length}`;
	}
	if (result.hasProjectContext) {
		return `Project memory found: ${result.project?.name ?? "Project"}`;
	}
	return "No project memory found for this conversation.";
}

function sanitizeImageSearchInput(input: ImageSearchInput): ImageSearchInput {
	return { query: input.query.trim() };
}

type CompactImageSearchResult = {
	id: string;
	url: string;
	title: string;
	source: string;
	thumbnail?: string;
	width?: number;
	height?: number;
};

function compactImageSearchResults(
	results: ImageSearchResult[],
): CompactImageSearchResult[] {
	return results.slice(0, 8).map((result, index) => {
		const url = truncateText(result.url, 500);
		const source = truncateText(result.source, 180);
		return {
			id: imageSearchResultId(result, index),
			url,
			title: truncateText(
				result.title || result.url || `Image ${index + 1}`,
				180,
			),
			source,
			...(result.thumbnail
				? { thumbnail: truncateText(result.thumbnail, 500) }
				: {}),
			...(typeof result.width === "number" ? { width: result.width } : {}),
			...(typeof result.height === "number" ? { height: result.height } : {}),
		};
	});
}

function imageSearchResultId(result: ImageSearchResult, index: number): string {
	const stableSource =
		result.url || `${result.title}:${result.source}:${index}`;
	return `image-search:${shortHash(stableSource)}`;
}

function createImageSearchCandidates(
	results: CompactImageSearchResult[],
): ToolEvidenceCandidate[] {
	return results.map((result) => ({
		id: result.id,
		title: result.title,
		url: result.url,
		snippet: result.source,
		sourceType: "web",
		metadata: {
			source: result.source,
			...(result.thumbnail ? { thumbnail: result.thumbnail } : {}),
			...(typeof result.width === "number" ? { width: result.width } : {}),
			...(typeof result.height === "number" ? { height: result.height } : {}),
		},
	}));
}

function sanitizeProduceFileInput(
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

function sanitizeUnsafeProduceFileInput(input: unknown): SafeProduceFileInput {
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
		safe.outputs = input.outputs
			.filter(isRecord)
			.map((output) => ({
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

function compactProduceFileModelPayload(result: FileProductionIntakeResult) {
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

function summarizeProduceFileResult(
	payload: ReturnType<typeof compactProduceFileModelPayload>,
): string {
	if (payload.ok) {
		return `File production job ${payload.jobId} queued with status ${payload.jobStatus}.`;
	}
	return payload.jobId
		? `File production intake failed for job ${payload.jobId}: ${payload.error}`
		: `File production intake failed: ${payload.error}`;
}

function createProduceFileToolCallEntry(params: {
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
