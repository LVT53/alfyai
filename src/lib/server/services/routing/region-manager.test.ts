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

	it("rejects a corrupted download by checksum and marks the region error", async () => {
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
		expect(row?.status).toBe("error");
		expect(row?.error).toContain("checksum");
		expect(docker.createContainer).not.toHaveBeenCalled();
		// Retry re-queues and kicks the job loop again. Drain it before the test
		// ends, otherwise the retried download is still writing into the temp
		// directory while afterEach deletes it (ENOTEMPTY under suite load).
		const retried = await m.retryRegion("ireland-and-northern-ireland");
		expect(retried?.status).toBe("queued");
		await m.drain();
		const afterRetry = (await m.listRegions()).find(
			(r) => r.id === "ireland-and-northern-ireland",
		);
		expect(afterRetry?.status).toBe("error");
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
