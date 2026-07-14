import { getConfig } from "$lib/server/config-store";
import {
	parallelExtract,
	parallelSearch,
} from "$lib/server/services/parallel-search/client";
import {
	DEFAULT_ATLAS_IMAGE_SEARCH_SAFESEARCH,
	DEFAULT_ATLAS_SEARCH_CONCURRENCY,
	DEFAULT_ATLAS_SEARCH_INITIAL_RETRY_BACKOFF_MS,
	DEFAULT_ATLAS_SEARCH_INTER_BATCH_DELAY_MS,
	DEFAULT_ATLAS_SEARCH_MAX_ATTEMPTS,
	DEFAULT_ATLAS_SEARCH_MAX_RETRY_BACKOFF_MS,
} from "./config";
import { isUsableAtlasImageCandidate } from "./image-quality";
import { sanitizeSourceTitle } from "./source-title";
import type { AtlasImageCandidate } from "./types";

export interface AtlasSearchSource {
	id: string;
	title: string;
	url: string;
	snippet: string | null;
}

export interface RejectedAtlasSearchSource extends AtlasSearchSource {
	rejectionReason:
		| "unsafe_adult_content"
		| "duplicate_url"
		| "source_cap"
		| "unusable_snippet";
}

export interface AtlasSearchLimitation {
	code: string;
	message: string;
	failedQueries?: string[];
}

export interface AtlasImageSearchLimitation {
	code: string;
	message: string;
	failedQueries?: string[];
}

export interface AtlasSearchConfig {
	parallelApiKey?: string;
	parallelBaseUrl?: string;
	// Brave Search API key backing the image-search stage.
	braveSearchApiKey?: string;
	concurrency?: number;
	interBatchDelayMs?: number;
	maxAcceptedSources?: number;
	maxImageCandidates?: number;
	initialRetryBackoffMs?: number;
	maxRetryBackoffMs?: number;
	maxAttempts?: number;
}

export interface AtlasSearchDeps {
	fetch?: typeof fetch;
	signal?: AbortSignal;
}

export interface AtlasImageSearchDeps {
	fetch?: typeof fetch;
	signal?: AbortSignal;
}

export interface RunAtlasSearchStageInput {
	queries: string[];
	config: AtlasSearchConfig;
	deps?: AtlasSearchDeps;
	search?: (query: string) => Promise<AtlasSearchSource[]>;
	fetchPage?: (source: AtlasSearchSource) => Promise<AtlasSearchSource>;
	sleep?: (ms: number) => Promise<void>;
}

export interface AtlasSearchStageResult {
	sources: AtlasSearchSource[];
	rejectedSources: RejectedAtlasSearchSource[];
	limitation: AtlasSearchLimitation | null;
}

export interface RunAtlasImageSearchStageInput {
	queries: string[];
	config: Pick<
		AtlasSearchConfig,
		| "braveSearchApiKey"
		| "concurrency"
		| "interBatchDelayMs"
		| "maxImageCandidates"
		| "initialRetryBackoffMs"
		| "maxRetryBackoffMs"
		| "maxAttempts"
	>;
	deps?: AtlasImageSearchDeps;
	timeRange?: string | null;
	searchImages?: (query: string) => Promise<AtlasImageCandidate[]>;
	sleep?: (ms: number) => Promise<void>;
}

export interface AtlasImageSearchStageResult {
	imageCandidates: AtlasImageCandidate[];
	imageLimitation: AtlasImageSearchLimitation | null;
}

function uniqueQueries(queries: string[]): string[] {
	return Array.from(
		new Set(queries.map((query) => query.trim()).filter(Boolean)),
	);
}

async function defaultSleep(ms: number): Promise<void> {
	if (ms <= 0) return;
	await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function normalizedSourceUrlKey(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.hash = "";
		parsed.searchParams.sort();
		const normalized = parsed.toString().replace(/\/+$/, "");
		return normalized.toLowerCase();
	} catch {
		return url.trim().replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();
	}
}

function isUnsafeAdultSource(source: AtlasSearchSource): boolean {
	const haystack = [source.title, source.url, source.snippet ?? ""]
		.join(" ")
		.toLowerCase();
	return isUnsafeAdultText(haystack);
}

function isUnsafeAdultImageCandidate(candidate: AtlasImageCandidate): boolean {
	const haystack = [
		candidate.title,
		candidate.imageUrl,
		candidate.sourcePageUrl ?? "",
		candidate.sourceTitle ?? "",
		candidate.caption,
		candidate.selectionReason,
	]
		.join(" ")
		.toLowerCase();
	return isUnsafeAdultText(haystack);
}

