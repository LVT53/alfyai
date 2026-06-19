import {
	getMaxMessageLength,
	normalizeModelSelection,
	type RuntimeConfig,
} from "$lib/server/config-store";
import { createAttachmentTraceId } from "$lib/server/services/attachment-trace";
import { listEnabledProviderModels } from "$lib/server/services/provider-models";
import {
	getProviderByName,
	getProviderWithSecrets,
} from "$lib/server/services/providers";
import type {
	LinkedContextSource,
	ModelId,
	PendingSkillSelection,
	ReasoningDepth,
	ThinkingMode,
} from "$lib/types";
import {
	isReasoningDepth,
	reasoningDepthToThinkingMode,
	thinkingModeToReasoningDepth,
} from "$lib/types";
import type {
	AtlasAction,
	AtlasProfile,
	ChatTurnRequestError,
	ChatTurnRoute,
	ParsedChatTurnRequest,
} from "./types";

type ParseResult =
	| { ok: true; value: ParsedChatTurnRequest }
	| { ok: false; error: ChatTurnRequestError };

type RequestBody = {
	message?: unknown;
	userMessage?: unknown;
	conversationId?: unknown;
	streamId?: unknown;
	reconnectToStreamId?: unknown;
	model?: unknown;
	skipPersistUserMessage?: unknown;
	attachmentIds?: unknown;
	linkedSources?: unknown;
	pendingSkill?: unknown;
	activeDocumentArtifactId?: unknown;
	personalityProfileId?: unknown;
	reasoningDepth?: unknown;
	thinkingMode?: unknown;
	forceWebSearch?: unknown;
	atlasMode?: unknown;
	atlasProfile?: unknown;
	clientAtlasTurnId?: unknown;
	atlasAction?: unknown;
	parentAtlasId?: unknown;
};

type ParsedStreamIds = {
	streamId: string | undefined;
	reconnectToStreamId: string | undefined;
};

type ParsedMessage = {
	normalizedMessage: string;
	streamIds: ParsedStreamIds;
};

type ModelSelectionState = {
	modelId: ModelId | undefined;
	modelDisplayName: string;
	providerDisplayName: string | undefined;
	resolvedMaxMessageLength: number | null;
};

type ModelSelectionOutcome =
	| { ok: false; error: ChatTurnRequestError }
	| { ok: true; value: ModelSelectionState };

export async function parseChatTurnRequest(
	request: Request,
	runtimeConfig: RuntimeConfig,
	route: ChatTurnRoute,
): Promise<ParseResult> {
	const bodyResult = await parseJsonBody(request);
	if (!bodyResult.ok) {
		return bodyResult;
	}

	const body = bodyResult.value;
	const parsedMessage = parseRequestMessage(body);
	if (!parsedMessage.ok) {
		return parsedMessage;
	}

	if (
		typeof body.conversationId !== "string" ||
		body.conversationId.trim().length === 0
	) {
		return {
			ok: false,
			error: { status: 400, error: "conversationId is required" },
		};
	}

	const modelResult = await resolveModelSelection(body.model, runtimeConfig);
	if (!modelResult.ok) {
		return modelResult;
	}

	const maxLen =
		modelResult.value.resolvedMaxMessageLength ??
		getMaxMessageLength(modelResult.value.modelId);
	if (parsedMessage.value.normalizedMessage.length > maxLen) {
		return {
			ok: false,
			error: {
				status: 400,
				error: `Message exceeds maximum length of ${maxLen} characters`,
			},
		};
	}

	const safeAttachmentIds = parseAttachmentIds(body.attachmentIds);
	const atlasResult = parseAtlasTurnFields(body);
	if (!atlasResult.ok) {
		return atlasResult;
	}
	const atlasFields = atlasResult.value;
	const reasoningDepth = atlasFields.atlasMode
		? "auto"
		: parseReasoningDepth(body.reasoningDepth, body.thinkingMode);

	return {
		ok: true,
		value: {
			conversationId: body.conversationId,
			normalizedMessage: parsedMessage.value.normalizedMessage,
			streamId: parsedMessage.value.streamIds.streamId,
			reconnectToStreamId: parsedMessage.value.streamIds.reconnectToStreamId,
			modelId: modelResult.value.modelId,
			modelDisplayName: modelResult.value.modelDisplayName,
			providerDisplayName: modelResult.value.providerDisplayName,
			attachmentIds: safeAttachmentIds,
			linkedSources: parseLinkedSources(body.linkedSources),
			pendingSkill: atlasFields.atlasMode
				? null
				: parsePendingSkill(body.pendingSkill),
			activeDocumentArtifactId:
				typeof body.activeDocumentArtifactId === "string" &&
				body.activeDocumentArtifactId.trim().length > 0
					? body.activeDocumentArtifactId.trim()
					: undefined,
			personalityProfileId:
				typeof body.personalityProfileId === "string" &&
				body.personalityProfileId.trim().length > 0
					? body.personalityProfileId.trim()
					: undefined,
			reasoningDepth,
			thinkingMode: reasoningDepthToThinkingMode(reasoningDepth),
			forceWebSearch: atlasFields.atlasMode
				? false
				: body.forceWebSearch === true,
			skipPersistUserMessage: body.skipPersistUserMessage === true,
			attachmentTraceId:
				safeAttachmentIds.length > 0
					? createAttachmentTraceId(route)
					: undefined,
			...atlasFields,
		},
	};
}

