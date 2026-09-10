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

export interface AdminConfigOverrideMeta {
	updatedAt: string;
	updatedBy: string;
}

interface AdminConfigResponse {
	overrides?: Record<string, string>;
	overrideMeta?: Record<string, AdminConfigOverrideMeta>;
}

/**
 * When each admin_config override was last written. The System screen shows it
 * on secret rows, where the value is masked and the date is the only evidence
 * that a key is set at all.
 */
export async function fetchAdminConfigOverrideMeta(
	fetchImpl: FetchLike = fetch,
): Promise<Record<string, AdminConfigOverrideMeta>> {
	const response = await requestJson<AdminConfigResponse>(
		"/api/admin/config",
		undefined,
		"Failed to load admin configuration",
		fetchImpl,
	);
	return response.overrideMeta ?? {};
}

/**
 * Runs the provider's own connection check (GET /v1/models with its stored
 * key). The endpoint existed but nothing called it: the Test button in the old
 * provider dialog was wired to a handler the pane never passed.
 */
export async function validateProviderConnection(
	providerId: string,
	fetchImpl: FetchLike = fetch,
): Promise<{ valid: boolean; error?: string }> {
	return requestJson<{ valid: boolean; error?: string }>(
		`/api/admin/providers/${encodeURIComponent(providerId)}/validate`,
		{ method: "POST" },
		"Failed to validate provider",
		fetchImpl,
	);
}
