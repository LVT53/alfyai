import {
	extractWebResearchPage,
	type WebResearchExtractionConfig,
} from "$lib/server/services/web-research/extraction";
import {
	DEFAULT_ATLAS_IMAGE_SEARCH_SAFESEARCH,
	DEFAULT_ATLAS_SEARCH_CONCURRENCY,
	DEFAULT_ATLAS_SEARCH_INITIAL_RETRY_BACKOFF_MS,
	DEFAULT_ATLAS_SEARCH_INTER_BATCH_DELAY_MS,
	DEFAULT_ATLAS_SEARCH_MAX_ATTEMPTS,
	DEFAULT_ATLAS_SEARCH_MAX_RETRY_BACKOFF_MS,
} from "./config";
import { isUsableAtlasImageCandidate } from "./image-quality";
import type { AtlasImageCandidate } from "./types";

export interface AtlasSearchSource {
	id: string;
	title: string;
	url: string;
	snippet: string | null;
}

export interface RejectedAtlasSearchSource extends AtlasSearchSource {
	rejectionReason: "unsafe_adult_content" | "duplicate_url" | "source_cap";
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
	searxngBaseUrl: string;
	concurrency?: number;
	interBatchDelayMs?: number;
	maxAcceptedSources?: number;
	maxImageCandidates?: number;
	initialRetryBackoffMs?: number;
	maxRetryBackoffMs?: number;
	maxAttempts?: number;
	webResearchExtractorMode?: WebResearchExtractionConfig["webResearchExtractorMode"];
	webResearchExtractTimeoutMs?: number;
	webResearchExtractCacheTtlHours?: number;
}

