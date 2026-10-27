import { isModelCapabilitySupported } from "$lib/model-capabilities";
// The same classifier locality.ts asks of a model's provider (`isCloudModel`),
// from the leaf it lives in: this file is imported by the model run, so it can
// not import locality.ts, which imports the run.
import { isPrivateHostname } from "$lib/server/services/connections/host-locality";
// A type only, on purpose. The model run imports this file (it asks before
// every attempt whether the model may be sent pictures), so this file must
// never import the run's values back: that would be a circular dependency, and
// the Fallow gate refuses a fifth one. model-vision.ts, which does import the
// run to resolve a model id, re-exports the question from here.
import type { NormalChatModelRunProvider } from "$lib/server/services/normal-chat-model";

// The two questions about a provider the model run has built before it sends an
// attempt anything: may it be sent pictures, and does it run on the person's own
// box?

/** Only an explicit "supported" counts: unknown and missing do not. */
export function providerCanSeeImages(
	provider: NormalChatModelRunProvider,
): boolean {
	return isModelCapabilitySupported(provider.capabilities, "imageMessageParts");
}

/**
 * Whether a model served from this provider runs on the person's own box: its
 * base URL names a private, loopback or link-local host. This is the rule
 * `isCloudModel` (connections/locality.ts) applies to a model's provider, for
 * the provider the run is about to call instead of a model id the connector
 * gate looked up: `isCloudModel(model)` is `!providerRunsLocally(provider)`
 * (provider-vision.test.ts holds the two together over a table of addresses).
 * A base URL that cannot be read is not local.
 */
export function providerRunsLocally(
	provider: Pick<NormalChatModelRunProvider, "baseUrl">,
): boolean {
	try {
		return isPrivateHostname(new URL(provider.baseUrl).hostname);
	} catch {
		return false;
	}
}
