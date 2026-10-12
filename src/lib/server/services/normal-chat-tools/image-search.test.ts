import { describe, expect, it } from "vitest";
import {
	compactImageSearchResults,
	createImageSearchCandidates,
} from "./image-search";

// The chat shows an image_search picture through Brave's thumbnail, by the exact
// address the search returned (docs/plans/exfil-channels). The payload keeps that
// address whole, because a cut-off one shows nothing, and keeps no other.

function braveThumbnail(wrapped: string): string {
	return `https://imgs.search.brave.com/Zq3s9x/rs:fit:500:0:0:0/g:ce/${Buffer.from(wrapped).toString("base64url")}`;
}

describe("compactImageSearchResults", () => {
	it("keeps a Brave thumbnail whole, however long its address is", () => {
		const longPage = `https://example.com/${"a".repeat(700)}.jpg`;
		const thumbnail = braveThumbnail(longPage);
		expect(thumbnail.length).toBeGreaterThan(500);

		const [result] = compactImageSearchResults([
			{
				url: "https://example.com/cat.jpg",
				title: "Cat",
				source: "example.com",
				thumbnail,
			},
		]);

		expect(result?.thumbnail).toBe(thumbnail);
	});

	it("drops a thumbnail that is not an address on Brave's image proxy", () => {
		const results = compactImageSearchResults(
			[
				"https://evil.example/collect?d=secret",
				"http://imgs.search.brave.com/sig/abc",
				"https://imgs.search.brave.com.evil.example/sig/abc",
				"javascript:alert(1)",
				"not a url",
			].map((thumbnail) => ({
				url: "https://example.com/cat.jpg",
				title: "Cat",
				source: "example.com",
				thumbnail,
			})),
		);

		expect(results).toHaveLength(5);
		for (const result of results)
			expect(result).not.toHaveProperty("thumbnail");
	});

	it("keeps the payload's field names", () => {
		const thumbnail = braveThumbnail("https://example.com/cat.jpg");

		const [result] = compactImageSearchResults([
			{
				url: "https://example.com/cat.jpg",
				title: "Cat",
				source: "example.com",
				thumbnail,
				width: 1200,
				height: 800,
			},
		]);

		expect(result).toEqual({
			id: expect.stringMatching(/^image-search:[0-9a-f]{12}$/),
			url: "https://example.com/cat.jpg",
			title: "Cat",
			source: "example.com",
			thumbnail,
			width: 1200,
			height: 800,
		});
	});
});

describe("createImageSearchCandidates", () => {
	it("carries the thumbnail into the candidate's metadata, where the chat reads it", () => {
		const thumbnail = braveThumbnail("https://example.com/cat.jpg");
		const compact = compactImageSearchResults([
			{
				url: "https://example.com/cat.jpg",
				title: "Cat",
				source: "example.com",
				thumbnail,
			},
		]);

		const [candidate] = createImageSearchCandidates(compact);

		expect(candidate?.url).toBe("https://example.com/cat.jpg");
		expect(candidate?.metadata?.thumbnail).toBe(thumbnail);
	});
});
