import { describe, expect, it, vi } from "vitest";

describe("Atlas search stage", () => {
	it("requires SearXNG configuration", async () => {
		const { runAtlasSearchStage } = await import("./search");

		const result = await runAtlasSearchStage({
			queries: ["enterprise search"],
			config: { searxngBaseUrl: "" },
			search: vi.fn(),
		});

		expect(result).toMatchObject({
			sources: [],
			limitation: {
				code: "atlas_searxng_required",
			},
		});
	});

	it("uses bounded batch concurrency and stops when more than half a batch fails", async () => {
		const { runAtlasSearchStage } = await import("./search");
		let active = 0;
		let maxActive = 0;
		const search = vi.fn(async (query: string) => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await Promise.resolve();
			active -= 1;
			if (query !== "q1") {
				throw new Error(`failed ${query}`);
			}
			return [
				{
					id: "source-q1",
					title: "Source q1",
					url: "https://example.com/q1",
					snippet: "snippet",
				},
			];
		});

		const result = await runAtlasSearchStage({
			queries: ["q1", "q2", "q3", "q4"],
			config: {
				searxngBaseUrl: "http://searxng.local",
				concurrency: 3,
				interBatchDelayMs: 0,
				initialRetryBackoffMs: 0,
				maxRetryBackoffMs: 0,
				maxAttempts: 1,
			},
			search,
		});

		expect(maxActive).toBeLessThanOrEqual(3);
		expect(search).toHaveBeenCalledTimes(3);
		expect(result.sources).toHaveLength(1);
		expect(result.limitation).toMatchObject({
			code: "atlas_search_batch_failure_limit",
			failedQueries: ["q2", "q3"],
		});
	});
});
