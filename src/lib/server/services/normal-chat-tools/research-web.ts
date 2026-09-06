import { z } from "zod";

// readPages lets the model read the top N search-result pages in the SAME
// call, so a question that needs page-level detail (an exact price, a spec,
// official documentation) doesn't need a separate fetch_url round trip.
// Capped at 2: readPages fetches are extra Parallel Extract calls layered on
// top of the search, so the cap keeps a single research_web call's latency
// and page-content budget bounded (see MAX_RESEARCH_WEB_READ_PAGES usage in
// index.ts, which divides the shared char cap across the fetched pages).
export const MAX_RESEARCH_WEB_READ_PAGES = 2;

export const researchWebInputSchema = z.object({
	query: z.string().min(1),
	objective: z.string().min(1).optional(),
	searchQueries: z.array(z.string().min(1)).max(5).optional(),
	readPages: z
		.number()
		.int()
		.min(0)
		.max(MAX_RESEARCH_WEB_READ_PAGES)
		.optional(),
});

export type ResearchWebInput = z.infer<typeof researchWebInputSchema>;

export function sanitizeResearchWebInput(
	input: ResearchWebInput,
): ResearchWebInput {
	const objective = input.objective?.trim();
	const searchQueries = input.searchQueries
		?.map((q) => q.trim())
		.filter((q) => q.length > 0);
	const readPages = input.readPages
		? Math.max(
				0,
				Math.min(MAX_RESEARCH_WEB_READ_PAGES, Math.trunc(input.readPages)),
			)
		: 0;
	return {
		query: input.query.trim(),
		...(objective ? { objective } : {}),
		...(searchQueries?.length ? { searchQueries } : {}),
		...(readPages > 0 ? { readPages } : {}),
	};
}
