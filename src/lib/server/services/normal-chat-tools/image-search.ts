import { z } from "zod";

import type { ImageSearchResult } from "$lib/server/services/image-search";
import type { ToolEvidenceCandidate } from "$lib/server/services/message-evidence";

import type { ToolCallEntry } from "$lib/server/services/messages-types";
import type { StepImageQueue } from "$lib/server/services/vision/step-images";
import { queueWebImagePreviews } from "$lib/server/services/vision/web-image-look";
import { searchResultThumbnail } from "$lib/shared/url-provenance";

import { shortHash, truncateText } from "./shared";

const searchFields = {
	query: z
		.string()
		.trim()
		.min(1)
		.describe("Short visual keywords; preserve local names and accents."),
	additionalQueries: z
		.array(z.string().trim().min(1).max(200))
		.max(2)
		.optional()
		.describe(
			"Optional complementary international terms. Honor any requested search language.",
		),
	objective: z
		.string()
		.trim()
		.max(5000)
		.optional()
		.describe("What the picture must visibly show."),
};
const resultIds = z
	.array(z.string().regex(/^image-search:[0-9a-f]{12}$/))
	.min(1)
	.max(2)
	.describe("One or two image IDs from this turn's search results. No URLs.");

export const imageSearchInputSchema = z.union([
	z.strictObject({ action: z.literal("search").optional(), ...searchFields }),
	z.strictObject({ action: z.literal("inspect"), resultIds }),
]);

// Providers expect a tool's parameters to be a top-level object. The union
// above validates the action-specific fields that this compact schema shows.
export const imageSearchShownSchema = z.object({
	action: z.enum(["search", "inspect"]).optional(),
	...searchFields,
	query: searchFields.query.optional(),
	resultIds: resultIds.optional(),
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

type InspectableImage = Pick<
	CompactImageSearchResult,
	"id" | "url" | "thumbnail"
> & { sourcePageUrl?: string };

type InspectionResult = {
	queuedIds: string[];
	queuedImages: Pick<InspectableImage, "id" | "url" | "sourcePageUrl">[];
	reason?: "unknown_result" | "budget" | "unavailable" | "text_only";
};

export function spentImageInspectionSlots(
	entries: readonly ToolCallEntry[],
): number {
	let spent = 0;
	for (const entry of entries) {
		if (
			entry.name !== "image_search" ||
			entry.status !== "done" ||
			entry.metadata?.action !== "inspect" ||
			entry.metadata.ok !== true
		)
			continue;
		const count = entry.metadata.queuedCount;
		if (typeof count === "number" && Number.isInteger(count) && count > 0)
			spent += count;
	}
	return Math.min(2, spent);
}

/** Only actual results of this logical turn may supply a publisher address. */
export function createTurnImageInspection(
	queue: StepImageQueue | undefined,
	allowed: (result: InspectableImage) => boolean,
	priorCalls: readonly ToolCallEntry[] = [],
) {
	const found = new Map<string, InspectableImage>();
	for (const call of priorCalls) {
		if (
			call.name !== "image_search" ||
			call.status !== "done" ||
			call.metadata?.ok !== true ||
			call.metadata.action === "inspect"
		)
			continue;
		for (const candidate of call.candidates ?? []) {
			const { id, url } = candidate;
			if (
				candidate.metadata?.provider !== "parallel" ||
				typeof url !== "string" ||
				id !== `image-search:${shortHash(url)}`
			)
				continue;
			const thumbnail = searchResultThumbnail(candidate);
			const sourcePageUrl = candidate.metadata?.sourcePageUrl;
			found.set(id, {
				id,
				url,
				...(thumbnail ? { thumbnail } : {}),
				...(typeof sourcePageUrl === "string" ? { sourcePageUrl } : {}),
			});
		}
	}
	let remaining = 2 - spentImageInspectionSlots(priorCalls);
	return {
		remember(results: CompactImageSearchResult[]) {
			for (const result of results) found.set(result.id, result);
		},
		async inspect(
			ids: string[],
			signal: AbortSignal,
		): Promise<InspectionResult> {
			const selected: InspectableImage[] = [];
			for (const id of new Set(ids)) {
				const candidate = found.get(id);
				if (!candidate || !allowed(candidate))
					return {
						queuedIds: [],
						queuedImages: [],
						reason: "unknown_result",
					};
				selected.push(candidate);
			}
			const granted = Math.min(remaining, selected.length);
			if (!granted)
				return { queuedIds: [], queuedImages: [], reason: "budget" };
			// Reserve before the first await: concurrent tool calls share two slots.
			remaining -= granted;
			let queued = 0;
			try {
				const result = await queueWebImagePreviews({
					queue,
					candidates: selected.slice(0, granted),
					signal,
				});
				queued = result.queuedIds.length;
				return {
					queuedIds: result.queuedIds,
					queuedImages: selected
						.filter((candidate) => result.queuedIds.includes(candidate.id))
						.map(({ id, url, sourcePageUrl }) => ({ id, url, sourcePageUrl })),
					reason:
						result.reason ?? (granted < selected.length ? "budget" : undefined),
				};
			} finally {
				remaining += granted - queued;
			}
		},
	};
}
