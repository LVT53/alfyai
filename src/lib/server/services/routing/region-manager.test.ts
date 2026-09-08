import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import { parseGeofabrikIndex } from "./geofabrik";
import type { GtfsFeed } from "./gtfs-catalogue";
import type { RegionContainerSpec, RegionDocker } from "./region-docker";
import {
	classifyRegionError,
	computeRetryDelayMs,
	createRoutingRegionManager,
	type RoutingRegionManagerConfig,
	regionContainerName,
} from "./region-manager";

const fixture = JSON.parse(
	readFileSync(
		join(__dirname, "__fixtures__", "geofabrik-index.sample.json"),
		"utf8",
	),
);
const index = parseGeofabrikIndex(fixture, 0);

const BUDAPEST = { lat: 47.4979, lng: 19.0402 };
const DUBLIN = { lat: 53.4269, lng: -6.2474 };
const MUNICH = { lat: 48.1351, lng: 11.582 };
const MID_ATLANTIC = { lat: 30, lng: -40 };
const PBF_BYTES = Buffer.from(
	"not really a pbf but good enough for a checksum",
);
// Starts with the local zip magic number, because the feed downloader refuses
// anything that is not a zip (a CDN's HTML error page arrives with a 200).
const GTFS_BYTES = Buffer.from(
	"PK\u0003\u0004 not really a gtfs zip, but it has a length",
	"latin1",
);
const HU_FEED = "https://go.bkk.hu/api/static/v1/public-gtfs/budapest_gtfs.zip";
const IE_FEED = "https://www.transportforireland.ie/transitData/Data/GTFS.zip";
const HU_GTFS: GtfsFeed = {
	id: "bkk",
	name: "BKK Budapest",
	url: HU_FEED,
	refreshDays: 7,
};
const IE_GTFS: GtfsFeed = {
	id: "tfi",
	name: "Transport for Ireland",
	url: IE_FEED,
	refreshDays: 7,
};
const NO_FEEDS = new Map<string, GtfsFeed[]>();
const IE_FEEDS = new Map<string, GtfsFeed[]>([
	["ireland-and-northern-ireland", [IE_GTFS]],
]);
const HU_FEEDS = new Map<string, GtfsFeed[]>([["hungary", [HU_GTFS]]]);

type FakeDocker = RegionDocker & {
	containers: Map<string, { running: boolean; spec?: RegionContainerSpec }>;
	pulled: string[];
	execCalls: Array<{ name: string; cmd: string[] }>;
};

function fakeDocker(): FakeDocker {
	const containers = new Map<
		string,
		{ running: boolean; spec?: RegionContainerSpec }
	>();
	const pulled: string[] = [];
	const execCalls: Array<{ name: string; cmd: string[] }> = [];
	return {
		containers,
		pulled,
		execCalls,
		ping: vi.fn().mockResolvedValue(undefined),
		inspectContainer: vi.fn(async (name: string) => {
			const entry = containers.get(name);
			return entry
				? { exists: true, running: entry.running }
				: { exists: false, running: false };
		}),
		pullImage: vi.fn(async (image: string) => {
			pulled.push(image);
		}),
		createContainer: vi.fn(async (spec: RegionContainerSpec) => {
			containers.set(spec.name, { running: false, spec });
		}),
		startContainer: vi.fn(async (name: string) => {
			const entry = containers.get(name);
			if (entry) entry.running = true;
		}),
		stopContainer: vi.fn(async (name: string) => {
			const entry = containers.get(name);
			if (entry) entry.running = false;
		}),
		removeContainer: vi.fn(async (name: string) => {
			containers.delete(name);
		}),
		exec: vi.fn(async (name: string, cmd: string[]) => {
			execCalls.push({ name, cmd });
			return { exitCode: 0, output: "" };
		}),
	};
}

// A fetch that serves the extract, its md5, HEAD sizes and ORS health. Health
// flips to ready once the container has been started (`docker` is consulted).
function fakeFetch(
	docker: FakeDocker,
	options: { healthReadyAfterStarts?: number } = {},
) {
	const md5 = createHash("md5").update(PBF_BYTES).digest("hex");
	let healthPolls = 0;
	return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith(".osm.pbf.md5"))
			return new Response(`${md5}  file.osm.pbf\n`);
		if (url.endsWith(".osm.pbf")) {
			if (init?.method === "HEAD") {
				return new Response(null, {
					status: 200,
					headers: { "content-length": String(PBF_BYTES.length) },
				});
			}
			return new Response(PBF_BYTES, {
				status: 200,
				headers: { "content-length": String(PBF_BYTES.length) },
			});
		}
		// A GTFS feed: no checksum is published for these, so the manager relies
		// on an exact Content-Length match — which this serves.
		if (url.endsWith(".zip")) {
			return new Response(GTFS_BYTES, {
				status: 200,
				headers: { "content-length": String(GTFS_BYTES.length) },
			});
		}
		if (url.endsWith("/v2/health")) {
			const port = Number(new URL(url).port);
			const running = Array.from(docker.containers.values()).some(
				(entry) => entry.running && entry.spec?.hostPort === port,
			);
			healthPolls += 1;
			const ready =
				running && healthPolls > (options.healthReadyAfterStarts ?? 0);
			return new Response(
				JSON.stringify({ status: ready ? "ready" : "not ready" }),
				{
					status: ready ? 200 : 503,
				},
			);
		}
		// `/v2/status` lists the profiles the engine actually BUILT, keyed by
		// profile name. Modelled honestly: public-transport appears only when
		// the running container was created with the PT env keys.
		if (url.endsWith("/v2/status")) {
			const port = Number(new URL(url).port);
			const entry = Array.from(docker.containers.values()).find(
				(candidate) => candidate.running && candidate.spec?.hostPort === port,
			);
			if (!entry) return new Response("not running", { status: 503 });
			const profiles: Record<string, unknown> = {
				"driving-car": { encoder_name: "driving-car" },
			};
			if (
				entry.spec?.env.includes(
					"ors.engine.profiles.public-transport.enabled=true",
				)
			) {
				profiles["public-transport"] = { encoder_name: "public-transport" };
			}
			return new Response(JSON.stringify({ profiles }), { status: 200 });
		}
		return new Response("not found", { status: 404 });
	});
}

