// Data-driven tool health registry. Every Normal Chat tool declares its
// backend, a `configured` predicate over the runtime config, and (where a
// server-side backend exists) a cheap probe. Adding a tool is one entry in
// TOOL_HEALTH_REGISTRY.
//
// Probes never throw: every failure is normalized to { ok: false, detail }.
// They receive an injectable `fetch` so tests can drive them without network.

import type {
	ToolHealthConfig,
	ToolHealthEntry,
	ToolProbeContext,
	ToolProbeResult,
} from "./types";

const DETAIL_MAX_CHARS = 160;

function trimBase(url: string): string {
	return url.trim().replace(/\/+$/, "");
}

function hasValue(value: string | undefined | null): boolean {
	return Boolean(value?.trim());
}

function describeError(error: unknown, signal: AbortSignal): string {
	if (signal.aborted) return "timed out";
	if (error instanceof Error) {
		const cause = (error as { cause?: { code?: string } }).cause;
		const code = cause?.code;
		return code ? `${error.message} (${code})` : error.message;
	}
	return String(error);
}

function clampDetail(detail: string): string {
	const single = detail.replace(/\s+/g, " ").trim();
	return single.length > DETAIL_MAX_CHARS
		? `${single.slice(0, DETAIL_MAX_CHARS)}…`
		: single;
}

type ProbeEvaluator = (
	response: Response,
) =>
	| Promise<{ ok: boolean; detail?: string }>
	| { ok: boolean; detail?: string };

// Shared HTTP probe shell: measures latency, maps thrown errors (network,
// abort) into { ok:false }, and delegates status interpretation to `evaluate`.
async function httpProbe(
	ctx: ToolProbeContext,
	input: string,
	init: RequestInit,
	evaluate: ProbeEvaluator,
): Promise<ToolProbeResult> {
	const started = Date.now();
	try {
		const response = await ctx.fetch(input, { ...init, signal: ctx.signal });
		const outcome = await evaluate(response);
		return {
			ok: outcome.ok,
			detail: outcome.detail ? clampDetail(outcome.detail) : undefined,
			latencyMs: Date.now() - started,
		};
	} catch (error) {
		return {
			ok: false,
			detail: clampDetail(describeError(error, ctx.signal)),
			latencyMs: Date.now() - started,
		};
	}
}

