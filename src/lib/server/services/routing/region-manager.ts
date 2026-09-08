// On-demand routing coverage: the region manager.
//
// The self-hosted OpenRouteService (ORS) can only serve the OSM extract its
// graph was built from, so a single fixed instance covers one country. This
// manager turns coverage into an on-demand resource:
//
//   point → Geofabrik region → (download extract → build graph in a dedicated
//   ORS container → ready) → base URL for that region's ORS
//
// Everything is persisted in `routing_regions` so a restart resumes, and the
// whole thing is DEGRADE-FIRST: a region that is not ready yet is reported as
// "preparing" (the tool tells the model to say so), never as an outage, and
// nothing here ever throws into the tool path.
//
// Resource discipline: one download/build at a time, an idle sweep stops
// containers nobody has routed through for a while (a stopped region restarts
// in a minute or two when needed — the graph is on disk), and a size cap keeps
// continent-scale extracts out.

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import type { DatabaseInstance } from "$lib/server/db";
import { routingRegions } from "$lib/server/db/schema";
import { deriveMirrorUrls, extractSourceLabel } from "./extract-mirrors";
import {
	findRegionsForPoint,
	type GeofabrikIndex,
	type GeofabrikRegion,
	regionSlug,
} from "./geofabrik";
import type { RegionDocker } from "./region-docker";
import type { LatLng } from "./types";

export type RoutingRegionRow = typeof routingRegions.$inferSelect;

export type RoutingRegionStatus =
	| "queued"
	| "downloading"
	| "building"
	| "ready"
	| "error";

export type RoutingRegionManagerConfig = {
	// Master switch for on-demand downloads. When false the manager still
	// serves the legacy fixed region (if any) but never downloads anything.
	enabled: boolean;
	// Host directory that holds one sub-directory per region (files, graphs …).
	regionsDir: string;
	orsImage: string;
	// JVM heap for a region's ORS container, e.g. "12g".
	xmx: string;
	portRange: { start: number; end: number };
	// Address the containers publish on and the app reaches them at.
	hostIp: string;
	idleMinutes: number;
	maxPbfBytes: number;
	buildTimeoutMs: number;
	startTimeoutMs: number;
	// Name of a running Nominatim container that should import each new
	// region's extract (`nominatim add-data`). Empty disables geocoder import.
	geocoderImportContainer: string;
	// Where `regionsDir` is mounted inside that Nominatim container.
	geocoderRegionsMount: string;
	// Extract mirrors tried, in order, when Geofabrik cannot serve the pbf.
	// Base URLs, e.g. "https://download.openstreetmap.fr/extracts".
	extractMirrors: string[];
	// Geofabrik ids kept downloaded and running: enqueued on start, never
	// stopped by the idle sweep.
	residentRegionIds: string[];
	// Abort a download that has not produced a byte for this long.
	downloadStallMs: number;
	// Hard cap on a single extract download, so a hung transfer cannot hold
	// the single job loop forever.
	downloadMaxMs: number;
	// Consecutive transient failures before a region is given up as `error`.
	maxAttempts: number;
	// The pre-existing fixed ORS instance, registered as an unmanaged region.
	legacy: { id: string; baseUrl: string } | null;
};

export type RoutingRegionManagerDeps = {
	db: DatabaseInstance;
	docker: RegionDocker;
	fetch: typeof fetch;
	loadIndex: () => Promise<GeofabrikIndex>;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	log?: (message: string, details?: Record<string, unknown>) => void;
};

export type EnsureRegionOutcome =
	| { kind: "ready"; region: RoutingRegionRow; baseUrl: string }
	| {
			kind: "preparing";
			region: RoutingRegionRow;
			status: "queued" | "downloading" | "building" | "starting";
	  }
	| { kind: "multi_region"; regions: string[] }
	| { kind: "unknown_region" }
	| { kind: "too_large"; regions: string[]; maxPbfBytes: number }
	| { kind: "disabled"; region: GeofabrikRegion }
	| { kind: "error"; region: RoutingRegionRow; message: string };

export interface RoutingRegionManager {
	ensureRegionForPoints(
		points: LatLng[],
		options?: { requestedBy?: string | null },
	): Promise<EnsureRegionOutcome>;
	listRegions(): Promise<RoutingRegionRow[]>;
	listReadyRegions(): Promise<RoutingRegionRow[]>;
	requestRegion(
		input: { id: string } | { point: LatLng },
		options?: { requestedBy?: string | null },
	): Promise<EnsureRegionOutcome>;
	retryRegion(id: string): Promise<RoutingRegionRow | null>;
	setResident(id: string, resident: boolean): Promise<RoutingRegionRow | null>;
	removeRegion(id: string): Promise<boolean>;
	runIdleSweep(): Promise<string[]>;
	resumePendingJobs(): Promise<void>;
	// Nudge the job loop (retry backoff has no timer of its own; the runtime
	// sweep timer calls this so a due retry runs without a user request).
	kickJobs(): void;
	// Wait for the in-process job loop to drain (tests / shutdown).
	drain(): Promise<void>;
}

