import { isIP } from "node:net";
import { getConfig, type RuntimeConfig } from "$lib/server/config-store";
import {
	type RankedTeiItem,
	rerankItems,
} from "$lib/server/services/tei-reranker";
import {
	canonicalYouTubeUrl,
	extractYouTubeVideoId,
	fetchYouTubeTranscript,
	isYouTubeVideoUrl,
} from "./youtube";

export type ResearchMode = "quick" | "research" | "exact";
export type ResearchFreshness = "auto" | "live" | "recent" | "cache";
export type ResearchSourcePolicy =
	| "general"
	| "technical"
	| "news"
	| "commerce"
	| "medical_legal_financial";
export type ResearchProvider = "searxng" | "direct";
export type AuthorityClass =
	| "primary"
	| "official"
	| "authoritative"
	| "standard"
	| "low";

export interface ResearchRequest {
	query: string;
	mode?: ResearchMode;
	freshness?: ResearchFreshness;
	sourcePolicy?: ResearchSourcePolicy;
	maxSources?: number;
	quoteRequired?: boolean;
}

export interface PlannedResearchQuery {
	query: string;
	purpose:
		| "broad"
		| "official"
		| "freshness"
		| "exact"
		| "technical"
		| "primary";
}

export interface ResearchSource {
	id: string;
	provider: ResearchProvider;
	title: string;
	url: string;
	canonicalUrl: string;
	snippet: string | null;
	highlights: string[];
	text: string | null;
	score: number;
	providerRank: number;
	query: string;
	publishedAt: string | null;
	updatedAt: string | null;
	retrievedAt: string;
	authorityClass: AuthorityClass;
	authorityScore: number;
	youtubeTranscript?: {
		videoId: string;
		language: string;
		languageCode: string;
		isGenerated: boolean;
		isTranslated: boolean;
		snippetCount: number;
		fetchedAt: string;
	};
}

export interface ResearchEvidence {
	id: string;
	sourceId: string;
	title: string;
	url: string;
	provider: ResearchProvider;
	quote: string;
	surroundingText: string;
	score: number;
	authorityScore: number;
}

export interface ResearchBriefSource {
	ref: string;
	sourceId: string;
	title: string;
	url: string;
	provider: ResearchProvider;
	authorityClass: AuthorityClass;
	authorityScore: number;
	publishedAt: string | null;
	updatedAt: string | null;
	youtubeTranscript?: ResearchSource["youtubeTranscript"];
}

export interface ResearchBriefEvidence {
	ref: string;
	evidenceId: string;
	sourceRef: string;
	sourceId: string;
	title: string;
	url: string;
	quote: string;
	score: number;
}

export interface ResearchAnswerBrief {
	markdown: string;
	instructions: string[];
	sources: ResearchBriefSource[];
	evidence: ResearchBriefEvidence[];
}

export interface ResearchDiagnostics {
	mode: ResearchMode;
	freshness: ResearchFreshness;
	sourcePolicy: ResearchSourcePolicy;
	providers: {
		searxngConfigured: boolean;
	};
	plannedQueryCount: number;
	directUrlCount: number;
	fetchedSourceCount: number;
	fusedSourceCount: number;
	selectedSourceCount: number;
	providerCalls: Array<{
		provider: ResearchProvider;
		query: string;
		resultCount: number;
		latencyMs: number;
		error?: string;
	}>;
	contentCharBudget: number;
	openedPageCount: number;
	sourceReranked: boolean;
	evidenceCandidateCount: number;
	exactEvidenceCandidateCount: number;
	reranked: boolean;
	youtubeTranscriptCandidateCount: number;
	youtubeTranscriptFetchedCount: number;
	youtubeTranscriptFailedCount: number;
	youtubeTranscriptErrors: Array<{
		videoId: string;
		url: string;
		error: string;
	}>;
	fallbackReasons: string[];
}

export interface ResearchResult {
	query: string;
	queries: PlannedResearchQuery[];
	sources: ResearchSource[];
	evidence: ResearchEvidence[];
	answerBrief: ResearchAnswerBrief;
	diagnostics: ResearchDiagnostics;
}

interface WebResearchConfig {
	searxngBaseUrl: string;
	webResearchSearxngNumResults: number;
	webResearchSearxngLanguage: string;
	webResearchSearxngSafesearch: number;
	webResearchSearxngCategories: string;
	webResearchMaxSources: number;
	webResearchHighlightChars: number;
	webResearchContentChars: number;
	webResearchFreshnessHours: number;
}

type ResearchRerankFn<T> = (params: {
	query: string;
	items: T[];
	getText: (item: T) => string;
	maxTexts?: number;
	truncate?: boolean;
}) => Promise<{
	items: Array<RankedTeiItem<T>>;
	confidence: number;
} | null>;

interface ResearchDeps {
	config?: WebResearchConfig;
	fetch?: typeof fetch;
	now?: Date;
	signal?: AbortSignal;
	rerank?: ResearchRerankFn<ResearchEvidence>;
	sourceRerank?: ResearchRerankFn<ResearchSource>;
}

interface ProviderSearchParams {
	query: PlannedResearchQuery;
	request: NormalizedResearchRequest;
	config: WebResearchConfig;
	fetch: typeof fetch;
	nowIso: string;
	signal?: AbortSignal;
}

interface NormalizedResearchRequest {
	query: string;
	mode: ResearchMode;
	freshness: ResearchFreshness;
	sourcePolicy: ResearchSourcePolicy;
	maxSources: number;
	quoteRequired: boolean;
}

function combineAbortSignals(
	...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
	const activeSignals = signals.filter((signal): signal is AbortSignal =>
		Boolean(signal),
	);
	if (activeSignals.length === 0) return undefined;
	if (activeSignals.length === 1) return activeSignals[0];
	return AbortSignal.any(activeSignals);
}

export interface DiscoveryResearchRequest extends ResearchRequest {
	query: string;
	mode: ResearchMode;
	freshness: ResearchFreshness;
	sourcePolicy: ResearchSourcePolicy;
	maxSources: number;
	quoteRequired: boolean;
}

const OFFICIAL_HOST_RE =
	/(^|\.)(gov|edu|who\.int|cdc\.gov|fda\.gov|nih\.gov|europa\.eu|ec\.europa\.eu|ema\.europa\.eu|ecdc\.europa\.eu|belastingdienst\.nl|rijksoverheid\.nl|overheid\.nl|business\.gov\.nl|kvk\.nl|acm\.nl|autoriteitpersoonsgegevens\.nl)$/i;
const TECHNICAL_HOST_RE =
	/(^|\.)((docs|developer|developers|support|help)\.|github\.com$|gitlab\.com$|npmjs\.com$|pypi\.org$|readthedocs\.io$|svelte\.dev$|docs\.searxng\.org$)/i;
const LOW_AUTHORITY_RE =
	/(^|\.)((reddit|quora|pinterest|medium|substack|instagram|linkedin|tiktok)\.com$|facebook\.com$|x\.com$|twitter\.com$)/i;
const EXPLICIT_ADULT_HOST_RE =
	/(^|\.)(porn|xvideos|xnxx|redtube|youporn|pornhub|xhamster|onlyfans|fansly)\./i;
const EXPLICIT_ADULT_TEXT_RE =
	/\b(porn(?:o|ography)?|xxx|x-rated|adult\s+video|adult\s+movie|nude\s+(?:photos?|videos?)|camgirl|escort\s+service|sex\s+(?:video|tube|chat|cam)|hardcore\s+adult)\b/i;
const NEWS_HOST_RE =
	/(^|\.)(reuters\.com$|apnews\.com$|bbc\.com$|bbc\.co\.uk$|nytimes\.com$|theguardian\.com$|wsj\.com$|bloomberg\.com$)/i;
const EXACT_FACT_RE =
	/\b(price|cost|availability|available|address|phone|contact|spec|specification|date|deadline|policy|quote|exact|how much|current)\b/i;
const FRESHNESS_RE =
	/\b(today|now|current|latest|recent|news|2026|this week|this month|price|availability|deadline)\b/i;
const TECHNICAL_RE =
	/\b(api|docs?|documentation|sdk|error|config|library|package|github|readme|migration|version|release)\b/i;
