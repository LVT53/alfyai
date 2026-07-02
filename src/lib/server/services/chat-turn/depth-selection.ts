import { performance } from "node:perf_hooks";
import { NoObjectGeneratedError } from "ai";
import { eq } from "drizzle-orm";
import { getConfig, isModelEnabled } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { messages } from "$lib/server/db/schema";
import { messageOrderDesc } from "$lib/server/services/message-ordering";
import { sendJsonControlMessage } from "$lib/server/services/normal-chat-control-model";
import { listEnabledProviderModels } from "$lib/server/services/provider-models";
import { getProviderWithSecrets } from "$lib/server/services/providers";
import type {
	DepthAppliedProfile,
	DepthMetadata,
	DepthSelectionSignals,
	DepthSelectionTimingMetadata,
	LinkedContextSource,
	ModelId,
	PendingSkillSelection,
	ReasoningDepth,
} from "$lib/types";

const CLASSIFIER_TOKEN_BUDGETS = [256, 640, 1280];
const MAX_REQUEST_CHARS = 2_000;
const MAX_RECENT_MESSAGES = 4;
const MAX_RECENT_MESSAGE_CHARS = 500;
const MAX_LINKED_SOURCES = 8;
const MAX_SOURCE_NAME_CHARS = 120;
const MAX_ATTACHMENT_IDS = 8;
const MAX_CONTEXT_CHARS = 6_000;
const SIMPLE_AUTO_FAST_PATH_MAX_CHARS = 180;
const SIMPLE_AUTO_FAST_PATH_MAX_WORDS = 24;
const SIMPLE_AUTO_FAST_PATH_CONSTRAINT_NOTE = "simple_auto_standard_fast_path";

const AUTO_FAST_PATH_AMBIGUITY_PATTERN =
	/\b(above|previous|earlier|last|same|again|continue|attached|attachment|file|document|source|sources|conversation|thread|draft|message|answer|response)\b/i;
const AUTO_FAST_PATH_REFERENTIAL_PATTERN =
	/\b(?:summari[sz]e|rewrite|explain|fix|update|use|check|look at)\s+(?:this|that|it|them|these|those)\b/i;
const AUTO_FAST_PATH_SHORT_FOLLOWUP_PATTERN =
	/^(?:why\??|how so\??|tell me more\.?|go on\.?|continue\.?|what about (?:this|that|it|them|these|those)\??)$/i;
const AUTO_FAST_PATH_COMPLEXITY_PATTERN =
	/\b(compare|analy[sz]e|analysis|multi[- ]?step|planning|plan|debug|evaluate|trade[- ]?off|review|assess|refactor|optimi[sz]e|migrate|design|architecture|strategy|recommend|comprehensive|exhaustive|edge cases?|failure modes?|critical|regulatory|compliance|security|audit|prove|verify|validate|guarantee|think hard|hard|deep|maximum|effort)\b/i;
const AUTO_FAST_PATH_GROUNDING_PATTERN =
	/\b(current|latest|recent|today|tomorrow|yesterday|news|weather|price|citation|citations|cite|web|internet|online|google|search|browse|look up|lookup|source-backed)\b/i;
const AUTO_FAST_PATH_BLOCKING_PATTERNS = [
	AUTO_FAST_PATH_AMBIGUITY_PATTERN,
	AUTO_FAST_PATH_REFERENTIAL_PATTERN,
	AUTO_FAST_PATH_SHORT_FOLLOWUP_PATTERN,
	AUTO_FAST_PATH_COMPLEXITY_PATTERN,
	AUTO_FAST_PATH_GROUNDING_PATTERN,
];
const FAST_PATH_EXTERNAL_RESOURCE_TERM =
	"(?:(?:external\\s+)?tools?|web\\s+search|web|internet|online\\s+sources?|sources?|files?|documents?)";
