import { type ToolExecutionOptions, tool } from "ai";
import { z } from "zod";

import type { FileProductionIntakeResult } from "$lib/server/services/file-production";
import { submitFileProductionIntake } from "$lib/server/services/file-production";
import { searchImages } from "$lib/server/services/image-search";
import { getMemoryContext } from "$lib/server/services/memory-context";
import { researchWeb } from "$lib/server/services/web-research";
import {
	compactImageSearchResults,
	createImageSearchCandidates,
	imageSearchInputSchema,
	sanitizeImageSearchInput,
} from "./image-search";

import {
	compactMemoryContextCandidates,
	compactMemoryContextModelPayload,
	createMemoryContextMetadata,
	memoryContextCandidateLimit,
	memoryContextInputSchema,
	sanitizeMemoryContextInput,
	summarizeMemoryContextResult,
} from "./memory-context";

import {
	buildSameTurnProduceFileDedupeKey,
	buildScopedIdempotencyKey,
	compactProduceFileModelPayload,
	createProduceFileToolCallEntry,
	normalizeProduceFileInput,
	produceFileInputSchema,
	sanitizeProduceFileInput,
	sanitizeUnsafeProduceFileInput,
	summarizeProduceFileResult,
} from "./produce-file";

import {
	compactResearchWebModelPayload,
	createResearchWebCandidates,
	createResearchWebMetadata,
	researchWebInputSchema,
	sanitizeResearchWebInput,
	summarizeResearchWebResult,
} from "./research-web";

import {
	createToolCallRecorder,
	TOOL_TIMEOUTS_MS,
	withTimeout,
} from "./shared";

// ── Public re-exports ──────────────────────────────────────────

export {
	isProduceFileRequest,
	shouldForceProduceFileTool,
} from "./produce-file";
export type { ToolCallRecorder } from "./shared";
export { createToolCallRecorder, recordToolCallEntry } from "./shared";

// ── Context ────────────────────────────────────────────────────

export interface CreateNormalChatToolsContext {
	userId: string;
	conversationId: string;
	turnId: string;
	recorder?: ToolCallRecorder;
	language?: "en" | "hu";
}

// ── I18n ───────────────────────────────────────────────────────

type ToolI18n = Record<string, { description: string; errorPrefix: string }>;

const TOOL_I18N: Record<"en" | "hu", ToolI18n> = {
	en: {
		research_web: {
			description:
				"Search and fetch current web sources, returning compact citation-ready evidence.",
			errorPrefix: "Web research failed",
		},
		memory_context: {
			description:
				"Retrieve bounded durable memory, named project-folder context, project continuity, persona memory, or account history for this conversation.",
			errorPrefix: "Memory context lookup failed",
		},
		image_search: {
			description: "Search the web for image results for the current request.",
			errorPrefix: "Image search failed",
		},
		produce_file: {
			description:
				"Queue generation of downloadable files for the current conversation.",
			errorPrefix: "File production intake failed",
		},
	},
	hu: {
		research_web: {
			description:
				"Keresés az interneten aktuális források után, tömör, hivatkozásra kész bizonyítékokkal.",
			errorPrefix: "A webes kutatás sikertelen",
		},
		memory_context: {
			description:
				"Tartós memória, projektmappa-kontextus, folytonosság, személyre szabott memória vagy fiókelőzmények lekérése ehhez a beszélgetéshez.",
			errorPrefix: "A memória kontextus lekérése sikertelen",
		},
		image_search: {
			description: "Képkeresés az interneten az aktuális kéréshez.",
			errorPrefix: "A képkeresés sikertelen",
		},
		produce_file: {
			description:
				"Letölthető fájlok generálásának ütemezése az aktuális beszélgetéshez.",
			errorPrefix: "A fájl-előállítás sikertelen",
		},
	},
};

// ── Tool factory ───────────────────────────────────────────────

export function createNormalChatTools(ctx: CreateNormalChatToolsContext) {
	const recorder = ctx.recorder ?? createToolCallRecorder();
	const lang = ctx.language ?? "en";
	const i18n = TOOL_I18N[lang];
	const sameTurnProduceFileResults = new Map<
		string,
		Extract<FileProductionIntakeResult, { ok: true }>
	>();

	const tools = {
		research_web: tool({
			description: i18n.research_web.description,
			inputSchema: researchWebInputSchema,
			execute: async (
				input: ReturnType<typeof researchWebInputSchema._output>,
				options: ToolExecutionOptions,
			) => {
				const safeInput = sanitizeResearchWebInput(input);
				try {
					const result = await withTimeout(
						researchWeb(safeInput, {
							config: { webResearchSearxngLanguage: ctx.language ?? "en" },
						}),
						TOOL_TIMEOUTS_MS.research_web,
						"research_web",
					);
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
							error instanceof Error
								? error.message
								: i18n.research_web.errorPrefix,
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
			description: i18n.memory_context.description,
			inputSchema: memoryContextInputSchema,
			execute: async (
				input: ReturnType<typeof memoryContextInputSchema._output>,
				options: ToolExecutionOptions,
			) => {
				const safeInput = sanitizeMemoryContextInput(input);
				try {
					const result = await withTimeout(
						getMemoryContext({
							userId: ctx.userId,
							conversationId: ctx.conversationId,
							...safeInput,
						}),
						TOOL_TIMEOUTS_MS.memory_context,
						"memory_context",
					);
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
								: i18n.memory_context.errorPrefix,
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
			description: i18n.image_search.description,
			inputSchema: imageSearchInputSchema,
			execute: async (
				input: ReturnType<typeof imageSearchInputSchema._output>,
				options: ToolExecutionOptions,
			) => {
				const safeInput = sanitizeImageSearchInput(input);
				try {
					const results = await withTimeout(
						searchImages(safeInput.query),
						TOOL_TIMEOUTS_MS.image_search,
						"image_search",
					);
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
							error instanceof Error
								? error.message
								: i18n.image_search.errorPrefix,
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
			description: i18n.produce_file.description,
			inputSchema: produceFileInputSchema,
			execute: async (
				input: ReturnType<typeof produceFileInputSchema._output>,
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
					const result = await withTimeout(
						submitFileProductionIntake({
							userId: ctx.userId,
							body: intakeBody,
						}),
						TOOL_TIMEOUTS_MS.produce_file,
						"produce_file",
					);
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
						error: i18n.produce_file.errorPrefix,
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
		done: tool({
			description:
				"Call this when the task is fully complete and you have nothing more to add. Include a brief summary of what was accomplished. Calling this ends the agent loop — do not call it until you are truly finished.",
			inputSchema: z.object({
				summary: z
					.string()
					.describe("Brief summary of what was accomplished in this turn"),
			}),
		}),
	};

	return {
		tools,
		recorder,
		getToolCalls: () => recorder.getEntries(),
	};
}