const COMMERCE_RE =
	/\b(price|buy|shop|availability|in stock|spec|model|product|sku|discount|deal|review|reviews?|unboxing|hands-on|vs)\b/i;
const NEWS_RE =
	/\b(news|latest|today|breaking|election|sports|market|stock|earnings)\b/i;
const HIGH_STAKES_RE =
	/\b(medical|medicine|legal|law|financial|finance|tax|health|drug|treatment|court|regulation)\b/i;
const VIDEO_RESEARCH_RE =
	/\b(youtube|video|review|reviews?|unboxing|hands-on|hands on|comparison|versus|vs|pros and cons|worth it|best)\b/i;
const MAX_PLANNED_QUERIES = 6;
const MAX_PROVIDER_SEARCH_CALLS = 4;
const SOURCE_RERANK_CONFIDENCE_MIN = 40;
const EXACT_CONTENT_CHARS_MIN = 12_000;
const RESEARCH_CONTENT_CHARS_MIN = 8_000;
const MAX_YOUTUBE_TRANSCRIPTS = 3;
const YOUTUBE_TRANSCRIPT_TIMEOUT_MS = 12_000;
const PAGE_FETCH_TIMEOUT_MS = 6_000;
const PAGE_OPEN_CONCURRENCY = 4;
const DEFAULT_WEB_RESEARCH_CONFIG: WebResearchConfig = {
	searxngBaseUrl: "",
	webResearchSearxngNumResults: 12,
	webResearchSearxngLanguage: "en",
	webResearchSearxngSafesearch: 1,
	webResearchSearxngCategories: "general",
	webResearchMaxSources: 8,
	webResearchHighlightChars: 4000,
	webResearchContentChars: 12000,
	webResearchFreshnessHours: 24,
};
const HTTP_URL_RE = /https?:\/\/[^\s<>)\]]+/gi;
const TRAILING_URL_PUNCTUATION_RE = /[.,;:!?]+$/;
const EXACT_VALUE_RE =
	/(?:[$\u20ac\u00a3\u00a5]\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:USD|EUR|GBP|JPY|dollars?|euros?|pounds?)\b|\b(?:in stock|out of stock|available|unavailable|sold out|pre[- ]?order|ships?\s+(?:by|in|within)\s+[^.!?]{1,48})\b|\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d+(?:\.\d+)?\s?(?:%|percent|GB|TB|MB|kg|g|lbs?|inches|inch|cm|mm|mAh|W|V|Hz|kWh)\b|\+?\d[\d\s().-]{7,}\d)/gi;
const QUERY_STOP_WORDS = new Set([
	"about",
	"after",
	"also",
	"and",
	"from",
	"based",
	"before",
	"focus",
	"for",
	"have",
	"into",
	"latest",
	"much",
	"only",
	"price",
	"show",
	"shown",
	"source",
	"sources",
	"should",
	"that",
	"the",
	"their",
	"there",
	"this",
	"use",
	"using",
	"verify",
	"what",
	"when",
	"where",
	"which",
	"with",
]);
const BLOCKED_DIRECT_HOSTNAMES = new Set([
	"localhost",
	"localhost.localdomain",
	"metadata.google.internal",
]);

function toWebResearchConfig(
	config: RuntimeConfig | WebResearchConfig,
): WebResearchConfig {
	return {
		searxngBaseUrl: config.searxngBaseUrl,
		webResearchSearxngNumResults: config.webResearchSearxngNumResults,
		webResearchSearxngLanguage: config.webResearchSearxngLanguage,
		webResearchSearxngSafesearch: config.webResearchSearxngSafesearch,
		webResearchSearxngCategories: config.webResearchSearxngCategories,
		webResearchMaxSources: config.webResearchMaxSources,
		webResearchHighlightChars: config.webResearchHighlightChars,
		webResearchContentChars: config.webResearchContentChars,
		webResearchFreshnessHours: config.webResearchFreshnessHours,
	};
}

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function normalizeUrlHostname(hostname: string): string {
	return hostname
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");
}

function isBlockedIpv4Address(hostname: string): boolean {
	const parts = hostname.split(".").map((part) => Number(part));
	if (
		parts.length !== 4 ||
		parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
	) {
		return false;
	}

	const [a, b] = parts;
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19)) ||
		a >= 224
	);
}

