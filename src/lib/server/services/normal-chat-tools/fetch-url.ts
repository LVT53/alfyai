import { z } from "zod";

export const fetchUrlInputSchema = z.object({
	urls: z.array(z.string().url()).min(1).max(5),
	objective: z.string().min(1).optional(),
});

export type FetchUrlInput = z.infer<typeof fetchUrlInputSchema>;

// Build the dedupe key for a URL: lowercased origin joined to the verbatim
// path/query/hash, so case-insensitive hosts collapse while case-distinct paths
// stay separate. Falls back to the whole-URL lowercase for unparseable input.
function dedupeKey(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.origin.toLowerCase()}${parsed.pathname}${parsed.search}${parsed.hash}`;
	} catch {
		return url.toLowerCase();
	}
}

export function sanitizeFetchUrlInput(input: FetchUrlInput): FetchUrlInput {
	const seen = new Set<string>();
	const urls: string[] = [];
	for (const rawUrl of input.urls) {
		const url = rawUrl.trim();
		if (url.length === 0) {
			continue;
		}
		// Dedupe on lowercased origin + VERBATIM path/query/hash. The origin
		// (scheme + host + port) is case-insensitive, but the path is not: `/Page`
		// and `/page` are distinct resources and must both survive. Fall back to the
		// whole-URL lowercase key only when the URL fails to parse.
		const key = dedupeKey(url);
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

// ── Model-aware fetched-content cap ────────────────────────────
//
// fetch_url returns detailed full_content. To keep a big page from crowding out
// the rest of a small model's context window — while letting large-context
// models see more — we size the returned content to a fraction of the model's
// window, expressed in characters (~4 chars/token). Most pages are ~10-35KB, so
// the cap rarely bites; it's a guardrail, not a routine trim.
const FETCH_CONTENT_CONTEXT_FRACTION = 0.4;
const FETCH_CONTENT_CHARS_PER_TOKEN = 4;
const FETCH_CONTENT_CHAR_FLOOR = 20_000;
const FETCH_CONTENT_CHAR_CEILING = 200_000;
const FETCH_CONTENT_CHAR_DEFAULT = 60_000;

/**
 * Compute the max total characters of page content to request for a fetch,
 * given the selected model's context window in tokens. Roughly 40% of the
 * window converted to chars, clamped to a floor/ceiling. Returns a safe default
 * when the capacity is unknown (null/undefined/non-positive).
 */
export function resolveFetchContentCharCap(
	contextTokens: number | null | undefined,
): number {
	if (!contextTokens || contextTokens <= 0) {
		return FETCH_CONTENT_CHAR_DEFAULT;
	}
	const raw = Math.floor(
		contextTokens *
			FETCH_CONTENT_CHARS_PER_TOKEN *
			FETCH_CONTENT_CONTEXT_FRACTION,
	);
	return Math.min(
		FETCH_CONTENT_CHAR_CEILING,
		Math.max(FETCH_CONTENT_CHAR_FLOOR, raw),
	);
}
