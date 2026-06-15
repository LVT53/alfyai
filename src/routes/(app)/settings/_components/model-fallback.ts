import type { ProviderModel } from "$lib/client/api/admin";
import type { ModelCapabilityKey } from "$lib/model-capabilities";
import {
	canUseProviderModelFallback,
	type ProviderModelFallbackCompatibilityInput,
} from "$lib/model-fallback-compatibility";

export type FallbackCompatibilityReason =
	| {
			kind: "disabled-target";
	  }
	| {
			kind: "capability";
			role: "source" | "fallback";
			capability: ModelCapabilityKey;
	  }
	| {
			kind: "unknown-source-capability";
			capability: ModelCapabilityKey;
	  }
	| {
			kind: "unparsed";
			message: string;
	  };

export type FallbackOption = {
	model: ProviderModel;
	compatible: boolean;
	reason: FallbackCompatibilityReason | null;
};

const SUPPORT_REASON_PATTERN =
	/^(source|fallback) model must explicitly support ([a-zA-Z]+)$/;
const UNKNOWN_SOURCE_REASON_PATTERN =
	/^source model capability ([a-zA-Z]+) is unknown; probe or override before choosing a fallback$/;

function toFallbackCompatibilityInput(
	model: ProviderModel,
): ProviderModelFallbackCompatibilityInput {
	return {
		capabilitiesJson: model.capabilitiesJson,
		reasoningEffort: model.reasoningEffort,
		thinkingType: model.thinkingType,
	};
}

function parseFallbackCompatibilityReason(
	message: string,
): FallbackCompatibilityReason {
	const supportMatch = message.match(SUPPORT_REASON_PATTERN);
	if (supportMatch) {
		return {
			kind: "capability",
			role: supportMatch[1] === "source" ? "source" : "fallback",
			capability: supportMatch[2] as ModelCapabilityKey,
		};
	}

	const unknownSourceMatch = message.match(UNKNOWN_SOURCE_REASON_PATTERN);
	if (unknownSourceMatch) {
		return {
			kind: "unknown-source-capability",
			capability: unknownSourceMatch[1] as ModelCapabilityKey,
		};
	}

	return { kind: "unparsed", message };
}

export function getProviderModelFallbackOptions(
	source: ProviderModel,
	allModels: ProviderModel[],
): FallbackOption[] {
	return allModels
		.filter((model) => model.id !== source.id)
		.map((model) => {
			if (!model.enabled) {
				return {
					model,
					compatible: false,
					reason: { kind: "disabled-target" } as const,
				};
			}

			const result = canUseProviderModelFallback(
				toFallbackCompatibilityInput(source),
				toFallbackCompatibilityInput(model),
			);
			return {
				model,
				compatible: result.compatible,
				reason: result.compatible
					? null
					: parseFallbackCompatibilityReason(result.reason),
			};
		})
		.sort((a, b) => {
			if (a.compatible !== b.compatible) return a.compatible ? -1 : 1;
			return a.model.displayName.localeCompare(b.model.displayName);
		});
}

function hasCompatibleProviderModelFallback(
	source: ProviderModel,
	allModels: ProviderModel[],
): boolean {
	return getProviderModelFallbackOptions(source, allModels).some(
		(option) => option.compatible,
	);
}

export function providerHasFallbackWarning(
	providerId: string,
	allModels: ProviderModel[],
): boolean {
	return allModels.some(
		(model) =>
			model.providerId === providerId &&
			model.enabled &&
			!hasCompatibleProviderModelFallback(model, allModels),
	);
}
