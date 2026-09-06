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
// fetch_url returns detailed full_content. The payload is re-sent as prompt
// on every later step of the turn, so it is sized to a fraction of the
// model's window (~4 chars/token) and capped hard: on a 131k-context model
// one fetched page was adding ~9k prompt tokens to each subsequent step.
// The ceiling keeps a page at roughly 12k tokens.
const FETCH_CONTENT_CONTEXT_FRACTION = 0.4;
const FETCH_CONTENT_CHARS_PER_TOKEN = 4;
const FETCH_CONTENT_CHAR_FLOOR = 20_000;
const FETCH_CONTENT_CHAR_CEILING = 48_000;
const FETCH_CONTENT_CHAR_DEFAULT = 32_000;

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
