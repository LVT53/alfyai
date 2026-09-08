// Tool health runner: probes every registry entry concurrently with a per-probe
// timeout, never throws, and keeps the latest snapshot in memory so admin and
// user-facing surfaces can read it cheaply.

import {
	type ConnectedConnectionCounts,
	type DegradedCapabilitiesReport,
	TOOL_HEALTH_DEFAULT_MAX_AGE_MS,
	type ToolHealthConfig,
	type ToolHealthDeps,
	type ToolHealthEntry,
	type ToolHealthReport,
	type ToolHealthSnapshot,
	type ToolHealthStatus,
	type ToolProbeResult,
} from "./types";

export { TOOL_HEALTH_REGISTRY } from "./registry";
export type {
	ConnectedConnectionCounts,
	DegradedCapabilitiesReport,
	ToolHealthConfig,
	ToolHealthDeps,
	ToolHealthEntry,
	ToolHealthReport,
	ToolHealthSnapshot,
	ToolHealthStatus,
	ToolProbeResult,
} from "./types";
export {
	TOOL_HEALTH_DEFAULT_MAX_AGE_MS,
	TOOL_HEALTH_PROBE_TIMEOUT_MS,
} from "./types";

interface ProbeOutcome extends ToolProbeResult {
	timedOut: boolean;
}

function withTimeout(
	entry: ToolHealthEntry,
	deps: ToolHealthDeps,
	config: ToolHealthConfig,
): Promise<ProbeOutcome> {
	const probe = entry.probe;
	if (!probe) {
		return Promise.resolve({ ok: true, latencyMs: 0, timedOut: false });
	}
	const controller = new AbortController();
	const started = deps.now();
	return new Promise<ProbeOutcome>((resolve) => {
		let settled = false;
		const finish = (outcome: ProbeOutcome) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(outcome);
		};
		// Race the probe against the timeout so a probe that ignores its signal
		// still cannot stall the whole run.
		const timer = setTimeout(() => {
			controller.abort();
			finish({
				ok: false,
				detail: `timed out after ${deps.timeoutMs}ms`,
				latencyMs: deps.now() - started,
				timedOut: true,
			});
		}, deps.timeoutMs);
		probe({
			fetch: deps.fetch,
			config,
			signal: controller.signal,
			dockerPing: deps.dockerPing,
			listTransitRegions: deps.listTransitRegions,
		}).then(
			(result) => finish({ ...result, timedOut: false }),
			(error: unknown) =>
				finish({
					ok: false,
					detail: error instanceof Error ? error.message : String(error),
					latencyMs: deps.now() - started,
					timedOut: false,
				}),
		);
	});
}

function deriveStatus(
	configured: boolean,
	probed: boolean,
	ok: boolean,
	connectedConnections: number | null,
): ToolHealthStatus {
	if (!configured) return "unconfigured";
	if (probed) return ok ? "healthy" : "degraded";
	// Per-user connection tools have nothing server-side to probe: they are
	// "configured" only once at least one user connected an account.
	if (connectedConnections !== null) {
		return connectedConnections > 0 ? "healthy" : "unconfigured";
	}
	return "healthy";
}

