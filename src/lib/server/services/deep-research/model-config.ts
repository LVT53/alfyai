import {
	DEEP_RESEARCH_MODEL_ROLES,
	type DeepResearchModelRole,
	type DeepResearchModelSelections,
} from "$lib/deep-research-models";
import {
	getConfig,
	type RuntimeConfig,
} from "$lib/server/config-store";
import { getProviderWithSecrets } from "$lib/server/services/providers";
import { deriveModelContextBudget } from "$lib/server/services/chat-turn/context-budget";
import { inferModelContextWindow } from "$lib/server/services/model-context";
import type { ModelId } from "$lib/types";

export type { DeepResearchModelRole, DeepResearchModelSelections };
export { DEEP_RESEARCH_MODEL_ROLES };

const UNKNOWN_PROVIDER_MAX_MODEL_CONTEXT_FALLBACK = 150_000;

export type ResolvedDeepResearchModel = {
	role: DeepResearchModelRole;
	modelId: ModelId;
	modelDisplayName: string;
	providerId: string | null;
	providerDisplayName: string | null;
	providerBaseUrl: string | null;
	providerModelName: string | null;
	limits: {
		maxModelContext: number;
		compactionUiThreshold: number;
		targetConstructedContext: number;
		maxMessageLength: number;
		maxTokens: number | null;
	};
};

export async function resolveDeepResearchModel(
	role: DeepResearchModelRole,
	config: RuntimeConfig = getConfig(),
): Promise<ResolvedDeepResearchModel> {
	const configuredModelId = config.deepResearchModels?.[role] ?? "model1";
	if (configuredModelId.startsWith("provider:")) {
		const providerId = configuredModelId.slice("provider:".length);
		const provider = await getProviderWithSecrets(providerId).catch(() => null);
		if (provider?.enabled) {
			const providerBudget = deriveModelContextBudget({
				maxModelContext: UNKNOWN_PROVIDER_MAX_MODEL_CONTEXT_FALLBACK,
			});
			return {
				role,
				modelId: configuredModelId,
				modelDisplayName: provider.displayName,
				providerId,
				providerDisplayName: provider.displayName,
				providerBaseUrl: provider.baseUrl,
				providerModelName: provider.name,
				limits: {
					maxModelContext: providerBudget.maxModelContext,
					compactionUiThreshold: providerBudget.compactionUiThreshold,
					targetConstructedContext: providerBudget.targetConstructedContext,
					maxMessageLength: config.maxMessageLength,
					maxTokens: null,
				},
			};
		}
	}

	if (configuredModelId === "model2" && config.model2Enabled !== false) {
		return {
			role,
			modelId: "model2",
			modelDisplayName: config.model2.displayName,
			providerId: null,
			providerDisplayName: null,
			providerBaseUrl: config.model2.baseUrl,
			providerModelName: config.model2.modelName,
			limits: {
				maxModelContext: config.model2MaxModelContext,
				compactionUiThreshold: config.model2CompactionUiThreshold,
				targetConstructedContext: config.model2TargetConstructedContext,
				maxMessageLength: config.model2MaxMessageLength,
				maxTokens: config.model2.maxTokens,
			},
		};
	}

	return {
		role,
		modelId: "model1",
		modelDisplayName: config.model1.displayName,
		providerId: null,
		providerDisplayName: null,
		providerBaseUrl: config.model1.baseUrl,
		providerModelName: config.model1.modelName,
		limits: {
			maxModelContext: config.model1MaxModelContext,
			compactionUiThreshold: config.model1CompactionUiThreshold,
			targetConstructedContext: config.model1TargetConstructedContext,
			maxMessageLength: config.model1MaxMessageLength,
			maxTokens: config.model1.maxTokens,
		},
	};
}

export async function resolveAllDeepResearchModels(
	config: RuntimeConfig = getConfig(),
): Promise<Record<DeepResearchModelRole, ResolvedDeepResearchModel>> {
	const entries = await Promise.all(
		DEEP_RESEARCH_MODEL_ROLES.map(async (role) => [
			role.id,
			await resolveDeepResearchModel(role.id, config),
		]),
	);
	return Object.fromEntries(entries) as Record<
		DeepResearchModelRole,
		ResolvedDeepResearchModel
	>;
}
