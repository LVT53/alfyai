import { getConfig, type RuntimeConfig } from "$lib/server/config-store";
import type { AtlasAvailability } from "$lib/types";

export function getAtlasAvailability(
	config: RuntimeConfig = getConfig(),
): AtlasAvailability {
	// TODO(#13): read `parallelApiKey` from a first-class RuntimeConfig field
	// once Wave 4 adds it; until then it is resolved defensively.
	const parallelApiKey = (
		config as { parallelApiKey?: string }
	).parallelApiKey?.trim();
	if (!config.atlasWorkerEnabled) {
		return {
			enabled: false,
			configured: Boolean(parallelApiKey),
			reasonCode: "disabled",
			reason: "Atlas is disabled by the administrator.",
		};
	}
	if (!parallelApiKey) {
		return {
			enabled: true,
			configured: false,
			reasonCode: "missing_parallel",
			reason: "Atlas requires Parallel Search API configuration.",
		};
	}
	return { enabled: true, configured: true, reasonCode: null, reason: null };
}