function isBlockedIpv6Address(hostname: string): boolean {
	const normalized = normalizeUrlHostname(hostname);
	if (normalized === "::" || normalized === "::1") return true;
	if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
	if (/^fe[89ab]/i.test(normalized)) return true;

	const mappedIpv4 = normalized.match(/^(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
	return mappedIpv4 ? isBlockedIpv4Address(mappedIpv4[1]) : false;
}

function isBlockedResearchHostname(hostname: string): boolean {
	const normalized = normalizeUrlHostname(hostname);
	if (!normalized) return true;
	if (
		BLOCKED_DIRECT_HOSTNAMES.has(normalized) ||
		normalized.endsWith(".localhost") ||
		normalized.endsWith(".local")
	) {
		return true;
	}

	const ipVersion = isIP(normalized);
	if (ipVersion === 4) return isBlockedIpv4Address(normalized);
	if (ipVersion === 6) return isBlockedIpv6Address(normalized);

	return false;
}

function isFetchableResearchUrl(value: string): boolean {
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return false;
		return !isBlockedResearchHostname(url.hostname);
	} catch {
		return false;
	}
}

function extractDirectUrls(value: string): string[] {
	const urls = new Map<string, string>();
	for (const match of value.matchAll(HTTP_URL_RE)) {
		const rawUrl = match[0]?.replace(TRAILING_URL_PUNCTUATION_RE, "");
		if (!rawUrl) continue;
		if (!isFetchableResearchUrl(rawUrl)) continue;
		const canonicalUrl = canonicalizeUrl(rawUrl);
		urls.set(canonicalUrl, rawUrl);
	}
	return [...urls.values()];
}

function containsDirectUrl(value: string): boolean {
	return extractDirectUrls(value).length > 0;
}

function inferMode(query: string): ResearchMode {
	if (containsDirectUrl(query)) return "exact";
	if (EXACT_FACT_RE.test(query)) return "exact";
	if (
		/\b(compare|comparison|research|detailed|sources|overview|pros and cons|best|review|reviews?|unboxing|hands-on|worth it)\b/i.test(
			query,
		)
	) {
		return "research";
	}
	return "quick";
}

function inferFreshness(query: string, mode: ResearchMode): ResearchFreshness {
	if (
		/\b(today|now|latest|breaking|current|price|availability|in stock)\b/i.test(
			query,
		)
	) {
		return "live";
	}
	if (mode === "exact" || FRESHNESS_RE.test(query)) return "recent";
	return "auto";
}

function inferSourcePolicy(query: string): ResearchSourcePolicy {
	if (HIGH_STAKES_RE.test(query)) return "medical_legal_financial";
	if (TECHNICAL_RE.test(query)) return "technical";
	if (COMMERCE_RE.test(query)) return "commerce";
	if (NEWS_RE.test(query)) return "news";
	return "general";
}

function shouldPlanYouTubeQuery(request: NormalizedResearchRequest): boolean {
	if (
		request.sourcePolicy === "technical" ||
		request.sourcePolicy === "medical_legal_financial" ||
		request.sourcePolicy === "news"
	) {
		return false;
	}
	return request.mode !== "quick" && VIDEO_RESEARCH_RE.test(request.query);
}

function normalizeRequest(
	request: ResearchRequest,
	config: WebResearchConfig,
): NormalizedResearchRequest {
	const query = normalizeWhitespace(request.query);
	const mode = request.mode ?? inferMode(query);
	const freshness = request.freshness ?? inferFreshness(query, mode);
	const sourcePolicy = request.sourcePolicy ?? inferSourcePolicy(query);
	const maxSources = Math.max(
		1,
		Math.min(12, request.maxSources ?? config.webResearchMaxSources),
	);
	return {
		query,
		mode,
		freshness,
		sourcePolicy,
		maxSources,
		quoteRequired:
			request.quoteRequired ?? (mode === "exact" || containsDirectUrl(query)),
	};
}

export function buildDiscoveryResearchRequest(
	request: ResearchRequest,
): DiscoveryResearchRequest {
	return normalizeRequest(request, DEFAULT_WEB_RESEARCH_CONFIG);
}

export function planResearchQueries(
	request: ResearchRequest,
	now: Date = new Date(),
): PlannedResearchQuery[] {
	const normalized = normalizeRequest(request, DEFAULT_WEB_RESEARCH_CONFIG);
	const year = now.getUTCFullYear();
	const queries: PlannedResearchQuery[] = [];
	const addQuery = (
		query: string,
		purpose: PlannedResearchQuery["purpose"],
	) => {
		const normalizedQuery = normalizeWhitespace(query);
		if (!normalizedQuery) return;
		if (
			queries.some(
				(entry) => entry.query.toLowerCase() === normalizedQuery.toLowerCase(),
			)
		) {
			return;
		}
		queries.push({ query: normalizedQuery, purpose });
	};

	addQuery(normalized.query, "broad");
	const compactQuery = compactSearchQuery(normalized.query) || normalized.query;
	if (/\bframework\s+laptop\b/i.test(normalized.query)) {
		addQuery(`site:frame.work ${compactQuery}`, "official");
	}
	if (/\bsvelte(?:kit)?\b/i.test(normalized.query)) {
		addQuery(`site:svelte.dev ${compactQuery}`, "official");
	}
	if (/\bsearxng\b/i.test(normalized.query)) {
		addQuery(`site:docs.searxng.org ${compactQuery}`, "official");
	}
	if (/\b(eu ai act|gpai|general-purpose ai)\b/i.test(normalized.query)) {
		addQuery(`site:europa.eu ${compactQuery}`, "official");
	}
	if (/\b(zzp|belastingdienst|dutch|netherlands)\b/i.test(normalized.query)) {
		addQuery(`site:business.gov.nl ${compactQuery}`, "official");
		addQuery(`site:belastingdienst.nl ${compactQuery}`, "official");
	}

	if (normalized.sourcePolicy === "technical") {
		addQuery(`${normalized.query} official documentation`, "technical");
		if (normalized.mode === "research" || normalized.quoteRequired) {
			addQuery(`${normalized.query} GitHub README release notes`, "primary");
		}
	} else if (normalized.sourcePolicy === "medical_legal_financial") {
		addQuery(`${normalized.query} official guidance`, "official");
		addQuery(`${normalized.query} government primary source`, "primary");
	} else if (normalized.sourcePolicy === "commerce") {
		addQuery(`${normalized.query} official store specifications`, "official");
		if (shouldPlanYouTubeQuery(normalized)) {
			addQuery(`${normalized.query} YouTube review transcript`, "primary");
		}
		if (normalized.mode === "exact" || normalized.quoteRequired) {
			addQuery(`${normalized.query} manufacturer price availability`, "exact");
		}
	} else if (normalized.sourcePolicy === "news") {
		addQuery(`${normalized.query} Reuters AP primary source`, "primary");
		if (normalized.mode === "research") {
			addQuery(`${normalized.query} official statement`, "official");
		}
	} else {
		addQuery(`${normalized.query} official source`, "official");
		if (shouldPlanYouTubeQuery(normalized)) {
			addQuery(`${normalized.query} YouTube review transcript`, "primary");
		}
		if (normalized.mode === "research" || normalized.quoteRequired) {
			addQuery(`${normalized.query} primary source report data`, "primary");
		}
	}

	if (normalized.freshness === "live" || normalized.freshness === "recent") {
		addQuery(`${normalized.query} ${year}`, "freshness");
	}

	if (normalized.mode === "exact" || normalized.quoteRequired) {
		addQuery(`"${normalized.query}"`, "exact");
		addQuery(`${normalized.query} exact value source`, "exact");
	}

	return queries.slice(0, MAX_PLANNED_QUERIES);
}

function canonicalizeUrl(value: string): string {
	const youtubeVideoId = extractYouTubeVideoId(value);
	if (youtubeVideoId) return canonicalYouTubeUrl(youtubeVideoId);

	try {
		const url = new URL(value);
		url.hash = "";
		for (const key of [...url.searchParams.keys()]) {
			if (/^(utm_|fbclid|gclid|mc_cid|mc_eid)/i.test(key)) {
				url.searchParams.delete(key);
			}
		}
		url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
		return url.toString();
	} catch {
		return value.trim();
	}
}

function hostOf(value: string): string {
	try {
		return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
	} catch {
		return "";
	}
}

function isQueryOfficialHost(host: string, query: string): boolean {
	if (!host) return false;
	if (/\bframework(?:\s+laptop)?\b/i.test(query)) {
		return host === "frame.work" || host.endsWith(".frame.work");
	}
	if (/\bsvelte(?:kit)?\b/i.test(query)) {
		return host === "svelte.dev" || host.endsWith(".svelte.dev");
	}
	if (/\bsearxng\b/i.test(query)) {
		return host === "docs.searxng.org" || host.endsWith(".searxng.org");
	}
	if (/\b(eu ai act|gpai|general-purpose ai)\b/i.test(query)) {
		return host.endsWith(".europa.eu");
	}
	if (/\b(zzp|belastingdienst|netherlands|dutch)\b/i.test(query)) {
		return (
			host === "belastingdienst.nl" ||
			host.endsWith(".belastingdienst.nl") ||
			host === "business.gov.nl" ||
			host.endsWith(".business.gov.nl") ||
			host === "rijksoverheid.nl" ||
			host.endsWith(".rijksoverheid.nl") ||
			host === "kvk.nl" ||
			host.endsWith(".kvk.nl")
		);
	}
	return false;
}

function isStrictOfficialSourceRequest(query: string): boolean {
	return (
		/\bofficial\b/i.test(query) &&
		/\bsources?\b/i.test(query) &&
		/\bonly\b/i.test(query)
	);
}

function isOfficialCandidateForQuery(
	source: ResearchSource,
	request: NormalizedResearchRequest,
): boolean {
	return (
		source.authorityClass === "official" ||
		isQueryOfficialHost(hostOf(source.canonicalUrl), request.query)
	);
}

function hasExplicitAdultContent(value: string): boolean {
	return EXPLICIT_ADULT_TEXT_RE.test(value);
}

function isExplicitAdultSource(params: {
	url: string;
	title: string;
	snippet?: string | null;
	highlights?: string[];
	text?: string | null;
}): boolean {
	const host = hostOf(params.url);
	if (host && EXPLICIT_ADULT_HOST_RE.test(host)) return true;
	return hasExplicitAdultContent(
		normalizeWhitespace(
			[
				params.title,
				params.snippet ?? "",
				...(params.highlights ?? []),
				params.text ?? "",
			].join(" "),
		),
	);
}

export function classifySourceAuthority(
	url: string,
	policy: ResearchSourcePolicy,
): { authorityClass: AuthorityClass; authorityScore: number } {
	const host = hostOf(url);
	if (!host) return { authorityClass: "standard", authorityScore: 20 };
	if (OFFICIAL_HOST_RE.test(host))
		return { authorityClass: "official", authorityScore: 95 };
	if (policy === "technical" && TECHNICAL_HOST_RE.test(host)) {
		return { authorityClass: "primary", authorityScore: 90 };
	}
	if (policy === "news" && NEWS_HOST_RE.test(host)) {
		return { authorityClass: "authoritative", authorityScore: 78 };
	}
	if (LOW_AUTHORITY_RE.test(host))
		return { authorityClass: "low", authorityScore: 8 };
	if (TECHNICAL_HOST_RE.test(host))
		return { authorityClass: "authoritative", authorityScore: 70 };
	return { authorityClass: "standard", authorityScore: 35 };
}

function truncate(value: string, maxLength: number): string {
	const normalized = normalizeWhitespace(value);
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function createSource(params: {
	provider: ResearchProvider;
	title: string;
	url: string;
	snippet?: string | null;
	highlights?: string[];
	text?: string | null;
	score?: number;
	providerRank: number;
	query: string;
	publishedAt?: string | null;
	updatedAt?: string | null;
	retrievedAt: string;
	policy: ResearchSourcePolicy;
}): ResearchSource | null {
	const url = typeof params.url === "string" ? params.url.trim() : "";
	if (!url || !/^https?:\/\//i.test(url)) return null;
	const title = normalizeWhitespace(params.title || url);
	const canonicalUrl = canonicalizeUrl(url);
	if (
		isExplicitAdultSource({
			url: canonicalUrl,
			title,
			snippet: params.snippet,
			highlights: params.highlights,
			text: params.text,
		})
	) {
		return null;
	}
	const authority = classifySourceAuthority(canonicalUrl, params.policy);
	return {
		id: `${params.provider}:${canonicalUrl}`,
		provider: params.provider,
		title,
		url,
		canonicalUrl,
		snippet: params.snippet ? truncate(params.snippet, 1200) : null,
		highlights: (params.highlights ?? [])
			.map((item) => truncate(item, 2000))
			.filter(Boolean),
		text: params.text ? truncate(params.text, 20000) : null,
		score: params.score ?? 0,
		providerRank: params.providerRank,
		query: params.query,
		publishedAt: params.publishedAt ?? null,
		updatedAt: params.updatedAt ?? null,
		retrievedAt: params.retrievedAt,
		...authority,
	};
}

function createDirectUrlSources(params: {
	request: NormalizedResearchRequest;
	nowIso: string;
}): ResearchSource[] {
	return extractDirectUrls(params.request.query)
		.map((url, index) =>
			createSource({
				provider: "direct",
				title: `User-provided page: ${hostOf(url) || url}`,
				url,
				snippet: null,
				highlights: [],
				text: null,
				score: 100,
				providerRank: index,
				query: params.request.query,
				retrievedAt: params.nowIso,
				policy: params.request.sourcePolicy,
			}),
		)
		.filter((source): source is ResearchSource => Boolean(source));
}

function searxngSearchUrl(baseUrl: string): URL {
	const trimmed = baseUrl.trim();
	const normalizedBase = trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
	return new URL("search", normalizedBase);
}

function searxngTimeRange(
	request: NormalizedResearchRequest,
	config: WebResearchConfig,
): string | null {
	if (request.freshness === "cache" || request.freshness === "auto") {
		return null;
	}
	if (request.freshness === "live") return "day";
	const hours = config.webResearchFreshnessHours;
	if (hours <= 0 || hours <= 24) return "day";
	if (hours <= 24 * 7) return "week";
	if (hours <= 24 * 31) return "month";
	return "year";
}

async function searchSearxng(
	params: ProviderSearchParams,
): Promise<ResearchSource[]> {
	if (!params.config.searxngBaseUrl.trim()) return [];

	const timeRange = searxngTimeRange(params.request, params.config);
	const fetchResults = async (activeTimeRange: string | null) => {
		const url = searxngSearchUrl(params.config.searxngBaseUrl);
		url.searchParams.set("q", params.query.query);
		url.searchParams.set("format", "json");
		url.searchParams.set("pageno", "1");
		url.searchParams.set(
			"categories",
			params.config.webResearchSearxngCategories || "general",
		);
		url.searchParams.set(
			"language",
			params.config.webResearchSearxngLanguage || "en",
		);
		url.searchParams.set(
			"safesearch",
			String(
				Math.max(0, Math.min(2, params.config.webResearchSearxngSafesearch)),
			),
		);
		if (activeTimeRange) url.searchParams.set("time_range", activeTimeRange);

		const response = await params.fetch(url.toString(), {
			method: "GET",
			headers: {
				Accept: "application/json",
			},
			signal: params.signal,
		});

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			const hint =
				response.status === 403
					? " Check that the local SearXNG settings.yml enables the json search format."
					: "";
			throw new Error(
				`SearXNG search failed: ${response.status} ${response.statusText}${text ? ` - ${text.slice(0, 300)}` : ""}${hint}`,
			);
		}

		const data = (await response.json()) as {
			results?: Array<Record<string, unknown>>;
		};
		return data.results ?? [];
	};

	let results = await fetchResults(timeRange);
	if (results.length === 0 && timeRange) {
		results = await fetchResults(null);
	}

	return results
		.slice(
			0,
			Math.min(100, Math.max(1, params.config.webResearchSearxngNumResults)),
		)
		.map((result, index) =>
			createSource({
				provider: "searxng",
				title: String(result.title ?? result.url ?? ""),
				url: String(result.url ?? ""),
				snippet:
					typeof result.content === "string"
						? result.content
						: typeof result.snippet === "string"
							? result.snippet
							: null,
				highlights:
					typeof result.content === "string"
						? [result.content]
						: typeof result.snippet === "string"
							? [result.snippet]
							: [],
				text: null,
				score: typeof result.score === "number" ? result.score : 0,
				providerRank: index + 1,
				query: params.query.query,
				publishedAt:
					typeof result.publishedDate === "string"
						? result.publishedDate
						: typeof result.published_date === "string"
							? result.published_date
							: null,
				updatedAt:
					typeof result.updatedAt === "string"
						? result.updatedAt
						: typeof result.updated_at === "string"
							? result.updated_at
							: null,
				retrievedAt: params.nowIso,
				policy: params.request.sourcePolicy,
			}),
		)
		.filter((source): source is ResearchSource => Boolean(source));
}

function sourceFusionScore(
	source: ResearchSource,
	request: NormalizedResearchRequest,
): number {
	const rankScore = 80 / (source.providerRank + 1);
	const providerScore = source.provider === "direct" ? 10 : 6;
	const sourceText = normalizeWhitespace(
		`${source.title} ${source.snippet ?? ""} ${source.highlights.join(" ")}`,
	).toLowerCase();
	const host = hostOf(source.canonicalUrl);
	const terms = queryTerms(request.query);
	const termHits = termHitCount(`${sourceText} ${host}`, terms);
	const relevanceBoost =
		terms.length === 0
			? 0
			: termHits === 0
				? -60
				: termHits === 1 && terms.length >= 4
					? -20
					: termHits >= Math.min(3, terms.length)
						? 10
						: 0;
	const exactBoost =
		request.mode === "exact" &&
		sourceText.includes(request.query.toLowerCase().slice(0, 80))
			? 10
			: 0;
	const freshnessBoost =
		request.freshness === "live" || request.freshness === "recent"
			? source.updatedAt || source.publishedAt
				? 8
				: 0
			: 0;
	const officialTextBoost =
		/\b(official|primary source|documentation|manual|reference)\b/i.test(
			sourceText,
		)
			? 8
			: 0;
	const commerceIntentBoost =
		request.sourcePolicy === "commerce" &&
		/\b(official|manufacturer|store|product page|specifications?|availability|in stock)\b/i.test(
			sourceText,
		)
			? 12
			: 0;
	const queryOfficialHostBoost = isQueryOfficialHost(host, request.query)
		? request.sourcePolicy === "commerce"
			? 55
			: 35
		: 0;
	const videoIntentBoost =
		isYouTubeVideoUrl(source.url) && VIDEO_RESEARCH_RE.test(request.query)
			? 18
			: 0;
	const transcriptBoost = source.youtubeTranscript ? 12 : 0;
	const technicalIntentBoost =
		request.sourcePolicy === "technical" &&
		/\b(docs?|documentation|api|reference|readme|release notes?|migration)\b/i.test(
			sourceText,
		)
			? 10
			: 0;
	const lowIntentPenalty =
		/\b(coupon|deal|affiliate|price tracker|forum thread|reddit|quora)\b/i.test(
			sourceText,
		)
			? 12
			: 0;
	return (
		rankScore +
		providerScore +
		source.authorityScore +
		relevanceBoost +
		exactBoost +
		freshnessBoost +
		officialTextBoost +
		commerceIntentBoost +
		queryOfficialHostBoost +
		videoIntentBoost +
		transcriptBoost +
		technicalIntentBoost -
		lowIntentPenalty
	);
}

function sourceCoverageBoost(params: {
	providerCount: number;
	queryCount: number;
	occurrenceCount: number;
}): number {
	return Math.min(
		14,
		Math.max(0, params.providerCount - 1) * 4 +
			Math.max(0, params.queryCount - 1) * 3 +
			Math.max(0, params.occurrenceCount - 1),
	);
}

function fuseSources(
	sources: ResearchSource[],
	request: NormalizedResearchRequest,
): ResearchSource[] {
	const byUrl = new Map<string, ResearchSource>();
	const coverage = new Map<
		string,
		{ providers: Set<ResearchProvider>; queries: Set<string>; count: number }
	>();
	for (const source of sources) {
		const sourceCoverage = coverage.get(source.canonicalUrl) ?? {
			providers: new Set<ResearchProvider>(),
			queries: new Set<string>(),
			count: 0,
		};
		sourceCoverage.providers.add(source.provider);
		sourceCoverage.queries.add(source.query);
		sourceCoverage.count += 1;
		coverage.set(source.canonicalUrl, sourceCoverage);

		const existing = byUrl.get(source.canonicalUrl);
		if (!existing) {
			byUrl.set(source.canonicalUrl, source);
			continue;
		}

		byUrl.set(source.canonicalUrl, {
			...existing,
			provider:
				existing.provider === "direct" ? existing.provider : source.provider,
			snippet: existing.snippet ?? source.snippet,
			highlights: [...existing.highlights, ...source.highlights].slice(0, 6),
			text: existing.text ?? source.text,
			score: Math.max(existing.score, source.score),
			authorityScore: Math.max(existing.authorityScore, source.authorityScore),
			authorityClass:
				source.authorityScore > existing.authorityScore
					? source.authorityClass
					: existing.authorityClass,
			providerRank: Math.min(existing.providerRank, source.providerRank),
		});
	}

	return [...byUrl.values()]
		.map((source) => ({
			...source,
			score:
				sourceFusionScore(source, request) +
				sourceCoverageBoost({
					providerCount: coverage.get(source.canonicalUrl)?.providers.size ?? 1,
					queryCount: coverage.get(source.canonicalUrl)?.queries.size ?? 1,
					occurrenceCount: coverage.get(source.canonicalUrl)?.count ?? 1,
				}),
		}))
		.sort((left, right) => {
			if (right.score !== left.score) return right.score - left.score;
			return left.canonicalUrl.localeCompare(right.canonicalUrl);
		});
}

function hostDiversityLimit(request: NormalizedResearchRequest): number {
	return request.mode === "quick" ? 1 : 2;
}

function lowAuthorityLimit(request: NormalizedResearchRequest): number {
	if (
		request.sourcePolicy === "technical" ||
		request.sourcePolicy === "medical_legal_financial"
	) {
		return 0;
	}
	return 1;
}

function selectResearchSources(
	sources: ResearchSource[],
	request: NormalizedResearchRequest,
	options: {
		mandatoryCanonicalUrls?: Set<string>;
		preferSourceOrder?: boolean;
	} = {},
): ResearchSource[] {
	const limit = request.maxSources;
	const hasOfficialCandidates = sources.some((source) =>
		isOfficialCandidateForQuery(source, request),
	);
	const candidateSources =
		isStrictOfficialSourceRequest(request.query) && hasOfficialCandidates
			? sources.filter((source) => isOfficialCandidateForQuery(source, request))
			: sources;
	const selected: ResearchSource[] = [];
	const selectedUrls = new Set<string>();
	const hostCounts = new Map<string, number>();
	const hostLimit = hostDiversityLimit(request);
	const lowLimit = lowAuthorityLimit(request);
	const hasNonLowAuthority = candidateSources.some(
		(source) => source.authorityClass !== "low",
	);

	const addSource = (
		source: ResearchSource,
		options: { enforceHostLimit: boolean; enforceLowLimit: boolean },
	): boolean => {
		if (selected.length >= limit || selectedUrls.has(source.canonicalUrl)) {
			return false;
		}

		const host = hostOf(source.canonicalUrl);
		if (options.enforceHostLimit && host) {
			const currentHostCount = hostCounts.get(host) ?? 0;
			if (currentHostCount >= hostLimit) return false;
		}

		if (
			options.enforceLowLimit &&
			hasNonLowAuthority &&
			source.authorityClass === "low"
		) {
			const currentLowCount = selected.filter(
				(item) => item.authorityClass === "low",
			).length;
			if (currentLowCount >= lowLimit) return false;
		}

		selected.push(source);
		selectedUrls.add(source.canonicalUrl);
		if (host) hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1);
		return true;
	};

	for (const source of sources) {
		if (!options.mandatoryCanonicalUrls?.has(source.canonicalUrl)) continue;
		addSource(source, { enforceHostLimit: false, enforceLowLimit: false });
	}

	if (options.preferSourceOrder) {
		for (const source of candidateSources) {
			addSource(source, { enforceHostLimit: true, enforceLowLimit: true });
		}

		for (const source of candidateSources) {
			addSource(source, { enforceHostLimit: false, enforceLowLimit: false });
		}

		return selected;
	}

	for (const source of candidateSources) {
		if (source.authorityScore < 70) continue;
		addSource(source, { enforceHostLimit: true, enforceLowLimit: true });
	}

	for (const source of candidateSources) {
		addSource(source, { enforceHostLimit: true, enforceLowLimit: true });
	}

	for (const source of candidateSources) {
		addSource(source, { enforceHostLimit: false, enforceLowLimit: false });
	}

	return selected;
}

function sourceRerankText(source: ResearchSource): string {
	return [
		source.title,
		source.snippet ?? "",
		source.highlights.join("\n"),
		source.text ? truncate(source.text, 3000) : "",
		`URL: ${source.url}`,
		`Authority: ${source.authorityClass}`,
		source.youtubeTranscript
			? `YouTube transcript: ${source.youtubeTranscript.language} (${source.youtubeTranscript.languageCode}), generated=${source.youtubeTranscript.isGenerated}`
			: "",
	]
		.filter(Boolean)
		.join("\n");
}

async function rerankSources(
	query: string,
	sources: ResearchSource[],
	rerank: ResearchRerankFn<ResearchSource>,
): Promise<{ sources: ResearchSource[]; reranked: boolean }> {
	if (sources.length <= 1) return { sources, reranked: false };

	try {
		const reranked = await rerank({
			query,
			items: sources,
			getText: sourceRerankText,
			maxTexts: Math.min(48, sources.length),
			truncate: true,
		});
		if (
			!reranked ||
			reranked.items.length === 0 ||
			reranked.confidence < SOURCE_RERANK_CONFIDENCE_MIN
		) {
			return { sources, reranked: false };
		}

		const rerankedUrls = new Set<string>();
		const ordered = reranked.items.map((entry) => {
			rerankedUrls.add(entry.item.canonicalUrl);
			return {
				...entry.item,
				score:
					entry.score * 100 +
					entry.item.authorityScore +
					Math.min(20, entry.item.score / 10),
			};
		});
		const remaining = sources.filter(
			(source) => !rerankedUrls.has(source.canonicalUrl),
		);
		return {
			sources: [...ordered, ...remaining],
			reranked: true,
		};
	} catch {
		return { sources, reranked: false };
	}
}

function decodeHtmlEntities(value: string): string {
	const named: Record<string, string> = {
		amp: "&",
		apos: "'",
		gt: ">",
		lt: "<",
		nbsp: " ",
		quot: '"',
	};
	return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
		const normalized = String(entity).toLowerCase();
		if (normalized.startsWith("#x")) {
			const parsed = Number.parseInt(normalized.slice(2), 16);
			return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : match;
		}
		if (normalized.startsWith("#")) {
			const parsed = Number.parseInt(normalized.slice(1), 10);
			return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : match;
		}
		return named[normalized] ?? match;
	});
}