const HEALTH_POLL_MS = 15_000;
const START_POLL_MS = 3_000;
const DEFAULT_LOG_PREFIX = "[ROUTING_REGIONS]";
// The whole Geofabrik attempt (first try plus its in-band retries) is capped
// so a persistent Geofabrik outage costs ~a minute before the mirrors run.
const GEOFABRIK_ATTEMPT_BUDGET_MS = 60_000;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;

// A failure the operator has to fix (a wrong id, an extract that is simply too
// big) must not be retried forever; anything that looks like a bad hour on the
// network must not become a terminal `error` row that only a click can clear.
const PERMANENT_ERROR_PATTERNS = [
	/above the \d+ mb cap/,
	/unknown region/,
	/no free port/,
];

const TRANSIENT_ERROR_PATTERNS = [
	// HTTP 5xx / 429 in any of the shapes we (or dockerode) produce.
	/(?:failed|error|status|code)[:\s]+(?:429|5\d\d)\b/,
	/\b(?:429|5\d\d)\s+(?:too many|internal|bad|service|gateway)/,
	/bad gateway|service unavailable|gateway time-?out|too many requests/,
	/truncated/,
	/checksum mismatch/,
	/stalled/,
	/download exceeded \d+ min/,
	/did not report a content length/,
	/timed out|timeout|etimedout|esockettimedout/,
	/network|fetch failed|socket hang up|econnreset|econnrefused|econnaborted|enotfound|eai_again|epipe|aborted/,
	/docker|image pull|pull image|manifest unknown|registry/,
];

// Classify a stored error message. Unrecognized failures are treated as
// permanent on purpose: an unknown build failure that repeats twenty times is
// worse than one that waits for an admin.
export function classifyRegionError(
	message: string | null | undefined,
): "transient" | "permanent" {
	const text = (message ?? "").toLowerCase().trim();
	if (!text) return "permanent";
	if (PERMANENT_ERROR_PATTERNS.some((pattern) => pattern.test(text))) {
		return "permanent";
	}
	return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(text))
		? "transient"
		: "permanent";
}

// 1 min, 2, 4 … capped at 1 h. `attempts` is the count *including* the failure
// that just happened, so the first retry waits RETRY_BASE_MS.
export function computeRetryDelayMs(attempts: number): number {
	const exponent = Math.max(0, attempts - 1);
	if (exponent > 30) return RETRY_MAX_MS;
	return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** exponent);
}

function defaultLog(message: string, details?: Record<string, unknown>): void {
	if (details) console.log(`${DEFAULT_LOG_PREFIX} ${message}`, details);
	else console.log(`${DEFAULT_LOG_PREFIX} ${message}`);
}

function toDate(now: () => number): Date {
	return new Date(now());
}

export function regionContainerName(slug: string): string {
	return `alfyai-ors-${slug}`;
}

