import type { ModelMessage } from "ai";
import type { ModelId } from "$lib/model-types";
import type { ThinkingMode } from "$lib/reasoning-depth-types";
import {
	getConfig,
	isImageMakingConfigured,
	type RuntimeConfig,
} from "$lib/server/config-store";
import type { ModelConfig } from "$lib/server/env";
import { resolveArtifactCatalogueBlock } from "$lib/server/services/artifacts";
import type { DepthMetadata } from "$lib/server/services/chat-turn/depth-metadata-types";
import { selectNormalChatToolsForRequest } from "$lib/server/services/chat-turn/normal-chat-tool-gating";
import { resolveReasoningDepthEffort } from "$lib/server/services/chat-turn/reasoning-depth-effort";
import type { Capability } from "$lib/server/services/connections/registry";
import type { ContextCompressionControlSender } from "$lib/server/services/context-compression";
import { isExplicitFilterOnFor } from "$lib/server/services/images/picture-check/policy";
import type { TurnPictureIndex } from "$lib/server/services/images/turn-pictures";
import type { TurnTakes } from "$lib/server/services/images/turn-takes";
import { resolveTurnInstructions } from "$lib/server/services/instructions";
import {
	isConversationIncognito,
	isMemoryActiveForConversation,
} from "$lib/server/services/memory-controls";
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
	SKILL_DRAFT_GUIDANCE,
} from "$lib/server/services/skills/prompt-context";
import { seedBuiltInSystemSkillDefinitions } from "$lib/server/services/skills/user-skills";
import { scheduleImageDescriptions } from "$lib/server/services/vision/describe";
import { providerCanSeeImages } from "$lib/server/services/vision/model-vision";
import {
	createStepImageQueue,
	type StepImageQueue,
} from "$lib/server/services/vision/step-images";
import { sumTurnImageTokens } from "$lib/server/services/vision/turn-images";
import type {
	ImageMarksRequest,
	PictureRef,
} from "$lib/shared/artifacts/image-body";
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
 * tool schemas + the pictures of the current message). Computed once the
 * outbound context and tool pack are final, so it reflects everything the
 * provider actually receives that we can see.
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
		) +
		sumTurnImageTokens(params.prepared.turnPictureImages)
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
	// The card pictures attached to this message and the marks drawn on one
	// picture (see chat-turn/request.ts).
	pictureRefs?: PictureRef[];
	imageMarks?: ImageMarksRequest | null;
	/**
	 * What this turn has made with `make_image`, shared by every model run of the
	 * turn (the stream and its non-stream rerun), so a rerun finds the cards and
	 * takes already made instead of making the picture again.
	 */
	turnTakes?: TurnTakes;
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
	/**
	 * A tool that waits on slow work (a picture being made) calls this about once
	 * a second so the stream's idle watchdog counts the wait as activity.
	 */
	onToolActivity?: () => void;
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
	/**
	 * This turn's queue of pictures a tool wants the model to see (the photos
	 * tool queues Immich thumbnails when the model asks to look). The tools are
	 * built with it and the model run is given the same one, which hands the
	 * pictures over in the step after the tool result (vision/AGENTS.md).
	 */
	stepImages: StepImageQueue;
};

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

