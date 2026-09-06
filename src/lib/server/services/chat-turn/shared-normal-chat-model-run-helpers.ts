import type { ModelMessage, ToolChoice, ToolSet } from "ai";
import type { ModelId } from "$lib/model-types";
import type { ThinkingMode } from "$lib/reasoning-depth-types";
import { getConfig, type RuntimeConfig } from "$lib/server/config-store";
import type { ModelConfig } from "$lib/server/env";
import type { DepthMetadata } from "$lib/server/services/chat-turn/depth-metadata-types";
import {
	selectNormalChatToolsForRequest,
	shouldExposeFileProductionTools,
} from "$lib/server/services/chat-turn/normal-chat-tool-gating";
import { resolveReasoningDepthEffort } from "$lib/server/services/chat-turn/reasoning-depth-effort";
import type { Capability } from "$lib/server/services/connections/registry";
import { detectLanguage } from "$lib/server/services/language";
import { isMemoryActiveForConversation } from "$lib/server/services/memory-controls";
import type { ToolCallEntry } from "$lib/server/services/messages-types";
import {
	type AuthenticatedPromptUser,
	estimateOutboundPromptTokenTotal,
	type PromptContextLimits,
	prepareOutboundChatContext,
	resolvePromptContextLimits,
} from "$lib/server/services/normal-chat-context";
import { createNormalChatContextPreparationActivityHandler } from "$lib/server/services/normal-chat-context-preparation";
import {
	type NormalChatModelRunProvider,
	resolveNormalChatModelRunProvider,
} from "$lib/server/services/normal-chat-model";
import { resolveHistoryToolMessagesMode } from "$lib/server/services/normal-chat-model/provider-compatibility";
import {
	createNormalChatTools,
	createToolCallRecorder,
} from "$lib/server/services/normal-chat-tools";
import {
	buildSkillCatalogueBlock,
	listSkillCatalogueEntries,
} from "$lib/server/services/skills/prompt-context";
import { seedBuiltInSystemSkillDefinitions } from "$lib/server/services/skills/user-skills";
import { estimateTokenCount } from "$lib/utils/tokens";
import { estimateHistoryMessagesTokens } from "./conversation-history";

export function isEvidenceReadyToolCall(toolCall: ToolCallEntry): boolean {
	return (
		toolCall.status === "done" &&
		toolCall.metadata?.ok !== false &&
		toolCall.metadata?.evidenceReady !== false
	);
}

export function createRequestAbortSignal(
	timeoutMs: number,
	signal?: AbortSignal,
): AbortSignal | undefined {
	const timeoutSignal =
		Number.isFinite(timeoutMs) && timeoutMs > 0
			? AbortSignal.timeout(timeoutMs)
			: undefined;
	const signals = [signal, timeoutSignal].filter(
		(value): value is AbortSignal => Boolean(value),
	);
	if (signals.length === 0) return undefined;
	if (signals.length === 1) return signals[0];
	return AbortSignal.any(signals);
}

export function resolvePromptModelConfig(params: {
	modelId: ModelId;
	provider: {
		baseUrl: string;
		apiKey: string;
		modelName: string;
		displayName: string;
		maxOutputTokens?: number;
		maxModelContext?: number;
		compactionUiThreshold?: number;
		targetConstructedContext?: number;
	};
	runtimeConfig: RuntimeConfig;
}): ModelConfig {
	const baseModelConfig =
		params.modelId === "model2"
			? params.runtimeConfig.model2
			: params.runtimeConfig.model1;

	if (params.modelId === "model2") return baseModelConfig;
	if (params.modelId === "model1") return baseModelConfig;

	return {
		...baseModelConfig,
		systemPrompt:
			params.runtimeConfig.systemPrompt || baseModelConfig.systemPrompt,
		baseUrl: params.provider.baseUrl,
		apiKey: params.provider.apiKey,
		modelName: params.provider.modelName,
		displayName: params.provider.displayName,
		maxTokens: params.provider.maxOutputTokens ?? baseModelConfig.maxTokens,
	};
}

