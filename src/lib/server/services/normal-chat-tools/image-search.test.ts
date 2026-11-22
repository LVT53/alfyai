import { describe, expect, it, vi } from "vitest";
import {
	compactImageSearchResults,
	createImageSearchCandidates,
	createTurnImageInspection,
	imageSearchInputSchema,
} from "./image-search";

describe("image search evidence", () => {
	it("keeps complete image and source page addresses for rendering and citation", () => {
		const url = `https://pics.example/${"a".repeat(700)}.jpg`;
		const sourcePageUrl = `https://news.example/${"b".repeat(700)}`;
		const result = {
			url,
			sourcePageUrl,
			provider: "parallel" as const,
			title: "Cat",
			source: "news.example",
			thumbnail: url,
		};
		const compact = compactImageSearchResults([result]);
		expect(compact[0]).toMatchObject(result);
		expect(createImageSearchCandidates(compact)[0]).toMatchObject({
			url,
			metadata: { provider: "parallel", thumbnail: url, sourcePageUrl },
		});
	});
});

vi.mock("$lib/server/services/vision/web-image-look", () => ({
	queueWebImagePreviews: vi.fn(),
}));

import { queueWebImagePreviews } from "$lib/server/services/vision/web-image-look";

describe("turn image inspection", () => {
	const signal = new AbortController().signal;
	const previews = vi.mocked(queueWebImagePreviews);
	function searchResults() {
		return compactImageSearchResults(
			["a", "b", "c"].map((tag) => {
				const url = `https://images.example/${tag}.jpg`;
				return {
					url,
					sourcePageUrl: "https://images.example",
					thumbnail: url,
					title: tag,
					source: "images.example",
					provider: "parallel",
				};
			}),
		);
	}
	it("rejects raw URLs, extra fields, and requests for more than two IDs", () => {
		const [a, b, c] = searchResults();
		for (const input of [
			{ action: "inspect", resultIds: [a.url] },
			{ action: "inspect", resultIds: [a.id, b.id, c.id] },
			{ action: "inspect", resultIds: [a.id], url: b.url },
			{ action: "inspect", resultIds: [a.id], query: "more" },
		])
			expect(imageSearchInputSchema.safeParse(input).success).toBe(false);
		expect(imageSearchInputSchema.safeParse({ query: "cat" }).success).toBe(
			true,
		);
	});
	it("reserves two slots across concurrent calls, returns unused capacity and never fetches unknown IDs", async () => {
		previews.mockReset();
		const inspect = createTurnImageInspection(undefined, () => true);
		const [a, b, c] = searchResults();
		inspect.remember([a, b, c]);
		expect(
			await inspect.inspect([a.id, "image-search:000000000000"], signal),
		).toMatchObject({ reason: "unknown_result" });
		expect(previews).not.toHaveBeenCalled();
		let release: () => void = () => {};
		previews.mockImplementationOnce(async () => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { queuedIds: [b.id] };
		});
		const first = inspect.inspect([a.id, b.id], signal);
		expect(await inspect.inspect([c.id], signal)).toMatchObject({
			reason: "budget",
		});
		release();
		expect((await first).queuedIds).toEqual([b.id]);
		previews.mockResolvedValueOnce({ queuedIds: [c.id] });
		expect((await inspect.inspect([c.id], signal)).queuedIds).toEqual([c.id]);
		expect(await inspect.inspect([a.id], signal)).toMatchObject({
			reason: "budget",
		});
		expect(previews).toHaveBeenCalledTimes(2);
		expect(previews.mock.calls[0]?.[0].candidates).toEqual([a, b]);
	});
});
