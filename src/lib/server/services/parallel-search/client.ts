// HTTP client for the Parallel Search API (https://api.parallel.ai).
//
// Contract confirmed live:
//   POST /v1/search   header x-api-key
//     body {objective, search_queries, mode} -> {search_id, results, session_id}
//   POST /v1/extract  header x-api-key
//     body {urls, objective, search_queries?, advanced_settings?} -> {extract_id, results, ...}
//
// Dependency-injected (fetch + config) so orchestrators stay testable. This
// module is intentionally decoupled from env.ts / config-store: it takes a
// narrow local config type and never reaches for global state.

export type ParallelMode = "turbo" | "basic" | "advanced";

// Narrow local config: do NOT widen this to import env.ts / config-store.
// parallelBaseUrl is optional and defaults to the production host; it exists so
// tests (and self-hosted deployments) can point the client at a local server.
export type ParallelClientConfig = {
	parallelApiKey: string;
	parallelBaseUrl?: string;
};

export interface ParallelClientDeps {
	fetch: typeof fetch;
	config: ParallelClientConfig;
	signal?: AbortSignal;
}

export interface ParallelSearchResult {
	url: string;
	title: string;
	publish_date: string | null;
	excerpts: string[];
}

export interface ParallelSearchResponse {
	search_id?: string;
	results: ParallelSearchResult[];
	session_id?: string;
}

export interface ParallelSearchRequest {
	objective: string;
	searchQueries: string[];
	mode?: ParallelMode;
	// Groups a related search + follow-up extracts as one logical task so
	// Parallel can use cross-call context (we pass the per-turn id, ctx.turnId).
	sessionId?: string;
	// Upper bound on total excerpt characters across all results.
	maxCharsTotal?: number;
	// Per-result excerpt size (advanced_settings.excerpt_settings).
	excerptMaxChars?: number;
}

export interface ParallelExtractResult {
	url: string;
	title: string;
	publish_date: string | null;
	excerpts: string[];
	full_content: string | null;
}

export interface ParallelExtractResponse {
	extract_id?: string;
	results: ParallelExtractResult[];
	errors?: unknown;
	warnings?: unknown;
	usage?: unknown;
}

// A per-URL Extract failure, normalized from the API's (loosely-typed) `errors`
// field. `url` is the page that failed (null when the API omitted it); `reason`
// is a short human-readable cause (404 / paywall / timeout / …). Surfaced so the
// consuming model can tell the user WHICH url failed and WHY, instead of a bare
// aggregate count.
export interface ParallelExtractUrlError {
	url: string | null;
	reason: string;
}

// Detailed result of an Extract call: the successful page results plus the
// per-URL errors the API reported. `parallelExtract` (below) returns just the
// results for callers that don't need failure detail; `parallelExtractWithErrors`
// exposes both.
export interface ParallelExtractDetailed {
	results: ParallelExtractResult[];
	errors: ParallelExtractUrlError[];
}

export interface ParallelExtractRequest {
	urls: string[];
	objective: string;
	searchQueries?: string[];
	fullContent?: boolean;
	// Prefer Parallel's cached page content up to this age (seconds) instead of a
	// live fetch. Cached retrieval is faster and far less variable than a live
	// fetch, which occasionally spikes to 25-42s; page content rarely needs
	// sub-day freshness. Omit for a live fetch.
	maxAgeSeconds?: number;
	sessionId?: string;
	// Upper bound on total returned characters. Does NOT constrain full_content
	// per the API; used to size returned content to the consuming model.
	maxCharsTotal?: number;
	excerptMaxChars?: number;
}

const DEFAULT_PARALLEL_BASE_URL = "https://api.parallel.ai";

function searchEndpoint(config: ParallelClientConfig): string {
	return `${resolveBaseUrl(config)}/v1/search`;
}

function extractEndpoint(config: ParallelClientConfig): string {
	return `${resolveBaseUrl(config)}/v1/extract`;
}

function resolveBaseUrl(config: ParallelClientConfig): string {
	return (config.parallelBaseUrl || DEFAULT_PARALLEL_BASE_URL).replace(
		/\/+$/,
		"",
	);
}

const MAX_QUERIES = 5;
const MAX_QUERY_CHARS = 200;
const MAX_OBJECTIVE_CHARS = 5000;
const MAX_EXTRACT_URLS = 20;
const ERROR_BODY_CHARS = 500;

function clampQueries(queries: string[]): string[] {
	return queries.map((q) => q.slice(0, MAX_QUERY_CHARS)).slice(0, MAX_QUERIES);
}

async function throwForStatus(res: Response, label: string): Promise<never> {
	const text = await res.text().catch(() => "");
	throw new Error(
		`Parallel ${label} failed: ${res.status} ${res.statusText} ${text.slice(0, ERROR_BODY_CHARS)}`.trim(),
	);
}