/**
 * Count of tool schemas that will ride the provider request. Feeds the
 * fallback prompt-size estimate used by the context usage ring when the
 * provider reports no input tokens.
 */
export function countToolPackTools(tools: ToolPack["tools"]): number {
	return tools ? Object.keys(tools).length : 0;
}

/**
 * Full-prompt estimate for a turn (system prompt + final outbound packet +
 * tool schemas). Computed once the outbound context and tool pack are final,
 * so it reflects everything the provider actually receives that we can see.
 */
export function estimateTurnPromptTokens(params: {
	prepared: PreparedModelContext;
	inputValue: string;
	tools: ToolPack["tools"];
}): number {
	return (
		estimateOutboundPromptTokenTotal({
			systemPrompt: params.prepared.systemPrompt,
			inputValue: params.inputValue,
			toolCount: countToolPackTools(params.tools),
		}) +
		estimateHistoryMessagesTokens(
			params.prepared.historyMessages ?? [],
			estimateTokenCount,
		)
	);
}

// --- Shared send-model param type and helpers (plain + streaming) ---
//
// Both the plain and streaming send-model entry points share the same
// four-step orchestration (provider runtime → depth effort → outbound
// context → tool pack). Those steps live here so they exist once (AGENTS.md:
// "Shared behavior should exist once. Do not copy logic between send and
// stream.").
//
// The two param types differ only in that the PLAIN type carries
// `disableTools` and `forceProduceFileTool` (the streaming path never forces
// `produce_file` tool-choice and never disables tools). Both types are
// assignable to the base type below because those two fields are optional.
// The streaming entry point passes a normalized `{ ...params, disableTools:
// false, forceProduceFileTool: false }` object to the shared helpers so the
// shared code can treat `disableTools`/`forceProduceFileTool` uniformly.

export type NormalChatSendModelBaseParams = {
	userId: string;
	runtimeConfig: RuntimeConfig;
	message: string;
	conversationId: string;
	modelId: ModelId | undefined;
	user?: AuthenticatedPromptUser;
	attachmentIds?: string[];
	activeDocumentArtifactId?: string;
	attachmentTraceId?: string;
	systemPromptAppendix?: string;
	// An explicit `$` composer selection's full instructions, resolved during
	// preflight (see chat-turn/types.ts's AppliedSkillContext) and forced into
	// this turn's packet only — no durable session row. See
	// normal-chat-context.ts's buildTurnGuidance.
	pendingSkillInstructions?: string | null;
	// Messages appended after the current user turn (a non-streaming
	// continuation replays the interrupted attempt's tool calls/results here).
	continuationMessages?: ModelMessage[];
	personalityPrompt?: string;
	thinkingMode?: ThinkingMode;
	depthMetadata?: DepthMetadata;
	forceWebSearch?: boolean;
	enabledConnectionCapabilities?: string[];
	createTurnId?: () => string;
	signal?: AbortSignal;
	/** Withhold all tools (memory recall, file-production, connections). Plain-only. */
	disableTools?: boolean;
	/** Force the `produce_file` tool-choice. Plain-only; streaming never forces it. */
	forceProduceFileTool?: boolean;
	overrideProvider?: NormalChatModelRunProvider;
	onContextPreparationActivity?: Parameters<
		typeof createNormalChatContextPreparationActivityHandler
	>[0]["onContextPreparationActivity"];
	onResponseActivity?: (
		entry: import("$lib/response-activity-types").ResponseActivityEntry,
	) => void;
};

export type DepthEffort = Awaited<
	ReturnType<typeof resolveReasoningDepthEffort>
> | null;

export type PreparedModelContext = Awaited<
	ReturnType<typeof prepareOutboundChatContext>
>;

type NormalChatModelTools = Partial<
	ReturnType<typeof createNormalChatTools>["tools"]
>;

export type ProviderRuntime = {
	modelId: ModelId;
	provider: NormalChatModelRunProvider;
	modelConfig: ReturnType<typeof resolvePromptModelConfig>;
	baseContextLimits: PromptContextLimits;
	depthEffort: DepthEffort;
};

export type ActiveDepthEffort = NonNullable<DepthEffort> & {
	depthMetadata: DepthMetadata;
};

