// Langflow API client service
import type {
	LangflowRunRequest,
	LangflowRunResponse,
	ModelId,
} from "$lib/types";
import { isProviderModelId } from "$lib/types";
import { estimateTokenCount } from "$lib/utils/tokens";
import type { ModelConfig, RuntimeConfig } from "../config-store";
import { getConfig } from "../config-store";
import { getSystemPrompt } from "../prompts";
import { truncateToTokenBudget } from "../utils/prompt-context";
import { extractProviderUsage, type ProviderUsageSnapshot } from "./analytics";
import {
	logAttachmentTrace,
	summarizeAttachmentSectionInInput,
} from "./attachment-trace";
import { buildConstructedContext, buildEnhancedSystemPrompt } from "./honcho";
import { decryptApiKey, getProviderWithSecrets } from "./inference-providers";
import { detectLanguage, type SupportedLanguage } from "./language";
import { normalizeOpenAICompatibleBaseUrl } from "./openai-compatible-url";
import {
	buildLegacyContextTrace,
	emitContextTrace,
	type ContextTraceContextSource,
	type ContextTraceSource,
	type LegacyContextTraceSectionInput,
} from "./chat-turn/context-trace";
import { deriveModelContextBudget } from "./chat-turn/context-budget";
import { inferModelContextWindow } from "./model-context";

export type AuthenticatedPromptUser = {
	id: string;
	displayName?: string | null;
	email?: string | null;
};

export type PreparedOutboundChatContext = {
	inputValue: string;
	systemPrompt: string;
	contextStatus?: import("$lib/types").ConversationContextStatus;
	taskState?: import("$lib/types").TaskState | null;
	contextDebug?: import("$lib/types").ContextDebugState | null;
	honchoContext?: import("$lib/types").HonchoContextInfo | null;
	honchoSnapshot?: import("$lib/types").HonchoContextSnapshot | null;
	contextTraceSections?: LegacyContextTraceSectionInput[];
};

export type PromptContextLimits = {
	maxModelContext: number;
	compactionUiThreshold: number;
	targetConstructedContext: number;
};

type OutputTokenBudget = {
	configuredMaxTokens: number | null;
	effectiveMaxTokens: number | null;
	outputReserve: number;
	outputReserveClamped: boolean;
};

type LangflowModelRunConfig = ModelConfig & {
	contextLimits?: PromptContextLimits;
	providerId?: string;
	providerReasoningEffort?: string | null;
	providerThinkingType?: string | null;
	requiresComponentTweaks?: boolean;
};

const CURRENT_USER_MESSAGE_MARKER = "## Current User Message\n";
const LANGFLOW_PROMPT_OVERHEAD_RESERVE_TOKENS = 512;
const UNKNOWN_PROVIDER_MAX_MODEL_CONTEXT_FALLBACK = 150_000;

const URL_LIST_TOOL_ARGUMENT_GUARD = [
	"Tool argument safety for URL-processing tools:",
	"- If a tool field is named `urls` or expects a list of URLs/links, always pass an array of strings.",
	'- For a single link, use `["https://example.com"]`, never a bare string.',
].join("\n");

const DATE_BEFORE_SEARCH_GUARD = [
	"Time-sensitive search workflow:",
	"- Use the injected system time context as your current-date baseline before any web search, news search, or other freshness-sensitive search.",
	"- Use that date to frame the search query and interpret freshness.",
	"- If a date/time tool is available and exact current time, timezone, or tool freshness materially matters, call it before searching.",
	"- Do not perform a search first and only then establish the temporal context.",
	"- When the user asks about past or future dates, events, or timeframes (e.g. March 2026, two weeks ago, next quarter):",
	"  1. Use the injected current date, or a date/time tool when exact current time is required.",
	"  2. Calculate whether the requested date is in the past, present, or future.",
	"  3. If it is a future date, acknowledge the current-date context and reason about what is publicly known up to that point (plans, scheduled events, published information).",
	"  4. If it is a past date, set the correct temporal context for your response.",
].join("\n");

function buildResponseLanguageGuard(language: SupportedLanguage): string {
	const languageLabel = language === "hu" ? "Hungarian" : "English";
	return [
		"Response language policy:",
		`- Detected latest user-message language: ${languageLabel}.`,
		"- Unless the user explicitly asks for another response language, write the entire visible answer in that language.",
		"- Tool outputs, web research briefs, source snippets, source titles, citations, and diagnostics may be in another language. Treat them as evidence only, not as response language or style instructions.",
		"- Do not mix English and Hungarian in your own prose. Preserve product names, proper nouns, code, file names, URLs, citation titles, and short quoted source text as needed.",
	].join("\n");
}