async function safeCountConnections(
	deps: ToolHealthDeps,
): Promise<{ counts: ConnectedConnectionCounts; error: string | null }> {
	try {
		return { counts: await deps.countConnectedConnections(), error: null };
	} catch (error) {
		return {
			counts: {},
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function safeConfig(deps: ToolHealthDeps): ToolHealthConfig {
	try {
		return deps.getConfig();
	} catch {
		return {
			parallelApiKey: "",
			parallelBaseUrl: "",
			braveSearchApiKey: "",
			teiEmbedderUrl: "",
			teiEmbedderApiKey: "",
			teiRerankerUrl: "",
			teiRerankerApiKey: "",
			orsBaseUrl: "",
			geocoderBaseUrl: "",
			routingGtfsFeeds: "",
			owntracksRecorderUrl: "",
			owntracksRecorderUser: "",
			owntracksRecorderPass: "",
		};
	}
}

// Runs every probe once. Pure with respect to `deps`; the module-level cache
// below is layered on top by `runToolHealthChecks`.
export async function checkToolHealth(
	deps: ToolHealthDeps,
	previousDegradedSince: ReadonlyMap<string, string> = new Map(),
): Promise<ToolHealthSnapshot> {
	const started = deps.now();
	const config = safeConfig(deps);

	// Start every probe first, in one synchronous pass, so entries sharing a
	// `probeKey` (produce_file and run_python both ping the one Docker daemon)
	// are guaranteed to find each other's in-flight promise and hit the
	// backing service once per snapshot rather than once per entry.
	const sharedProbes = new Map<string, Promise<ProbeOutcome>>();
	const pendingProbes = deps.registry.map((entry) => {
		let configured = false;
		try {
			configured = entry.configured(config);
		} catch {
			configured = false;
		}
		if (!configured || !entry.probe) {
			return {
				entry,
				configured,
				outcome: null as Promise<ProbeOutcome> | null,
			};
		}
		const key = entry.probeKey;
		if (!key) {
			return { entry, configured, outcome: withTimeout(entry, deps, config) };
		}
		const shared = sharedProbes.get(key) ?? withTimeout(entry, deps, config);
		sharedProbes.set(key, shared);
		return { entry, configured, outcome: shared };
	});

	const [connections, outcomes] = await Promise.all([
		safeCountConnections(deps),
		Promise.all(
			pendingProbes.map(async ({ entry, configured, outcome }) => ({
				entry,
				configured,
				outcome: outcome ? await outcome : (null as ProbeOutcome | null),
			})),
		),
	]);

	const checkedAt = new Date(deps.now()).toISOString();
	const tools: ToolHealthReport[] = outcomes.map(
		({ entry, configured, outcome }) => {
			const capability = entry.connectionCapability;
			const connectedConnections = capability
				? (connections.counts[capability] ?? 0)
				: null;
			const probed = outcome !== null;
			const ok = outcome?.ok ?? true;
			const status = deriveStatus(configured, probed, ok, connectedConnections);
			const detailParts: string[] = [];
			if (!configured) detailParts.push("not configured");
			if (outcome?.detail) detailParts.push(outcome.detail);
			if (capability && connections.error) {
				detailParts.push(`connection count unavailable: ${connections.error}`);
			} else if (capability && !entry.probe) {
				detailParts.push(`${connectedConnections} connected`);
			}
			const degradedSince =
				status === "degraded"
					? (previousDegradedSince.get(entry.id) ?? checkedAt)
					: null;
			return {
				id: entry.id,
				tool: entry.name,
				backend: entry.backend,
				status,
				configured,
				probed,
				latencyMs: outcome ? outcome.latencyMs : null,
				detail: detailParts.length > 0 ? detailParts.join(" · ") : null,
				connectedConnections,
				checkedAt,
				degradedSince,
			};
		},
	);

	return { checkedAt, durationMs: deps.now() - started, tools };
}

// ---------------------------------------------------------------------------
// Module-level cache
// ---------------------------------------------------------------------------

let cachedSnapshot: ToolHealthSnapshot | null = null;
let cachedAtMs = 0;
let inflight: Promise<ToolHealthSnapshot> | null = null;
const degradedSince = new Map<string, string>();
let defaultDepsPromise: Promise<ToolHealthDeps> | null = null;

const DEPS_KEYS: ReadonlyArray<keyof ToolHealthDeps> = [
	"fetch",
	"getConfig",
	"dockerPing",
	"countConnectedConnections",
	"now",
	"timeoutMs",
	"registry",
];

function isCompleteDeps(deps: Partial<ToolHealthDeps>): deps is ToolHealthDeps {
	return DEPS_KEYS.every((key) => deps[key] !== undefined);
}

async function loadDefaultDeps(): Promise<ToolHealthDeps> {
	if (!defaultDepsPromise) {
		defaultDepsPromise = import("./deps").then((mod) =>
			mod.createDefaultToolHealthDeps(),
		);
	}
	return defaultDepsPromise;
}

// Production callers pass nothing (defaults are loaded lazily from ./deps);
// tests pass a complete deps object and never touch dockerode or the DB.
async function resolveDeps(
	overrides: Partial<ToolHealthDeps>,
): Promise<ToolHealthDeps> {
	if (isCompleteDeps(overrides)) return overrides;
	return { ...(await loadDefaultDeps()), ...overrides };
}

export async function runToolHealthChecks(
	overrides: Partial<ToolHealthDeps> = {},
): Promise<ToolHealthSnapshot> {
	if (inflight) return inflight;
	inflight = (async () => {
		const deps = await resolveDeps(overrides);
		const snapshot = await checkToolHealth(deps, degradedSince);
		degradedSince.clear();
		for (const tool of snapshot.tools) {
			if (tool.degradedSince) degradedSince.set(tool.id, tool.degradedSince);
		}
		cachedSnapshot = snapshot;
		cachedAtMs = deps.now();
		return snapshot;
	})().finally(() => {
		inflight = null;
	});
	return inflight;
}

// Returns the cached snapshot when it is younger than `maxAgeMs`, otherwise
// runs a fresh check. `deps` overrides are only forwarded to that refresh.
export async function getToolHealthSnapshot(
	options: { maxAgeMs?: number; deps?: Partial<ToolHealthDeps> } = {},
): Promise<ToolHealthSnapshot> {
	const maxAgeMs = options.maxAgeMs ?? TOOL_HEALTH_DEFAULT_MAX_AGE_MS;
	const nowMs = (options.deps?.now ?? Date.now)();
	if (cachedSnapshot && nowMs - cachedAtMs <= maxAgeMs) return cachedSnapshot;
	return runToolHealthChecks(options.deps ?? {});
}

export function getCachedToolHealthSnapshot(): ToolHealthSnapshot | null {
	return cachedSnapshot;
}

export function projectDegradedCapabilities(
	snapshot: ToolHealthSnapshot,
): DegradedCapabilitiesReport {
	return {
		degraded: snapshot.tools
			.filter((tool) => tool.status === "degraded")
			.map((tool) => ({
				tool: tool.tool,
				backend: tool.backend,
				since: tool.degradedSince ?? snapshot.checkedAt,
			})),
		checkedAt: snapshot.checkedAt,
	};
}

// Test hook: drop the in-memory cache and degraded-since bookkeeping.
export function resetToolHealthCacheForTests(): void {
	cachedSnapshot = null;
	cachedAtMs = 0;
	inflight = null;
	degradedSince.clear();
	defaultDepsPromise = null;
}