function extractHtmlTitle(html: string): string | null {
	const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	if (titleMatch?.[1]) {
		return truncate(
			decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, " ")),
			300,
		);
	}
	const h1Match = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
	if (h1Match?.[1]) {
		return truncate(
			decodeHtmlEntities(h1Match[1].replace(/<[^>]+>/g, " ")),
			300,
		);
	}
	return null;
}

function htmlToReadableText(html: string): string {
	const withoutNonContent = html
		.replace(/<script\b[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<pre\b[\s\S]*?<\/pre>/gi, " ")
		.replace(/<svg\b[\s\S]*?<\/svg>/gi, " ");
	const withBreaks = withoutNonContent
		.replace(
			/<\/(p|div|section|article|header|footer|main|aside|li|tr|h[1-6])>/gi,
			"\n",
		)
		.replace(/<br\s*\/?>/gi, "\n");
	return normalizeWhitespace(
		decodeHtmlEntities(withBreaks.replace(/<[^>]+>/g, " ")),
	);
}

function buildPageHighlights(
	text: string,
	request: NormalizedResearchRequest,
): string[] {
	const terms = queryTerms(request.query);
	return splitIntoChunks(text, 900)
		.map((chunk, index) => {
			EXACT_VALUE_RE.lastIndex = 0;
			return {
				chunk,
				score:
					termHitCount(chunk, terms) * 10 +
					(EXACT_VALUE_RE.test(chunk) ? 8 : 0) -
					index / 100,
			};
		})
		.sort((left, right) => right.score - left.score)
		.slice(0, 5)
		.map((item) => truncate(item.chunk, 1600));
}

async function fetchPageContent(params: {
	source: ResearchSource;
	request: NormalizedResearchRequest;
	config: WebResearchConfig;
	fetch: typeof fetch;
	signal?: AbortSignal;
}): Promise<{
	title: string | null;
	text: string | null;
	highlights: string[];
} | null> {
	try {
		if (!isFetchableResearchUrl(params.source.url)) {
			return null;
		}
		const response = await params.fetch(params.source.url, {
			method: "GET",
			headers: {
				Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			},
			signal: combineAbortSignals(
				params.signal,
				AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS),
			),
		});
		if (!response.ok) return null;
		const contentType = response.headers.get("content-type") ?? "";
		if (
			contentType &&
			!/text\/html|application\/xhtml\+xml|text\/plain|application\/xml|text\/xml/i.test(
				contentType,
			)
		) {
			return null;
		}

		const rawText = await response.text();
		const htmlLike =
			!contentType ||
			/html|xml/i.test(contentType) ||
			/<html|<body|<article|<p[\s>]/i.test(rawText);
		const text = htmlLike
			? htmlToReadableText(rawText)
			: normalizeWhitespace(rawText);
		if (!text) return null;
		if (
			isExplicitAdultSource({
				url: params.source.canonicalUrl,
				title: params.source.title,
				snippet: params.source.snippet,
				highlights: params.source.highlights,
				text,
			})
		) {
			return null;
		}
		const contentCharacters = contentCharacterBudget(
			params.request,
			params.config,
		);
		return {
			title: htmlLike ? extractHtmlTitle(rawText) : null,
			text: truncate(text, contentCharacters),
			highlights: buildPageHighlights(text, params.request),
		};
	} catch {
		return null;
	}
}

