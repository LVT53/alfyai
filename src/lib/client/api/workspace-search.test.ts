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

	it("sends the chosen kind and the page cursor, and leaves out the default kind", async () => {
		const fetchImpl = vi.fn().mockImplementation(
			async () =>
				new Response(JSON.stringify({ query: "kitchen" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);

		await fetchWorkspaceSearch(
			{ query: "kitchen plan", scope: "chats", cursor: "o:20" },
			fetchImpl,
		);
		await fetchWorkspaceSearch({ query: "kitchen", scope: "all" }, fetchImpl);

		expect(fetchImpl).toHaveBeenNthCalledWith(
			1,
			"/api/workspace-search?q=kitchen+plan&scope=chats&cursor=o%3A20",
		);
		expect(fetchImpl).toHaveBeenNthCalledWith(
			2,
			"/api/workspace-search?q=kitchen",
		);
	});

	it("hands an abort signal on to the request", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ query: "kitchen" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		const controller = new AbortController();

		await fetchWorkspaceSearch(
			{ query: "kitchen", signal: controller.signal },
			fetchImpl,
		);

		expect(fetchImpl).toHaveBeenCalledWith("/api/workspace-search?q=kitchen", {
			signal: controller.signal,
		});
	});
});
