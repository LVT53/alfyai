import { z } from "zod";

export const researchWebInputSchema = z.object({
	query: z.string().min(1),
	objective: z.string().min(1).optional(),
	searchQueries: z.array(z.string().min(1)).max(5).optional(),
});

export type ResearchWebInput = z.infer<typeof researchWebInputSchema>;

export function sanitizeResearchWebInput(
	input: ResearchWebInput,
): ResearchWebInput {
	const objective = input.objective?.trim();
	const searchQueries = input.searchQueries
		?.map((q) => q.trim())
		.filter((q) => q.length > 0);
	return {
		query: input.query.trim(),
		...(objective ? { objective } : {}),
		...(searchQueries?.length ? { searchQueries } : {}),
	};
}
