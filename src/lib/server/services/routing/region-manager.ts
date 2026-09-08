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
import {
	mkdir,
	open as openFile,
	readdir,
	rename,
	rm,
	stat,
} from "node:fs/promises";
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
import type { GtfsFeed } from "./gtfs-catalogue";
import { timezoneForRegion } from "./gtfs-feeds";
import type { RegionDocker } from "./region-docker";
import { type LatLng, PUBLIC_TRANSPORT_PROFILE } from "./types";

export type RoutingRegionRow = typeof routingRegions.$inferSelect;

export type RoutingRegionStatus =
	| "queued"
	| "downloading"
	| "building"
	| "ready"
	| "error";

// Public-transport readiness, tracked SEPARATELY from `status` because the two
// are genuinely independent: a region routes cars as soon as its road graph is
// built, whether or not a GTFS timetable graph exists (or ever will).
export type RoutingTransitStatus =
	| "none"
	| "queued"
	| "building"
	| "ready"
	| "error";

// Per-feed download state, persisted as JSON on `routing_regions.gtfs_feeds`.
// One entry per CONFIGURED feed, whether or not it downloaded: an entry with
// an `error` and no `downloadedAt` is a feed that has never made it to disk,
// which the admin table shows and the build skips.
export type GtfsFeedState = {
	id: string;
	url: string;
	// Bytes on disk, and when it last landed there. Absent until one download
	// has succeeded.
	bytes?: number;
	downloadedAt?: number;
	// Validators from the last successful response, replayed as
	// If-None-Match / If-Modified-Since so a refresh of an unchanged feed costs
	// a 304 instead of a transfer.
	etag?: string;
	lastModified?: string;
	// The last failure, cleared by the next success. A feed with an error AND a
	// downloadedAt is still usable — the old copy is on disk.
	error?: string;
};

// A feed's state list is written and read whole; anything unparseable is
// treated as "no state yet" rather than failing a build over a bad row.
export function parseGtfsFeedStates(raw: string | null): GtfsFeedState[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(entry): entry is GtfsFeedState =>
				Boolean(entry) &&
				typeof entry === "object" &&
				typeof (entry as GtfsFeedState).id === "string" &&
				typeof (entry as GtfsFeedState).url === "string",
		);
	} catch {
		return [];
	}
}

// Feeds whose zip is on disk and current, in configured order — exactly what
// goes into `gtfs_file`.
export function loadedGtfsFeedIds(raw: string | null): string[] {
	return parseGtfsFeedStates(raw)
		.filter((state) => typeof state.downloadedAt === "number")
		.map((state) => state.id);
}

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
	// Geofabrik region id → the GTFS feeds that cover it, already resolved from
	// the catalogue and ROUTING_GTFS_FEEDS/_EXCLUDE. A region listed here gets a
	// `public-transport` profile whose `gtfs_file` is the comma-joined list of
	// the feeds that downloaded successfully.
	gtfsFeeds: Map<string, GtfsFeed[]>;
	// Default staleness before a feed is re-downloaded and its PT graph rebuilt
	// (during the nightly window only). A catalogue feed's own `refreshDays`
	// wins over this.
	gtfsRefreshMs: number;
	// Hard cap on a single GTFS download.
	gtfsMaxBytes: number;
	// Local-clock window in which an AUTOMATIC timetable refresh may start.
	// A PT rebuild stops the region's container for the duration of the build,
	// so it must not land in the middle of the day. An explicit admin refresh
	// ignores this window.
	transitRefreshWindow: { startHour: number; endHour: number };
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