async function mapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	mapper: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = [];
	let cursor = 0;
	const workers = Array.from(
		{ length: Math.min(concurrency, Math.max(1, items.length)) },
		async () => {
			while (cursor < items.length) {
				const index = cursor;
				cursor += 1;
				results[index] = await mapper(items[index] as T);
			}
		},
	);
	await Promise.all(workers);
	return results;
}

async function openTopPages(params: {
	sources: ResearchSource[];
	request: NormalizedResearchRequest;
	config: WebResearchConfig;
	fetch: typeof fetch;
	signal?: AbortSignal;
}): Promise<
	Map<
		string,
		{ title: string | null; text: string | null; highlights: string[] }
	>
> {
	if (params.sources.length === 0) {
		return new Map();
	}

	const opened = new Map<
		string,
		{ title: string | null; text: string | null; highlights: string[] }
	>();
	const pageResults = await mapWithConcurrency(
		params.sources,
		PAGE_OPEN_CONCURRENCY,
		async (source) => ({
			source,
			content: await fetchPageContent({ ...params, source }),
		}),
	);
	for (const result of pageResults) {
		if (result.content) opened.set(result.source.canonicalUrl, result.content);
	}
	return opened;
}

function contentCharacterBudget(
	request: NormalizedResearchRequest,
	config: WebResearchConfig,
): number {
	const configured = Math.max(1000, config.webResearchContentChars);
	if (request.mode === "exact" || request.quoteRequired) {
		return Math.max(configured, EXACT_CONTENT_CHARS_MIN);
	}
	if (request.mode === "research") {
		return Math.max(configured, RESEARCH_CONTENT_CHARS_MIN);
	}
	return configured;
}