const FAST_PATH_EXTERNAL_RESOURCE_LIST = `(?:the\\s+)?${FAST_PATH_EXTERNAL_RESOURCE_TERM}(?:(?:,?\\s*(?:or|and)\\s+|,\\s*|/\\s*)(?:the\\s+)?${FAST_PATH_EXTERNAL_RESOURCE_TERM})*`;
const NEGATED_EXTERNAL_RESOURCE_DIRECTIVE_PATTERNS = [
	new RegExp(
		`\\b(?:do not|don't|dont|never)\\s+(?:use|consult|access)\\s+${FAST_PATH_EXTERNAL_RESOURCE_LIST}\\b`,
		"gi",
	),
	/\b(?:do not|don't|dont|never)\s+(?:browse|search|browse\/search|search\/browse)(?:\s+(?:the\s+)?(?:web|internet))?\b/gi,
	new RegExp(
		`\\bwithout\\s+(?:using\\s+)?${FAST_PATH_EXTERNAL_RESOURCE_LIST}\\b`,
		"gi",
	),
	new RegExp(
		`\\bno\\s+${FAST_PATH_EXTERNAL_RESOURCE_LIST}(?:\\s+(?:needed|required|necessary))?\\b`,
		"gi",
	),
];
const AI_NO_OBJECT_ERROR_NAMES = new Set([
	"AI_NoObjectGeneratedError",
	"NoObjectGeneratedError",
	"AI_NoOutputGeneratedError",
	"NoOutputGeneratedError",
]);

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
	"Return only JSON matching this schema:",
	"{",
	'  "appliedProfile": "standard" | "extended" | "maximum",',
	'  "reason": "brief explanation",',
	'  "groundingNeed": "none" | "possible" | "useful" | "required",',
	'  "contextBreadth": "narrow" | "normal" | "broad",',
	'  "outputRoom": "concise" | "normal" | "expanded",',
	'  "toolUse": "none" | "normal" | "source_heavy"',
	"}",
	"Never choose off. Off is only available through explicit user selection outside this classifier.",
	"Prefer standard for ordinary direct answers, transformations, summaries, and simple coding help.",
	"Use extended for multi-step analysis, comparisons, debugging, planning, or requests with several constraints.",
	"Reserve maximum for clearly hard, high-value, ambiguous, long-horizon, or failure-sensitive work.",
	"Set groundingNeed to useful or required only when external/current/source-backed evidence is materially useful.",
	"Set outputRoom to expanded only when the task likely needs more answer room; higher depth does not imply verbosity.",
].join("\n");

const MAX_DEFAULT_SIGNALS: DepthSelectionSignals = {
	groundingNeed: "useful",
	contextBreadth: "broad",
	outputRoom: "expanded",
	toolUse: "normal",
};

const EXTENDED_KEYWORDS = [
	"compare",
	"analyze",
	"multi-step",
	"planning",
	"debug",
	"evaluate",
	"tradeoff",
	"trade-off",
	"trade off",
	"review",
	"assess",
	"refactor",
	"optimize",
	"migrate",
	"design",
	"architecture",
	"strategy",
	"recommend",
];