describe("routing region manager", () => {
	let memory: InMemoryDatabase;
	let dir: string;
	let docker: FakeDocker;
	let now = 1_700_000_000_000;

	function config(
		overrides: Partial<RoutingRegionManagerConfig> = {},
	): RoutingRegionManagerConfig {
		return {
			enabled: true,
			regionsDir: dir,
			orsImage: "openrouteservice/openrouteservice:test",
			xmx: "4g",
			portRange: { start: 8300, end: 8302 },
			hostIp: "127.0.0.1",
			idleMinutes: 60,
			maxPbfBytes: 10 * 1048576,
			buildTimeoutMs: 60_000,
			startTimeoutMs: 10_000,
			geocoderImportContainer: "",
			geocoderRegionsMount: "/regions",
			extractMirrors: [],
			residentRegionIds: [],
			downloadStallMs: 5_000,
			downloadMaxMs: 30_000,
			maxAttempts: 20,
			legacy: { id: "hungary", baseUrl: "http://127.0.0.1:8088/ors" },
			gtfsFeeds: NO_FEEDS,
			gtfsRefreshMs: 7 * 24 * 60 * 60 * 1000,
			gtfsMaxBytes: 600 * 1048576,
			transitRefreshWindow: { startHour: 3, endHour: 5 },
			...overrides,
		};
	}

	function manager(
		overrides: Partial<RoutingRegionManagerConfig> = {},
		fetchImpl?: typeof fetch,
	) {
		return createRoutingRegionManager(config(overrides), {
			db: memory.db,
			docker,
			fetch: (fetchImpl ?? fakeFetch(docker)) as typeof fetch,
			loadIndex: async () => index,
			now: () => now,
			sleep: async () => {
				now += 1000;
			},
			log: () => undefined,
		});
	}

	beforeEach(() => {
		memory = createInMemoryDatabase();
		dir = mkdtempSync(join(tmpdir(), "alfyai-regions-"));
		docker = fakeDocker();
		now = 1_700_000_000_000;
	});

	afterEach(() => {
		memory.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("serves the legacy fixed region without touching docker", async () => {
		const m = manager();
		const outcome = await m.ensureRegionForPoints([BUDAPEST]);
		expect(outcome).toMatchObject({
			kind: "ready",
			baseUrl: "http://127.0.0.1:8088/ors",
		});
		expect(docker.inspectContainer).not.toHaveBeenCalled();
		const regions = await m.listRegions();
		expect(regions.map((r) => [r.id, r.managed, r.status])).toEqual([
			["hungary", false, "ready"],
		]);
	});

	it("queues an unknown region, then downloads, builds and reports ready", async () => {
		const m = manager();
		const first = await m.ensureRegionForPoints([DUBLIN], {
			requestedBy: "user-1",
		});
		expect(first).toMatchObject({ kind: "preparing", status: "queued" });
		if (first.kind !== "preparing") throw new Error("expected preparing");
		expect(first.region.id).toBe("ireland-and-northern-ireland");
		expect(first.region.requestedBy).toBe("user-1");

		await m.drain();

		const rows = await m.listRegions();
		const gb = rows.find((r) => r.id === "ireland-and-northern-ireland");
		expect(gb?.status).toBe("ready");
		expect(gb?.hostPort).toBe(8300);
		expect(gb?.baseUrl).toBe("http://127.0.0.1:8300/ors");
		expect(gb?.pbfSizeBytes).toBe(PBF_BYTES.length);
		expect(docker.pulled).toEqual(["openrouteservice/openrouteservice:test"]);
		const spec = docker.containers.get(
			regionContainerName("ireland-and-northern-ireland"),
		)?.spec;
		expect(spec?.env).toContain(
			"ors.engine.profile_default.build.source_file=/home/ors/files/ireland-and-northern-ireland.osm.pbf",
		);
		expect(spec?.binds.some((bind) => bind.endsWith(":/home/ors/graphs"))).toBe(
			true,
		);
		expect(
			readFileSync(
				join(
					dir,
					"ireland-and-northern-ireland",
					"files",
					"ireland-and-northern-ireland.osm.pbf",
				),
			),
		).toEqual(PBF_BYTES);

		const second = await m.ensureRegionForPoints([DUBLIN]);
		expect(second).toMatchObject({
			kind: "ready",
			baseUrl: "http://127.0.0.1:8300/ors",
		});
	});

	it("rejects a corrupted download by checksum and schedules a retry", async () => {
		const badFetch = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith(".md5"))
					return new Response("00000000000000000000000000000000  x\n");
				if (init?.method === "HEAD") {
					return new Response(null, {
						status: 200,
						headers: { "content-length": "10" },
					});
				}
				return new Response(Buffer.from("0123456789"), {
					status: 200,
					headers: { "content-length": "10" },
				});
			},
		);
		const m = manager({}, badFetch as unknown as typeof fetch);
		await m.ensureRegionForPoints([DUBLIN]);
		await m.drain();
		const row = (await m.listRegions()).find(
			(r) => r.id === "ireland-and-northern-ireland",
		);
		// A checksum mismatch is transient (a truncated/garbled transfer), so the
		// row stays queued behind a backoff rather than becoming terminal.
		expect(row?.status).toBe("queued");
		expect(row?.attempts).toBe(1);
		expect(row?.nextAttemptAt?.getTime()).toBeGreaterThan(now);
		expect(row?.error).toContain("checksum");
		expect(docker.createContainer).not.toHaveBeenCalled();
		// Retry clears the backoff and kicks the job loop again. Drain it before
		// the test ends, otherwise the retried download is still writing into the
		// temp directory while afterEach deletes it (ENOTEMPTY under suite load).
		const retried = await m.retryRegion("ireland-and-northern-ireland");
		expect(retried?.status).toBe("queued");
		expect(retried?.attempts).toBe(0);
		expect(retried?.nextAttemptAt).toBeNull();
		await m.drain();
		const afterRetry = (await m.listRegions()).find(
			(r) => r.id === "ireland-and-northern-ireland",
		);
		expect(afterRetry?.status).toBe("queued");
		expect(afterRetry?.attempts).toBe(1);
		expect(afterRetry?.error).toContain("checksum");
	});

	it("refuses extracts above the size cap and reports which regions were too large", async () => {
		const m = manager({ maxPbfBytes: 4 });
		const outcome = await m.ensureRegionForPoints([MUNICH]);
		expect(outcome).toMatchObject({ kind: "too_large" });
		if (outcome.kind !== "too_large") throw new Error("expected too_large");
		expect(outcome.regions).toEqual(["Germany", "Bayern"]);
		expect(await m.listRegions()).toHaveLength(1);
	});

	it("reports multi-region and unknown-region point sets without queuing anything", async () => {
		const m = manager();
		expect(await m.ensureRegionForPoints([BUDAPEST, DUBLIN])).toMatchObject({
			kind: "multi_region",
			regions: ["Hungary", "Ireland and Northern Ireland"],
		});
		expect(await m.ensureRegionForPoints([MID_ATLANTIC])).toEqual({
			kind: "unknown_region",
		});
		expect((await m.listRegions()).map((r) => r.id)).toEqual(["hungary"]);
	});

	it("does not download when on-demand is disabled", async () => {
		const m = manager({ enabled: false });
		expect(await m.ensureRegionForPoints([DUBLIN])).toMatchObject({
			kind: "disabled",
		});
		expect((await m.listRegions()).map((r) => r.id)).toEqual(["hungary"]);
	});

	it("stops idle managed containers and restarts them on demand", async () => {
		const m = manager();
		await m.ensureRegionForPoints([DUBLIN]);
		await m.drain();
		const name = regionContainerName("ireland-and-northern-ireland");
		expect(docker.containers.get(name)?.running).toBe(true);

		expect(await m.runIdleSweep()).toEqual([]);
		now += 61 * 60_000;
		expect(await m.runIdleSweep()).toEqual(["ireland-and-northern-ireland"]);
		expect(docker.containers.get(name)?.running).toBe(false);

		const again = await m.ensureRegionForPoints([DUBLIN]);
		expect(again).toMatchObject({ kind: "ready" });
		expect(docker.containers.get(name)?.running).toBe(true);
	});

	it("rebuilds when the container vanished, and removeRegion cleans up", async () => {
		const m = manager();
		await m.ensureRegionForPoints([DUBLIN]);
		await m.drain();
		docker.containers.clear();
		const outcome = await m.ensureRegionForPoints([DUBLIN]);
		expect(outcome).toMatchObject({ kind: "preparing", status: "queued" });
		await m.drain();
		expect(
			(await m.listRegions()).find(
				(r) => r.id === "ireland-and-northern-ireland",
			)?.status,
		).toBe("ready");
		expect(await m.removeRegion("ireland-and-northern-ireland")).toBe(true);
		expect(
			docker.containers.has(
				regionContainerName("ireland-and-northern-ireland"),
			),
		).toBe(false);
		expect((await m.listRegions()).map((r) => r.id)).toEqual(["hungary"]);
	});

	it("imports the extract into the geocoder container after the region is ready", async () => {
		docker.containers.set("nominatim", { running: true });
		const m = manager({ geocoderImportContainer: "nominatim" });
		await m.ensureRegionForPoints([DUBLIN]);
		await m.drain();
		const row = (await m.listRegions()).find(
			(r) => r.id === "ireland-and-northern-ireland",
		);
		expect(row?.geocoderStatus).toBe("ready");
		expect(docker.execCalls).toHaveLength(2);
		expect(docker.execCalls[0].name).toBe("nominatim");
		expect(docker.execCalls[0].cmd.slice(-3)).toEqual([
			"add-data",
			"--file",
			"/regions/ireland-and-northern-ireland/files/ireland-and-northern-ireland.osm.pbf",
		]);
		expect(docker.execCalls[1].cmd.slice(-2)).toEqual(["nominatim", "index"]);
	});

	it("reuses an extract already on disk instead of downloading again", async () => {
		const files = join(dir, "ireland-and-northern-ireland", "files");
		await mkdir(files, { recursive: true });
		writeFileSync(
			join(files, "ireland-and-northern-ireland.osm.pbf"),
			PBF_BYTES,
		);
		const fetchImpl = fakeFetch(docker);
		const m = manager({}, fetchImpl as unknown as typeof fetch);
		await m.ensureRegionForPoints([DUBLIN]);
		await m.drain();
		const pbfDownloads = fetchImpl.mock.calls.filter(
			([input, init]) =>
				String(input).endsWith(".osm.pbf") && init?.method !== "HEAD",
		);
		expect(pbfDownloads).toHaveLength(0);
		expect(
			(await m.listRegions()).find(
				(r) => r.id === "ireland-and-northern-ireland",
			)?.status,
		).toBe("ready");
	});

	// ── Mirror fallback ───────────────────────────────────────

	const IRELAND_MIRROR =
		"https://mirror.invalid/extracts/europe/ireland.osm.pbf";

	// A fetch where Geofabrik's pbf endpoint is dead (exactly the September
	// 2026 outage: the index answers, the extracts 502) and the mirror serves
	// the file, refusing HEAD so the range probe is exercised too.
	function mirrorFetch(options: { mirrorBody?: () => Response } = {}) {
		const good = fakeFetch(docker);
		const calls: Array<{ url: string; method: string }> = [];
		const impl = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				const method = init?.method ?? "GET";
				if (url.endsWith(".osm.pbf") || url.endsWith(".osm.pbf.md5")) {
					calls.push({ url, method });
				}
				if (
					url.startsWith("https://download.geofabrik.de/") &&
					!url.endsWith(".md5")
				) {
					if (method === "HEAD") return good(input, init);
					return new Response("bad gateway", {
						status: 502,
						statusText: "Bad Gateway",
					});
				}
				if (url === IRELAND_MIRROR) {
					if (method === "HEAD") {
						return new Response(null, { status: 405 });
					}
					if (init?.headers && "range" in (init.headers as object)) {
						return new Response(PBF_BYTES.subarray(0, 1), { status: 206 });
					}
					return (
						options.mirrorBody?.() ??
						new Response(PBF_BYTES, {
							status: 200,
							headers: { "content-length": String(PBF_BYTES.length) },
						})
					);
				}
				return good(input, init);
			},
		);
		return { impl, calls };
	}

	it("falls back to a mirror when Geofabrik cannot serve the extract", async () => {
		const { impl, calls } = mirrorFetch();
		const m = manager(
			{ extractMirrors: ["https://mirror.invalid/extracts"] },
			impl as unknown as typeof fetch,
		);
		await m.ensureRegionForPoints([DUBLIN]);
		await m.drain();
		const row = (await m.listRegions()).find(
			(r) => r.id === "ireland-and-northern-ireland",
		);
		expect(row?.status).toBe("ready");
		expect(row?.extractSource).toBe("mirror.invalid");
		expect(row?.pbfSizeBytes).toBe(PBF_BYTES.length);
		expect(
			readFileSync(
				join(
					dir,
					"ireland-and-northern-ireland",
					"files",
					"ireland-and-northern-ireland.osm.pbf",
				),
			),
		).toEqual(PBF_BYTES);
		// Geofabrik is tried first and exhausts its budget, the mirror is probed
		// before it is streamed, and no mirror .md5 is ever requested.
		const geofabrikGets = calls.filter(
			(call) =>
				call.url.startsWith("https://download.geofabrik.de/") &&
				call.method === "GET",
		);
		expect(geofabrikGets.length).toBeGreaterThan(1);
		expect(
			calls.some(
				(call) => call.url === IRELAND_MIRROR && call.method === "HEAD",
			),
		).toBe(true);
		expect(
			calls.some((call) => call.url.endsWith(`${IRELAND_MIRROR}.md5`)),
		).toBe(false);
	});

	it("rejects a mirror body that does not match the declared content length", async () => {
		const { impl } = mirrorFetch({
			mirrorBody: () =>
				new Response(PBF_BYTES.subarray(0, 5), {
					status: 200,
					headers: { "content-length": String(PBF_BYTES.length) },
				}),
		});
		const m = manager(
			{ extractMirrors: ["https://mirror.invalid/extracts"] },
			impl as unknown as typeof fetch,
		);
		await m.ensureRegionForPoints([DUBLIN]);
		await m.drain();
		const row = (await m.listRegions()).find(
			(r) => r.id === "ireland-and-northern-ireland",
		);
		expect(row?.status).toBe("queued");
		expect(row?.error).toContain("truncated");
		expect(docker.createContainer).not.toHaveBeenCalled();
	});

	it("refuses a mirror that publishes no content length", async () => {
		// Mirrors have no .md5, so the length is the only integrity signal there
		// is; without it the download cannot be trusted.
		const { impl } = mirrorFetch({
			mirrorBody: () => new Response(PBF_BYTES, { status: 200 }),
		});
		const m = manager(
			{ extractMirrors: ["https://mirror.invalid/extracts"] },
			impl as unknown as typeof fetch,
		);
		await m.ensureRegionForPoints([DUBLIN]);
		await m.drain();
		const row = (await m.listRegions()).find(
			(r) => r.id === "ireland-and-northern-ireland",
		);
		expect(row?.error).toContain("content length");
	});

	it("skips a mirror that does not carry the region without downloading", async () => {
		const good = fakeFetch(docker);
		const seen: string[] = [];
		const impl = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				const method = init?.method ?? "GET";
				if (url === IRELAND_MIRROR) {
					seen.push(method);
					return new Response("not found", { status: 404 });
				}
				if (
					url.startsWith("https://download.geofabrik.de/") &&
					!url.endsWith(".md5") &&
					method !== "HEAD"
				) {
					return new Response("bad gateway", { status: 502 });
				}
				return good(input, init);
			},
		);
		const m = manager(
			{ extractMirrors: ["https://mirror.invalid/extracts"] },
			impl as unknown as typeof fetch,
		);
		await m.ensureRegionForPoints([DUBLIN]);
		await m.drain();
		// One probe, no transfer attempt.
		expect(seen).toEqual(["HEAD"]);
		const row = (await m.listRegions()).find(
			(r) => r.id === "ireland-and-northern-ireland",
		);
		expect(row?.error).toContain("mirror probe failed: 404");
	});

	it("aborts a download that stops producing bytes", async () => {
		const good = fakeFetch(docker);
		const impl = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith(".osm.pbf") && init?.method !== "HEAD") {
					return new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(new Uint8Array([1, 2, 3]));
								// …and then nothing, ever.
							},
						}),
					);
				}
				return good(input, init);
			},
		);
		const m = manager(
			{ downloadStallMs: 40, extractMirrors: [] },
			impl as unknown as typeof fetch,
		);
		await m.ensureRegionForPoints([DUBLIN]);
		await m.drain();
		const row = (await m.listRegions()).find(
			(r) => r.id === "ireland-and-northern-ireland",
		);
		expect(row?.error).toContain("stalled");
		// Transient, so it is queued for a retry rather than given up on.
		expect(row?.status).toBe("queued");
		expect(row?.attempts).toBe(1);
	});

	// ── Retry scheduling ──────────────────────────────────────

	it("holds a backed-off row out of the job loop until its next attempt is due", async () => {
		let failing = true;
		const good = fakeFetch(docker);
		const impl = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith(".osm.pbf") && init?.method !== "HEAD" && failing) {
					return new Response("bad gateway", {
						status: 502,
						statusText: "Bad Gateway",
					});
				}
				return good(input, init);
			},
		);
		const m = manager({ extractMirrors: [] }, impl as unknown as typeof fetch);
		await m.ensureRegionForPoints([DUBLIN]);
		await m.drain();
		const failed = (await m.listRegions()).find(
			(r) => r.id === "ireland-and-northern-ireland",
		);
		expect(failed?.status).toBe("queued");
		expect(failed?.attempts).toBe(1);
		// First backoff is a minute.
		expect(failed?.nextAttemptAt?.getTime()).toBe(now + 60_000);

		// The loop must not touch the row while the backoff is running, even
		// though its status is `queued`.
		failing = false;
		vi.mocked(docker.createContainer).mockClear();
		m.kickJobs();
		await m.drain();
		expect(docker.createContainer).not.toHaveBeenCalled();
		expect(
			(await m.listRegions()).find(
				(r) => r.id === "ireland-and-northern-ireland",
			)?.status,
		).toBe("queued");

		// Once it is due, a plain kick (what the runtime sweep timer does) is
		// enough — no user request required.
		now += 61_000;
		m.kickJobs();
		await m.drain();
		const recovered = (await m.listRegions()).find(
			(r) => r.id === "ireland-and-northern-ireland",
		);
		expect(recovered?.status).toBe("ready");
		expect(recovered?.attempts).toBe(0);
		expect(recovered?.nextAttemptAt).toBeNull();
	});

	it("gives up after the attempt cap and marks a permanent failure immediately", async () => {
		const good = fakeFetch(docker);
		const impl = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith(".osm.pbf") && init?.method !== "HEAD") {
					return new Response("bad gateway", { status: 502 });
				}
				return good(input, init);
			},
		);
		const m = manager(
			{ extractMirrors: [], maxAttempts: 3 },
			impl as unknown as typeof fetch,
		);
		await m.ensureRegionForPoints([DUBLIN]);
		for (let attempt = 0; attempt < 4; attempt++) {
			await m.drain();
			now += 2 * 60 * 60_000;
			m.kickJobs();
		}
		await m.drain();
		const row = (await m.listRegions()).find(
			(r) => r.id === "ireland-and-northern-ireland",
		);
		expect(row?.status).toBe("error");
		expect(row?.attempts).toBe(3);
		expect(row?.nextAttemptAt).toBeNull();
	});

	it("does not retry a permanent failure", async () => {
		const good = fakeFetch(docker);
		const impl = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith(".osm.pbf") && init?.method !== "HEAD") {
					return new Response("gone", { status: 404, statusText: "Not Found" });
				}
				return good(input, init);
			},
		);
		const m = manager({ extractMirrors: [] }, impl as unknown as typeof fetch);
		await m.ensureRegionForPoints([DUBLIN]);
		await m.drain();
		const row = (await m.listRegions()).find(
			(r) => r.id === "ireland-and-northern-ireland",
		);
		expect(row?.status).toBe("error");
		expect(row?.error).toContain("404");
	});

	// ── Resident regions ──────────────────────────────────────

	it("enqueues configured resident regions on start and keeps them running", async () => {
		const m = manager({
			residentRegionIds: ["ireland-and-northern-ireland"],
		});
		await m.resumePendingJobs();
		await m.drain();
		const row = (await m.listRegions()).find(
			(r) => r.id === "ireland-and-northern-ireland",
		);
		expect(row?.resident).toBe(true);
		expect(row?.status).toBe("ready");

		// The idle sweep leaves residents alone however long they sit unused.
		now += 10 * 60 * 60_000;
		expect(await m.runIdleSweep()).toEqual([]);
		expect(
			docker.containers.get(regionContainerName("ireland-and-northern-ireland"))
				?.running,
		).toBe(true);
	});

	it("marks an already-known region resident without re-enqueueing it", async () => {
		const first = manager();
		await first.ensureRegionForPoints([DUBLIN]);
		await first.drain();
		const second = manager({
			residentRegionIds: ["ireland-and-northern-ireland"],
		});
		await second.resumePendingJobs();
		await second.drain();
		const rows = await second.listRegions();
		expect(
			rows.filter((r) => r.id === "ireland-and-northern-ireland"),
		).toHaveLength(1);
		expect(
			rows.find((r) => r.id === "ireland-and-northern-ireland")?.resident,
		).toBe(true);
	});

	it("re-queues a resident region left in a transient error by an earlier run", async () => {
		// Exactly the production state this work exists for: Ireland sitting in
		// `error` with a 502 from Geofabrik, waiting for someone to click retry.
		const good = fakeFetch(docker);
		let failing = true;
		const impl = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith(".osm.pbf") && init?.method !== "HEAD" && failing) {
					return new Response("bad gateway", { status: 502 });
				}
				return good(input, init);
			},
		);
		const broken = manager(
			{ extractMirrors: [], maxAttempts: 1 },
			impl as unknown as typeof fetch,
		);
		await broken.ensureRegionForPoints([DUBLIN]);
		await broken.drain();
		expect(
			(await broken.listRegions()).find(
				(r) => r.id === "ireland-and-northern-ireland",
			)?.status,
		).toBe("error");

		failing = false;
		const restarted = manager(
			{ residentRegionIds: ["ireland-and-northern-ireland"] },
			fakeFetch(docker) as unknown as typeof fetch,
		);
		await restarted.resumePendingJobs();
		await restarted.drain();
		const row = (await restarted.listRegions()).find(
			(r) => r.id === "ireland-and-northern-ireland",
		);
		expect(row?.resident).toBe(true);
		expect(row?.status).toBe("ready");
		expect(row?.attempts).toBe(0);
	});

	it("leaves a permanently failed resident region alone on start", async () => {
		const good = fakeFetch(docker);
		const impl = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith(".osm.pbf") && init?.method !== "HEAD") {
					return new Response("gone", { status: 404, statusText: "Not Found" });
				}
				return good(input, init);
			},
		);
		const broken = manager(
			{ extractMirrors: [] },
			impl as unknown as typeof fetch,
		);
		await broken.ensureRegionForPoints([DUBLIN]);
		await broken.drain();
		const restarted = manager({
			residentRegionIds: ["ireland-and-northern-ireland"],
		});
		await restarted.resumePendingJobs();
		await restarted.drain();
		const row = (await restarted.listRegions()).find(
			(r) => r.id === "ireland-and-northern-ireland",
		);
		expect(row?.status).toBe("error");
		expect(row?.resident).toBe(true);
	});

	it("setResident toggles the flag and revives a transiently failed region", async () => {
		const good = fakeFetch(docker);
		let failing = true;
		const impl = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith(".osm.pbf") && init?.method !== "HEAD" && failing) {
					return new Response("bad gateway", { status: 502 });
				}
				return good(input, init);
			},
		);
		const m = manager(
			{ extractMirrors: [], maxAttempts: 1 },
			impl as unknown as typeof fetch,
		);
		await m.ensureRegionForPoints([DUBLIN]);
		await m.drain();
		failing = false;
		const promoted = await m.setResident("ireland-and-northern-ireland", true);
		expect(promoted?.resident).toBe(true);
		await m.drain();
		expect(
			(await m.listRegions()).find(
				(r) => r.id === "ireland-and-northern-ireland",
			)?.status,
		).toBe("ready");
		const demoted = await m.setResident("ireland-and-northern-ireland", false);
		expect(demoted?.resident).toBe(false);
		expect(await m.setResident("nope", true)).toBeNull();
	});

	it("still lists ready regions for the tool coverage label, residents included", async () => {
		const m = manager({
			residentRegionIds: ["ireland-and-northern-ireland"],
		});
		await m.resumePendingJobs();
		await m.drain();
		expect((await m.listReadyRegions()).map((r) => r.name).sort()).toEqual([
			"Hungary",
			"Ireland and Northern Ireland",
		]);
	});
});