function isUnsafeAdultText(haystack: string): boolean {
	return /(^|[^a-z0-9])(porn|porno|xxx|xvideos|xnxx|pornhub|redtube|onlyfans|adult\s+video|escort|nsfw|nude\s+girls?|camgirl|sex\s+video)([^a-z0-9]|$)/i.test(
		haystack,
	);
}

/**
 * Returns `true` when the title is substantive enough to compensate for a
 * short search-result snippet.  Rejects bare URLs, login/auth pages, and
 * titles too short to convey meaningful content.
 */
export function hasSubstantiveAtlasSourceTitle(title: string): boolean {
	const trimmed = title.trim();
	if (!trimmed) return false;
	if (trimmed.length < 10) return false;
	// Bare URLs (no spaces, looks like a domain)
	if (/^https?:\/\//i.test(trimmed)) return false;
	if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(trimmed) && !/\s/.test(trimmed))
		return false;
	// Login / auth / registration pages
	if (
		/^(log\s*in|sign\s*in|sign\s*up|register|login|signin|signup|bejelentkezés|regisztráció)$/i.test(
			trimmed,
		)
	)
		return false;
	return true;
}

/**
 * Rejects sources whose snippet is empty after page-hygiene sanitization or
 * too short to produce usable evidence.  These sources would fill acceptance
 * slots without contributing to Evidence Packs.
 *
 * When an optional `title` is provided and the only rejection reason is a
 * short (< 8 char) sanitized snippet, a substantive title can override the
 * rejection so the source is accepted for evidence extraction.
 *
 * Sources whose title is a login, sign-in, sign-up, or registration page
 * are always rejected, regardless of snippet quality, so they never consume
 * acceptance slots.
 */
export function isUnusableAtlasSnippet(
	snippet: string | null,
	title?: string,
): boolean {
	// Login / auth / registration page titles are never usable as sources
	if (
		title &&
		/^(log\s*in|sign\s*in|sign\s*up|register|login|signin|signup|bejelentkezés|regisztráció)$/i.test(
			title.trim(),
		)
	) {
		return true;
	}

	if (!snippet) return false;
	const sanitized = sanitizeSearchSnippet(snippet);
	if (!sanitized) return true;

	if (sanitized.length < 8) {
		// Title exemption: a substantive title can compensate for a short snippet
		if (title && hasSubstantiveAtlasSourceTitle(title)) return false;
		return true;
	}

	return false;
}

function convergeSources(input: {
	sources: AtlasSearchSource[];
	maxAccepted: number;
}): {
	sources: AtlasSearchSource[];
	rejectedSources: RejectedAtlasSearchSource[];
} {
	const accepted: AtlasSearchSource[] = [];
	const rejectedSources: RejectedAtlasSearchSource[] = [];
	const seenUrls = new Set<string>();

	for (const source of input.sources) {
		if (isUnsafeAdultSource(source)) {
			rejectedSources.push({
				...source,
				rejectionReason: "unsafe_adult_content",
			});
			continue;
		}

		const key = normalizedSourceUrlKey(source.url);
		if (seenUrls.has(key)) {
			rejectedSources.push({ ...source, rejectionReason: "duplicate_url" });
			continue;
		}

		if (isUnusableAtlasSnippet(source.snippet, source.title)) {
			rejectedSources.push({ ...source, rejectionReason: "unusable_snippet" });
			continue;
		}

		seenUrls.add(key);

		if (accepted.length >= input.maxAccepted) {
			rejectedSources.push({ ...source, rejectionReason: "source_cap" });
			continue;
		}

		accepted.push(source);
	}

	return { sources: accepted, rejectedSources };
}

/**
 * Strips generic page-hygiene boilerplate that survives in a Parallel excerpt
 * or extract before it reaches evidence extraction.
 *
 * Removes, in order, leading:
 * 1. Loading / "please enable JavaScript" placeholders
 * 2. Cookie-consent banners
 * 3. Login / social-media view prompts (Please log in, View on Instagram, …)
 *
 * After each pass the result is trimmed. Returns empty string when the entire
 * snippet is consumed by boilerplate.
 */