function statusDetail(response: Response): string {
	return `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
}

// Default evaluator: any 2xx is healthy, everything else is degraded.
function expectOk(response: Response): { ok: boolean; detail?: string } {
	return response.ok
		? { ok: true, detail: statusDetail(response) }
		: { ok: false, detail: statusDetail(response) };
}

// Evaluator for authenticated APIs where we deliberately send a minimal or
// invalid request: a validation error proves the host is reachable AND the
// key was accepted, while 401/403 prove the key was rejected.
function expectAuthenticated(response: Response): {
	ok: boolean;
	detail?: string;
} {
	if (response.ok) return { ok: true, detail: statusDetail(response) };
	if (response.status === 401 || response.status === 403) {
		return {
			ok: false,
			detail: `authentication rejected (${statusDetail(response)})`,
		};
	}
	if (response.status === 400 || response.status === 422) {
		return {
			ok: true,
			detail: `reachable, key accepted (${statusDetail(response)})`,
		};
	}
	if (response.status === 429) {
		return { ok: false, detail: `rate limited (${statusDetail(response)})` };
	}
	return { ok: false, detail: statusDetail(response) };
}

// ---------------------------------------------------------------------------
// Backend probes
// ---------------------------------------------------------------------------

const DEFAULT_PARALLEL_BASE_URL = "https://api.parallel.ai";

function probeParallel(ctx: ToolProbeContext): Promise<ToolProbeResult> {
	const base = trimBase(
		ctx.config.parallelBaseUrl || DEFAULT_PARALLEL_BASE_URL,
	);
	// An empty body fails Parallel's request validation (400/422) without
	// running a billable search; the response still proves reachability and
	// whether the x-api-key header was accepted.
	return httpProbe(
		ctx,
		`${base}/v1/search`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": ctx.config.parallelApiKey,
			},
			body: "{}",
		},
		expectAuthenticated,
	);
}

const BRAVE_IMAGE_SEARCH_PROBE_URL =
	"https://api.search.brave.com/res/v1/images/search?q=test&count=1";

function probeBrave(ctx: ToolProbeContext): Promise<ToolProbeResult> {
	return httpProbe(
		ctx,
		BRAVE_IMAGE_SEARCH_PROBE_URL,
		{
			method: "GET",
			headers: {
				Accept: "application/json",
				"X-Subscription-Token": ctx.config.braveSearchApiKey,
			},
		},
		expectAuthenticated,
	);
}

function probeTei(
	ctx: ToolProbeContext,
	baseUrl: string,
	apiKey: string,
): Promise<ToolProbeResult> {
	const headers: Record<string, string> = { Accept: "application/json" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	return httpProbe(
		ctx,
		`${trimBase(baseUrl)}/health`,
		{ method: "GET", headers },
		expectOk,
	);
}

async function probeOrs(ctx: ToolProbeContext): Promise<ToolProbeResult> {
	return httpProbe(
		ctx,
		`${trimBase(ctx.config.orsBaseUrl)}/v2/health`,
		{ method: "GET", headers: { Accept: "application/json" } },
		async (response) => {
			if (!response.ok) return { ok: false, detail: statusDetail(response) };
			const body = (await response.json().catch(() => null)) as {
				status?: unknown;
			} | null;
			const status = typeof body?.status === "string" ? body.status : null;
			if (status === "ready") return { ok: true, detail: "status: ready" };
			return {
				ok: false,
				detail: status ? `status: ${status}` : "unexpected health payload",
			};
		},
	);
}

function probeGeocoder(ctx: ToolProbeContext): Promise<ToolProbeResult> {
	return httpProbe(
		ctx,
		`${trimBase(ctx.config.geocoderBaseUrl)}/status`,
		{ method: "GET", headers: { Accept: "application/json, text/plain" } },
		expectOk,
	);
}

function owntracksHeaders(config: ToolHealthConfig): Record<string, string> {
	const headers: Record<string, string> = { Accept: "application/json" };
	const user = config.owntracksRecorderUser?.trim();
	if (user) {
		const pass = config.owntracksRecorderPass ?? "";
		headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
	}
	return headers;
}

async function probeOwntracks(ctx: ToolProbeContext): Promise<ToolProbeResult> {
	const base = trimBase(ctx.config.owntracksRecorderUrl);
	const headers = owntracksHeaders(ctx.config);
	const version = await httpProbe(
		ctx,
		`${base}/api/0/version`,
		{ method: "GET", headers },
		expectOk,
	);
	if (version.ok || !/HTTP 404/.test(version.detail ?? "")) return version;
	// Older recorders may not expose /api/0/version; fall back to the root.
	const root = await httpProbe(
		ctx,
		`${base}/`,
		{ method: "GET", headers },
		expectOk,
	);
	return { ...root, latencyMs: version.latencyMs + root.latencyMs };
}

async function probeDocker(ctx: ToolProbeContext): Promise<ToolProbeResult> {
	const started = Date.now();
	try {
		await ctx.dockerPing(ctx.signal);
		return { ok: true, detail: "ping ok", latencyMs: Date.now() - started };
	} catch (error) {
		return {
			ok: false,
			detail: clampDetail(describeError(error, ctx.signal)),
			latencyMs: Date.now() - started,
		};
	}
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const PER_USER_CONNECTION_BACKEND = "per-user connection";

function connectionEntry(
	name: string,
	capability: ToolHealthEntry["connectionCapability"],
): ToolHealthEntry {
	return {
		id: name,
		name,
		backend: PER_USER_CONNECTION_BACKEND,
		configured: () => true,
		connectionCapability: capability,
	};
}

export const TOOL_HEALTH_REGISTRY: readonly ToolHealthEntry[] = [
	{
		id: "research_web",
		name: "research_web",
		backend: "Parallel API",
		configured: (config) => hasValue(config.parallelApiKey),
		probe: probeParallel,
	},
	{
		id: "fetch_url",
		name: "fetch_url",
		backend: "Parallel API",
		configured: (config) => hasValue(config.parallelApiKey),
		probe: probeParallel,
	},
	{
		id: "image_search",
		name: "image_search",
		backend: "Brave Search",
		configured: (config) => hasValue(config.braveSearchApiKey),
		probe: probeBrave,
	},
	{
		id: "memory_context",
		name: "memory_context",
		backend: "TEI embedder",
		configured: (config) => hasValue(config.teiEmbedderUrl),
		probe: (ctx) =>
			probeTei(ctx, ctx.config.teiEmbedderUrl, ctx.config.teiEmbedderApiKey),
	},
	{
		id: "memory_context:reranker",
		name: "memory_context",
		backend: "TEI reranker",
		configured: (config) => hasValue(config.teiRerankerUrl),
		probe: (ctx) =>
			probeTei(ctx, ctx.config.teiRerankerUrl, ctx.config.teiRerankerApiKey),
	},
	{
		id: "map_route",
		name: "map_route",
		backend: "OpenRouteService",
		configured: (config) => hasValue(config.orsBaseUrl),
		probe: probeOrs,
	},
	{
		id: "map_route:geocoder",
		name: "map_route",
		backend: "Geocoder (Nominatim)",
		configured: (config) => hasValue(config.geocoderBaseUrl),
		probe: probeGeocoder,
	},
	{
		id: "produce_file",
		name: "produce_file",
		backend: "Docker sandbox",
		configured: () => true,
		probe: probeDocker,
	},
	{
		id: "location",
		name: "location",
		backend: "OwnTracks recorder",
		configured: (config) => hasValue(config.owntracksRecorderUrl),
		probe: probeOwntracks,
		connectionCapability: "location",
	},
	connectionEntry("files", "files"),
	connectionEntry("calendar", "calendar"),
	connectionEntry("email", "email"),
	connectionEntry("photos", "photos"),
	connectionEntry("media", "media"),
	connectionEntry("contacts", "contacts"),
	connectionEntry("repos", "repos"),
	connectionEntry("tasks", "tasks"),
];