export type ToolPack = {
	tools: NormalChatModelTools | undefined;
	recorder: ReturnType<typeof createToolCallRecorder>;
	getToolCalls: ReturnType<typeof createNormalChatTools>["getToolCalls"];
};

/**
 * A forced-web-search turn no longer prefetches (see maybePrefetchWebSearch
 * in normal-chat-context.ts) — instead the model's FIRST tool-call step is
 * forced to research_web, so it always runs its own (possibly better)
 * query instead of the raw user message, and every later step's tool choice
 * stays automatic (forcing it every step would loop forever). Returns
 * `undefined` when the turn isn't a forced-search turn, or the tool set
 * doesn't expose research_web (e.g. Parallel isn't configured) — a caller
 * can pass the result straight through to `firstStepToolChoice` without a
 * null check.
 */
export function resolveForcedResearchWebFirstStepToolChoice(params: {
	forceWebSearch?: boolean;
	tools: ToolPack["tools"];
}): ToolChoice<ToolSet> | undefined {
	if (!params.forceWebSearch) return undefined;
	if (!params.tools?.research_web) return undefined;
	return { type: "tool", toolName: "research_web" };
}

export async function resolveProviderRuntime(
	params: NormalChatSendModelBaseParams,
): Promise<ProviderRuntime> {
	const modelId = params.modelId ?? "model1";
	const provider =
		params.overrideProvider ??
		(await resolveNormalChatModelRunProvider(modelId, params.runtimeConfig));
	const modelConfig = resolvePromptModelConfig({
		modelId,
		provider,
		runtimeConfig: params.runtimeConfig,
	});
	const baseContextLimits = resolvePromptContextLimits({
		modelId,
		provider,
		runtimeConfig: params.runtimeConfig,
	});
	const depthEffort = params.depthMetadata
		? resolveReasoningDepthEffort({
				depthMetadata: params.depthMetadata,
				provider,
				forceWebSearch: params.forceWebSearch,
			})
		: null;

	return {
		modelId,
		provider,
		modelConfig,
		baseContextLimits,
		depthEffort,
	};
}

// Depth clarification used to be able to rewrite `depthMetadata` ahead of the
// turn (ADR-0061); now that the gate is gone, this is a typed passthrough
// (DepthEffort -> ActiveDepthEffort) kept so callers don't need to reason
// about `depthEffort` being possibly null at each call site.
export function resolveActiveDepthEffort(
	depthEffort: DepthEffort,
): ActiveDepthEffort | null {
	return depthEffort;
}

// On-demand skill loading's per-turn catalogue line: resolved here (not as a
// context-preparation pipeline stage) because it only needs the userId and
// response language already available to every caller of
// prepareOutboundContext. Fails open (no catalogue) on any lookup error, same
// posture as every other best-effort context addition in this file.
async function resolveSkillCatalogueBlock(
	userId: string | undefined,
	message: string,
): Promise<string | null> {
	if (!userId || !getConfig().composerCommandRegistryEnabled) return null;
	try {
		await ensureBuiltInSystemSkillsSeeded(userId);
		const entries = await listSkillCatalogueEntries(
			userId,
			detectLanguage(message),
		);
		return buildSkillCatalogueBlock(entries);
	} catch {
		return null;
	}
}

// Built-in system packs are seeded (and refreshed to the current pack text)
// by the three skills HTTP routes. On-demand loading made the chat turn the
// primary consumer, and it touches none of them: without this, a database
// where nobody opened the `$` picker or the Skills settings tab has no system
// packs to put in the catalogue, and a pack rewrite shipped in a deploy never
// reaches the model. Seeding is idempotent and pack text only changes with a
// deploy, so once per process is enough; a failure clears the memo so the
// next turn retries.
let builtInSystemSkillSeed: Promise<void> | null = null;

async function ensureBuiltInSystemSkillsSeeded(userId: string): Promise<void> {
	builtInSystemSkillSeed ??= seedBuiltInSystemSkillDefinitions(userId).catch(
		(error: unknown) => {
			builtInSystemSkillSeed = null;
			throw error;
		},
	);
	await builtInSystemSkillSeed;
}

