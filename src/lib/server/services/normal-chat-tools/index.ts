import { type ToolExecutionOptions, tool } from "ai";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "$lib/server/db";
import { artifacts } from "$lib/server/db/schema";
import type { FileProductionIntakeResult } from "$lib/server/services/file-production";
import { submitFileProductionIntake } from "$lib/server/services/file-production";
import type { ReasoningDepthWebSourceBudget } from "$lib/server/services/chat-turn/reasoning-depth-effort";
import { searchImages } from "$lib/server/services/image-search";
import { getMemoryContext } from "$lib/server/services/memory-context";
import {
	buildGroundedWebModelPayload,
	createGroundedWebCandidates,
	createGroundedWebMetadata,
	summarizeGroundedWebResult,
} from "$lib/server/services/web-grounding";
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
	applyTextPatches,
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
	buildReadGeneratedFileModelPayload,
	extractContentFromMemoryText,
	readGeneratedFileContent,
	readGeneratedFileInputSchema,
	sanitizeReadGeneratedFileInput,
	summarizeReadGeneratedFileResult,
	type ReadGeneratedFileResult,
} from "./read-generated-file";

import {
	researchWebInputSchema,
	sanitizeResearchWebInput,
} from "./research-web";

import {
	createToolCallRecorder,
	executeToolWithEnvelope,
	modelSafeToolError,
	TOOL_TIMEOUTS_MS,
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
	webSourceBudget?: ReasoningDepthWebSourceBudget;
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
		read_generated_file: {
			description:
				"Read the full content of a previously generated file by filename or title, so you can review it before making surgical edits.",
			errorPrefix: "Read generated file failed",
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
		read_generated_file: {
			description:
				"Egy korábban generált fájl teljes tartalmának beolvasása fájlnév vagy cím alapján, hogy ellenőrizhesd a tartalmát a módosítások előtt.",
			errorPrefix: "A fájl beolvasása sikertelen",
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
				const safeInput = applyResearchWebSourceBudget(
					sanitizeResearchWebInput(input),
					ctx.webSourceBudget,
				);
				return executeToolWithEnvelope({
					toolName: "research_web",
					timeoutMs: TOOL_TIMEOUTS_MS.research_web,
					options,
					recorder,
					run: async (abortSignal) => {
						const result = await researchWeb(safeInput, {
							signal: abortSignal,
						});
						const modelPayload = buildGroundedWebModelPayload(result);
						const candidates = createGroundedWebCandidates(result);
						return {
							modelPayload,
							entry: {
								callId: options.toolCallId,
								name: "research_web",
								input: safeInput,
								status: "done",
								outputSummary: summarizeGroundedWebResult(result),
								sourceType: "web",
								candidates,
								metadata: createGroundedWebMetadata(result),
							},
						};
					},
					onError: (error) => {
						const message = modelSafeToolError(
							error,
							i18n.research_web.errorPrefix,
						);
						const modelPayload = {
							success: false as const,
							error: message,
						};
						return {
							modelPayload,
							entry: {
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
							},
						};
					},
				});
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
				return executeToolWithEnvelope({
					toolName: "memory_context",
					timeoutMs: TOOL_TIMEOUTS_MS.memory_context,
					options,
					recorder,
					run: async () => {
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
						return {
							modelPayload,
							entry: {
								callId: options.toolCallId,
								name: "memory_context",
								input: safeInput,
								status: "done",
								outputSummary: summarizeMemoryContextResult(result),
								sourceType: "memory",
								candidates,
								metadata: createMemoryContextMetadata(result),
							},
						};
					},
					onError: (error) => {
						const message = modelSafeToolError(
							error,
							i18n.memory_context.errorPrefix,
						);
						const modelPayload = {
							success: false as const,
							error: message,
						};
						return {
							modelPayload,
							entry: {
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
							},
						};
					},
				});
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
				return executeToolWithEnvelope({
					toolName: "image_search",
					timeoutMs: TOOL_TIMEOUTS_MS.image_search,
					options,
					recorder,
					run: async () => {
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
						return {
							modelPayload,
							entry: {
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
							},
						};
					},
					onError: (error) => {
						const message = modelSafeToolError(
							error,
							i18n.image_search.errorPrefix,
						);
						const modelPayload = {
							success: false as const,
							error: message,
						};
						return {
							modelPayload,
							entry: {
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
							},
						};
					},
				});
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

				// Resolve patches: if the model provided surgical edits instead of full content,
				// fetch the previous version and apply patches to reconstruct the full file.
				if (
					normalizedInput.patches &&
					normalizedInput.patches.length > 0 &&
					normalizedInput.sourceMode === "program" &&
					normalizedInput.program
				) {
					const previousContent = await getPreviousGeneratedFileContent(
						ctx.userId,
						ctx.conversationId,
						normalizedInput.requestTitle,
					);
					if (previousContent === null) {
						const error =
							"No previous version of this file could be found. Use content, markdown, or text to create the initial version instead of patches.";
						const result: Extract<
							FileProductionIntakeResult,
							{ ok: false }
						> = {
							ok: false,
							status: 422,
							code: "no_previous_version_for_patches",
							error,
						};
						const safeInput =
							sanitizeProduceFileInput(normalizedInput);
						const modelPayload =
							compactProduceFileModelPayload(result);
						recorder.record(
							createProduceFileToolCallEntry({
								callId: options.toolCallId,
								input: safeInput,
								result,
								outputSummary:
									summarizeProduceFileResult(modelPayload),
							}),
						);
						return modelPayload;
					}
					const patchResult = applyTextPatches(
						previousContent,
						normalizedInput.patches,
					);
					if (!patchResult.ok) {
						const result: Extract<
							FileProductionIntakeResult,
							{ ok: false }
						> = {
							ok: false,
							status: 422,
							code: "patch_failed",
							error: patchResult.error,
						};
						const safeInput =
							sanitizeProduceFileInput(normalizedInput);
						const modelPayload =
							compactProduceFileModelPayload(result);
						recorder.record(
							createProduceFileToolCallEntry({
								callId: options.toolCallId,
								input: safeInput,
								result,
								outputSummary:
									summarizeProduceFileResult(modelPayload),
							}),
						);
						return modelPayload;
					}
					normalizedInput.program.sourceCode =
						buildResolvedProgramSource(
							normalizedInput.program.filename ??
								"generated-file.txt",
							patchResult.resolvedText,
						);
				}
				const { patches: _patches, ...intakeNormalizedInput } =
					normalizedInput;

				const safeInput = sanitizeProduceFileInput(normalizedInput);
				const intakeBody = {
					...intakeNormalizedInput,
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

				return executeToolWithEnvelope({
					toolName: "produce_file",
					timeoutMs: TOOL_TIMEOUTS_MS.produce_file,
					options,
					recorder,
					run: async (abortSignal) => {
						const result = await submitFileProductionIntake({
							userId: ctx.userId,
							body: intakeBody,
							signal: abortSignal,
						});
						if (result.ok) {
							sameTurnProduceFileResults.set(sameTurnDedupeKey, result);
						}
						const modelPayload = compactProduceFileModelPayload(result);
						return {
							modelPayload,
							entry: createProduceFileToolCallEntry({
								callId: options.toolCallId,
								input: safeInput,
								result,
								outputSummary: summarizeProduceFileResult(modelPayload),
							}),
						};
					},
					onError: (error) => {
						const safeError = modelSafeToolError(
							error,
							i18n.produce_file.errorPrefix,
						);
						const modelPayload = {
							ok: false as const,
							status: 500,
							error: i18n.produce_file.errorPrefix,
						};
						return {
							modelPayload,
							entry: {
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
									error: safeError,
								},
							},
						};
					},
				});
			},
		}),
		read_generated_file: tool({
			description: i18n.read_generated_file.description,
			inputSchema: readGeneratedFileInputSchema,
			execute: async (
				input: ReturnType<typeof readGeneratedFileInputSchema._output>,
				options: ToolExecutionOptions,
			) => {
				const parsedInput = readGeneratedFileInputSchema.safeParse(input);
				if (!parsedInput.success) {
					const error = parsedInput.error.issues[0]?.message ?? "Invalid input";
					return {
						found: false,
						error,
					};
				}
				const safeInput = sanitizeReadGeneratedFileInput(parsedInput.data);
				return executeToolWithEnvelope({
					toolName: "read_generated_file",
					timeoutMs: TOOL_TIMEOUTS_MS.read_generated_file,
					options,
					recorder,
					run: async () => {
						const result = await readGeneratedFileContent({
							userId: ctx.userId,
							conversationId: ctx.conversationId,
							filename: parsedInput.data.filename ?? null,
							requestTitle: parsedInput.data.requestTitle ?? null,
						});
						const modelPayload =
							buildReadGeneratedFileModelPayload(result);
						return {
							modelPayload,
							entry: {
								callId: options.toolCallId,
								name: "read_generated_file",
								input: safeInput,
								status: "done",
								outputSummary:
									summarizeReadGeneratedFileResult(result),
								sourceType: "tool",
								metadata: {
									ok: !result.notFound,
									evidenceReady: false,
									found: !result.notFound,
								},
							},
						};
					},
					onError: (error) => {
						const message = modelSafeToolError(
							error,
							i18n.read_generated_file.errorPrefix,
						);
						return {
							modelPayload: {
								found: false,
								error: message,
							},
							entry: {
								callId: options.toolCallId,
								name: "read_generated_file",
								input: safeInput,
								status: "done",
								outputSummary: message,
								sourceType: "tool",
								metadata: {
									ok: false,
									evidenceReady: false,
									found: false,
									error: message,
								},
							},
						};
					},
				});
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

function applyResearchWebSourceBudget(
	input: ReturnType<typeof sanitizeResearchWebInput>,
	budget: ReasoningDepthWebSourceBudget | undefined,
): ReturnType<typeof sanitizeResearchWebInput> {
	if (!budget) return input;
	const maxSources = Math.max(1, Math.min(12, Math.floor(budget.maxSources)));
	if (input.maxSources === undefined) {
		return { ...input, maxSources };
	}
	return {
		...input,
		maxSources: Math.min(input.maxSources, maxSources),
	};
}

async function getPreviousGeneratedFileContent(
	userId: string,
	conversationId: string,
	requestTitle: string,
): Promise<string | null> {
	const rows = await db
		.select({
			contentText: artifacts.contentText,
		})
		.from(artifacts)
		.where(
			and(
				eq(artifacts.userId, userId),
				eq(artifacts.conversationId, conversationId),
				eq(artifacts.type, "generated_output"),
			),
		)
		.orderBy(desc(artifacts.updatedAt))
		.limit(24);

	const normalizedTitle = requestTitle.trim().toLowerCase();
	for (const row of rows) {
		if (!row.contentText) continue;
		if (row.contentText.toLowerCase().includes(normalizedTitle)) {
			const extracted = extractContentFromMemoryText(row.contentText);
			return extracted ?? row.contentText;
		}
	}

	return null;
}

function buildResolvedProgramSource(
	filename: string,
	content: string,
): string {
	const jsonFilename = JSON.stringify(filename);
	const jsonContent = JSON.stringify(content);
	return [
		"from pathlib import Path",
		"output = Path('/output')",
		"output.mkdir(parents=True, exist_ok=True)",
		`(output / ${jsonFilename}).write_text(${jsonContent}, encoding='utf-8')`,
		"",
	].join("\n");
}