// One row of the admin timetable table: what is configured, joined with what
// actually happened to it.
export type TransitFeedView = {
	id: string;
	name: string;
	url: string;
	licence?: string;
	official?: boolean;
	notes?: string;
	// ready  — on disk and in (or headed for) the graph
	// stale  — on disk but past its refresh interval
	// error  — the last attempt failed and nothing is on disk
	// pending — configured, never downloaded, no failure recorded yet
	status: "ready" | "stale" | "error" | "pending";
	bytes?: number;
	downloadedAt?: number;
	error?: string;
	refreshDays: number;
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
	// Regions whose public-transport graph is loaded and serving timetables.
	listTransitReadyRegions(): Promise<RoutingRegionRow[]>;
	// Admin "Refresh timetable": re-download the feeds and rebuild ONLY the
	// public-transport graph, ignoring the nightly window.
	refreshTransit(id: string): Promise<RoutingRegionRow | null>;
	// Admin per-feed retry: clear ONE feed's recorded failure and queue the
	// region's timetable rebuild, which re-downloads what is missing or stale
	// and leaves the feeds already on disk alone.
	retryTransitFeed(
		id: string,
		feedId: string,
	): Promise<RoutingRegionRow | null>;
	// The configured feeds of a region joined with their recorded state, for
	// the admin table. Returns [] for a region with no feeds configured.
	describeTransitFeeds(row: RoutingRegionRow): TransitFeedView[];
	requestRegion(
		input: { id: string } | { point: LatLng },
		options?: { requestedBy?: string | null },
	): Promise<EnsureRegionOutcome>;
	retryRegion(id: string): Promise<RoutingRegionRow | null>;
	setResident(id: string, resident: boolean): Promise<RoutingRegionRow | null>;
	removeRegion(id: string): Promise<boolean>;
	runIdleSweep(): Promise<string[]>;
	// Reconciles configured GTFS feeds and queues any timetable refresh that
	// has come due inside the nightly window. Returns the ids it queued.
	runTransitMaintenance(): Promise<string[]>;
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
		if (existing?.managed) {
			// The legacy region was promoted to a managed container (see
			// promoteLegacyRegion). Re-seeding it would point it back at the old
			// fixed instance and undo the promotion on every restart.
			return;
		}
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
			if (!row?.managed) {
				// No road build is pending; timetable work runs in the same single
				// job loop so a PT rebuild never overlaps a graph build.
				if (await runTransitJob()) continue;
				return;
			}
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
			// One zip PER FEED. GraphHopper comma-splits `gtfs_file`, so the
			// region's timetable graph is built from every one of these that is
			// on disk. The path is derived from the feed id, which is stable for
			// a catalogue feed and digest-derived for a hand-configured URL.
			gtfs: (feedId: string) => `${root}/files/${slug}-gtfs-${feedId}.zip`,
			// The public-transport graph. Deleting THIS directory (and nothing
			// else) is what forces ORS to rebuild only the timetable graph:
			// REBUILD_GRAPHS=False makes it reuse every other profile's graph.
			transitGraph: `${root}/graphs/${PUBLIC_TRANSPORT_PROFILE}`,
		};
	}

	// The `public-transport` profile block, appended to a region's container
	// env only when a GTFS feed is configured for it. Key names come from the
	// ORS 9.10.0 config template's profile block:
	//   public-transport:
	//     encoder_name: public-transport
	//     build: { elevation: …, gtfs_file: … }
	//     service: { maximum_visited_nodes: 1000000 }
	// `build.elevation` is forced OFF so a timetable build never waits on (or
	// fails over) the SRTM elevation cache the road profiles use.
	//
	// `gtfs_file` is the COMMA-JOINED list of absolute container paths: ORS
	// passes the string through `Path.toAbsolutePath()` untouched and
	// GraphHopper 4.14's GraphHopperGtfs splits it on commas, loading each zip
	// as feed `gtfs_<n>`. Overlapping feeds are fine — a change between two
	// operators is a walk on the street graph like any other transfer.
	function transitEnv(slug: string, feedIds: string[]): string[] {
		const files = feedIds
			.map((feedId) => `/home/ors/files/${slug}-gtfs-${feedId}.zip`)
			.join(",");
		return [
			`ors.engine.profiles.${PUBLIC_TRANSPORT_PROFILE}.enabled=true`,
			`ors.engine.profiles.${PUBLIC_TRANSPORT_PROFILE}.encoder_name=${PUBLIC_TRANSPORT_PROFILE}`,
			`ors.engine.profiles.${PUBLIC_TRANSPORT_PROFILE}.build.gtfs_file=${files}`,
			`ors.engine.profiles.${PUBLIC_TRANSPORT_PROFILE}.build.elevation=false`,
			`ors.engine.profiles.${PUBLIC_TRANSPORT_PROFILE}.service.maximum_visited_nodes=1000000`,
		];
	}

	function feedsFor(id: string): GtfsFeed[] {
		return config.gtfsFeeds.get(id) ?? [];
	}

	// The configured set, as a single string, so a changed config (a feed added,
	// removed or re-pointed) is one comparison against `gtfs_url`.
	function feedFingerprint(feeds: GtfsFeed[]): string | null {
		if (feeds.length === 0) return null;
		return feeds.map((feed) => `${feed.id}=${feed.url}`).join("|");
	}

	function feedRefreshMs(feed: GtfsFeed): number {
		return feed.refreshDays && feed.refreshDays > 0
			? feed.refreshDays * 24 * 60 * 60 * 1000
			: config.gtfsRefreshMs;
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

		// 1b. Timetable feeds (optional, and MANY per region). A feed that cannot
		// be fetched costs the region THAT OPERATOR'S trips and nothing else:
		// the build uses whichever feeds did land, and only a region where every
		// feed failed is recorded as a transit error. A bad hour at one transit
		// agency's web server must never cost a country its routing, nor its
		// other operators' timetables.
		const feeds = feedsFor(row.id);
		let readyFeedIds: string[] = [];
		// Held until after the road build, because the "region ready" update
		// clears `error` — writing the feed failure earlier would erase it.
		let feedError: string | null = null;
		if (feeds.length > 0) {
			const outcome = await downloadTransitFeeds(row, feeds);
			readyFeedIds = outcome.readyFeedIds;
			if (readyFeedIds.length === 0) {
				feedError =
					outcome.failures.join("; ") ||
					"no timetable feed could be downloaded";
				log("every gtfs feed failed", { id: row.id, error: feedError });
			}
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
			await createRegionContainer(row, hostPort, containerName);
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
		// The container was created WITH the public-transport profile when the
		// feed was on disk, so the timetable graph is built by the same start.
		// With no feed on disk there is nothing to wait for — only a failure to
		// record, now that the road build is no longer overwriting `error`.
		if (readyFeedIds.length > 0) {
			await settleTransitReadiness(row.id, baseUrl);
		} else if (feedError) {
			await updateRow(row.id, {
				transitStatus: "error",
				error: `transit: ${feedError.slice(0, 900)}`,
			});
		}

		// 3. Best-effort geocoder import; never affects routing readiness.
		if (config.geocoderImportContainer && row.geocoderStatus !== "ready") {
			await importIntoGeocoder(row, paths.pbf);
		}
	}

	// ── Public transport (GTFS) ──────────────────────────────────

	// Creates the region's ORS container. The `public-transport` profile is
	// added only when the region's GTFS zip is already on disk, so a container
	// is never asked to build a timetable graph from a file that is not there.
	async function createRegionContainer(
		row: RoutingRegionRow,
		hostPort: number,
		containerName: string,
	): Promise<void> {
		const paths = regionPaths(row.slug);
		const onDisk = await feedsOnDisk(row);
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
				...(onDisk.length > 0 ? transitEnv(row.slug, onDisk) : []),
			],
		});
	}

	// Which of a region's CONFIGURED feeds have a zip on disk right now, in
	// configured order. This — not the recorded state — is what decides the
	// container's `gtfs_file`, so ORS is never pointed at a file that is not
	// there.
	async function feedsOnDisk(row: RoutingRegionRow): Promise<string[]> {
		const paths = regionPaths(row.slug);
		const present: string[] = [];
		for (const feed of feedsFor(row.id)) {
			if (await stat(paths.gtfs(feed.id)).catch(() => null)) {
				present.push(feed.id);
			}
		}
		return present;
	}

	// Downloads every configured feed that is missing, whose URL changed, or
	// that is past its own refresh interval. Each feed is independent: one
	// failure is recorded against that feed and the rest carry on.
	//
	// There is no "force" flag, deliberately. Wanting a feed re-fetched is
	// expressed by FORGETTING its download timestamp (see `refreshTransit` and
	// `retryTransitFeed`), which is what makes a per-feed retry cost one small
	// download instead of re-pulling a country's twenty-one feeds.
	//
	// GTFS feeds publish no checksum, so integrity rests on (a) an exact
	// Content-Length match WHEN the server sends one — several of the Hungarian
	// city feeds are generated on the fly and send none — and (b) the zip magic
	// number, which catches an HTML error page served with a 200.
	async function downloadTransitFeeds(
		row: RoutingRegionRow,
		feeds: GtfsFeed[],
	): Promise<{ readyFeedIds: string[]; failures: string[] }> {
		const paths = regionPaths(row.slug);
		await mkdir(paths.files, { recursive: true });
		const prior = new Map(
			parseGtfsFeedStates(row.gtfsFeeds).map((state) => [state.id, state]),
		);
		const states: GtfsFeedState[] = [];
		const readyFeedIds: string[] = [];
		const failures: string[] = [];
		for (const feed of feeds) {
			const target = paths.gtfs(feed.id);
			const previous = prior.get(feed.id);
			const onDisk = await stat(target).catch(() => null);
			const unchangedUrl = previous?.url === feed.url;
			const fresh = !feedIsDue(feed, previous);
			if (onDisk && fresh) {
				states.push({
					...previous,
					id: feed.id,
					url: feed.url,
					bytes: onDisk.size,
				});
				readyFeedIds.push(feed.id);
				continue;
			}
			try {
				log("downloading gtfs feed", {
					id: row.id,
					feed: feed.id,
					url: feed.url,
				});
				// Revalidate only a feed whose current file we would otherwise
				// keep: a changed URL, or a missing file, must be a full fetch.
				const validators = onDisk && unchangedUrl ? previous : undefined;
				const result = await downloadFeedFile(feed.url, target, validators);
				const bytes = result.bytes ?? onDisk?.size ?? previous?.bytes;
				states.push({
					id: feed.id,
					url: feed.url,
					...(bytes === undefined ? {} : { bytes }),
					downloadedAt: now(),
					...(result.etag ? { etag: result.etag } : {}),
					...(result.lastModified ? { lastModified: result.lastModified } : {}),
				});
				readyFeedIds.push(feed.id);
				log(
					result.notModified ? "gtfs feed unchanged" : "gtfs feed downloaded",
					{ id: row.id, feed: feed.id, bytes },
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				failures.push(`${feed.id}: ${message}`);
				// A feed that failed but still has yesterday's zip on disk keeps
				// serving it: stale trips beat no trips, and the error is visible
				// in the admin table either way.
				const usable = Boolean(onDisk) && unchangedUrl;
				states.push({
					...(usable && previous ? previous : {}),
					id: feed.id,
					url: feed.url,
					...(usable && onDisk ? { bytes: onDisk.size } : {}),
					error: message.slice(0, 400),
				});
				if (usable) readyFeedIds.push(feed.id);
				log("gtfs feed download failed", {
					id: row.id,
					feed: feed.id,
					error: message,
				});
			}
		}
		await pruneStaleFeedFiles(row, feeds);
		const downloadedAt = states
			.map((state) => state.downloadedAt ?? 0)
			.reduce((max, value) => Math.max(max, value), 0);
		const totalBytes = states
			.filter((state) => readyFeedIds.includes(state.id))
			.reduce((total, state) => total + (state.bytes ?? 0), 0);
		await updateRow(row.id, {
			gtfsUrl: feedFingerprint(feeds),
			gtfsFeeds: JSON.stringify(states),
			gtfsSizeBytes: totalBytes || null,
			...(downloadedAt > 0 ? { gtfsDownloadedAt: new Date(downloadedAt) } : {}),
			timezone: row.timezone ?? (await regionTimezone(row.id)),
		});
		return { readyFeedIds, failures };
	}

	// Feed zips for feeds that are no longer configured (and the single-feed
	// file this manager used to write) are dead weight in the region's files
	// directory, and a stale one must never be picked up by a later build.
	async function pruneStaleFeedFiles(
		row: RoutingRegionRow,
		feeds: GtfsFeed[],
	): Promise<void> {
		const paths = regionPaths(row.slug);
		const keep = new Set(
			feeds.map((feed) => `${row.slug}-gtfs-${feed.id}.zip`),
		);
		const entries = await readdir(paths.files).catch(() => [] as string[]);
		for (const entry of entries) {
			if (!entry.startsWith(`${row.slug}-gtfs`) || !entry.endsWith(".zip")) {
				continue;
			}
			if (keep.has(entry)) continue;
			await rm(`${paths.files}/${entry}`, { force: true }).catch(
				() => undefined,
			);
		}
	}

	// The timezone is derived once, from the Geofabrik id (an explicit table)
	// or its bounding box. It is stored so a timetable query never has to load
	// the catalogue just to read a clock.
	async function regionTimezone(id: string): Promise<string | null> {
		try {
			const region = (await getIndex()).byId.get(id);
			return timezoneForRegion(id, region?.bbox ?? null);
		} catch {
			return timezoneForRegion(id, null);
		}
	}

	// `/v2/status` lists every profile the engine actually built, keyed by
	// profile name (StatusAPI.addProfilesInfo). A `public-transport` key there
	// is the only honest proof that the timetable graph loaded.
	async function transitProfileLoaded(baseUrl: string): Promise<boolean> {
		try {
			const res = await deps.fetch(`${baseUrl}/v2/status`);
			if (!res.ok) return false;
			const body = (await res.json()) as { profiles?: unknown };
			const profiles = body?.profiles;
			if (!profiles || typeof profiles !== "object") return false;
			return Object.keys(profiles as Record<string, unknown>).includes(
				PUBLIC_TRANSPORT_PROFILE,
			);
		} catch {
			return false;
		}
	}

	// A PT graph finishes building AFTER the container reports healthy (health
	// flips once the engine is up), so readiness is polled separately with the
	// same budget a graph build gets.
	async function waitForTransitProfile(
		baseUrl: string,
		timeoutMs: number,
	): Promise<boolean> {
		const deadline = now() + timeoutMs;
		for (;;) {
			if (await transitProfileLoaded(baseUrl)) return true;
			if (now() >= deadline) return false;
			await sleep(HEALTH_POLL_MS);
		}
	}

	async function settleTransitReadiness(
		id: string,
		baseUrl: string,
	): Promise<void> {
		const ready = await waitForTransitProfile(baseUrl, config.buildTimeoutMs);
		if (ready) {
			// The graph now contains every feed that was on disk when the
			// container was created; anything downloaded after this stamp is what
			// schedules the next rebuild.
			await updateRow(id, {
				transitStatus: "ready",
				transitBuiltAt: toDate(now),
			});
			log("region timetables ready", { id });
			return;
		}
		await updateRow(id, {
			transitStatus: "error",
			error: `transit: the public-transport profile did not load within ${Math.round(config.buildTimeoutMs / 60000)} min`,
		});
		log("region timetable build timed out", { id });
	}

	// Rebuild ONLY the public-transport graph of an already-managed region:
	// stop the container, drop graphs/public-transport (every other profile's
	// graph survives because REBUILD_GRAPHS=False), recreate the container so
	// the PT env is present, start it, and wait for the profile to appear.
	async function rebuildTransit(row: RoutingRegionRow): Promise<void> {
		const feeds = feedsFor(row.id);
		if (feeds.length === 0) {
			await updateRow(row.id, { transitStatus: "none" });
			return;
		}
		const paths = regionPaths(row.slug);
		await updateRow(row.id, { transitStatus: "building" });
		const { readyFeedIds, failures } = await downloadTransitFeeds(row, feeds);
		if (readyFeedIds.length === 0) {
			throw new Error(
				failures.join("; ") || "no timetable feed could be downloaded",
			);
		}
		if (failures.length > 0) {
			// Explicitly NOT fatal: the graph is built from the operators that
			// answered, and the ones that did not are visible per feed in admin.
			log("building timetables without some feeds", {
				id: row.id,
				skipped: failures,
			});
		}
		const containerName = row.containerName ?? regionContainerName(row.slug);
		const hostPort = row.hostPort ?? (await allocatePort());
		const baseUrl = row.baseUrl ?? `http://${config.hostIp}:${hostPort}/ors`;
		const state = await docker.inspectContainer(containerName);
		if (state.exists) {
			await docker.stopContainer(containerName).catch(() => undefined);
			await docker.removeContainer(containerName).catch(() => undefined);
		}
		await rm(paths.transitGraph, { recursive: true, force: true });
		await updateRow(row.id, { containerName, hostPort, baseUrl });
		await createRegionContainer(row, hostPort, containerName);
		await docker.startContainer(containerName);
		const healthy = await waitForHealth(
			baseUrl,
			config.buildTimeoutMs,
			HEALTH_POLL_MS,
		);
		if (!healthy) {
			throw new Error(
				`ORS did not become ready within ${Math.round(config.buildTimeoutMs / 60000)} min after the timetable rebuild`,
			);
		}
		await settleTransitReadiness(row.id, baseUrl);
	}

	// The legacy fixed instance (ORS_BASE_URL) has no public-transport profile
	// and is outside this manager, so giving that country timetables means
	// building a MANAGED container for it. The legacy base URL keeps serving
	// every route for the whole build — the row stays `managed: false` and
	// `ready` — and only flips over once the new container is healthy. A
	// failure therefore costs nothing: routing carries on where it was.
	async function promoteLegacyRegion(row: RoutingRegionRow): Promise<void> {
		const feeds = feedsFor(row.id);
		if (feeds.length === 0) {
			await updateRow(row.id, { transitStatus: "none" });
			return;
		}
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
		await updateRow(row.id, { transitStatus: "building" });
		log("promoting legacy region to a managed container", { id: row.id });
		const existingPbf = await stat(paths.pbf).catch(() => null);
		if (!existingPbf) {
			const { bytes, source } = await downloadPbf(
				row.pbfUrl,
				paths.pbf,
				row.id,
			);
			await updateRow(row.id, { pbfSizeBytes: bytes, extractSource: source });
		} else {
			await updateRow(row.id, { pbfSizeBytes: existingPbf.size });
		}
		const promoted = await downloadTransitFeeds(row, feeds);
		if (promoted.readyFeedIds.length === 0) {
			throw new Error(
				promoted.failures.join("; ") || "no timetable feed could be downloaded",
			);
		}
		const hostPort = row.hostPort ?? (await allocatePort());
		const containerName = regionContainerName(row.slug);
		const managedBaseUrl = `http://${config.hostIp}:${hostPort}/ors`;
		const state = await docker.inspectContainer(containerName);
		if (!state.exists) {
			await createRegionContainer(row, hostPort, containerName);
		}
		await docker.startContainer(containerName);
		const healthy = await waitForHealth(
			managedBaseUrl,
			config.buildTimeoutMs,
			HEALTH_POLL_MS,
		);
		if (!healthy) {
			throw new Error(
				`the managed container for ${row.id} did not become ready within ${Math.round(config.buildTimeoutMs / 60000)} min`,
			);
		}
		// Only now does the region stop being the legacy fixed instance.
		await updateRow(row.id, {
			managed: true,
			containerName,
			hostPort,
			baseUrl: managedBaseUrl,
			status: "ready",
			error: null,
			attempts: 0,
			nextAttemptAt: null,
			readyAt: toDate(now),
			lastUsedAt: toDate(now),
		});
		log("legacy region is now managed", {
			id: row.id,
			baseUrl: managedBaseUrl,
		});
		await settleTransitReadiness(row.id, managedBaseUrl);
	}

	// Pick up one region whose timetable graph needs (re)building. Runs only
	// when no ROAD build is pending — a PT rebuild stops a serving container,
	// so it must never queue-jump a region that has no graph at all yet.
	async function runTransitJob(): Promise<boolean> {
		const rows = await db
			.select()
			.from(routingRegions)
			.where(
				and(
					inArray(routingRegions.transitStatus, ["queued", "building"]),
					eq(routingRegions.status, "ready"),
				),
			)
			.orderBy(asc(routingRegions.createdAt))
			.limit(1);
		const row = rows[0];
		if (!row) return false;
		try {
			if (row.managed) await rebuildTransit(row);
			else await promoteLegacyRegion(row);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log("timetable build failed", { id: row.id, error: message });
			await updateRow(row.id, {
				transitStatus: "error",
				error: `transit: ${message.slice(0, 900)}`,
			});
		}
		return true;
	}

	// Reconcile the resolved feed set against the rows: a region that gained
	// feeds (or whose feed list changed at all) is queued for a timetable
	// build; a region whose feeds were all removed drops back to "none".
	async function reconcileTransitFeeds(): Promise<void> {
		const rows = await db.select().from(routingRegions);
		for (const row of rows) {
			const feeds = feedsFor(row.id);
			const fingerprint = feedFingerprint(feeds);
			if (!fingerprint) {
				if (row.transitStatus !== "none") {
					log("timetable feeds removed", { id: row.id });
					await updateRow(row.id, { transitStatus: "none" });
				}
				continue;
			}
			if (!row.timezone) {
				await updateRow(row.id, { timezone: await regionTimezone(row.id) });
			}
			if (row.gtfsUrl !== fingerprint || row.transitStatus === "none") {
				log("timetable feeds configured", {
					id: row.id,
					feeds: feeds.length,
				});
				await updateRow(row.id, {
					gtfsUrl: fingerprint,
					transitStatus: "queued",
				});
			}
		}
	}

	// True when a feed is past ITS OWN refresh interval (catalogue
	// `refreshDays`, else the global default) — BKK republishes daily, the
	// small city feeds every fortnight, so one global interval would either
	// hammer the small hosts or serve a week-old Budapest timetable.
	function feedIsDue(
		feed: GtfsFeed,
		state: GtfsFeedState | undefined,
	): boolean {
		if (!state || state.url !== feed.url) return true;
		if (typeof state.downloadedAt !== "number") return true;
		return now() - state.downloadedAt >= feedRefreshMs(feed);
	}

	// A region is rebuilt when a feed has come due, or when a feed landed on
	// disk AFTER the running graph was built (an admin's per-feed retry, say) —
	// but only inside the nightly window, because the rebuild takes the
	// region's container down.
	async function scheduleTransitRefreshes(): Promise<string[]> {
		const hour = new Date(now()).getHours();
		const { startHour, endHour } = config.transitRefreshWindow;
		if (hour < startHour || hour >= endHour) return [];
		const rows = await db
			.select()
			.from(routingRegions)
			.where(eq(routingRegions.transitStatus, "ready"));
		const queued: string[] = [];
		for (const row of rows) {
			const feeds = feedsFor(row.id);
			if (feeds.length === 0) continue;
			const states = new Map(
				parseGtfsFeedStates(row.gtfsFeeds).map((state) => [state.id, state]),
			);
			const due = feeds.filter((feed) => feedIsDue(feed, states.get(feed.id)));
			const builtAt =
				row.transitBuiltAt?.getTime() ?? row.gtfsDownloadedAt?.getTime() ?? 0;
			const newerThanGraph = [...states.values()].some(
				(state) => (state.downloadedAt ?? 0) > builtAt,
			);
			if (due.length === 0 && !newerThanGraph) continue;
			log("timetable refresh due", {
				id: row.id,
				due: due.map((feed) => feed.id),
				newerThanGraph,
			});
			await updateRow(row.id, { transitStatus: "queued" });
			queued.push(row.id);
		}
		if (queued.length > 0) kick();
		return queued;
	}

	// A timetable build that died on a bad hour at the feed host must come
	// back by itself, the same way a resident road build does.
	async function requeueTransientTransitErrors(): Promise<void> {
		const rows = await db
			.select()
			.from(routingRegions)
			.where(eq(routingRegions.transitStatus, "error"));
		for (const row of rows) {
			if (feedsFor(row.id).length === 0) continue;
			if (classifyRegionError(row.error) !== "transient") continue;
			log("re-queueing timetable build after a transient failure", {
				id: row.id,
				error: row.error,
			});
			await updateRow(row.id, { transitStatus: "queued", error: null });
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
				...init,
				headers: {
					"user-agent": "AlfyAI",
					...(init.headers as Record<string, string> | undefined),
				},
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
		maxBytes?: number,
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
			// A source that sends no Content-Length can still be capped — on the
			// bytes it actually delivers.
			if (maxBytes !== undefined && bytes > maxBytes) {
				abortWith(
					`download is over the ${Math.round(maxBytes / 1048576)} MB cap`,
				);
				return;
			}
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
			// Both of these refuse the response before a byte is written, so let
			// go of the socket instead of leaving the body dangling.
			const refuse = async (error: Error): Promise<never> => {
				await res.body?.cancel().catch(() => undefined);
				throw error;
			};
			if (expectedLength !== null && expectedLength > config.maxPbfBytes) {
				await refuse(
					new Error(
						`extract is ${Math.round(expectedLength / 1048576)} MB, above the ${Math.round(config.maxPbfBytes / 1048576)} MB cap`,
					),
				);
			}
			if (candidate.kind === "mirror" && expectedLength === null) {
				await refuse(new Error("mirror did not report a content length"));
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

	// Single-source download for a GTFS feed. No mirrors and no checksums exist
	// for these, so the integrity signals are:
	//
	//   * an exact Content-Length match WHEN the server sends one — several
	//     Hungarian city feeds are generated per request and send none, so its
	//     absence is tolerated rather than fatal;
	//   * the zip magic number ("PK\x03\x04"), which catches the HTML error
	//     page a CDN happily serves with a 200;
	//   * the shared stall / overall-timeout guards plus a streaming byte cap,
	//     so neither a hung nor an endless feed host can wedge the job loop.
	//
	// `validators` replays the previous response's ETag / Last-Modified, so a
	// refresh of an unchanged feed costs a 304 and no transfer. A server that
	// ignores conditional requests (or Range — menetbrand does) simply answers
	// 200 and the file is rewritten, which is correct, only less cheap.
	async function downloadFeedFile(
		url: string,
		target: string,
		validators?: { etag?: string; lastModified?: string },
	): Promise<{
		bytes: number | null;
		etag?: string;
		lastModified?: string;
		notModified: boolean;
	}> {
		const maxBytes = config.gtfsMaxBytes;
		const part = `${target}.part`;
		await rm(part, { force: true });
		const controller = new AbortController();
		const headers: Record<string, string> = {};
		if (validators?.etag) headers["if-none-match"] = validators.etag;
		if (validators?.lastModified) {
			headers["if-modified-since"] = validators.lastModified;
		}
		try {
			const res = await fetchFeed(url, controller.signal, headers);
			if (res.status === 304) {
				await res.body?.cancel().catch(() => undefined);
				return {
					bytes: null,
					...(validators?.etag ? { etag: validators.etag } : {}),
					...(validators?.lastModified
						? { lastModified: validators.lastModified }
						: {}),
					notModified: true,
				};
			}
			const expectedLength = contentLength(res);
			const refuse = async (error: Error): Promise<never> => {
				await res.body?.cancel().catch(() => undefined);
				throw error;
			};
			if (expectedLength !== null && expectedLength > maxBytes) {
				await refuse(
					new Error(
						`feed is ${Math.round(expectedLength / 1048576)} MB, above the ${Math.round(maxBytes / 1048576)} MB cap`,
					),
				);
			}
			const { bytes } = await streamToPart(res, part, controller, maxBytes);
			if (expectedLength !== null && bytes !== expectedLength) {
				throw new Error(
					`feed download truncated (${bytes} of ${expectedLength} bytes)`,
				);
			}
			if (!(await looksLikeZip(part))) {
				throw new Error("feed is not a zip archive");
			}
			await rename(part, target);
			const etag = res.headers.get("etag") ?? undefined;
			const lastModified = res.headers.get("last-modified") ?? undefined;
			return {
				bytes,
				...(etag ? { etag } : {}),
				...(lastModified ? { lastModified } : {}),
				notModified: false,
			};
		} catch (error) {
			await rm(part, { force: true }).catch(() => undefined);
			throw error;
		}
	}

	// Like `fetchExtract`, but 304 is a SUCCESS (the caller keeps its file) and
	// the error text says "feed", which is what an admin reads.
	async function fetchFeed(
		url: string,
		signal: AbortSignal,
		headers: Record<string, string>,
	): Promise<Response> {
		const res = await deps.fetch(url, {
			headers: { "user-agent": "AlfyAI", ...headers },
			signal,
		});
		if (res.status === 304) return res;
		if (!res.ok || !res.body) {
			await res.body?.cancel().catch(() => undefined);
			throw new Error(`feed download failed: ${res.status} ${res.statusText}`);
		}
		return res;
	}

	// The local zip magic number. Cheap, and the only thing standing between a
	// captive-portal HTML page and a ten-minute graph build that fails.
	async function looksLikeZip(path: string): Promise<boolean> {
		const handle = await openFile(path, "r").catch(() => null);
		if (!handle) return false;
		try {
			const buffer = Buffer.alloc(4);
			const { bytesRead } = await handle.read(buffer, 0, 4, 0);
			return bytesRead === 4 && buffer.toString("latin1", 0, 2) === "PK";
		} finally {
			await handle.close().catch(() => undefined);
		}
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

	async function listTransitReadyRegions(): Promise<RoutingRegionRow[]> {
		return (await listRegions()).filter(
			(row) => row.transitStatus === "ready" && row.status === "ready",
		);
	}

	// Admin "Refresh timetable": queue an immediate rebuild, bypassing the
	// nightly window. A region with no feeds configured cannot be refreshed.
	async function refreshTransit(id: string): Promise<RoutingRegionRow | null> {
		const row = await getRow(id);
		if (!row) return null;
		if (feedsFor(id).length === 0) return row;
		// "Refresh" means every feed, so every feed is marked due — the download
		// still sends its validators, so an unchanged feed costs a 304.
		const states = parseGtfsFeedStates(row.gtfsFeeds).map((state) =>
			forgetFeedDownload(state),
		);
		await updateRow(id, {
			gtfsFeeds: JSON.stringify(states),
			transitStatus: "queued",
			error: null,
		});
		kick();
		return getRow(id);
	}

	// Drops the timestamp (and any recorded failure) that would otherwise make
	// a feed count as fresh, while KEEPING the validators, so the next download
	// can still be answered with a 304.
	function forgetFeedDownload(state: GtfsFeedState): GtfsFeedState {
		return {
			id: state.id,
			url: state.url,
			...(state.bytes === undefined ? {} : { bytes: state.bytes }),
			...(state.etag ? { etag: state.etag } : {}),
			...(state.lastModified ? { lastModified: state.lastModified } : {}),
		};
	}

	// Admin per-feed retry. It clears the recorded failure and forgets that
	// feed's download timestamp, then queues the region: the rebuild fetches
	// exactly this feed (it is now "due") and leaves every feed already on disk
	// and fresh alone, so retrying one small city costs one small download.
	async function retryTransitFeed(
		id: string,
		feedId: string,
	): Promise<RoutingRegionRow | null> {
		const row = await getRow(id);
		if (!row) return null;
		const feeds = feedsFor(id);
		if (!feeds.some((feed) => feed.id === feedId)) return row;
		const states = parseGtfsFeedStates(row.gtfsFeeds).map((state) =>
			state.id === feedId ? forgetFeedDownload(state) : state,
		);
		await updateRow(id, {
			gtfsFeeds: JSON.stringify(states),
			transitStatus: "queued",
			error: null,
		});
		kick();
		return getRow(id);
	}

	// The configured feeds joined with their recorded state, for the admin
	// table. Configuration order is preserved so the list reads the same way it
	// is written in the catalogue.
	function describeTransitFeeds(row: RoutingRegionRow): TransitFeedView[] {
		const states = new Map(
			parseGtfsFeedStates(row.gtfsFeeds).map((state) => [state.id, state]),
		);
		return feedsFor(row.id).map((feed) => {
			const state = states.get(feed.id);
			const downloaded = state?.downloadedAt;
			const status: TransitFeedView["status"] =
				downloaded === undefined
					? state?.error
						? "error"
						: "pending"
					: feedIsDue(feed, state)
						? "stale"
						: "ready";
			return {
				id: feed.id,
				name: feed.name,
				url: feed.url,
				...(feed.licence ? { licence: feed.licence } : {}),
				...(feed.official === undefined ? {} : { official: feed.official }),
				...(feed.notes ? { notes: feed.notes } : {}),
				status,
				...(state?.bytes === undefined ? {} : { bytes: state.bytes }),
				...(downloaded === undefined ? {} : { downloadedAt: downloaded }),
				...(state?.error ? { error: state.error } : {}),
				refreshDays: Math.round(feedRefreshMs(feed) / (24 * 60 * 60 * 1000)),
			};
		});
	}

	// Periodic timetable maintenance, driven by the runtime's sweep timer:
	// pick up feeds added to the config since the last tick and queue the
	// refreshes that have come due inside the nightly window.
	async function runTransitMaintenance(): Promise<string[]> {
		await reconcileTransitFeeds();
		const queued = await scheduleTransitRefreshes();
		kick();
		return queued;
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
			// A queued/running timetable build owns this container; stopping it
			// underneath the build would fail the build for no reason.
			if (row.transitStatus === "queued" || row.transitStatus === "building") {
				continue;
			}
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
		await reconcileTransitFeeds();
		await requeueTransientTransitErrors();
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
		listTransitReadyRegions,
		refreshTransit,
		retryTransitFeed,
		describeTransitFeeds,
		requestRegion,
		retryRegion,
		setResident,
		removeRegion,
		runIdleSweep,
		runTransitMaintenance,
		resumePendingJobs,
		kickJobs: kick,
		drain,
	};
}
