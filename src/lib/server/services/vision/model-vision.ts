import type { ModelId } from "$lib/model-types";
import { getConfig, type RuntimeConfig } from "$lib/server/config-store";
import { resolveModelSelection } from "$lib/server/services/chat-turn/request";
import { resolveNormalChatModelRunProvider } from "$lib/server/services/normal-chat-model";
import { providerCanSeeImages } from "./provider-vision";

// Who may be sent pixels. The admin ticks "Can see images" on a provider model
// (src/lib/model-image-input.ts) and that is the `imageMessageParts` capability
// the run builds into its provider; a built-in model without a provider row has
// nowhere to be ticked and cannot see.

// The question about a built provider is answered in provider-vision.ts, which
// the model run can import without a cycle (this file imports the run); the
// rest of the app reads it from here.
export { providerCanSeeImages };

/** "No model chosen" is the model the turn falls back to. */
async function defaultModelId(runtimeConfig: RuntimeConfig): Promise<ModelId> {
	const selection = await resolveModelSelection(undefined, runtimeConfig);
	return (selection.ok ? selection.value.modelId : undefined) ?? "model1";
}

/**
 * Whether the model a turn will run on can see, for the checks that come before
 * the run (the send gate). A model that cannot be resolved cannot be shown a
 * picture; the turn itself reports that failure.
 */
export async function modelIdCanSeeImages(
	modelId: ModelId | undefined,
): Promise<boolean> {
	try {
		const runtimeConfig = getConfig();
		const provider = await resolveNormalChatModelRunProvider(
			modelId ?? (await defaultModelId(runtimeConfig)),
			runtimeConfig,
		);
		return providerCanSeeImages(provider);
	} catch {
		return false;
	}
}

const LEGACY_MODEL_IDS = ["model1", "model2"] as const;

/**
 * The provider model ("provider:<id>:<model>") each legacy id ("model1",
 * "model2") runs on, for the ids a provider row named after them has taken
 * over. The model list (`/api/models`) names such a row by its own id and hides
 * the legacy one, while a person's selection, and the system default, may
 * still be "model1". This is the run's own resolution of the id, not a second
 * one, so the composer's "can this model see" reads the same row as the send
 * gate's (`modelIdCanSeeImages`). A legacy id with no provider row is left out:
 * the list names it itself.
 */
export async function legacyModelIdAliases(): Promise<
	Partial<Record<(typeof LEGACY_MODEL_IDS)[number], ModelId>>
> {
	const runtimeConfig = getConfig();
	const aliases: Partial<Record<(typeof LEGACY_MODEL_IDS)[number], ModelId>> =
		{};
	for (const legacyId of LEGACY_MODEL_IDS) {
		try {
			const provider = await resolveNormalChatModelRunProvider(
				legacyId,
				runtimeConfig,
			);
			if (provider.modelId && provider.modelId !== legacyId) {
				aliases[legacyId] = provider.modelId;
			}
		} catch {
			// An id the run cannot resolve has nothing to alias.
		}
	}
	return aliases;
}
