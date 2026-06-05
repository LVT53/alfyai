import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

export type WebResearchExtractorMode = "readability" | "basic" | "auto";

export interface WebResearchExtractionConfig {
	webResearchExtractorMode?: WebResearchExtractorMode;
	webResearchExtractTimeoutMs?: number;
	webResearchExtractCacheTtlHours?: number;
	webResearchCrawl4aiEnabled?: boolean;
	webResearchCrawl4aiBaseUrl?: string;
	webResearchCrawl4aiTimeoutMs?: number;
	webResearchCrawl4aiMaxFallbackSources?: number;
	webResearchCrawl4aiMinQualityScore?: number;
	webResearchLlmExtractionReviewEnabled?: boolean;
}

export interface WebResearchFallbackBudget {
	remaining: number;
}

export interface WebResearchExtractionQuality {
	score: number;
	contentLength: number;
	markdownLength: number;
	linkDensity: number;
	structureScore: number;
	repeatedLineRatio: number;
	blockedHint: boolean;
	lowQualityReasons: string[];
}

export interface WebResearchExtractionDiagnostics {
	extractor: "readability" | "basic" | "crawl4ai";
	mode: WebResearchExtractorMode;
	latencyMs: number;
	contentType: string | null;
	status: number | null;
	cacheHit: boolean;
	fallbackUsed: boolean;
	fallbackReason: string | null;
	errorCode: string | null;
}

export interface WebResearchExtractedPage {
	title: string | null;
	markdown: string;
	plainText: string;
	excerpt: string | null;
	metadata: {
		byline?: string | null;
		siteName?: string | null;
		publishedTime?: string | null;
	};
	quality: WebResearchExtractionQuality;
	diagnostics: WebResearchExtractionDiagnostics;
}

export interface WebResearchExtractionMetrics {
	attemptedCount: number;
	succeededCount: number;
	cacheHitCount: number;
	crawl4aiFallbackCount: number;
	lowQualityCount: number;
	blockedCount: number;
	failedCount: number;
	totalLatencyMs: number;
	lastErrorCode: string | null;
}

const EXTRACTOR_VERSION = "readability-markdown-v2";
const DEFAULT_EXTRACT_TIMEOUT_MS = 6_000;
const DEFAULT_CACHE_TTL_HOURS = 24;
const DEFAULT_CRAWL4AI_TIMEOUT_MS = 9_000;
const DEFAULT_CRAWL4AI_MIN_QUALITY_SCORE = 0.45;
const MAX_CACHE_ENTRIES = 512;
const MAX_MARKDOWN_CHARS = 80_000;
const BLOCKED_HOSTNAMES = new Set([
	"localhost",
	"localhost.localdomain",
	"metadata.google.internal",
]);
const HTML_CONTENT_TYPE_RE =
	/text\/html|application\/xhtml\+xml|application\/xml|text\/xml/i;
const TEXT_CONTENT_TYPE_RE = /text\/plain/i;
const BLOCKED_PAGE_RE =
	/\b(captcha|access denied|enable javascript|checking your browser|cloudflare|are you a human|unusual traffic)\b/i;
const GENERATED_FALLBACK_RE =
	/\b(as an ai language model|i (?:cannot|can't) browse|i do not have access to|generated summary|here(?:'s| is) (?:a )?summary of)\b/i;

const cache = new Map<
	string,
	{ expiresAt: number; value: WebResearchExtractedPage }
>();

