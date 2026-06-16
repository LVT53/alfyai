import type { WorkspaceSearchResponse } from "$lib/types";
import { type FetchLike, requestJson } from "./http";

export async function fetchWorkspaceSearch(
	options: { query?: string | null } = {},
	fetchImpl?: FetchLike,
): Promise<WorkspaceSearchResponse> {
	const params = new URLSearchParams();
	params.set("q", options.query ?? "");
	return requestJson<WorkspaceSearchResponse>(
		`/api/workspace-search?${params.toString()}`,
		undefined,
		"Failed to search the workspace.",
		fetchImpl,
	);
}
