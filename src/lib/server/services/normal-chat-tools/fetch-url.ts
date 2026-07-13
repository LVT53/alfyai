import { z } from "zod";

export const fetchUrlInputSchema = z.object({
	urls: z.array(z.string().url()).min(1).max(5),
	objective: z.string().min(1).optional(),
});

export type FetchUrlInput = z.infer<typeof fetchUrlInputSchema>;

export function sanitizeFetchUrlInput(input: FetchUrlInput): FetchUrlInput {
	const seen = new Set<string>();
	const urls: string[] = [];
	for (const rawUrl of input.urls) {
		const url = rawUrl.trim();
		if (url.length === 0) {
			continue;
		}
		const key = url.toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		urls.push(url);
		if (urls.length >= 5) {
			break;
		}
	}

	const objective = input.objective?.trim();

	return {
		urls,
		...(objective ? { objective } : {}),
	};
}