async function parseJsonBody(
	request: Request,
): Promise<
	{ ok: true; value: RequestBody } | { ok: false; error: ChatTurnRequestError }
> {
	try {
		const body = await request.json();
		return { ok: true, value: body as RequestBody };
	} catch {
		return { ok: false, error: { status: 400, error: "Invalid JSON body" } };
	}
}

function parseRequestMessage(
	body: RequestBody,
):
	| { ok: true; value: ParsedMessage }
	| { ok: false; error: ChatTurnRequestError } {
	const safeStreamId = normalizeStreamId(body.streamId);
	const safeReconnectToStreamId = normalizeStreamId(body.reconnectToStreamId);

	const isReconnect = Boolean(safeReconnectToStreamId);
	const rawMessage =
		isReconnect && typeof body.userMessage === "string"
			? body.userMessage
			: body.message;
	const normalizedMessage =
		typeof rawMessage === "string" ? rawMessage.trim() : "";

	if (!isReconnect && normalizedMessage.length === 0) {
		return {
			ok: false,
			error: { status: 400, error: "Message must be a non-empty string" },
		};
	}

	return {
		ok: true,
		value: {
			normalizedMessage,
			streamIds: {
				streamId: safeReconnectToStreamId ?? safeStreamId,
				reconnectToStreamId: safeReconnectToStreamId,
			},
		},
	};
}

function normalizeStreamId(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

async function resolveModelSelection(
	model: unknown,
	runtimeConfig: RuntimeConfig,
): Promise<ModelSelectionOutcome> {
	const modelStr = typeof model === "string" ? model.trim() : "";

	if (modelStr === "model1" || modelStr === "model2") {
		const providerModel = await resolveModelFromNewProvidersTable(modelStr);
		if (providerModel) {
			return {
				ok: true,
				value: {
					modelId: modelStr as ModelId,
					modelDisplayName: providerModel.displayName,
					providerDisplayName: undefined,
					resolvedMaxMessageLength: providerModel.maxMessageLength,
				},
			};
		}

		const resolvedModelId = normalizeModelSelection(modelStr, runtimeConfig);
		return {
			ok: true,
			value: {
				modelId: resolvedModelId,
				modelDisplayName:
					resolvedModelId === "model2"
						? runtimeConfig.model2.displayName
						: runtimeConfig.model1.displayName,
				providerDisplayName: undefined,
				resolvedMaxMessageLength: null,
			},
		};
	}

	if (modelStr.startsWith("provider:")) {
		return resolveProviderModelSelection(modelStr, runtimeConfig);
	}

	if (modelStr !== "") {
		return {
			ok: true,
			value: {
				modelId: undefined,
				modelDisplayName: runtimeConfig.model1.displayName,
				providerDisplayName: undefined,
				resolvedMaxMessageLength: null,
			},
		};
	}

	return {
		ok: true,
		value: {
			modelId: "model1",
			modelDisplayName: runtimeConfig.model1.displayName,
			providerDisplayName: undefined,
			resolvedMaxMessageLength: null,
		},
	};
}

async function resolveProviderModelSelection(
	providerValue: string,
	runtimeConfig: RuntimeConfig,
): Promise<ModelSelectionOutcome> {
	const providerId = providerValue.slice("provider:".length);
	if (providerId.length === 0) {
		return {
			ok: true,
			value: {
				modelId: undefined,
				modelDisplayName: runtimeConfig.model1.displayName,
				providerDisplayName: undefined,
				resolvedMaxMessageLength: null,
			},
		};
	}

	const actualProviderId = providerId.includes(":")
		? providerId.split(":")[0]
		: providerId;
	const provider = await getProviderWithSecrets(actualProviderId).catch(
		() => null,
	);
	if (!provider?.enabled) {
		return {
			ok: false,
			error: {
				status: 400,
				error: "Selected provider model is not available",
			},
		};
	}

	if (!providerId.includes(":")) {
		return {
			ok: true,
			value: {
				modelId: providerValue as ModelId,
				modelDisplayName: provider.displayName,
				providerDisplayName: provider.displayName,
				resolvedMaxMessageLength: null,
			},
		};
	}

	const modelUuid = providerId.split(":")[1];
	const models = await listEnabledProviderModels(actualProviderId).catch(
		() => [],
	);
	const found = models.find((m) => m.id === modelUuid);
	return {
		ok: true,
		value: {
			modelId: providerValue as ModelId,
			modelDisplayName: found?.displayName ?? provider.displayName,
			providerDisplayName: provider.displayName,
			resolvedMaxMessageLength: found?.maxMessageLength ?? null,
		},
	};
}

function parseAttachmentIds(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter(
				(candidate): candidate is string => typeof candidate === "string",
			)
		: [];
}

function parsePendingSkill(value: unknown): PendingSkillSelection | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	if (
		typeof record.id !== "string" ||
		(record.ownership !== "user" && record.ownership !== "system") ||
		typeof record.displayName !== "string"
	) {
		return null;
	}
	return {
		id: record.id,
		ownership: record.ownership,
		skillKind:
			record.skillKind === "user_skill" ||
			record.skillKind === "skill_pack" ||
			record.skillKind === "skill_variant"
				? record.skillKind
				: undefined,
		displayName: record.displayName,
		baseSkillId:
			typeof record.baseSkillId === "string" ? record.baseSkillId : null,
		baseSkillDisplayName:
			typeof record.baseSkillDisplayName === "string"
				? record.baseSkillDisplayName
				: null,
		unavailable: record.unavailable === true,
	};
}

