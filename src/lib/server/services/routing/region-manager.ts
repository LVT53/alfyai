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
import { asc, eq, inArray } from "drizzle-orm";
import type { DatabaseInstance } from "$lib/server/db";
import { routingRegions } from "$lib/server/db/schema";
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
	removeRegion(id: string): Promise<boolean>;
	runIdleSweep(): Promise<string[]>;
	resumePendingJobs(): Promise<void>;
	// Wait for the in-process job loop to drain (tests / shutdown).
	drain(): Promise<void>;
}

const HEALTH_POLL_MS = 15_000;
const START_POLL_MS = 3_000;
const DEFAULT_LOG_PREFIX = "[ROUTING_REGIONS]";

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
			if (existing.baseUrl !== baseUrl || existing.status !== "ready") {
				await db
					.update(routingRegions)
					.set({
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
		} catch {
			// The index is optional for seeding the legacy row.
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
			const rows = await db
				.select()
				.from(routingRegions)
				.where(
					inArray(routingRegions.status, ["queued", "downloading", "building"]),
				)
				.orderBy(asc(routingRegions.createdAt))
				.limit(1);
			const row = rows[0];
			if (!row?.managed) return;
			try {
				await buildRegion(row);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log("region build failed", { id: row.id, error: message });
				await updateRow(row.id, {
					status: "error",
					error: message.slice(0, 1000),
				});
			}
		}
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
			log("downloading extract", { id: row.id, url: row.pbfUrl });
			const size = await downloadPbf(row.pbfUrl, paths.pbf);
			await updateRow(row.id, { pbfSizeBytes: size });
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
			readyAt: toDate(now),
			lastUsedAt: toDate(now),
		});
		log("region ready", { id: row.id, baseUrl });

		// 3. Best-effort geocoder import; never affects routing readiness.
		if (config.geocoderImportContainer && row.geocoderStatus !== "ready") {
			await importIntoGeocoder(row, paths.pbf);
		}
	}

	async function downloadPbf(url: string, target: string): Promise<number> {
		const part = `${target}.part`;
		await rm(part, { force: true });
		const res = await deps.fetch(url, { headers: { "user-agent": "AlfyAI" } });
		if (!res.ok || !res.body) {
			throw new Error(
				`extract download failed: ${res.status} ${res.statusText}`,
			);
		}
		const expectedLength = Number(res.headers.get("content-length"));
		if (
			Number.isFinite(expectedLength) &&
			expectedLength > config.maxPbfBytes
		) {
			throw new Error(
				`extract is ${Math.round(expectedLength / 1048576)} MB, above the ${Math.round(config.maxPbfBytes / 1048576)} MB cap`,
			);
		}
		const hash = createHash("md5");
		let bytes = 0;
		const body = Readable.fromWeb(res.body as never);
		body.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			hash.update(chunk);
		});
		await pipeline(body, createWriteStream(part));
		if (
			Number.isFinite(expectedLength) &&
			expectedLength > 0 &&
			bytes !== expectedLength
		) {
			await rm(part, { force: true });
			throw new Error(
				`extract download truncated (${bytes} of ${expectedLength} bytes)`,
			);
		}
		const expectedMd5 = await fetchMd5(url);
		if (expectedMd5 && expectedMd5 !== hash.digest("hex")) {
			await rm(part, { force: true });
			throw new Error("extract checksum mismatch");
		}
		await rename(part, target);
		return bytes;
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
		await updateRow(id, { status: "queued", error: null });
		kick();
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

	async function resumePendingJobs(): Promise<void> {
		await seedLegacy();
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
		removeRegion,
		runIdleSweep,
		resumePendingJobs,
		drain,
	};
}
