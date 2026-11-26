import type {
	WorkspaceSearchResponse,
	WorkspaceSearchScope,
} from "$lib/server/services/workspace-search";
import { type FetchLike, requestJson } from "./http";

export async function fetchWorkspaceSearch(
	options: {
		query?: string | null;
		/** One kind's page; "all" (the default) is a few of each kind. */
		scope?: WorkspaceSearchScope;
		/** The `nextCursor` of the page before, to load the next one. */
		cursor?: string | null;
		signal?: AbortSignal;
	} = {},
	fetchImpl?: FetchLike,
): Promise<WorkspaceSearchResponse> {
	const params = new URLSearchParams();
	params.set("q", options.query ?? "");
	if (options.scope && options.scope !== "all") {
		params.set("scope", options.scope);
	}
	if (options.cursor) {
		params.set("cursor", options.cursor);
	}
	return requestJson<WorkspaceSearchResponse>(
		`/api/workspace-search?${params.toString()}`,
		options.signal ? { signal: options.signal } : undefined,
		"Failed to search the workspace.",
		fetchImpl,
	);
}
