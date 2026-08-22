import type { ModelId } from "$lib/model-types";
import { isProviderModelId } from "$lib/model-types";
import type { ToolCallEntry } from "$lib/server/services/messages-types";
import { estimateTokenCount } from "$lib/utils/tokens";
import {
	getConfig,
	type ModelConfig,
	type RuntimeConfig,
} from "../config-store";
import { getSystemPrompt, stripDeprecatedPromptSections } from "../prompts";
import { truncateToTokenBudget } from "../utils/prompt-context";
import {
	logAttachmentTrace,
	summarizeAttachmentSectionInInput,
} from "./attachment-trace";
import { deriveModelContextBudget } from "./chat-turn/context-budget";
import {
	buildConstructedContext,
	type ConstructedContextReuseData,
} from "./chat-turn/context-selection";
import {
	buildLegacyContextTrace,
	type ContextTraceContextSource,
	type ContextTraceSource,
	emitContextTrace,
	type LegacyContextTraceSectionInput,
} from "./chat-turn/context-trace";
import { buildProactiveConnectorContext } from "./chat-turn/proactive-connector-context";
import type { ReasoningDepthEffort } from "./chat-turn/reasoning-depth-effort";
import type { Capability } from "./connections/registry";
import type { ContextCompressionControlSender } from "./context-compression";
import { detectLanguage, type SupportedLanguage } from "./language";
import { inferModelContextWindow } from "./model-context";
import {
	getDefaultNormalChatContextPreparationPlan,
	type NormalChatContextPreparationActivityCallback,
	type NormalChatContextPreparationStageTiming,
	runNormalChatContextPreparationStages,
} from "./normal-chat-context-preparation";
import { resolveFetchContentCharCap } from "./normal-chat-tools/fetch-url";
import { resolveModelContextTokens } from "./normal-chat-tools/model-context-tokens";
import type { GroundedWebResult } from "./parallel-search/types";

const UNKNOWN_PROVIDER_MAX_MODEL_CONTEXT_FALLBACK = 150_000;
const CURRENT_USER_MESSAGE_MARKER = "## Current User Message\n";
const NORMAL_CHAT_PROMPT_OVERHEAD_RESERVE_TOKENS = 512;
const NORMAL_CHAT_PROMPT_OVERHEAD_RESERVE_RATIO = 0.16;
const NORMAL_CHAT_PROMPT_MAX_OVERHEAD_RESERVE_TOKENS = 48_000;
const NORMAL_CHAT_PROMPT_TOKEN_SAFETY_FACTOR = 1.2;
const GPT_OSS_HIGH_REASONING_DIRECTIVE = "Reasoning: high";
const GPT_OSS_REASONING_DIRECTIVE_RE =
	/(^|\n)Reasoning:\s*(?:low|medium|high)\s*(?=\n|$)/i;
const GPT_OSS_REASONING_DIRECTIVE_LINE_RE =
	/^\s*Reasoning:\s*(?:low|medium|high)\s*$/i;
const NORMAL_CHAT_CONTEXT_LOG_PREFIX = "[NORMAL_CHAT_CONTEXT]";
// Upper bound on a server-side web prefetch made while building the turn
// context. Live Parallel Extract fetches occasionally spike to 25-42s (see
// parallel-search/fetch-url.ts); without a bound a cache-missing pasted URL
// could stall the START of the turn indefinitely. On timeout we abort the
// underlying request and degrade gracefully (no prefetched tool calls). Kept
// within the design review's 10-15s guidance.
const PREFETCH_TIMEOUT_MS = 12_000;

export type AuthenticatedPromptUser = {
	id: string;
	displayName?: string | null;
	email?: string | null;
};

export type PromptContextLimits = {
	maxModelContext: number;
	compactionUiThreshold: number;
	targetConstructedContext: number;
};

export type NormalChatContextModelConfig = ModelConfig & {
	contextLimits?: PromptContextLimits;
	providerId?: string | null;
};

export type PreparedOutboundChatContext = {
	inputValue: string;
	systemPrompt: string;
	contextStatus?: import("$lib/server/services/knowledge/context-types").ConversationContextStatus;
	taskState?: import("$lib/server/services/task-state/types").TaskState | null;
	contextDebug?:
		| import("$lib/server/services/knowledge/context-types").ContextDebugState
		| null;
	contextTraceSections?: LegacyContextTraceSectionInput[];
	prefetchedToolCalls?: ToolCallEntry[];
	outputTokenBudget?: OutputTokenBudget;
	contextLimits: PromptContextLimits;
	contextPreparationTimings?: NormalChatContextPreparationStageTiming[];
};

export type OutputTokenBudget = {
	configuredMaxTokens: number | null;
	effectiveMaxTokens: number | null;
	outputReserve: number;
	outputReserveClamped: boolean;
};

function containsDirectHttpUrl(value: string): boolean {
	return DIRECT_HTTP_URL_RE.test(value);
}

function extractPastedUrls(value: string): string[] {
	const matches = value.match(/https?:\/\/[^\s<>)\]]+/gi) ?? [];
	return matches
		.map((url) => url.replace(/[.,;:!?]+$/, ""))
		.filter((url) => url.length > 0)
		.slice(0, 5);
}

type ConstructedContextResult = Awaited<
	ReturnType<typeof buildConstructedContext>
>;

type AutomaticContextCompressionOutcome =
	| "not_needed"
	| "not_possible"
	| "failed"
	| "succeeded";

type AutomaticContextCompressionResult = {
	context: ConstructedContextResult | null;
	outcome: AutomaticContextCompressionOutcome;
	reason: string;
	attempted: boolean;
	beforeInputTokensWithSafety?: number;
	rawSourceTokensWithSafety?: number;
	sourceMessageCount?: number;
	snapshotId?: string | null;
};

type OutboundChatContextPreparationState = {
	inputValue: string;
	contextStatus?: import("$lib/server/services/knowledge/context-types").ConversationContextStatus;
	taskState?: import("$lib/server/services/task-state/types").TaskState | null;
	contextDebug?:
		| import("$lib/server/services/knowledge/context-types").ContextDebugState
		| null;
	contextTraceSections?: LegacyContextTraceSectionInput[];
	prefetchedToolCalls: ToolCallEntry[];
	reuseData?: ConstructedContextReuseData;
	baseSystemPrompt?: string;
	systemPrompt?: string;
	contextLimits?: PromptContextLimits;
	automaticCompression?: AutomaticContextCompressionResult;
	outputTokenBudget?: OutputTokenBudget;
};

// Used by maybePrefetchWebSearch (server-side pasted-URL / forced-search
// prefetch — a distinct feature from tool-usage guidance text, and NOT part
// of what G1 removed) to detect a pasted URL in the latest user message.
const DIRECT_HTTP_URL_RE = /https?:\/\/[^\s<>)\]]+/i;

