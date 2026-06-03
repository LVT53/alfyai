import { json } from "@sveltejs/kit";
import {
	getAvailableModels,
	getEnabledProviders,
	modelIconUrl,
} from "$lib/server/config-store";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
	const [builtInModels, oldProviders] = await Promise.all([
		Promise.resolve(getAvailableModels()),
		getEnabledProviders(),
	]);

	const { listEnabledProviders: listNewProviders } = await import(
		"$lib/server/services/providers"
	);
	const { listEnabledProviderModels: listNewProviderModels } = await import(
		"$lib/server/services/provider-models"
	);

	const newProviders = await listNewProviders();

	const providers: Array<{
		id: string;
		name: string;
		displayName: string;
		iconAssetId: string | null;
		iconUrl: string | null;
		models: Array<{ id: string; displayName: string }>;
	}> = [];

	// Built-in provider group
	if (builtInModels.length > 0) {
		providers.push({
			id: "built-in",
			name: "built-in",
			displayName: "AlfyAI",
			iconAssetId: null,
			iconUrl: null,
			models: builtInModels.map((m) => ({
				id: m.id,
				displayName: m.displayName,
			})),
		});
	}

	// Old inference providers
	for (const provider of oldProviders) {
		providers.push({
			id: provider.id,
			name: provider.name,
			displayName: provider.displayName,
			iconAssetId: provider.iconAssetId,
			iconUrl: modelIconUrl(provider.iconAssetId),
			models: [
				{
					id: `provider:${provider.id}`,
					displayName: provider.displayName,
				},
			],
		});
	}

	// New providers with their models
	for (const provider of newProviders) {
		const models = await listNewProviderModels(provider.id);
		const enabledModels = models.filter((m) => m.enabled);

		if (enabledModels.length > 0) {
			providers.push({
				id: provider.id,
				name: provider.name,
				displayName: provider.displayName,
				iconAssetId: provider.iconAssetId,
				iconUrl: modelIconUrl(provider.iconAssetId),
				models: enabledModels.map((m) => ({
					id: `provider:${provider.id}:${m.id}`,
					displayName: m.displayName,
				})),
			});
		}
	}

	return json({ providers });
};