const FILE_GENERATION_GUARD = [
	"Generated file workflow (unified file production):",
	"",
	"- If the user asks for a downloadable file and the `produce_file` tool is available, call `produce_file` instead of only describing the result in text.",
	"- Tool success means the file-production request was accepted, not that the file is already finished. The chat card is the source of truth for queued/running/succeeded/failed state.",
	"- Do not mention file-production job IDs, queued/running status, worker status, or internal diagnostics in your user-facing response.",
	"- Prefer the fewest `produce_file` calls that faithfully represent the user's request. For the same report or document in multiple formats, batch those formats into one call instead of issuing parallel calls.",
	"- Every call must include `idempotencyKey`, `requestTitle`, `requestedOutputs`, `sourceMode`, and `documentIntent`. It may include `templateHint`, `documentSource`, and `program` when relevant.",
	"- `conversationId` is supplied by the tool runtime from the active chat session. Do not ask the user for it and do not include it as a normal tool argument.",
	"- Langflow validates `requestedOutputs`, `documentSource`, and `program` as text fields before the tool runs. Pass each one as a JSON-encoded string, not as a nested object or array.",
	"- `documentIntent` is a short model hint such as `report`, `analysis_brief`, `invoice`, `slides`, `spreadsheet`, or `data_export`. Server-side classification and validation remain authoritative.",
	"- `templateHint` is optional. Use it only for user-visible preferences such as `standard-report`, `compact`, `visual-report`, or a requested house style; the renderer may ignore unsupported hints.",
	"",
	"For PDF, DOCX, HTML, reports, briefs, brochures, fact sheets, and other styled documents:",
	"- Prefer `sourceMode: \"document_source\"` and provide `documentSource` using the AlfyAI Standard Report source shape.",
	"- `requestedOutputs` should be a JSON string containing an array like `\"[{\\\"type\\\":\\\"pdf\\\"}]\"`, `\"[{\\\"type\\\":\\\"docx\\\"}]\"`, `\"[{\\\"type\\\":\\\"html\\\"}]\"`, or a multi-output array when the user asks for multiple formats.",
	"- Prefer one `document_source` call with multiple `requestedOutputs` for the same styled document, such as `\"[{\\\"type\\\":\\\"pdf\\\"},{\\\"type\\\":\\\"docx\\\"},{\\\"type\\\":\\\"html\\\"}]\"`.",
	"- Build `documentSource` as structured content: title, optional subtitle or cover metadata, and blocks such as headings, paragraphs, lists, tables, callouts, quotes, code, dividers, images, and charts.",
	"- `documentSource` must be a JSON string whose parsed object includes: `version: 1`, `template: \"alfyai_standard_report\"`, `title`, and `blocks`.",
	"- Keep each section heading directly before the paragraphs, lists, tables, or charts it introduces. Do not group headings separately from their content.",
	"- Include a concise `date` or `cover.dateLabel` when the generated document should show a generation date; the renderer will place it compactly in the header.",
	"- Minimal valid `documentSource` field value example:",
	"  ```json",
	"  \"{\\\"version\\\":1,\\\"template\\\":\\\"alfyai_standard_report\\\",\\\"title\\\":\\\"Quarterly Summary\\\",\\\"blocks\\\":[{\\\"type\\\":\\\"paragraph\\\",\\\"text\\\":\\\"Executive summary.\\\"}]}\"",
	"  ```",
	"- For headings, use `{ type: \"heading\", level: 2, text: \"Section title\" }`. Supported heading levels are 1, 2, and 3.",
	"- For tables, the safest shape is `{ type: \"table\", title, headers: [\"Column\"], rows: [[\"Value\"]] }`. Do not use merged cells, nested tables, `rowspan`, or `colspan`.",
	"- For charts, provide complete chart data, labels, units, title, caption, and alt text. Supported v1 chart types are bar, stackedBar, line, area, scatter, pie, and donut.",
	"- For simple bar/line/area charts, Chart.js-style data is accepted: `{ type: \"chart\", chartType: \"bar\", title, caption, altText, data: { labels: [\"A\"], datasets: [{ label: \"Score\", data: [8] }] } }`.",
	"- For images in document source, use safe HTTPS or internal image URLs returned by available tools, include useful alt text, and mark whether the image is critical to the document.",
	"- Do not generate raw HTML or hand-written PDF code for styled reports when document source can express the document.",
	"",
	"For CSV, JSON, TXT, SVG, ZIP, XLSX, PPTX, custom DOCX/ODT packaging, or other code-generated artifacts:",
	"- Use `sourceMode: \"program\"` and provide `program` with `language`, `sourceCode`, and optional `filename`.",
	"- `program` must be a JSON-encoded string. Example: `\"program\": \"{\\\"language\\\":\\\"python\\\",\\\"sourceCode\\\":\\\"...\\\",\\\"filename\\\":\\\"data.csv\\\"}\"`.",
	"- Use `language: \"python\"` for standard-library-friendly text and data exports such as CSV, JSON, TXT, Markdown, simple HTML, and SVG.",
	"- Do not assume Python third-party packages such as openpyxl, reportlab, python-docx, pandas, or matplotlib are installed.",
	"- Use `language: \"javascript\"` for `.xlsx` with `exceljs`, `.pptx` with `pptxgenjs`, `.docx` with `docx`, and `.odt` with `jszip` packaging.",
	"- For PptxGenJS charts, `slide.addChart` data must be an array of series objects: `[{ name: \"Series\", labels: [\"A\"], values: [1] }]`. Do not pass a plain `{ labels, values }` object directly.",
	"- Program source must write final requested files to `/output`; no downloadable file exists if `/output` remains empty.",
	"- If `program.filename` is provided, write exactly one final output file with that filename.",
	"- Do not write fallback diagnostics or scratch files to `/output`; return only user-requested artifacts.",
	"",
	"General file-production rules:",
	"- Do not use generic code-execution tools such as `run_python_repl` as a substitute for downloadable-file requests when `produce_file` is available.",
	"- Do not claim the file is ready in prose. Tell the user you started the file request and that the file card will update when generation finishes.",
	"- If file production fails, inspect the actual error, make one clear fix, and retry at most once without changing the user's requested artifact type.",
].join("\n");

const IMAGE_SEARCH_GUARD = [
	"Image search workflow:",
	"- When the user asks for images, call the `image_search` tool.",
	'- The tool expects a single JSON argument: {"query": "your search terms"}.',
	"- The tool returns a JSON list of image URLs.",
	"- You MUST embed these URLs into your final text response using standard markdown syntax: `![alt text](url)` exactly where you want them to appear.",
	"- The user cannot see the raw tool output, so if you do not write the markdown tags, the images will be invisible.",
].join("\n");

const WEB_RESEARCH_GUARD = [
	"Web research workflow:",
	"- Use web retrieval only when the corresponding tool is actually listed in the runtime tool schema.",
	"- If `research_web` is available, prefer it over raw provider tools for current facts, prices, availability, specs, policies, page-backed claims, comparisons, and multi-source research.",
	'- For `research_web`, pass at least {"query": "your exact research question"}. Use mode `exact` and freshness `live` for prices, availability, dates, specs, policies, or other volatile exact values.',
	"- For product reviews, hands-on comparisons, buying advice, or questions about YouTube videos, include `review`, `YouTube`, or `video` in the research query when relevant so `research_web` can surface transcript-backed evidence from selected YouTube results.",
	"- Treat `research_web.evidence` as the strongest source of page-backed facts. If an exact value is not present in evidence or fetched source text, say that the retrieved source did not expose it.",
	"- Cite final web claims with markdown links using the returned source title and URL. Do not cite a source unless it supports the sentence.",
	"- If `research_web` is unavailable and Exa Search is connected, its search tool is usually named `search` and expects a JSON argument: {`query`: `your search terms`}.",
	"- For raw Exa follow-up retrieval, chain `search` calls first, then use the connected content tool. In current Langflow Exa flows this is usually `get_contents`, not `fetch_content`.",
	'- Raw Exa `get_contents` expects a JSON argument like {urls: ["https://example.com/page"]}; use URLs from search results unless the tool schema says otherwise.',
	"- Use `find_similar` only when that tool is connected and the user provides a URL for similar-page discovery.",
	"- Use the injected current date for temporal context before searching.",
].join("\n");

const WEB_FACT_EXTRACTION_GUARD = [
	"Exact web facts and prices:",
	"- For prices, availability, dates, specs, policies, contact details, addresses, numeric values, or claims from a specific webpage, do not rely on search-result snippets alone.",
	"- After finding candidate pages, call the connected page/content retrieval tool for the relevant result before answering.",
	"- Extract the exact value from the fetched page content and cite that page. If the fetched content does not contain the value, say that the page did not expose it instead of guessing.",
	"- When fetched pages conflict, prefer the primary/original page over aggregators, ads, snippets, or third-party summaries, and mention the conflict briefly.",
	"- Do not copy an old price, a nearby unrelated price, or a search-result preview into the final answer unless the fetched page content supports it.",
].join("\n");

