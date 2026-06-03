import { requestJson } from "./http";

export interface ProviderModel {
	id: string;
	displayName: string;
}

export interface ModelProvider {
	id: string;
	name: string;
	displayName: string;
	iconAssetId: string | null;
	iconUrl: string | null;
	models: ProviderModel[];
}

export interface AvailableModelsResponse {
	providers: ModelProvider[];
}

export async function fetchAvailableModels(): Promise<AvailableModelsResponse> {
	const payload = await requestJson<{ providers?: ModelProvider[] }>(
		"/api/models",
		undefined,
		"Failed to load models",
	);

	return { providers: payload.providers ?? [] };
}
