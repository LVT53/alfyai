import type { ResearchResult } from "$lib/server/services/web-research";
import type { ToolCallEntry, ToolEvidenceCandidate } from "$lib/types";

export type GroundedWebSource = {
	id: string;
	title: string;
	url: string;
	provider: string;
	authorityClass: string;
	authorityScore: number;
	publishedAt: string | null;
	updatedAt: string | null;
	snippet?: string;
	youtubeTranscript?: {
		videoId: string;
		language: string;
		languageCode: string;
		isGenerated: boolean;
		isTranslated: boolean;
		snippetCount: number;
		fetchedAt: string;
	};
};

export type GroundedWebEvidence = {
	id: string;
	sourceId: string;
	title: string;
	url: string;
	provider: string;
	quote: string;
	score: number;
};

export type GroundedWebModelPayload = {
	success: boolean;
	name: "research_web";
	sourceType: "web";
	query: string;
	queries: string[];
	answerBrief: {
		instructions: string[];
		sourceCount: number;
		evidenceCount: number;
	};
	answerBriefMarkdown: string;
	sources: GroundedWebSource[];
	evidence: GroundedWebEvidence[];
	diagnostics: {
		mode: string;
		freshness: string;
		sourcePolicy: string;
		plannedQueryCount: number;
		directUrlCount: number;
		fetchedSourceCount: number;
		fusedSourceCount: number;
		selectedSourceCount: number;
		openedPageCount: number;
		pageExtraction: {
			attemptedCount: number;
			succeededCount: number;
			cacheHitCount: number;
			lowQualityCount: number;
			blockedCount: number;
			failedCount: number;
			totalLatencyMs: number;
		};
		evidenceCandidateCount: number;
		exactEvidenceCandidateCount: number;
		reranked: boolean;
		sourceReranked: boolean;
		fallbackReasons: string[];
	};
	instructions: string;
};

export type GroundedWebMetadata = NonNullable<ToolCallEntry["metadata"]>;

export type GroundedWebCitationSource = {
	id: string;
	title: string;
	url: string;
	canonicalUrl: string;
	host: string;
};

const MARKDOWN_LINK_RE = /\[[^\]]+\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/gi;
const BARE_URL_RE = /https?:\/\/[^\s<>)\]]+/gi;
const TRAILING_PUNCTUATION_RE = /[.,;:!?]+$/;

