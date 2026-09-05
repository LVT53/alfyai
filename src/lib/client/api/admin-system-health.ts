// Browser fetchers for the admin System pane's health surfaces: the tool
// health snapshot (GET, or POST to force a fresh probe run) and the
// effective-configuration readout. Kept out of admin.ts so the many tests
// that mock that module by explicit export list keep working unchanged.

import type { EffectiveConfigReport } from "$lib/server/services/admin-effective-config";
import type { ToolHealthSnapshot } from "$lib/server/services/tool-health";
import { type FetchLike, requestJson } from "./http";

export type {
	BuiltinModelResolution,
	EffectiveConfigEntry,
	EffectiveConfigReport,
	EffectiveConfigSource,
} from "$lib/server/services/admin-effective-config";
export type {
	ToolHealthReport,
	ToolHealthSnapshot,
	ToolHealthStatus,
} from "$lib/server/services/tool-health";

interface ToolHealthResponse {
	snapshot?: ToolHealthSnapshot;
}

function normalizeSnapshot(
	snapshot: ToolHealthSnapshot | undefined,
): ToolHealthSnapshot {
	return {
		checkedAt:
			typeof snapshot?.checkedAt === "string" ? snapshot.checkedAt : "",
		durationMs:
			typeof snapshot?.durationMs === "number" ? snapshot.durationMs : 0,
		tools: Array.isArray(snapshot?.tools) ? snapshot.tools : [],
	};
}

export async function fetchAdminToolHealth(
	options: { refresh?: boolean } = {},
	fetchImpl: FetchLike = fetch,
): Promise<ToolHealthSnapshot> {
	const response = await requestJson<ToolHealthResponse>(
		"/api/admin/tool-health",
		options.refresh ? { method: "POST" } : undefined,
		"Failed to load tool health",
		fetchImpl,
	);
	return normalizeSnapshot(response.snapshot);
}

export async function fetchAdminEffectiveConfig(
	fetchImpl: FetchLike = fetch,
): Promise<EffectiveConfigReport> {
	const response = await requestJson<Partial<EffectiveConfigReport>>(
		"/api/admin/config/effective",
		undefined,
		"Failed to load effective configuration",
		fetchImpl,
	);
	return {
		generatedAt:
			typeof response.generatedAt === "string" ? response.generatedAt : "",
		entries: Array.isArray(response.entries) ? response.entries : [],
		models: Array.isArray(response.models) ? response.models : [],
	};
}
