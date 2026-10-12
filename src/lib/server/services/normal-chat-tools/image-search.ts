import { z } from "zod";

import type { ImageSearchResult } from "$lib/server/services/image-search";
import type { ToolEvidenceCandidate } from "$lib/server/services/message-evidence";
import { isBraveThumbnailUrl } from "$lib/shared/url-provenance";

import { shortHash, truncateText } from "./shared";

export const imageSearchInputSchema = z.object({
	query: z.string().min(1),
});

export type ImageSearchInput = z.infer<typeof imageSearchInputSchema>;

export type CompactImageSearchResult = {
	id: string;
	url: string;
	title: string;
	source: string;
	thumbnail?: string;
	width?: number;
	height?: number;
};

export function sanitizeImageSearchInput(
	input: ImageSearchInput,
): ImageSearchInput {
	return { query: input.query.trim() };
}

export function compactImageSearchResults(
	results: ImageSearchResult[],
): CompactImageSearchResult[] {
	return results.slice(0, 8).map((result, index) => {
		const url = truncateText(result.url, 500);
		const source = truncateText(result.source, 180);
		return {
			id: imageSearchResultId(result, index),
			url,
			title: truncateText(
				result.title || result.url || `Image ${index + 1}`,
				180,
			),
			source,
			// Whole or not at all: the chat shows a Brave thumbnail exactly as the
			// search returned it (through the app's own thumbnail route, which asks
			// for that exact address), and an address cut off at 500 characters ends
			// in "..." and shows nothing. Anything that is not an address on Brave's
			// image proxy is never shown, so it is not kept.
			...(result.thumbnail && isBraveThumbnailUrl(result.thumbnail)
				? { thumbnail: result.thumbnail.trim() }
				: {}),
			...(typeof result.width === "number" ? { width: result.width } : {}),
			...(typeof result.height === "number" ? { height: result.height } : {}),
		};
	});
}

function imageSearchResultId(result: ImageSearchResult, index: number): string {
	const stableSource =
		result.url || `${result.title}:${result.source}:${index}`;
	return `image-search:${shortHash(stableSource)}`;
}

export function createImageSearchCandidates(
	results: CompactImageSearchResult[],
): ToolEvidenceCandidate[] {
	return results.map((result) => ({
		id: result.id,
		title: result.title,
		url: result.url,
		snippet: result.source,
		sourceType: "web",
		metadata: {
			source: result.source,
			...(result.thumbnail ? { thumbnail: result.thumbnail } : {}),
			...(typeof result.width === "number" ? { width: result.width } : {}),
			...(typeof result.height === "number" ? { height: result.height } : {}),
		},
	}));
}
