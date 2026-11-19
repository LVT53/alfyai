import { z } from "zod";

import type { ImageSearchResult } from "$lib/server/services/image-search";
import type { ToolEvidenceCandidate } from "$lib/server/services/message-evidence";

import { shortHash, truncateText } from "./shared";

export const imageSearchInputSchema = z.object({
	query: z.string().trim().min(1),
	additionalQueries: z
		.array(z.string().trim().min(1).max(200))
		.max(2)
		.optional(),
	objective: z.string().trim().max(5000).optional(),
});

type CompactImageSearchResult = ImageSearchResult & { id: string };

export function compactImageSearchResults(
	results: ImageSearchResult[],
): CompactImageSearchResult[] {
	return results.map((result) => ({
		...result,
		id: `image-search:${shortHash(result.url)}`,
		title: truncateText(result.title || result.source, 180),
	}));
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
			provider: result.provider,
			sourcePageUrl: result.sourcePageUrl,
			...(result.thumbnail ? { thumbnail: result.thumbnail } : {}),
			...(typeof result.width === "number" ? { width: result.width } : {}),
			...(typeof result.height === "number" ? { height: result.height } : {}),
		},
	}));
}
