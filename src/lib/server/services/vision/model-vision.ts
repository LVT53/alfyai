import { isModelCapabilitySupported } from "$lib/model-capabilities";
import type { ModelId } from "$lib/model-types";
import { getConfig, type RuntimeConfig } from "$lib/server/config-store";
import { resolveModelSelection } from "$lib/server/services/chat-turn/request";
import {
	type NormalChatModelRunProvider,
	resolveNormalChatModelRunProvider,
} from "$lib/server/services/normal-chat-model";

// Who may be sent pixels. The admin ticks "Can see images" on a provider model
// (src/lib/model-image-input.ts) and that is the `imageMessageParts` capability
// the run builds into its provider; a built-in model without a provider row has
// nowhere to be ticked and cannot see.

/** Only an explicit "supported" counts: unknown and missing do not. */
export function providerCanSeeImages(
	provider: NormalChatModelRunProvider,
): boolean {
	return isModelCapabilitySupported(provider.capabilities, "imageMessageParts");
}

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
