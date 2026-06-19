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
}

export interface RunAtlasSearchStageInput {
	queries: string[];
	config: AtlasSearchConfig;
	search?: (query: string) => Promise<AtlasSearchSource[]>;
	sleep?: (ms: number) => Promise<void>;
}

export interface AtlasSearchStageResult {
	sources: AtlasSearchSource[];
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
	const sources: AtlasSearchSource[] = [];

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
			return {
				sources,
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

	return { sources, limitation: null };
}
