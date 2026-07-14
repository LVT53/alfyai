// Frozen normalized result shape produced by the Parallel-backed orchestrators
// (research.ts, fetch-url.ts) and consumed by web-grounding.ts. This is a
// field-compatible re-declaration of the fields the old ResearchResult exposed
// to web-grounding, so the model/citation payload contract stays unchanged.
//
// CONTRACT GUARD: the top-level GroundedWebModelPayload field NAMES derived from
// this shape are hard-coded in the stream leak-filter (stream-protocol.ts) — do
// not rename fields here without updating that regex.

export interface GroundedWebSource {
	id: string;
	title: string;
	url: string;
	provider: string;
	authorityClass: string;
	authorityScore: number;
	snippet: string | null;
	highlights: string[];
	providerRank: number;
	publishedAt: string | null;
	updatedAt: string | null;
}

export interface GroundedWebEvidence {
	id: string;
	sourceId: string;
	title: string;
	url: string;
	provider: string;
	quote: string;
	score: number;
}

export interface GroundedWebAnswerBrief {
	markdown: string;
	instructions: string[];
}

export interface GroundedWebPageExtraction {
	attemptedCount: number;
	succeededCount: number;
	cacheHitCount: number;
	lowQualityCount: number;
	blockedCount: number;
	failedCount: number;
	totalLatencyMs: number;
}

export interface GroundedWebDiagnostics {
	mode: string;
	freshness: string;
	sourcePolicy: string;
	plannedQueryCount: number;
	directUrlCount: number;
	fetchedSourceCount: number;
	fusedSourceCount: number;
	selectedSourceCount: number;
	openedPageCount: number;
	pageExtraction: GroundedWebPageExtraction;
	evidenceCandidateCount: number;
	exactEvidenceCandidateCount: number;
	reranked: boolean;
	sourceReranked: boolean;
	fallbackReasons: string[];
	// Parallel-specific, informational; ignored by web-grounding but useful in logs.
	provider?: "parallel";
	searchLatencyMs?: number;
}

// Single source of truth for the truncation caps applied when building the
// model/citation payload: at most this many sources and evidence quotes reach
// the model. Used by the orchestrators (research.ts, fetch-url.ts) and the
// payload builder (web-grounding.ts) so the caps never drift apart.
export const MAX_PAYLOAD_SOURCES = 8;
export const MAX_PAYLOAD_EVIDENCE = 12;

export interface GroundedWebResult {
	query: string;
	queries: Array<{ query: string }>;
	sources: GroundedWebSource[];
	evidence: GroundedWebEvidence[];
	answerBrief: GroundedWebAnswerBrief;
	diagnostics: GroundedWebDiagnostics;
}

// Base diagnostics helper: sets the provider/mode defaults (mode "turbo",
// provider "parallel") and zeroes the synthetic pipeline counters that Turbo has
// no analog for. Orchestrators override the meaningful ones.
export function baseGroundedWebDiagnostics(
	overrides: Partial<GroundedWebDiagnostics> = {},
): GroundedWebDiagnostics {
	return {
		mode: "turbo",
		freshness: "auto",
		sourcePolicy: "general",
		plannedQueryCount: 0,
		directUrlCount: 0,
		fetchedSourceCount: 0,
		fusedSourceCount: 0,
		selectedSourceCount: 0,
		openedPageCount: 0,
		pageExtraction: {
			attemptedCount: 0,
			succeededCount: 0,
			cacheHitCount: 0,
			lowQualityCount: 0,
			blockedCount: 0,
			failedCount: 0,
			totalLatencyMs: 0,
		},
		evidenceCandidateCount: 0,
		exactEvidenceCandidateCount: 0,
		reranked: false,
		sourceReranked: false,
		fallbackReasons: [],
		provider: "parallel",
		...overrides,
	};
}
