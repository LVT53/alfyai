import type { ActiveMemoryProfileContext } from "$lib/server/services/memory-profile/active-context";
import { recordMemoryReworkTelemetry } from "$lib/server/services/memory-profile/telemetry";

/**
 * Shared "prompt_use" telemetry for every memory-read path (baseline profile
 * injection and the memory_context tool). The event-name strings differ per
 * call site (dashboards and tests depend on the existing vocabularies), but the
 * summarisation and the fire-and-forget recording live here so there is a
 * single implementation rather than one copy per read path.
 */
export function summarizeActiveMemoryProfileTelemetry(
	context: ActiveMemoryProfileContext,
): {
	categoryCounts: Record<string, number>;
	scopeCounts: Record<string, number>;
} {
	const categoryCounts: Record<string, number> = {};
	const scopeCounts: Record<string, number> = {};
	for (const item of context.items) {
		categoryCounts[item.category] = (categoryCounts[item.category] ?? 0) + 1;
		scopeCounts[item.scope.type] = (scopeCounts[item.scope.type] ?? 0) + 1;
	}
	return { categoryCounts, scopeCounts };
}

export async function recordMemoryPromptTelemetry(params: {
	userId: string;
	eventName: string;
	reason: string;
	status: string;
	count: number;
	metadata?: Record<string, unknown>;
}): Promise<void> {
	try {
		await recordMemoryReworkTelemetry({
			userId: params.userId,
			eventFamily: "prompt_use",
			eventName: params.eventName,
			reason: params.reason,
			status: params.status,
			count: params.count,
			metadata: params.metadata,
		});
	} catch {
		// Read paths must never fail because telemetry is unavailable.
	}
}