export async function parallelSearch(
	req: ParallelSearchRequest,
	deps: ParallelClientDeps,
): Promise<ParallelSearchResult[]> {
	const res = await deps.fetch(searchEndpoint(deps.config), {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-api-key": deps.config.parallelApiKey,
		},
		body: JSON.stringify({
			objective: req.objective.slice(0, MAX_OBJECTIVE_CHARS),
			search_queries: clampQueries(req.searchQueries),
			mode: req.mode ?? "turbo",
			...(req.sessionId ? { session_id: req.sessionId } : {}),
			...(req.maxCharsTotal ? { max_chars_total: req.maxCharsTotal } : {}),
			...(req.excerptMaxChars
				? {
						advanced_settings: {
							excerpt_settings: { max_chars_per_result: req.excerptMaxChars },
						},
					}
				: {}),
		}),
		signal: deps.signal,
	});

	if (!res.ok) {
		return throwForStatus(res, "search");
	}

	const body = (await res.json()) as ParallelSearchResponse;
	return Array.isArray(body.results) ? body.results : [];
}

// Collapse all interior whitespace (newlines, tabs, runs of spaces) into single
// spaces and trim. A provider `reason` can be multi-line; left as-is it fractures
// the markdown bullet list rendered downstream (see buildFailureNote).
function collapseWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

// Defensively normalize the API's `errors` field into ParallelExtractUrlError[].
// The exact shape is not contractually frozen, so we probe several plausible
// keys and never throw on an unexpected shape: an object item yields its `url`
// (when a string) plus the first present of message/reason/error/detail/code as
// the reason; a string item becomes a reason with a null url; anything else is
// skipped. A non-array `errors` (or absent) yields [].
function parseExtractErrors(raw: unknown): ParallelExtractUrlError[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const out: ParallelExtractUrlError[] = [];
	for (const item of raw) {
		if (typeof item === "string") {
			const reason = collapseWhitespace(item);
			if (reason) out.push({ url: null, reason });
			continue;
		}
		if (item && typeof item === "object") {
			const record = item as Record<string, unknown>;
			const url = typeof record.url === "string" ? record.url : null;
			const reasonCandidate =
				record.message ??
				record.reason ??
				record.error ??
				record.detail ??
				record.code;
			const reason =
				typeof reasonCandidate === "string" && collapseWhitespace(reasonCandidate)
					? collapseWhitespace(reasonCandidate)
					: "unknown error";
			out.push({ url, reason });
		}
	}
	return out;
}

// Full Extract call surfacing BOTH the successful results and the per-URL
// errors. Prefer this when the caller wants to tell the user which url failed
// and why (see fetchUrlViaParallel). `parallelExtract` is the results-only
// convenience wrapper for callers that don't need failure detail.
export async function parallelExtractWithErrors(
	req: ParallelExtractRequest,
	deps: ParallelClientDeps,
): Promise<ParallelExtractDetailed> {
	if (req.urls.length < 1) {
		throw new Error("Parallel extract requires at least 1 url");
	}
	if (req.urls.length > MAX_EXTRACT_URLS) {
		throw new Error(
			`Parallel extract accepts at most ${MAX_EXTRACT_URLS} urls (got ${req.urls.length})`,
		);
	}

	const advancedSettings: Record<string, unknown> = {};
	if (req.fullContent) advancedSettings.full_content = true;
	if (req.maxAgeSeconds !== undefined) {
		advancedSettings.fetch_policy = { max_age_seconds: req.maxAgeSeconds };
	}
	if (req.excerptMaxChars !== undefined) {
		advancedSettings.excerpt_settings = {
			max_chars_per_result: req.excerptMaxChars,
		};
	}

	const res = await deps.fetch(extractEndpoint(deps.config), {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-api-key": deps.config.parallelApiKey,
		},
		body: JSON.stringify({
			urls: req.urls,
			objective: req.objective.slice(0, MAX_OBJECTIVE_CHARS),
			...(req.searchQueries?.length
				? { search_queries: clampQueries(req.searchQueries) }
				: {}),
			...(req.sessionId ? { session_id: req.sessionId } : {}),
			...(req.maxCharsTotal ? { max_chars_total: req.maxCharsTotal } : {}),
			...(Object.keys(advancedSettings).length
				? { advanced_settings: advancedSettings }
				: {}),
		}),
		signal: deps.signal,
	});

	if (!res.ok) {
		return throwForStatus(res, "extract");
	}

	const body = (await res.json()) as ParallelExtractResponse;
	return {
		results: Array.isArray(body.results) ? body.results : [],
		errors: parseExtractErrors(body.errors),
	};
}

export async function parallelExtract(
	req: ParallelExtractRequest,
	deps: ParallelClientDeps,
): Promise<ParallelExtractResult[]> {
	return (await parallelExtractWithErrors(req, deps)).results;
}
