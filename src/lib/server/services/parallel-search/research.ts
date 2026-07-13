// Parallel-backed web research orchestrator. Calls the Turbo search client and
// maps its raw results into the frozen GroundedWebResult shape that
// web-grounding.ts consumes. This is intentionally a thin, pure mapping layer:
// no fetch/fuse/rerank pipeline (Turbo has none), so most diagnostics fields are
// synthetic (see emptyGroundedWebDiagnostics).

import { type ParallelClientConfig, parallelSearch } from "./client";
import {
	emptyGroundedWebDiagnostics,
	type GroundedWebEvidence,
	type GroundedWebResult,
	type GroundedWebSource,
} from "./types";

const MAX_EVIDENCE = 12;

const ANSWER_BRIEF_INSTRUCTIONS = [
	"Answer only from these sources.",
	"Cite claims with the returned source URLs.",
	"Do not cite URLs outside this list.",
];

export interface ResearchWebViaParallelRequest {
	query: string;
	// Optional model-supplied intent sentence. Falls back to `query`.
	objective?: string;
	// Optional model-supplied keyword queries (distinct angles). Falls back to
	// `[query]` when omitted or empty.
	searchQueries?: string[];
}

export interface ResearchWebViaParallelDeps {
	fetch: typeof fetch;
	config: ParallelClientConfig;
	signal?: AbortSignal;
}

export interface ResearchWebViaParallelOptions {
	// Groups this search with related follow-ups (we pass the conversation id).
	sessionId?: string;
	// Per-result excerpt size passed through to the Parallel search request.
	excerptMaxChars?: number;
}

function buildAnswerBriefMarkdown(
	sources: GroundedWebSource[],
	results: { excerpts: string[] }[],
): string {
	if (sources.length === 0) {
		return "";
	}

	const lines: string[] = ["# Web research brief", ""];
	for (const [index, source] of sources.entries()) {
		const ref = index + 1;
		lines.push(`[${ref}] ${source.title} — ${source.url}`);
		for (const excerpt of results[index]?.excerpts ?? []) {
			lines.push(`- ${excerpt}`);
		}
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

export async function researchWebViaParallel(
	req: ResearchWebViaParallelRequest,
	deps: ResearchWebViaParallelDeps,
	opts?: ResearchWebViaParallelOptions,
): Promise<GroundedWebResult> {
	const startedAt = Date.now();
	const results = await parallelSearch(
		{
			objective: req.objective ?? req.query,
			searchQueries: req.searchQueries?.length
				? req.searchQueries
				: [req.query],
			mode: "turbo",
			sessionId: opts?.sessionId,
			excerptMaxChars: opts?.excerptMaxChars,
		},
		deps,
	);
	const searchLatencyMs = Date.now() - startedAt;

	const sources: GroundedWebSource[] = results.map((result, i) => ({
		id: `p${i}`,
		title: result.title,
		url: result.url,
		provider: "parallel",
		authorityClass: "standard",
		authorityScore: 50,
		snippet: result.excerpts[0] ?? null,
		highlights: result.excerpts,
		providerRank: i,
		publishedAt: result.publish_date,
		updatedAt: null,
	}));

	const evidence: GroundedWebEvidence[] = [];
	let scoreIndex = 0;
	for (const [i, result] of results.entries()) {
		for (const [j, excerpt] of result.excerpts.entries()) {
			if (evidence.length >= MAX_EVIDENCE) {
				break;
			}
			evidence.push({
				id: `p${i}e${j}`,
				sourceId: `p${i}`,
				title: result.title,
				url: result.url,
				provider: "parallel",
				quote: excerpt,
				score: 1 - scoreIndex * 0.02,
			});
			scoreIndex++;
		}
		if (evidence.length >= MAX_EVIDENCE) {
			break;
		}
	}

	return {
		query: req.query,
		queries: [{ query: req.query }],
		sources,
		evidence,
		answerBrief: {
			markdown: buildAnswerBriefMarkdown(sources, results),
			instructions: ANSWER_BRIEF_INSTRUCTIONS,
		},
		diagnostics: emptyGroundedWebDiagnostics({
			mode: "turbo",
			plannedQueryCount: 1,
			fetchedSourceCount: results.length,
			fusedSourceCount: sources.length,
			selectedSourceCount: sources.length,
			evidenceCandidateCount: evidence.length,
			searchLatencyMs,
		}),
	};
}