describe("region failure classification", () => {
	it("treats outages, throttling and corrupt transfers as transient", () => {
		for (const message of [
			"extract download failed: 502 Bad Gateway",
			"extract download failed: 503 Service Unavailable",
			"extract download failed: 429 Too Many Requests",
			"mirror probe failed: 500",
			"extract download truncated (10 of 20 bytes)",
			"extract checksum mismatch",
			"extract download stalled (no data for 60s)",
			"extract download exceeded 180 min",
			"mirror did not report a content length",
			"fetch failed",
			"connect ECONNRESET 1.2.3.4:443",
			"(HTTP code 500) server error - docker pull failed",
		]) {
			expect(classifyRegionError(message)).toBe("transient");
		}
	});

	it("treats operator-fixable failures as permanent", () => {
		for (const message of [
			"extract download failed: 404 Not Found",
			"extract download failed: 403 Forbidden",
			"extract is 4000 MB, above the 2500 MB cap",
			"No free port left in ROUTING_REGION_PORT_RANGE",
			"ORS did not become ready within 240 min",
			"",
			null,
		]) {
			expect(classifyRegionError(message)).toBe("permanent");
		}
	});

	it("classifies an aggregate of source failures by its worst part", () => {
		expect(
			classifyRegionError(
				"download.geofabrik.de: extract download failed: 502 Bad Gateway; mirror.invalid: mirror probe failed: 404",
			),
		).toBe("transient");
		expect(
			classifyRegionError(
				"download.geofabrik.de: extract download failed: 404 Not Found; mirror.invalid: mirror probe failed: 404",
			),
		).toBe("permanent");
	});
});