const PERSONA_MEMORY_GUARD = [
	"Persona Memory Usage:",
	"- Persona memory describes the human user for personalization and direct address.",
	"- Do NOT incorporate persona facts (pet ownership, hobbies, biographical details) into generated documents, reports, or file content unless the user explicitly asks for them.",
].join("\n");

const SOURCE_AUTHORITY_GUARD = [
	"Source Authority and Synthesis Rules:",
	"- When you retrieve multiple sources (web search, fetched pages, manuals), rank them by authority before synthesizing your answer:",
	"  1. Official documentation, manuals, READMEs, and primary sources (highest authority)",
	"  2. Authoritative technical references, API docs, and established wikis",
	"  3. Original research papers or primary-source data",
	"  4. Forum discussions with verified, reproducible solutions",
	"  5. Commercial listings, shop pages, marketing sites, and aggregator content (lowest authority)",
	"- When synthesizing your answer, prioritize technical accuracy and depth from high-authority sources over recency or simplicity from low-authority sources.",
	"- If an official manual or primary-source document contradicts a commercial listing, trust the manual.",
	"- Do not discard detailed technical findings from earlier, high-authority tool calls just because later calls return simpler or thinner results.",
	"- Cite the most authoritative source that supports each claim, not merely the most recent one.",
	"- When multiple sources agree, prefer citing the highest-authority one; when they conflict, explain the conflict and cite the higher-authority source.",
].join("\n");

function containsHttpUrl(value: string): boolean {
	return /https?:\/\/[^\s)>\]]+/i.test(value);
}

export function buildOutboundSystemPrompt(params: {
	basePrompt: string;
	inputValue: string;
	responseLanguage?: SupportedLanguage;
	modelDisplayName?: string;
	systemPromptAppendix?: string;
	personalityPrompt?: string;
}): string {
	const modelHeader = params.modelDisplayName
		? `[MODEL: ${params.modelDisplayName}]\n`
		: "";
	const basePrompt = modelHeader + params.basePrompt.trim();
	const todayStr = new Date().toLocaleDateString("en-US", {
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
	});
	const explicitDateContext = `[SYSTEM TIME CONTEXT: Today is ${todayStr}. Use this exact date as your current temporal anchor for relative timeframes. Call a date/time tool only when exact current time, timezone, or freshness-sensitive tool behavior materially depends on it.]`;
	const responseLanguage =
		params.responseLanguage ?? detectLanguage(params.inputValue);
	const guidanceAdditions: string[] = [
		explicitDateContext,
		buildResponseLanguageGuard(responseLanguage),
		DATE_BEFORE_SEARCH_GUARD,
	];

	if (containsHttpUrl(params.inputValue)) {
		guidanceAdditions.push(URL_LIST_TOOL_ARGUMENT_GUARD);
	}

	guidanceAdditions.push(
		FILE_GENERATION_GUARD,
		IMAGE_SEARCH_GUARD,
		WEB_RESEARCH_GUARD,
		WEB_FACT_EXTRACTION_GUARD,
		PERSONA_MEMORY_GUARD,
		SOURCE_AUTHORITY_GUARD,
	);

	if (
		typeof params.systemPromptAppendix === "string" &&
		params.systemPromptAppendix.trim()
	) {
		guidanceAdditions.push(params.systemPromptAppendix.trim());
	}

	const uniqueGuidance = Array.from(new Set(guidanceAdditions));
	const sections: string[] = [];

	if (basePrompt) {
		sections.push(basePrompt);
	}

	if (uniqueGuidance.length > 0) {
		sections.push(
			`## Tool And Search Guidance\n${uniqueGuidance.join("\n\n")}`,
		);
	}

	if (params.personalityPrompt?.trim()) {
		sections.push(
			[
				"## Response Style",
				"Apply this style strictly to every visible response. It overrides your default structure, length, formatting, and voice. Treat it as a hard rule, not a soft preference. Before finalizing, revise the answer to match the selected style's length, format, and prose constraints. Only deviate if it directly conflicts with safety, tool, source-citation requirements, or an explicit user instruction in the current message.",
				params.personalityPrompt.trim(),
			].join("\n"),
		);
	}

	return sections.join("\n\n");
}

async function resolveLangflowRunConfig(
	modelId?: ModelId,
): Promise<LangflowModelRunConfig> {
	const config = getConfig();

	if (modelId && isProviderModelId(modelId)) {
		const providerId = modelId.slice("provider:".length);
		const provider = await getProviderWithSecrets(providerId);
		if (!provider?.enabled) {
			throw new Error("Selected provider model is not available");
		}

		const componentId = config.model1.componentId.trim();
		if (!componentId) {
			throw new Error(
				"Provider models require MODEL_1_COMPONENT_ID to route through the shared Langflow Agent flow.",
			);
		}

		let apiKey: string;
		try {
			apiKey = decryptApiKey(provider.apiKeyEncrypted, provider.apiKeyIv);
		} catch {
			throw new Error(
				"Failed to decrypt provider API key. Check SESSION_SECRET and provider settings.",
			);
		}

		return {
			...config.model1,
			baseUrl: normalizeOpenAICompatibleBaseUrl(provider.baseUrl),
			apiKey,
			modelName: provider.modelName,
			displayName: provider.displayName,
			maxTokens: provider.maxTokens ?? config.model1.maxTokens,
			flowId: config.model1.flowId || config.langflowFlowId,
			componentId,
			contextLimits: resolveProviderPromptContextLimits(provider),
			providerId,
			providerReasoningEffort: provider.reasoningEffort,
			providerThinkingType: provider.thinkingType,
			requiresComponentTweaks: true,
		};
	}

	if (modelId === "model2") {
		return config.model2;
	}

	return config.model1;
}

function resolvePromptContextLimits(
	modelId: ModelId | string | undefined,
	modelConfig: LangflowModelRunConfig,
	config: RuntimeConfig,
): PromptContextLimits {
	if (modelConfig.contextLimits) {
		return modelConfig.contextLimits;
	}

	if (modelId === "model2") {
		return {
			maxModelContext: config.model2MaxModelContext,
			compactionUiThreshold: config.model2CompactionUiThreshold,
			targetConstructedContext: config.model2TargetConstructedContext,
		};
	}

	return {
		maxModelContext: config.model1MaxModelContext,
		compactionUiThreshold: config.model1CompactionUiThreshold,
		targetConstructedContext: config.model1TargetConstructedContext,
	};
}

