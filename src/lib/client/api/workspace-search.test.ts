import { describe, expect, it, vi } from "vitest";
import { fetchWorkspaceSearch } from "./workspace-search";

describe("workspace search client API", () => {
	it("fetches grouped workspace search results with an encoded query", async () => {
		const payload = {
			query: "atlas renewal",
			mode: "query",
			conversations: [],
			documents: [],
			documentOverflow: false,
			knowledgeHref: null,
		};
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(payload), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await expect(
			fetchWorkspaceSearch({ query: "atlas renewal" }, fetchImpl),
		).resolves.toEqual(payload);

		expect(fetchImpl).toHaveBeenCalledWith(
			"/api/workspace-search?q=atlas+renewal",
		);
	});
});
