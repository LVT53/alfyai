// Fetch-URL orchestrator: extracts the content of caller-supplied URLs via the
// Parallel Extract API and maps the results into the frozen GroundedWebResult
// shape consumed by web-grounding.ts. This is the "fetch" counterpart to the
// search-backed research orchestrator; it does no planning, ranking, or fusion.

import { type ParallelClientDeps, parallelExtract } from "./client";
import {
	baseGroundedWebDiagnostics,
	type GroundedWebEvidence,
	type GroundedWebResult,
	type GroundedWebSource,
	MAX_PAYLOAD_EVIDENCE,
} from "./types";

const DEFAULT_OBJECTIVE =
	"Extract the key facts, details, and specifications from these pages.";

// Character budgets for synthetic snippets/quotes derived from full_content.
// These stay short: they feed citation surfaces (source snippet, evidence
// quotes), not the bulk page body. The detailed full_content flows to the
// model through the answer brief instead (see buildAnswerBrief), where a
// model-aware per-page budget governs how much survives.
const SNIPPET_CHARS = 300;
const FULL_CONTENT_QUOTE_CHARS = 900;

// Fallback total answer-brief budget (chars) when the caller supplies no
// model-aware maxCharsTotal. Split evenly across the fetched pages.
const DEFAULT_ANSWER_BRIEF_CHARS_TOTAL = 60_000;

// Prefer cached page content up to 24h old. Live Extract fetches are usually
// ~1s but occasionally spike to 25-42s (and can time out empty); cached
// retrieval is ~735ms and far less variable. Page content read on demand rarely
// needs sub-day freshness.
const DEFAULT_MAX_AGE_SECONDS = 86_400;

export interface FetchUrlRequest {
	urls: string[];
	objective?: string;
}

// Optional tuning threaded through from the tool layer. sessionId groups this
// fetch with the other Parallel calls made in the same assistant turn (a
// search→fetch chain) so the API can reuse task context, without leaking a
// stable cross-conversation correlator; maxCharsTotal sizes returned content to
// the consuming model's context window; searchQueries sharpen the returned
// excerpts.
export interface FetchUrlOptions {
	sessionId?: string;
	maxCharsTotal?: number;
	searchQueries?: string[];
}

// Truncate a page body to a per-page character budget, appending an ellipsis
// when trimmed so the model can tell content was cut.
function truncateBody(text: string, budget: number): string {
	if (budget <= 0) {
		return "";
	}
	if (text.length <= budget) {
		return text;
	}
	return `${text.slice(0, budget).trimEnd()}…`;
}

// Build the answer-brief markdown that carries the DETAILED page content to the
// model. Each fetched page gets a block: a `[n] title — url` heading, its
// excerpts as a short lead-in, then its full_content body truncated to a
// per-page budget = floor(maxCharsTotal / pageCount). This is the channel
// through which up to ~maxCharsTotal chars of page content actually reach the
// model — the source snippet and evidence quotes stay short for citations.
function buildAnswerBrief(
	sources: GroundedWebSource[],
	fullContents: (string | null)[],
	maxCharsTotal: number | undefined,
): string {
	if (sources.length === 0) {
		return "";
	}
	const totalBudget =
		maxCharsTotal && maxCharsTotal > 0
			? maxCharsTotal
			: DEFAULT_ANSWER_BRIEF_CHARS_TOTAL;
	const perPageBudget = Math.floor(totalBudget / sources.length);
	const blocks = sources.map((source, index) => {
		const heading = `[${index + 1}] ${source.title} — ${source.url}`;
		const parts = [heading];
		// Excerpts as a short lead-in when present.
		if (source.highlights.length > 0) {
			parts.push(source.highlights.map((h) => `- ${h}`).join("\n"));
		}
		// The full_content body is the point: emit it up to the per-page budget.
		const fullContent = fullContents[index];
		const body = fullContent
			? truncateBody(fullContent, perPageBudget)
			: (source.snippet ?? "");
		if (body) {
			parts.push(body);
		}
		return parts.join("\n");
	});
	return `# Fetched page content\n\n${blocks.join("\n\n")}`;
}

