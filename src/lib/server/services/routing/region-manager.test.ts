import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import { parseGeofabrikIndex } from "./geofabrik";
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
