// Process-wide wiring for the routing region manager: builds the singleton
// from runtime config, exposes it to the tool layer and admin API, and runs
// the idle sweep / job resume on a timer. Kept separate from region-manager.ts
// so the manager itself stays dependency-injected and unit-testable.

import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { parseMirrorList } from "./extract-mirrors";
import { loadGeofabrikIndex } from "./geofabrik";
import { createDockerodeRegionDocker } from "./region-docker";
import {
	createRoutingRegionManager,
	type RoutingRegionManager,
	type RoutingRegionManagerConfig,
} from "./region-manager";

const IDLE_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const BUILD_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const START_TIMEOUT_MS = 90 * 1000;
const DOWNLOAD_STALL_MS = 60 * 1000;
const DOWNLOAD_MAX_MS = 3 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 20;

let manager: RoutingRegionManager | null = null;
let managerKey = "";
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function parsePortRange(value: string): { start: number; end: number } {
	const match = value.match(/^(\d+)\s*-\s*(\d+)$/);
	if (!match) return { start: 8300, end: 8399 };
	const start = Number(match[1]);
	const end = Number(match[2]);
	return end >= start ? { start, end } : { start: end, end: start };
}

export function buildRegionManagerConfig(): RoutingRegionManagerConfig {
	const config = getConfig();
	const legacyBase = config.orsBaseUrl?.trim();
	return {
		enabled: config.routingOnDemandEnabled,
		regionsDir: config.routingRegionsDir,
		orsImage: config.routingOrsImage,
		xmx: config.routingRegionXmx,
		portRange: parsePortRange(config.routingRegionPortRange),
		hostIp: config.routingRegionHostIp,
		idleMinutes: config.routingRegionIdleMinutes,
		maxPbfBytes: config.routingRegionMaxPbfMb * 1048576,
		buildTimeoutMs: BUILD_TIMEOUT_MS,
		startTimeoutMs: START_TIMEOUT_MS,
		geocoderImportContainer: config.routingGeocoderImportContainer,
		geocoderRegionsMount: "/regions",
		extractMirrors: parseMirrorList(config.routingExtractMirrors),
		residentRegionIds: config.routingResidentRegionIds
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean),
		downloadStallMs: DOWNLOAD_STALL_MS,
		downloadMaxMs: DOWNLOAD_MAX_MS,
		maxAttempts: MAX_ATTEMPTS,
		legacy:
			legacyBase && config.routingLegacyRegionId
				? { id: config.routingLegacyRegionId, baseUrl: legacyBase }
				: null,
	};
}

// Whether any region-aware routing is possible at all: a legacy ORS base or
// on-demand downloads. Mirrors the tool registration gate.
export function isRegionRoutingConfigured(): boolean {
	const config = getConfig();
	return Boolean(config.orsBaseUrl?.trim()) || config.routingOnDemandEnabled;
}

export function getRoutingRegionManager(): RoutingRegionManager {
	const managerConfig = buildRegionManagerConfig();
	const key = JSON.stringify(managerConfig);
	if (manager && managerKey === key) return manager;
	managerKey = key;
	manager = createRoutingRegionManager(managerConfig, {
		db,
		docker: createDockerodeRegionDocker(),
		fetch,
		loadIndex: () =>
			loadGeofabrikIndex({
				fetch,
				cachePath: `${managerConfig.regionsDir}/geofabrik-index.json`,
			}),
	});
	return manager;
}

export function ensureRoutingRegionScheduler(): void {
	if (sweepTimer || !isRegionRoutingConfigured()) return;
	const current = getRoutingRegionManager();
	current
		.resumePendingJobs()
		.catch((error) =>
			console.error("[ROUTING_REGIONS] resume failed", String(error)),
		);
	sweepTimer = setInterval(() => {
		const active = getRoutingRegionManager();
		// The retry backoff has no timer of its own; this tick is what makes a
		// region whose next attempt has come due actually get retried, with or
		// without a user request.
		active.kickJobs();
		active
			.runIdleSweep()
			.catch((error) =>
				console.error("[ROUTING_REGIONS] idle sweep failed", String(error)),
			);
	}, IDLE_SWEEP_INTERVAL_MS);
	sweepTimer.unref?.();
}

export function stopRoutingRegionScheduler(): void {
	if (sweepTimer) {
		clearInterval(sweepTimer);
		sweepTimer = null;
	}
}

// Test seam.
export function resetRoutingRegionRuntimeForTests(): void {
	stopRoutingRegionScheduler();
	manager = null;
	managerKey = "";
}
