import {
	normalizeModelSelection,
	type RuntimeConfig,
} from "$lib/server/config-store";
import type { ModelId } from "$lib/types";

export type UserModelPreference = ModelId | null;
export type UserModelPreferenceMode = "system" | "explicit";

export interface ResolvedUserModelPreference {
	preference: UserModelPreference;
	effectiveModel: ModelId;
	systemDefaultModel: ModelId;
}

export async function resolveUserModelPreference(
	storedPreference: string | null | undefined,
	storedMode: string | null | undefined,
	config: RuntimeConfig,
): Promise<ResolvedUserModelPreference> {
	const defaultModel = normalizeModelSelection(
		config.defaultNewUserModel,
		config,
	);
	if (storedMode === "system") {
		return {
			preference: null,
			effectiveModel: defaultModel,
			systemDefaultModel: defaultModel,
		};
	}

	const explicitModel =
		storedPreference == null
			? null
			: normalizeModelSelection(storedPreference, config);
	const isLegacyMode = storedMode !== "explicit";
	const preference = isLegacyMode && explicitModel === defaultModel ? null : explicitModel;

	return {
		preference,
		effectiveModel: preference ?? defaultModel,
		systemDefaultModel: defaultModel,
	};
}

export async function modelPreferenceStorageForSystemDefault(
	config: RuntimeConfig,
): Promise<{ preferredModel: ModelId; modelPreferenceMode: UserModelPreferenceMode }> {
	return {
		preferredModel: normalizeModelSelection(config.defaultNewUserModel, config),
		modelPreferenceMode: "system",
	};
}

export async function modelPreferenceStorageForExplicitChoice(
	model: ModelId,
	config: RuntimeConfig,
): Promise<{ preferredModel: ModelId; modelPreferenceMode: UserModelPreferenceMode }> {
	return {
		preferredModel: normalizeModelSelection(model, config),
		modelPreferenceMode: "explicit",
	};
}
