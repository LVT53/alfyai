import { z } from "zod";

export const researchWebInputSchema = z.object({
	query: z.string().min(1),
});

export type ResearchWebInput = z.infer<typeof researchWebInputSchema>;

export function sanitizeResearchWebInput(
	input: ResearchWebInput,
): ResearchWebInput {
	return {
		query: input.query.trim(),
	};
}
