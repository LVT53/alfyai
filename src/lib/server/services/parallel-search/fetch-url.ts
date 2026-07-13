// Fetch-URL orchestrator: extracts the content of caller-supplied URLs via the
// Parallel Extract API and maps the results into the frozen GroundedWebResult
// shape consumed by web-grounding.ts. This is the "fetch" counterpart to the
// search-backed research orchestrator; it does no planning, ranking, or fusion.

import { type ParallelClientDeps, parallelExtract } from "./client";
import {
	emptyGroundedWebDiagnostics,
	type GroundedWebEvidence,
	type GroundedWebResult,
	type GroundedWebSource,
} from "./types";

const DEFAULT_OBJECTIVE =
	"Extract the key facts, details, and specifications from these pages.";

// Cap on total evidence quotes emitted across all fetched pages.
const MAX_EVIDENCE = 12;

// Character budgets for synthetic snippets/quotes derived from full_content.
const SNIPPET_CHARS = 300;
const FULL_CONTENT_QUOTE_CHARS = 900;

export interface FetchUrlRequest {
	urls: string[];
	objective?: string;
}

function buildAnswerBrief(sources: GroundedWebSource[]): string {
	if (sources.length === 0) {
		return "";
	}
	const blocks = sources.map((source, index) => {
		const heading = `[${index + 1}] ${source.title} — ${source.url}`;
		const body =
			source.highlights.length > 0
				? source.highlights.map((h) => `- ${h}`).join("\n")
				: (source.snippet ?? "");
		return body ? `${heading}\n${body}` : heading;
	});
	return `# Fetched page content\n\n${blocks.join("\n\n")}`;
}

export async function fetchUrlViaParallel(
	req: FetchUrlRequest,
	deps: ParallelClientDeps,
): Promise<GroundedWebResult> {
	const startedAt = Date.now();
	const results = await parallelExtract(
		{
			urls: req.urls,
			objective: req.objective ?? DEFAULT_OBJECTIVE,
			fullContent: false,
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
		snippet:
			result.excerpts[0] ??
			(result.full_content
				? result.full_content.slice(0, SNIPPET_CHARS)
				: null),
		highlights: result.excerpts,
		providerRank: index,
		publishedAt: result.publish_date,
		updatedAt: null,
	}));

	const evidence: GroundedWebEvidence[] = [];
	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		if (evidence.length >= MAX_EVIDENCE) {
			break;
		}
		if (result.excerpts.length > 0) {
			for (let j = 0; j < result.excerpts.length; j++) {
				if (evidence.length >= MAX_EVIDENCE) {
					break;
				}
				evidence.push({
					id: `e${i}q${j}`,
					sourceId: `e${i}`,
					title: result.title,
					url: result.url,
					provider: "parallel",
					quote: result.excerpts[j],
					score: 0,
				});
			}
		} else if (result.full_content) {
			evidence.push({
				id: `e${i}q0`,
				sourceId: `e${i}`,
				title: result.title,
				url: result.url,
				provider: "parallel",
				quote: result.full_content.slice(0, FULL_CONTENT_QUOTE_CHARS),
				score: 0,
			});
		}
	}

	// Assign strictly descending scores in emission order.
	for (let k = 0; k < evidence.length; k++) {
		evidence[k].score = 1 - k / MAX_EVIDENCE;
	}

	return {
		query: req.urls.join(", "),
		queries: req.urls.map((url) => ({ query: url })),
		sources,
		evidence,
		answerBrief: {
			markdown: buildAnswerBrief(sources),
			instructions: [
				"Answer only from these fetched pages.",
				"Cite claims with the returned page URLs.",
			],
		},
		diagnostics: emptyGroundedWebDiagnostics({
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