// Redesign R8 — concise holistic framing for the connection tools
// (calendar/files/email/photos/media/location/contacts). Only spliced into
// the outbound system prompt when the caller reports the user has at least
// one active connection capability (buildOutboundSystemPrompt's
// `hasActiveConnections`), so turns with no connections don't pay the token
// cost. Deliberately English-only, matching every other guard constant in
// this file — the model is instructed in English regardless of
// responseLanguage, which only governs the user-facing reply language.
const CONNECTIONS_FRAMING_GUARD = [
	"Connected Accounts:",
	"- The user may have connected personal accounts (calendar, files, email, photos, media, location, contacts). Use the relevant connection tool when the user's request calls for it. Do not announce tool use mechanically, and only surface connected-account data when it is relevant to the request.",
	"- Every write to a connected account — creating/updating/deleting a calendar event, saving a file, sending/trashing/flagging an email, adding photos to an album — is only a proposal. You never modify a connected account immediately or autonomously; the user must explicitly confirm before anything is written.",
	"- If more than one connected account could serve a request (e.g. two calendars), ask the user which one to use, unless the conversation or memory already makes it clear.",
].join("\n");

// R1 defect 5 — this generic tool-call-JSON-formatting guidance was dropped
// entirely by G1 (ADR-0055, which deleted the message-content-selected
// guidance-pack machinery this used to ride on). It applies to every tool
// call regardless of which specific tool is used, so — unlike the
// per-tool when/how/example guidance G1 correctly relocated onto each
// tool's own TOOL_I18N description — it belongs here as always-on runtime
// guidance, gated only on tools actually being available (the same
// `!skipDefaultRuntimeGuidance` gate the other default runtime guidance
// below uses; the tool-less control-model caller is the only caller that
// opts out). Deliberately English-only, matching every other guard
// constant in this file.
const JSON_FORMATTING_RULES = [
	"Tool JSON formatting rules — all tool arguments MUST be valid JSON:",
	"- Pass exactly the JSON object as the argument — no trailing punctuation (no period, comma, or semicolon after the closing `}`). The argument ends at `}`.",
	"- Within JSON strings, use `\\n` to represent newlines. Do not paste raw multiline text into a JSON string — the parser will reject it.",
	"- Only include fields listed in the tool's schema. Do not invent extra fields.",
	"- If a tool call fails with a JSON parse error, read the error message, fix the specific issue, and retry once. Do not repeat the same malformed JSON.",
	"- Do not add comments, markdown fences, or explanatory text inside the JSON argument.",
].join("\n");

// A3 (Tier A3, prompt coupling — REQUIRED): the chat UI renders a set of rich
// markdown blocks natively (interactive checklists, accordions, tables,
// callouts, and mermaid/chart/csv diagrams). Without teaching the model this
// syntax it keeps dumping structured content into generic grey code fences, so
// the renderer support is invisible. This is always-on answer-formatting
// guidance (not tool- or message-specific), gated only on the same
// `!skipDefaultRuntimeGuidance` flag as the other default runtime guidance so
// the tool-less control-model caller does not pay for it. English-only, like
// every other guard constant here.
const RICH_BLOCK_SYNTAX_GUIDE = [
	"Rich answer blocks — the chat UI renders these natively. EMIT them directly when they help; do NOT dump structured content into a generic ``` code fence:",
	"- Checklists: write the task list directly in the message text, each item on its own line as `- [ ] todo` or `- [x] done`. The `- ` before the box is REQUIRED, and the list must NOT be inside a ``` code fence — `[ ] item` on its own, or a fenced block, renders as dead monospaced text instead of a clean checklist. Use for steps and to-dos.",
	"- Collapsible sections: `<details><summary>Title</summary> …markdown… </details>` renders as an accordion. Use to tuck away long optional detail.",
	"- Tables: standard GFM pipe tables render as first-class scrollable tables. Use for structured comparisons.",
	"- Callouts: `> [!NOTE] Title` (also TIP, WARNING, IMPORTANT) renders as a highlighted callout.",
	'- Diagrams: a fenced ```mermaid block renders a flowchart, sequence, class, or state diagram. In a flowchart, wrap any node label containing parentheses, colons, or quotes in double quotes and always close the bracket, e.g. `F{"Gate (3+ reps)?"}` — an unquoted `(` or an unclosed `{`/`[` fails to render. Do NOT use a mermaid gantt for a simple week-by-week plan (it needs a `dateFormat` line and a real calendar date on every task); prefer a flowchart, a table, or a ```chart bar for schedules.',
	'- Charts: a fenced ```chart block whose body is a JSON Chart.js config renders as a chart, e.g. {"type":"bar","data":{"labels":["A","B"],"datasets":[{"label":"X","data":[1,2]}]}}. Use for quantitative comparisons. `type` MUST be one of bar, line, scatter, bubble, pie, doughnut, polarArea, radar — no other value renders. Keep the config small — `data` plus at most a title in `options` — and make sure every `{` and `[` is closed so the JSON is valid.',
	"- CSV tables: a fenced ```csv block (first row is the header) renders as a table. Use for quick tabular data.",
	"A ```mermaid / ```chart / ```csv block MUST contain complete, valid source and be properly closed, or it falls back to plain code. Prefer prose for simple answers — do not over-format.",
].join("\n");

function buildReasoningDepthEffortGuard(effort: ReasoningDepthEffort): string {
	const profile = effort.depthMetadata.appliedProfile;
	const grounding = effort.grounding.guidance;
	const depthContract =
		profile === "maximum"
			? [
					"Maximum-depth reasoning contract:",
					"- Before answering, deliberately spend extra private reasoning effort on the user's real objective, unstated constraints, edge cases, likely failure modes, and tradeoffs.",
					"- Break the task into subproblems internally, test the strongest candidate answer against alternatives, and resolve contradictions before writing the final response.",
					"- If the request involves code, architecture, research, product choice, study help, planning, or debugging, check assumptions and implementation details more aggressively than a normal turn.",
					"- Do not expose chain-of-thought or scratchpad reasoning. Show only the concise conclusions, key rationale, citations when used, and any uncertainty that matters.",
				]
			: profile === "extended"
				? [
						"Extended-depth reasoning contract:",
						"- Before answering, take an extra private pass over the user's goal, constraints, edge cases, and likely missing details.",
						"- Decompose multi-step work internally and verify that the final answer actually satisfies each important part of the request.",
						"- Do not expose chain-of-thought or scratchpad reasoning. Show only the useful rationale and conclusions.",
					]
				: profile === "standard"
					? [
							"Standard-depth reasoning contract:",
							"- Use normal private reasoning. Keep the answer efficient, but still check obvious constraints and avoid unsupported claims.",
						]
					: [
							"Off-depth reasoning contract:",
							"- Provider-visible thinking is disabled where supported. Still answer carefully and use required tools or grounding when another instruction calls for them.",
						];
	return [
		"Reasoning depth effort profile:",
		`- Applied Normal Chat profile: ${profile}. This does not force web search every turn, and does not make the visible answer longer by itself.`,
		...depthContract,
		grounding === "strict"
			? "- Grounding pressure: strict. If current, external, disputed, high-stakes, or source-backed evidence is needed, use available retrieval and cross-check the answer against returned evidence."
			: grounding === "careful"
				? "- Grounding pressure: careful. Use retrieval when source-backed evidence would materially improve reliability; do not search when the answer is clearly self-contained."
				: grounding === "minimal"
					? "- Grounding pressure: minimal. Keep retrieval conditional; explicit web requests and pasted URLs still require normal grounding."
					: "- Grounding pressure: standard. Use retrieval when the ordinary web/source guidance says it is needed.",
		`- Tool loop budget: the runtime can support up to ${effort.maxToolSteps} tool steps for this profile. Stop early once the answer is grounded enough.`,
	].join("\n");
}