const MAXIMUM_KEYWORDS = [
	"comprehensive",
	"exhaustive",
	"edge case",
	"edge cases",
	"failure mode",
	"failure modes",
	"critical",
	"production",
	"regulatory",
	"compliance",
	"security",
	"audit",
	"prove",
	"verify",
	"validate",
	"guarantee",
];

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
	const selectionStartedAt = nowDepthSelectionMs();
	const { request } = params;
	if (request.reasoningDepth === "off") {
		return {
			metadata: buildDepthMetadata({
				request,
				appliedProfile: "off",
				classifierSource: "deterministic_bypass",
				constraintNote: "explicit_off",
				timing: buildDepthSelectionTiming({
					selectionStartedAt,
					classifierSource: "deterministic_bypass",
					appliedProfile: "off",
					classifierAttempts: 0,
				}),
			}),
		};
	}
	if (request.reasoningDepth === "max") {
		const recentMessagesStartedAt = nowDepthSelectionMs();
		const maxSignals = await resolveMaxSignals(params);
		const recentMessagesMs = elapsedDepthSelectionMs(recentMessagesStartedAt);
		return {
			metadata: buildDepthMetadata({
				request,
				appliedProfile: "maximum",
				signals: maxSignals,
				classifierSource: "deterministic_bypass",
				constraintNote: "explicit_max",
				timing: buildDepthSelectionTiming({
					selectionStartedAt,
					classifierSource: "deterministic_bypass",
					appliedProfile: "maximum",
					classifierAttempts: 0,
					recentMessagesMs,
				}),
			}),
		};
	}
	const fastPathResult = runSafeStandardAutoFastPath(request);
	if (fastPathResult) {
		logClassifierResult({
			source: "deterministic_fast_path",
			appliedProfile: fastPathResult.appliedProfile,
			attemptCount: 0,
		});
		return {
			metadata: buildDepthMetadata({
				request,
				appliedProfile: fastPathResult.appliedProfile,
				signals: fastPathResult.signals,
				classifierSource: "deterministic_fast_path",
				constraintNote: SIMPLE_AUTO_FAST_PATH_CONSTRAINT_NOTE,
				timing: buildDepthSelectionTiming({
					selectionStartedAt,
					classifierSource: "deterministic_fast_path",
					appliedProfile: fastPathResult.appliedProfile,
					classifierAttempts: 0,
				}),
			}),
		};
	}
	const listRecentMessages =
		params.listRecentMessages ?? listRecentDepthConversationMessages;
	const recentMessagesStartedAt = nowDepthSelectionMs();
	const recentMessages = await listRecentMessages({
		userId: params.userId,
		conversationId: params.conversationId,
	}).catch(() => []);
	const recentMessagesMs = elapsedDepthSelectionMs(recentMessagesStartedAt);
	const classificationContextStartedAt = nowDepthSelectionMs();
	const context = buildDepthClassificationContext({
		request,
		recentMessages,
	});
	const prompt = formatDepthClassificationPrompt(context);
	const classificationContextMs = elapsedDepthSelectionMs(
		classificationContextStartedAt,
	);
	const classifierModelResolutionStartedAt = nowDepthSelectionMs();
	const classifierModel = await resolveDepthClassifierModel(request);
	const classifierModelResolutionMs = elapsedDepthSelectionMs(
		classifierModelResolutionStartedAt,
	);
	let lastError: unknown;
	let fallbackReason:
		| "control_model_error"
		| "control_model_no_object_generated"
		| "invalid_classifier_response"
		| undefined;
	let attemptCount = 0;
	let finishReason: string | undefined;
	let hadReasoningTokens = false;
	let controlModelClassifierMs = 0;

	for (const tokenBudget of CLASSIFIER_TOKEN_BUDGETS) {
		attemptCount++;
		const classifierAttemptStartedAt = nowDepthSelectionMs();
		try {
			const result = await sendJsonControlMessage(
				prompt,
				classifierModel.modelId,
				{
					systemPrompt: DEPTH_CLASSIFIER_SYSTEM_PROMPT,
					thinkingMode: "off",
					maxTokens: tokenBudget,
					temperature: 0,
					allowEmptyTextOnLengthFinish: true,
					skipStructuredOutputs: true,
					jsonSchema: {
						name: "reasoning_depth_selection",
						strict: true,
						schema: DEPTH_CLASSIFICATION_SCHEMA,
					},
				},
			);

			const rawResponse = result.rawResponse as
				| Record<string, unknown>
				| undefined;
			const choices = Array.isArray(rawResponse?.choices)
				? rawResponse.choices
				: [];
			const firstChoice = choices[0] as Record<string, unknown> | undefined;
			finishReason =
				typeof firstChoice?.finish_reason === "string"
					? firstChoice.finish_reason
					: undefined;

			const usage = rawResponse?.usage as Record<string, unknown> | undefined;
			const completionTokensDetails = usage?.completion_tokens_details as
				| Record<string, unknown>
				| undefined;
			hadReasoningTokens =
				typeof completionTokensDetails?.reasoning_tokens === "number" &&
				completionTokensDetails.reasoning_tokens > 0;

			const text = result.text;
			const classification = parseClassifierResult(text);
			controlModelClassifierMs += elapsedDepthSelectionMs(
				classifierAttemptStartedAt,
			);

			if (classification) {
				logClassifierResult({
					source: "control_model",
					appliedProfile: classification.appliedProfile,
					attemptCount,
					finishReason,
					hadReasoningTokens,
				});
				return {
					metadata: buildDepthMetadata({
						request,
						appliedProfile: classification.appliedProfile,
						signals: classification.signals,
						classifierSource: "control_model",
						classifierModel,
						timing: buildDepthSelectionTiming({
							selectionStartedAt,
							classifierSource: "control_model",
							appliedProfile: classification.appliedProfile,
							classifierAttempts: attemptCount,
							recentMessagesMs,
							classificationContextMs,
							classifierModelResolutionMs,
							controlModelClassifierMs,
						}),
					}),
				};
			}

			if (finishReason === "length" || isTruncatedJson(text)) {
				continue;
			}

			lastError = new Error("invalid_classifier_response");
			fallbackReason = "invalid_classifier_response";
			break;
		} catch (error) {
			controlModelClassifierMs += elapsedDepthSelectionMs(
				classifierAttemptStartedAt,
			);
			lastError = error;
			const errorSummary = summarizeClassifierError(error);
			fallbackReason = errorSummary.fallbackReason;
			finishReason = errorSummary.finishReason ?? finishReason;
			hadReasoningTokens =
				errorSummary.hadReasoningTokens ?? hadReasoningTokens;
			break;
		}
	}

	if (lastError) {
		const keywordResult = runDeterministicKeywordClassifier(
			request.normalizedMessage,
		);
		const resolvedFallbackReason = fallbackReason ?? "control_model_error";
		logClassifierResult({
			source: "deterministic_fallback",
			appliedProfile: keywordResult.appliedProfile,
			attemptCount,
			finishReason,
			hadReasoningTokens,
			fallbackReason: resolvedFallbackReason,
			error: formatClassifierErrorForLog(lastError, resolvedFallbackReason),
		});
		return {
			metadata: buildDepthMetadata({
				request,
				appliedProfile: keywordResult.appliedProfile,
				signals: keywordResult.signals,
				classifierSource: "deterministic_fallback",
				fallback: true,
				fallbackReason: resolvedFallbackReason,
				classifierModel,
				timing: buildDepthSelectionTiming({
					selectionStartedAt,
					classifierSource: "deterministic_fallback",
					appliedProfile: keywordResult.appliedProfile,
					classifierAttempts: attemptCount,
					fallbackReason: resolvedFallbackReason,
					recentMessagesMs,
					classificationContextMs,
					classifierModelResolutionMs,
					controlModelClassifierMs,
				}),
			}),
		};
	}

	const keywordResult = runDeterministicKeywordClassifier(
		request.normalizedMessage,
	);
	logClassifierResult({
		source: "deterministic_fallback",
		appliedProfile: keywordResult.appliedProfile,
		attemptCount,
		finishReason,
		hadReasoningTokens,
		error: "invalid_classifier_response",
	});
	return {
		metadata: buildDepthMetadata({
			request,
			appliedProfile: keywordResult.appliedProfile,
			signals: keywordResult.signals,
			classifierSource: "deterministic_fallback",
			fallback: true,
			fallbackReason: "invalid_classifier_response",
			classifierModel,
			timing: buildDepthSelectionTiming({
				selectionStartedAt,
				classifierSource: "deterministic_fallback",
				appliedProfile: keywordResult.appliedProfile,
				classifierAttempts: attemptCount,
				fallbackReason: "invalid_classifier_response",
				recentMessagesMs,
				classificationContextMs,
				classifierModelResolutionMs,
				controlModelClassifierMs,
			}),
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

function buildDepthMetadata(params: {
	request: DepthSelectionTurnInput;
	appliedProfile: DepthAppliedProfile;
	classifierSource: string;
	fallback?: boolean;
	fallbackReason?: string;
	constraintNote?: string;
	signals?: DepthSelectionSignals;
	classifierModel?: ResolvedDepthClassifierModel;
	timing?: DepthSelectionTimingMetadata;
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
	if (params.timing) metadata.timing = params.timing;
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

function buildDepthSelectionTiming(params: {
	selectionStartedAt: number;
	classifierSource: string;
	appliedProfile: DepthAppliedProfile;
	classifierAttempts: number;
	fallbackReason?: string;
	recentMessagesMs?: number;
	classificationContextMs?: number;
	classifierModelResolutionMs?: number;
	controlModelClassifierMs?: number;
}): DepthSelectionTimingMetadata {
	const classifierAttempts = Number.isFinite(params.classifierAttempts)
		? Math.max(0, Math.floor(params.classifierAttempts))
		: 0;
	const timing: DepthSelectionTimingMetadata = {
		totalMs: elapsedDepthSelectionMs(params.selectionStartedAt),
		classifierAttempts,
		classifierSource: params.classifierSource,
		appliedProfile: params.appliedProfile,
	};
	assignDepthSelectionDuration(
		timing,
		"recentMessagesMs",
		params.recentMessagesMs,
	);
	assignDepthSelectionDuration(
		timing,
		"classificationContextMs",
		params.classificationContextMs,
	);
	assignDepthSelectionDuration(
		timing,
		"classifierModelResolutionMs",
		params.classifierModelResolutionMs,
	);
	assignDepthSelectionDuration(
		timing,
		"controlModelClassifierMs",
		params.controlModelClassifierMs,
	);
	if (params.fallbackReason) {
		timing.fallbackReason = params.fallbackReason;
	}
	return timing;
}

function assignDepthSelectionDuration(
	timing: DepthSelectionTimingMetadata,
	key:
		| "recentMessagesMs"
		| "classificationContextMs"
		| "classifierModelResolutionMs"
		| "controlModelClassifierMs",
	value: number | undefined,
): void {
	if (value === undefined || !Number.isFinite(value) || value < 0) return;
	timing[key] = value;
}

function nowDepthSelectionMs(): number {
	return performance.now();
}

function elapsedDepthSelectionMs(startedAt: number): number {
	const elapsedMs = nowDepthSelectionMs() - startedAt;
	return Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
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
	{ ok: true; modelDisplayName?: string | null } | { ok: false; reason: string }
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

function parseClassifierResult(text: string): {
	appliedProfile: DepthAppliedProfile;
	signals: DepthSelectionSignals;
} | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;

	const record = parsed as Record<string, unknown>;
	const appliedProfile = resolveAppliedProfile(record);
	if (!appliedProfile) return null;

	const signals = parseClassifierSignals(record);
	if (!signals) return null;
	return { appliedProfile, signals };
}

function resolveAppliedProfile(
	record: Record<string, unknown>,
): DepthAppliedProfile | null {
	const raw =
		record.appliedProfile ??
		record.applied_profile ??
		record.profile ??
		record.reasoning_depth ??
		record.depth;

	if (typeof raw !== "string") return null;

	const normalized = raw.toLowerCase().trim();
	const mapped = mapProfileValue(normalized);
	if (mapped === "standard" || mapped === "extended" || mapped === "maximum") {
		return mapped;
	}
	return null;
}

function mapProfileValue(value: string): string {
	switch (value) {
		case "deep":
		case "high":
		case "advanced":
			return "extended";
		case "expert":
		case "highest":
		case "very high":
		case "max":
			return "maximum";
		case "low":
		case "moderate":
			return "standard";
		default:
			return value;
	}
}

function parseClassifierSignals(
	parsed: Record<string, unknown>,
): DepthSelectionSignals | null {
	const groundingNeed = parseSignalValue(
		parsed.groundingNeed,
		{
			none: "none",
			possible: "possible",
			useful: "useful",
			required: "required",
			low: "possible",
			medium: "useful",
			moderate: "useful",
			high: "required",
		},
		"none",
	);
	const contextBreadth = parseSignalValue(
		parsed.contextBreadth,
		{
			narrow: "narrow",
			normal: "normal",
			broad: "broad",
			low: "narrow",
			medium: "normal",
			moderate: "normal",
			high: "broad",
		},
		"normal",
	);
	const outputRoom = parseSignalValue(
		parsed.outputRoom,
		{
			concise: "concise",
			normal: "normal",
			expanded: "expanded",
			low: "concise",
			medium: "normal",
			moderate: "normal",
			high: "expanded",
		},
		"normal",
	);
	const toolUse = parseSignalValue(
		parsed.toolUse,
		{
			none: "none",
			normal: "normal",
			source_heavy: "source_heavy",
			low: "none",
			medium: "normal",
			moderate: "normal",
			high: "source_heavy",
		},
		"normal",
	);

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

function parseSignalValue<T extends string>(
	raw: unknown,
	allowed: Record<string, T>,
	defaultValue: T,
): T | null {
	if (raw === undefined) return defaultValue;
	if (typeof raw !== "string") return null;
	const normalized = raw.toLowerCase().trim().replaceAll("-", "_");
	return allowed[normalized] ?? null;
}

function isTruncatedJson(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return true;
	try {
		JSON.parse(trimmed);
		return false;
	} catch {
		return true;
	}
}

type ClassifierLogEntry = {
	source:
		| "control_model"
		| "deterministic_fast_path"
		| "deterministic_fallback"
		| "control_model_error";
	appliedProfile: DepthAppliedProfile;
	attemptCount: number;
	finishReason?: string;
	hadReasoningTokens?: boolean;
	fallbackReason?: string;
	error?: string;
};

function logClassifierResult(entry: ClassifierLogEntry): void {
	const parts = [
		`source=${entry.source}`,
		`profile=${entry.appliedProfile}`,
		`attempts=${entry.attemptCount}`,
	];
	if (entry.finishReason) {
		parts.push(`finish_reason=${entry.finishReason}`);
	}
	if (entry.hadReasoningTokens !== undefined) {
		parts.push(`reasoning_tokens=${entry.hadReasoningTokens}`);
	}
	if (entry.fallbackReason) {
		parts.push(`fallback_reason=${entry.fallbackReason}`);
	}
	if (entry.error) {
		parts.push(`error=${entry.error}`);
	}
	console.log(`[DEPTH_CLASSIFIER] ${parts.join(" ")}`);
}

function runSafeStandardAutoFastPath(request: DepthSelectionTurnInput): {
	appliedProfile: "standard";
	signals: DepthSelectionSignals;
} | null {
	const normalizedMessage = request.normalizedMessage.trim();
	const wordCount = normalizedMessage.split(/\s+/).filter(Boolean).length;
	const hasBlockingTurnState = [
		!normalizedMessage,
		normalizedMessage.length > SIMPLE_AUTO_FAST_PATH_MAX_CHARS,
		wordCount > SIMPLE_AUTO_FAST_PATH_MAX_WORDS,
		Boolean(request.attachmentIds?.length),
		Boolean(request.linkedSources?.length),
		request.forceWebSearch === true,
		Boolean(request.pendingSkill),
	].some(Boolean);
	if (hasBlockingTurnState) return null;
	const blockerMessage =
		removeNegatedExternalResourceDirectives(normalizedMessage);
	if (
		AUTO_FAST_PATH_BLOCKING_PATTERNS.some((pattern) =>
			pattern.test(blockerMessage),
		)
	) {
		return null;
	}

	const keywordResult = runDeterministicKeywordClassifier(normalizedMessage);
	if (keywordResult.appliedProfile !== "standard") return null;
	return {
		appliedProfile: "standard",
		signals: keywordResult.signals,
	};
}

function removeNegatedExternalResourceDirectives(message: string): string {
	return NEGATED_EXTERNAL_RESOURCE_DIRECTIVE_PATTERNS.reduce(
		(next, pattern) => next.replace(pattern, " "),
		message,
	);
}

function summarizeClassifierError(error: unknown): {
	fallbackReason: "control_model_error" | "control_model_no_object_generated";
	finishReason?: string;
	hadReasoningTokens?: boolean;
} {
	if (!isNoObjectGeneratedClassifierError(error)) {
		return { fallbackReason: "control_model_error" };
	}

	return {
		fallbackReason: "control_model_no_object_generated",
		finishReason: extractClassifierErrorFinishReason(error),
		hadReasoningTokens: readHadReasoningTokensFromUsage(
			readRecordProperty(error, "usage"),
		),
	};
}

function isNoObjectGeneratedClassifierError(error: unknown): boolean {
	try {
		if (NoObjectGeneratedError.isInstance(error)) return true;
	} catch {
		// Fall through to the structural check below. Tests use lightweight shapes.
	}

	const name = readStringRecordProperty(error, "name");
	const code = readStringRecordProperty(error, "code");
	return [name, code].some(
		(value) => value !== undefined && AI_NO_OBJECT_ERROR_NAMES.has(value),
	);
}

function extractClassifierErrorFinishReason(
	error: unknown,
): string | undefined {
	return readStringRecordProperty(error, "finishReason");
}

function readHadReasoningTokensFromUsage(usage: unknown): boolean | undefined {
	const details =
		readRecordProperty(usage, "completion_tokens_details") ??
		readRecordProperty(usage, "completionTokensDetails");
	const reasoningTokens =
		readNumberRecordProperty(details, "reasoning_tokens") ??
		readNumberRecordProperty(details, "reasoningTokens");
	return reasoningTokens === undefined ? undefined : reasoningTokens > 0;
}

function formatClassifierErrorForLog(
	error: unknown,
	fallbackReason: string,
): string {
	if (fallbackReason !== "control_model_no_object_generated") {
		return String(error);
	}

	return (
		readStringRecordProperty(error, "name") ??
		readStringRecordProperty(error, "code") ??
		"AI_NoObjectGeneratedError"
	);
}

function readRecordProperty(
	value: unknown,
	property: string,
): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object") return undefined;
	const propertyValue = (value as Record<string, unknown>)[property];
	return propertyValue && typeof propertyValue === "object"
		? (propertyValue as Record<string, unknown>)
		: undefined;
}

function readStringRecordProperty(
	value: unknown,
	property: string,
): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const propertyValue = (value as Record<string, unknown>)[property];
	return typeof propertyValue === "string" && propertyValue.trim()
		? propertyValue
		: undefined;
}

function readNumberRecordProperty(
	value: unknown,
	property: string,
): number | undefined {
	if (!value || typeof value !== "object") return undefined;
	const propertyValue = (value as Record<string, unknown>)[property];
	return typeof propertyValue === "number" ? propertyValue : undefined;
}

function runDeterministicKeywordClassifier(normalizedMessage: string): {
	appliedProfile: DepthAppliedProfile;
	signals: DepthSelectionSignals;
} {
	const lower = normalizedMessage.toLowerCase();
	const wordCount = normalizedMessage.split(/\s+/).filter(Boolean).length;

	let extendedScore = 0;
	for (const keyword of EXTENDED_KEYWORDS) {
		if (lower.includes(keyword)) extendedScore++;
	}

	let maximumScore = 0;
	for (const keyword of MAXIMUM_KEYWORDS) {
		if (lower.includes(keyword)) maximumScore++;
	}

	let appliedProfile: DepthAppliedProfile = "standard";
	let groundingNeed: DepthSelectionSignals["groundingNeed"] = "none";
	let contextBreadth: DepthSelectionSignals["contextBreadth"] = "normal";
	let outputRoom: DepthSelectionSignals["outputRoom"] = "normal";
	const toolUse: DepthSelectionSignals["toolUse"] = "normal";

	if (maximumScore >= 2 || (maximumScore >= 1 && wordCount > 200)) {
		appliedProfile = "maximum";
		groundingNeed = "useful";
		contextBreadth = "broad";
		outputRoom = "expanded";
	} else if (extendedScore >= 2 || (extendedScore >= 1 && wordCount > 100)) {
		appliedProfile = "extended";
		groundingNeed = extendedScore >= 3 ? "useful" : "possible";
		contextBreadth = extendedScore >= 3 ? "broad" : "normal";
		outputRoom = wordCount > 150 ? "expanded" : "normal";
	}

	return {
		appliedProfile,
		signals: { groundingNeed, contextBreadth, outputRoom, toolUse },
	};
}

async function resolveMaxSignals(
	params: ResolveReasoningDepthSelectionParams,
): Promise<DepthSelectionSignals> {
	try {
		const rows = await db
			.select({
				metadataJson: messages.metadataJson,
			})
			.from(messages)
			.where(eq(messages.conversationId, params.conversationId))
			.orderBy(...messageOrderDesc())
			.limit(1);

		const lastRow = rows[0];
		if (lastRow?.metadataJson) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(lastRow.metadataJson);
			} catch (error) {
				console.warn(
					"[DEPTH_CLASSIFIER] Failed to parse previous message metadataJson",
					error,
				);
			}
			if (parsed && typeof parsed === "object") {
				const meta = parsed as Record<string, unknown>;
				const depthMeta = meta.depthMetadata as DepthMetadata | undefined;
				if (
					depthMeta?.signals &&
					(depthMeta.appliedProfile === "extended" ||
						depthMeta.appliedProfile === "maximum")
				) {
					return depthMeta.signals;
				}
			}
		}
	} catch (error) {
		console.warn(
			"[DEPTH_CLASSIFIER] Failed to read previous message depth metadata",
			error,
		);
	}

	return { ...MAX_DEFAULT_SIGNALS };
}

function truncate(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, Math.max(0, maxChars - 15))}\n[truncated]`;
}