function resolveProviderPromptContextLimits(
	provider: {
		modelName?: string | null;
		maxModelContext: number | null;
		compactionUiThreshold: number | null;
		targetConstructedContext: number | null;
	},
): PromptContextLimits {
	const budget = deriveModelContextBudget({
		maxModelContext:
			provider.maxModelContext ??
			inferModelContextWindow(provider.modelName) ??
			UNKNOWN_PROVIDER_MAX_MODEL_CONTEXT_FALLBACK,
		compactionUiThreshold: provider.compactionUiThreshold,
		targetConstructedContext: provider.targetConstructedContext,
	});
	return {
		maxModelContext: budget.maxModelContext,
		compactionUiThreshold: budget.compactionUiThreshold,
		targetConstructedContext: budget.targetConstructedContext,
	};
}

function extractCurrentMessageSection(
	inputValue: string,
	message: string,
): { contextPrefix: string; currentMessageSection: string } {
	const markerIndex = inputValue.lastIndexOf(CURRENT_USER_MESSAGE_MARKER);
	if (markerIndex >= 0) {
		return {
			contextPrefix: inputValue.slice(0, markerIndex).trim(),
			currentMessageSection: inputValue.slice(markerIndex).trim(),
		};
	}

	return {
		contextPrefix: "",
		currentMessageSection: message.trim()
			? `${CURRENT_USER_MESSAGE_MARKER}${message.trim()}`
			: inputValue.trim(),
	};
}

function resolveOutputTokenBudget(params: {
	maxTokens?: number | null;
	contextLimits: PromptContextLimits;
	systemPrompt: string;
	currentMessageSection: string;
}): OutputTokenBudget {
	const systemTokens = estimateTokenCount(params.systemPrompt);
	const currentMessageTokens = estimateTokenCount(params.currentMessageSection);
	const budget = deriveModelContextBudget({
		maxModelContext: params.contextLimits.maxModelContext,
		targetConstructedContext: params.contextLimits.targetConstructedContext,
		compactionUiThreshold: params.contextLimits.compactionUiThreshold,
		maxTokens: params.maxTokens,
		systemPromptTokens: systemTokens,
		currentMessageTokens,
		overheadReserveTokens: LANGFLOW_PROMPT_OVERHEAD_RESERVE_TOKENS,
	});
	return {
		configuredMaxTokens: budget.configuredMaxTokens,
		effectiveMaxTokens: budget.effectiveMaxTokens,
		outputReserve: budget.outputReserve,
		outputReserveClamped: budget.outputReserveClamped,
	};
}

function applyOutboundPromptBudget(params: {
	inputValue: string;
	message: string;
	systemPrompt: string;
	contextLimits: PromptContextLimits;
	maxTokens?: number | null;
	sessionId: string;
	modelId: ModelId | string | undefined;
	modelName: string;
	providerId?: string | null;
}): { inputValue: string; outputTokenBudget: OutputTokenBudget } {
	const { contextPrefix, currentMessageSection } = extractCurrentMessageSection(
		params.inputValue,
		params.message,
	);
	const outputTokenBudget = resolveOutputTokenBudget({
		maxTokens: params.maxTokens,
		contextLimits: params.contextLimits,
		systemPrompt: params.systemPrompt,
		currentMessageSection,
	});
	const outputReserve = outputTokenBudget.outputReserve;
	const configuredPromptBudget = Math.min(
		params.contextLimits.targetConstructedContext,
		Math.max(1, params.contextLimits.maxModelContext - outputReserve),
	);
	const systemTokens = estimateTokenCount(params.systemPrompt);
	const inputTokenBudget =
		configuredPromptBudget -
		systemTokens -
		LANGFLOW_PROMPT_OVERHEAD_RESERVE_TOKENS;
	const currentInputTokens = estimateTokenCount(params.inputValue);
	if (outputTokenBudget.outputReserveClamped) {
		console.warn("[LANGFLOW] Output token cap clamped", {
			sessionId: params.sessionId,
			modelId: params.modelId ?? "model1",
			providerId: params.providerId ?? null,
			modelName: params.modelName,
			maxModelContext: params.contextLimits.maxModelContext,
			targetConstructedContext: params.contextLimits.targetConstructedContext,
			configuredMaxTokens: outputTokenBudget.configuredMaxTokens,
			effectiveMaxTokens: outputTokenBudget.effectiveMaxTokens,
			outputReserve: outputTokenBudget.outputReserve,
			outputReserveClamped: true,
		});
	}

	if (inputTokenBudget > 0 && currentInputTokens <= inputTokenBudget) {
		return { inputValue: params.inputValue, outputTokenBudget };
	}

	const currentMessageTokens = estimateTokenCount(currentMessageSection);
	const contextBudget = Math.max(0, inputTokenBudget - currentMessageTokens - 16);
	const compactedContext = contextPrefix
		? truncateToTokenBudget(contextPrefix, contextBudget)
		: "";
	const budgetedInputValue = [compactedContext, currentMessageSection]
		.filter((part) => part.trim())
		.join("\n\n");
	const finalInputValue =
		inputTokenBudget > 0
			? truncateToTokenBudget(budgetedInputValue, inputTokenBudget)
			: currentMessageSection;

	console.warn("[LANGFLOW] Outbound prompt budget applied", {
		sessionId: params.sessionId,
		modelId: params.modelId ?? "model1",
		providerId: params.providerId ?? null,
		modelName: params.modelName,
		maxModelContext: params.contextLimits.maxModelContext,
		compactionUiThreshold: params.contextLimits.compactionUiThreshold,
		targetConstructedContext: params.contextLimits.targetConstructedContext,
		configuredPromptBudget,
		systemTokens,
		outputReserve,
		configuredMaxTokens: outputTokenBudget.configuredMaxTokens,
		effectiveMaxTokens: outputTokenBudget.effectiveMaxTokens,
		outputReserveClamped: outputTokenBudget.outputReserveClamped,
		inputTokenBudget,
		beforeInputTokens: currentInputTokens,
		afterInputTokens: estimateTokenCount(finalInputValue),
	});

	return { inputValue: finalInputValue, outputTokenBudget };
}

function inferContextTraceSource(sectionName: string): ContextTraceSource {
	const normalized = sectionName.toLowerCase();
	if (normalized.includes("attachment")) return "attachment";
	if (normalized.includes("generated")) return "generated_output";
	if (normalized.includes("user memory")) return "memory";
	if (normalized.includes("session")) return "session";
	if (normalized.includes("task")) return "task_state";
	if (normalized.includes("current user message")) return "user";
	if (normalized.includes("evidence") || normalized.includes("working")) {
		return "working_set";
	}
	if (normalized.includes("document")) return "document";
	return "session";
}