describe("retry backoff", () => {
	it("doubles from a minute and caps at an hour", () => {
		expect(computeRetryDelayMs(1)).toBe(60_000);
		expect(computeRetryDelayMs(2)).toBe(120_000);
		expect(computeRetryDelayMs(3)).toBe(240_000);
		expect(computeRetryDelayMs(7)).toBe(60 * 60_000);
		expect(computeRetryDelayMs(20)).toBe(60 * 60_000);
		expect(computeRetryDelayMs(0)).toBe(60_000);
	});
});

describe("routing region manager — legacy seed backfill", () => {
	it("backfills the legacy region name from the index on a later start", async () => {
		const memory = createInMemoryDatabase();
		const dir = mkdtempSync(join(tmpdir(), "alfyai-regions-"));
		const docker = fakeDocker();
		try {
			const base = {
				db: memory.db,
				docker,
				fetch: fakeFetch(docker) as typeof fetch,
				now: () => 1_700_000_000_000,
				log: () => undefined,
			};
			const cfg: RoutingRegionManagerConfig = {
				enabled: true,
				regionsDir: dir,
				orsImage: "img",
				xmx: "4g",
				portRange: { start: 8300, end: 8301 },
				hostIp: "127.0.0.1",
				idleMinutes: 60,
				maxPbfBytes: 10 * 1048576,
				buildTimeoutMs: 1000,
				startTimeoutMs: 1000,
				geocoderImportContainer: "",
				geocoderRegionsMount: "/regions",
				extractMirrors: [],
				residentRegionIds: [],
				downloadStallMs: 5_000,
				downloadMaxMs: 30_000,
				maxAttempts: 20,
				legacy: { id: "hungary", baseUrl: "http://127.0.0.1:8088/ors" },
				gtfsFeeds: NO_FEEDS,
				gtfsRefreshMs: 7 * 24 * 60 * 60 * 1000,
				gtfsMaxBytes: 600 * 1048576,
				transitRefreshWindow: { startHour: 3, endHour: 5 },
			};
			// First start: index unavailable → name falls back to the id.
			const first = createRoutingRegionManager(cfg, {
				...base,
				loadIndex: async () => {
					throw new Error("offline");
				},
			});
			expect((await first.listRegions()).map((r) => r.name)).toEqual([
				"hungary",
			]);
			// Second start: index available → name is backfilled.
			const second = createRoutingRegionManager(cfg, {
				...base,
				loadIndex: async () => index,
			});
			expect((await second.listRegions()).map((r) => r.name)).toEqual([
				"Hungary",
			]);
		} finally {
			memory.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("routing region manager — download retries", () => {
	it("retries a transient 5xx and then succeeds", async () => {
		const memory = createInMemoryDatabase();
		const dir = mkdtempSync(join(tmpdir(), "alfyai-regions-"));
		const docker = fakeDocker();
		const good = fakeFetch(docker);
		let failures = 2;
		const flaky = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (
					url.endsWith(".osm.pbf") &&
					init?.method !== "HEAD" &&
					failures > 0
				) {
					failures -= 1;
					return new Response("bad gateway", { status: 502 });
				}
				return good(input, init);
			},
		);
		try {
			const m = createRoutingRegionManager(
				{
					enabled: true,
					regionsDir: dir,
					orsImage: "img",
					xmx: "4g",
					portRange: { start: 8300, end: 8301 },
					hostIp: "127.0.0.1",
					idleMinutes: 60,
					maxPbfBytes: 10 * 1048576,
					buildTimeoutMs: 60_000,
					startTimeoutMs: 1000,
					geocoderImportContainer: "",
					geocoderRegionsMount: "/regions",
					extractMirrors: [],
					residentRegionIds: [],
					downloadStallMs: 5_000,
					downloadMaxMs: 30_000,
					maxAttempts: 20,
					legacy: null,
					gtfsFeeds: NO_FEEDS,
					gtfsRefreshMs: 7 * 24 * 60 * 60 * 1000,
					gtfsMaxBytes: 600 * 1048576,
					transitRefreshWindow: { startHour: 3, endHour: 5 },
				},
				{
					db: memory.db,
					docker,
					fetch: flaky as unknown as typeof fetch,
					loadIndex: async () => index,
					now: () => 1_700_000_000_000,
					sleep: async () => undefined,
					log: () => undefined,
				},
			);
			await m.ensureRegionForPoints([DUBLIN]);
			await m.drain();
			const row = (await m.listRegions()).find(
				(r) => r.id === "ireland-and-northern-ireland",
			);
			expect(row?.status).toBe("ready");
			expect(failures).toBe(0);
		} finally {
			memory.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ── Public transport (GTFS) ────────────────────────────────────

describe("routing region manager — public transport", () => {
	let memory: InMemoryDatabase;
	let dir: string;
	let docker: FakeDocker;
	let now = 1_700_000_000_000;

	// The refresh window is a LOCAL-clock window, so a test that wants to be
	// inside (or outside) it has to build its timestamp in the process's own
	// timezone rather than assume UTC.
	function atLocalHour(hour: number): number {
		const date = new Date(1_700_000_000_000);
		date.setHours(hour, 0, 0, 0);
		return date.getTime();
	}

	function config(
		overrides: Partial<RoutingRegionManagerConfig> = {},
	): RoutingRegionManagerConfig {
		return {
			enabled: true,
			regionsDir: dir,
			orsImage: "openrouteservice/openrouteservice:test",
			xmx: "4g",
			portRange: { start: 8300, end: 8302 },
			hostIp: "127.0.0.1",
			idleMinutes: 60,
			maxPbfBytes: 10 * 1048576,
			buildTimeoutMs: 60_000,
			startTimeoutMs: 10_000,
			geocoderImportContainer: "",
			geocoderRegionsMount: "/regions",
			extractMirrors: [],
			residentRegionIds: [],
			downloadStallMs: 5_000,
			downloadMaxMs: 30_000,
			maxAttempts: 20,
			legacy: null,
			gtfsFeeds: NO_FEEDS,
			gtfsRefreshMs: 7 * 24 * 60 * 60 * 1000,
			gtfsMaxBytes: 600 * 1048576,
			transitRefreshWindow: { startHour: 3, endHour: 5 },
			...overrides,
		};
	}

	function manager(overrides: Partial<RoutingRegionManagerConfig> = {}) {
		return createRoutingRegionManager(config(overrides), {
			db: memory.db,
			docker,
			fetch: fakeFetch(docker) as typeof fetch,
			loadIndex: async () => index,
			now: () => now,
			sleep: async () => {
				now += 1000;
			},
			log: () => undefined,
		});
	}

	beforeEach(() => {
		memory = createInMemoryDatabase();
		dir = mkdtempSync(join(tmpdir(), "alfyai-regions-"));
		docker = fakeDocker();
		now = 1_700_000_000_000;
	});

	afterEach(() => {
		memory.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("builds a region with the public-transport profile when a feed is configured", async () => {
		const m = manager({
			gtfsFeeds: IE_FEEDS,
		});
		await m.ensureRegionForPoints([DUBLIN]);
		await m.drain();

		const row = (await m.listRegions()).find(
			(r) => r.id === "ireland-and-northern-ireland",
		);
		expect(row?.status).toBe("ready");
		expect(row?.transitStatus).toBe("ready");
		expect(row?.gtfsUrl).toBe(`tfi=${IE_FEED}`);
		expect(row?.gtfsSizeBytes).toBe(GTFS_BYTES.length);
		expect(row?.gtfsDownloadedAt).toBeInstanceOf(Date);
		expect(row?.timezone).toBe("Europe/Dublin");

		// The feed lands next to the extract, under the name the PT env points at.
		expect(
			readFileSync(
				join(
					dir,
					"ireland-and-northern-ireland",
					"files",
					"ireland-and-northern-ireland-gtfs-tfi.zip",
				),
			),
		).toEqual(GTFS_BYTES);

		const spec = docker.containers.get(
			regionContainerName("ireland-and-northern-ireland"),
		)?.spec;
		expect(spec?.env).toEqual(
			expect.arrayContaining([
				"ors.engine.profiles.public-transport.enabled=true",
				"ors.engine.profiles.public-transport.encoder_name=public-transport",
				"ors.engine.profiles.public-transport.build.gtfs_file=/home/ors/files/ireland-and-northern-ireland-gtfs-tfi.zip",
				"ors.engine.profiles.public-transport.build.elevation=false",
				"ors.engine.profiles.public-transport.service.maximum_visited_nodes=1000000",
			]),
		);
		expect(await m.listTransitReadyRegions()).toHaveLength(1);
	});

	it("leaves a region without a configured feed on road profiles only", async () => {
		const m = manager();
		await m.ensureRegionForPoints([DUBLIN]);
		await m.drain();
		const row = (await m.listRegions()).find(
			(r) => r.id === "ireland-and-northern-ireland",
		);
		expect(row?.status).toBe("ready");
		expect(row?.transitStatus).toBe("none");
		const spec = docker.containers.get(
			regionContainerName("ireland-and-northern-ireland"),
		)?.spec;
		expect(spec?.env.some((entry) => entry.includes("public-transport"))).toBe(
			false,
		);
		expect(await m.listTransitReadyRegions()).toHaveLength(0);
	});

	it("still builds road routing when the timetable feed cannot be downloaded", async () => {
		const good = fakeFetch(docker);
		const feedDown = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				if (String(input).endsWith(".zip")) {
					return new Response("bad gateway", { status: 502 });
				}
				return good(input, init);
			},
		);
		const m = createRoutingRegionManager(
			config({
				gtfsFeeds: IE_FEEDS,
			}),
			{
				db: memory.db,
				docker,
				fetch: feedDown as unknown as typeof fetch,
				loadIndex: async () => index,
				now: () => now,
				sleep: async () => {
					now += 1000;
				},
				log: () => undefined,
			},
		);
		await m.ensureRegionForPoints([DUBLIN]);
		await m.drain();

		const row = (await m.listRegions()).find(
			(r) => r.id === "ireland-and-northern-ireland",
		);
		// A bad hour at the transit agency's web server costs the region its
		// timetables and nothing else.
		expect(row?.status).toBe("ready");
		expect(row?.transitStatus).toBe("error");
		expect(row?.error).toContain("transit:");
		// And the container is not asked to build a graph from a file that is
		// not there.
		const spec = docker.containers.get(
			regionContainerName("ireland-and-northern-ireland"),
		)?.spec;
		expect(spec?.env.some((entry) => entry.includes("public-transport"))).toBe(
			false,
		);
	});

	it("rebuilds ONLY the public-transport graph when a feed is added later", async () => {
		// First build: no feed.
		const plain = manager();
		await plain.ensureRegionForPoints([DUBLIN]);
		await plain.drain();
		const graphs = join(dir, "ireland-and-northern-ireland", "graphs");
		mkdirSync(join(graphs, "public-transport"), { recursive: true });
		mkdirSync(join(graphs, "driving-car"), { recursive: true });
		writeFileSync(join(graphs, "driving-car", "keep.me"), "road graph");

		// Second start: the feed is now configured.
		const withFeed = manager({
			gtfsFeeds: IE_FEEDS,
		});
		await withFeed.resumePendingJobs();
		await withFeed.drain();

		const row = (await withFeed.listRegions()).find(
			(r) => r.id === "ireland-and-northern-ireland",
		);
		expect(row?.transitStatus).toBe("ready");
		// The road graph is untouched — REBUILD_GRAPHS=False reuses it — while
		// the public-transport graph directory was dropped before the restart.
		expect(existsSync(join(graphs, "driving-car", "keep.me"))).toBe(true);
		expect(existsSync(join(graphs, "public-transport"))).toBe(false);
		const spec = docker.containers.get(
			regionContainerName("ireland-and-northern-ireland"),
		)?.spec;
		expect(spec?.env).toContain(
			"ors.engine.profiles.public-transport.enabled=true",
		);
	});

	it("drops a region back to no timetables when its feed is removed", async () => {
		const withFeed = manager({
			gtfsFeeds: IE_FEEDS,
		});
		await withFeed.ensureRegionForPoints([DUBLIN]);
		await withFeed.drain();

		const without = manager();
		await without.runTransitMaintenance();
		const row = (await without.listRegions()).find(
			(r) => r.id === "ireland-and-northern-ireland",
		);
		expect(row?.transitStatus).toBe("none");
	});

	describe("refresh scheduling", () => {
		async function readyRegion() {
			const m = manager({
				gtfsFeeds: IE_FEEDS,
			});
			await m.ensureRegionForPoints([DUBLIN]);
			await m.drain();
			return m;
		}

		it("queues a stale feed only inside the nightly window", async () => {
			await readyRegion();
			const feeds = IE_FEEDS;
			// A fortnight later, but at midday: the rebuild would take the region
			// down, so it must wait.
			now = atLocalHour(12) + 14 * 24 * 60 * 60 * 1000;
			const daytime = manager({ gtfsFeeds: feeds });
			expect(await daytime.runTransitMaintenance()).toEqual([]);
			expect(
				(await daytime.listRegions()).find(
					(r) => r.id === "ireland-and-northern-ireland",
				)?.transitStatus,
			).toBe("ready");

			// Same staleness, 04:00 local: now it goes.
			now = atLocalHour(4) + 14 * 24 * 60 * 60 * 1000;
			const nightly = manager({ gtfsFeeds: feeds });
			expect(await nightly.runTransitMaintenance()).toEqual([
				"ireland-and-northern-ireland",
			]);
		});

		it("leaves a fresh feed alone inside the window", async () => {
			await readyRegion();
			now = atLocalHour(4) + 60 * 60 * 1000;
			const m = manager({
				gtfsFeeds: IE_FEEDS,
			});
			expect(await m.runTransitMaintenance()).toEqual([]);
		});

		it("an admin refresh ignores the window entirely", async () => {
			const m = manager({
				gtfsFeeds: IE_FEEDS,
			});
			await m.ensureRegionForPoints([DUBLIN]);
			await m.drain();
			now = atLocalHour(12);
			const row = await m.refreshTransit("ireland-and-northern-ireland");
			expect(row?.transitStatus).toBe("queued");
			await m.drain();
			expect(
				(await m.listRegions()).find(
					(r) => r.id === "ireland-and-northern-ireland",
				)?.transitStatus,
			).toBe("ready");
		});

		it("refuses to refresh a region that has no feed configured", async () => {
			const m = manager();
			await m.ensureRegionForPoints([DUBLIN]);
			await m.drain();
			const row = await m.refreshTransit("ireland-and-northern-ireland");
			expect(row?.transitStatus).toBe("none");
			expect(await m.refreshTransit("nowhere")).toBeNull();
		});
	});

	describe("legacy region promotion", () => {
		const legacy = { id: "hungary", baseUrl: "http://127.0.0.1:8088/ors" };

		it("keeps serving the legacy URL until the managed container is healthy", async () => {
			const m = manager({
				legacy,
				residentRegionIds: ["hungary"],
				gtfsFeeds: HU_FEEDS,
			});
			// Before the promotion runs, the legacy instance still answers.
			expect(await m.ensureRegionForPoints([BUDAPEST])).toMatchObject({
				kind: "ready",
				baseUrl: legacy.baseUrl,
			});
			expect(
				(await m.listRegions()).find((r) => r.id === "hungary")?.managed,
			).toBe(false);

			await m.resumePendingJobs();
			await m.drain();

			const after = (await m.listRegions()).find((r) => r.id === "hungary");
			expect(after?.managed).toBe(true);
			expect(after?.status).toBe("ready");
			expect(after?.transitStatus).toBe("ready");
			expect(after?.containerName).toBe("alfyai-ors-hungary");
			expect(after?.baseUrl).toBe("http://127.0.0.1:8300/ors");
			expect(after?.timezone).toBe("Europe/Budapest");
			// Routing now goes through the managed container.
			expect(await m.ensureRegionForPoints([BUDAPEST])).toMatchObject({
				kind: "ready",
				baseUrl: "http://127.0.0.1:8300/ors",
			});
		});

		it("does not re-seed the promoted region back onto the legacy instance", async () => {
			const first = manager({
				legacy,
				residentRegionIds: ["hungary"],
				gtfsFeeds: HU_FEEDS,
			});
			await first.resumePendingJobs();
			await first.drain();

			// A later start (deploy/restart) must not undo the promotion.
			const second = manager({
				legacy,
				residentRegionIds: ["hungary"],
				gtfsFeeds: HU_FEEDS,
			});
			const row = (await second.listRegions()).find((r) => r.id === "hungary");
			expect(row?.managed).toBe(true);
			expect(row?.baseUrl).toBe("http://127.0.0.1:8300/ors");
		});

		it("leaves the legacy row serving when the promotion fails", async () => {
			const failing = vi.fn(async () => {
				throw new Error("network is unreachable");
			});
			const m = createRoutingRegionManager(
				config({ legacy, gtfsFeeds: HU_FEEDS }),
				{
					db: memory.db,
					docker,
					fetch: failing as unknown as typeof fetch,
					loadIndex: async () => index,
					now: () => now,
					sleep: async () => {
						now += 1000;
					},
					log: () => undefined,
				},
			);
			await m.resumePendingJobs();
			await m.drain();
			const row = (await m.listRegions()).find((r) => r.id === "hungary");
			expect(row?.managed).toBe(false);
			expect(row?.status).toBe("ready");
			expect(row?.baseUrl).toBe(legacy.baseUrl);
			expect(row?.transitStatus).toBe("error");
			expect(row?.error).toContain("transit:");
		});

		it("does nothing to the legacy region when no feed is configured for it", async () => {
			const m = manager({ legacy, residentRegionIds: ["hungary"] });
			await m.resumePendingJobs();
			await m.drain();
			const row = (await m.listRegions()).find((r) => r.id === "hungary");
			expect(row?.managed).toBe(false);
			expect(row?.transitStatus).toBe("none");
			expect(docker.createContainer).not.toHaveBeenCalled();
		});
	});

	it("never stops a container while its timetable graph is being rebuilt", async () => {
		const m = manager({
			gtfsFeeds: IE_FEEDS,
		});
		await m.ensureRegionForPoints([DUBLIN]);
		await m.drain();
		await m.refreshTransit("ireland-and-northern-ireland");
		// Long past the idle cutoff, but a rebuild is queued for it.
		now += 10 * 60 * 60 * 1000;
		expect(await m.runIdleSweep()).toEqual([]);
	});
});

// ── Many feeds per region ──────────────────────────────────────
//
// A country's timetables are a BUNDLE: Hungary publishes ~21 official feeds
// and no national one. GraphHopper comma-splits `gtfs_file` and loads each
// path as its own feed, so a region carries all of them — and one operator's
// web server having a bad hour must cost that operator's trips and nothing
// more.
describe("routing region manager — many timetable feeds", () => {
	let memory: InMemoryDatabase;
	let dir: string;
	let docker: FakeDocker;
	let now = 1_700_000_000_000;

	const RAIL = "https://rail.test/rail.zip";
	const COACH = "https://coach.test/coach.zip";
	const CITY = "https://city.test/city.zip";
	const HU_MANY: GtfsFeed[] = [
		{ id: "rail", name: "Rail", url: RAIL, refreshDays: 1 },
		{ id: "coach", name: "Coach", url: COACH, refreshDays: 14 },
		{ id: "city", name: "City", url: CITY, refreshDays: 14 },
	];
	const MANY_FEEDS = new Map<string, GtfsFeed[]>([["hungary", HU_MANY]]);

	function atLocalHour(hour: number): number {
		const date = new Date(1_700_000_000_000);
		date.setHours(hour, 0, 0, 0);
		return date.getTime();
	}

	function config(
		overrides: Partial<RoutingRegionManagerConfig> = {},
	): RoutingRegionManagerConfig {
		return {
			enabled: true,
			regionsDir: dir,
			orsImage: "openrouteservice/openrouteservice:test",
			xmx: "4g",
			portRange: { start: 8300, end: 8302 },
			hostIp: "127.0.0.1",
			idleMinutes: 60,
			maxPbfBytes: 10 * 1048576,
			buildTimeoutMs: 60_000,
			startTimeoutMs: 10_000,
			geocoderImportContainer: "",
			geocoderRegionsMount: "/regions",
			extractMirrors: [],
			residentRegionIds: [],
			downloadStallMs: 5_000,
			downloadMaxMs: 30_000,
			maxAttempts: 20,
			legacy: null,
			gtfsFeeds: MANY_FEEDS,
			gtfsRefreshMs: 7 * 24 * 60 * 60 * 1000,
			gtfsMaxBytes: 600 * 1048576,
			transitRefreshWindow: { startHour: 3, endHour: 5 },
			...overrides,
		};
	}

	// Records what each feed URL was asked for, and lets a test answer one
	// feed differently (a 502, a 304, an HTML page) while the rest behave.
	function feedFetch(
		answers: Record<
			string,
			(init?: RequestInit) => Response | Promise<Response>
		> = {},
	) {
		const base = fakeFetch(docker);
		const calls: Array<{ url: string; headers: Record<string, string> }> = [];
		const impl = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				const answer = answers[url];
				if (answer) {
					calls.push({
						url,
						headers: (init?.headers ?? {}) as Record<string, string>,
					});
					return answer(init);
				}
				return base(input, init);
			},
		);
		return Object.assign(impl, { calls });
	}

	function manager(
		overrides: Partial<RoutingRegionManagerConfig> = {},
		fetchImpl?: typeof fetch,
	) {
		return createRoutingRegionManager(config(overrides), {
			db: memory.db,
			docker,
			fetch: (fetchImpl ?? fakeFetch(docker)) as typeof fetch,
			loadIndex: async () => index,
			now: () => now,
			sleep: async () => {
				now += 1000;
			},
			log: () => undefined,
		});
	}

	async function readyHungary(fetchImpl?: typeof fetch) {
		const m = manager({}, fetchImpl);
		await m.ensureRegionForPoints([BUDAPEST]);
		await m.drain();
		return m;
	}

	function transitEnvOf(): string | undefined {
		return docker.containers
			.get(regionContainerName("hungary"))
			?.spec?.env.find((entry) => entry.includes("build.gtfs_file="));
	}

	beforeEach(() => {
		memory = createInMemoryDatabase();
		dir = mkdtempSync(join(tmpdir(), "alfyai-regions-"));
		docker = fakeDocker();
		now = 1_700_000_000_000;
	});

	afterEach(() => {
		memory.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("joins every downloaded feed into one comma-separated gtfs_file", async () => {
		const m = await readyHungary();
		const row = (await m.listRegions()).find((r) => r.id === "hungary");
		expect(row?.transitStatus).toBe("ready");
		// The exact string ORS receives: absolute container paths, comma-joined,
		// in configured order. GraphHopper splits it and loads each as gtfs_<n>.
		expect(transitEnvOf()).toBe(
			"ors.engine.profiles.public-transport.build.gtfs_file=" +
				"/home/ors/files/hungary-gtfs-rail.zip," +
				"/home/ors/files/hungary-gtfs-coach.zip," +
				"/home/ors/files/hungary-gtfs-city.zip",
		);
		for (const feedId of ["rail", "coach", "city"]) {
			expect(
				readFileSync(
					join(dir, "hungary", "files", `hungary-gtfs-${feedId}.zip`),
				),
			).toEqual(GTFS_BYTES);
		}
		// Each feed is accounted for individually, and the row's summary is the
		// total of what landed.
		expect(m.describeTransitFeeds(row as never).map((f) => f.status)).toEqual([
			"ready",
			"ready",
			"ready",
		]);
		expect(row?.gtfsSizeBytes).toBe(3 * GTFS_BYTES.length);
	});

	it("builds from the feeds that answered when one operator is down", async () => {
		const m = await readyHungary(
			feedFetch({
				[COACH]: () => new Response("bad gateway", { status: 502 }),
			}) as unknown as typeof fetch,
		);
		const row = (await m.listRegions()).find((r) => r.id === "hungary");
		// Two feeds are enough: the region serves timetables, minus coaches.
		expect(row?.transitStatus).toBe("ready");
		expect(transitEnvOf()).toBe(
			"ors.engine.profiles.public-transport.build.gtfs_file=" +
				"/home/ors/files/hungary-gtfs-rail.zip," +
				"/home/ors/files/hungary-gtfs-city.zip",
		);
		expect(
			existsSync(join(dir, "hungary", "files", "hungary-gtfs-coach.zip")),
		).toBe(false);
		const feeds = m.describeTransitFeeds(row as never);
		expect(feeds.map((feed) => [feed.id, feed.status])).toEqual([
			["rail", "ready"],
			["coach", "error"],
			["city", "ready"],
		]);
		expect(feeds[1].error).toContain("502");
	});

	it("refuses a feed that is not a zip", async () => {
		const m = await readyHungary(
			feedFetch({
				[CITY]: () =>
					new Response("<html>maintenance</html>", {
						status: 200,
						headers: { "content-length": "24" },
					}),
			}) as unknown as typeof fetch,
		);
		const row = (await m.listRegions()).find((r) => r.id === "hungary");
		const city = m
			.describeTransitFeeds(row as never)
			.find((feed) => feed.id === "city");
		expect(city?.status).toBe("error");
		expect(city?.error).toContain("not a zip");
		expect(transitEnvOf()).not.toContain("city");
	});

	it("records a transit error only when EVERY feed fails", async () => {
		const down = () => new Response("bad gateway", { status: 502 });
		const m = await readyHungary(
			feedFetch({
				[RAIL]: down,
				[COACH]: down,
				[CITY]: down,
			}) as unknown as typeof fetch,
		);
		const row = (await m.listRegions()).find((r) => r.id === "hungary");
		// Road routing is untouched — a transit agency's bad hour must never
		// cost a country its routing.
		expect(row?.status).toBe("ready");
		expect(row?.transitStatus).toBe("error");
		expect(row?.error).toContain("transit:");
		expect(transitEnvOf()).toBeUndefined();
	});

	it("revalidates an unchanged feed with If-None-Match instead of re-downloading", async () => {
		const etagged = feedFetch({
			[RAIL]: (init) => {
				const headers = (init?.headers ?? {}) as Record<string, string>;
				if (headers["if-none-match"] === '"v1"') {
					return new Response(null, { status: 304 });
				}
				return new Response(GTFS_BYTES, {
					status: 200,
					headers: {
						"content-length": String(GTFS_BYTES.length),
						etag: '"v1"',
					},
				});
			},
		});
		const m = await readyHungary(etagged as unknown as typeof fetch);
		expect(etagged.calls).toHaveLength(1);
		// The zip is fresh by its own cadence, so "refresh" has to mean
		// something explicit — it marks every feed due.
		// An explicit refresh revalidates every feed; the rail host answers 304
		// and the zip on disk is kept.
		await m.refreshTransit("hungary");
		await m.drain();
		expect(etagged.calls).toHaveLength(2);
		expect(etagged.calls[1].headers["if-none-match"]).toBe('"v1"');
		expect(
			readFileSync(join(dir, "hungary", "files", "hungary-gtfs-rail.zip")),
		).toEqual(GTFS_BYTES);
		const row = (await m.listRegions()).find((r) => r.id === "hungary");
		expect(row?.transitStatus).toBe("ready");
	});

	it("keeps yesterday's zip when a feed's refresh fails", async () => {
		let attempts = 0;
		const flaky = feedFetch({
			[CITY]: () => {
				attempts += 1;
				return attempts === 1
					? new Response(GTFS_BYTES, {
							status: 200,
							headers: { "content-length": String(GTFS_BYTES.length) },
						})
					: new Response("gone", { status: 500 });
			},
		});
		const m = await readyHungary(flaky as unknown as typeof fetch);
		await m.refreshTransit("hungary");
		await m.drain();
		const row = (await m.listRegions()).find((r) => r.id === "hungary");
		expect(row?.transitStatus).toBe("ready");
		// Stale trips beat no trips: the file stays and still goes in the graph,
		// with the failure visible per feed.
		expect(transitEnvOf()).toContain("hungary-gtfs-city.zip");
		const city = m
			.describeTransitFeeds(row as never)
			.find((feed) => feed.id === "city");
		expect(city?.error).toContain("500");
	});

	it("queues a rebuild when ONE feed comes due on its own cadence", async () => {
		await readyHungary();
		// Two days on, at midday: the daily rail feed is due but the window is
		// closed, so nothing moves.
		now = atLocalHour(12) + 2 * 24 * 60 * 60 * 1000;
		expect(await manager().runTransitMaintenance()).toEqual([]);
		// 04:00: the rail feed alone is enough to schedule the rebuild, even
		// though the fortnightly city and coach feeds are still fresh.
		now = atLocalHour(4) + 2 * 24 * 60 * 60 * 1000;
		const nightly = manager();
		expect(await nightly.runTransitMaintenance()).toEqual(["hungary"]);
	});

	it("leaves every feed alone while all of them are inside their cadence", async () => {
		await readyHungary();
		now = atLocalHour(4) + 60 * 60 * 1000;
		expect(await manager().runTransitMaintenance()).toEqual([]);
	});

	it("re-downloads ONLY the feed an admin retried", async () => {
		await readyHungary(
			feedFetch({
				[COACH]: () => new Response("bad gateway", { status: 502 }),
			}) as unknown as typeof fetch,
		);
		// Later, with every host healthy again, the admin retries just coaches.
		const serve = () =>
			new Response(GTFS_BYTES, {
				status: 200,
				headers: { "content-length": String(GTFS_BYTES.length) },
			});
		const healthy = feedFetch({ [RAIL]: serve, [COACH]: serve, [CITY]: serve });
		const second = manager({}, healthy as unknown as typeof fetch);
		const queued = await second.retryTransitFeed("hungary", "coach");
		expect(queued?.transitStatus).toBe("queued");
		await second.drain();
		// Retrying one small city must not re-pull the country: rail and city
		// are on disk and inside their cadence, so they are not fetched at all.
		expect(healthy.calls.map((call) => call.url)).toEqual([COACH]);
		const row = (await second.listRegions()).find((r) => r.id === "hungary");
		expect(row?.transitStatus).toBe("ready");
		const coach = second
			.describeTransitFeeds(row as never)
			.find((feed) => feed.id === "coach");
		expect(coach?.status).toBe("ready");
		expect(coach?.error).toBeUndefined();
	});

	it("ignores a retry for a feed the region does not have", async () => {
		const m = await readyHungary();
		const row = await m.retryTransitFeed("hungary", "not-a-feed");
		expect(row?.transitStatus).toBe("ready");
		expect(await m.retryTransitFeed("nowhere", "rail")).toBeNull();
	});

	it("deletes the zip of a feed that has been removed from the config", async () => {
		await readyHungary();
		const files = join(dir, "hungary", "files");
		expect(existsSync(join(files, "hungary-gtfs-city.zip"))).toBe(true);
		const trimmed = manager({
			gtfsFeeds: new Map<string, GtfsFeed[]>([
				["hungary", HU_MANY.slice(0, 2)],
			]),
		});
		await trimmed.refreshTransit("hungary");
		await trimmed.drain();
		expect(existsSync(join(files, "hungary-gtfs-city.zip"))).toBe(false);
		expect(transitEnvOf()).toBe(
			"ors.engine.profiles.public-transport.build.gtfs_file=" +
				"/home/ors/files/hungary-gtfs-rail.zip," +
				"/home/ors/files/hungary-gtfs-coach.zip",
		);
	});
});
