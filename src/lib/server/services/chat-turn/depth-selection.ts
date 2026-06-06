import { eq } from "drizzle-orm";
import { getConfig, isModelEnabled } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { messages } from "$lib/server/db/schema";
import { messageOrderDesc } from "$lib/server/services/message-ordering";
import { sendJsonControlMessage } from "$lib/server/services/normal-chat-control-model";
import { listEnabledProviderModels } from "$lib/server/services/provider-models";
import { getProviderWithSecrets } from "$lib/server/services/providers";
import type {
	DeepResearchDepth,
	DepthAppliedProfile,
	DepthSelectionSignals,
	DepthMetadata,
	LinkedContextSource,
	ModelId,
	PendingSkillSelection,
	ReasoningDepth,
} from "$lib/types";

const CLASSIFIER_MAX_TOKENS = 192;
const MAX_REQUEST_CHARS = 2_000;
const MAX_RECENT_MESSAGES = 4;
const MAX_RECENT_MESSAGE_CHARS = 500;
const MAX_LINKED_SOURCES = 8;
const MAX_SOURCE_NAME_CHARS = 120;
const MAX_ATTACHMENT_IDS = 8;
const MAX_CONTEXT_CHARS = 6_000;

const DEPTH_CLASSIFICATION_SCHEMA = {
	type: "object",
	properties: {
		appliedProfile: {
			type: "string",
			enum: ["standard", "extended", "maximum"],
		},
		reason: {
			type: "string",
		},
		groundingNeed: {
			type: "string",
			enum: ["none", "possible", "useful", "required"],
		},
		contextBreadth: {
			type: "string",
			enum: ["narrow", "normal", "broad"],
		},
		outputRoom: {
			type: "string",
			enum: ["concise", "normal", "expanded"],
		},
		toolUse: {
			type: "string",
			enum: ["none", "normal", "source_heavy"],
		},
	},
	required: [
		"appliedProfile",
		"reason",
		"groundingNeed",
		"contextBreadth",
		"outputRoom",
		"toolUse",
	],
	additionalProperties: false,
};

const DEPTH_CLASSIFIER_SYSTEM_PROMPT = [
	"You classify the reasoning depth needed for one normal chat turn.",
	"Return only JSON matching the schema.",
	"Allowed appliedProfile values: standard, extended, maximum.",
	"Never choose off. Off is only available through explicit user selection outside this classifier.",
	"Prefer standard for ordinary direct answers, transformations, summaries, and simple coding help.",
	"Use extended for multi-step analysis, comparisons, debugging, planning, or requests with several constraints.",
	"Reserve maximum for clearly hard, high-value, ambiguous, long-horizon, or failure-sensitive work.",
	"Also return compact effort signals: groundingNeed, contextBreadth, outputRoom, and toolUse.",
	"Set groundingNeed to useful or required only when external/current/source-backed evidence is materially useful.",
	"Set outputRoom to expanded only when the task likely needs more answer room; higher depth does not imply verbosity.",
].join("\n");

type DepthSelectionTurnInput = {
	normalizedMessage: string;
	reasoningDepth: ReasoningDepth;
	modelId?: ModelId;
	modelDisplayName?: string | null;
	providerDisplayName?: string | null;
	attachmentIds?: string[];
	linkedSources?: LinkedContextSource[];
	pendingSkill?: PendingSkillSelection | null;
	activeDocumentArtifactId?: string;
	personalityProfileId?: string;
	deepResearchDepth?: DeepResearchDepth;
	forceWebSearch?: boolean;
};

export type DepthRecentMessage = {
	role: "user" | "assistant";
	content: string;
};

type ListRecentMessages = (params: {
	userId: string;
	conversationId: string;
}) => Promise<DepthRecentMessage[]>;

type ClassifierModelSource = "selected_chat_model" | "configured_model";

type ResolvedDepthClassifierModel = {
	modelId: ModelId | undefined;
	source: ClassifierModelSource;
	modelDisplayName?: string | null;
	configuredModelId?: string;
	fallbackReason?: string;
};

export type ResolveReasoningDepthSelectionParams = {
	userId: string;
	conversationId: string;
	request: DepthSelectionTurnInput;
	listRecentMessages?: ListRecentMessages;
};

