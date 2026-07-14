import { getConfig } from "$lib/server/config-store";

// Resolve the selected model's context window (in tokens) from a model id.
// Composite ids (`provider:<providerId>:<modelId>`) resolve against the
// provider-models table; builtin ids (model1/model2) resolve from runtime
// config. Returns null when the model or its capacity can't be resolved, which
// resolveFetchContentCharCap turns into a safe default cap.
//
// provider-models is imported dynamically so importing this helper does not
// eagerly pull the database layer into callers that only need the builtin
// (model1/model2) branch (e.g. the normal-chat context builder).
export async function resolveModelContextTokens(
	modelId: string | undefined,
): Promise<number | null> {
	if (!modelId) return null;
	if (modelId.startsWith("provider:")) {
		const parts = modelId.split(":");
		if (parts.length >= 3) {
			try {
				const { listEnabledProviderModels } = await import(
					"$lib/server/services/provider-models"
				);
				const models = await listEnabledProviderModels(parts[1]);
				// The model segment can itself contain colons (e.g. an id like
				// "org/model:tag"), so rejoin everything after the provider segment.
				const modelSegment = parts.slice(2).join(":");
				const model = models.find((candidate) => candidate.id === modelSegment);
				if (model) {
					return (
						model.maxModelContext ?? model.targetConstructedContext ?? null
					);
				}
			} catch {
				return null;
			}
		}
		return null;
	}
	try {
		const config = getConfig();
		return modelId === "model2"
			? (config.model2MaxModelContext ?? null)
			: (config.model1MaxModelContext ?? null);
	} catch {
		return null;
	}
}
