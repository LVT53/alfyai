import { afterEach, describe, expect, it, vi } from "vitest";
import {
	checkToolHealth,
	getToolHealthSnapshot,
	resetToolHealthCacheForTests,
	runToolHealthChecks,
	TOOL_HEALTH_REGISTRY,
	type ToolHealthConfig,
	type ToolHealthDeps,
} from "./index";

function fullConfig(
	overrides: Partial<ToolHealthConfig> = {},
): ToolHealthConfig {
	return {
		parallelApiKey: "parallel-key",
		parallelBaseUrl: "https://parallel.test",
		braveSearchApiKey: "brave-key",
		teiEmbedderUrl: "http://tei-embed:8080/",
		teiEmbedderApiKey: "",
		teiRerankerUrl: "http://tei-rerank:8080",
		teiRerankerApiKey: "rerank-token",
		orsBaseUrl: "http://ors:8082/ors",
		geocoderBaseUrl: "http://nominatim:8080",
		routingGtfsFeeds: "hungary=https://feeds.test/hu.zip",
		owntracksRecorderUrl: "http://owntracks:8083",
		owntracksRecorderUser: "alfy",
		owntracksRecorderPass: "secret",
		...overrides,
	};
}

function emptyConfig(): ToolHealthConfig {
	return fullConfig({
		parallelApiKey: "",
		braveSearchApiKey: "",
		teiEmbedderUrl: "",
		teiRerankerUrl: "",
		orsBaseUrl: "",
		geocoderBaseUrl: "",
		routingGtfsFeeds: "",
		owntracksRecorderUrl: "",
	});
}

type FetchHandler = (
	url: string,
	init: RequestInit,
) => Response | Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function makeDeps(
	handler: FetchHandler,
	overrides: Partial<ToolHealthDeps> = {},
): ToolHealthDeps & { fetch: ReturnType<typeof vi.fn> } {
	const fetchMock = vi.fn(
		async (input: RequestInfo | URL, init?: RequestInit) =>
			handler(String(input), init ?? {}),
	);
	return {
		fetch: fetchMock as unknown as typeof fetch,
		getConfig: () => fullConfig(),
		dockerPing: vi.fn(async () => {}),
		listTransitRegions: vi.fn(async () => [
			{ name: "Hungary", transitStatus: "ready" },
		]),
		countConnectedConnections: vi.fn(async () => ({ files: 2, calendar: 1 })),
		now: Date.now,
		timeoutMs: 50,
		registry: TOOL_HEALTH_REGISTRY,
		...overrides,
	} as ToolHealthDeps & { fetch: ReturnType<typeof vi.fn> };
}

function healthyHandler(url: string): Response {
	if (url.includes("/v1/search"))
		return jsonResponse({ error: "bad request" }, 422);
	if (url.includes("/v2/health")) return jsonResponse({ status: "ready" });
	return jsonResponse({ ok: true });
}

function byId(snapshot: Awaited<ReturnType<typeof checkToolHealth>>) {
	return Object.fromEntries(snapshot.tools.map((tool) => [tool.id, tool]));
}

afterEach(() => {
	resetToolHealthCacheForTests();
	vi.useRealTimers();
});