const metrics: WebResearchExtractionMetrics = {
	attemptedCount: 0,
	succeededCount: 0,
	cacheHitCount: 0,
	crawl4aiFallbackCount: 0,
	lowQualityCount: 0,
	blockedCount: 0,
	failedCount: 0,
	totalLatencyMs: 0,
	lastErrorCode: null,
};

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function normalizeMarkdown(value: string): string {
	return value
		.replace(/\r\n?/g, "\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{4,}/g, "\n\n\n")
		.trim();
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

export function isSafeWebResearchFetchUrl(value: string): boolean {
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return false;
		const normalized = normalizeUrlHostname(url.hostname);
		if (!normalized) return false;
		if (
			BLOCKED_HOSTNAMES.has(normalized) ||
			normalized.endsWith(".localhost") ||
			normalized.endsWith(".local")
		) {
			return false;
		}
		const ipVersion = isIP(normalized);
		if (ipVersion === 4) return !isBlockedIpv4Address(normalized);
		if (ipVersion === 6) return !isBlockedIpv6Address(normalized);
		return true;
	} catch {
		return false;
	}
}

function canonicalizeUrl(value: string): string {
	try {
		const url = new URL(value);
		url.hash = "";
		for (const key of [...url.searchParams.keys()]) {
			if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) {
				url.searchParams.delete(key);
			}
		}
		url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
		url.pathname = url.pathname.replace(/\/+$/, "") || "/";
		return url.toString();
	} catch {
		return value.trim();
	}
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

function extractionMode(
	config: WebResearchExtractionConfig,
): WebResearchExtractorMode {
	const mode = config.webResearchExtractorMode;
	return mode === "basic" || mode === "auto" || mode === "readability"
		? mode
		: "readability";
}

function timeoutMs(value: number | undefined, fallback: number): number {
	return Math.max(1_000, Math.floor(value ?? fallback));
}

function cacheTtlMs(config: WebResearchExtractionConfig): number {
	const hours = Math.max(
		0,
		Number.isFinite(config.webResearchExtractCacheTtlHours)
			? (config.webResearchExtractCacheTtlHours as number)
			: DEFAULT_CACHE_TTL_HOURS,
	);
	return hours * 60 * 60 * 1000;
}

function cacheKey(url: string, config: WebResearchExtractionConfig): string {
	const fallbackKey = config.webResearchCrawl4aiEnabled
		? [
				"crawl4ai",
				config.webResearchCrawl4aiBaseUrl?.trim().replace(/\/+$/, "") ?? "",
				Math.max(0, config.webResearchCrawl4aiMaxFallbackSources ?? 0),
				Math.max(
					0,
					Math.min(
						1,
						config.webResearchCrawl4aiMinQualityScore ??
							DEFAULT_CRAWL4AI_MIN_QUALITY_SCORE,
					),
				),
			].join(":")
		: "local";
	return `${EXTRACTOR_VERSION}:${extractionMode(config)}:${fallbackKey}:${canonicalizeUrl(url)}`;
}

function cloneResult(
	result: WebResearchExtractedPage,
	cacheHit: boolean,
): WebResearchExtractedPage {
	return {
		...result,
		metadata: { ...result.metadata },
		quality: {
			...result.quality,
			lowQualityReasons: [...result.quality.lowQualityReasons],
		},
		diagnostics: {
			...result.diagnostics,
			cacheHit,
		},
	};
}

function readCache(
	url: string,
	config: WebResearchExtractionConfig,
	now: number,
): WebResearchExtractedPage | null {
	const ttlMs = cacheTtlMs(config);
	if (ttlMs <= 0) return null;
	const entry = cache.get(cacheKey(url, config));
	if (!entry || entry.expiresAt <= now) {
		if (entry) cache.delete(cacheKey(url, config));
		return null;
	}
	metrics.cacheHitCount += 1;
	return cloneResult(entry.value, true);
}

function writeCache(
	url: string,
	config: WebResearchExtractionConfig,
	now: number,
	value: WebResearchExtractedPage,
): void {
	const ttlMs = cacheTtlMs(config);
	if (ttlMs <= 0) return;
	if (cache.size >= MAX_CACHE_ENTRIES) {
		const oldest = cache.keys().next().value;
		if (oldest) cache.delete(oldest);
	}
	cache.set(cacheKey(url, config), {
		expiresAt: now + ttlMs,
		value: cloneResult(value, false),
	});
}

function markdownToPlainText(markdown: string): string {
	return normalizeWhitespace(
		markdown
			.replace(/```[\s\S]*?```/g, (block) =>
				block.replace(/^```[^\n]*\n?|\n?```$/g, " "),
			)
			.replace(/`([^`]+)`/g, "$1")
			.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
			.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
			.replace(/^#{1,6}\s+/gm, "")
			.replace(/^\s*[-*+]\s+/gm, "")
			.replace(/^\s*\d+\.\s+/gm, "")
			.replace(/[>|*_~#]+/g, " "),
	);
}

function createTurndownService(): TurndownService {
	const service = new TurndownService({
		headingStyle: "atx",
		bulletListMarker: "-",
		codeBlockStyle: "fenced",
		fence: "```",
		emDelimiter: "*",
		strongDelimiter: "**",
		linkStyle: "inlined",
		preformattedCode: true,
	});
	service.use(gfm);
	service.addRule("fencedPre", {
		filter: (node) => node.nodeName === "PRE",
		replacement: (_content, node) => {
			const text = (node.textContent ?? "").replace(/\n+$/g, "");
			if (!text.trim()) return "";
			return `\n\n\`\`\`\n${text}\n\`\`\`\n\n`;
		},
	});
	return service;
}