export function createRoutingRegionManager(
	config: RoutingRegionManagerConfig,
	deps: RoutingRegionManagerDeps,
): RoutingRegionManager {
	const { db, docker } = deps;
	const now = deps.now ?? Date.now;
	const sleep =
		deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const log = deps.log ?? defaultLog;
	const regionsDir = resolvePath(config.regionsDir);
	const sizeCache = new Map<string, number | null>();
	let indexPromise: Promise<GeofabrikIndex> | null = null;
	let jobLoop: Promise<void> | null = null;
	let legacySeeded = false;

	async function getIndex(): Promise<GeofabrikIndex> {
		if (!indexPromise) {
			indexPromise = deps.loadIndex().catch((error) => {
				indexPromise = null;
				log("geofabrik index load failed", {
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			});
		}
		return indexPromise;
	}

	async function seedLegacy(): Promise<void> {
		if (legacySeeded) return;
		legacySeeded = true;
		if (!config.legacy) return;
		const { id, baseUrl } = config.legacy;
		const existing = await getRow(id);
		if (existing) {
			// Backfill the display name if an earlier seed ran without the index
			// (e.g. the cache directory did not exist yet on that start).
			let name = existing.name;
			if (name === existing.id) {
				try {
					name = (await getIndex()).byId.get(id)?.name ?? name;
				} catch {
					// Still optional; the next start will try again.
				}
			}
			if (
				existing.baseUrl !== baseUrl ||
				existing.status !== "ready" ||
				name !== existing.name
			) {
				await db
					.update(routingRegions)
					.set({
						name,
						baseUrl,
						status: "ready",
						managed: false,
						error: null,
						updatedAt: toDate(now),
					})
					.where(eq(routingRegions.id, id));
			}
			return;
		}
		let name = id;
		let pbfUrl = "";
		try {
			const index = await getIndex();
			const region = index.byId.get(id);
			if (region) {
				name = region.name;
				pbfUrl = region.pbfUrl;
			}
		} catch (error) {
			// The index is optional for seeding the legacy row, but a failure here
			// also means on-demand lookups will fail, so make it visible.
			log("geofabrik index unavailable while seeding legacy region", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		await db.insert(routingRegions).values({
			id,
			name,
			slug: regionSlug(id),
			pbfUrl,
			status: "ready",
			managed: false,
			baseUrl,
			geocoderStatus: "none",
			createdAt: toDate(now),
			updatedAt: toDate(now),
			readyAt: toDate(now),
		});
	}

	async function getRow(id: string): Promise<RoutingRegionRow | null> {
		const rows = await db
			.select()
			.from(routingRegions)
			.where(eq(routingRegions.id, id))
			.limit(1);
		return rows[0] ?? null;
	}

	async function updateRow(
		id: string,
		patch: Partial<typeof routingRegions.$inferInsert>,
	): Promise<void> {
		await db
			.update(routingRegions)
			.set({ ...patch, updatedAt: toDate(now) })
			.where(eq(routingRegions.id, id));
	}

	async function pbfSize(region: GeofabrikRegion): Promise<number | null> {
		if (sizeCache.has(region.id)) return sizeCache.get(region.id) ?? null;
		let size: number | null = null;
		try {
			const res = await deps.fetch(region.pbfUrl, {
				method: "HEAD",
				headers: { "user-agent": "AlfyAI" },
			});
			const length = Number(res.headers.get("content-length"));
			size = res.ok && Number.isFinite(length) && length > 0 ? length : null;
		} catch {
			size = null;
		}
		sizeCache.set(region.id, size);
		return size;
	}

	// Pick the region to serve a point: an already-known region wins (so the
	// legacy country keeps serving), otherwise the shallowest candidate whose
	// extract fits the size cap.
	async function chooseRegion(
		point: LatLng,
	): Promise<
		| { kind: "chosen"; region: GeofabrikRegion; row: RoutingRegionRow | null }
		| { kind: "unknown" }
		| { kind: "too_large"; candidates: GeofabrikRegion[] }
	> {
		const index = await getIndex();
		const candidates = findRegionsForPoint(index, point);
		if (candidates.length === 0) return { kind: "unknown" };
		const rows = await db
			.select()
			.from(routingRegions)
			.where(
				inArray(
					routingRegions.id,
					candidates.map((candidate) => candidate.id),
				),
			);
		const byId = new Map(rows.map((row) => [row.id, row]));
		for (const candidate of candidates) {
			const row = byId.get(candidate.id);
			if (row) return { kind: "chosen", region: candidate, row };
		}
		for (const candidate of candidates) {
			const size = await pbfSize(candidate);
			if (size === null || size <= config.maxPbfBytes) {
				return { kind: "chosen", region: candidate, row: null };
			}
		}
		return { kind: "too_large", candidates };
	}

	async function allocatePort(): Promise<number> {
		const rows = await db.select().from(routingRegions);
		const used = new Set(rows.map((row) => row.hostPort).filter(Boolean));
		for (
			let port = config.portRange.start;
			port <= config.portRange.end;
			port++
		) {
			if (!used.has(port)) return port;
		}
		throw new Error("No free port left in ROUTING_REGION_PORT_RANGE");
	}

	async function enqueue(
		region: GeofabrikRegion,
		requestedBy: string | null | undefined,
		options: { resident?: boolean } = {},
	): Promise<RoutingRegionRow> {
		const slug = regionSlug(region.id);
		await db
			.insert(routingRegions)
			.values({
				id: region.id,
				name: region.name,
				slug,
				pbfUrl: region.pbfUrl,
				status: "queued",
				managed: true,
				containerName: regionContainerName(slug),
				geocoderStatus: config.geocoderImportContainer ? "queued" : "none",
				resident: options.resident ?? false,
				requestedBy: requestedBy ?? null,
				createdAt: toDate(now),
				updatedAt: toDate(now),
			})
			.onConflictDoNothing();
		kick();
		const row = await getRow(region.id);
		if (!row) throw new Error(`Region ${region.id} vanished after enqueue`);
		return row;
	}

	async function healthReady(
		baseUrl: string,
		timeoutMs = 4_000,
	): Promise<boolean> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const res = await deps.fetch(`${baseUrl}/v2/health`, {
				signal: controller.signal,
			});
			if (!res.ok) return false;
			const body = (await res.json()) as { status?: unknown };
			return body?.status === "ready";
		} catch {
			return false;
		} finally {
			clearTimeout(timer);
		}
	}

	async function waitForHealth(
		baseUrl: string,
		timeoutMs: number,
		pollMs: number,
	) {
		const deadline = now() + timeoutMs;
		while (now() < deadline) {
			if (await healthReady(baseUrl)) return true;
			await sleep(pollMs);
		}
		return false;
	}

	async function ensureReadyRow(
		row: RoutingRegionRow,
	): Promise<EnsureRegionOutcome> {
		if (!row.baseUrl) {
			await updateRow(row.id, { status: "queued", error: null });
			kick();
			return { kind: "preparing", region: row, status: "queued" };
		}
		if (!row.managed || !row.containerName) {
			await updateRow(row.id, { lastUsedAt: toDate(now) });
			return { kind: "ready", region: row, baseUrl: row.baseUrl };
		}
		const state = await docker.inspectContainer(row.containerName);
		if (!state.exists) {
			log("container missing, rebuilding region", { id: row.id });
			await updateRow(row.id, { status: "queued", error: null });
			kick();
			return { kind: "preparing", region: row, status: "queued" };
		}
		if (!state.running) {
			log("starting idle region container", { id: row.id });
			await docker.startContainer(row.containerName);
			const ready = await waitForHealth(
				row.baseUrl,
				config.startTimeoutMs,
				START_POLL_MS,
			);
			if (!ready) {
				return { kind: "preparing", region: row, status: "starting" };
			}
		}
		await updateRow(row.id, { lastUsedAt: toDate(now) });
		return { kind: "ready", region: row, baseUrl: row.baseUrl };
	}

	async function ensureRegionForPoints(
		points: LatLng[],
		options?: { requestedBy?: string | null },
	): Promise<EnsureRegionOutcome> {
		await seedLegacy();
		const chosen: Array<{
			region: GeofabrikRegion;
			row: RoutingRegionRow | null;
		}> = [];
		for (const point of points) {
			const choice = await chooseRegion(point);
			if (choice.kind === "unknown") return { kind: "unknown_region" };
			if (choice.kind === "too_large") {
				return {
					kind: "too_large",
					regions: choice.candidates.map((candidate) => candidate.name),
					maxPbfBytes: config.maxPbfBytes,
				};
			}
			chosen.push({ region: choice.region, row: choice.row });
		}
		const distinct = new Map(chosen.map((entry) => [entry.region.id, entry]));
		if (distinct.size > 1) {
			return {
				kind: "multi_region",
				regions: Array.from(distinct.values()).map(
					(entry) => entry.region.name,
				),
			};
		}
		const [entry] = chosen;
		if (!entry) return { kind: "unknown_region" };
		let row = entry.row;
		if (!row) {
			if (!config.enabled) return { kind: "disabled", region: entry.region };
			row = await enqueue(entry.region, options?.requestedBy);
		}
		switch (row.status) {
			case "ready":
				return ensureReadyRow(row);
			case "error":
				return {
					kind: "error",
					region: row,
					message: row.error ?? "unknown error",
				};
			case "queued":
			case "downloading":
			case "building":
				kick();
				return { kind: "preparing", region: row, status: row.status };
			default:
				return { kind: "preparing", region: row, status: "queued" };
		}
	}

	// ── Job loop ─────────────────────────────────────────────────

	function kick(): void {
		if (jobLoop) return;
		jobLoop = runJobs()
			.catch((error) => log("job loop crashed", { error: String(error) }))
			.finally(() => {
				jobLoop = null;
			});
	}

	async function runJobs(): Promise<void> {
		if (!config.enabled) return;
		for (;;) {
			// A row waiting out its retry backoff is invisible to the loop, so a
			// failing region never spins and never blocks the ones behind it.
			const rows = await db
				.select()
				.from(routingRegions)
				.where(
					and(
						inArray(routingRegions.status, [
							"queued",
							"downloading",
							"building",
						]),
						or(
							isNull(routingRegions.nextAttemptAt),
							lte(routingRegions.nextAttemptAt, toDate(now)),
						),
					),
				)
				.orderBy(asc(routingRegions.createdAt))
				.limit(1);
			const row = rows[0];
			if (!row?.managed) return;
			try {
				await buildRegion(row);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await recordFailure(row, message);
			}
		}
	}

	async function recordFailure(
		row: RoutingRegionRow,
		message: string,
	): Promise<void> {
		const attempts = (row.attempts ?? 0) + 1;
		const kind = classifyRegionError(message);
		if (kind === "transient" && attempts < config.maxAttempts) {
			const delayMs = computeRetryDelayMs(attempts);
			log("region build failed, retrying later", {
				id: row.id,
				attempts,
				retryInSeconds: Math.round(delayMs / 1000),
				error: message,
			});
			await updateRow(row.id, {
				status: "queued",
				attempts,
				nextAttemptAt: new Date(now() + delayMs),
				error: message.slice(0, 1000),
			});
			return;
		}
		log("region build failed", { id: row.id, attempts, kind, error: message });
		await updateRow(row.id, {
			status: "error",
			attempts,
			nextAttemptAt: null,
			error: message.slice(0, 1000),
		});
	}

	function regionPaths(slug: string) {
		const root = `${regionsDir}/${slug}`;
		return {
			root,
			files: `${root}/files`,
			graphs: `${root}/graphs`,
			logs: `${root}/logs`,
			config: `${root}/config`,
			elevation: `${root}/elevation_cache`,
			pbf: `${root}/files/${slug}.osm.pbf`,
		};
	}

	async function buildRegion(row: RoutingRegionRow): Promise<void> {
		const paths = regionPaths(row.slug);
		await Promise.all(
			[
				paths.files,
				paths.graphs,
				paths.logs,
				paths.config,
				paths.elevation,
			].map((dir) => mkdir(dir, { recursive: true })),
		);

		// 1. Download (skipped when a complete extract is already on disk).
		const existing = await stat(paths.pbf).catch(() => null);
		if (!existing) {
			await updateRow(row.id, { status: "downloading", error: null });
			const { bytes, source } = await downloadPbf(
				row.pbfUrl,
				paths.pbf,
				row.id,
			);
			await updateRow(row.id, { pbfSizeBytes: bytes, extractSource: source });
		} else {
			await updateRow(row.id, { pbfSizeBytes: existing.size });
		}

		// 2. Build the graph inside a dedicated ORS container.
		const hostPort = row.hostPort ?? (await allocatePort());
		const containerName = row.containerName ?? regionContainerName(row.slug);
		const baseUrl = `http://${config.hostIp}:${hostPort}/ors`;
		await updateRow(row.id, {
			status: "building",
			hostPort,
			containerName,
			baseUrl,
		});
		const state = await docker.inspectContainer(containerName);
		if (!state.exists) {
			await docker.pullImage(config.orsImage);
			await docker.createContainer({
				name: containerName,
				image: config.orsImage,
				hostIp: config.hostIp,
				hostPort,
				containerPort: 8082,
				labels: { "ai.alfy.routing-region": row.id },
				binds: [
					`${paths.graphs}:/home/ors/graphs`,
					`${paths.elevation}:/home/ors/elevation_cache`,
					`${paths.files}:/home/ors/files`,
					`${paths.logs}:/home/ors/logs`,
					`${paths.config}:/home/ors/config`,
				],
				env: [
					"REBUILD_GRAPHS=False",
					"CONTAINER_LOG_LEVEL=INFO",
					"XMS=2g",
					`XMX=${config.xmx}`,
					`ors.engine.profile_default.build.source_file=/home/ors/files/${row.slug}.osm.pbf`,
					"ors.engine.profiles.driving-car.enabled=true",
					"ors.engine.profiles.foot-walking.enabled=true",
					"ors.engine.profiles.cycling-regular.enabled=true",
					"ors.engine.profile_default.service.maximum_distance=1000000",
					"ors.engine.profile_default.service.maximum_distance_dynamic_weights=1000000",
					"ors.engine.profile_default.service.maximum_snapping_radius=2000",
					"ors.endpoints.isochrones.maximum_range_distance_default=200000",
					"ors.endpoints.isochrones.maximum_range_time_default=18000",
				],
			});
		}
		await docker.startContainer(containerName);
		log("waiting for graph build", { id: row.id, baseUrl });
		const ready = await waitForHealth(
			baseUrl,
			config.buildTimeoutMs,
			HEALTH_POLL_MS,
		);
		if (!ready) {
			throw new Error(
				`ORS did not become ready within ${Math.round(config.buildTimeoutMs / 60000)} min`,
			);
		}
		await updateRow(row.id, {
			status: "ready",
			error: null,
			attempts: 0,
			nextAttemptAt: null,
			readyAt: toDate(now),
			lastUsedAt: toDate(now),
		});
		log("region ready", { id: row.id, baseUrl });

		// 3. Best-effort geocoder import; never affects routing readiness.
		if (config.geocoderImportContainer && row.geocoderStatus !== "ready") {
			await importIntoGeocoder(row, paths.pbf);
		}
	}

	// Geofabrik occasionally answers 5xx or drops a connection; retry transient
	// failures in-band before falling through to the mirrors. The whole attempt
	// is budgeted so a hard Geofabrik outage costs about a minute, not more.
	async function fetchGeofabrikWithRetry(
		url: string,
		signal: AbortSignal,
	): Promise<Response> {
		const delays = [5_000, 15_000, 45_000];
		const deadline = now() + GEOFABRIK_ATTEMPT_BUDGET_MS;
		let lastError: Error = new Error("extract download failed");
		for (let attempt = 0; attempt <= delays.length; attempt++) {
			try {
				return await fetchExtract(url, signal);
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				// Client errors other than 429 are permanent here (wrong URL, gone).
				if (/download failed: 4(?!29)\d\d/.test(lastError.message)) break;
			}
			const delay = delays[attempt];
			if (delay === undefined || now() + delay > deadline) break;
			log("extract download retry", {
				url,
				attempt: attempt + 1,
				error: lastError.message,
			});
			await sleep(delay);
		}
		throw lastError;
	}

	async function fetchExtract(
		url: string,
		signal: AbortSignal,
		headers: Record<string, string> = {},
	): Promise<Response> {
		const res = await deps.fetch(url, {
			headers: { "user-agent": "AlfyAI", ...headers },
			signal,
		});
		if (!res.ok || !res.body) {
			await res.body?.cancel().catch(() => undefined);
			throw new Error(
				`extract download failed: ${res.status} ${res.statusText}`,
			);
		}
		return res;
	}

	function contentLength(res: Response): number | null {
		const raw = Number(res.headers.get("content-length"));
		return Number.isFinite(raw) && raw > 0 ? raw : null;
	}

	// Cheap liveness/existence check so a mirror that simply does not carry a
	// region (osm.fr has no `hungary`) costs one request instead of a transfer.
	async function probeMirror(
		url: string,
		signal: AbortSignal,
	): Promise<{ ok: true } | { ok: false; message: string }> {
		const attempt = async (
			init: RequestInit,
		): Promise<{ ok: true } | { ok: false; message: string }> => {
			const res = await deps.fetch(url, {
				headers: { "user-agent": "AlfyAI", ...(init.headers ?? {}) },
				...init,
				signal,
			});
			await res.body?.cancel().catch(() => undefined);
			return res.ok
				? { ok: true }
				: { ok: false, message: `mirror probe failed: ${res.status}` };
		};
		try {
			const head = await attempt({ method: "HEAD" });
			if (head.ok) return head;
			// Some mirrors refuse HEAD; a one-byte range answers the same question.
			if (/failed: (?:403|405|501)$/.test(head.message)) {
				return await attempt({ headers: { range: "bytes=0-0" } });
			}
			return head;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, message: `mirror probe failed: ${message}` };
		}
	}

	// Stream one response into `part`, aborting on a stall (no bytes for
	// downloadStallMs) or on the overall cap. Both are enforced on the Node
	// stream itself, not only on the fetch signal, so a source that ignores
	// AbortSignal still cannot wedge the single job loop.
	async function streamToPart(
		res: Response,
		part: string,
		controller: AbortController,
	): Promise<{ bytes: number; md5: string }> {
		const hash = createHash("md5");
		let bytes = 0;
		let aborted: Error | null = null;
		const body = Readable.fromWeb(res.body as never);
		const abortWith = (message: string) => {
			aborted = new Error(message);
			controller.abort();
			body.destroy(aborted);
		};
		let stallTimer: ReturnType<typeof setTimeout> | null = null;
		const armStall = () => {
			if (stallTimer) clearTimeout(stallTimer);
			stallTimer = setTimeout(() => {
				abortWith(
					`extract download stalled (no data for ${Math.round(config.downloadStallMs / 1000)}s)`,
				);
			}, config.downloadStallMs);
			stallTimer.unref?.();
		};
		const overallTimer = setTimeout(() => {
			abortWith(
				`extract download exceeded ${Math.round(config.downloadMaxMs / 60000)} min`,
			);
		}, config.downloadMaxMs);
		overallTimer.unref?.();
		armStall();
		body.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			hash.update(chunk);
			armStall();
		});
		try {
			await pipeline(body, createWriteStream(part));
		} catch (error) {
			throw (
				aborted ?? (error instanceof Error ? error : new Error(String(error)))
			);
		} finally {
			if (stallTimer) clearTimeout(stallTimer);
			clearTimeout(overallTimer);
		}
		if (aborted) throw aborted;
		return { bytes, md5: hash.digest("hex") };
	}

	function assertUnderCap(expectedLength: number | null): void {
		if (expectedLength !== null && expectedLength > config.maxPbfBytes) {
			throw new Error(
				`extract is ${Math.round(expectedLength / 1048576)} MB, above the ${Math.round(config.maxPbfBytes / 1048576)} MB cap`,
			);
		}
	}

	// Download from one source into `target`. Geofabrik publishes a `.md5` for
	// every extract and is checked against it; mirrors do not, so their only
	// integrity signal is an exact Content-Length match, which is therefore
	// required rather than optional.
	async function downloadFrom(
		candidate: { url: string; kind: "geofabrik" | "mirror" },
		target: string,
	): Promise<number> {
		const part = `${target}.part`;
		await rm(part, { force: true });
		const controller = new AbortController();
		try {
			if (candidate.kind === "mirror") {
				const probe = await probeMirror(candidate.url, controller.signal);
				if (!probe.ok) throw new Error(probe.message);
			}
			const res =
				candidate.kind === "geofabrik"
					? await fetchGeofabrikWithRetry(candidate.url, controller.signal)
					: await fetchExtract(candidate.url, controller.signal);
			const expectedLength = contentLength(res);
			assertUnderCap(expectedLength);
			if (candidate.kind === "mirror" && expectedLength === null) {
				await res.body?.cancel().catch(() => undefined);
				throw new Error("mirror did not report a content length");
			}
			const { bytes, md5 } = await streamToPart(res, part, controller);
			if (expectedLength !== null && bytes !== expectedLength) {
				throw new Error(
					`extract download truncated (${bytes} of ${expectedLength} bytes)`,
				);
			}
			if (candidate.kind === "geofabrik") {
				const expectedMd5 = await fetchMd5(candidate.url);
				if (expectedMd5 && expectedMd5 !== md5) {
					throw new Error("extract checksum mismatch");
				}
			}
			await rename(part, target);
			return bytes;
		} catch (error) {
			await rm(part, { force: true }).catch(() => undefined);
			throw error;
		}
	}

	// Geofabrik first (it is the catalogue and the only source with checksums),
	// then each configured mirror in order.
	async function downloadPbf(
		pbfUrl: string,
		target: string,
		regionId: string,
	): Promise<{ bytes: number; source: string }> {
		const candidates: Array<{ url: string; kind: "geofabrik" | "mirror" }> = [
			{ url: pbfUrl, kind: "geofabrik" },
			...deriveMirrorUrls(pbfUrl, config.extractMirrors).map((url) => ({
				url,
				kind: "mirror" as const,
			})),
		];
		const failures: string[] = [];
		for (const candidate of candidates) {
			const source = extractSourceLabel(candidate.url);
			await updateRow(regionId, { extractSource: source });
			log("downloading extract", {
				id: regionId,
				url: candidate.url,
				source,
			});
			try {
				const bytes = await downloadFrom(candidate, target);
				log("extract downloaded", { id: regionId, source, bytes });
				return { bytes, source };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				// An extract that is over the cap is over the cap everywhere.
				if (/above the \d+ MB cap/.test(message)) throw error;
				log("extract source failed", { id: regionId, source, error: message });
				failures.push(`${source}: ${message}`);
			}
		}
		throw new Error(failures.join("; ") || "extract download failed");
	}

	async function fetchMd5(url: string): Promise<string | null> {
		try {
			const res = await deps.fetch(`${url}.md5`, {
				headers: { "user-agent": "AlfyAI" },
			});
			if (!res.ok) return null;
			const text = await res.text();
			const match = text.trim().match(/^([0-9a-f]{32})/i);
			return match ? match[1].toLowerCase() : null;
		} catch {
			return null;
		}
	}

	async function importIntoGeocoder(row: RoutingRegionRow, pbfPath: string) {
		const container = config.geocoderImportContainer;
		const mounted = `${config.geocoderRegionsMount}/${row.slug}/files/${row.slug}.osm.pbf`;
		await updateRow(row.id, { geocoderStatus: "importing" });
		log("importing extract into geocoder", { id: row.id, container, pbfPath });
		try {
			const state = await docker.inspectContainer(container);
			if (!state.running)
				throw new Error(`geocoder container ${container} is not running`);
			const add = await docker.exec(container, [
				"sudo",
				"-E",
				"-u",
				"nominatim",
				"nominatim",
				"add-data",
				"--file",
				mounted,
			]);
			if (add.exitCode !== 0) {
				throw new Error(
					`nominatim add-data exited ${add.exitCode}: ${add.output.slice(-500)}`,
				);
			}
			const index = await docker.exec(container, [
				"sudo",
				"-E",
				"-u",
				"nominatim",
				"nominatim",
				"index",
			]);
			if (index.exitCode !== 0) {
				throw new Error(
					`nominatim index exited ${index.exitCode}: ${index.output.slice(-500)}`,
				);
			}
			await updateRow(row.id, { geocoderStatus: "ready" });
			log("geocoder import done", { id: row.id });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log("geocoder import failed", { id: row.id, error: message });
			await updateRow(row.id, {
				geocoderStatus: "error",
				error: `geocoder: ${message.slice(0, 900)}`,
			});
		}
	}

	// ── Admin / maintenance ──────────────────────────────────────

	async function listRegions(): Promise<RoutingRegionRow[]> {
		await seedLegacy();
		return db
			.select()
			.from(routingRegions)
			.orderBy(asc(routingRegions.createdAt));
	}

	async function listReadyRegions(): Promise<RoutingRegionRow[]> {
		return (await listRegions()).filter((row) => row.status === "ready");
	}

	async function requestRegion(
		input: { id: string } | { point: LatLng },
		options?: { requestedBy?: string | null },
	): Promise<EnsureRegionOutcome> {
		if ("point" in input) {
			return ensureRegionForPoints([input.point], options);
		}
		await seedLegacy();
		const existing = await getRow(input.id);
		if (existing) {
			return existing.status === "ready"
				? ensureReadyRow(existing)
				: existing.status === "error"
					? { kind: "error", region: existing, message: existing.error ?? "" }
					: {
							kind: "preparing",
							region: existing,
							status: existing.status as never,
						};
		}
		const index = await getIndex();
		const region = index.byId.get(input.id);
		if (!region) return { kind: "unknown_region" };
		if (!config.enabled) return { kind: "disabled", region };
		const row = await enqueue(region, options?.requestedBy);
		return { kind: "preparing", region: row, status: "queued" };
	}

	async function retryRegion(id: string): Promise<RoutingRegionRow | null> {
		const row = await getRow(id);
		if (!row?.managed) return row;
		// An explicit admin retry clears the backoff entirely: run it now.
		await updateRow(id, {
			status: "queued",
			error: null,
			attempts: 0,
			nextAttemptAt: null,
		});
		kick();
		return getRow(id);
	}

	async function setResident(
		id: string,
		resident: boolean,
	): Promise<RoutingRegionRow | null> {
		const row = await getRow(id);
		if (!row) return null;
		await updateRow(id, { resident });
		// Promoting a region that fell over transiently should also get it going
		// again — that is the whole point of asking for it to be resident.
		if (
			resident &&
			row.managed &&
			row.status === "error" &&
			classifyRegionError(row.error) === "transient"
		) {
			await updateRow(id, {
				status: "queued",
				error: null,
				attempts: 0,
				nextAttemptAt: null,
			});
			kick();
		}
		return getRow(id);
	}

	async function removeRegion(id: string): Promise<boolean> {
		const row = await getRow(id);
		if (!row) return false;
		if (row.managed && row.containerName) {
			await docker.stopContainer(row.containerName).catch(() => undefined);
			await docker.removeContainer(row.containerName).catch(() => undefined);
			await rm(regionPaths(row.slug).root, {
				recursive: true,
				force: true,
			}).catch(() => undefined);
		}
		await db.delete(routingRegions).where(eq(routingRegions.id, id));
		return true;
	}

	async function runIdleSweep(): Promise<string[]> {
		const cutoff = now() - config.idleMinutes * 60_000;
		const rows = await db
			.select()
			.from(routingRegions)
			.where(eq(routingRegions.status, "ready"));
		const stopped: string[] = [];
		for (const row of rows) {
			if (!row.managed || !row.containerName) continue;
			// Resident regions stay up no matter how long nobody routed there.
			if (row.resident) continue;
			const lastUsed = row.lastUsedAt?.getTime() ?? row.readyAt?.getTime() ?? 0;
			if (lastUsed > cutoff) continue;
			const state = await docker
				.inspectContainer(row.containerName)
				.catch(() => null);
			if (!state?.running) continue;
			log("stopping idle region container", { id: row.id });
			await docker
				.stopContainer(row.containerName)
				.catch((error) =>
					log("idle stop failed", { id: row.id, error: String(error) }),
				);
			stopped.push(row.id);
		}
		return stopped;
	}

	// Every configured resident id exists as a resident row after this, whether
	// it was already known, known but not resident, or not in the table at all.
	async function ensureResidentRegions(): Promise<void> {
		for (const id of config.residentRegionIds) {
			const existing = await getRow(id);
			if (existing) {
				if (!existing.resident) {
					log("marking region resident", { id });
					await updateRow(id, { resident: true });
				}
				continue;
			}
			if (!config.enabled) continue;
			let region: GeofabrikRegion | undefined;
			try {
				region = (await getIndex()).byId.get(id);
			} catch (error) {
				log("resident region lookup failed", { id, error: String(error) });
				continue;
			}
			if (!region) {
				log("resident region id is not in the Geofabrik catalogue", { id });
				continue;
			}
			log("enqueueing resident region", { id });
			await enqueue(region, null, { resident: true });
		}
	}

	// A resident region that died on a bad hour at Geofabrik must come back by
	// itself on the next deploy — that failure mode is exactly what left
	// Ireland sitting in `error` with a 502 for two days.
	async function requeueTransientResidentErrors(): Promise<void> {
		const rows = await db
			.select()
			.from(routingRegions)
			.where(eq(routingRegions.status, "error"));
		for (const row of rows) {
			if (!row.managed || !row.resident) continue;
			if (classifyRegionError(row.error) !== "transient") continue;
			log("re-queueing resident region after a transient failure", {
				id: row.id,
				error: row.error,
			});
			await updateRow(row.id, {
				status: "queued",
				attempts: 0,
				nextAttemptAt: null,
				error: null,
			});
		}
	}

	async function resumePendingJobs(): Promise<void> {
		await seedLegacy();
		await ensureResidentRegions();
		await requeueTransientResidentErrors();
		kick();
	}

	async function drain(): Promise<void> {
		while (jobLoop) {
			await jobLoop;
		}
	}

	return {
		ensureRegionForPoints,
		listRegions,
		listReadyRegions,
		requestRegion,
		retryRegion,
		setResident,
		removeRegion,
		runIdleSweep,
		resumePendingJobs,
		kickJobs: kick,
		drain,
	};
}
