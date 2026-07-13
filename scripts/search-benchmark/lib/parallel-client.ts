// Minimal client for the Parallel Search API (throwaway benchmark harness).
// Contract confirmed live: POST /v1/search, header x-api-key,
// body {objective, search_queries, mode}; modes turbo|basic|advanced.

export type ParallelMode = "turbo" | "basic" | "advanced";

export type ParallelResult = {
	url: string;
	title: string;
	publish_date: string | null;
	excerpts: string[];
};

export type ParallelResponse = {
	search_id?: string;
	results: ParallelResult[];
	session_id?: string;
};

export type ParallelCall = {
	ok: boolean;
	status: number;
	latencyMs: number;
	results: ParallelResult[];
	error?: string;
	searchId?: string;
};

const ENDPOINT = "https://api.parallel.ai/v1/search";
const EXTRACT_ENDPOINT = "https://api.parallel.ai/v1/extract";

export type ParallelExtractResult = {
	url: string;
	title: string;
	publish_date: string | null;
	excerpts: string[];
	full_content: string | null;
};

export type ParallelExtractCall = {
	ok: boolean;
	status: number;
	latencyMs: number;
	results: ParallelExtractResult[];
	error?: string;
};

// Extract API: takes URLs, returns cleaned excerpts (or full content) per page.
// This is the candidate replacement for our extraction.ts page-fetch layer.
export async function extractParallel(params: {
	urls: string[];
	objective: string;
	searchQueries?: string[];
	apiKey: string;
	fullContent?: boolean;
	signal?: AbortSignal;
}): Promise<ParallelExtractCall> {
	const started = Date.now();
	try {
		const res = await fetch(EXTRACT_ENDPOINT, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": params.apiKey,
			},
			body: JSON.stringify({
				urls: params.urls.slice(0, 20),
				objective: params.objective.slice(0, 5000),
				...(params.searchQueries?.length
					? { search_queries: params.searchQueries.map((q) => q.slice(0, 200)).slice(0, 5) }
					: {}),
				...(params.fullContent
					? { advanced_settings: { full_content: true } }
					: {}),
			}),
			signal: params.signal,
		});
		const latencyMs = Date.now() - started;
		const text = await res.text();
		if (!res.ok) {
			return { ok: false, status: res.status, latencyMs, results: [], error: text.slice(0, 500) };
		}
		const body = JSON.parse(text);
		return {
			ok: true,
			status: res.status,
			latencyMs,
			results: Array.isArray(body.results) ? body.results : [],
		};
	} catch (error) {
		return {
			ok: false,
			status: 0,
			latencyMs: Date.now() - started,
			results: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function searchParallel(params: {
	objective: string;
	searchQueries: string[];
	mode: ParallelMode;
	apiKey: string;
	signal?: AbortSignal;
}): Promise<ParallelCall> {
	const started = Date.now();
	try {
		const res = await fetch(ENDPOINT, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": params.apiKey,
			},
			body: JSON.stringify({
				objective: params.objective.slice(0, 2000),
				// Parallel wants 2-3 keyword queries, max 5, <=200 chars each.
				search_queries: params.searchQueries
					.map((q) => q.slice(0, 200))
					.slice(0, 5),
				mode: params.mode,
			}),
			signal: params.signal,
		});
		const latencyMs = Date.now() - started;
		const text = await res.text();
		if (!res.ok) {
			return {
				ok: false,
				status: res.status,
				latencyMs,
				results: [],
				error: text.slice(0, 500),
			};
		}
		const body = JSON.parse(text) as ParallelResponse;
		return {
			ok: true,
			status: res.status,
			latencyMs,
			results: Array.isArray(body.results) ? body.results : [],
			searchId: body.search_id,
		};
	} catch (error) {
		return {
			ok: false,
			status: 0,
			latencyMs: Date.now() - started,
			results: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
