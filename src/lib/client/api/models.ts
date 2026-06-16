import { requestJson } from "./http";

export interface ProviderModel {
	id: string;
	displayName: string;
	iconUrl: string | null;
	guideNoteEn: string | null;
	guideNoteHu: string | null;
	guideBadge: "intelligent" | "simple" | null;
	guideNoCost: boolean;
	estimatedTokensPerSecond: number | null;
	maxModelContext: number | null;
	inputUsdMicrosPer1m: number;
	outputUsdMicrosPer1m: number;
}

export interface ModelProvider {
	id: string;
	name: string;
	displayName: string;
	iconAssetId: string | null;
	iconUrl: string | null;
	processingRegionCode: string | null;
	privacyPolicyUrl: string | null;
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