function parseLegacyContextSections(inputValue: string) {
	const matches = Array.from(inputValue.matchAll(/^## (.+)$/gm));
	if (matches.length === 0) {
		return [
			{
				name: "Current User Message",
				source: "user" as const,
				body: inputValue,
				signalReasons: ["current_user_message"],
			},
		];
	}

	return matches.map((match, index) => {
		const name = match[1]?.trim() || "Context Section";
		const bodyStart = (match.index ?? 0) + match[0].length;
		const nextMatch = matches[index + 1];
		const bodyEnd = nextMatch?.index ?? inputValue.length;
		return {
			name,
			source: inferContextTraceSource(name),
			body: inputValue.slice(bodyStart, bodyEnd).trim(),
			signalReasons: [],
			protected:
				name === "Current Attachments" ||
				name === "Honcho Session Context" ||
				name === "Task State",
		};
	});
}

function normalizeContextTraceSource(
	source: unknown,
	hasUserContext: boolean,
): ContextTraceContextSource {
	if (
		source === "live" ||
		source === "snapshot" ||
		source === "persisted_fallback" ||
		source === "disabled"
	) {
		return source;
	}
	return hasUserContext ? "mixed" : "disabled";
}

function emitOutboundContextTrace(params: {
	inputValue: string;
	systemPrompt: string;
	message: string;
	contextLimits: PromptContextLimits;
	outputReserve: number;
	sessionId: string;
	userId?: string | null;
	modelId: ModelId | string | undefined;
	providerId?: string | null;
	modelName: string;
	honchoContext?: import("$lib/types").HonchoContextInfo | null;
	contextTraceSections?: LegacyContextTraceSectionInput[];
}): void {
	try {
		emitContextTrace(
			buildLegacyContextTrace({
				conversationId: params.sessionId,
				streamId: null,
				userId: params.userId ?? "anonymous",
				modelId: params.modelId ?? "model1",
				providerId: params.providerId ?? null,
				modelName: params.modelName,
				attempt: 1,
				phase: "context_selection",
				contextSource: normalizeContextTraceSource(
					params.honchoContext?.source,
					Boolean(params.userId),
				),
				budget: {
					maxModelContext: params.contextLimits.maxModelContext,
					targetConstructedContext:
						params.contextLimits.targetConstructedContext,
					reservedEstimate:
						estimateTokenCount(params.systemPrompt) +
						estimateTokenCount(params.message),
					promptEstimate: estimateTokenCount(params.inputValue),
					outputReserve: params.outputReserve,
					wasBudgetEnforced:
						estimateTokenCount(params.inputValue) >=
						params.contextLimits.targetConstructedContext,
				},
				sections:
					params.contextTraceSections ??
					parseLegacyContextSections(params.inputValue),
				limitations: [],
				warnings: [],
				fallbacks: [],
			}),
		);
	} catch (error) {
		console.warn("[CONTEXT_TRACE] Failed to emit context trace", {
			conversationId: params.sessionId,
			modelId: params.modelId ?? "model1",
			error,
		});
	}
}

function shouldSendVllmChatTemplateThinking(
	modelConfig: LangflowModelRunConfig,
): boolean {
	if (isMistralMedium35Model(modelConfig.modelName)) {
		return false;
	}

	if (modelConfig.providerId) {
		return false;
	}

	const thinkingType =
		modelConfig.providerThinkingType ?? modelConfig.thinkingType;
	if (thinkingType === "enabled") {
		return true;
	}
	if (thinkingType === "disabled") {
		return false;
	}

	return /\b(qwen3?|deepseek|nemotron|reasoning|r1)\b/i.test(
		modelConfig.modelName,
	);
}

function isMistralMedium35Model(modelName: string): boolean {
	const normalized = modelName.toLowerCase();
	return /mistral.*medium.*3[._-p]?5|medium.*3[._-p]?5.*mistral/.test(
		normalized,
	);
}

function getProviderReasoningEffort(
	modelConfig: LangflowModelRunConfig,
): string | null {
	const configuredReasoningEffort =
		modelConfig.providerReasoningEffort ?? modelConfig.reasoningEffort;
	const configuredThinkingType =
		modelConfig.providerThinkingType ?? modelConfig.thinkingType;

	if (configuredReasoningEffort) {
		return configuredReasoningEffort;
	}

	if (isMistralMedium35Model(modelConfig.modelName)) {
		if (configuredThinkingType === "enabled") {
			return "high";
		}
		if (configuredThinkingType === "disabled") {
			return "none";
		}
	}

	return null;
}

function buildLangflowTweaks(
	modelConfig: LangflowModelRunConfig,
	systemPrompt: string,
	effectiveMaxTokens?: number | null,
): Record<string, unknown> {
	const componentId = modelConfig.componentId.trim();
	const requestTimeoutSeconds = Math.max(
		1,
		Math.ceil(getConfig().requestTimeoutMs / 1000),
	);
	const reasoningEffort = getProviderReasoningEffort(modelConfig);
	const thinkingType =
		modelConfig.providerThinkingType ?? modelConfig.thinkingType;
	const componentTweaks = {
		model_name: modelConfig.modelName,
		api_base: modelConfig.baseUrl,
		...(componentId ? { timeout: requestTimeoutSeconds } : {}),
		...(modelConfig.apiKey ? { api_key: modelConfig.apiKey } : {}),
		...(effectiveMaxTokens != null
			? { max_tokens: effectiveMaxTokens }
			: {}),
		enable_thinking: shouldSendVllmChatTemplateThinking(modelConfig),
		...(reasoningEffort &&
		(!thinkingType || isMistralMedium35Model(modelConfig.modelName))
			? { reasoning_effort: reasoningEffort }
			: {}),
		...(thinkingType && !isMistralMedium35Model(modelConfig.modelName)
			? { thinking_type: thinkingType }
			: {}),
		system_prompt: systemPrompt,
	};

	if (modelConfig.requiresComponentTweaks && !componentId) {
		throw new Error(
			"Provider models require a Langflow component ID for runtime model tweaks.",
		);
	}

	if (!componentId) {
		// Do not pass api_key as a flat tweak to avoid "Tool names must be unique" LangChain error
		// when multiple nodes have api_key parameters.
		const { api_key, ...safeTweaks } = componentTweaks;
		return safeTweaks;
	}

	return {
		[componentId]: componentTweaks,
	};
}

function mergeAbortSignals(
	...signals: Array<AbortSignal | undefined>
): AbortSignal {
	const activeSignals = signals.filter((signal): signal is AbortSignal =>
		Boolean(signal),
	);

	if (activeSignals.length === 1) {
		return activeSignals[0];
	}

	const controller = new AbortController();
	const abort = () => controller.abort();

	for (const signal of activeSignals) {
		if (signal.aborted) {
			controller.abort();
			break;
		}

		signal.addEventListener("abort", abort, { once: true });
	}

	return controller.signal;
}

export async function prepareOutboundChatContext(params: {
	message: string;
	sessionId: string;
	modelConfig: ModelConfig;
	user?: AuthenticatedPromptUser;
	attachmentIds?: string[];
	activeDocumentArtifactId?: string;
	attachmentTraceId?: string;
	systemPromptAppendix?: string;
	personalityPrompt?: string;
	skipHonchoContext?: boolean;
	modelId?: string;
	contextLimits?: PromptContextLimits;
	logLabel: "request" | "streaming bundle" | "provider request";
}): Promise<PreparedOutboundChatContext> {
	let inputValue = params.message;
	let contextStatus: import("$lib/types").ConversationContextStatus | undefined;
	let taskState: import("$lib/types").TaskState | null | undefined;
	let contextDebug: import("$lib/types").ContextDebugState | null | undefined;
	let honchoContext: import("$lib/types").HonchoContextInfo | null | undefined;
	let honchoSnapshot:
		| import("$lib/types").HonchoContextSnapshot
		| null
		| undefined;
	let contextTraceSections: LegacyContextTraceSectionInput[] | undefined;

	if (params.user?.id && !params.skipHonchoContext) {
		const constructed = await buildConstructedContext({
			userId: params.user.id,
			conversationId: params.sessionId,
			message: params.message,
			attachmentIds: params.attachmentIds,
			activeDocumentArtifactId: params.activeDocumentArtifactId,
			attachmentTraceId: params.attachmentTraceId,
			modelId: params.modelId,
			contextLimits: params.contextLimits,
		});
		inputValue = constructed.inputValue;
		contextStatus = constructed.contextStatus;
		taskState = constructed.taskState;
		contextDebug = constructed.contextDebug;
		honchoContext = constructed.honchoContext;
		honchoSnapshot = constructed.honchoSnapshot;
		contextTraceSections = constructed.contextTraceSections;
	}

	const attachmentSection = summarizeAttachmentSectionInInput(inputValue);
	if ((params.attachmentIds?.length ?? 0) > 0) {
		logAttachmentTrace("langflow_request", {
			traceId: params.attachmentTraceId ?? null,
			sessionId: params.sessionId,
			inputValueLength: inputValue.length,
			hasCurrentAttachmentsMarker: attachmentSection.hasMarker,
			attachmentSectionPreview: attachmentSection.preview,
			attachmentSectionPreviewHash: attachmentSection.previewHash,
		});
		if (!attachmentSection.hasMarker) {
			console.warn(
				`[LANGFLOW] Attachment marker missing from outgoing ${params.logLabel}`,
				{
					sessionId: params.sessionId,
					attachmentIds: params.attachmentIds ?? [],
					traceId: params.attachmentTraceId ?? null,
					inputValueLength: inputValue.length,
				},
			);
		}
	}

	const baseSystemPrompt = params.user?.id
		? await buildEnhancedSystemPrompt(params.modelConfig.systemPrompt, {
				userId: params.user.id,
				displayName: params.user.displayName,
				email: params.user.email,
			})
		: getSystemPrompt(params.modelConfig.systemPrompt);
	const systemPrompt = buildOutboundSystemPrompt({
		basePrompt: baseSystemPrompt,
		inputValue,
		responseLanguage: detectLanguage(params.message),
		modelDisplayName: params.modelConfig.displayName,
		systemPromptAppendix: params.systemPromptAppendix,
		personalityPrompt: params.personalityPrompt,
	});
	const budgetedPrompt = applyOutboundPromptBudget({
		inputValue,
		message: params.message,
		systemPrompt,
		contextLimits:
			params.contextLimits ??
			resolvePromptContextLimits(
				params.modelId ?? "model1",
				params.modelConfig,
				getConfig(),
			),
		maxTokens: params.modelConfig.maxTokens,
		sessionId: params.sessionId,
		modelId: params.modelId ?? "model1",
		modelName: params.modelConfig.modelName,
		providerId: null,
	});
	inputValue = budgetedPrompt.inputValue;

	return {
		inputValue,
		systemPrompt,
		contextStatus,
		taskState,
		contextDebug,
		honchoContext,
		honchoSnapshot,
		contextTraceSections,
	};
}

export function extractMessageText(response: LangflowRunResponse): string {
	try {
		const text = response.outputs?.[0]?.outputs?.[0]?.results?.message?.text;

		if (typeof text !== "string" || text === "") {
			throw new Error("Could not extract message text from Langflow response");
		}

		return text;
	} catch (error) {
		throw new Error(
			`Failed to extract message text: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export async function sendMessage(
	message: string,
	sessionId: string,
	modelId?: ModelId,
	user?: AuthenticatedPromptUser,
	options?: {
		signal?: AbortSignal;
		attachmentIds?: string[];
		activeDocumentArtifactId?: string;
		attachmentTraceId?: string;
		systemPromptAppendix?: string;
		personalityPrompt?: string;
		skipHonchoContext?: boolean;
	},
): Promise<{
	text: string;
	rawResponse: LangflowRunResponse;
	contextStatus?: import("$lib/types").ConversationContextStatus;
	taskState?: import("$lib/types").TaskState | null;
	contextDebug?: import("$lib/types").ContextDebugState | null;
	honchoContext?: import("$lib/types").HonchoContextInfo | null;
	honchoSnapshot?: import("$lib/types").HonchoContextSnapshot | null;
	providerUsage?: ProviderUsageSnapshot | null;
}> {
	const config = getConfig();
	const controller = new AbortController();
	const timeoutId = setTimeout(
		() => controller.abort(),
		config.requestTimeoutMs,
	);
	const signal = mergeAbortSignals(options?.signal, controller.signal);

	try {
		const modelConfig = await resolveLangflowRunConfig(modelId);
		const flowId = modelConfig.flowId || config.langflowFlowId;
		const url = `${config.langflowApiUrl}/api/v1/run/${flowId}`;
		const modelName = modelConfig.modelName;
		const baseUrl = modelConfig.baseUrl;

		let inputValue = message;
		let contextStatus:
			| import("$lib/types").ConversationContextStatus
			| undefined;
		let taskState: import("$lib/types").TaskState | null | undefined;
		let contextDebug: import("$lib/types").ContextDebugState | null | undefined;
		let honchoContext:
			| import("$lib/types").HonchoContextInfo
			| null
			| undefined;
		let honchoSnapshot:
			| import("$lib/types").HonchoContextSnapshot
			| null
			| undefined;
		let contextTraceSections: LegacyContextTraceSectionInput[] | undefined;
		if (user?.id && !options?.skipHonchoContext) {
			const constructed = await buildConstructedContext({
				userId: user.id,
				conversationId: sessionId,
				message,
				attachmentIds: options?.attachmentIds,
				activeDocumentArtifactId: options?.activeDocumentArtifactId,
				attachmentTraceId: options?.attachmentTraceId,
				modelId: modelId ?? "model1",
				contextLimits: modelConfig.contextLimits,
			});
			inputValue = constructed.inputValue;
			contextStatus = constructed.contextStatus;
			taskState = constructed.taskState;
			contextDebug = constructed.contextDebug;
			honchoContext = constructed.honchoContext;
			honchoSnapshot = constructed.honchoSnapshot;
			contextTraceSections = constructed.contextTraceSections;
		}

		const attachmentSection = summarizeAttachmentSectionInInput(inputValue);
		if ((options?.attachmentIds?.length ?? 0) > 0) {
			logAttachmentTrace("langflow_request", {
				traceId: options?.attachmentTraceId ?? null,
				sessionId,
				inputValueLength: inputValue.length,
				hasCurrentAttachmentsMarker: attachmentSection.hasMarker,
				attachmentSectionPreview: attachmentSection.preview,
				attachmentSectionPreviewHash: attachmentSection.previewHash,
			});
			if (!attachmentSection.hasMarker) {
				console.warn(
					"[LANGFLOW] Attachment marker missing from outgoing request bundle",
					{
						sessionId,
						attachmentIds: options?.attachmentIds ?? [],
						traceId: options?.attachmentTraceId ?? null,
						inputValueLength: inputValue.length,
					},
				);
			}
		}

		const baseSystemPrompt = user?.id
			? await buildEnhancedSystemPrompt(modelConfig.systemPrompt, {
					userId: user.id,
					displayName: user.displayName,
					email: user.email,
				})
			: getSystemPrompt(modelConfig.systemPrompt);
		const systemPrompt = buildOutboundSystemPrompt({
			basePrompt: baseSystemPrompt,
			inputValue,
			responseLanguage: detectLanguage(message),
			modelDisplayName: modelConfig.displayName,
			systemPromptAppendix: options?.systemPromptAppendix,
			personalityPrompt: options?.personalityPrompt,
		});
		const contextLimits = resolvePromptContextLimits(
			modelId ?? "model1",
			modelConfig,
			config,
		);
		const budgetedPrompt = applyOutboundPromptBudget({
			inputValue,
			message,
			systemPrompt,
			contextLimits,
			maxTokens: modelConfig.maxTokens,
			sessionId,
			modelId: modelId ?? "model1",
			modelName,
			providerId: modelConfig.providerId ?? null,
		});
		inputValue = budgetedPrompt.inputValue;
		emitOutboundContextTrace({
			inputValue,
			systemPrompt,
			message,
			contextLimits,
			outputReserve: budgetedPrompt.outputTokenBudget.outputReserve,
			sessionId,
			userId: user?.id ?? null,
			modelId: modelId ?? "model1",
			providerId: modelConfig.providerId ?? null,
			modelName,
			honchoContext,
			contextTraceSections,
		});

		const body: LangflowRunRequest & { tweaks?: Record<string, unknown> } = {
			input_value: inputValue,
			input_type: "chat",
			output_type: "chat",
			session_id: sessionId,
			tweaks: buildLangflowTweaks(
				modelConfig,
				systemPrompt,
				budgetedPrompt.outputTokenBudget.effectiveMaxTokens,
			),
		};

		if (config.contextDiagnosticsDebug) {
			console.info("[LANGFLOW] Starting request", {
				url,
				flowId,
				sessionId,
				userId: user?.id ?? null,
				modelId: modelId ?? "model1",
				providerId: modelConfig.providerId ?? null,
				modelName,
				baseUrl,
				attachmentCount: options?.attachmentIds?.length ?? 0,
				inputLength: inputValue.length,
			});
		}

		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": config.langflowApiKey,
			},
			body: JSON.stringify(body),
			signal,
		});

		if (!response.ok) {
			const errorBody = await response.text().catch(() => "");
			console.error("[LANGFLOW] sendMessage non-OK response", {
				url,
				status: response.status,
				statusText: response.statusText,
				bodyPreview: errorBody.slice(0, 1000),
			});
			throw new Error(
				`Langflow API error: ${response.status} ${response.statusText}${errorBody ? ` - ${errorBody.slice(0, 500)}` : ""}`,
			);
		}

		const rawResponse: LangflowRunResponse = await response.json();
		const text = extractMessageText(rawResponse);
		const providerUsage = extractProviderUsage(rawResponse);

		return {
			text,
			rawResponse,
			contextStatus,
			taskState,
			contextDebug,
			honchoContext,
			honchoSnapshot,
			providerUsage,
		};
	} finally {
		clearTimeout(timeoutId);
	}
}

export async function sendMessageStream(
	message: string,
	sessionId: string,
	modelId?: ModelId,
	options?: {
		connectTimeoutMs?: number;
		signal?: AbortSignal;
		user?: AuthenticatedPromptUser;
		attachmentIds?: string[];
		activeDocumentArtifactId?: string;
		attachmentTraceId?: string;
		systemPromptAppendix?: string;
		personalityPrompt?: string;
		skipHonchoContext?: boolean;
	},
): Promise<{
	stream?: ReadableStream<Uint8Array>;
	text?: string;
	rawResponse?: LangflowRunResponse;
	contextStatus?: import("$lib/types").ConversationContextStatus;
	taskState?: import("$lib/types").TaskState | null;
	contextDebug?: import("$lib/types").ContextDebugState | null;
	honchoContext?: import("$lib/types").HonchoContextInfo | null;
	honchoSnapshot?: import("$lib/types").HonchoContextSnapshot | null;
	providerUsage?: ProviderUsageSnapshot | null;
}> {
	const config = getConfig();
	const timeoutController = new AbortController();
	const timeoutId = setTimeout(
		() => timeoutController.abort(),
		config.requestTimeoutMs,
	);
	const connectTimeoutMs = Math.min(
		config.requestTimeoutMs,
		Math.max(1000, options?.connectTimeoutMs ?? config.requestTimeoutMs),
	);
	const connectTimeoutController = new AbortController();
	let connectTimedOut = false;
	const connectTimeoutId = setTimeout(() => {
		connectTimedOut = true;
		connectTimeoutController.abort();
	}, connectTimeoutMs);
	const signal = mergeAbortSignals(
		options?.signal,
		timeoutController.signal,
		connectTimeoutController.signal,
	);

	try {
		const modelConfig = await resolveLangflowRunConfig(modelId);
		const flowId = modelConfig.flowId || config.langflowFlowId;
		const url = `${config.langflowApiUrl}/api/v1/run/${flowId}?stream=true`;
		const modelName = modelConfig.modelName;
		const baseUrl = modelConfig.baseUrl;

		let inputValue = message;
		let contextStatus:
			| import("$lib/types").ConversationContextStatus
			| undefined;
		let taskState: import("$lib/types").TaskState | null | undefined;
		let contextDebug: import("$lib/types").ContextDebugState | null | undefined;
		let honchoContext:
			| import("$lib/types").HonchoContextInfo
			| null
			| undefined;
		let honchoSnapshot:
			| import("$lib/types").HonchoContextSnapshot
			| null
			| undefined;
		let contextTraceSections: LegacyContextTraceSectionInput[] | undefined;
		if (options?.user?.id && !options.skipHonchoContext) {
			const constructed = await buildConstructedContext({
				userId: options.user.id,
				conversationId: sessionId,
				message,
				attachmentIds: options.attachmentIds,
				activeDocumentArtifactId: options.activeDocumentArtifactId,
				attachmentTraceId: options.attachmentTraceId,
				modelId: modelId ?? "model1",
				contextLimits: modelConfig.contextLimits,
			});
			inputValue = constructed.inputValue;
			contextStatus = constructed.contextStatus;
			taskState = constructed.taskState;
			contextDebug = constructed.contextDebug;
			honchoContext = constructed.honchoContext;
			honchoSnapshot = constructed.honchoSnapshot;
			contextTraceSections = constructed.contextTraceSections;
		}

		const attachmentSection = summarizeAttachmentSectionInInput(inputValue);
		if ((options?.attachmentIds?.length ?? 0) > 0) {
			logAttachmentTrace("langflow_request", {
				traceId: options?.attachmentTraceId ?? null,
				sessionId,
				inputValueLength: inputValue.length,
				hasCurrentAttachmentsMarker: attachmentSection.hasMarker,
				attachmentSectionPreview: attachmentSection.preview,
				attachmentSectionPreviewHash: attachmentSection.previewHash,
			});
			if (!attachmentSection.hasMarker) {
				console.warn(
					"[LANGFLOW] Attachment marker missing from outgoing streaming bundle",
					{
						sessionId,
						attachmentIds: options?.attachmentIds ?? [],
						traceId: options?.attachmentTraceId ?? null,
						inputValueLength: inputValue.length,
					},
				);
			}
		}

		const baseSystemPrompt = options?.user?.id
			? await buildEnhancedSystemPrompt(modelConfig.systemPrompt, {
					userId: options.user.id,
					displayName: options.user.displayName,
					email: options.user.email,
				})
			: getSystemPrompt(modelConfig.systemPrompt);
		const systemPrompt = buildOutboundSystemPrompt({
			basePrompt: baseSystemPrompt,
			inputValue,
			responseLanguage: detectLanguage(message),
			modelDisplayName: modelConfig.displayName,
			systemPromptAppendix: options?.systemPromptAppendix,
			personalityPrompt: options?.personalityPrompt,
		});
		const contextLimits = resolvePromptContextLimits(
			modelId ?? "model1",
			modelConfig,
			config,
		);
		const budgetedPrompt = applyOutboundPromptBudget({
			inputValue,
			message,
			systemPrompt,
			contextLimits,
			maxTokens: modelConfig.maxTokens,
			sessionId,
			modelId: modelId ?? "model1",
			modelName,
			providerId: modelConfig.providerId ?? null,
		});
		inputValue = budgetedPrompt.inputValue;
		emitOutboundContextTrace({
			inputValue,
			systemPrompt,
			message,
			contextLimits,
			outputReserve: budgetedPrompt.outputTokenBudget.outputReserve,
			sessionId,
			userId: options?.user?.id ?? null,
			modelId: modelId ?? "model1",
			providerId: modelConfig.providerId ?? null,
			modelName,
			honchoContext,
			contextTraceSections,
		});

		const body: LangflowRunRequest & { tweaks?: Record<string, unknown> } = {
			input_value: inputValue,
			input_type: "chat",
			output_type: "chat",
			session_id: sessionId,
			tweaks: buildLangflowTweaks(
				modelConfig,
				systemPrompt,
				budgetedPrompt.outputTokenBudget.effectiveMaxTokens,
			),
		};

		if (config.contextDiagnosticsDebug) {
			console.info("[LANGFLOW] Starting streaming request", {
				url,
				flowId,
				sessionId,
				userId: options?.user?.id ?? null,
				modelId: modelId ?? "model1",
				providerId: modelConfig.providerId ?? null,
				modelName,
				baseUrl,
				attachmentCount: options?.attachmentIds?.length ?? 0,
				inputLength: inputValue.length,
			});
		}

		const response = await fetch(url, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Cache-Control": "no-cache",
				"Content-Type": "application/json",
				"x-api-key": config.langflowApiKey,
			},
			body: JSON.stringify(body),
			signal,
		});
		clearTimeout(connectTimeoutId);

		if (!response.ok) {
			const errorBody = await response.text().catch(() => "");
			console.error("[LANGFLOW] sendMessageStream non-OK response", {
				url,
				status: response.status,
				statusText: response.statusText,
				bodyPreview: errorBody.slice(0, 1000),
			});
			throw new Error(
				`Langflow API error: ${response.status} ${response.statusText}${errorBody ? ` - ${errorBody.slice(0, 500)}` : ""}`,
			);
		}

		const contentType = response.headers.get("content-type") ?? "";
		if (!contentType.includes("text/event-stream")) {
			const rawResponse: LangflowRunResponse = await response.json();
			const text = extractMessageText(rawResponse);
			const providerUsage = extractProviderUsage(rawResponse);
			console.warn(
				"[LANGFLOW] sendMessageStream received non-stream JSON response",
				{
					url,
					sessionId,
					contentType,
					textLength: text.length,
				},
			);
			return {
				text,
				rawResponse,
				contextStatus,
				taskState,
				contextDebug,
				honchoContext,
				honchoSnapshot,
				providerUsage,
			};
		}

		if (!response.body) {
			console.error("[LANGFLOW] sendMessageStream missing response body", {
				url,
				sessionId,
			});
			throw new Error("Response body is empty");
		}

		return {
			stream: response.body as ReadableStream<Uint8Array>,
			contextStatus,
			taskState,
			contextDebug,
			honchoContext,
			honchoSnapshot,
		};
	} catch (error) {
		if (connectTimedOut) {
			const timeoutError = new Error(
				`Timed out waiting ${connectTimeoutMs}ms for Langflow streaming response headers`,
			) as Error & { code?: string };
			timeoutError.name = "LangflowStreamConnectTimeoutError";
			timeoutError.code = "langflow_stream_connect_timeout";
			throw timeoutError;
		}
		throw error;
	} finally {
		clearTimeout(timeoutId);
		clearTimeout(connectTimeoutId);
	}
}
