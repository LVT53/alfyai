import type { ModelCapabilityStatus } from "./model-capabilities";
import { parseCapabilitySupportMap } from "./model-fallback-compatibility";

// "Can see images" is the `imageMessageParts` capability a provider model keeps
// in `provider_models.capabilities_json` (src/lib/model-capabilities.ts). The
// admin form writes it and the available-models payload reads it through this
// pair, and a chat turn builds its provider's entry from the same reading
// (readModelImageInput), so the stored shape is decided in one place.
//
// Ticked is an explicit `supported: true` manual override. Unticked takes the
// key out and never writes `supported: false`: an explicit `false` on a model
// makes `canUseProviderModelFallback` refuse it as the fallback of a model that
// can see, and a model that merely has not been ticked must stay acceptable.

const IMAGE_INPUT_ENABLED: Pick<
	ModelCapabilityStatus,
	"state" | "supported" | "source"
> = {
	state: "manual_override",
	supported: true,
	source: "manual_override",
};

function readCapabilityRecord(
	capabilitiesJson: string | null | undefined,
): Record<string, unknown> {
	if (!capabilitiesJson) return {};
	try {
		const parsed: unknown = JSON.parse(capabilitiesJson);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed)
		) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// Unparseable JSON counts as no capabilities at all.
	}
	return {};
}

/**
 * What the stored entry says, in whatever shape probes, older rows and hand
 * edits wrote it: `true` (can see), `false` (an explicit no) or `null` (nothing
 * decided: absent, unknown or unreadable). The one reading of the entry, for
 * the admin form (`modelCanSeeImages`) and for the capability entry a chat turn
 * builds from the same string (normal-chat-model/index.ts), which has to tell
 * an explicit no from nothing said.
 */
export function readModelImageInput(
	capabilitiesJson: string | null | undefined,
): boolean | null {
	return parseCapabilitySupportMap(capabilitiesJson ?? "").imageMessageParts;
}

/** Only an explicit "supported" counts: unknown, missing and `false` do not. */
export function modelCanSeeImages(
	capabilitiesJson: string | null | undefined,
): boolean {
	return readModelImageInput(capabilitiesJson) === true;
}

/**
 * Returns `capabilitiesJson` with the image capability set or taken out and
 * every other capability left exactly as it was.
 */
export function setModelImageInput(
	capabilitiesJson: string | null | undefined,
	enabled: boolean,
): string {
	const capabilities = readCapabilityRecord(capabilitiesJson);
	if (enabled) {
		return JSON.stringify({
			...capabilities,
			imageMessageParts: IMAGE_INPUT_ENABLED,
		});
	}
	const { imageMessageParts: _removed, ...others } = capabilities;
	return JSON.stringify(others);
}
