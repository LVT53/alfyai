import type { ToolEvidenceCandidate } from "$lib/server/services/message-evidence";
import type { ToolCallEntry } from "$lib/server/services/messages-types";
import {
	type GroundedWebResult,
	type GroundedWebSource,
	MAX_PAYLOAD_EVIDENCE,
	MAX_PAYLOAD_SOURCES,
} from "$lib/server/services/parallel-search/types";

export type GroundedWebPayloadSource = {
	id: string;
	title: string;
	url: string;
	provider: string;
	authorityClass: string;
	authorityScore: number;
	publishedAt: string | null;
	updatedAt: string | null;
	snippet?: string;
};

export type GroundedWebPayloadEvidence = {
	id: string;
	sourceId: string;
	title: string;
	url: string;
	provider: string;
	quote: string;
	score: number;
};

// A single page body fetched by research_web's optional `readPages` (see
// index.ts): the full markdown content of one search-result URL, alongside
// its title, so the model can answer from page-level detail without a
// separate fetch_url round trip in the same turn.
export type GroundedWebPage = {
	url: string;
	title: string;
	contentMarkdown: string;
};

export type GroundedWebModelPayload = {
	success: boolean;
	name: "research_web" | "fetch_url";
	sourceType: "web";
	query: string;
	queries: string[];
	answerBrief: {
		sourceCount: number;
		evidenceCount: number;
	};
	answerBriefMarkdown: string;
	sources: GroundedWebPayloadSource[];
	evidence: GroundedWebPayloadEvidence[];
	// Only present on research_web when readPages > 0.
	pages?: GroundedWebPage[];
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

// Default cap on the answer-brief markdown emitted to the model. Only
// research_web relies on this default — fetch_url always passes an explicit
// maxMarkdownChars sized to the model's context window, so this constant is
// its fallback only (e.g. a caller that forgets to pass one).
const DEFAULT_RESEARCH_WEB_BRIEF_MAX_CHARS = 12_000;
const FETCH_URL_BRIEF_MARKDOWN_CHARS_FALLBACK = 30_000;

// research_web has no model-context-aware sizing of its own (unlike fetch_url,
// which derives maxCharsTotal from the selected model), so its brief cap is a
// flat, operator-tunable knob. Read directly from process.env (not env.ts/
// config-store) so this stays a narrow, local knob.
function resolveWebResearchBriefMaxChars(): number {
	const raw = process.env.WEB_RESEARCH_BRIEF_MAX_CHARS;
	const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0
		? parsed
		: DEFAULT_RESEARCH_WEB_BRIEF_MAX_CHARS;
}

export function buildGroundedWebModelPayload(
	result: GroundedWebResult,
	opts?: { maxMarkdownChars?: number; name?: "research_web" | "fetch_url" },
): GroundedWebModelPayload {
	const name = opts?.name ?? "research_web";
	const sources = result.sources
		.slice(0, MAX_PAYLOAD_SOURCES)
		.map((source) => ({
			id: source.id,
			title: truncateText(source.title, 180),
			url: truncateText(source.url, 500),
			provider: source.provider,
			authorityClass: source.authorityClass,
			authorityScore: source.authorityScore,
			publishedAt: source.publishedAt,
			updatedAt: source.updatedAt,
			...(source.snippet ? { snippet: truncateText(source.snippet, 500) } : {}),
		}));
	const evidence = result.evidence
		.slice(0, MAX_PAYLOAD_EVIDENCE)
		.map((item) => ({
			id: item.id,
			sourceId: item.sourceId,
			title: truncateText(item.title, 180),
			url: truncateText(item.url, 500),
			provider: item.provider,
			quote: truncateText(item.quote, 900),
			score: item.score,
		}));
	const evidenceReady = evidence.length > 0;
	const maxMarkdownChars =
		opts?.maxMarkdownChars ??
		(name === "research_web"
			? resolveWebResearchBriefMaxChars()
			: FETCH_URL_BRIEF_MARKDOWN_CHARS_FALLBACK);

	return {
		success: evidenceReady,
		name,
		sourceType: "web",
		query: result.query,
		queries: result.queries.slice(0, 6).map((query) => query.query),
		answerBrief: {
			sourceCount: sources.length,
			evidenceCount: evidence.length,
		},
		answerBriefMarkdown: truncateText(
			result.answerBrief.markdown,
			maxMarkdownChars,
		),
		sources,
		evidence,
	};
}

export function createGroundedWebCandidates(
	result: GroundedWebResult,
): ToolEvidenceCandidate[] {
	// Slice to the SAME cap as the model payload (MAX_PAYLOAD_SOURCES). A chip
	// must never represent a source the model was never given — otherwise the
	// candidate set could include sources #9–12 that never reached the model.
	return result.sources.slice(0, MAX_PAYLOAD_SOURCES).map((source) => ({
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

// Pick the top `limit` DISTINCT result URLs (by canonical URL, preserving
// source-ranking order) for research_web's optional `readPages` page-read
// follow-up. Sources that fail to canonicalize fall back to their raw URL as
// the dedupe key rather than being dropped.
export function selectTopDistinctSourceUrls(
	sources: GroundedWebSource[],
	limit: number,
): string[] {
	if (limit <= 0) return [];
	const seen = new Set<string>();
	const urls: string[] = [];
	for (const source of sources) {
		const key =
			canonicalizeGroundedWebUrl(source.url)?.canonicalUrl ?? source.url;
		if (seen.has(key)) continue;
		seen.add(key);
		urls.push(source.url);
		if (urls.length >= limit) break;
	}
	return urls;
}

const FETCH_PAGE_HEADER_RE = /^# Fetched page content\n\n/;

// Build a research_web `pages[]` entry from a fetchUrlViaParallel result for
// a SINGLE url. The fetch orchestrator has no per-page-without-wrapper output
// of its own, so this strips the generic "# Fetched page content" wrapper
// fetchUrlViaParallel adds around its (here, single) page block, leaving the
// per-page "[1] title — url" heading, excerpts, and body intact.
export function buildGroundedWebPageFromFetch(
	fetchResult: GroundedWebResult,
): GroundedWebPage | null {
	const source = fetchResult.sources[0];
	if (!source) return null;
	return {
		url: source.url,
		title: source.title,
		contentMarkdown: fetchResult.answerBrief.markdown.replace(
			FETCH_PAGE_HEADER_RE,
			"",
		),
	};
}

// The model payload no longer carries `diagnostics` (P4 hygiene) — this is
// now the ONLY place the full diagnostics survive, for the admin tool-call
// view. `ToolCallEntry["metadata"]` is a flat scalar map, so nested counters
// (pageExtraction.*) are flattened with a prefix and the string[] reason list
// is joined into one string.
export function createGroundedWebMetadata(
	result: GroundedWebResult,
): GroundedWebMetadata {
	const hasGroundingEvidence = result.evidence.length > 0;
	// Diagnostics are operational telemetry; a partial or missing block must
	// never break the turn (the forced web prefetch swallows throws here).
	const diagnostics = (result.diagnostics ?? {}) as Partial<
		GroundedWebResult["diagnostics"]
	>;
	const extraction: Partial<
		NonNullable<GroundedWebResult["diagnostics"]>["pageExtraction"]
	> = diagnostics.pageExtraction ?? {};
	const fallbackReasons = (diagnostics.fallbackReasons ?? [])
		.slice(0, 8)
		.join("; ");
	return {
		ok: true,
		evidenceReady: hasGroundingEvidence,
		sourceCount: result.sources.length,
		evidenceCount: result.evidence.length,
		mode: diagnostics.mode ?? "unknown",
		freshness: diagnostics.freshness ?? "unknown",
		sourcePolicy: diagnostics.sourcePolicy ?? "unknown",
		plannedQueryCount: diagnostics.plannedQueryCount ?? 0,
		directUrlCount: diagnostics.directUrlCount ?? 0,
		fetchedSourceCount: diagnostics.fetchedSourceCount ?? 0,
		fusedSourceCount: diagnostics.fusedSourceCount ?? 0,
		selectedSourceCount: diagnostics.selectedSourceCount ?? 0,
		openedPageCount: diagnostics.openedPageCount ?? 0,
		pageExtractionAttemptedCount: extraction.attemptedCount ?? 0,
		pageExtractionSucceededCount: extraction.succeededCount ?? 0,
		pageExtractionCacheHitCount: extraction.cacheHitCount ?? 0,
		pageExtractionLowQualityCount: extraction.lowQualityCount ?? 0,
		pageExtractionBlockedCount: extraction.blockedCount ?? 0,
		pageExtractionFailedCount: extraction.failedCount ?? 0,
		pageExtractionTotalLatencyMs: extraction.totalLatencyMs ?? 0,
		evidenceCandidateCount: diagnostics.evidenceCandidateCount ?? 0,
		exactEvidenceCandidateCount: diagnostics.exactEvidenceCandidateCount ?? 0,
		reranked: diagnostics.reranked ?? false,
		sourceReranked: diagnostics.sourceReranked ?? false,
		...(fallbackReasons ? { fallbackReasons } : {}),
	};
}

export function summarizeGroundedWebResult(result: GroundedWebResult): string {
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

// Canonical set of the web URLs the assistant actually cited in its answer.
// This is the signal that drives which displayed sources count as "used":
// canonicalization here must match canonicalizeGroundedWebUrl applied to the
// candidate URLs so trailing slashes / www / utm params don't defeat a match.
export function extractCitedCanonicalWebUrls(
	assistantResponse: string,
): Set<string> {
	const canonical = new Set<string>();
	for (const url of extractAssistantWebCitationUrls(assistantResponse)) {
		const result = canonicalizeGroundedWebUrl(url);
		if (result) canonical.add(result.canonicalUrl);
	}
	return canonical;
}

function isWebGroundingTool(tool: ToolCallEntry): boolean {
	return (
		tool.status === "done" &&
		(tool.name === "research_web" || tool.name === "fetch_url")
	);
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
		.filter(isWebGroundingTool)
		.flatMap((tool) => tool.candidates ?? [])
		.map(candidateToGroundedWebCitationSource)
		.filter((source): source is GroundedWebCitationSource => Boolean(source))) {
		if (!uniqueSources.has(source.canonicalUrl)) {
			uniqueSources.set(source.canonicalUrl, source);
		}
	}
	return Array.from(uniqueSources.values());
}