function truncateText(
	value: string | null | undefined,
	maxLength: number,
): string {
	const text = value ?? "";
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength).trimEnd()}...`;
}

function optionalScalarMetadata(
	value: string | number | boolean | null | undefined,
): string | number | boolean | null | undefined {
	return value === undefined ? undefined : value;
}

export function buildGroundedWebModelPayload(
	result: ResearchResult,
): GroundedWebModelPayload {
	const sources = result.sources.slice(0, 8).map((source) => ({
		id: source.id,
		title: truncateText(source.title, 180),
		url: truncateText(source.url, 500),
		provider: source.provider,
		authorityClass: source.authorityClass,
		authorityScore: source.authorityScore,
		publishedAt: source.publishedAt,
		updatedAt: source.updatedAt,
		...(source.snippet ? { snippet: truncateText(source.snippet, 500) } : {}),
		...(source.youtubeTranscript
			? { youtubeTranscript: source.youtubeTranscript }
			: {}),
	}));
	const evidence = result.evidence.slice(0, 12).map((item) => ({
		id: item.id,
		sourceId: item.sourceId,
		title: truncateText(item.title, 180),
		url: truncateText(item.url, 500),
		provider: item.provider,
		quote: truncateText(item.quote, 900),
		score: item.score,
	}));
	const evidenceReady = evidence.length > 0;

	return {
		success: evidenceReady,
		name: "research_web",
		sourceType: "web",
		query: result.query,
		queries: result.queries.slice(0, 6).map((query) => query.query),
		answerBrief: {
			instructions: result.answerBrief.instructions
				.slice(0, 8)
				.map((instruction) => truncateText(instruction, 240)),
			sourceCount: sources.length,
			evidenceCount: evidence.length,
		},
		answerBriefMarkdown: truncateText(result.answerBrief.markdown, 30000),
		sources,
		evidence,
		diagnostics: {
			mode: result.diagnostics.mode,
			freshness: result.diagnostics.freshness,
			sourcePolicy: result.diagnostics.sourcePolicy,
			plannedQueryCount: result.diagnostics.plannedQueryCount,
			directUrlCount: result.diagnostics.directUrlCount,
			fetchedSourceCount: result.diagnostics.fetchedSourceCount,
			fusedSourceCount: result.diagnostics.fusedSourceCount,
			selectedSourceCount: result.diagnostics.selectedSourceCount,
			openedPageCount: result.diagnostics.openedPageCount,
			pageExtraction: result.diagnostics.pageExtraction,
			evidenceCandidateCount: result.diagnostics.evidenceCandidateCount,
			exactEvidenceCandidateCount:
				result.diagnostics.exactEvidenceCandidateCount,
			reranked: result.diagnostics.reranked,
			sourceReranked: result.diagnostics.sourceReranked,
			fallbackReasons: result.diagnostics.fallbackReasons.slice(0, 8),
		},
		instructions: evidenceReady
			? "Answer only from the returned answer brief, sources, and evidence. Use markdown links with returned source URLs, and never cite URLs outside the returned source list."
			: "No citation-ready page evidence was fetched. Say the page could not be loaded or no usable evidence was returned; do not infer facts from the URL or answer from memory.",
	};
}

export function createGroundedWebCandidates(
	result: ResearchResult,
): ToolEvidenceCandidate[] {
	return result.sources.slice(0, 12).map((source) => ({
		id: source.id,
		title: truncateText(source.title, 180),
		url: source.url,
		snippet: source.snippet
			? truncateText(source.snippet, 500)
			: source.highlights[0]
				? truncateText(source.highlights[0], 500)
				: null,
		sourceType: "web",
		material: true,
		metadata: {
			provider: source.provider,
			authorityClass: source.authorityClass,
			authorityScore: source.authorityScore,
			providerRank: source.providerRank,
			...(optionalScalarMetadata(source.publishedAt)
				? { publishedAt: source.publishedAt }
				: {}),
			...(optionalScalarMetadata(source.updatedAt)
				? { updatedAt: source.updatedAt }
				: {}),
		},
	}));
}

export function createGroundedWebMetadata(
	result: ResearchResult,
): GroundedWebMetadata {
	const hasGroundingEvidence = result.evidence.length > 0;
	return {
		ok: true,
		evidenceReady: hasGroundingEvidence,
		sourceCount: result.sources.length,
		evidenceCount: result.evidence.length,
		mode: result.diagnostics.mode,
		freshness: result.diagnostics.freshness,
		sourcePolicy: result.diagnostics.sourcePolicy,
		selectedSourceCount: result.diagnostics.selectedSourceCount,
		openedPageCount: result.diagnostics.openedPageCount,
		reranked: result.diagnostics.reranked,
		sourceReranked: result.diagnostics.sourceReranked,
	};
}

export function summarizeGroundedWebResult(result: ResearchResult): string {
	const sourceLabel = result.sources.length === 1 ? "source" : "sources";
	const evidenceLabel =
		result.evidence.length === 1 ? "evidence snippet" : "evidence snippets";
	return `Web research returned ${result.sources.length} ${sourceLabel} and ${result.evidence.length} ${evidenceLabel}.`;
}

export function canonicalizeGroundedWebUrl(
	value: string,
): { canonicalUrl: string; host: string } | null {
	try {
		const url = new URL(value.trim().replace(TRAILING_PUNCTUATION_RE, ""));
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		url.hash = "";
		for (const key of [...url.searchParams.keys()]) {
			if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) {
				url.searchParams.delete(key);
			}
		}
		url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
		url.pathname = url.pathname.replace(/\/+$/, "") || "/";
		return { canonicalUrl: url.toString(), host: url.hostname };
	} catch {
		return null;
	}
}

export function extractAssistantWebCitationUrls(
	assistantResponse: string,
): string[] {
	const urls = new Set<string>();
	for (const match of assistantResponse.matchAll(MARKDOWN_LINK_RE)) {
		if (match[1]) urls.add(match[1]);
	}
	for (const match of assistantResponse.matchAll(BARE_URL_RE)) {
		const value = match[0];
		if (value) urls.add(value);
	}
	return [...urls];
}

function isResearchWebTool(tool: ToolCallEntry): boolean {
	return tool.status === "done" && tool.name === "research_web";
}

function candidateToGroundedWebCitationSource(
	candidate: ToolEvidenceCandidate,
): GroundedWebCitationSource | null {
	if (candidate.sourceType !== "web" || !candidate.url) return null;
	const canonical = canonicalizeGroundedWebUrl(candidate.url);
	if (!canonical) return null;
	return {
		id: candidate.id,
		title: candidate.title,
		url: candidate.url,
		canonicalUrl: canonical.canonicalUrl,
		host: canonical.host,
	};
}

export function extractGroundedWebCitationSources(
	toolCalls: ToolCallEntry[],
): GroundedWebCitationSource[] {
	const uniqueSources = new Map<string, GroundedWebCitationSource>();
	for (const source of toolCalls
		.filter(isResearchWebTool)
		.flatMap((tool) => tool.candidates ?? [])
		.map(candidateToGroundedWebCitationSource)
		.filter((source): source is GroundedWebCitationSource => Boolean(source))) {
		if (!uniqueSources.has(source.canonicalUrl)) {
			uniqueSources.set(source.canonicalUrl, source);
		}
	}
	return Array.from(uniqueSources.values());
}