function splitIntoChunks(value: string, maxLength = 1200): string[] {
	const paragraphs = value
		.split(/\n{2,}|(?<=\.)\s+(?=[A-Z0-9])/)
		.map((item) => normalizeWhitespace(item))
		.filter((item) => item.length > 40);
	const chunks: string[] = [];
	let current = "";

	for (const paragraph of paragraphs) {
		if (`${current} ${paragraph}`.trim().length > maxLength && current) {
			chunks.push(current);
			current = paragraph;
		} else {
			current = `${current} ${paragraph}`.trim();
		}
	}
	if (current) chunks.push(current);
	return chunks.slice(0, 8);
}

function queryTerms(query: string): string[] {
	const terms = query
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.map((term) => term.trim())
		.filter(
			(term) =>
				(term.length >= 3 || /^\d{2,4}$/.test(term)) &&
				!QUERY_STOP_WORDS.has(term),
		);
	return [...new Set(terms)].slice(0, 12);
}

function compactSearchQuery(query: string): string {
	return queryTerms(query).join(" ");
}

function termHitCount(value: string, terms: string[]): number {
	if (terms.length === 0) return 0;
	const lowerValue = value.toLowerCase();
	return terms.filter((term) => lowerValue.includes(term)).length;
}

function buildTranscriptHighlights(
	transcriptText: string,
	request: NormalizedResearchRequest,
): string[] {
	const terms = queryTerms(request.query);
	const paragraphs = transcriptText
		.split(/\n{2,}/)
		.map((item) => normalizeWhitespace(item))
		.filter((item) => item.length > 40);
	if (paragraphs.length === 0) return [];

	return paragraphs
		.map((paragraph, index) => ({
			paragraph,
			score:
				termHitCount(paragraph, terms) * 10 +
				(VIDEO_RESEARCH_RE.test(paragraph) ? 4 : 0) -
				index / 100,
		}))
		.sort((left, right) => right.score - left.score)
		.slice(0, 5)
		.map((item) => truncate(item.paragraph, 1600));
}