export function sanitizeSearchSnippet(snippet: string): string {
	let result = snippet.trim();
	if (!result) return result;

	// Common boilerplate prefixes that survive snippet extraction
	result = result.replace(
		/^(?:Loading\.\.\.\s*|Please wait\.\.\.\s*|Please enable JavaScript(?:[^.]*\.)?\s*|Enable JavaScript(?:[^.]*\.)?\s*)+/i,
		"",
	);

	// Cookie consent banners
	result = result.replace(
		/^(?:This (?:website|site) uses cookies[^.]*\.\s*|We use cookies[^.]*\.\s*|Accept (?:all\s+)?cookies[^.]*\.\s*|Cookie (?:Settings|Preferences)[^.]*\.\s*)+/i,
		"",
	);

	// SEO / calculator / login placeholder prefixes
	result = result.replace(
		/^(?:Please log in to continue[.!]?\s*|Sign in to continue[.!]?\s*|Log in to (?:read|view)[^.]*\.\s*|View on (?:Instagram|Facebook|Twitter)[.!]?\s*)+/i,
		"",
	);

	return result.trim();
}

function fetchedSnippet(input: {
	source: AtlasSearchSource;
	title: string | null;
	text: string;
}): AtlasSearchSource {
	const excerpt = sanitizeSearchSnippet(input.text)
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 3_500);
	if (!excerpt) return input.source;
	const searchSnippet = input.source.snippet?.trim();
	return {
		...input.source,
		title: input.title?.trim() || input.source.title,
		snippet: [
			searchSnippet ? `Search result snippet: ${searchSnippet}` : null,
			`Fetched page excerpt: ${excerpt}`,
		]
			.filter(Boolean)
			.join("\n\n"),
	};
}

interface ParallelCallDeps {
	fetch: typeof fetch;
	parallelApiKey: string;
	parallelBaseUrl?: string;
	signal?: AbortSignal;
}

async function defaultFetchPageContent(
	source: AtlasSearchSource,
	objective: string,
	deps: ParallelCallDeps,
): Promise<AtlasSearchSource> {
	const [extracted] = await parallelExtract(
		{ urls: [source.url], objective, fullContent: true },
		{
			fetch: deps.fetch,
			config: {
				parallelApiKey: deps.parallelApiKey,
				parallelBaseUrl: deps.parallelBaseUrl,
			},
			signal: deps.signal,
		},
	);
	if (!extracted) return source;
	// Parallel extract returns { title, full_content, excerpts }. Map the full
	// page content (falling back to joined excerpts) into the plain-text field
	// Atlas already consumes for the "Fetched page excerpt" snippet.
	const text =
		extracted.full_content?.trim() ||
		extracted.excerpts
			.map((excerpt) => excerpt.trim())
			.filter(Boolean)
			.join("\n\n");
	if (!text) return source;
	return fetchedSnippet({
		source,
		title: extracted.title,
		text,
	});
}

async function enrichAcceptedSources(input: {
	sources: AtlasSearchSource[];
	fetchPage: (source: AtlasSearchSource) => Promise<AtlasSearchSource>;
	concurrency: number;
}): Promise<AtlasSearchSource[]> {
	const enriched: AtlasSearchSource[] = [];
	for (
		let index = 0;
		index < input.sources.length;
		index += input.concurrency
	) {
		const batch = input.sources.slice(index, index + input.concurrency);
		const settled = await Promise.allSettled(
			batch.map((source) => input.fetchPage(source)),
		);
		for (const [batchIndex, result] of settled.entries()) {
			enriched.push(
				result.status === "fulfilled" ? result.value : batch[batchIndex],
			);
		}
	}
	return enriched;
}

function resolveParallelApiKey(explicit?: string): string {
	return explicit?.trim() || getConfig().parallelApiKey.trim();
}

function resolveParallelBaseUrl(explicit?: string): string {
	return explicit?.trim() || getConfig().parallelBaseUrl;
}

async function searchParallel(
	query: string,
	deps: ParallelCallDeps,
): Promise<AtlasSearchSource[]> {
	const results = await parallelSearch(
		{ objective: query, searchQueries: [query], mode: "turbo" },
		{
			fetch: deps.fetch,
			config: {
				parallelApiKey: deps.parallelApiKey,
				parallelBaseUrl: deps.parallelBaseUrl,
			},
			signal: deps.signal,
		},
	);
	return results
		.map((result, index) => {
			const url = result.url?.trim() ?? "";
			const title = sanitizeSourceTitle(result.title?.trim() || url);
			const rawSnippet = result.excerpts?.[0]?.trim() ?? "";
			const snippet = sanitizeSearchSnippet(rawSnippet) || title;
			return {
				id: `web:${query}:${index}`,
				title,
				url,
				snippet: snippet || null,
			};
		})
		.filter((source) => source.url.length > 0);
}