export interface RunAtlasSearchStageInput {
	queries: string[];
	config: AtlasSearchConfig;
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
		| "searxngBaseUrl"
		| "concurrency"
		| "interBatchDelayMs"
		| "maxImageCandidates"
		| "initialRetryBackoffMs"
		| "maxRetryBackoffMs"
		| "maxAttempts"
	>;
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

function normalizeBaseUrl(value: string): string {
	return value.trim().replace(/\/+$/, "");
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
 * Strips known SearXNG artifacts and boilerplate from a search result snippet.
 *
 * Removes in order:
 * 1. SearXNG UI metadata keywords at start (Naptár, Keresés, Beállítások)
 * 2. Hungarian language filter echoes (Nem tartalmazza: ... | Tartalmaznia kell: ... |)
 * 3. English language filter echoes (Excluding: ... | Must include: ... |)
 * 4. YouTube channel prefix (YouTube ·)
 * 5. Hungarian date prefixes (2024. jan. 26. ·, 2024. január 26. ·)
 *
 * After each pass the result is trimmed. Returns empty string when the entire
 * snippet is consumed by artifacts.
 */
export function sanitizeSearchSnippet(snippet: string): string {
	let result = snippet.trim();
	if (!result) return result;

	// SearXNG UI metadata keywords at snippet start
	result = result.replace(/^(Naptár|Keresés|Beállítások)\s*·\s*/, "");

	// Hungarian language filter echo (both conditions: Nem tartalmazza + Tartalmaznia kell)
	result = result.replace(
		/^Nem tartalmazza:[^|]+\|\s*Tartalmaznia kell:[^|]+\|\s*/i,
		"",
	);
	// Hungarian single-condition fallbacks
	result = result.replace(/^Nem tartalmazza:[^|]+\|\s*/i, "");
	result = result.replace(/^Tartalmaznia kell:[^|]+\|\s*/i, "");

	// English language filter echo (both conditions)
	result = result.replace(/^Excluding:[^|]+\|\s*Must include:[^|]+\|\s*/i, "");
	// English single-condition fallbacks
	result = result.replace(/^Excluding:[^|]+\|\s*/i, "");
	result = result.replace(/^Must include:[^|]+\|\s*/i, "");

	// YouTube channel prefix
	result = result.replace(/^YouTube ·\s*/, "");

	// Hungarian date prefixes
	result = result.replace(
		/^\d{4}\. (?:jan\.|febr\.|márc\.|ápr\.|máj\.|jún\.|júl\.|aug\.|szept\.|okt\.|nov\.|dec\.|január|február|március|április|május|június|július|augusztus|szeptember|október|november|december) \d{1,2}\. ·\s*/,
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

async function defaultFetchPageContent(
	source: AtlasSearchSource,
	config: AtlasSearchConfig,
): Promise<AtlasSearchSource> {
	const extracted = await extractWebResearchPage({
		url: source.url,
		config: {
			webResearchExtractorMode: config.webResearchExtractorMode,
			webResearchExtractTimeoutMs: config.webResearchExtractTimeoutMs,
			webResearchExtractCacheTtlHours: config.webResearchExtractCacheTtlHours,
		},
	});
	if (!extracted) return source;
	return fetchedSnippet({
		source,
		title: extracted.title,
		text: extracted.plainText,
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

function normalizeSearxngResult(
	query: string,
	result: unknown,
	index: number,
): AtlasSearchSource | null {
	if (!result || typeof result !== "object" || Array.isArray(result)) {
		return null;
	}
	const record = result as Record<string, unknown>;
	const url = typeof record.url === "string" ? record.url.trim() : "";
	if (!url) return null;
	const title =
		typeof record.title === "string" && record.title.trim()
			? record.title.trim()
			: url;
	const rawSnippet =
		typeof record.content === "string"
			? record.content.trim()
			: typeof record.snippet === "string"
				? record.snippet.trim()
				: null;
	let snippet: string | null = rawSnippet;
	if (snippet) {
		const sanitized = sanitizeSearchSnippet(snippet);
		snippet = sanitized.length > 0 ? sanitized : title;
	}
	return {
		id: `web:${query}:${index}`,
		title,
		url,
		snippet: snippet || null,
	};
}

async function searchSearxng(
	baseUrl: string,
	query: string,
): Promise<AtlasSearchSource[]> {
	const url = new URL(`${normalizeBaseUrl(baseUrl)}/search`);
	url.searchParams.set("q", query);
	url.searchParams.set("format", "json");
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`SearXNG search failed with HTTP ${response.status}`);
	}
	const body = (await response.json()) as unknown;
	const results =
		body &&
		typeof body === "object" &&
		Array.isArray((body as { results?: unknown }).results)
			? (body as { results: unknown[] }).results
			: [];
	return results
		.map((result, index) => normalizeSearxngResult(query, result, index))
		.filter((source): source is AtlasSearchSource => source !== null);
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

function parseResolution(value: unknown): {
	width: number | null;
	height: number | null;
} {
	if (typeof value !== "string") return { width: null, height: null };
	const match = value.match(/(\d{2,6})\s*[x×]\s*(\d{2,6})/i);
	if (!match) return { width: null, height: null };
	const width = Number(match[1]);
	const height = Number(match[2]);
	return {
		width: Number.isFinite(width) ? width : null,
		height: Number.isFinite(height) ? height : null,
	};
}

function normalizeSearxngImageResult(
	query: string,
	result: unknown,
	index: number,
): AtlasImageCandidate | null {
	if (!result || typeof result !== "object" || Array.isArray(result)) {
		return null;
	}
	const record = result as Record<string, unknown>;
	const imageUrl =
		httpsUrl(record.img_src) ??
		httpsUrl(record.thumbnail_src) ??
		httpsUrl(record.thumbnail);
	if (!imageUrl) return null;
	const sourcePageUrl = httpsUrl(record.url);
	const title =
		cleanOptionalText(record.title) ??
		cleanOptionalText(record.content) ??
		sourcePageUrl ??
		imageUrl;
	const sourceTitle =
		cleanOptionalText(record.source) ??
		cleanOptionalText(record.engine) ??
		(sourcePageUrl ? new URL(sourcePageUrl).hostname : null);
	const { width, height } = parseResolution(record.resolution);
	const caption = cleanOptionalText(record.content) ?? title;
	return {
		id: `image:${query}:${index}`,
		query,
		title,
		imageUrl,
		sourcePageUrl,
		sourceTitle,
		thumbnailUrl: httpsUrl(record.thumbnail_src) ?? httpsUrl(record.thumbnail),
		width,
		height,
		caption,
		selectionReason: `Image result for "${query}" from SearXNG.`,
	};
}

function convergeImageCandidates(input: {
	imageCandidates: AtlasImageCandidate[];
	maxAccepted: number;
}): AtlasImageCandidate[] {
	const accepted: AtlasImageCandidate[] = [];
	const seenUrls = new Set<string>();

	for (const candidate of input.imageCandidates) {
		if (isUnsafeAdultImageCandidate(candidate)) continue;
		if (!isUsableAtlasImageCandidate(candidate)) continue;
		const key = normalizedSourceUrlKey(candidate.imageUrl);
		if (seenUrls.has(key)) continue;
		seenUrls.add(key);
		if (accepted.length >= input.maxAccepted) break;
		accepted.push(candidate);
	}

	return accepted;
}

async function searchSearxngImages(
	baseUrl: string,
	query: string,
): Promise<AtlasImageCandidate[]> {
	const url = new URL(`${normalizeBaseUrl(baseUrl)}/search`);
	url.searchParams.set("q", query);
	url.searchParams.set("format", "json");
	url.searchParams.set("categories", "images");
	url.searchParams.set(
		"safesearch",
		String(DEFAULT_ATLAS_IMAGE_SEARCH_SAFESEARCH),
	);
	url.searchParams.set("image_proxy", "0");
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`SearXNG image search failed with HTTP ${response.status}`);
	}
	const body = (await response.json()) as unknown;
	const results =
		body &&
		typeof body === "object" &&
		Array.isArray((body as { results?: unknown }).results)
			? (body as { results: unknown[] }).results
			: [];
	return results
		.map((result, index) => normalizeSearxngImageResult(query, result, index))
		.filter((source): source is AtlasImageCandidate => source !== null);
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
	const baseUrl = normalizeBaseUrl(input.config.searxngBaseUrl);
	if (!baseUrl) {
		return {
			sources: [],
			rejectedSources: [],
			limitation: {
				code: "atlas_searxng_required",
				message: "Atlas web search requires SearXNG to be configured.",
			},
		};
	}

	const queries = uniqueQueries(input.queries);
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
	const search = input.search ?? ((query) => searchSearxng(baseUrl, query));
	const fetchPage =
		input.fetchPage ??
		(input.search
			? null
			: (source: AtlasSearchSource) =>
					defaultFetchPageContent(source, input.config));
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
	const baseUrl = normalizeBaseUrl(input.config.searxngBaseUrl);
	if (!baseUrl) {
		return {
			imageCandidates: [],
			imageLimitation: {
				code: "atlas_image_search_unavailable",
				message: "Atlas image search requires SearXNG to be configured.",
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
	const searchImages =
		input.searchImages ?? ((query) => searchSearxngImages(baseUrl, query));
	const imageCandidates: AtlasImageCandidate[] = [];
	const failedQueries: string[] = [];
	const maxImageCandidates = Math.max(0, input.config.maxImageCandidates ?? 3);
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
