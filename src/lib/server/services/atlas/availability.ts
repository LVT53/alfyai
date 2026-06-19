import { getConfig, type RuntimeConfig } from "$lib/server/config-store";
import type { AtlasAvailability } from "$lib/types";

export function getAtlasAvailability(
	config: RuntimeConfig = getConfig(),
): AtlasAvailability {
	if (!config.atlasWorkerEnabled) {
		return {
			enabled: false,
			configured: Boolean(config.searxngBaseUrl?.trim()),
			reasonCode: "disabled",
			reason: "Atlas is disabled by the administrator.",
		};
	}
	if (!config.searxngBaseUrl?.trim()) {
		return {
			enabled: true,
			configured: false,
			reasonCode: "missing_searxng",
			reason: "Atlas requires SearXNG web search configuration.",
		};
	}
	return { enabled: true, configured: true, reasonCode: null, reason: null };
}
