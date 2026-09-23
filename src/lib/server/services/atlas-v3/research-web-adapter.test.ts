import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchUrlViaParallel = vi.fn();

vi.mock("$lib/server/config-store", () => ({
	getConfig: () => ({ parallelApiKey: "key", parallelBaseUrl: null }),
}));
vi.mock("$lib/server/services/parallel-search/fetch-url", () => ({
	PARALLEL_MIN_MAX_AGE_SECONDS: 600,
	fetchUrlViaParallel: (...args: unknown[]) => fetchUrlViaParallel(...args),
}));
vi.mock("$lib/server/services/parallel-search/research", () => ({
	researchWebViaParallel: vi.fn(),
}));
vi.mock("$lib/server/services/web-grounding", () => ({
	buildGroundedWebPageFromFetch: (fetched: { text: string }) => ({
		contentMarkdown: fetched.text,
	}),
}));

import { resetToolResultCacheForTests } from "$lib/server/services/normal-chat-tools/tool-result-cache";
import { createAtlasV3ResearchWeb } from "./research-web-adapter";

const PAGE_URL = "https://example.org/report";

describe("createAtlasV3ResearchWeb read", () => {
	beforeEach(() => {
		resetToolResultCacheForTests();
		fetchUrlViaParallel.mockReset();
	});

	it("answers a repeated read from the conversation cache", async () => {
		fetchUrlViaParallel.mockResolvedValue({ text: "first copy" });
		const web = createAtlasV3ResearchWeb({
			conversationId: "conv-1",
			sessionId: "job-1",
		});
		await web.read(PAGE_URL);
		const again = await web.read(PAGE_URL);
		expect(again).toEqual({ url: PAGE_URL, text: "first copy", cached: true });
		expect(fetchUrlViaParallel).toHaveBeenCalledTimes(1);
	});

	it("bypasses the cache on a fresh read, asks Parallel for a live page, and still caches it", async () => {
		fetchUrlViaParallel
			.mockResolvedValueOnce({ text: "first copy" })
			.mockResolvedValueOnce({ text: "page as it is now" });
		const web = createAtlasV3ResearchWeb({
			conversationId: "conv-1",
			sessionId: "job-1",
		});
		await web.read(PAGE_URL);
		const fresh = await web.read(PAGE_URL, { fresh: true });
		expect(fresh).toEqual({
			url: PAGE_URL,
			text: "page as it is now",
			cached: false,
		});
		expect(fetchUrlViaParallel).toHaveBeenCalledTimes(2);
		// The first read keeps the default policy; the recheck asks for the API's
		// minimum age and refuses a fallback to an older cached copy.
		expect(fetchUrlViaParallel.mock.calls[0]?.[2]).not.toHaveProperty(
			"maxAgeSeconds",
		);
		expect(fetchUrlViaParallel.mock.calls[1]?.[2]).toMatchObject({
			maxAgeSeconds: 600,
			disableCacheFallback: true,
		});
		// The fresh result replaced the cached copy.
		const cached = await web.read(PAGE_URL);
		expect(cached).toEqual({
			url: PAGE_URL,
			text: "page as it is now",
			cached: true,
		});
		expect(fetchUrlViaParallel).toHaveBeenCalledTimes(2);
	});

	it("reports an unreachable fresh read as no text", async () => {
		fetchUrlViaParallel.mockRejectedValue(new Error("live fetch failed"));
		const web = createAtlasV3ResearchWeb({
			conversationId: "conv-1",
			sessionId: "job-1",
		});
		expect(await web.read(PAGE_URL, { fresh: true })).toEqual({
			url: PAGE_URL,
			text: null,
			cached: false,
		});
	});
});
