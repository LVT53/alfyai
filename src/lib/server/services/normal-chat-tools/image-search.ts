import { z } from "zod";

import type { ImageSearchResult } from "$lib/server/services/image-search";
import type { ToolEvidenceCandidate } from "$lib/types";

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
			...(result.thumbnail
				? { thumbnail: truncateText(result.thumbnail, 500) }
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
