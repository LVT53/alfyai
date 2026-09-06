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
	/** false only when the model's capabilities explicitly mark reasoning
	 * controls unsupported — the composer's thinking toggle hides itself for
	 * such models. See src/lib/model-capabilities.ts. */
	supportsReasoningControls: boolean;
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