describe("tool health registry", () => {
	it("has a unique id per entry and covers every chat tool", () => {
		const ids = TOOL_HEALTH_REGISTRY.map((entry) => entry.id);
		expect(new Set(ids).size).toBe(ids.length);
		const names = new Set(TOOL_HEALTH_REGISTRY.map((entry) => entry.name));
		for (const name of [
			"research_web",
			"fetch_url",
			"image_search",
			"memory_context",
			"map_route",
			"produce_file",
			"run_python",
			"location",
			"files",
			"calendar",
			"email",
			"photos",
			"media",
			"contacts",
			"repos",
			"tasks",
		]) {
			expect(names.has(name)).toBe(true);
		}
	});

	it("pings the Parallel API once for research_web and fetch_url together", async () => {
		const deps = makeDeps(healthyHandler);
		const snapshot = await checkToolHealth(deps);
		const tools = byId(snapshot);

		const searchCalls = deps.fetch.mock.calls.filter(([input]) =>
			String(input).includes("/v1/search"),
		);
		expect(searchCalls).toHaveLength(1);
		expect(tools.research_web.status).toBe("healthy");
		expect(tools.fetch_url.status).toBe("healthy");
	});

	it("probes a shared backend once per snapshot and reports it on every entry", async () => {
		const deps = makeDeps(healthyHandler);
		const snapshot = await checkToolHealth(deps);
		const tools = byId(snapshot);

		// produce_file and run_python are two entries on one Docker daemon.
		expect(deps.dockerPing).toHaveBeenCalledTimes(1);
		expect(tools.produce_file.probed).toBe(true);
		expect(tools.run_python.probed).toBe(true);
		expect(tools.produce_file.status).toBe("healthy");
		expect(tools.run_python.status).toBe("healthy");
		expect(tools.run_python.detail).toBe(tools.produce_file.detail);
	});

	it("marks every entry sharing a failed probe degraded from the single run", async () => {
		const deps = makeDeps(healthyHandler, {
			dockerPing: vi.fn(async () => {
				throw new Error("Cannot connect to the Docker daemon");
			}),
		});
		const snapshot = await checkToolHealth(deps);
		const tools = byId(snapshot);

		expect(deps.dockerPing).toHaveBeenCalledTimes(1);
		expect(tools.produce_file.status).toBe("degraded");
		expect(tools.run_python.status).toBe("degraded");
		expect(tools.run_python.detail).toContain("Cannot connect");
	});

	it("reports every configured backend healthy when probes succeed", async () => {
		const deps = makeDeps(healthyHandler);
		const snapshot = await checkToolHealth(deps);
		const tools = byId(snapshot);

		expect(tools.research_web.status).toBe("healthy");
		expect(tools.research_web.detail).toContain("key accepted");
		expect(tools.fetch_url.status).toBe("healthy");
		expect(tools.image_search.status).toBe("healthy");
		expect(tools.memory_context.status).toBe("healthy");
		expect(tools["memory_context:reranker"].status).toBe("healthy");
		expect(tools.map_route.status).toBe("healthy");
		expect(tools.map_route.detail).toBe("status: ready");
		expect(tools["map_route:geocoder"].status).toBe("healthy");
		expect(tools["map_route:transit"].status).toBe("healthy");
		expect(tools["map_route:transit"].detail).toBe("Hungary: ready");
		expect(tools.produce_file.status).toBe("healthy");
		expect(tools.run_python.status).toBe("healthy");
		expect(tools.location.status).toBe("healthy");
		expect(tools.location.connectedConnections).toBe(0);
		expect(tools.files.status).toBe("healthy");
		expect(tools.files.connectedConnections).toBe(2);
		expect(tools.files.probed).toBe(false);
		expect(tools.files.detail).toBe("2 connected");
		expect(tools.email.status).toBe("unconfigured");
		expect(tools.email.connectedConnections).toBe(0);
		for (const tool of snapshot.tools) {
			expect(tool.degradedSince).toBeNull();
			if (tool.probed) expect(tool.latencyMs).toBeGreaterThanOrEqual(0);
		}
	});

	// Public-transport readiness is per REGION and is app state, not an
	// endpoint: the probe reads `routing_regions` and reports every configured
	// region's state so an admin can see which country is still building.
	it("reports per-region timetable readiness without an HTTP call", async () => {
		const deps = makeDeps(healthyHandler, {
			listTransitRegions: vi.fn(async () => [
				{ name: "Hungary", transitStatus: "ready" },
				{ name: "Netherlands", transitStatus: "building" },
				// A region with no feed is not part of the picture at all.
				{ name: "Austria", transitStatus: "none" },
			]),
		});
		const tools = byId(await checkToolHealth(deps));
		expect(tools["map_route:transit"].status).toBe("healthy");
		expect(tools["map_route:transit"].detail).toBe(
			"Hungary: ready, Netherlands: building",
		);
		expect(
			deps.fetch.mock.calls.some((call) => String(call[0]).includes("status")),
		).toBe(true);
	});

	it("is degraded while no region has a timetable graph yet", async () => {
		const tools = byId(
			await checkToolHealth(
				makeDeps(healthyHandler, {
					listTransitRegions: vi.fn(async () => [
						{ name: "Hungary", transitStatus: "building" },
					]),
				}),
			),
		);
		expect(tools["map_route:transit"].status).toBe("degraded");
		expect(tools["map_route:transit"].detail).toBe("Hungary: building");
	});

	it("is unconfigured when no GTFS feed is configured at all", async () => {
		const tools = byId(
			await checkToolHealth(
				makeDeps(healthyHandler, { getConfig: () => emptyConfig() }),
			),
		);
		expect(tools["map_route:transit"].status).toBe("unconfigured");
		expect(tools["map_route:transit"].probed).toBe(false);
	});

	it("sends the expected requests and headers for each probe", async () => {
		const deps = makeDeps(healthyHandler);
		await checkToolHealth(deps);
		const calls = deps.fetch.mock.calls.map(
			([url, init]) => [String(url), init as RequestInit] as const,
		);
		const find = (fragment: string) =>
			calls.find(([url]) => url.includes(fragment));

		const parallel = find("https://parallel.test/v1/search");
		expect(parallel?.[1].method).toBe("POST");
		expect((parallel?.[1].headers as Record<string, string>)["x-api-key"]).toBe(
			"parallel-key",
		);
		expect(parallel?.[1].body).toBe("{}");

		const brave = find(
			"api.search.brave.com/res/v1/images/search?q=test&count=1",
		);
		expect(
			(brave?.[1].headers as Record<string, string>)["X-Subscription-Token"],
		).toBe("brave-key");

		expect(find("http://tei-embed:8080/health")).toBeDefined();
		const reranker = find("http://tei-rerank:8080/health");
		expect(
			(reranker?.[1].headers as Record<string, string>).Authorization,
		).toBe("Bearer rerank-token");

		expect(find("http://ors:8082/ors/v2/health")).toBeDefined();
		expect(find("http://nominatim:8080/status")).toBeDefined();

		const owntracks = find("http://owntracks:8083/api/0/version");
		expect(
			(owntracks?.[1].headers as Record<string, string>).Authorization,
		).toBe(`Basic ${Buffer.from("alfy:secret").toString("base64")}`);
		// produce_file and run_python sit on the same Docker daemon and share a
		// probeKey, so one snapshot pings it once, not once per entry.
		expect(deps.dockerPing).toHaveBeenCalledTimes(1);
	});

	it("marks configured backends degraded when probes fail, with a detail", async () => {
		const deps = makeDeps(
			(url) => {
				if (url.includes("/v1/search")) return jsonResponse({}, 401);
				if (url.includes("brave")) return jsonResponse({}, 429);
				if (url.includes("/v2/health"))
					return jsonResponse({ status: "not ready" });
				if (url.includes("tei-embed")) throw new TypeError("fetch failed");
				return jsonResponse({}, 500);
			},
			{
				dockerPing: vi.fn(async () => {
					throw new Error("connect ENOENT /var/run/docker.sock");
				}),
			},
		);
		const snapshot = await checkToolHealth(deps);
		const tools = byId(snapshot);

		expect(tools.research_web.status).toBe("degraded");
		expect(tools.research_web.detail).toContain("authentication rejected");
		expect(tools.image_search.status).toBe("degraded");
		expect(tools.image_search.detail).toContain("rate limited");
		expect(tools.map_route.status).toBe("degraded");
		expect(tools.map_route.detail).toBe("status: not ready");
		expect(tools.memory_context.status).toBe("degraded");
		expect(tools.memory_context.detail).toContain("fetch failed");
		expect(tools["memory_context:reranker"].status).toBe("degraded");
		expect(tools["memory_context:reranker"].detail).toContain("HTTP 500");
		expect(tools.produce_file.status).toBe("degraded");
		expect(tools.produce_file.detail).toContain("docker.sock");
		expect(tools.run_python.status).toBe("degraded");
		expect(tools.run_python.detail).toContain("docker.sock");
		expect(tools.location.status).toBe("degraded");
		for (const tool of snapshot.tools) {
			if (tool.status === "degraded") {
				expect(tool.degradedSince).toBe(snapshot.checkedAt);
			}
		}
	});

	it("falls back to the recorder root when /api/0/version is missing", async () => {
		const deps = makeDeps((url) => {
			if (url.endsWith("/api/0/version")) return jsonResponse({}, 404);
			return healthyHandler(url);
		});
		const snapshot = await checkToolHealth(deps);
		expect(byId(snapshot).location.status).toBe("healthy");
		expect(
			deps.fetch.mock.calls.some(
				([url]) => String(url) === "http://owntracks:8083/",
			),
		).toBe(true);
	});

	it("times out slow probes without stalling the run", async () => {
		const deps = makeDeps((url, init) => {
			if (url.includes("tei-embed")) {
				return new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener("abort", () =>
						reject(new DOMException("aborted", "AbortError")),
					);
				});
			}
			if (url.includes("nominatim")) {
				// Ignores the abort signal entirely.
				return new Promise<Response>(() => {});
			}
			return healthyHandler(url);
		});
		const snapshot = await checkToolHealth(deps);
		const tools = byId(snapshot);
		expect(tools.memory_context.status).toBe("degraded");
		expect(tools.memory_context.detail).toContain("timed out");
		expect(tools["map_route:geocoder"].status).toBe("degraded");
		expect(tools["map_route:geocoder"].detail).toContain(
			"timed out after 50ms",
		);
		expect(tools.research_web.status).toBe("healthy");
	});

	it("reports unconfigured backends without probing them", async () => {
		const deps = makeDeps(healthyHandler, { getConfig: emptyConfig });
		const snapshot = await checkToolHealth(deps);
		const tools = byId(snapshot);
		for (const id of [
			"research_web",
			"fetch_url",
			"image_search",
			"memory_context",
			"memory_context:reranker",
			"map_route",
			"map_route:geocoder",
			"location",
		]) {
			expect(tools[id].status).toBe("unconfigured");
			expect(tools[id].probed).toBe(false);
			expect(tools[id].detail).toBe("not configured");
		}
		expect(deps.fetch).not.toHaveBeenCalled();
		// Docker needs no config, so it is still probed.
		expect(tools.produce_file.status).toBe("healthy");
		expect(tools.run_python.status).toBe("healthy");
	});

	it("never throws when config or connection counting fail", async () => {
		const deps = makeDeps(healthyHandler, {
			getConfig: () => {
				throw new Error("config unavailable");
			},
			countConnectedConnections: async () => {
				throw new Error("db down");
			},
		});
		const snapshot = await checkToolHealth(deps);
		const tools = byId(snapshot);
		expect(tools.research_web.status).toBe("unconfigured");
		expect(tools.files.detail).toContain(
			"connection count unavailable: db down",
		);
	});

	it("preserves degradedSince across consecutive degraded runs", async () => {
		let failing = true;
		const deps = makeDeps((url) =>
			failing && url.includes("brave")
				? jsonResponse({}, 500)
				: healthyHandler(url),
		);
		const first = await runToolHealthChecks(deps);
		const firstSince = byId(first).image_search.degradedSince;
		expect(firstSince).toBe(first.checkedAt);

		const second = await runToolHealthChecks({
			...deps,
			now: () => Date.parse(first.checkedAt) + 60_000,
		});
		expect(byId(second).image_search.degradedSince).toBe(firstSince);

		failing = false;
		const third = await runToolHealthChecks(deps);
		expect(byId(third).image_search.status).toBe("healthy");
		expect(byId(third).image_search.degradedSince).toBeNull();
	});

	it("serves the cached snapshot until maxAgeMs elapses", async () => {
		let nowMs = 1_000_000;
		const deps = makeDeps(healthyHandler, { now: () => nowMs });
		const first = await runToolHealthChecks(deps);
		expect(await getToolHealthSnapshot({ maxAgeMs: 5_000, deps })).toBe(first);
		const fetchCalls = deps.fetch.mock.calls.length;

		nowMs += 10_000;
		const refreshed = await getToolHealthSnapshot({ maxAgeMs: 5_000, deps });
		expect(refreshed).not.toBe(first);
		expect(deps.fetch.mock.calls.length).toBeGreaterThan(fetchCalls);
	});

	it("dedupes concurrent refreshes into one run", async () => {
		const deps = makeDeps(healthyHandler);
		const [a, b] = await Promise.all([
			runToolHealthChecks(deps),
			runToolHealthChecks(deps),
		]);
		expect(a).toBe(b);
		// One run, and one Docker ping shared by produce_file and run_python.
		expect(deps.dockerPing).toHaveBeenCalledTimes(1);
	});
});
