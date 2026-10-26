import { isModelCapabilitySupported } from "$lib/model-capabilities";
// A type only, on purpose. The model run imports this file (it asks before
// every attempt whether the model may be sent pictures), so this file must
// never import the run's values back: that would be a circular dependency, and
// the Fallow gate refuses a fifth one. model-vision.ts, which does import the
// run to resolve a model id, re-exports the question from here.
import type { NormalChatModelRunProvider } from "$lib/server/services/normal-chat-model";

// The one question about a provider the model run has built: may it be sent
// pictures? The answer is the `imageMessageParts` capability the run builds
// from the admin's "Can see images" tick (src/lib/model-image-input.ts).

/** Only an explicit "supported" counts: unknown and missing do not. */
export function providerCanSeeImages(
	provider: NormalChatModelRunProvider,
): boolean {
	return isModelCapabilitySupported(provider.capabilities, "imageMessageParts");
}