function parseLinkedSources(value: unknown): LinkedContextSource[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(source): source is LinkedContextSource =>
			typeof source === "object" &&
			source !== null &&
			"displayArtifactId" in source &&
			typeof source.displayArtifactId === "string" &&
			"name" in source &&
			typeof source.name === "string" &&
			"type" in source &&
			source.type === "document",
	);
}

function parseReasoningDepth(
	value: unknown,
	legacyThinkingMode: unknown,
): ReasoningDepth {
	if (isReasoningDepth(value)) return value;
	return thinkingModeToReasoningDepth(parseThinkingMode(legacyThinkingMode));
}

function parseThinkingMode(value: unknown): ThinkingMode {
	return value === "on" || value === "off" || value === "auto" ? value : "auto";
}

type ParsedAtlasTurnFields = {
	atlasMode: boolean;
	atlasProfile: AtlasProfile | null;
	atlasAction: AtlasAction;
	parentAtlasId: string | null;
	clientAtlasTurnId: string | null;
};

function parseAtlasTurnFields(
	body: RequestBody,
):
	| { ok: true; value: ParsedAtlasTurnFields }
	| { ok: false; error: ChatTurnRequestError } {
	const atlasMode = body.atlasMode === true;
	if (!atlasMode) {
		return {
			ok: true,
			value: {
				atlasMode: false,
				atlasProfile: null,
				atlasAction: "create",
				parentAtlasId: null,
				clientAtlasTurnId: null,
			},
		};
	}

	const atlasProfile = parseAtlasProfile(body.atlasProfile);
	if (!atlasProfile) {
		return {
			ok: false,
			error: {
				status: 400,
				error: "atlasProfile must be one of overview, in-depth, or exhaustive",
				code: "INVALID_ATLAS_PROFILE",
			},
		};
	}

	return {
		ok: true,
		value: {
			atlasMode: true,
			atlasProfile,
			atlasAction: parseAtlasAction(body.atlasAction),
			parentAtlasId: parseOptionalTrimmedString(body.parentAtlasId),
			clientAtlasTurnId: parseOptionalTrimmedString(body.clientAtlasTurnId),
		},
	};
}

function parseAtlasProfile(value: unknown): AtlasProfile | null {
	return value === "overview" || value === "in-depth" || value === "exhaustive"
		? value
		: null;
}

function parseAtlasAction(value: unknown): AtlasAction {
	return value === "continue" || value === "fork" || value === "revise"
		? value
		: "create";
}

function parseOptionalTrimmedString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

type ModelFromProvidersTable = {
	displayName: string;
	maxMessageLength: number | null;
} | null;

async function resolveModelFromNewProvidersTable(
	name: string,
): Promise<ModelFromProvidersTable> {
	try {
		const provider = await getProviderByName(name);
		if (!provider?.enabled) return null;

		const models = await listEnabledProviderModels(provider.id);
		const model = models[0];
		if (!model) return null;

		return {
			displayName: model.displayName,
			maxMessageLength: model.maxMessageLength ?? null,
		};
	} catch {
		return null;
	}
}