async function enrichYouTubeTranscriptSources(params: {
	sources: ResearchSource[];
	request: NormalizedResearchRequest;
	config: WebResearchConfig;
	fetch: typeof fetch;
	nowIso: string;
	signal?: AbortSignal;
}): Promise<{
	candidateCount: number;
	fetchedCount: number;
	failedCount: number;
	errors: Array<{ videoId: string; url: string; error: string }>;
}> {
	const youtubeSources = params.sources
		.filter((source) => isYouTubeVideoUrl(source.url))
		.slice(0, MAX_YOUTUBE_TRANSCRIPTS);
	const errors: Array<{ videoId: string; url: string; error: string }> = [];
	let fetchedCount = 0;

	await Promise.all(
		youtubeSources.map(async (source) => {
			const videoId = extractYouTubeVideoId(source.url) ?? "";
			try {
				const transcript = await fetchYouTubeTranscript({
					url: source.url,
					fetch: params.fetch,
					timeoutMs: YOUTUBE_TRANSCRIPT_TIMEOUT_MS,
					signal: params.signal,
				});
				if (!transcript) return;

				fetchedCount += 1;
				if (transcript.title) {
					source.title = truncate(transcript.title, 300);
				}
				source.text = truncate(
					[
						`YouTube transcript for ${source.title}.`,
						`Language: ${transcript.language} (${transcript.languageCode}).`,
						transcript.isGenerated
							? "Transcript type: automatically generated captions."
							: "Transcript type: manually created captions.",
						transcript.isTranslated
							? "Transcript was translated by YouTube captions."
							: "",
						transcript.text,
					]
						.filter(Boolean)
						.join("\n\n"),
					contentCharacterBudget(params.request, params.config),
				);
				source.highlights = [
					...buildTranscriptHighlights(transcript.text, params.request),
					...source.highlights,
				].slice(0, 8);
				source.score += 18;
				source.youtubeTranscript = {
					videoId: transcript.videoId,
					language: transcript.language,
					languageCode: transcript.languageCode,
					isGenerated: transcript.isGenerated,
					isTranslated: transcript.isTranslated,
					snippetCount: transcript.snippetCount,
					fetchedAt: params.nowIso,
				};
			} catch (error) {
				errors.push({
					videoId,
					url: source.url,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}),
	);

	return {
		candidateCount: youtubeSources.length,
		fetchedCount,
		failedCount: errors.length,
		errors,
	};
}

function previousSentenceStart(value: string, index: number): number {
	const candidates = [". ", "! ", "? "]
		.map((marker) => value.lastIndexOf(marker, index))
		.filter((candidate) => candidate >= 0);
	const boundary = candidates.length > 0 ? Math.max(...candidates) + 2 : -1;
	if (boundary >= 0 && index - boundary <= 360) return boundary;
	return Math.max(0, index - 260);
}

function nextSentenceEnd(value: string, index: number): number {
	const rest = value.slice(index);
	const match = /[.!?](?:\s|$)/.exec(rest);
	if (match?.index != null) {
		const boundary = index + match.index + 1;
		if (boundary - index <= 360) return boundary;
	}
	return Math.min(value.length, index + 260);
}

function exactQuoteWindow(
	value: string,
	matchIndex: number,
	matchLength: number,
	maxQuoteLength: number,
): string {
	const start = previousSentenceStart(value, matchIndex);
	const end = nextSentenceEnd(value, matchIndex + matchLength);
	return truncate(value.slice(start, end), maxQuoteLength);
}

function shouldExtractExactEvidence(
	request: NormalizedResearchRequest,
): boolean {
	return (
		request.quoteRequired ||
		request.mode !== "quick" ||
		request.sourcePolicy === "commerce" ||
		request.sourcePolicy === "medical_legal_financial"
	);
}

function buildExactEvidenceChunks(
	source: ResearchSource,
	request: NormalizedResearchRequest,
	maxQuoteLength: number,
): ResearchEvidence[] {
	if (!shouldExtractExactEvidence(request)) return [];

	const terms = queryTerms(request.query);
	const candidates = new Map<string, ResearchEvidence>();
	const parts = [
		...source.highlights,
		source.snippet ?? "",
		source.text ?? "",
	].filter(Boolean);

	for (const [partIndex, part] of parts.entries()) {
		const normalizedPart = normalizeWhitespace(part);
		EXACT_VALUE_RE.lastIndex = 0;
		for (const match of normalizedPart.matchAll(EXACT_VALUE_RE)) {
			const matchIndex = match.index ?? -1;
			const rawMatch = match[0] ?? "";
			if (matchIndex < 0 || !rawMatch.trim()) continue;

			const quote = exactQuoteWindow(
				normalizedPart,
				matchIndex,
				rawMatch.length,
				maxQuoteLength,
			);
			if (!quote) continue;

			const key = quote.toLowerCase();
			const score =
				source.score +
				source.authorityScore +
				60 +
				termHitCount(quote, terms) * 6 -
				partIndex;
			const existing = candidates.get(key);
			if (existing && existing.score >= score) continue;

			candidates.set(key, {
				id: `${source.id}#exact-${partIndex}-${matchIndex}`,
				sourceId: source.id,
				title: source.title,
				url: source.url,
				provider: source.provider,
				quote,
				surroundingText: quote,
				score,
				authorityScore: source.authorityScore,
			});
		}
	}

	return [...candidates.values()]
		.sort((left, right) => {
			if (right.score !== left.score) return right.score - left.score;
			return left.id.localeCompare(right.id);
		})
		.slice(0, 6);
}

function buildEvidenceChunks(
	sources: ResearchSource[],
	maxQuoteLength: number,
	request: NormalizedResearchRequest,
): { evidence: ResearchEvidence[]; exactCount: number } {
	const chunks: ResearchEvidence[] = [];
	let exactCount = 0;
	for (const source of sources) {
		const exactChunks = buildExactEvidenceChunks(
			source,
			request,
			maxQuoteLength,
		);
		exactCount += exactChunks.length;
		chunks.push(...exactChunks);

		const sourceTextParts = [
			...source.highlights,
			source.snippet ?? "",
			source.text ?? "",
		].filter(Boolean);

		const sourceChunks = sourceTextParts.flatMap((part) =>
			splitIntoChunks(part),
		);
		for (const [index, chunk] of sourceChunks.entries()) {
			const quote = truncate(chunk, maxQuoteLength);
			if (!quote) continue;
			chunks.push({
				id: `${source.id}#chunk-${index}`,
				sourceId: source.id,
				title: source.title,
				url: source.url,
				provider: source.provider,
				quote,
				surroundingText: chunk,
				score: source.score + source.authorityScore,
				authorityScore: source.authorityScore,
			});
		}
	}
	return { evidence: chunks, exactCount };
}

async function rerankEvidence(
	query: string,
	evidence: ResearchEvidence[],
	rerank: ResearchRerankFn<ResearchEvidence>,
): Promise<{ evidence: ResearchEvidence[]; reranked: boolean }> {
	if (evidence.length <= 1) return { evidence, reranked: false };

	try {
		const reranked = await rerank({
			query,
			items: evidence,
			getText: (item) => `${item.title}\n${item.quote}`,
			maxTexts: Math.min(48, evidence.length),
		});
		if (!reranked || reranked.items.length === 0) {
			return {
				evidence: evidence.sort((a, b) => b.score - a.score),
				reranked: false,
			};
		}
		return {
			evidence: reranked.items.map((entry) => ({
				...entry.item,
				score: entry.score * 100 + entry.item.authorityScore,
			})),
			reranked: true,
		};
	} catch {
		return {
			evidence: evidence.sort((a, b) => b.score - a.score),
			reranked: false,
		};
	}
}

function dateLabel(
	source: Pick<ResearchSource, "publishedAt" | "updatedAt">,
): string {
	if (source.updatedAt) return `updated ${source.updatedAt}`;
	if (source.publishedAt) return `published ${source.publishedAt}`;
	return "date not exposed";
}

function buildResearchAnswerBrief(params: {
	query: string;
	sources: ResearchSource[];
	evidence: ResearchEvidence[];
}): ResearchAnswerBrief {
	const instructions = [
		"Use only the sources and evidence in this brief for web-backed claims.",
		"The brief may be written in English because it is tool context. It is not a response-language instruction; write the final visible answer in the latest user-message language unless the user explicitly requested another language.",
		"Cite every web-backed claim with markdown links using the listed source URLs and titles. Use the source title as the visible link text, not the S1/S2 reference.",
		"For exact prices, dates, specs, policies, availability, or quotes, rely on evidence snippets; if the value is not in the snippets, say it was not found.",
		"Do not cite URLs that are not listed in this brief.",
	];
	const sourceRefById = new Map<string, string>();
	const sources: ResearchBriefSource[] = params.sources.map((source, index) => {
		const ref = `S${index + 1}`;
		sourceRefById.set(source.id, ref);
		return {
			ref,
			sourceId: source.id,
			title: source.title,
			url: source.url,
			provider: source.provider,
			authorityClass: source.authorityClass,
			authorityScore: source.authorityScore,
			publishedAt: source.publishedAt,
			updatedAt: source.updatedAt,
			youtubeTranscript: source.youtubeTranscript,
		};
	});
	const evidence: ResearchBriefEvidence[] = params.evidence
		.slice(0, Math.max(4, Math.min(12, params.sources.length * 2)))
		.map((item, index) => ({
			ref: `E${index + 1}`,
			evidenceId: item.id,
			sourceRef: sourceRefById.get(item.sourceId) ?? "S?",
			sourceId: item.sourceId,
			title: item.title,
			url: item.url,
			quote: truncate(item.quote, 700),
			score: Math.round(item.score * 100) / 100,
		}));

	const sourceLines = sources.map((source) =>
		[
			`[${source.title}](${source.url})`,
			`Authority: ${source.authorityClass} (${source.authorityScore})`,
			`Provider: ${source.provider}`,
			source.youtubeTranscript
				? `Media: YouTube transcript, ${source.youtubeTranscript.language} (${source.youtubeTranscript.languageCode}), generated=${source.youtubeTranscript.isGenerated}, translated=${source.youtubeTranscript.isTranslated}`
				: "",
			`Date: ${dateLabel(source)}`,
		]
			.filter(Boolean)
			.join("\n"),
	);
	const evidenceLines = evidence.map((item) =>
		[`[${item.title}](${item.url})`, `Quote: ${item.quote}`].join("\n"),
	);
	const markdown = [
		`Research brief for: ${params.query}`,
		"Citation rules:",
		...instructions.map((instruction) => `- ${instruction}`),
		sources.length > 0
			? `Sources:\n${sourceLines.join("\n\n")}`
			: "Sources: none returned.",
		evidence.length > 0
			? `Evidence snippets:\n${evidenceLines.join("\n\n")}`
			: "Evidence snippets: none returned.",
	].join("\n\n");

	return {
		markdown: truncate(markdown, 16000),
		instructions,
		sources,
		evidence,
	};
}

export async function researchWeb(
	request: ResearchRequest,
	deps: ResearchDeps = {},
): Promise<ResearchResult> {
	const config = toWebResearchConfig(deps.config ?? getConfig());
	const fetchImpl = deps.fetch ?? fetch;
	const now = deps.now ?? new Date();
	const nowIso = now.toISOString();
	const normalized = normalizeRequest(request, config);

	if (!normalized.query) {
		throw new Error("query is required");
	}

	const queries = planResearchQueries(normalized, now);
	const diagnostics: ResearchDiagnostics = {
		mode: normalized.mode,
		freshness: normalized.freshness,
		sourcePolicy: normalized.sourcePolicy,
		providers: {
			searxngConfigured: Boolean(config.searxngBaseUrl.trim()),
		},
		plannedQueryCount: queries.length,
		directUrlCount: 0,
		fetchedSourceCount: 0,
		fusedSourceCount: 0,
		selectedSourceCount: 0,
		providerCalls: [],
		contentCharBudget: contentCharacterBudget(normalized, config),
		openedPageCount: 0,
		sourceReranked: false,
		evidenceCandidateCount: 0,
		exactEvidenceCandidateCount: 0,
		reranked: false,
		youtubeTranscriptCandidateCount: 0,
		youtubeTranscriptFetchedCount: 0,
		youtubeTranscriptFailedCount: 0,
		youtubeTranscriptErrors: [],
		fallbackReasons: [],
	};

	const enabledProviders: ResearchProvider[] = config.searxngBaseUrl.trim()
		? ["searxng"]
		: [];
	const providerCalls = queries
		.flatMap((query) =>
			enabledProviders.map((provider) => ({ provider, query })),
		)
		.slice(0, MAX_PROVIDER_SEARCH_CALLS);
	const directUrlSources = createDirectUrlSources({
		request: normalized,
		nowIso,
	});
	diagnostics.directUrlCount = directUrlSources.length;
	const mandatoryCanonicalUrls = new Set(
		directUrlSources.map((source) => source.canonicalUrl),
	);

	const sourceBatches: Array<{
		sources: ResearchSource[];
		providerCall: ResearchDiagnostics["providerCalls"][number];
	}> = [];
	for (const call of providerCalls) {
		const startedAt = Date.now();
		try {
			const sources = await searchSearxng({
				query: call.query,
				request: normalized,
				config,
				fetch: fetchImpl,
				nowIso,
				signal: deps.signal,
			});
			sourceBatches.push({
				sources,
				providerCall: {
					provider: call.provider,
					query: call.query.query,
					resultCount: sources.length,
					latencyMs: Date.now() - startedAt,
				},
			});
		} catch (error) {
			sourceBatches.push({
				sources: [],
				providerCall: {
					provider: call.provider,
					query: call.query.query,
					resultCount: 0,
					latencyMs: Date.now() - startedAt,
					error: error instanceof Error ? error.message : String(error),
				},
			});
		}
	}
	diagnostics.providerCalls = sourceBatches.map((batch) => batch.providerCall);
	diagnostics.fetchedSourceCount = sourceBatches.reduce(
		(total, batch) => total + batch.sources.length,
		0,
	);

	const fused = fuseSources(
		[...directUrlSources, ...sourceBatches.flatMap((batch) => batch.sources)],
		normalized,
	);
	diagnostics.fusedSourceCount = fused.length;
	const sourceRanked = await rerankSources(
		normalized.query,
		fused,
		deps.sourceRerank ?? rerankItems<ResearchSource>,
	);
	diagnostics.sourceReranked = sourceRanked.reranked;
	let selectedSources = selectResearchSources(
		sourceRanked.sources,
		normalized,
		{
			mandatoryCanonicalUrls,
			preferSourceOrder: sourceRanked.reranked,
		},
	);
	diagnostics.selectedSourceCount = selectedSources.length;
	if (selectedSources.length === 0) {
		if (enabledProviders.length === 0 && directUrlSources.length === 0) {
			diagnostics.fallbackReasons.push("web_research_not_configured");
		} else {
			const providerCallCount = diagnostics.providerCalls.length;
			const providerFailureCount = diagnostics.providerCalls.filter((call) =>
				Boolean(call.error),
			).length;
			if (providerFailureCount > 0) {
				diagnostics.fallbackReasons.push("provider_search_failed");
			}
			if (providerFailureCount < providerCallCount) {
				diagnostics.fallbackReasons.push("no_search_results");
			}
		}
	}

	if (
		normalized.quoteRequired ||
		normalized.mode === "research" ||
		normalized.mode === "exact"
	) {
		const opened = await openTopPages({
			sources: selectedSources,
			request: normalized,
			config,
			fetch: fetchImpl,
			signal: deps.signal,
		});
		diagnostics.openedPageCount = opened.size;
		if (selectedSources.length > 0 && opened.size === 0) {
			diagnostics.fallbackReasons.push("page_open_failed");
		}
		const failedDirectUrlSources = selectedSources.filter(
			(source) =>
				mandatoryCanonicalUrls.has(source.canonicalUrl) &&
				source.provider === "direct" &&
				!opened.has(source.canonicalUrl),
		);
		if (failedDirectUrlSources.length > 0) {
			diagnostics.fallbackReasons.push("direct_url_open_failed");
		}
		for (const source of selectedSources) {
			const openedContent = opened.get(source.canonicalUrl);
			if (!openedContent) continue;
			if (openedContent.title) {
				source.title = truncate(openedContent.title, 300);
			}
			const contentCharacters = contentCharacterBudget(normalized, config);
			source.text = openedContent.text
				? truncate(openedContent.text, contentCharacters)
				: source.text;
			source.highlights = [
				...openedContent.highlights,
				...source.highlights,
			].slice(0, 8);
		}
		selectedSources = selectedSources.filter((source) => {
			if (
				!mandatoryCanonicalUrls.has(source.canonicalUrl) ||
				source.provider !== "direct" ||
				opened.has(source.canonicalUrl)
			) {
				return true;
			}
			return Boolean(
				source.text?.trim() ||
					source.snippet?.trim() ||
					source.highlights.some((highlight) => highlight.trim()),
			);
		});
		diagnostics.selectedSourceCount = selectedSources.length;
	}

	const youtubeTranscriptResult = await enrichYouTubeTranscriptSources({
		sources: selectedSources,
		request: normalized,
		config,
		fetch: fetchImpl,
		nowIso,
		signal: deps.signal,
	});
	diagnostics.youtubeTranscriptCandidateCount =
		youtubeTranscriptResult.candidateCount;
	diagnostics.youtubeTranscriptFetchedCount =
		youtubeTranscriptResult.fetchedCount;
	diagnostics.youtubeTranscriptFailedCount =
		youtubeTranscriptResult.failedCount;
	diagnostics.youtubeTranscriptErrors = youtubeTranscriptResult.errors;
	if (
		youtubeTranscriptResult.candidateCount > 0 &&
		youtubeTranscriptResult.fetchedCount === 0
	) {
		diagnostics.fallbackReasons.push("youtube_transcript_unavailable");
	}

	const rawEvidence = buildEvidenceChunks(
		selectedSources,
		config.webResearchHighlightChars,
		normalized,
	);
	diagnostics.evidenceCandidateCount = rawEvidence.evidence.length;
	diagnostics.exactEvidenceCandidateCount = rawEvidence.exactCount;
	const rankedEvidence = await rerankEvidence(
		normalized.query,
		rawEvidence.evidence,
		deps.rerank ?? rerankItems<ResearchEvidence>,
	);
	diagnostics.reranked = rankedEvidence.reranked;
	const evidence = rankedEvidence.evidence.slice(
		0,
		Math.max(4, normalized.maxSources * 2),
	);

	return {
		query: normalized.query,
		queries,
		sources: selectedSources,
		evidence,
		answerBrief: buildResearchAnswerBrief({
			query: normalized.query,
			sources: selectedSources,
			evidence,
		}),
		diagnostics,
	};
}
