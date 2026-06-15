import type { ModelId } from "$lib/types";
import type { RuntimeConfig } from "../config-store";
import {
	listEnabledProviderModels,
	type ProviderModel,
} from "./provider-models";
import { listEnabledProviders, type Provider } from "./providers";

export interface AvailableBuiltInModel {
	id: ModelId;
	displayName: string;
	iconAssetId: string | null;
	iconUrl: string | null;
}

export interface AvailableSettingsModel extends AvailableBuiltInModel {
	isThirdParty: boolean;
}

export interface AvailableModelProviderGroup {
	id: string;
	name: string;
	displayName: string;
	iconAssetId: string | null;
	iconUrl: string | null;
	processingRegionCode: string | null;
	privacyPolicyUrl: string | null;
	models: Array<{
		id: ModelId;
		displayName: string;
		iconUrl: string | null;
		guideNoteEn: string | null;
		guideNoteHu: string | null;
		guideBadge: "intelligent" | "fast" | null;
		maxModelContext: number | null;
		inputUsdMicrosPer1m: number;
		outputUsdMicrosPer1m: number;
	}>;
}

export function modelIconUrl(
	iconAssetId: string | null | undefined,
): string | null {
	return iconAssetId
		? `/api/campaign-assets/${encodeURIComponent(iconAssetId)}/content`
		: null;
}

export function projectBuiltInAvailableModels(
	config: RuntimeConfig,
): AvailableBuiltInModel[] {
	const models: AvailableBuiltInModel[] = [];

	if (config.model1.baseUrl && config.model1.modelName) {
		models.push({
			id: "model1",
			displayName: config.model1.displayName,
			iconAssetId: config.model1IconAssetId,
			iconUrl: modelIconUrl(config.model1IconAssetId),
		});
	}

	if (
		config.model2Enabled !== false &&
		config.model2.baseUrl &&
		config.model2.modelName
	) {
		models.push({
			id: "model2",
			displayName: config.model2.displayName,
			iconAssetId: config.model2IconAssetId,
			iconUrl: modelIconUrl(config.model2IconAssetId),
		});
	}

	return models;
}

function providerModelId(provider: Provider, model: ProviderModel): ModelId {
	return `provider:${provider.id}:${model.id}` as ModelId;
}

function projectProviderModelForSettings(
	provider: Provider,
	model: ProviderModel,
): AvailableSettingsModel {
	return {
		id: providerModelId(provider, model),
		displayName: `${provider.displayName} - ${model.displayName}`,
		isThirdParty: true,
		iconAssetId: model.iconAssetId,
		iconUrl: modelIconUrl(model.iconAssetId),
	};
}

function projectProviderFallbackForSettings(
	provider: Provider,
): AvailableSettingsModel {
	return {
		id: `provider:${provider.id}` as ModelId,
		displayName: provider.displayName,
		isThirdParty: true,
		iconAssetId: provider.iconAssetId,
		iconUrl: modelIconUrl(provider.iconAssetId),
	};
}

export async function getAvailableModelsWithProvidersForSettings(
	config: RuntimeConfig,
): Promise<AvailableSettingsModel[]> {
	const models: AvailableSettingsModel[] = projectBuiltInAvailableModels(
		config,
	).map((model) => ({ ...model, isThirdParty: false }));

	let providers: Provider[];
	try {
		providers = await listEnabledProviders();
	} catch {
		return models;
	}

	for (const provider of providers) {
		try {
			const providerModels = await listEnabledProviderModels(provider.id);
			for (const model of providerModels) {
				models.push(projectProviderModelForSettings(provider, model));
			}
		} catch {
			models.push(projectProviderFallbackForSettings(provider));
		}
	}

	return models;
}

export async function getAvailableModelProviderGroups(
	config: RuntimeConfig,
): Promise<AvailableModelProviderGroup[]> {
	const [builtInModels, providers] = await Promise.all([
		Promise.resolve(projectBuiltInAvailableModels(config)),
		listEnabledProviders(),
	]);
	const groups: AvailableModelProviderGroup[] = [];
	const seededProviderNames = new Set(
		providers.map((provider) => provider.name),
	);
	const visibleBuiltIns = builtInModels.filter(
		(model) => !seededProviderNames.has(model.id),
	);

	if (visibleBuiltIns.length > 0) {
		groups.push({
			id: "built-in",
			name: "built-in",
			displayName: "AlfyAI",
			iconAssetId: null,
			iconUrl: null,
			processingRegionCode: null,
			privacyPolicyUrl: null,
			models: visibleBuiltIns.map((model) => ({
				id: model.id,
				displayName: model.displayName,
				iconUrl: model.iconUrl ?? null,
				guideNoteEn: null,
				guideNoteHu: null,
				guideBadge: null,
				maxModelContext: null,
				inputUsdMicrosPer1m: 0,
				outputUsdMicrosPer1m: 0,
			})),
		});
	}

	for (const provider of providers) {
		const providerModels = await listEnabledProviderModels(provider.id);
		if (providerModels.length === 0) continue;

		groups.push({
			id: provider.id,
			name: provider.name,
			displayName: provider.displayName,
			iconAssetId: provider.iconAssetId,
			iconUrl: modelIconUrl(provider.iconAssetId),
			processingRegionCode: provider.processingRegionCode,
			privacyPolicyUrl: provider.privacyPolicyUrl,
			models: providerModels.map((model) => ({
				id: providerModelId(provider, model),
				displayName: model.displayName,
				iconUrl: modelIconUrl(model.iconAssetId),
				guideNoteEn: model.guideNoteEn,
				guideNoteHu: model.guideNoteHu,
				guideBadge: model.guideBadge,
				maxModelContext: model.maxModelContext,
				inputUsdMicrosPer1m: model.inputUsdMicrosPer1m,
				outputUsdMicrosPer1m: model.outputUsdMicrosPer1m,
			})),
		});
	}

	return groups;
}