export async function fetchUrlViaParallel(
	req: FetchUrlRequest,
	deps: ParallelClientDeps,
	opts?: FetchUrlOptions,
): Promise<GroundedWebResult> {
	const startedAt = Date.now();
	const results = await parallelExtract(
		{
			urls: req.urls,
			objective: req.objective ?? DEFAULT_OBJECTIVE,
			// Request detailed page content: the model reads full_content (via the
			// answer brief), not just excerpts. Note max_chars_total does NOT bound
			// full_content at the API level (see client), so WE size it when building
			// the brief below — this field is passed through but is not the cap that
			// governs what the model sees.
			fullContent: true,
			maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS,
			...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
			...(opts?.maxCharsTotal ? { maxCharsTotal: opts.maxCharsTotal } : {}),
			...(opts?.searchQueries?.length
				? { searchQueries: opts.searchQueries }
				: {}),
		},
		deps,
	);
	const totalLatencyMs = Date.now() - startedAt;

	const sources: GroundedWebSource[] = results.map((result, index) => ({
		id: `e${index}`,
		title: result.title,
		url: result.url,
		provider: "parallel",
		authorityClass: "standard",
		authorityScore: 60,
		// Short citation snippet (a lead-in derived from full_content), NOT the
		// bulk page body — the detailed full_content reaches the model through
		// the answer brief instead. Fall back to the first excerpt when a page
		// returned no full_content.
		snippet: result.full_content
			? result.full_content.slice(0, SNIPPET_CHARS)
			: (result.excerpts[0] ?? null),
		highlights: result.excerpts,
		providerRank: index,
		publishedAt: result.publish_date,
		updatedAt: null,
	}));

	const evidence: GroundedWebEvidence[] = [];
	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		if (evidence.length >= MAX_PAYLOAD_EVIDENCE) {
			break;
		}
		let quoteIndex = 0;
		// Primary: a detailed quote from full_content when present.
		if (result.full_content) {
			evidence.push({
				id: `e${i}q${quoteIndex}`,
				sourceId: `e${i}`,
				title: result.title,
				url: result.url,
				provider: "parallel",
				quote: result.full_content.slice(0, FULL_CONTENT_QUOTE_CHARS),
				score: 0,
			});
			quoteIndex++;
		}
		// Secondary: the targeted excerpts, still emitted when present.
		for (let j = 0; j < result.excerpts.length; j++) {
			if (evidence.length >= MAX_PAYLOAD_EVIDENCE) {
				break;
			}
			evidence.push({
				id: `e${i}q${quoteIndex}`,
				sourceId: `e${i}`,
				title: result.title,
				url: result.url,
				provider: "parallel",
				quote: result.excerpts[j],
				score: 0,
			});
			quoteIndex++;
		}
	}

	// Assign strictly descending scores in emission order.
	for (let k = 0; k < evidence.length; k++) {
		evidence[k].score = 1 - k / MAX_PAYLOAD_EVIDENCE;
	}

	return {
		query: req.urls.join(", "),
		queries: req.urls.map((url) => ({ query: url })),
		sources,
		evidence,
		answerBrief: {
			markdown: buildAnswerBrief(
				sources,
				results.map((result) => result.full_content ?? null),
				opts?.maxCharsTotal,
			),
			instructions: [
				"Answer only from these fetched pages.",
				"Cite claims with the returned page URLs.",
			],
		},
		diagnostics: baseGroundedWebDiagnostics({
			mode: "fetch",
			openedPageCount: req.urls.length,
			fetchedSourceCount: results.length,
			selectedSourceCount: sources.length,
			evidenceCandidateCount: evidence.length,
			pageExtraction: {
				attemptedCount: req.urls.length,
				succeededCount: results.length,
				cacheHitCount: 0,
				lowQualityCount: 0,
				blockedCount: 0,
				failedCount: req.urls.length - results.length,
				totalLatencyMs,
			},
		}),
	};
}