function cleanOptionalText(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function httpsUrl(value: unknown): string | null {
	const raw = cleanOptionalText(value);
	if (!raw) return null;
	try {
		const parsed = new URL(raw);
		return parsed.protocol === "https:" ? parsed.toString() : null;
	} catch {
		return null;
	}
}

function parseDimension(value: unknown): number | null {
	const numeric =
		typeof value === "number"
			? value
			: typeof value === "string"
				? Number(value)
				: Number.NaN;
	return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function normalizeBraveImageResult(
	query: string,
	result: unknown,
	index: number,
): AtlasImageCandidate | null {
	if (!result || typeof result !== "object" || Array.isArray(result)) {
		return null;
	}
	const record = result as Record<string, unknown>;
	const properties = asRecord(record.properties);
	const thumbnail = asRecord(record.thumbnail);
	const metaUrl = asRecord(record.meta_url);
	const imageUrl =
		httpsUrl(properties.url) ?? httpsUrl(thumbnail.src) ?? httpsUrl(record.url);
	if (!imageUrl) return null;
	const sourcePageUrl = httpsUrl(record.url);
	const title = cleanOptionalText(record.title) ?? sourcePageUrl ?? imageUrl;
	const sourceTitle =
		cleanOptionalText(record.source) ??
		cleanOptionalText(metaUrl.hostname) ??
		(sourcePageUrl ? new URL(sourcePageUrl).hostname : null);
	const width = parseDimension(properties.width);
	const height = parseDimension(properties.height);
	const caption = cleanOptionalText(record.title) ?? title;
	const publishedAt = cleanOptionalText(record.page_fetched);
	return {
		id: `image:${query}:${index}`,
		query,
		title,
		imageUrl,
		sourcePageUrl,
		sourceTitle,
		thumbnailUrl: httpsUrl(thumbnail.src) ?? httpsUrl(properties.url),
		width,
		height,
		caption,
		selectionReason: `Image result for "${query}" from Brave image search.`,
		publishedAt,
	};
}

function convergeImageCandidates(input: {
	imageCandidates: AtlasImageCandidate[];
	maxAccepted: number;
	freshnessSensitive?: boolean;
}): AtlasImageCandidate[] {
	const candidates = [...input.imageCandidates];
	if (input.freshnessSensitive) {
		candidates.sort((a, b) => {
			const dateA = a.publishedAt ? Date.parse(a.publishedAt) : 0;
			const dateB = b.publishedAt ? Date.parse(b.publishedAt) : 0;
			if (dateA && dateB && dateA !== dateB) return dateB - dateA;
			if (dateA && !dateB) return -1;
			if (!dateA && dateB) return 1;
			return 0;
		});
	}
	const accepted: AtlasImageCandidate[] = [];
	const seenUrls = new Set<string>();

	for (const candidate of candidates) {
		if (isUnsafeAdultImageCandidate(candidate)) continue;
		if (!isUsableAtlasImageCandidate(candidate, input.freshnessSensitive))
			continue;
		const key = normalizedSourceUrlKey(candidate.imageUrl);
		if (seenUrls.has(key)) continue;
		seenUrls.add(key);
		if (accepted.length >= input.maxAccepted) break;
		accepted.push(candidate);
	}

	return accepted;
}

interface BraveImageCallDeps {
	fetch: typeof fetch;
	braveSearchApiKey: string;
	signal?: AbortSignal;
}

// The Brave image API exposes only "off"/"strict" safesearch; map the numeric
// Atlas default (0 = off, >=1 = on) onto those two levels.
function braveSafesearch(value: number): "off" | "strict" {
	return value >= 1 ? "strict" : "off";
}

async function searchBraveImages(
	query: string,
	deps: BraveImageCallDeps,
): Promise<AtlasImageCandidate[]> {
	const url = new URL("https://api.search.brave.com/res/v1/images/search");
	url.searchParams.set("q", query);
	url.searchParams.set("count", "20");
	url.searchParams.set(
		"safesearch",
		braveSafesearch(DEFAULT_ATLAS_IMAGE_SEARCH_SAFESEARCH),
	);
	const response = await deps.fetch(url.toString(), {
		method: "GET",
		headers: {
			Accept: "application/json",
			"Accept-Encoding": "gzip",
			"X-Subscription-Token": deps.braveSearchApiKey,
		},
		signal: deps.signal,
	});
	if (!response.ok) {
		throw new Error(`Brave image search failed with HTTP ${response.status}`);
	}
	const body = (await response.json()) as unknown;
	const results =
		body &&
		typeof body === "object" &&
		Array.isArray((body as { results?: unknown }).results)
			? (body as { results: unknown[] }).results
			: [];
	return results
		.map((result, index) => normalizeBraveImageResult(query, result, index))
		.filter((source): source is AtlasImageCandidate => source !== null);
}

function resolveBraveSearchApiKey(explicit?: string): string {
	return (
		explicit?.trim() ||
		(getConfig() as { braveSearchApiKey?: string }).braveSearchApiKey?.trim() ||
		process.env.BRAVE_SEARCH_API_KEY?.trim() ||
		""
	);
}

async function runWithRetries<T>(
	query: string,
	search: (query: string) => Promise<T[]>,
	input: {
		maxAttempts: number;
		initialRetryBackoffMs: number;
		maxRetryBackoffMs: number;
		sleep: (ms: number) => Promise<void>;
	},
): Promise<T[]> {
	let nextBackoff = input.initialRetryBackoffMs;
	let lastError: unknown;
	for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
		try {
			return await search(query);
		} catch (error) {
			lastError = error;
			if (attempt === input.maxAttempts) break;
			await input.sleep(nextBackoff);
			nextBackoff = Math.min(
				Math.max(nextBackoff * 2, input.initialRetryBackoffMs),
				input.maxRetryBackoffMs,
			);
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error("Atlas search failed.");
}

export async function runAtlasSearchStage(
	input: RunAtlasSearchStageInput,
): Promise<AtlasSearchStageResult> {
	const parallelApiKey = resolveParallelApiKey(input.config.parallelApiKey);
	const parallelBaseUrl = resolveParallelBaseUrl(input.config.parallelBaseUrl);
	if (!parallelApiKey) {
		return {
			sources: [],
			rejectedSources: [],
			limitation: {
				code: "atlas_parallel_required",
				message:
					"Atlas web search requires the Parallel Search API to be configured.",
			},
		};
	}

	const queries = uniqueQueries(input.queries);
	const fetchImpl = input.deps?.fetch ?? fetch;
	const signal = input.deps?.signal;
	const parallelDeps: ParallelCallDeps = {
		fetch: fetchImpl,
		parallelApiKey,
		parallelBaseUrl,
		signal,
	};
	// Objective threaded into extract: the joined research queries describe what
	// each fetched page is being mined for.
	const extractObjective = queries.join(" | ") || input.queries.join(" ");
	const concurrency = Math.max(
		1,
		input.config.concurrency ?? DEFAULT_ATLAS_SEARCH_CONCURRENCY,
	);
	const interBatchDelayMs =
		input.config.interBatchDelayMs ?? DEFAULT_ATLAS_SEARCH_INTER_BATCH_DELAY_MS;
	const maxAttempts = Math.max(
		1,
		input.config.maxAttempts ?? DEFAULT_ATLAS_SEARCH_MAX_ATTEMPTS,
	);
	const initialRetryBackoffMs =
		input.config.initialRetryBackoffMs ??
		DEFAULT_ATLAS_SEARCH_INITIAL_RETRY_BACKOFF_MS;
	const maxRetryBackoffMs =
		input.config.maxRetryBackoffMs ?? DEFAULT_ATLAS_SEARCH_MAX_RETRY_BACKOFF_MS;
	const sleep = input.sleep ?? defaultSleep;
	const search =
		input.search ?? ((query) => searchParallel(query, parallelDeps));
	const fetchPage =
		input.fetchPage ??
		(input.search
			? null
			: (source: AtlasSearchSource) =>
					defaultFetchPageContent(source, extractObjective, parallelDeps));
	const sources: AtlasSearchSource[] = [];
	const rejectedSources: RejectedAtlasSearchSource[] = [];
	const maxAcceptedSources = Math.max(1, input.config.maxAcceptedSources ?? 18);

	for (let index = 0; index < queries.length; index += concurrency) {
		const batch = queries.slice(index, index + concurrency);
		const settled = await Promise.allSettled(
			batch.map((query) =>
				runWithRetries(query, search, {
					maxAttempts,
					initialRetryBackoffMs,
					maxRetryBackoffMs,
					sleep,
				}),
			),
		);
		const failedQueries = batch.filter(
			(_query, batchIndex) => settled[batchIndex]?.status === "rejected",
		);
		for (const result of settled) {
			if (result.status === "fulfilled") {
				sources.push(...result.value);
			}
		}
		if (failedQueries.length / batch.length > 0.5) {
			const converged = convergeSources({
				sources,
				maxAccepted: maxAcceptedSources,
			});
			return {
				sources: fetchPage
					? await enrichAcceptedSources({
							sources: converged.sources,
							fetchPage,
							concurrency,
						})
					: converged.sources,
				rejectedSources: [...rejectedSources, ...converged.rejectedSources],
				limitation: {
					code: "atlas_search_batch_failure_limit",
					message:
						"Atlas stopped web search because more than half of a search batch failed.",
					failedQueries,
				},
			};
		}
		if (index + concurrency < queries.length) {
			await sleep(interBatchDelayMs);
		}
	}

	const converged = convergeSources({
		sources,
		maxAccepted: maxAcceptedSources,
	});
	return {
		sources: fetchPage
			? await enrichAcceptedSources({
					sources: converged.sources,
					fetchPage,
					concurrency,
				})
			: converged.sources,
		rejectedSources: [...rejectedSources, ...converged.rejectedSources],
		limitation: null,
	};
}

export async function runAtlasImageSearchStage(
	input: RunAtlasImageSearchStageInput,
): Promise<AtlasImageSearchStageResult> {
	const braveSearchApiKey = resolveBraveSearchApiKey(
		input.config.braveSearchApiKey,
	);
	if (!braveSearchApiKey) {
		return {
			imageCandidates: [],
			imageLimitation: {
				code: "atlas_image_search_unavailable",
				message:
					"Atlas image search requires the Brave Search API to be configured.",
			},
		};
	}

	const queries = uniqueQueries(input.queries);
	if (queries.length === 0) {
		return { imageCandidates: [], imageLimitation: null };
	}

	const concurrency = Math.max(
		1,
		input.config.concurrency ?? DEFAULT_ATLAS_SEARCH_CONCURRENCY,
	);
	const interBatchDelayMs =
		input.config.interBatchDelayMs ?? DEFAULT_ATLAS_SEARCH_INTER_BATCH_DELAY_MS;
	const maxAttempts = Math.max(
		1,
		input.config.maxAttempts ?? DEFAULT_ATLAS_SEARCH_MAX_ATTEMPTS,
	);
	const initialRetryBackoffMs =
		input.config.initialRetryBackoffMs ??
		DEFAULT_ATLAS_SEARCH_INITIAL_RETRY_BACKOFF_MS;
	const maxRetryBackoffMs =
		input.config.maxRetryBackoffMs ?? DEFAULT_ATLAS_SEARCH_MAX_RETRY_BACKOFF_MS;
	const sleep = input.sleep ?? defaultSleep;
	const timeRange = input.timeRange ?? null;
	const braveDeps: BraveImageCallDeps = {
		fetch: input.deps?.fetch ?? fetch,
		braveSearchApiKey,
		signal: input.deps?.signal,
	};
	const searchImages =
		input.searchImages ?? ((query) => searchBraveImages(query, braveDeps));
	const imageCandidates: AtlasImageCandidate[] = [];
	const failedQueries: string[] = [];
	const maxImageCandidates = Math.max(0, input.config.maxImageCandidates ?? 3);
	const freshnessSensitive = timeRange != null;
	if (maxImageCandidates === 0) {
		return { imageCandidates: [], imageLimitation: null };
	}

	for (let index = 0; index < queries.length; index += concurrency) {
		const batch = queries.slice(index, index + concurrency);
		const settled = await Promise.allSettled(
			batch.map((query) =>
				runWithRetries(query, searchImages, {
					maxAttempts,
					initialRetryBackoffMs,
					maxRetryBackoffMs,
					sleep,
				}),
			),
		);
		for (const [batchIndex, result] of settled.entries()) {
			if (result.status === "fulfilled") {
				imageCandidates.push(...result.value);
			} else {
				failedQueries.push(batch[batchIndex]);
			}
		}
		if (index + concurrency < queries.length) {
			await sleep(interBatchDelayMs);
		}
	}

	return {
		imageCandidates: convergeImageCandidates({
			imageCandidates,
			maxAccepted: maxImageCandidates,
			freshnessSensitive,
		}),
		imageLimitation:
			failedQueries.length > 0
				? {
						code: "atlas_image_search_partial_failure",
						message:
							"Atlas image search skipped some queries because image search failed.",
						failedQueries,
					}
				: null,
	};
}