export type ResolveReasoningDepthSelectionResult = {
	metadata: DepthMetadata;
};

export type DepthClassificationContext = {
	userRequest: string;
	recentMessages: DepthRecentMessage[];
	selectedSources: Array<{
		displayArtifactId: string;
		name: string;
		type: LinkedContextSource["type"];
		documentOrigin?: LinkedContextSource["documentOrigin"];
	}>;
	attachments: {
		count: number;
		sampleIds: string[];
	};
	activeDocumentArtifactId: string | null;
	model: {
		id: string | null;
		displayName: string | null;
		providerDisplayName: string | null;
	};
	composerState: {
		forceWebSearch: boolean;
		hasPendingSkill: boolean;
		pendingSkillName: string | null;
		hasPersonalityProfile: boolean;
	};
};

export async function resolveReasoningDepthSelection(
	params: ResolveReasoningDepthSelectionParams,
): Promise<ResolveReasoningDepthSelectionResult> {
	const { request } = params;
	if (request.reasoningDepth === "off") {
		return {
			metadata: buildDepthMetadata({
				request,
				appliedProfile: "off",
				classifierSource: "deterministic_bypass",
				constraintNote: "explicit_off",
			}),
		};
	}
	if (request.reasoningDepth === "max") {
		return {
			metadata: buildDepthMetadata({
				request,
				appliedProfile: "maximum",
				classifierSource: "deterministic_bypass",
				constraintNote: "explicit_max",
			}),
		};
	}
	if (request.deepResearchDepth) {
		return {
			metadata: buildDepthMetadata({
				request,
				appliedProfile: "standard",
				classifierSource: "deterministic_bypass",
				constraintNote: "deep_research_bypass",
			}),
		};
	}

	const listRecentMessages =
		params.listRecentMessages ?? listRecentDepthConversationMessages;
	const recentMessages = await listRecentMessages({
		userId: params.userId,
		conversationId: params.conversationId,
	}).catch(() => []);
	const context = buildDepthClassificationContext({
		request,
		recentMessages,
	});
	const classifierModel = await resolveDepthClassifierModel(request);
	let text: string;
	try {
		const result = await sendJsonControlMessage(
			formatDepthClassificationPrompt(context),
			classifierModel.modelId,
			{
				systemPrompt: DEPTH_CLASSIFIER_SYSTEM_PROMPT,
				thinkingMode: "off",
				maxTokens: CLASSIFIER_MAX_TOKENS,
				temperature: 0,
				jsonSchema: {
					name: "reasoning_depth_selection",
					strict: true,
					schema: DEPTH_CLASSIFICATION_SCHEMA,
				},
			},
		);
		text = result.text;
	} catch {
		return {
			metadata: buildFallbackDepthMetadata(
				request,
				"control_model_error",
				classifierModel,
			),
		};
	}

	const classification = parseClassifierResult(text);
	if (!classification) {
		return {
			metadata: buildFallbackDepthMetadata(
				request,
				"invalid_classifier_response",
				classifierModel,
			),
		};
	}

	return {
		metadata: buildDepthMetadata({
			request,
			appliedProfile: classification.appliedProfile,
			signals: classification.signals,
			classifierSource: "control_model",
			classifierModel,
		}),
	};
}

