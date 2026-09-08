import type { RuntimeConfig } from "$lib/server/config-store";
import type { Capability } from "$lib/server/services/connections/registry";

// Narrow config slice the registry reads. Kept as a Pick so the registry never
// depends on config-store internals beyond the keys it actually inspects.
export type ToolHealthConfig = Pick<
	RuntimeConfig,
	| "parallelApiKey"
	| "parallelBaseUrl"
	| "braveSearchApiKey"
	| "teiEmbedderUrl"
	| "teiEmbedderApiKey"
	| "teiRerankerUrl"
	| "teiRerankerApiKey"
	| "orsBaseUrl"
	| "geocoderBaseUrl"
	| "routingGtfsFeeds"
	| "routingOnDemandEnabled"
	| "owntracksRecorderUrl"
	| "owntracksRecorderUser"
	| "owntracksRecorderPass"
>;

// Per-region public-transport readiness, as the map_route health entry reports
// it. Read from `routing_regions`, not from an HTTP probe: whether a region's
// GTFS graph is loaded is state this app owns, not something an endpoint says.
export interface TransitRegionHealth {
	name: string;
	transitStatus: string;
}

export interface ToolProbeResult {
	ok: boolean;
	detail?: string;
	latencyMs: number;
}

export interface ToolProbeContext {
	fetch: typeof fetch;
	config: ToolHealthConfig;
	signal: AbortSignal;
	dockerPing: (signal: AbortSignal) => Promise<void>;
	listTransitRegions: () => Promise<TransitRegionHealth[]>;
}

// One registry entry per (tool, backend) pair. A new tool is one object here.
export interface ToolHealthEntry {
	// Stable id — unique across the registry (tool name plus an optional
	// sub-backend suffix, e.g. "map_route:geocoder").
	id: string;
	// Model-facing tool name as registered in normal-chat-tools.
	name: string;
	// Human label for the backing service.
	backend: string;
	configured: (config: ToolHealthConfig) => boolean;
	// Cheap reachability/auth check. Omit for tools that have no server-side
	// backend to probe (per-user connection tools).
	probe?: (ctx: ToolProbeContext) => Promise<ToolProbeResult>;
	// Entries that share a probeKey share one probe run per snapshot: the
	// first one starts it, the rest reuse its result. Set it whenever several
	// tools sit on the same backing service (produce_file and run_python both
	// ping the one Docker daemon), so a snapshot does not hit that service
	// once per tool. Omit it for probes that are per-entry.
	probeKey?: string;
	// When set, the report includes the number of `connected` user_connections
	// rows that serve this capability.
	connectionCapability?: Capability;
}

export type ToolHealthStatus = "healthy" | "degraded" | "unconfigured";

export interface ToolHealthReport {
	id: string;
	tool: string;
	backend: string;
	status: ToolHealthStatus;
	configured: boolean;
	probed: boolean;
	latencyMs: number | null;
	detail: string | null;
	connectedConnections: number | null;
	checkedAt: string;
	// ISO timestamp of the first consecutive degraded observation; null when
	// the tool is not currently degraded.
	degradedSince: string | null;
}

export interface ToolHealthSnapshot {
	checkedAt: string;
	durationMs: number;
	tools: ToolHealthReport[];
}

export const TOOL_HEALTH_PROBE_TIMEOUT_MS = 5_000;
export const TOOL_HEALTH_DEFAULT_MAX_AGE_MS = 5 * 60_000;

export type ConnectedConnectionCounts = Partial<Record<Capability, number>>;

export interface ToolHealthDeps {
	fetch: typeof fetch;
	getConfig: () => ToolHealthConfig;
	dockerPing: (signal: AbortSignal) => Promise<void>;
	listTransitRegions: () => Promise<TransitRegionHealth[]>;
	countConnectedConnections: () => Promise<ConnectedConnectionCounts>;
	now: () => number;
	timeoutMs: number;
	registry: readonly ToolHealthEntry[];
}

// Content-free projection for any signed-in user: which tools are degraded
// and since when. Probe details (which can carry URLs or error bodies) stay on
// the admin-only surfaces.
export interface DegradedCapabilitiesReport {
	degraded: Array<{ tool: string; backend: string; since: string }>;
	checkedAt: string;
}
