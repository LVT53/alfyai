// The bridge from Atlas v3 to the harness's `research_web` (ADR 0063).
//
// This is v2's adapter split in two. v2 asked the tool to search AND to read
// its own top-distinct URLs in one call, which meant the read budget was spent
// before anything knew a hit was a marketplace listing. v3 needs to choose what
// to read by SOURCE TIER, so the two halves are separate operations over the
// same Parallel services and the same per-conversation tool-result cache:
//
//   search(question, queries) -> hits with excerpts, nothing read
//   read(url)                 -> page text for ONE chosen URL
//
// Everything else is v2's: the same cache key shape as the chat tool, so a
// question Atlas researches and a question the user then asks in chat cost
// Parallel once, and any fix to the chat path lands in Atlas for free.

import { getConfig } from "$lib/server/config-store";
import {
	buildToolResultCacheKey,
	getCachedToolResult,
	setCachedToolResult,
} from "$lib/server/services/normal-chat-tools/tool-result-cache";
import { fetchUrlViaParallel } from "$lib/server/services/parallel-search/fetch-url";
import { researchWebViaParallel } from "$lib/server/services/parallel-search/research";
import { buildGroundedWebPageFromFetch } from "$lib/server/services/web-grounding";

/** Per-result excerpt budget requested from Parallel, matching research_web. */
const ATLAS_V3_EXCERPT_MAX_CHARS = 1500;
/** Characters one page read may return. */
const ATLAS_V3_PAGE_CHAR_CAP = 20_000;

export interface AtlasV3SearchRequest {
	/** The sub-question, verbatim — used as the Parallel objective. */
	question: string;
	/** Short keyword queries; Parallel fans out across them. */
	searchQueries: string[];
}

export interface AtlasV3SearchHit {
	url: string;
	title: string;
	snippets: string[];
	publishedAt: string | null;
}

export interface AtlasV3SearchResult {
	hits: AtlasV3SearchHit[];
	cached: boolean;
}

export interface AtlasV3ReadResult {
	url: string;
	text: string | null;
	cached: boolean;
}

export interface AtlasV3ResearchWeb {
	search: (request: AtlasV3SearchRequest) => Promise<AtlasV3SearchResult>;
	read: (url: string) => Promise<AtlasV3ReadResult>;
}

export interface CreateAtlasV3ResearchWebInput {
	/** Scopes the tool result cache, exactly as the chat tool scopes it. */
	conversationId: string;
	/** Groups related Parallel searches; the Atlas job id plays the turn id. */
	sessionId: string;
	recordUsage?: (tool: "research_web" | "fetch_url") => void;
}

export function createAtlasV3ResearchWeb(
	input: CreateAtlasV3ResearchWebInput,
): AtlasV3ResearchWeb {
	const deps = () => {
		const { parallelApiKey, parallelBaseUrl } = getConfig();
		return { fetch, config: { parallelApiKey, parallelBaseUrl } };
	};

	return {
		search: async (request) => {
			const cacheKey = buildToolResultCacheKey({
				conversationId: input.conversationId,
				toolName: "research_web",
				input: {
					query: request.question,
					objective: request.question,
					searchQueries: request.searchQueries,
				},
			});
			const cached = getCachedToolResult<AtlasV3SearchResult>(cacheKey);
			if (cached) return { ...cached, cached: true };

			const result = await researchWebViaParallel(
				{
					query: request.question,
					objective: request.question,
					searchQueries: request.searchQueries,
				},
				deps(),
				{
					sessionId: input.sessionId,
					excerptMaxChars: ATLAS_V3_EXCERPT_MAX_CHARS,
				},
			);
			input.recordUsage?.("research_web");
			const adapted: AtlasV3SearchResult = {
				hits: result.sources.map((source) => ({
					url: source.url,
					title: source.title,
					snippets: [
						...(source.snippet ? [source.snippet] : []),
						...source.highlights,
					],
					publishedAt: source.publishedAt,
				})),
				cached: false,
			};
			// A search that found nothing is worth re-running, so it is not pinned.
			if (adapted.hits.length > 0) setCachedToolResult(cacheKey, adapted);
			return adapted;
		},

		read: async (url) => {
			const cacheKey = buildToolResultCacheKey({
				conversationId: input.conversationId,
				toolName: "fetch_url",
				input: { urls: [url] },
			});
			const cached = getCachedToolResult<AtlasV3ReadResult>(cacheKey);
			if (cached) return { ...cached, cached: true };
			try {
				const fetched = await fetchUrlViaParallel({ urls: [url] }, deps(), {
					sessionId: input.sessionId,
					maxCharsTotal: ATLAS_V3_PAGE_CHAR_CAP,
				});
				input.recordUsage?.("fetch_url");
				const page = buildGroundedWebPageFromFetch(fetched);
				const adapted: AtlasV3ReadResult = {
					url,
					text: page?.contentMarkdown ?? null,
					cached: false,
				};
				// Only a page that actually extracted is pinned: a transient
				// extraction failure must stay retryable in the next round.
				if (adapted.text) setCachedToolResult(cacheKey, adapted);
				return adapted;
			} catch {
				return { url, text: null, cached: false };
			}
		},
	};
}
