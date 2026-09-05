import type { DegradedCapabilitiesReport } from "$lib/server/services/tool-health";
import { type FetchLike, requestJson } from "./http";

export type SystemCapabilitiesResponse = DegradedCapabilitiesReport;
export type DegradedCapability = SystemCapabilitiesResponse["degraded"][number];

export async function fetchSystemCapabilities(
	fetchImpl: FetchLike = fetch,
): Promise<SystemCapabilitiesResponse> {
	const response = await requestJson<Partial<SystemCapabilitiesResponse>>(
		"/api/system/capabilities",
		undefined,
		"Failed to load system capabilities",
		fetchImpl,
	);
	return {
		degraded: Array.isArray(response.degraded) ? response.degraded : [],
		checkedAt: typeof response.checkedAt === "string" ? response.checkedAt : "",
	};
}
