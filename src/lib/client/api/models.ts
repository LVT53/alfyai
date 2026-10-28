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
	/** true only when the admin marked the model "Can see images" (the
	 * `imageMessageParts` capability, see src/lib/model-image-input.ts). */
	supportsImages: boolean;
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
	/** Legacy ids ("model1", "model2") mapped to the provider model the server
	 *  runs them on, when a provider row has taken them over: the list names
	 *  that row by its own id. See `legacyModelIdAliases` (vision/model-vision). */
	modelAliases: Partial<Record<string, string>>;
}

export async function fetchAvailableModels(): Promise<AvailableModelsResponse> {
	const payload = await requestJson<{
		providers?: ModelProvider[];
		modelAliases?: Partial<Record<string, string>>;
	}>("/api/models", undefined, "Failed to load models");

	return {
		providers: payload.providers ?? [],
		modelAliases: payload.modelAliases ?? {},
	};
}

/** The listed model a selected id means: the id itself, or the provider model
 *  the server resolves a legacy id to. `null` when the list has neither. */
export function findAvailableModel(
	models: AvailableModelsResponse,
	modelId: string,
): ProviderModel | null {
	const listedId = models.modelAliases[modelId] ?? modelId;
	for (const provider of models.providers) {
		const found = provider.models.find((model) => model.id === listedId);
		if (found) return found;
	}
	return null;
}
