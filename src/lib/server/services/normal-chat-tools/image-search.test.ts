import { describe, expect, it } from "vitest";
import {
	compactImageSearchResults,
	createImageSearchCandidates,
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
