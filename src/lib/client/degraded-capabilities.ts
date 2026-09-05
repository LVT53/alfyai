// Browser-side helpers for the degraded-capabilities banner: session-scoped
// dismissal (keyed by the set of degraded tools, so a NEW degradation re-shows
// the banner) and the tool -> i18n label mapping.

import type { DegradedCapability } from "$lib/client/api/system";
import type { I18nKey } from "$lib/i18n";

export const DEGRADED_CAPABILITIES_POLL_MS = 5 * 60_000;
const DISMISSED_STORAGE_KEY = "alfyai:degraded-capabilities:dismissed";

export function degradedSignature(degraded: DegradedCapability[]): string {
	return Array.from(new Set(degraded.map((item) => item.tool)))
		.sort()
		.join(",");
}

function storage(): Storage | null {
	try {
		return typeof sessionStorage === "undefined" ? null : sessionStorage;
	} catch {
		return null;
	}
}

export function isDegradedBannerDismissed(
	degraded: DegradedCapability[],
): boolean {
	const signature = degradedSignature(degraded);
	if (!signature) return true;
	try {
		return storage()?.getItem(DISMISSED_STORAGE_KEY) === signature;
	} catch {
		return false;
	}
}

export function dismissDegradedBanner(degraded: DegradedCapability[]): void {
	try {
		storage()?.setItem(DISMISSED_STORAGE_KEY, degradedSignature(degraded));
	} catch {
		// sessionStorage unavailable (private mode, SSR) — banner simply re-shows.
	}
}

const TOOL_LABEL_KEYS: Record<string, I18nKey> = {
	research_web: "chat.degradedBanner.tool.research_web",
	fetch_url: "chat.degradedBanner.tool.fetch_url",
	image_search: "chat.degradedBanner.tool.image_search",
	memory_context: "chat.degradedBanner.tool.memory_context",
	map_route: "chat.degradedBanner.tool.map_route",
	produce_file: "chat.degradedBanner.tool.produce_file",
	location: "chat.degradedBanner.tool.location",
};

// Unique, ordered, human labels for the banner sentence. Tools without a
// translation fall back to their model-facing name.
export function degradedToolLabels(
	degraded: DegradedCapability[],
	translate: (key: I18nKey) => string,
): string[] {
	const seen = new Set<string>();
	const labels: string[] = [];
	for (const item of degraded) {
		if (seen.has(item.tool)) continue;
		seen.add(item.tool);
		const key = TOOL_LABEL_KEYS[item.tool];
		labels.push(key ? translate(key) : item.tool);
	}
	return labels;
}