export function buildDepthClassificationContext(params: {
	request: DepthSelectionTurnInput;
	recentMessages?: DepthRecentMessage[];
}): DepthClassificationContext {
	const request = params.request;
	return {
		userRequest: truncate(request.normalizedMessage, MAX_REQUEST_CHARS),
		recentMessages: (params.recentMessages ?? [])
			.filter(
				(message): message is DepthRecentMessage =>
					(message.role === "user" || message.role === "assistant") &&
					typeof message.content === "string" &&
					message.content.trim().length > 0,
			)
			.slice(-MAX_RECENT_MESSAGES)
			.map((message) => ({
				role: message.role,
				content: truncate(message.content, MAX_RECENT_MESSAGE_CHARS),
			})),
		selectedSources: (request.linkedSources ?? [])
			.slice(0, MAX_LINKED_SOURCES)
			.map((source) => ({
				displayArtifactId: source.displayArtifactId,
				name: truncate(source.name, MAX_SOURCE_NAME_CHARS),
				type: source.type,
				documentOrigin: source.documentOrigin,
			})),
		attachments: {
			count: request.attachmentIds?.length ?? 0,
			sampleIds: (request.attachmentIds ?? []).slice(0, MAX_ATTACHMENT_IDS),
		},
		activeDocumentArtifactId: request.activeDocumentArtifactId ?? null,
		model: {
			id: request.modelId ?? null,
			displayName: request.modelDisplayName ?? null,
			providerDisplayName: request.providerDisplayName ?? null,
		},
		composerState: {
			forceWebSearch: request.forceWebSearch === true,
			hasPendingSkill: Boolean(request.pendingSkill),
			pendingSkillName: request.pendingSkill?.displayName ?? null,
			hasPersonalityProfile: Boolean(request.personalityProfileId),
		},
	};
}

export function formatDepthClassificationPrompt(
	context: DepthClassificationContext,
): string {
	const prompt = [
		"Classify the reasoning depth for this turn.",
		"Use only the bounded metadata below; do not infer full document contents.",
		JSON.stringify(context, null, 2),
	].join("\n\n");
	return truncate(prompt, MAX_CONTEXT_CHARS);
}

async function listRecentDepthConversationMessages(params: {
	userId: string;
	conversationId: string;
}): Promise<DepthRecentMessage[]> {
	void params.userId;
	const rows = await db
		.select({
			role: messages.role,
			content: messages.content,
		})
		.from(messages)
		.where(eq(messages.conversationId, params.conversationId))
		.orderBy(...messageOrderDesc())
		.limit(MAX_RECENT_MESSAGES);
	return rows
		.reverse()
		.filter(
			(row): row is DepthRecentMessage =>
				(row.role === "user" || row.role === "assistant") &&
				typeof row.content === "string",
		);
}

function buildFallbackDepthMetadata(
	request: DepthSelectionTurnInput,
	reason: string,
	classifierModel?: ResolvedDepthClassifierModel,
): DepthMetadata {
	return buildDepthMetadata({
		request,
		appliedProfile: "standard",
		classifierSource: "control_model_fallback",
		fallback: true,
		fallbackReason: reason,
		classifierModel,
	});
}

function buildDepthMetadata(params: {
	request: DepthSelectionTurnInput;
	appliedProfile: DepthAppliedProfile;
	classifierSource: string;
	fallback?: boolean;
	fallbackReason?: string;
	constraintNote?: string;
	signals?: DepthSelectionSignals;
	classifierModel?: ResolvedDepthClassifierModel;
}): DepthMetadata {
	const metadata: DepthMetadata = {
		requested: params.request.reasoningDepth,
		appliedProfile: params.appliedProfile,
		fallback: params.fallback ?? false,
		classifierSource: params.classifierSource,
	};
	if (params.fallbackReason) metadata.fallbackReason = params.fallbackReason;
	if (params.constraintNote) metadata.constraintNote = params.constraintNote;
	if (params.signals) metadata.signals = params.signals;
	if (params.classifierModel) {
		metadata.classifierModelSource = params.classifierModel.source;
		if (params.classifierModel.modelId) {
			metadata.classifierModelId = params.classifierModel.modelId;
		}
		if (params.classifierModel.modelDisplayName) {
			metadata.classifierModelDisplayName =
				params.classifierModel.modelDisplayName;
		}
		if (params.classifierModel.configuredModelId) {
			metadata.configuredClassifierModelId =
				params.classifierModel.configuredModelId;
		}
		if (params.classifierModel.fallbackReason) {
			metadata.classifierModelFallbackReason =
				params.classifierModel.fallbackReason;
		}
	}
	if (params.request.modelId) metadata.modelId = params.request.modelId;
	if (params.request.modelDisplayName) {
		metadata.modelDisplayName = params.request.modelDisplayName;
	}
	if (params.request.providerDisplayName) {
		metadata.providerDisplayName = params.request.providerDisplayName;
	}
	return metadata;
}