export async function prepareOutboundContext(
	params: NormalChatSendModelBaseParams,
	runtime: ProviderRuntime,
	activeDepthEffort: ActiveDepthEffort | null,
	enabledConnectionCapabilities: Set<Capability>,
	logLabel = "provider request",
): Promise<PreparedModelContext> {
	const skillCatalogueBlock = await resolveSkillCatalogueBlock(
		params.userId,
		params.message,
	);
	// The model's configured max output tokens and context limits are passed
	// through untouched: reasoning depth never shrinks the output reserve or
	// the constructed-context target (those are fixed per model). Depth only
	// reaches context prep via `reasoningDepthEffort` (guidance + tool budget).
	return prepareOutboundChatContext({
		message: params.message,
		sessionId: params.conversationId,
		modelConfig: runtime.modelConfig,
		user: params.user,
		attachmentIds: params.attachmentIds,
		activeDocumentArtifactId: params.activeDocumentArtifactId,
		attachmentTraceId: params.attachmentTraceId,
		systemPromptAppendix: params.systemPromptAppendix,
		personalityPrompt: params.personalityPrompt,
		forceWebSearch: params.forceWebSearch,
		fileProductionToolsAvailable:
			!params.disableTools &&
			shouldExposeFileProductionTools({
				message: params.message,
				forceProduceFileTool: params.forceProduceFileTool,
			}),
		modelId: runtime.modelId,
		contextLimits: runtime.baseContextLimits,
		reasoningDepthEffort: activeDepthEffort ?? undefined,
		activeConnectionCapabilities: enabledConnectionCapabilities,
		historyToolMessages: resolveHistoryToolMessagesMode(runtime.provider),
		skillCatalogueBlock,
		pendingSkillInstructions: params.pendingSkillInstructions,
		onContextPreparationActivity:
			createNormalChatContextPreparationActivityHandler(params),
		logLabel,
	});
}

// Ready on-demand routing regions, for the map_route description. Fails open
// (no label) so a region-manager hiccup never blocks a turn.
async function resolveRoutingCoverageLabel(): Promise<string | null> {
	if (!getConfig().routingOnDemandEnabled) return null;
	try {
		const { getRoutingRegionManager } = await import(
			"$lib/server/services/routing/region-runtime"
		);
		const ready = await getRoutingRegionManager().listReadyRegions();
		return ready.length > 0
			? ready.map((row) => row.name).join(", ")
			: "none yet";
	} catch {
		return null;
	}
}

export async function createToolPack(
	params: NormalChatSendModelBaseParams,
	turnId: string,
	activeDepthEffort: ActiveDepthEffort | null,
	modelId: ModelId,
	enabledConnectionCapabilities: Set<Capability>,
): Promise<ToolPack> {
	const routingCoverageLabel = await resolveRoutingCoverageLabel();
	const normalChatTools = createNormalChatTools({
		userId: params.userId,
		conversationId: params.conversationId,
		turnId,
		requestText: params.message,
		language: detectLanguage(params.message),
		enabledConnectionCapabilities,
		modelId,
		...(routingCoverageLabel ? { routingCoverageLabel } : {}),
		...(activeDepthEffort
			? { webSourceBudget: activeDepthEffort.webSourceBudget }
			: {}),
	});

	// Read-side master gate for the recall tool. Single source of truth; fail
	// open (active) so a controls-lookup hiccup never silently drops recall.
	const memoryActive = params.disableTools
		? false
		: await isMemoryActiveForConversation({
				userId: params.userId,
				conversationId: params.conversationId,
			}).catch(() => true);

	return {
		tools: params.disableTools
			? undefined
			: selectNormalChatToolsForRequest(normalChatTools.tools, {
					message: params.message,
					forceProduceFileTool: params.forceProduceFileTool,
					memoryActive,
					skillsEnabled: getConfig().composerCommandRegistryEnabled,
				}),
		recorder: normalChatTools.recorder ?? createToolCallRecorder(),
		getToolCalls: normalChatTools.getToolCalls,
	};
}
