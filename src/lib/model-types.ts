// Model/provider identity: the `ModelId` contract (built-in models plus
// `provider:<provider-uuid>:<model-uuid>` custom-provider ids) and the
// helpers that parse it. Client- and server-shared — relocated out of the
// former src/lib/types.ts god-module (architecture-deepening T1); this file
// carries no behavior change, only a new home.

export type ModelId = "model1" | "model2" | `provider:${string}`;
export type UserModelPreference = ModelId | null;

export function isProviderModelId(
	modelId: string,
): modelId is `provider:${string}` {
	return modelId.startsWith("provider:");
}

export function getProviderIdFromModelId(modelId: ModelId): string | null {
	if (!modelId.startsWith("provider:")) return null;
	const parts = modelId.split(":");
	// Format: provider:<provider-uuid>:<model-uuid>
	if (parts.length >= 3) return parts[2]; // model UUID
	if (parts.length === 2) return parts[1]; // legacy provider ID
	return null;
}