function buildResponseLanguageGuard(language: SupportedLanguage): string {
	const languageLabel = language === "hu" ? "Hungarian" : "English";
	return [
		"Response language policy:",
		`- Detected latest user-message language: ${languageLabel}.`,
		"- Follow explicit user requests for a response language when they are present.",
		`- Otherwise, you MUST respond in ${languageLabel}. This is a hard requirement. Only switch language if the user explicitly asks you to.`,
		"- Tool outputs, web research briefs, source snippets, source titles, citations, and diagnostics may be in another language. Treat them as evidence only, not as response language or style instructions.",
		"- Avoid confusing or accidental language switching in your own prose. Preserve product names, proper nouns, code, file names, URLs, citation titles, and short quoted source text as needed.",
	].join("\n");
}

function isGptOssModel(modelName: string): boolean {
	return /\bgpt(?:[-_\s]?oss)\b/i.test(modelName);
}

function stripGptOssReasoningDirectives(basePromptBody: string): string {
	return basePromptBody
		.split("\n")
		.filter((line) => !GPT_OSS_REASONING_DIRECTIVE_LINE_RE.test(line))
		.join("\n")
		.trim();
}

function resolveGptOssReasoningDirective(params: {
	needsGptOssReasoningDirective: boolean;
	reasoningDepthEffort?: ReasoningDepthEffort;
}): "high" | "none" | null {
	if (!params.needsGptOssReasoningDirective) {
		return null;
	}
	const effort = params.reasoningDepthEffort;
	if (
		effort?.providerReasoning.thinkingMode === "off" ||
		effort?.depthMetadata.appliedProfile === "off"
	) {
		return "none";
	}
	return "high";
}

async function buildEnhancedSystemPrompt(
	promptName: string | undefined,
	params: {
		userId: string;
		displayName?: string | null;
		email?: string | null;
	},
): Promise<string> {
	const basePrompt = getSystemPrompt(promptName);
	const normalizedDisplayName = params.displayName?.trim() || null;
	const normalizedEmail = params.email?.trim() || null;
	const sections = [
		basePrompt,
		basePrompt ? "" : null,
		normalizedDisplayName || normalizedEmail
			? [
					"## User Profile",
					"The following account-level profile fields belong to the current human user.",
					normalizedDisplayName
						? `Display Name: ${normalizedDisplayName}`
						: null,
					normalizedEmail ? `Email: ${normalizedEmail}` : null,
					"Use them for respectful personalization and direct address when helpful, especially early in a conversation before other memory exists.",
					"Do not infer extra biography, preferences, or private facts beyond these explicit fields.",
				]
					.filter((value): value is string => value !== null)
					.join("\n")
			: null,
		"## Retrieved Context Discipline",
		"Use any retrieved task state, recalled session details, documents, workflows, or evidence as supporting context only.",
		"User profile and persona memory describe the human user, not you.",
		"Never adopt the user's biography, preferences, education, profession, or life circumstances as your own identity.",
		"You remain AlfyAI, the assistant, even when memory says the user is a student, designer, applicant, or has other personal traits.",
		"Do not restate user-memory facts in first person unless the user is directly quoting themselves.",
		"Do not let stale or weakly related retrieved material steer the conversation.",
		"Do not proactively pivot to old recalled documents, recipes, files, or workflows unless the latest user turn clearly asks for them or they are directly relevant to the active task.",
		"If retrieved context conflicts with the current user intent, follow the current user intent and ignore the irrelevant retrieved material.",
		"When prior evidence is relevant, use it naturally without over-explaining that it was retrieved.",
	];

	return sections.filter((value): value is string => value !== null).join("\n");
}

export function buildOutboundSystemPrompt(params: {
	basePrompt: string;
	inputValue: string;
	responseLanguage?: SupportedLanguage;
	modelDisplayName?: string;
	modelName?: string;
	systemPromptAppendix?: string;
	personalityPrompt?: string;
	forceWebSearch?: boolean;
	fileProductionToolsAvailable?: boolean;
	reasoningDepthEffort?: ReasoningDepthEffort;
	// When true, omits every turn-scoped guidance addition below (temporal
	// anchor, response-language guard, reasoning-depth contract) — used by
	// the control-model JSON caller, which has no tools and wants the
	// leanest possible system prompt. CONNECTIONS_FRAMING_GUARD and
	// systemPromptAppendix are NOT gated by this flag; they always apply
	// when their own trigger condition is met.
	skipDefaultRuntimeGuidance?: boolean;
	// Redesign R8 — true when the caller resolved at least one active
	// connection capability for this turn (see activeConnectionCapabilities
	// on PrepareOutboundChatContextParams). Splices CONNECTIONS_FRAMING_GUARD
	// into the prompt so a connections-enabled turn always carries the
	// confirm-before-write framing, even before any connection tool is
	// actually called.
	hasActiveConnections?: boolean;
}): string {
	const modelHeader = params.modelDisplayName
		? `[MODEL: ${params.modelDisplayName}]`
		: "";
	const needsGptOssReasoningDirective = [
		params.modelName,
		params.modelDisplayName,
	].some((value) => typeof value === "string" && isGptOssModel(value));
	const basePromptBody = params.basePrompt.trim();
	const gptOssReasoningDirective = resolveGptOssReasoningDirective({
		needsGptOssReasoningDirective,
		reasoningDepthEffort: params.reasoningDepthEffort,
	});
	let normalizedBasePromptBody = basePromptBody;
	if (gptOssReasoningDirective === "none") {
		normalizedBasePromptBody = stripGptOssReasoningDirectives(basePromptBody);
	} else if (
		gptOssReasoningDirective === "high" &&
		GPT_OSS_REASONING_DIRECTIVE_RE.test(basePromptBody)
	) {
		normalizedBasePromptBody = basePromptBody.replace(
			GPT_OSS_REASONING_DIRECTIVE_RE,
			`$1${GPT_OSS_HIGH_REASONING_DIRECTIVE}`,
		);
	}
	const promptPreamble =
		gptOssReasoningDirective === "high" &&
		!GPT_OSS_REASONING_DIRECTIVE_RE.test(normalizedBasePromptBody)
			? GPT_OSS_HIGH_REASONING_DIRECTIVE
			: "";
	const basePrompt = [modelHeader, promptPreamble, normalizedBasePromptBody]
		.filter(Boolean)
		.join("\n\n");
	const todayStr = new Date().toLocaleDateString("en-US", {
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
	});
	const explicitDateContext = `[SYSTEM TIME CONTEXT: Today is ${todayStr}. Use this exact date as your current temporal anchor for relative timeframes. Call a date/time tool only when exact current time, timezone, or freshness-sensitive tool behavior materially depends on it.]`;
	const responseLanguage =
		params.responseLanguage ?? detectLanguage(params.inputValue);

	// Tool usage guidance (when to call a tool, its argument shape, output
	// handling, failure behaviour) lives in each tool's own TOOL_I18N
	// description now (normal-chat-tools/index.ts) — tool AVAILABILITY
	// already determines whether that guidance reaches the model, so it no
	// longer needs a separate, message-content-driven selector here. See
	// ADR-0055. What remains below is genuinely TURN-scoped, not
	// tool-scoped: it does not vary with the latest message's wording or
	// language, only with turn-level signals (response language, reasoning
	// depth, active connections, an explicit prompt appendix).
	const guidanceAdditions: string[] = params.skipDefaultRuntimeGuidance
		? []
		: [
				explicitDateContext,
				buildResponseLanguageGuard(responseLanguage),
				JSON_FORMATTING_RULES,
				RICH_BLOCK_SYNTAX_GUIDE,
			];

	if (!params.skipDefaultRuntimeGuidance && params.reasoningDepthEffort) {
		guidanceAdditions.push(
			buildReasoningDepthEffortGuard(params.reasoningDepthEffort),
		);
	}

	if (params.hasActiveConnections) {
		guidanceAdditions.push(CONNECTIONS_FRAMING_GUARD);
	}

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
		sections.push(`## Runtime Guidance\n${uniqueGuidance.join("\n\n")}`);
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

	return stripDeprecatedPromptSections(sections.join("\n\n"));
}