async function resolveDepthClassifierModel(
	request: DepthSelectionTurnInput,
): Promise<ResolvedDepthClassifierModel> {
	const selectedModelId = request.modelId ?? "model1";
	const selectedModel: ResolvedDepthClassifierModel = {
		modelId: selectedModelId,
		source: "selected_chat_model",
		modelDisplayName: request.modelDisplayName ?? null,
	};
	const configuredModelId = getConfig().reasoningDepthClassifierModel?.trim();
	if (!configuredModelId) return selectedModel;

	const validation = await validateConfiguredClassifierModel(configuredModelId);
	if (validation.ok) {
		return {
			modelId: configuredModelId as ModelId,
			source: "configured_model",
			modelDisplayName: validation.modelDisplayName,
			configuredModelId,
		};
	}

	return {
		...selectedModel,
		configuredModelId,
		fallbackReason: validation.reason,
	};
}

async function validateConfiguredClassifierModel(
	modelId: string,
): Promise<
	| { ok: true; modelDisplayName?: string | null }
	| { ok: false; reason: string }
> {
	const config = getConfig();
	if (modelId === "model1" || modelId === "model2") {
		if (!isModelEnabled(modelId, config)) {
			return { ok: false, reason: "configured_model_unavailable" };
		}
		return {
			ok: true,
			modelDisplayName:
				modelId === "model2"
					? config.model2.displayName
					: config.model1.displayName,
		};
	}

	if (!modelId.startsWith("provider:")) {
		return { ok: false, reason: "invalid_configured_model" };
	}

	const [, providerId, providerModelId] = modelId.split(":");
	if (!providerId || !providerModelId) {
		return { ok: false, reason: "invalid_configured_model" };
	}

	try {
		const provider = await getProviderWithSecrets(providerId);
		if (!provider?.enabled) {
			return { ok: false, reason: "configured_provider_unavailable" };
		}
		const models = await listEnabledProviderModels(providerId);
		const model = models.find((candidate) => candidate.id === providerModelId);
		if (!model) {
			return { ok: false, reason: "configured_model_unavailable" };
		}
		return { ok: true, modelDisplayName: model.displayName };
	} catch {
		return { ok: false, reason: "configured_model_unavailable" };
	}
}

function parseClassifierResult(
	text: string,
): { appliedProfile: DepthAppliedProfile; signals: DepthSelectionSignals } | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const profile = (parsed as { appliedProfile?: unknown }).appliedProfile;
	const appliedProfile =
		profile === "standard" ||
		profile === "extended" ||
		profile === "maximum"
			? profile
			: null;
	if (!appliedProfile) return null;
	const signals = parseClassifierSignals(parsed as Record<string, unknown>);
	if (!signals) return null;
	return { appliedProfile, signals };
}

function parseClassifierSignals(
	parsed: Record<string, unknown>,
): DepthSelectionSignals | null {
	const groundingNeed =
		parsed.groundingNeed === undefined
			? "none"
			: parsed.groundingNeed === "none" ||
					parsed.groundingNeed === "possible" ||
					parsed.groundingNeed === "useful" ||
					parsed.groundingNeed === "required"
				? parsed.groundingNeed
				: null;
	const contextBreadth =
		parsed.contextBreadth === undefined
			? "normal"
			: parsed.contextBreadth === "narrow" ||
					parsed.contextBreadth === "normal" ||
					parsed.contextBreadth === "broad"
				? parsed.contextBreadth
				: null;
	const outputRoom =
		parsed.outputRoom === undefined
			? "normal"
			: parsed.outputRoom === "concise" ||
					parsed.outputRoom === "normal" ||
					parsed.outputRoom === "expanded"
				? parsed.outputRoom
				: null;
	const toolUse =
		parsed.toolUse === undefined
			? "normal"
			: parsed.toolUse === "none" ||
					parsed.toolUse === "normal" ||
					parsed.toolUse === "source_heavy"
				? parsed.toolUse
				: null;

	if (!groundingNeed || !contextBreadth || !outputRoom || !toolUse) {
		return null;
	}

	return {
		groundingNeed,
		contextBreadth,
		outputRoom,
		toolUse,
	};
}

function truncate(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, Math.max(0, maxChars - 15))}\n[truncated]`;
}
