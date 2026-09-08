// The bridge from Atlas v2 to the harness's `research_web` (ADR 0062).
//
// v2 does NOT have its own search layer. It calls the same Parallel search +
// `readPages` extraction that the chat tool calls, with the same per-
// conversation result cache, so a question Atlas researches and a question the
// user then asks in chat cost Parallel once, and so any fix to the chat path
// lands in Atlas for free.
//
// The only thing this module adds on top of the tool is the shape Atlas needs:
// raw sources tagged with the question they answer.

import { getConfig } from "$lib/server/config-store";
import {
	buildToolResultCacheKey,
	getCachedToolResult,
	setCachedToolResult,
} from "$lib/server/services/normal-chat-tools/tool-result-cache";
import { fetchUrlViaParallel } from "$lib/server/services/parallel-search/fetch-url";
import { researchWebViaParallel } from "$lib/server/services/parallel-search/research";
import {
	buildGroundedWebPageFromFetch,
	selectTopDistinctSourceUrls,
} from "$lib/server/services/web-grounding";

/** Per-result excerpt budget requested from Parallel, matching research_web. */
const ATLAS_V2_EXCERPT_MAX_CHARS = 1500;
/** Total page-content budget shared across the pages read for one question. */
const ATLAS_V2_PAGE_CHAR_CAP = 24_000;

export interface AtlasV2ResearchWebRequest {
	/** The research question, verbatim — used as the Parallel objective. */
	question: string;
	/** Short keyword queries; Parallel fans out across them. */
	searchQueries: string[];
	/** How many of the top distinct result URLs to read in full. */
	readPages: number;
}

export interface AtlasV2ResearchWebSource {
	url: string;
	title: string;
	snippets: string[];
	publishedAt: string | null;
	pageExcerpt: string | null;
}

export interface AtlasV2ResearchWebResult {
	sources: AtlasV2ResearchWebSource[];
	pagesRead: number;
	cached: boolean;
}

export type AtlasV2ResearchWebRunner = (
	request: AtlasV2ResearchWebRequest,
) => Promise<AtlasV2ResearchWebResult>;

export interface CreateAtlasV2ResearchWebRunnerInput {
	/** Scopes the tool result cache, exactly as the chat tool scopes it. */
	conversationId: string;
	/** Groups related Parallel searches; the Atlas job id plays the turn id. */
	sessionId: string;
	/** Fire-and-forget Parallel usage accounting, matching the chat tool. */
	recordUsage?: (tool: "research_web" | "fetch_url") => void;
}

export function createAtlasV2ResearchWebRunner(
	input: CreateAtlasV2ResearchWebRunnerInput,
): AtlasV2ResearchWebRunner {
	return async (request) => {
		const { parallelApiKey, parallelBaseUrl } = getConfig();
		const deps = {
			fetch,
			config: { parallelApiKey, parallelBaseUrl },
		};
		// Same key shape as the chat tool's: conversation + tool name + the
		// normalized input, so an identical question is served from memory.
		const cacheKey = buildToolResultCacheKey({
			conversationId: input.conversationId,
			toolName: "research_web",
			input: {
				query: request.question,
				objective: request.question,
				searchQueries: request.searchQueries,
				...(request.readPages > 0 ? { readPages: request.readPages } : {}),
			},
		});
		const cached = getCachedToolResult<AtlasV2ResearchWebResult>(cacheKey);
		if (cached) return { ...cached, cached: true };

		const result = await researchWebViaParallel(
			{
				query: request.question,
				objective: request.question,
				searchQueries: request.searchQueries,
			},
			deps,
			{
				sessionId: input.sessionId,
				excerptMaxChars: ATLAS_V2_EXCERPT_MAX_CHARS,
			},
		);
		input.recordUsage?.("research_web");

		const pageTextByUrl = new Map<string, string>();
		let pagesRead = 0;
		if (request.readPages > 0 && result.sources.length > 0) {
			const topUrls = selectTopDistinctSourceUrls(
				result.sources,
				request.readPages,
			);
			if (topUrls.length > 0) {
				const perPageCap = Math.max(
					1,
					Math.floor(ATLAS_V2_PAGE_CHAR_CAP / topUrls.length),
				);
				// Best-effort, exactly as the chat tool treats readPages: a page
				// that fails to extract leaves the search result standing.
				const settled = await Promise.allSettled(
					topUrls.map((url) =>
						fetchUrlViaParallel({ urls: [url] }, deps, {
							sessionId: input.sessionId,
							maxCharsTotal: perPageCap,
						}),
					),
				);
				for (const outcome of settled) {
					if (outcome.status !== "fulfilled") continue;
					const page = buildGroundedWebPageFromFetch(outcome.value);
					if (!page?.contentMarkdown) continue;
					pageTextByUrl.set(page.url, page.contentMarkdown);
					pagesRead += 1;
					input.recordUsage?.("fetch_url");
				}
			}
		}

		const sources: AtlasV2ResearchWebSource[] = result.sources.map(
			(source) => ({
				url: source.url,
				title: source.title,
				snippets: [
					...(source.snippet ? [source.snippet] : []),
					...source.highlights,
				],
				publishedAt: source.publishedAt,
				pageExcerpt: pageTextByUrl.get(source.url) ?? null,
			}),
		);

		const adapted: AtlasV2ResearchWebResult = {
			sources,
			pagesRead,
			cached: false,
		};
		// A search that found nothing is worth re-running, so it is not pinned —
		// the same discipline the chat tool applies.
		if (sources.length > 0) setCachedToolResult(cacheKey, adapted);
		return adapted;
	};
}
