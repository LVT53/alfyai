import {
	extractWebResearchPage,
	type WebResearchExtractionConfig,
} from "$lib/server/services/web-research/extraction";
import {
	DEFAULT_ATLAS_SEARCH_CONCURRENCY,
	DEFAULT_ATLAS_SEARCH_INITIAL_RETRY_BACKOFF_MS,
	DEFAULT_ATLAS_SEARCH_INTER_BATCH_DELAY_MS,
	DEFAULT_ATLAS_SEARCH_MAX_ATTEMPTS,
	DEFAULT_ATLAS_SEARCH_MAX_RETRY_BACKOFF_MS,
} from "./config";

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

export interface AtlasSearchConfig {
	searxngBaseUrl: string;
	concurrency?: number;
	interBatchDelayMs?: number;
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

function fetchedSnippet(input: {
	source: AtlasSearchSource;
	title: string | null;
	text: string;
}): AtlasSearchSource {
	const excerpt = input.text.replace(/\s+/g, " ").trim().slice(0, 3_500);
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
	const snippet =
		typeof record.content === "string"
			? record.content.trim()
			: typeof record.snippet === "string"
				? record.snippet.trim()
				: null;
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

async function runWithRetries(
	query: string,
	search: (query: string) => Promise<AtlasSearchSource[]>,
	input: {
		maxAttempts: number;
		initialRetryBackoffMs: number;
		maxRetryBackoffMs: number;
		sleep: (ms: number) => Promise<void>;
	},
): Promise<AtlasSearchSource[]> {
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
	const maxAcceptedSources = 18;

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