export function resolveProviderPromptContextLimits(provider: {
	modelName?: string | null;
	maxModelContext: number | null;
	compactionUiThreshold?: number | null;
	targetConstructedContext?: number | null;
}): PromptContextLimits {
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

export function resolvePromptContextLimits(
	modelId: ModelId | string | undefined,
	modelConfig: NormalChatContextModelConfig,
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

function estimateOutboundPromptTokens(text: string): number {
	return Math.ceil(
		estimateTokenCount(text) * NORMAL_CHAT_PROMPT_TOKEN_SAFETY_FACTOR,
	);
}

function resolveNormalChatPromptOverheadReserve(
	maxModelContext: number,
): number {
	return Math.max(
		NORMAL_CHAT_PROMPT_OVERHEAD_RESERVE_TOKENS,
		Math.min(
			NORMAL_CHAT_PROMPT_MAX_OVERHEAD_RESERVE_TOKENS,
			Math.floor(maxModelContext * NORMAL_CHAT_PROMPT_OVERHEAD_RESERVE_RATIO),
		),
	);
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

function insertContextBeforeCurrentMessage(
	inputValue: string,
	message: string,
	contextSection: string,
): string {
	const { contextPrefix, currentMessageSection } = extractCurrentMessageSection(
		inputValue,
		message,
	);
	return [contextPrefix, contextSection, currentMessageSection]
		.filter((part) => part.trim())
		.join("\n\n");
}

async function maybePrefetchWebSearch(params: {
	inputValue: string;
	message: string;
	forceWebSearch?: boolean;
	sessionId: string;
	modelId: ModelId | string | undefined;
}): Promise<{ inputValue: string; prefetchedToolCalls: ToolCallEntry[] }> {
	const prefetchReason = params.forceWebSearch
		? "forced_search"
		: containsDirectHttpUrl(params.message)
			? "pasted_url"
			: null;
	if (!prefetchReason) {
		return { inputValue: params.inputValue, prefetchedToolCalls: [] };
	}

	// Pre-gate on Parallel being configured, mirroring the index.ts tool gate:
	// without an API key every Parallel call 401s, so skip issuing a doomed
	// request (and starting a timer) and degrade to no prefetched context.
	if (!getConfig().parallelApiKey?.trim()) {
		return { inputValue: params.inputValue, prefetchedToolCalls: [] };
	}

	// Bound the prefetch: create a signal that fires after PREFETCH_TIMEOUT_MS and
	// thread it into the Parallel client via deps.signal (the client forwards it
	// into fetch), so a timeout TRULY aborts the underlying request rather than
	// leaving it running detached. On abort the awaited call rejects and the
	// catch below degrades gracefully. The timer is unref'd so it never keeps the
	// process alive, and cleared in the finally so a fast call leaves no dangling
	// timer.
	const abortController = new AbortController();
	const prefetchTimeout = setTimeout(() => {
		abortController.abort();
	}, PREFETCH_TIMEOUT_MS);
	prefetchTimeout.unref?.();
	try {
		const deps = {
			fetch,
			config: {
				parallelApiKey: getConfig().parallelApiKey,
				parallelBaseUrl: getConfig().parallelBaseUrl,
			},
			signal: abortController.signal,
		};
		const {
			createGroundedWebCandidates,
			createGroundedWebMetadata,
			summarizeGroundedWebResult,
		} = await import("./web-grounding");
		const pastedUrls =
			prefetchReason === "pasted_url" ? extractPastedUrls(params.message) : [];
		let result: GroundedWebResult;
		if (prefetchReason === "pasted_url" && pastedUrls.length > 0) {
			const { fetchUrlViaParallel } = await import(
				"./parallel-search/fetch-url"
			);
			// Size the fetched-page brief to the selected model's context window the
			// same way the fetch_url tool does, instead of the flat 60k default.
			const maxCharsTotal = resolveFetchContentCharCap(
				await resolveModelContextTokens(params.modelId),
			);
			result = await fetchUrlViaParallel({ urls: pastedUrls }, deps, {
				maxCharsTotal,
			});
		} else {
			const { researchWebViaParallel } = await import(
				"./parallel-search/research"
			);
			result = await researchWebViaParallel({ query: params.message }, deps);
		}
		const sourceCandidates = createGroundedWebCandidates(result);
		const metadata = {
			...createGroundedWebMetadata(result),
			serverPrefetched: true,
			prefetchReason,
		};
		const webContext = [
			"## Current Web Research",
			prefetchReason === "pasted_url"
				? "Server-prefetched page content for the pasted URL; use it as retrieved evidence."
				: "Server-prefetched web context for this forced-search turn. Use it as retrieved evidence. Do not expose raw source dumps, diagnostics, JSON, or search-result internals.",
			result.answerBrief.markdown,
		].join("\n\n");

		return {
			inputValue: insertContextBeforeCurrentMessage(
				params.inputValue,
				params.message,
				webContext,
			),
			prefetchedToolCalls: [
				{
					callId: `server-prefetch:research_web:${Date.now().toString(36)}`,
					name: "research_web",
					input: {
						query: params.message,
						source: "server_prefetch",
						prefetchReason,
					},
					status: "done",
					outputSummary: summarizeGroundedWebResult(result),
					sourceType: "web",
					candidates: sourceCandidates,
					metadata,
				},
			],
		};
	} catch (error) {
		console.warn(`${NORMAL_CHAT_CONTEXT_LOG_PREFIX} Web prefetch failed`, {
			sessionId: params.sessionId,
			modelId: params.modelId ?? "model1",
			prefetchReason,
			error: error instanceof Error ? error.message : String(error),
		});
		return { inputValue: params.inputValue, prefetchedToolCalls: [] };
	} finally {
		clearTimeout(prefetchTimeout);
	}
}

function resolveOutputTokenBudget(params: {
	maxTokens?: number | null;
	contextLimits: PromptContextLimits;
	systemPrompt: string;
	currentMessageSection: string;
}): OutputTokenBudget {
	const systemTokens = estimateOutboundPromptTokens(params.systemPrompt);
	const currentMessageTokens = estimateOutboundPromptTokens(
		params.currentMessageSection,
	);
	const overheadReserveTokens = resolveNormalChatPromptOverheadReserve(
		params.contextLimits.maxModelContext,
	);
	const budget = deriveModelContextBudget({
		maxModelContext: params.contextLimits.maxModelContext,
		targetConstructedContext: params.contextLimits.targetConstructedContext,
		compactionUiThreshold: params.contextLimits.compactionUiThreshold,
		maxTokens: params.maxTokens,
		systemPromptTokens: systemTokens,
		currentMessageTokens,
		overheadReserveTokens,
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
	automaticCompression?: AutomaticContextCompressionResult | null;
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
	const promptOverheadReserve = resolveNormalChatPromptOverheadReserve(
		params.contextLimits.maxModelContext,
	);
	const configuredPromptBudget = Math.min(
		params.contextLimits.targetConstructedContext,
		Math.max(
			1,
			params.contextLimits.maxModelContext -
				outputReserve -
				promptOverheadReserve,
		),
	);
	const systemTokens = estimateOutboundPromptTokens(params.systemPrompt);
	const inputTokenBudget = configuredPromptBudget - systemTokens;
	const safeInputTokenBudget = Math.max(
		1,
		Math.floor(inputTokenBudget / NORMAL_CHAT_PROMPT_TOKEN_SAFETY_FACTOR),
	);
	const currentInputTokens = estimateTokenCount(params.inputValue);
	const safeCurrentInputTokens = estimateOutboundPromptTokens(
		params.inputValue,
	);
	if (
		outputTokenBudget.outputReserveClamped &&
		getConfig().contextDiagnosticsDebug
	) {
		console.warn(`${NORMAL_CHAT_CONTEXT_LOG_PREFIX} Output token cap clamped`, {
			sessionId: params.sessionId,
			modelId: params.modelId ?? "model1",
			providerId: params.providerId ?? null,
			modelName: params.modelName,
			maxModelContext: params.contextLimits.maxModelContext,
			targetConstructedContext: params.contextLimits.targetConstructedContext,
			configuredMaxTokens: outputTokenBudget.configuredMaxTokens,
			effectiveMaxTokens: outputTokenBudget.effectiveMaxTokens,
			outputReserve: outputTokenBudget.outputReserve,
			promptOverheadReserve,
			tokenSafetyFactor: NORMAL_CHAT_PROMPT_TOKEN_SAFETY_FACTOR,
			outputReserveClamped: true,
		});
	}

	if (inputTokenBudget > 0 && safeCurrentInputTokens <= inputTokenBudget) {
		return { inputValue: params.inputValue, outputTokenBudget };
	}

	const currentMessageTokens = estimateTokenCount(currentMessageSection);
	const contextBudget = Math.max(
		0,
		safeInputTokenBudget - currentMessageTokens - 16,
	);
	const compactedContext = contextPrefix
		? truncateToTokenBudget(contextPrefix, contextBudget)
		: "";
	const budgetedInputValue = [compactedContext, currentMessageSection]
		.filter((part) => part.trim())
		.join("\n\n");
	const finalInputValue =
		inputTokenBudget > 0
			? truncateToTokenBudget(budgetedInputValue, safeInputTokenBudget)
			: currentMessageSection;

	if (getConfig().contextDiagnosticsDebug) {
		console.warn(
			`${NORMAL_CHAT_CONTEXT_LOG_PREFIX} Outbound prompt budget applied`,
			{
				sessionId: params.sessionId,
				modelId: params.modelId ?? "model1",
				providerId: params.providerId ?? null,
				modelName: params.modelName,
				maxModelContext: params.contextLimits.maxModelContext,
				compactionUiThreshold: params.contextLimits.compactionUiThreshold,
				targetConstructedContext: params.contextLimits.targetConstructedContext,
				configuredPromptBudget,
				systemTokens,
				promptOverheadReserve,
				tokenSafetyFactor: NORMAL_CHAT_PROMPT_TOKEN_SAFETY_FACTOR,
				outputReserve,
				configuredMaxTokens: outputTokenBudget.configuredMaxTokens,
				effectiveMaxTokens: outputTokenBudget.effectiveMaxTokens,
				outputReserveClamped: outputTokenBudget.outputReserveClamped,
				inputTokenBudget,
				safeInputTokenBudget,
				beforeInputTokens: currentInputTokens,
				beforeInputTokensWithSafety: safeCurrentInputTokens,
				afterInputTokens: estimateTokenCount(finalInputValue),
				afterInputTokensWithSafety:
					estimateOutboundPromptTokens(finalInputValue),
				automaticCompressionOutcome:
					params.automaticCompression?.outcome ?? "untracked",
				fallbackAfterAutomaticCompression:
					params.automaticCompression?.outcome ?? "untracked",
				automaticCompressionAttempted:
					params.automaticCompression?.attempted ?? false,
				automaticCompressionReason:
					params.automaticCompression?.reason ?? "legacy_budget_guard",
			},
		);
	}

	return { inputValue: finalInputValue, outputTokenBudget };
}

function estimateOutboundPromptFit(params: {
	inputValue: string;
	message: string;
	systemPrompt: string;
	contextLimits: PromptContextLimits;
	maxTokens?: number | null;
}) {
	const { currentMessageSection } = extractCurrentMessageSection(
		params.inputValue,
		params.message,
	);
	const outputTokenBudget = resolveOutputTokenBudget({
		maxTokens: params.maxTokens,
		contextLimits: params.contextLimits,
		systemPrompt: params.systemPrompt,
		currentMessageSection,
	});
	const promptOverheadReserve = resolveNormalChatPromptOverheadReserve(
		params.contextLimits.maxModelContext,
	);
	const configuredPromptBudget = Math.min(
		params.contextLimits.targetConstructedContext,
		Math.max(
			1,
			params.contextLimits.maxModelContext -
				outputTokenBudget.outputReserve -
				promptOverheadReserve,
		),
	);
	const systemTokens = estimateOutboundPromptTokens(params.systemPrompt);
	const inputTokenBudget = configuredPromptBudget - systemTokens;
	const safeInputTokens = estimateOutboundPromptTokens(params.inputValue);
	return {
		overBudget: inputTokenBudget <= 0 || safeInputTokens > inputTokenBudget,
		inputTokenBudget,
		safeInputTokens,
		configuredPromptBudget,
		systemTokens,
		outputReserve: outputTokenBudget.outputReserve,
		promptOverheadReserve,
	};
}

function automaticCompressionResult(
	input: Omit<AutomaticContextCompressionResult, "context"> & {
		context?: ConstructedContextResult | null;
	},
): AutomaticContextCompressionResult {
	return {
		context: input.context ?? null,
		outcome: input.outcome,
		reason: input.reason,
		attempted: input.attempted,
		beforeInputTokensWithSafety: input.beforeInputTokensWithSafety,
		rawSourceTokensWithSafety: input.rawSourceTokensWithSafety,
		sourceMessageCount: input.sourceMessageCount,
		snapshotId: input.snapshotId,
	};
}

function serializeRawSourceMessageForFit(message: {
	role: string;
	content: string;
	thinking?: string | null;
	toolCalls?: unknown;
}): string {
	const parts = [
		`${message.role.toUpperCase()}:`,
		message.content?.trim() ?? "",
	];
	if (message.thinking?.trim()) {
		parts.push(`Thinking:\n${message.thinking.trim()}`);
	}
	if (message.toolCalls != null) {
		parts.push(
			`Tool calls:\n${
				typeof message.toolCalls === "string"
					? message.toolCalls
					: JSON.stringify(message.toolCalls)
			}`,
		);
	}
	return parts.filter((part) => part.trim()).join("\n");
}

function buildRawPendingSourceFitInput(params: {
	sourceMessages: Array<{
		role: string;
		content: string;
		thinking?: string | null;
		toolCalls?: unknown;
	}>;
	message: string;
}): string {
	return [
		"Context from your conversation history:",
		...params.sourceMessages.map(serializeRawSourceMessageForFit),
		`${CURRENT_USER_MESSAGE_MARKER}${params.message.trim()}`,
	]
		.filter((part) => part.trim())
		.join("\n\n");
}

async function maybeRunAutomaticContextCompression(params: {
	user: AuthenticatedPromptUser | undefined;
	sessionId: string;
	message: string;
	modelId: ModelId;
	modelConfig: NormalChatContextModelConfig;
	contextLimits: PromptContextLimits;
	inputValue: string;
	systemPrompt: string;
	attachmentIds?: string[];
	activeDocumentArtifactId?: string;
	attachmentTraceId?: string;
	controlMessageSender?: ContextCompressionControlSender;
	reuseFromContext?: ConstructedContextReuseData;
}): Promise<AutomaticContextCompressionResult> {
	if (!params.user?.id) {
		return automaticCompressionResult({
			outcome: "not_possible",
			reason: "missing_user",
			attempted: false,
		});
	}

	if (!params.controlMessageSender) {
		return automaticCompressionResult({
			outcome: "not_possible",
			reason: "missing_control_message_sender",
			attempted: false,
		});
	}

	const fit = estimateOutboundPromptFit({
		inputValue: params.inputValue,
		message: params.message,
		systemPrompt: params.systemPrompt,
		contextLimits: params.contextLimits,
		maxTokens: params.modelConfig.maxTokens,
	});

	const {
		getLatestValidContextCompressionSnapshot,
		listContextCompressionSourceMessages,
		runContextCompression,
	} = await import("./context-compression");
	const sourceMessages = await listContextCompressionSourceMessages(
		params.sessionId,
	);
	const priorSnapshot = await getLatestValidContextCompressionSnapshot({
		userId: params.user.id,
		conversationId: params.sessionId,
	}).catch(() => null);
	const pendingSourceMessages = priorSnapshot
		? sourceMessages.filter(
				(message) =>
					message.messageSequence > priorSnapshot.sourceEndMessageSequence,
			)
		: sourceMessages;
	if (pendingSourceMessages.length === 0) {
		return automaticCompressionResult({
			outcome: fit.overBudget ? "not_possible" : "not_needed",
			reason: fit.overBudget
				? "no_pending_source_messages"
				: "prompt_within_budget",
			attempted: false,
			beforeInputTokensWithSafety: fit.safeInputTokens,
			sourceMessageCount: 0,
		});
	}

	const rawSourceInputValue = buildRawPendingSourceFitInput({
		sourceMessages: pendingSourceMessages,
		message: params.message,
	});
	const rawSourceFit = estimateOutboundPromptFit({
		inputValue: rawSourceInputValue,
		message: params.message,
		systemPrompt: params.systemPrompt,
		contextLimits: params.contextLimits,
		maxTokens: params.modelConfig.maxTokens,
	});
	if (!fit.overBudget && !rawSourceFit.overBudget) {
		return automaticCompressionResult({
			outcome: "not_needed",
			reason: "prompt_and_raw_source_within_budget",
			attempted: false,
			beforeInputTokensWithSafety: fit.safeInputTokens,
			rawSourceTokensWithSafety: rawSourceFit.safeInputTokens,
			sourceMessageCount: pendingSourceMessages.length,
		});
	}

	console.info(
		`${NORMAL_CHAT_CONTEXT_LOG_PREFIX} Running automatic context compression before model call`,
		{
			sessionId: params.sessionId,
			modelId: params.modelId,
			beforeInputTokensWithSafety: fit.safeInputTokens,
			rawSourceTokensWithSafety: rawSourceFit.safeInputTokens,
			inputTokenBudget: fit.inputTokenBudget,
			sourceMessageCount: pendingSourceMessages.length,
			priorSnapshotId: priorSnapshot?.id ?? null,
		},
	);

	const snapshot = await runContextCompression({
		conversationId: params.sessionId,
		userId: params.user.id,
		trigger: "automatic",
		selectedModelId: params.modelId,
		controlMessageSender: params.controlMessageSender,
		sourceMessages: pendingSourceMessages,
		priorSnapshot,
		sourceTokenEstimate: Math.max(
			fit.safeInputTokens,
			rawSourceFit.safeInputTokens,
		),
		targetTokenEstimate: params.contextLimits.targetConstructedContext,
		budget: {
			maxModelContext: params.contextLimits.maxModelContext,
			targetConstructedContext: params.contextLimits.targetConstructedContext,
		},
	});
	if (snapshot.status !== "valid") {
		console.warn(
			`${NORMAL_CHAT_CONTEXT_LOG_PREFIX} Automatic context compression failed validation`,
			{
				sessionId: params.sessionId,
				modelId: params.modelId,
				snapshotId: snapshot.id,
				failureReason: snapshot.failureReason,
			},
		);
		return automaticCompressionResult({
			outcome: "failed",
			reason: snapshot.failureReason ?? "snapshot_validation_failed",
			attempted: true,
			beforeInputTokensWithSafety: fit.safeInputTokens,
			rawSourceTokensWithSafety: rawSourceFit.safeInputTokens,
			sourceMessageCount: pendingSourceMessages.length,
			snapshotId: snapshot.id,
		});
	}

	const context = await buildConstructedContext({
		userId: params.user.id,
		conversationId: params.sessionId,
		message: params.message,
		attachmentIds: params.attachmentIds,
		activeDocumentArtifactId: params.activeDocumentArtifactId,
		attachmentTraceId: params.attachmentTraceId,
		modelId: params.modelId,
		contextLimits: params.contextLimits,
		reuseFrom: params.reuseFromContext,
	});
	return automaticCompressionResult({
		context,
		outcome: "succeeded",
		reason: "snapshot_valid",
		attempted: true,
		beforeInputTokensWithSafety: fit.safeInputTokens,
		rawSourceTokensWithSafety: rawSourceFit.safeInputTokens,
		sourceMessageCount: pendingSourceMessages.length,
		snapshotId: snapshot.id,
	});
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
				name === "Session Context" ||
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

export function emitOutboundContextTrace(params: {
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
					undefined,
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

type PrepareOutboundChatContextParams = {
	message: string;
	sessionId: string;
	modelConfig: NormalChatContextModelConfig;
	user?: AuthenticatedPromptUser;
	attachmentIds?: string[];
	activeDocumentArtifactId?: string;
	attachmentTraceId?: string;
	systemPromptAppendix?: string;
	personalityPrompt?: string;
	forceWebSearch?: boolean;
	fileProductionToolsAvailable?: boolean;
	skipDefaultRuntimeGuidance?: boolean;
	systemPromptOverride?: string;
	modelId?: ModelId | string;
	contextLimits?: PromptContextLimits;
	compressionControlMessageSender?: ContextCompressionControlSender;
	reasoningDepthEffort?: ReasoningDepthEffort;
	onContextPreparationActivity?: NormalChatContextPreparationActivityCallback;
	// Issue 8.1 — the turn's resolved active capability set (calendar/email/
	// etc.), resolved by the caller (resolveActiveCapabilities) BEFORE calling
	// prepareOutboundChatContext rather than after, specifically so the
	// proactive_connector_context stage can gate its fetch on it. Undefined
	// (older/partial call sites) is treated the same as an empty set — the
	// stage simply injects nothing, never fails the turn.
	activeConnectionCapabilities?: ReadonlySet<Capability>;
	logLabel: string;
};

function applyConstructedContextToPreparationState(
	state: OutboundChatContextPreparationState,
	constructed: ConstructedContextResult,
): OutboundChatContextPreparationState {
	return {
		...state,
		inputValue: constructed.inputValue,
		contextStatus: constructed.contextStatus,
		taskState: constructed.taskState,
		contextDebug: constructed.contextDebug,
		contextTraceSections: constructed.contextTraceSections,
		reuseData: constructed._reuseData,
	};
}

function requirePreparationValue<T>(value: T | undefined, label: string): T {
	if (value === undefined) {
		throw new Error(`Missing normal chat context preparation value: ${label}`);
	}
	return value;
}

// Builds the outbound system prompt from turn-level params only (base
// prompt, model identity, response language, reasoning depth, active
// connections, personality/appendix). None of these depend on the evolving
// `inputValue` — unlike the deleted guidance-pack selector, tool usage
// guidance no longer varies with message content — so this is safe to call
// once per turn; later pipeline stages that splice text into `inputValue`
// (forced web prefetch, proactive connector context, automatic compression)
// do not need to rebuild the system prompt.
function buildPreparationSystemPrompt(
	params: PrepareOutboundChatContextParams,
	state: OutboundChatContextPreparationState,
): { systemPrompt: string } {
	return {
		systemPrompt: buildOutboundSystemPrompt({
			basePrompt: requirePreparationValue(
				state.baseSystemPrompt,
				"baseSystemPrompt",
			),
			inputValue: state.inputValue,
			responseLanguage: detectLanguage(params.message),
			modelDisplayName: params.modelConfig.displayName,
			modelName: params.modelConfig.modelName,
			systemPromptAppendix: params.systemPromptAppendix,
			personalityPrompt: params.personalityPrompt,
			forceWebSearch: params.forceWebSearch,
			fileProductionToolsAvailable: params.fileProductionToolsAvailable,
			reasoningDepthEffort: params.reasoningDepthEffort,
			skipDefaultRuntimeGuidance: params.skipDefaultRuntimeGuidance,
			hasActiveConnections: Boolean(
				params.activeConnectionCapabilities &&
					params.activeConnectionCapabilities.size > 0,
			),
		}),
	};
}

function resolveAutomaticCompressionModelId(
	modelId: ModelId | string | undefined,
): ModelId {
	if (modelId && isProviderModelId(modelId)) {
		return modelId;
	}
	return modelId === "model2" ? "model2" : "model1";
}

type AutomaticContextCompressionStageResult = {
	decision: AutomaticContextCompressionResult;
	rebuiltContext: ConstructedContextResult | null;
};

async function runAutomaticContextCompressionStage(input: {
	params: PrepareOutboundChatContextParams;
	inputValue: string;
	systemPrompt: string;
	contextLimits: PromptContextLimits;
	reuseData?: ConstructedContextReuseData;
}): Promise<AutomaticContextCompressionStageResult> {
	const decision = await maybeRunAutomaticContextCompression({
		user: input.params.user,
		sessionId: input.params.sessionId,
		message: input.params.message,
		modelId: resolveAutomaticCompressionModelId(input.params.modelId),
		modelConfig: input.params.modelConfig,
		contextLimits: input.contextLimits,
		inputValue: input.inputValue,
		systemPrompt: input.systemPrompt,
		attachmentIds: input.params.attachmentIds,
		activeDocumentArtifactId: input.params.activeDocumentArtifactId,
		attachmentTraceId: input.params.attachmentTraceId,
		controlMessageSender: input.params.compressionControlMessageSender,
		reuseFromContext: input.reuseData,
	}).catch((error) => {
		console.warn(
			`${NORMAL_CHAT_CONTEXT_LOG_PREFIX} Automatic context compression skipped`,
			{
				sessionId: input.params.sessionId,
				modelId: input.params.modelId ?? "model1",
				error: error instanceof Error ? error.message : String(error),
			},
		);
		return automaticCompressionResult({
			outcome: "failed",
			reason: error instanceof Error ? error.message : String(error),
			attempted: true,
		});
	});

	if (!decision.context) {
		return {
			decision,
			rebuiltContext: null,
		};
	}

	return {
		decision,
		rebuiltContext: decision.context,
	};
}

async function runForcedWebPrefetchStage(input: {
	params: PrepareOutboundChatContextParams;
	state: OutboundChatContextPreparationState;
}): Promise<
	Pick<
		OutboundChatContextPreparationState,
		"inputValue" | "prefetchedToolCalls"
	>
> {
	const forcedWebPrefetch = await maybePrefetchWebSearch({
		inputValue: input.state.inputValue,
		message: input.params.message,
		forceWebSearch: input.params.forceWebSearch,
		sessionId: input.params.sessionId,
		modelId: input.params.modelId,
	});
	return {
		inputValue: forcedWebPrefetch.inputValue,
		prefetchedToolCalls: forcedWebPrefetch.prefetchedToolCalls,
	};
}

// Issue 8.1 — proactive_connector_context stage. Mirrors
// runForcedWebPrefetchStage above: build the (locality-gated,
// budget-bounded) block in a separate module and splice it in with the SAME
// insertContextBeforeCurrentMessage helper the web-prefetch stage uses.
// Never throws: buildProactiveConnectorContext already fails safe (silently
// skips a broken connector, withholds on distill-unavailable), and the
// `.catch` below is a second backstop so a bug in that module can never
// abort the chat turn — same posture as maybePrefetchWebSearch's own
// try/catch.
async function runProactiveConnectorContextStage(input: {
	params: PrepareOutboundChatContextParams;
	state: OutboundChatContextPreparationState;
}): Promise<Pick<OutboundChatContextPreparationState, "inputValue">> {
	const { params, state } = input;
	const userId = params.user?.id;
	const activeCapabilities = params.activeConnectionCapabilities;
	if (
		!userId ||
		!activeCapabilities ||
		(!activeCapabilities.has("calendar") && !activeCapabilities.has("email"))
	) {
		return { inputValue: state.inputValue };
	}

	const built = await buildProactiveConnectorContext({
		userId,
		conversationId: params.sessionId,
		modelId: params.modelId ?? "model1",
		message: params.message,
		activeCapabilities,
		targetConstructedContextTokens: requirePreparationValue(
			state.contextLimits,
			"contextLimits",
		).targetConstructedContext,
	}).catch((error) => {
		console.warn(
			`${NORMAL_CHAT_CONTEXT_LOG_PREFIX} Proactive connector context skipped`,
			{
				sessionId: params.sessionId,
				modelId: params.modelId ?? "model1",
				error: error instanceof Error ? error.message : String(error),
			},
		);
		return null;
	});

	if (!built) {
		return { inputValue: state.inputValue };
	}

	return {
		inputValue: insertContextBeforeCurrentMessage(
			state.inputValue,
			params.message,
			built.block,
		),
	};
}

function runPromptBudgetStage(input: {
	params: PrepareOutboundChatContextParams;
	state: OutboundChatContextPreparationState;
}): Pick<
	OutboundChatContextPreparationState,
	"inputValue" | "outputTokenBudget"
> {
	const budgetedPrompt = applyOutboundPromptBudget({
		inputValue: input.state.inputValue,
		message: input.params.message,
		systemPrompt: requirePreparationValue(
			input.state.systemPrompt,
			"systemPrompt",
		),
		contextLimits: requirePreparationValue(
			input.state.contextLimits,
			"contextLimits",
		),
		maxTokens: input.params.modelConfig.maxTokens,
		sessionId: input.params.sessionId,
		modelId: input.params.modelId ?? "model1",
		modelName: input.params.modelConfig.modelName,
		providerId: input.params.modelConfig.providerId ?? null,
		automaticCompression: input.state.automaticCompression,
	});
	return {
		inputValue: budgetedPrompt.inputValue,
		outputTokenBudget: budgetedPrompt.outputTokenBudget,
	};
}

export async function prepareOutboundChatContext(
	params: PrepareOutboundChatContextParams,
): Promise<PreparedOutboundChatContext> {
	let runtimeConfig: RuntimeConfig | undefined;
	const getPreparationConfig = () => {
		runtimeConfig ??= getConfig();
		return runtimeConfig;
	};
	const contextLimits =
		params.contextLimits ??
		resolvePromptContextLimits(
			params.modelId ?? "model1",
			params.modelConfig,
			getPreparationConfig(),
		);
	const { state, timings } =
		await runNormalChatContextPreparationStages<OutboundChatContextPreparationState>(
			{
				plan: getDefaultNormalChatContextPreparationPlan(),
				initialState: {
					inputValue: params.message,
					prefetchedToolCalls: [],
					contextLimits,
				} satisfies OutboundChatContextPreparationState,
				handlers: {
					plan: (currentState) => currentState,
					constructed_context: async (currentState) => {
						if (!params.user?.id) {
							return currentState;
						}

						const constructed = await buildConstructedContext({
							userId: params.user.id,
							conversationId: params.sessionId,
							message: params.message,
							attachmentIds: params.attachmentIds,
							activeDocumentArtifactId: params.activeDocumentArtifactId,
							attachmentTraceId: params.attachmentTraceId,
							modelId: params.modelId,
							contextLimits,
						});
						return applyConstructedContextToPreparationState(
							currentState,
							constructed,
						);
					},
					attachment_trace: (currentState) => {
						const attachmentSection = summarizeAttachmentSectionInInput(
							currentState.inputValue,
						);
						if ((params.attachmentIds?.length ?? 0) > 0) {
							logAttachmentTrace("normal_chat_context", {
								traceId: params.attachmentTraceId ?? null,
								sessionId: params.sessionId,
								inputValueLength: currentState.inputValue.length,
								hasCurrentAttachmentsMarker: attachmentSection.hasMarker,
								attachmentSectionPreview: attachmentSection.preview,
								attachmentSectionPreviewHash: attachmentSection.previewHash,
							});
							if (!attachmentSection.hasMarker) {
								console.warn(
									`${NORMAL_CHAT_CONTEXT_LOG_PREFIX} Attachment marker missing from outgoing ${params.logLabel}`,
									{
										sessionId: params.sessionId,
										attachmentIds: params.attachmentIds ?? [],
										traceId: params.attachmentTraceId ?? null,
										inputValueLength: currentState.inputValue.length,
									},
								);
							}
						}
						return currentState;
					},
					base_prompt: async () => {
						const configuredBasePrompt =
							params.systemPromptOverride ??
							(getPreparationConfig().systemPrompt ||
								params.modelConfig.systemPrompt);
						const baseSystemPrompt =
							params.user?.id && !params.systemPromptOverride
								? await buildEnhancedSystemPrompt(configuredBasePrompt, {
										userId: params.user.id,
										displayName: params.user.displayName,
										email: params.user.email,
									})
								: getSystemPrompt(configuredBasePrompt);
						return { baseSystemPrompt };
					},
					system_prompt: (currentState) => ({
						...buildPreparationSystemPrompt(params, currentState),
					}),
					automatic_compression: async (currentState) => {
						const contextLimits = requirePreparationValue(
							currentState.contextLimits,
							"contextLimits",
						);
						const systemPrompt = requirePreparationValue(
							currentState.systemPrompt,
							"systemPrompt",
						);
						const compressionStage = await runAutomaticContextCompressionStage({
							params,
							inputValue: currentState.inputValue,
							systemPrompt,
							contextLimits,
							reuseData: currentState.reuseData,
						});
						let nextState: OutboundChatContextPreparationState = {
							...currentState,
							contextLimits,
							automaticCompression: compressionStage.decision,
						};
						if (compressionStage.rebuiltContext) {
							// The system prompt does not depend on `inputValue` any more
							// (see buildPreparationSystemPrompt), so a rebuilt constructed
							// context does NOT require rebuilding `systemPrompt` here —
							// only the context-derived fields (inputValue, contextStatus,
							// etc.) need to move onto the compressed context.
							nextState = applyConstructedContextToPreparationState(
								nextState,
								compressionStage.rebuiltContext,
							);
						}
						return nextState;
					},
					forced_web_prefetch: async (currentState) => {
						return runForcedWebPrefetchStage({
							params,
							state: currentState,
						});
					},
					proactive_connector_context: async (currentState) => {
						return runProactiveConnectorContextStage({
							params,
							state: currentState,
						});
					},
					prompt_budget: (currentState) => {
						return runPromptBudgetStage({
							params,
							state: currentState,
						});
					},
				},
				onActivity: params.onContextPreparationActivity,
			},
		);

	return {
		inputValue: state.inputValue,
		systemPrompt: requirePreparationValue(state.systemPrompt, "systemPrompt"),
		contextStatus: state.contextStatus,
		taskState: state.taskState,
		contextDebug: state.contextDebug,
		contextTraceSections: state.contextTraceSections,
		prefetchedToolCalls: state.prefetchedToolCalls,
		outputTokenBudget: requirePreparationValue(
			state.outputTokenBudget,
			"outputTokenBudget",
		),
		contextLimits: requirePreparationValue(
			state.contextLimits,
			"contextLimits",
		),
		contextPreparationTimings: timings.map((timing) => ({ ...timing })),
	};
}
