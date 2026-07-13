import { getConfig, type RuntimeConfig } from "$lib/server/config-store";
import type { AtlasAvailability } from "$lib/types";

export function getAtlasAvailability(
	config: RuntimeConfig = getConfig(),
): AtlasAvailability {
	const parallelApiKey = config.parallelApiKey.trim();
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