function basicHtmlToMarkdown(html: string): string {
	const withoutNonContent = html
		.replace(/<script\b[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<svg\b[\s\S]*?<\/svg>/gi, " ");
	const withBreaks = withoutNonContent
		.replace(
			/<\/(p|div|section|article|header|footer|main|aside|li|tr|h[1-6]|pre)>/gi,
			"\n\n",
		)
		.replace(/<br\s*\/?>/gi, "\n");
	return normalizeMarkdown(withBreaks.replace(/<[^>]+>/g, " "));
}

function extractHtmlTitle(html: string): string | null {
	const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	if (titleMatch?.[1])
		return normalizeWhitespace(titleMatch[1].replace(/<[^>]+>/g, " "));
	const h1Match = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
	return h1Match?.[1]
		? normalizeWhitespace(h1Match[1].replace(/<[^>]+>/g, " "))
		: null;
}

function documentTitle(document: Document): string | null {
	const title = document.querySelector("title")?.textContent;
	return title?.trim() ? normalizeWhitespace(title) : null;
}

function elementTitle(element: Element, document: Document): string | null {
	const heading = element.querySelector("h1")?.textContent;
	return heading?.trim()
		? normalizeWhitespace(heading)
		: documentTitle(document);
}

function markdownWithTitle(markdown: string, title: string | null): string {
	if (!title) return markdown;
	if (markdown.toLowerCase().includes(title.toLowerCase())) return markdown;
	return normalizeMarkdown(`# ${title}\n\n${markdown}`);
}

function readableTemporalHint(value: string | null): string | null {
	const trimmed = value?.trim();
	if (!trimmed) return null;
	return trimmed.length > 80 ? trimmed.slice(0, 80) : trimmed;
}

function preserveMachineReadableTimes(document: Document): void {
	const temporalElements = document.querySelectorAll(
		[
			"time[datetime]",
			"time[title]",
			"relative-time[datetime]",
			"relative-time[title]",
			"local-time[datetime]",
			"local-time[title]",
		].join(","),
	);

	for (const element of temporalElements) {
		const visibleText = normalizeWhitespace(element.textContent ?? "");
		const hint = readableTemporalHint(
			element.getAttribute("datetime") ?? element.getAttribute("title"),
		);
		if (!hint) continue;
		if (visibleText.includes(hint)) continue;
		element.textContent = visibleText ? `${visibleText} (${hint})` : hint;
	}
}

function extractWithReadability(
	html: string,
	url: string,
): {
	title: string | null;
	markdown: string;
	plainText: string;
	excerpt: string | null;
	metadata: WebResearchExtractedPage["metadata"];
} | null {
	const dom = new JSDOM(html, { url });
	preserveMachineReadableTimes(dom.window.document);
	const semanticArticle = dom.window.document.querySelector("article");
	if (
		semanticArticle &&
		normalizeWhitespace(semanticArticle.textContent ?? "").length >= 120
	) {
		const title = elementTitle(semanticArticle, dom.window.document);
		const markdown = markdownWithTitle(
			normalizeMarkdown(
				createTurndownService().turndown(semanticArticle.innerHTML),
			),
			title,
		);
		const plainText = markdownToPlainText(markdown);
		if (markdown && plainText) {
			return {
				title,
				markdown,
				plainText,
				excerpt: plainText.slice(0, 280),
				metadata: { siteName: hostLabel(url) },
			};
		}
	}
	const documentClone = dom.window.document.cloneNode(true) as Document;
	const article = new Readability(documentClone, {
		charThreshold: 250,
		keepClasses: false,
	}).parse();
	if (!article?.content) return null;
	const title = article.title
		? normalizeWhitespace(article.title)
		: documentTitle(dom.window.document);
	const markdown = markdownWithTitle(
		normalizeMarkdown(
			createTurndownService()
				.turndown(article.content)
				.slice(0, MAX_MARKDOWN_CHARS),
		),
		title,
	);
	const plainText = markdownToPlainText(markdown || article.textContent || "");
	if (!markdown || !plainText) return null;
	return {
		title,
		markdown,
		plainText,
		excerpt: article.excerpt ? normalizeWhitespace(article.excerpt) : null,
		metadata: {
			byline: article.byline ?? article.meta?.author ?? null,
			siteName: article.siteName ?? null,
			publishedTime: article.publishedTime ?? null,
		},
	};
}

function extractBasic(
	raw: string,
	url: string,
	htmlLike: boolean,
): {
	title: string | null;
	markdown: string;
	plainText: string;
	excerpt: string | null;
	metadata: WebResearchExtractedPage["metadata"];
} | null {
	const markdown = htmlLike ? basicHtmlToMarkdown(raw) : normalizeMarkdown(raw);
	const plainText = markdownToPlainText(markdown);
	if (!plainText) return null;
	return {
		title: htmlLike ? extractHtmlTitle(raw) : null,
		markdown,
		plainText,
		excerpt: plainText.slice(0, 280),
		metadata: { siteName: hostLabel(url) },
	};
}

function hostLabel(value: string): string | null {
	try {
		return new URL(value).hostname.replace(/^www\./, "");
	} catch {
		return null;
	}
}

function countMarkdownStructures(markdown: string): number {
	let score = 0;
	if (/^#{1,6}\s+/m.test(markdown)) score += 1;
	if (/^\s*[-*+]\s+/m.test(markdown) || /^\s*\d+\.\s+/m.test(markdown))
		score += 1;
	if (/```/.test(markdown)) score += 1;
	if (/^\|.+\|$/m.test(markdown)) score += 1;
	if (/\[[^\]]+\]\(https?:\/\//.test(markdown)) score += 1;
	return score;
}

function repeatedLineRatio(value: string): number {
	const lines = value
		.split(/\n+/)
		.map((line) => normalizeWhitespace(line).toLowerCase())
		.filter((line) => line.length > 20);
	if (lines.length < 4) return 0;
	const unique = new Set(lines);
	return Math.max(0, Math.min(1, 1 - unique.size / lines.length));
}

function linkDensity(markdown: string, plainText: string): number {
	const linkTextLength = [
		...markdown.matchAll(/\[([^\]]+)\]\([^)]+\)/g),
	].reduce((total, match) => total + (match[1]?.length ?? 0), 0);
	return plainText.length > 0
		? Math.max(0, Math.min(1, linkTextLength / plainText.length))
		: 0;
}

function scoreQuality(
	markdown: string,
	plainText: string,
): WebResearchExtractionQuality {
	const structures = countMarkdownStructures(markdown);
	const repeated = repeatedLineRatio(markdown);
	const density = linkDensity(markdown, plainText);
	const blockedHint = BLOCKED_PAGE_RE.test(plainText);
	const lowQualityReasons: string[] = [];
	if (plainText.length < 500) lowQualityReasons.push("too_short");
	if (blockedHint) lowQualityReasons.push("blocked_page_hint");
	if (density > 0.65) lowQualityReasons.push("high_link_density");
	if (repeated > 0.5) lowQualityReasons.push("repeated_lines");

	const lengthScore = Math.min(1, plainText.length / 2500) * 0.45;
	const structureScore = Math.min(1, structures / 4);
	const structureContribution = structureScore * 0.25;
	const densityPenalty = density > 0.65 ? 0.25 : density > 0.45 ? 0.12 : 0;
	const repeatedPenalty = repeated > 0.5 ? 0.2 : repeated > 0.3 ? 0.1 : 0;
	const blockedPenalty = blockedHint ? 0.35 : 0;
	const score = Math.max(
		0,
		Math.min(
			1,
			0.25 +
				lengthScore +
				structureContribution -
				densityPenalty -
				repeatedPenalty -
				blockedPenalty,
		),
	);

	return {
		score: Math.round(score * 100) / 100,
		contentLength: plainText.length,
		markdownLength: markdown.length,
		linkDensity: Math.round(density * 100) / 100,
		structureScore,
		repeatedLineRatio: Math.round(repeated * 100) / 100,
		blockedHint,
		lowQualityReasons,
	};
}

function shouldUseFallback(
	result: WebResearchExtractedPage | null,
	config: WebResearchExtractionConfig,
): { use: boolean; reason: string | null } {
	if (!config.webResearchCrawl4aiEnabled) return { use: false, reason: null };
	if (!config.webResearchCrawl4aiBaseUrl?.trim())
		return { use: false, reason: null };
	if (!result) return { use: true, reason: "local_extraction_failed" };
	const threshold =
		typeof config.webResearchCrawl4aiMinQualityScore === "number"
			? Math.max(0, Math.min(1, config.webResearchCrawl4aiMinQualityScore))
			: DEFAULT_CRAWL4AI_MIN_QUALITY_SCORE;
	if (result.quality.score < threshold) {
		return { use: true, reason: "low_quality_local_extraction" };
	}
	if (result.quality.blockedHint)
		return { use: true, reason: "blocked_page_hint" };
	return { use: false, reason: null };
}

async function fetchCrawl4aiMarkdown(params: {
	url: string;
	config: WebResearchExtractionConfig;
	fetch: typeof fetch;
	signal?: AbortSignal;
}): Promise<string | null> {
	const baseUrl = params.config.webResearchCrawl4aiBaseUrl?.trim();
	if (!baseUrl) return null;
	const endpoint = `${baseUrl.replace(/\/+$/, "")}/md`;
	const response = await params.fetch(endpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ url: params.url }),
		signal: combineAbortSignals(
			params.signal,
			AbortSignal.timeout(
				timeoutMs(
					params.config.webResearchCrawl4aiTimeoutMs,
					DEFAULT_CRAWL4AI_TIMEOUT_MS,
				),
			),
		),
	});
	if (!response.ok) return null;
	const payload = (await response.json().catch(() => null)) as unknown;
	if (payload && typeof payload === "object" && "markdown" in payload) {
		const markdown = (payload as { markdown?: unknown }).markdown;
		return typeof markdown === "string" && markdown.trim() ? markdown : null;
	}
	return null;
}

async function hasSafeDnsResolution(value: string): Promise<boolean> {
	try {
		const hostname = normalizeUrlHostname(new URL(value).hostname);
		const ipVersion = isIP(hostname);
		if (ipVersion === 4) return !isBlockedIpv4Address(hostname);
		if (ipVersion === 6) return !isBlockedIpv6Address(hostname);
		const addresses = await lookup(hostname, { all: true, verbatim: true });
		if (addresses.length === 0) return false;
		return addresses.every((entry) => {
			if (entry.family === 4) return !isBlockedIpv4Address(entry.address);
			if (entry.family === 6) return !isBlockedIpv6Address(entry.address);
			return false;
		});
	} catch {
		return false;
	}
}

function redirectLocation(
	response: Response,
	currentUrl: string,
): string | null {
	if (response.status < 300 || response.status >= 400) return null;
	const location = response.headers.get("location");
	if (!location) return null;
	try {
		return new URL(location, currentUrl).toString();
	} catch {
		return null;
	}
}

async function fetchSafeSource(params: {
	url: string;
	fetch: typeof fetch;
	init: RequestInit;
	useDnsPreflight: boolean;
}): Promise<{
	response: Response | null;
	url: string;
	errorCode: string | null;
}> {
	let currentUrl = params.url;
	for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
		if (!isSafeWebResearchFetchUrl(currentUrl)) {
			return { response: null, url: currentUrl, errorCode: "unsafe_url" };
		}
		if (params.useDnsPreflight && !(await hasSafeDnsResolution(currentUrl))) {
			return { response: null, url: currentUrl, errorCode: "unsafe_dns" };
		}
		const response = await params.fetch(currentUrl, {
			...params.init,
			redirect: "manual",
		});
		const nextUrl = redirectLocation(response, currentUrl);
		if (!nextUrl) return { response, url: currentUrl, errorCode: null };
		if (!isSafeWebResearchFetchUrl(nextUrl)) {
			return { response: null, url: nextUrl, errorCode: "unsafe_redirect" };
		}
		currentUrl = nextUrl;
	}
	return { response: null, url: currentUrl, errorCode: "too_many_redirects" };
}

function fallbackMarkdownIsUsable(markdown: string): boolean {
	const plainText = markdownToPlainText(markdown);
	if (!plainText) return false;
	if (BLOCKED_PAGE_RE.test(plainText)) return false;
	if (GENERATED_FALLBACK_RE.test(plainText)) return false;
	return true;
}

function buildResult(params: {
	title: string | null;
	markdown: string;
	plainText: string;
	excerpt: string | null;
	metadata: WebResearchExtractedPage["metadata"];
	diagnostics: WebResearchExtractionDiagnostics;
}): WebResearchExtractedPage {
	const markdown = normalizeMarkdown(params.markdown).slice(
		0,
		MAX_MARKDOWN_CHARS,
	);
	const plainText = normalizeWhitespace(params.plainText);
	return {
		title: params.title,
		markdown,
		plainText,
		excerpt: params.excerpt,
		metadata: params.metadata,
		quality: scoreQuality(markdown, plainText),
		diagnostics: params.diagnostics,
	};
}

function recordResult(
	result: WebResearchExtractedPage | null,
	latencyMs: number,
): void {
	metrics.totalLatencyMs += latencyMs;
	if (!result) {
		metrics.failedCount += 1;
		return;
	}
	metrics.succeededCount += 1;
	if (result.quality.lowQualityReasons.length > 0) metrics.lowQualityCount += 1;
	if (result.diagnostics.fallbackUsed) metrics.crawl4aiFallbackCount += 1;
}

export function getWebResearchExtractionMetrics(): WebResearchExtractionMetrics {
	return { ...metrics };
}

export function resetWebResearchExtractionForTests(): void {
	cache.clear();
	metrics.attemptedCount = 0;
	metrics.succeededCount = 0;
	metrics.cacheHitCount = 0;
	metrics.crawl4aiFallbackCount = 0;
	metrics.lowQualityCount = 0;
	metrics.blockedCount = 0;
	metrics.failedCount = 0;
	metrics.totalLatencyMs = 0;
	metrics.lastErrorCode = null;
}

export async function extractWebResearchPage(params: {
	url: string;
	config: WebResearchExtractionConfig;
	fetch?: typeof fetch;
	signal?: AbortSignal;
	fallbackBudget?: WebResearchFallbackBudget;
	now?: number;
}): Promise<WebResearchExtractedPage | null> {
	const startedAt = Date.now();
	const now = params.now ?? startedAt;
	const fetchImpl = params.fetch ?? fetch;
	const mode = extractionMode(params.config);
	metrics.attemptedCount += 1;

	if (!isSafeWebResearchFetchUrl(params.url)) {
		metrics.blockedCount += 1;
		metrics.lastErrorCode = "unsafe_url";
		return null;
	}

	const cached = readCache(params.url, params.config, now);
	if (cached) {
		const latencyMs = Date.now() - startedAt;
		cached.diagnostics.latencyMs = latencyMs;
		recordResult(cached, latencyMs);
		return cached;
	}

	let localResult: WebResearchExtractedPage | null = null;
	let localError: string | null = null;
	try {
		const fetched = await fetchSafeSource({
			url: params.url,
			fetch: fetchImpl,
			useDnsPreflight: fetchImpl === fetch,
			init: {
				method: "GET",
				headers: {
					Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
				},
				signal: combineAbortSignals(
					params.signal,
					AbortSignal.timeout(
						timeoutMs(
							params.config.webResearchExtractTimeoutMs,
							DEFAULT_EXTRACT_TIMEOUT_MS,
						),
					),
				),
			},
		});
		if (fetched.errorCode) {
			metrics.blockedCount += 1;
			metrics.lastErrorCode = fetched.errorCode;
			return null;
		}
		const response = fetched.response;
		const responseUrl = response?.url || fetched.url;
		if (!response) {
			localError = "fetch_failed";
		} else if (!isSafeWebResearchFetchUrl(responseUrl)) {
			metrics.blockedCount += 1;
			metrics.lastErrorCode = "unsafe_redirect";
			return null;
		} else if (!response.ok) {
			localError = "http_status";
		} else {
			const contentType = response.headers.get("content-type") ?? "";
			if (
				contentType &&
				!HTML_CONTENT_TYPE_RE.test(contentType) &&
				!TEXT_CONTENT_TYPE_RE.test(contentType)
			) {
				localError = "unsupported_content_type";
			} else {
				const rawText = await response.text();
				const htmlLike =
					!contentType ||
					HTML_CONTENT_TYPE_RE.test(contentType) ||
					/<html|<body|<article|<p[\s>]/i.test(rawText);
				let extractor: WebResearchExtractionDiagnostics["extractor"] = "basic";
				let extracted: {
					title: string | null;
					markdown: string;
					plainText: string;
					excerpt: string | null;
					metadata: WebResearchExtractedPage["metadata"];
				} | null;
				if (htmlLike && mode !== "basic") {
					extracted = extractWithReadability(rawText, responseUrl);
					if (extracted) {
						extractor = "readability";
					} else if (mode === "readability" || mode === "auto") {
						extracted = extractBasic(rawText, responseUrl, htmlLike);
					} else {
						extracted = null;
					}
				} else {
					extracted = extractBasic(rawText, responseUrl, htmlLike);
				}
				if (extracted) {
					localResult = buildResult({
						...extracted,
						diagnostics: {
							extractor,
							mode,
							latencyMs: Date.now() - startedAt,
							contentType: contentType || null,
							status: response.status,
							cacheHit: false,
							fallbackUsed: false,
							fallbackReason: null,
							errorCode: null,
						},
					});
				} else {
					localError = "empty_extraction";
				}
			}
		}
	} catch (error) {
		localError =
			error instanceof Error && error.name === "TimeoutError"
				? "timeout"
				: "fetch_failed";
	}

	const fallbackDecision = shouldUseFallback(localResult, params.config);
	let result = localResult;
	if (fallbackDecision.use && (params.fallbackBudget?.remaining ?? 0) > 0) {
		if (params.fallbackBudget) params.fallbackBudget.remaining -= 1;
		try {
			const fallbackMarkdown = await fetchCrawl4aiMarkdown({
				url: params.url,
				config: params.config,
				fetch: fetchImpl,
				signal: params.signal,
			});
			if (fallbackMarkdown && fallbackMarkdownIsUsable(fallbackMarkdown)) {
				const markdown = normalizeMarkdown(fallbackMarkdown);
				result = buildResult({
					title: localResult?.title ?? null,
					markdown,
					plainText: markdownToPlainText(markdown),
					excerpt: markdownToPlainText(markdown).slice(0, 280),
					metadata: localResult?.metadata ?? {
						siteName: hostLabel(params.url),
					},
					diagnostics: {
						extractor: "crawl4ai",
						mode,
						latencyMs: Date.now() - startedAt,
						contentType: localResult?.diagnostics.contentType ?? null,
						status: localResult?.diagnostics.status ?? null,
						cacheHit: false,
						fallbackUsed: true,
						fallbackReason: fallbackDecision.reason,
						errorCode: null,
					},
				});
			}
		} catch {
			if (!result) localError = "crawl4ai_failed";
		}
	}

	const latencyMs = Date.now() - startedAt;
	if (result) {
		result.diagnostics.latencyMs = latencyMs;
		if (
			!(
				params.config.webResearchCrawl4aiEnabled &&
				fallbackDecision.use &&
				result === localResult
			)
		) {
			writeCache(params.url, params.config, now, result);
		}
	} else if (localError) {
		metrics.lastErrorCode = localError;
	}
	recordResult(result, latencyMs);
	return result;
}
