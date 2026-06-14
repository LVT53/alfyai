import { deriveModelContextLimits } from "$lib/model-context-defaults";

export type ProviderModelRuntimeDefaultInput = {
	maxModelContext?: number | null;
	compactionUiThreshold?: number | null;
	targetConstructedContext?: number | null;
	maxTokens?: number | null;
	reasoningEffort?: string | null;
	thinkingType?: string | null;
};

export type ProviderModelRuntimeDefaults = {
	maxOutputTokens?: number;
	maxModelContext?: number;
	compactionUiThreshold?: number;
	targetConstructedContext?: number;
	reasoningEffort?: "low" | "medium" | "high" | "max" | "xhigh";
	thinkingType?: "enabled" | "disabled";
};

export type ProviderModelPersistenceContextDefaults = {
	maxModelContext: number | null;
	compactionUiThreshold: number | null;
	targetConstructedContext: number | null;
};

export type ProviderModelPersistenceDefaults =
	ProviderModelPersistenceContextDefaults & {
		maxTokens: number | null;
		reasoningEffort: ProviderModelRuntimeDefaults["reasoningEffort"] | null;
		thinkingType: ProviderModelRuntimeDefaults["thinkingType"] | null;
	};

function finitePositiveInteger(
	value: number | null | undefined,
): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 1
		? Math.floor(value)
		: null;
}

function normalizeReasoningEffort(
	value: string | null | undefined,
): ProviderModelRuntimeDefaults["reasoningEffort"] {
	return value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "max" ||
		value === "xhigh"
		? value
		: undefined;
}

function normalizeThinkingType(
	value: string | null | undefined,
): ProviderModelRuntimeDefaults["thinkingType"] {
	return value === "enabled" || value === "disabled" ? value : undefined;
}

export function resolveProviderModelRuntimeDefaults(
	model: ProviderModelRuntimeDefaultInput,
): ProviderModelRuntimeDefaults {
	const maxModelContext = finitePositiveInteger(model.maxModelContext);
	const explicitCompactionUiThreshold = finitePositiveInteger(
		model.compactionUiThreshold,
	);
	const explicitTargetConstructedContext = finitePositiveInteger(
		model.targetConstructedContext,
	);
	const contextLimits =
		maxModelContext !== null
			? deriveModelContextLimits({
					maxModelContext,
					compactionUiThreshold: explicitCompactionUiThreshold,
					targetConstructedContext: explicitTargetConstructedContext,
				})
			: null;
	const maxOutputTokens = finitePositiveInteger(model.maxTokens);
	const reasoningEffort = normalizeReasoningEffort(model.reasoningEffort);
	const thinkingType = normalizeThinkingType(model.thinkingType);

	return {
		...(maxOutputTokens !== null ? { maxOutputTokens } : {}),
		...(contextLimits
			? {
					maxModelContext: contextLimits.maxModelContext,
					compactionUiThreshold: contextLimits.compactionUiThreshold,
					targetConstructedContext: contextLimits.targetConstructedContext,
				}
			: {}),
		...(!contextLimits && explicitCompactionUiThreshold !== null
			? { compactionUiThreshold: explicitCompactionUiThreshold }
			: {}),
		...(!contextLimits && explicitTargetConstructedContext !== null
			? { targetConstructedContext: explicitTargetConstructedContext }
			: {}),
		...(reasoningEffort ? { reasoningEffort } : {}),
		...(thinkingType ? { thinkingType } : {}),
	};
}

export function resolveProviderModelPersistenceContextDefaults(
	model: Pick<
		ProviderModelRuntimeDefaultInput,
		"maxModelContext" | "compactionUiThreshold" | "targetConstructedContext"
	>,
): ProviderModelPersistenceContextDefaults {
	const maxModelContext = finitePositiveInteger(model.maxModelContext);
	const explicitCompactionUiThreshold = finitePositiveInteger(
		model.compactionUiThreshold,
	);
	const explicitTargetConstructedContext = finitePositiveInteger(
		model.targetConstructedContext,
	);

	if (maxModelContext === null) {
		return {
			maxModelContext: null,
			compactionUiThreshold: explicitCompactionUiThreshold,
			targetConstructedContext: explicitTargetConstructedContext,
		};
	}

	const contextLimits = deriveModelContextLimits({
		maxModelContext,
		compactionUiThreshold: explicitCompactionUiThreshold,
		targetConstructedContext: explicitTargetConstructedContext,
	});

	return {
		maxModelContext: contextLimits.maxModelContext,
		compactionUiThreshold: contextLimits.compactionUiThreshold,
		targetConstructedContext: contextLimits.targetConstructedContext,
	};
}

export function resolveProviderModelPersistenceDefaults(
	model: ProviderModelRuntimeDefaultInput,
): ProviderModelPersistenceDefaults {
	return {
		...resolveProviderModelPersistenceContextDefaults(model),
		maxTokens: finitePositiveInteger(model.maxTokens),
		reasoningEffort: normalizeReasoningEffort(model.reasoningEffort) ?? null,
		thinkingType: normalizeThinkingType(model.thinkingType) ?? null,
	};
}