// On-demand skill loading's per-turn prompt text: the compact "## Skills
// available" catalogue line plus the rules for drafting a new skill, resolved
// here (not as a context-preparation pipeline stage) because they only need the
// userId already available to every caller of prepareOutboundContext. Both are
// English whatever the person writes: they are scaffolding the model reads, not
// text the person does. The catalogue fails open (no catalogue) on any lookup
// error, same posture as every other best-effort context addition in this file;
// the drafting rules need no read, so a failed lookup must not take them too.
// Both are gated on the composer registry flag, which also gates the Skill
// Draft Card's Save route.
async function resolveSkillPromptContext(userId: string | undefined): Promise<{
	catalogueBlock: string | null;
	draftGuidance: string | null;
}> {
	if (!userId || !getConfig().composerCommandRegistryEnabled) {
		return { catalogueBlock: null, draftGuidance: null };
	}
	const draftGuidance = SKILL_DRAFT_GUIDANCE;
	try {
		await ensureBuiltInSystemSkillsSeeded(userId);
		const entries = await listSkillCatalogueEntries(userId);
		return { catalogueBlock: buildSkillCatalogueBlock(entries), draftGuidance };
	} catch {
		return { catalogueBlock: null, draftGuidance };
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

// Automatic context compression (normal-chat-context.ts) summarizes the
// conversation through the same JSON control call the manual compression
// route uses. Loaded lazily: it only runs on the rare turn whose context no
// longer fits, so ordinary turns never load the control-model module for it.
const sendCompressionControlMessage: ContextCompressionControlSender = async (
	message,
	modelId,
	options,
) => {
	const { sendJsonControlMessage } = await import(
		"$lib/server/services/normal-chat-control-model"
	);
	return sendJsonControlMessage(message, modelId, options);
};

export async function prepareOutboundContext(
	params: NormalChatSendModelBaseParams,
	runtime: ProviderRuntime,
	activeDepthEffort: ActiveDepthEffort | null,
	enabledConnectionCapabilities: Set<Capability>,
	logLabel = "provider request",
): Promise<PreparedModelContext> {
	const {
		catalogueBlock: skillCatalogueBlock,
		draftGuidance: skillDraftGuidance,
	} = await resolveSkillPromptContext(params.userId);
	// The "## In this chat" artifact catalogue: a fact about the conversation
	// (what it has already made), resolved here for the same reason the skill
	// catalogue is — it needs a DB read prepareOutboundChatContext does not
	// perform. Fails open (see resolveArtifactCatalogueBlock) so a lookup
	// error never blocks a turn.
	const artifactCatalogueBlock = params.userId
		? await resolveArtifactCatalogueBlock({
				userId: params.userId,
				conversationId: params.conversationId,
			})
		: null;
	// Standing guidance is resolved here, once per turn, and passed in as
	// data: prompt assembly renders it and never reads for it. Unlike the
	// catalogue block these do NOT ride the user packet — short messages skip
	// the packet's folder sections, so instructions put there would silently
	// not apply on exactly the turns people type fastest.
	const instructions = await resolveTurnInstructions({
		userId: params.userId,
		conversationId: params.conversationId,
	});
	// The model's configured max output tokens and context limits are passed
	// through untouched: reasoning depth never shrinks the output reserve or
	// the constructed-context target (those are fixed per model). Depth only
	// reaches context prep via `reasoningDepthEffort` (guidance + tool budget).
	const prepared = await prepareOutboundChatContext({
		message: params.message,
		sessionId: params.conversationId,
		modelConfig: runtime.modelConfig,
		user: params.user,
		attachmentIds: params.attachmentIds,
		activeDocumentArtifactId: params.activeDocumentArtifactId,
		pictureRefs: params.pictureRefs,
		imageMarks: params.imageMarks,
		attachmentTraceId: params.attachmentTraceId,
		systemPromptAppendix: params.systemPromptAppendix,
		personalityPrompt: params.personalityPrompt,
		instructions,
		forceWebSearch: params.forceWebSearch,
		modelId: runtime.modelId,
		contextLimits: runtime.baseContextLimits,
		// Without a sender the automatic compression stage reports
		// `missing_control_message_sender` and never compresses.
		compressionControlMessageSender: sendCompressionControlMessage,
		signal: params.signal,
		reasoningDepthEffort: activeDepthEffort ?? undefined,
		activeConnectionCapabilities: enabledConnectionCapabilities,
		historyToolMessages: resolveHistoryToolMessagesMode(runtime.provider),
		// Pixels are prepared only for a model the admin marked "Can see images".
		collectImages: providerCanSeeImages(runtime.provider),
		skillCatalogueBlock,
		skillDraftGuidance,
		pendingSkillInstructions: params.pendingSkillInstructions,
		artifactCatalogueBlock,
		onContextPreparationActivity:
			createNormalChatContextPreparationActivityHandler(params),
		logLabel,
	});
	// The pictures this turn sends are described once, in the background, so the
	// turns after it carry a few words instead of the pixels (vision/AGENTS.md).
	// `currentImages` is the UPLOADED pictures alone (R15: an image file is never
	// described) and is empty unless the model can see; nothing here waits for the
	// descriptions or can fail the turn.
	if (prepared.currentImages.length > 0) {
		scheduleImageDescriptions({
			userId: params.userId,
			provider: runtime.provider,
			images: prepared.currentImages,
		});
	}
	return prepared;
}

// Ready on-demand routing regions (and, separately, the ones whose public
// transport timetables are loaded) for the map_route description. Fails open
// (no labels) so a region-manager hiccup never blocks a turn.
async function resolveRoutingCoverageLabels(): Promise<{
	routing: string | null;
	transit: string | null;
}> {
	if (!getConfig().routingOnDemandEnabled)
		return { routing: null, transit: null };
	try {
		const { getRoutingRegionManager } = await import(
			"$lib/server/services/routing/region-runtime"
		);
		const [{ loadedGtfsFeedIds }, { transitCoverageLabelFor }] =
			await Promise.all([
				import("$lib/server/services/routing/region-manager"),
				import("$lib/server/services/routing/gtfs-catalogue"),
			]);
		const ready = await getRoutingRegionManager().listReadyRegions();
		// The timetable label names what ACTUALLY loaded, feed by feed, so the
		// model is told "Hungary (national coverage: …)" only when the rail and
		// coach feeds really are in the graph.
		const transit = ready
			.filter((row) => row.transitStatus === "ready")
			.map((row) =>
				transitCoverageLabelFor(
					row.id,
					row.name,
					loadedGtfsFeedIds(row.gtfsFeeds),
				),
			);
		return {
			routing:
				ready.length > 0 ? ready.map((row) => row.name).join(", ") : "none yet",
			transit: transit.length > 0 ? transit.join(", ") : null,
		};
	} catch {
		return { routing: null, transit: null };
	}
}

export async function createToolPack(
	params: NormalChatSendModelBaseParams,
	turnId: string,
	activeDepthEffort: ActiveDepthEffort | null,
	modelId: ModelId,
	enabledConnectionCapabilities: Set<Capability>,
	turnPictures: TurnPictureIndex,
): Promise<ToolPack> {
	const routingCoverage = await resolveRoutingCoverageLabels();
	const routingCoverageLabel = routingCoverage.routing;
	// One queue for the turn, shared by the tools that fill it and the model run
	// that empties it (every attempt of the run, failover included).
	const stepImages = createStepImageQueue();
	// Whether make_image's description tells the model to decline explicit
	// pictures; only read when there is a make_image to describe.
	const explicitPictureFilter = isImageMakingConfigured(getConfig())
		? await isExplicitFilterOnFor(params.userId)
		: null;
	const normalChatTools = createNormalChatTools({
		userId: params.userId,
		conversationId: params.conversationId,
		turnId,
		requestText: params.message,
		enabledConnectionCapabilities,
		modelId,
		stepImages,
		turnPictures,
		...(explicitPictureFilter === null ? {} : { explicitPictureFilter }),
		...(params.turnTakes ? { turnTakes: params.turnTakes } : {}),
		...(params.onToolActivity ? { onToolActivity: params.onToolActivity } : {}),
		...(routingCoverageLabel ? { routingCoverageLabel } : {}),
		...(routingCoverage.transit
			? { routingTransitCoverageLabel: routingCoverage.transit }
			: {}),
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
	// Incognito is resolved on its own, never through `memoryActive`: the
	// instruction *offer* is what incognito withholds, while the instructions
	// themselves keep applying there. Fails to "not incognito" on a lookup
	// error, matching isConversationIncognito's own default — and because a
	// conversation is incognito for its whole life, this gate cannot vary
	// mid-conversation anyway. Skipped entirely for a turn with no tools at
	// all, where there is no catalogue to gate.
	const incognito = params.disableTools
		? false
		: await isConversationIncognito(params.conversationId).catch(() => false);

	return {
		tools: params.disableTools
			? undefined
			: selectNormalChatToolsForRequest(normalChatTools.tools, {
					message: params.message,
					forceProduceFileTool: params.forceProduceFileTool,
					memoryActive,
					skillsEnabled: getConfig().composerCommandRegistryEnabled,
					incognito,
				}),
		recorder: normalChatTools.recorder ?? createToolCallRecorder(),
		getToolCalls: normalChatTools.getToolCalls,
		stepImages,
	};
}
