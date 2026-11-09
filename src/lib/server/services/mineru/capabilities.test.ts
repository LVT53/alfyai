import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "$lib/server/config-store";
import {
	createDefaultMineruProbeClient,
	forgetMineruCapabilities,
	getMineruCapabilities,
	getMineruStatusReport,
	type MineruProbeClient,
	MineruProbeError,
	resetMineruCapabilitiesCacheForTests,
	setMineruProbeClientFactory,
} from "./capabilities";
import { MineruClient } from "./client";
import { type MineruConfig, resolveMineruConfig } from "./config";
import { MineruApiError } from "./errors";
import {
	createFakeMineruServer,
	type FakeMineruServer,
	readMineruProtocolFixture,
} from "./testing/fake-server";

// The recorded 4.1.7 responses, so the probe is tested against what the real
// server actually sends rather than against a hand-written idea of it.
function captured(file: string): unknown {
	return readMineruProtocolFixture<{ response: { json: unknown } }>(file)
		.response.json;
}
const HEALTH = captured("server/health_no_key.json") as {
	version: string;
	features: Record<string, unknown>;
};
const TIERS = captured("server/tiers.json") as { data: unknown[] };
const USAGE = captured("server/usage.json");
const FLASH_TIERS = {
	object: "list",
	data: [(TIERS.data as Array<{ id: string }>)[0]],
};
// The server this app used to talk to: 4.0.4, recorded in the 4.0 spike.
const OLD_HEALTH = JSON.parse(
	readFileSync("fixtures/mineru-v1/server/health.json", "utf8"),
) as { version: string };

function config(overrides: Partial<RuntimeConfig> = {}): MineruConfig {
	return resolveMineruConfig({
		mineruApiUrl: "http://127.0.0.1:8004",
		mineruApiKey: "",
		mineruDefaultTier: "auto",
		mineruOcrMode: "auto",
		mineruJobTimeoutMs: 300000,
		mineruPollMinMs: 2000,
		mineruPollMaxMs: 30000,
		mineruRequestTimeoutMs: 30000,
		mineruTransferTimeoutMs: 600000,
		mineruCapabilitiesTtlMs: 300000,
		mineruBundleMaxBytes: 33554432,
		mineruStructureChunkingEnabled: true,
		...overrides,
	} as RuntimeConfig);
}

function fakeClient(
	overrides: Partial<MineruProbeClient> = {},
): MineruProbeClient {
	return {
		getHealth: vi.fn(async () => HEALTH),
		getTiers: vi.fn(async () => TIERS.data as never),
		getUsage: vi.fn(async () => USAGE as never),
		...overrides,
	};
}

let clock = 1_000_000;
const now = () => clock;

beforeEach(() => {
	clock = 1_000_000;
	resetMineruCapabilitiesCacheForTests();
});

afterEach(() => {
	setMineruProbeClientFactory(null);
	resetMineruCapabilitiesCacheForTests();
});

describe("getMineruStatusReport", () => {
	it("reports the recorded 4.1.7 server's version, tiers, formats and limits", async () => {
		setMineruProbeClientFactory(() => fakeClient());

		const report = await getMineruStatusReport({ config: config(), now });

		expect(report.reachable).toBe(true);
		expect(report.version).toBe("4.1.7");
		expect(report.webhook).toBe(false);
		// 4.1 renamed the health key (`output_formats` became
		// `task_output_formats`) and changed what is in it: the card used to show
		// an empty list against a 4.1 server.
		expect(report.outputFormats).toEqual(["default", "docx", "html", "latex"]);
		expect(report.sources).toEqual(["upload", "url"]);
		expect(report.tiers).toEqual([
			{
				id: "flash",
				description: "Fast local text extraction.",
				currentModel: "mineru-4.1.7",
			},
			{
				id: "basic",
				description: "Basic parsing with local lightweight models.",
				// 4.1 reports one model name for every tier.
				currentModel: "mineru-4.1.7",
			},
			{
				id: "standard",
				description: "Standard parsing for most documents.",
				currentModel: "mineru-4.1.7",
			},
		]);
		expect(report.accessLevel).toBe("registered");
		expect(report.limits).toEqual({
			maxFileSizeBytes: null,
			maxPagesPerFile: null,
			maxFilesPerJob: 100,
			maxConcurrentJobs: 2,
		});
		expect(report.error).toBeNull();
	});

	it("shows the origin only, never the key or a path", async () => {
		setMineruProbeClientFactory(() => fakeClient());
		const report = await getMineruStatusReport({
			config: config({
				mineruApiUrl: "http://mineru.internal:8004/base",
				mineruApiKey: "sk-secret",
			}),
			now,
		});
		expect(report.baseUrl).toBe("http://mineru.internal:8004");
		expect(JSON.stringify(report)).not.toContain("sk-secret");
	});

	it("says unreachable with a taxonomy code instead of throwing", async () => {
		setMineruProbeClientFactory(() =>
			fakeClient({
				getHealth: vi.fn(async () => {
					throw new MineruProbeError(
						"unavailable",
						"fetch failed (ECONNREFUSED)",
					);
				}),
			}),
		);

		const report = await getMineruStatusReport({ config: config(), now });
		expect(report.reachable).toBe(false);
		expect(report.error).toEqual({
			code: "unavailable",
			message: "fetch failed (ECONNREFUSED)",
		});
		expect(report.version).toBeNull();
	});

	it("stays reachable when only the keyed endpoints are refused", async () => {
		// /v1/health is public even under --api-key. "Reachable, 4.1.7, tiers
		// unknown" is a more useful answer than "unreachable" because /v1/usage
		// came back 401.
		setMineruProbeClientFactory(() =>
			fakeClient({
				getTiers: vi.fn(async () => {
					throw new MineruProbeError("auth_failed", "invalid_api_key");
				}),
				getUsage: vi.fn(async () => {
					throw new MineruProbeError("auth_failed", "invalid_api_key");
				}),
			}),
		);

		const report = await getMineruStatusReport({ config: config(), now });
		expect(report.reachable).toBe(true);
		expect(report.version).toBe("4.1.7");
		expect(report.tiers).toEqual([]);
		expect(report.limits).toBeNull();
	});

	it("reports an unconfigured endpoint without probing", async () => {
		const client = fakeClient();
		setMineruProbeClientFactory(() => client);

		const report = await getMineruStatusReport({
			config: config({ mineruApiUrl: "   " }),
			now,
		});
		expect(report.reachable).toBe(false);
		expect(report.error?.code).toBe("unavailable");
		expect(client.getHealth).not.toHaveBeenCalled();
	});

	it("serves the cache inside the TTL and re-probes after it", async () => {
		const client = fakeClient();
		setMineruProbeClientFactory(() => client);

		const first = await getMineruStatusReport({ config: config(), now });
		expect(first.cached).toBe(false);

		clock += 1000;
		const second = await getMineruStatusReport({ config: config(), now });
		expect(second.cached).toBe(true);
		expect(client.getHealth).toHaveBeenCalledTimes(1);

		clock += 300_000;
		await getMineruStatusReport({ config: config(), now });
		expect(client.getHealth).toHaveBeenCalledTimes(2);
	});

	it("probes again when refresh is asked for", async () => {
		const client = fakeClient();
		setMineruProbeClientFactory(() => client);

		await getMineruStatusReport({ config: config(), now });
		await getMineruStatusReport({ config: config(), now, refresh: true });
		expect(client.getHealth).toHaveBeenCalledTimes(2);
	});

	it("issues one probe for a burst", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const getHealth = vi.fn(async () => {
			await gate;
			return HEALTH;
		});
		setMineruProbeClientFactory(() => fakeClient({ getHealth }));

		const all = Promise.all([
			getMineruStatusReport({ config: config(), now }),
			getMineruStatusReport({ config: config(), now }),
			getMineruStatusReport({ config: config(), now }),
		]);
		release();
		const reports = await all;

		expect(getHealth).toHaveBeenCalledTimes(1);
		expect(reports.every((report) => report.reachable)).toBe(true);
	});

	it("keeps a fresh answer when a refresh fails, and gives up past twice the TTL", async () => {
		const getHealth = vi
			.fn()
			.mockResolvedValueOnce(HEALTH)
			.mockRejectedValue(new MineruProbeError("unavailable", "down"));
		setMineruProbeClientFactory(() => fakeClient({ getHealth }));

		await getMineruStatusReport({ config: config(), now });

		// Inside 2 × TTL: a transient failure must not replace a good answer.
		clock += 400_000;
		const stillGood = await getMineruStatusReport({
			config: config(),
			now,
			refresh: true,
		});
		expect(stillGood.reachable).toBe(true);
		expect(stillGood.cached).toBe(true);

		// Past it: the admin is told the truth.
		clock += 400_000;
		const honest = await getMineruStatusReport({
			config: config(),
			now,
			refresh: true,
		});
		expect(honest.reachable).toBe(false);
		expect(honest.error?.message).toBe("down");
	});
});

describe("a report whose tier list could not be read", () => {
	// S4 resolves "auto" against the tier list. A report without one that was
	// cached would send every PDF and image with no tier (D14: whatever the
	// server starts at) for the whole cache TTL, because one `/v1/tiers` call
	// failed once. It is a failed refresh, not an answer to keep.
	const tierListFails = () =>
		vi
			.fn()
			.mockRejectedValueOnce(new MineruProbeError("unavailable", "boom"))
			.mockResolvedValue(TIERS.data);

	it("is told to the caller as it is, and not kept: the next read fetches again", async () => {
		const getHealth = vi.fn(async () => HEALTH);
		const getTiers = tierListFails();
		setMineruProbeClientFactory(() => fakeClient({ getHealth, getTiers }));
		vi.spyOn(console, "warn").mockImplementation(() => undefined);

		const first = await getMineruStatusReport({ config: config(), now });
		// The card still says what it knows: reachable, version, tiers unknown.
		expect(first.reachable).toBe(true);
		expect(first.version).toBe("4.1.7");
		expect(first.tiers).toEqual([]);
		expect(first.cached).toBe(false);

		clock += 1000;
		const second = await getMineruStatusReport({ config: config(), now });
		expect(second.tiers.map((tier) => tier.id)).toEqual([
			"flash",
			"basic",
			"standard",
		]);
		expect(second.cached).toBe(false);
		expect(getHealth).toHaveBeenCalledTimes(2);
		expect(getTiers).toHaveBeenCalledTimes(2);

		// A complete answer is kept as before.
		clock += 1000;
		const third = await getMineruStatusReport({ config: config(), now });
		expect(third.cached).toBe(true);
		expect(getHealth).toHaveBeenCalledTimes(2);
	});

	it("reaches the hot path as no tiers once, and as the real list on the next read", async () => {
		const getTiers = tierListFails();
		setMineruProbeClientFactory(() => fakeClient({ getTiers }));
		vi.spyOn(console, "warn").mockImplementation(() => undefined);

		const first = await getMineruCapabilities(undefined, {
			config: config(),
			now,
		});
		expect(first.tiers).toEqual([]);

		clock += 1000;
		const second = await getMineruCapabilities(undefined, {
			config: config(),
			now,
		});
		expect(second.tiers).toEqual(["flash", "basic", "standard"]);
	});

	it("does not replace a good answer that is still fresh enough to serve", async () => {
		const getTiers = vi
			.fn()
			.mockResolvedValueOnce(TIERS.data)
			.mockRejectedValue(new MineruProbeError("unavailable", "boom"));
		setMineruProbeClientFactory(() => fakeClient({ getTiers }));
		vi.spyOn(console, "warn").mockImplementation(() => undefined);

		await getMineruStatusReport({ config: config(), now });
		// Past the TTL, inside twice the TTL: a refresh that loses the tier list is
		// a failed refresh, and the earlier answer (with its tiers) is served.
		clock += 400_000;
		const report = await getMineruStatusReport({ config: config(), now });
		expect(report.tiers.map((tier) => tier.id)).toEqual([
			"flash",
			"basic",
			"standard",
		]);
		expect(report.cached).toBe(true);

		// Past twice the TTL it is not served any more, and the card is told the truth.
		clock += 400_000;
		const honest = await getMineruStatusReport({ config: config(), now });
		expect(honest.tiers).toEqual([]);
		expect(honest.cached).toBe(false);
	});

	it("does not matter when only the usage call fails", async () => {
		// Usage is decoration for the card: a report without it is complete.
		const getHealth = vi.fn(async () => HEALTH);
		setMineruProbeClientFactory(() =>
			fakeClient({
				getHealth,
				getUsage: vi.fn(async () => {
					throw new MineruProbeError("auth_failed", "invalid_api_key");
				}),
			}),
		);
		await getMineruStatusReport({ config: config(), now });
		clock += 1000;
		const again = await getMineruStatusReport({ config: config(), now });
		expect(again.cached).toBe(true);
		expect(getHealth).toHaveBeenCalledTimes(1);
	});
});

describe("the cache belongs to one endpoint", () => {
	// `MINERU_API_URL` is a live setting and the cutover (S9) is a URL flip, in
	// either direction. An answer read from the server that URL used to name says
	// nothing about the one it names now.
	it("does not serve a report that was read from another origin", async () => {
		const getHealth = vi.fn(async () => HEALTH);
		setMineruProbeClientFactory(() => fakeClient({ getHealth }));

		await getMineruStatusReport({ config: config(), now });
		clock += 1000;
		const elsewhere = await getMineruStatusReport({
			config: config({ mineruApiUrl: "http://127.0.0.1:8002" }),
			now,
		});

		expect(getHealth).toHaveBeenCalledTimes(2);
		expect(elsewhere.cached).toBe(false);
		expect(elsewhere.baseUrl).toBe("http://127.0.0.1:8002");
	});

	it("still serves it for the same origin under another path or key", async () => {
		const getHealth = vi.fn(async () => HEALTH);
		setMineruProbeClientFactory(() => fakeClient({ getHealth }));

		await getMineruStatusReport({ config: config(), now });
		const again = await getMineruStatusReport({
			config: config({
				mineruApiUrl: "http://127.0.0.1:8004/",
				mineruApiKey: "k",
			}),
			now,
		});

		expect(getHealth).toHaveBeenCalledTimes(1);
		expect(again.cached).toBe(true);
	});
});

describe("forgetMineruCapabilities", () => {
	// For a caller that has just been told the cached answer is wrong: the server
	// refused a tier its list offered, and the list is good for minutes more.
	it("makes the next read fetch the tier list again", async () => {
		const getTiers = vi.fn(async () => TIERS.data as never);
		setMineruProbeClientFactory(() => fakeClient({ getTiers }));

		await getMineruStatusReport({ config: config(), now });
		forgetMineruCapabilities(config());
		clock += 1000;
		const again = await getMineruStatusReport({ config: config(), now });

		expect(getTiers).toHaveBeenCalledTimes(2);
		expect(again.cached).toBe(false);
	});

	it("reaches the hot path: the tiers it reports are the ones read after it", async () => {
		let listed = TIERS.data;
		setMineruProbeClientFactory(() =>
			fakeClient({ getTiers: vi.fn(async () => listed as never) }),
		);

		expect(
			(await getMineruCapabilities(undefined, { config: config() })).tiers,
		).toContain("standard");
		// The box is restarted at a lower ceiling; the list on hand is still good.
		listed = FLASH_TIERS.data;
		expect(
			(await getMineruCapabilities(undefined, { config: config() })).tiers,
		).toContain("standard");

		forgetMineruCapabilities(config());
		expect(
			(await getMineruCapabilities(undefined, { config: config() })).tiers,
		).toEqual(["flash"]);
	});

	it("leaves a report for another endpoint alone", async () => {
		const getTiers = vi.fn(async () => TIERS.data as never);
		setMineruProbeClientFactory(() => fakeClient({ getTiers }));

		await getMineruStatusReport({ config: config(), now });
		forgetMineruCapabilities(config({ mineruApiUrl: "http://127.0.0.1:8002" }));
		const again = await getMineruStatusReport({ config: config(), now });

		expect(getTiers).toHaveBeenCalledTimes(1);
		expect(again.cached).toBe(true);
	});
});

describe("a server that speaks the old protocol", () => {
	// 4.0.12 already serves /v1/tasks (R14), in its own older shape, and answers a
	// healthy-looking /v1/health. Reading that as "reachable, 4.0.4" lets every
	// extraction walk up to a 400. It is not a healthy backend for this client.
	function oldServer() {
		return fakeClient({ getHealth: vi.fn(async () => OLD_HEALTH as never) });
	}

	it("is not reachable for this client, and says why", async () => {
		setMineruProbeClientFactory(() => oldServer());

		const report = await getMineruStatusReport({ config: config(), now });

		expect(report.reachable).toBe(false);
		expect(report.version).toBe("4.0.4");
		// `unavailable`, not `backend_misconfigured`: during the cutover (S9) the
		// URL is flipped within seconds and the retry budget of an outage is what
		// carries a document across (S6).
		expect(report.error?.code).toBe("unavailable");
		expect(report.error?.message).toContain("4.0.4");
		expect(report.error?.message).toContain("old protocol");
		expect(report.error?.message).toContain("MINERU_API_URL");
	});

	it("is refused by the hot path with the same retryable verdict", async () => {
		setMineruProbeClientFactory(() => oldServer());

		await expect(
			getMineruCapabilities(undefined, { config: config(), now }),
		).rejects.toMatchObject({
			name: "MineruProbeError",
			code: "unavailable",
		});
	});

	it("is not cached, so the first probe after the URL flip sees the new server", async () => {
		const getHealth = vi
			.fn()
			.mockResolvedValueOnce(OLD_HEALTH)
			.mockResolvedValue(HEALTH);
		setMineruProbeClientFactory(() => fakeClient({ getHealth }));

		const old = await getMineruStatusReport({ config: config(), now });
		expect(old.reachable).toBe(false);

		clock += 1000;
		const flipped = await getMineruStatusReport({ config: config(), now });
		expect(flipped.reachable).toBe(true);
		expect(flipped.version).toBe("4.1.7");
		expect(getHealth).toHaveBeenCalledTimes(2);
	});

	it("does not withdraw a cached 4.1 answer on its own", async () => {
		// An old answer on a refresh is a transient fact about the URL, like any
		// other failed refresh: the same grace window applies.
		const getHealth = vi
			.fn()
			.mockResolvedValueOnce(HEALTH)
			.mockResolvedValue(OLD_HEALTH);
		setMineruProbeClientFactory(() => fakeClient({ getHealth }));

		await getMineruStatusReport({ config: config(), now });
		clock += 400_000;
		const report = await getMineruStatusReport({
			config: config(),
			now,
			refresh: true,
		});
		expect(report.reachable).toBe(true);
		expect(report.cached).toBe(true);
	});

	it.each([
		["4.1.0", true],
		["4.1.7", true],
		["4.2.0", true],
		["5.0.1", true],
		["4.0.12", false],
		["4.0.4", false],
		["3.9.9", false],
		// A version this app cannot read is not evidence of anything.
		["nightly", true],
	])("version %s counts as a healthy backend: %s", async (version, healthy) => {
		setMineruProbeClientFactory(() =>
			fakeClient({ getHealth: vi.fn(async () => ({ ...HEALTH, version })) }),
		);
		const report = await getMineruStatusReport({ config: config(), now });
		expect(report.reachable).toBe(healthy);
	});
});

describe("getMineruCapabilities", () => {
	it("returns the version and the known tier ids", async () => {
		setMineruProbeClientFactory(() => fakeClient());
		const capabilities = await getMineruCapabilities(undefined, {
			config: config(),
			now,
		});
		expect(capabilities.version).toBe("4.1.7");
		expect(capabilities.tiers).toEqual(["flash", "basic", "standard"]);
	});

	it("reports a flash-only server as exactly that", async () => {
		// What `auto` resolves to depends on this list (S4): an omitted tier on a
		// lower ceiling is a silent downgrade, an explicit one above it is a 400.
		setMineruProbeClientFactory(() =>
			fakeClient({ getTiers: vi.fn(async () => FLASH_TIERS.data as never) }),
		);
		const capabilities = await getMineruCapabilities(undefined, {
			config: config(),
			now,
		});
		expect(capabilities.tiers).toEqual(["flash"]);
	});

	it("drops a tier id this app does not know how to request", async () => {
		setMineruProbeClientFactory(() =>
			fakeClient({
				getTiers: vi.fn(async () => [
					{ id: "flash", description: "" },
					{ id: "quantum", description: "from the future" },
				]),
			}),
		);
		const capabilities = await getMineruCapabilities(undefined, {
			config: config(),
			now,
		});
		expect(capabilities.tiers).toEqual(["flash"]);
	});

	it("throws rather than guessing when the server cannot be read", async () => {
		setMineruProbeClientFactory(() =>
			fakeClient({
				getHealth: vi.fn(async () => {
					throw new MineruProbeError("unavailable", "down");
				}),
			}),
		);
		await expect(
			getMineruCapabilities(undefined, { config: config(), now }),
		).rejects.toMatchObject({ code: "unavailable", message: "down" });
	});
});

describe("the default probe client", () => {
	function fetchStub(handler: (url: string, init: RequestInit) => Response) {
		return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
			handler(String(input), init ?? {}),
		) as unknown as typeof fetch;
	}

	it("calls the three V1 endpoints on the configured base", async () => {
		const seen: string[] = [];
		const client = createDefaultMineruProbeClient(
			config(),
			fetchStub((url) => {
				seen.push(url);
				if (url.endsWith("/v1/health")) return Response.json(HEALTH);
				if (url.endsWith("/v1/tiers")) return Response.json(TIERS);
				return Response.json(USAGE);
			}),
		);
		const signal = new AbortController().signal;

		const health = await client.getHealth(signal);
		expect(health.version).toBe("4.1.7");
		expect(health.features?.task_output_formats).toEqual([
			"default",
			"docx",
			"html",
			"latex",
		]);
		expect(await client.getTiers(signal)).toHaveLength(3);
		expect((await client.getUsage(signal)).access_level).toBe("registered");
		expect(seen).toEqual([
			"http://127.0.0.1:8004/v1/health",
			"http://127.0.0.1:8004/v1/tiers",
			"http://127.0.0.1:8004/v1/usage",
		]);
	});

	it("feeds the admin card the 4.1 formats when it is the probe", async () => {
		setMineruProbeClientFactory((cfg) =>
			createDefaultMineruProbeClient(
				cfg,
				fetchStub((url) => {
					if (url.endsWith("/v1/health")) return Response.json(HEALTH);
					if (url.endsWith("/v1/tiers")) return Response.json(TIERS);
					return Response.json(USAGE);
				}),
			),
		);
		const report = await getMineruStatusReport({ config: config(), now });
		expect(report.outputFormats).toEqual(["default", "docx", "html", "latex"]);
	});

	it("sends the key as a bearer token only when one is configured", async () => {
		const withoutKey = fetchStub(() => Response.json(HEALTH));
		await createDefaultMineruProbeClient(config(), withoutKey).getHealth(
			new AbortController().signal,
		);
		expect(
			(withoutKey as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]
				.headers.authorization,
		).toBeUndefined();

		const withKey = fetchStub(() => Response.json(HEALTH));
		await createDefaultMineruProbeClient(
			config({ mineruApiKey: "sk-1" }),
			withKey,
		).getHealth(new AbortController().signal);
		expect(
			(withKey as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].headers
				.authorization,
		).toBe("Bearer sk-1");
	});

	it("maps a 401 to auth_failed and a 5xx to unavailable", async () => {
		const unauthorized = createDefaultMineruProbeClient(
			config(),
			fetchStub(() => new Response("invalid_api_key", { status: 401 })),
		);
		await expect(
			unauthorized.getHealth(new AbortController().signal),
		).rejects.toMatchObject({ code: "auth_failed" });

		const broken = createDefaultMineruProbeClient(
			config(),
			fetchStub(() => new Response("boom", { status: 502 })),
		);
		await expect(
			broken.getHealth(new AbortController().signal),
		).rejects.toMatchObject({ code: "unavailable" });
	});

	it("treats a 200 that is not valid JSON as a protocol failure", async () => {
		const client = createDefaultMineruProbeClient(
			config(),
			fetchStub(() => new Response("<html>nginx</html>", { status: 200 })),
		);
		await expect(
			client.getHealth(new AbortController().signal),
		).rejects.toMatchObject({ code: "protocol" });
	});

	it("treats a 200 without a version as a protocol failure", async () => {
		const client = createDefaultMineruProbeClient(
			config(),
			fetchStub(() => Response.json({ status: "ok" })),
		);
		await expect(
			client.getHealth(new AbortController().signal),
		).rejects.toMatchObject({ code: "protocol" });
	});
});

describe("a probe client that is NOT the built-in one", () => {
	// The regression this pins. `describeTransportError` recognised only
	// `MineruProbeError` and sent everything else to `unavailable`, which is
	// RETRYABLE. The seam exists so `MineruClient` can be the probe, and
	// `MineruClient` throws `MineruApiError`. The day that swap happened, "this is
	// not a MinerU 4 server" (a permanent 404) became an outage that re-probed
	// forever while every upload failed.

	async function reportFor(error: unknown) {
		setMineruProbeClientFactory(() =>
			fakeClient({
				getHealth: vi.fn(async () => {
					throw error;
				}),
			}),
		);
		return getMineruStatusReport({ config: config(), now });
	}

	describe("against the real client", () => {
		let server: FakeMineruServer;

		beforeEach(async () => {
			server = await createFakeMineruServer();
			setMineruProbeClientFactory((cfg) => new MineruClient({ config: cfg }));
		});

		afterEach(async () => {
			await server.close();
		});

		it("calls a server with no /v1/health a permanent misconfiguration, by name", async () => {
			// FastAPI's own `{"detail":"Not Found"}`: what a MinerU 3.x server (no
			// /v1 namespace at all) or any other FastAPI service answers. A's
			// classification reads that as "another protocol", which is retried for
			// a task; for the HEALTH call it is the statement "this URL is not a
			// MinerU 4 server", and no retry changes it.
			const report = await getMineruStatusReport({
				config: config({ mineruApiUrl: `${server.baseUrl}/not-mineru4` }),
				now,
			});

			expect(report.reachable).toBe(false);
			// `backend_misconfigured`, not `unavailable` and not the generic
			// `protocol`: there is no dual-protocol fallback, so retrying a server
			// that does not speak V1 only delays the honest message, and once an
			// admin has repointed MINERU_API_URL every document that failed on it
			// must be retryable, which a plain `protocol` never was.
			expect(report.error?.code).toBe("backend_misconfigured");
			expect(report.error?.message).toContain("not a MinerU 4 server");
			expect(report.error?.message).toContain(
				"MinerU 3.x is no longer supported",
			);
			expect(report.error?.message).toContain("MINERU_API_URL");
			expect(report.version).toBeNull();
		});

		it("says the same when /v1/health answers like a non-MinerU server", async () => {
			setMineruProbeClientFactory(
				(cfg) =>
					new MineruClient({
						config: cfg,
						fetchImpl: async (input) => {
							const url = String(input);
							if (url.endsWith("/v1/health")) {
								return Response.json({
									status: "ok",
									service: "something-else",
								});
							}
							return fetch(input);
						},
					}),
			);
			const report = await getMineruStatusReport({
				config: config({ mineruApiUrl: server.baseUrl }),
				now,
			});
			expect(report.error?.code).toBe("backend_misconfigured");
			expect(report.error?.message).toContain("not a MinerU 4 server");
		});

		it("says the same when /v1/health answers a page, not JSON", async () => {
			setMineruProbeClientFactory(
				(cfg) =>
					new MineruClient({
						config: cfg,
						fetchImpl: async () =>
							new Response("<html>Welcome to nginx</html>", { status: 200 }),
					}),
			);
			const report = await getMineruStatusReport({
				config: config({ mineruApiUrl: server.baseUrl }),
				now,
			});
			expect(report.error?.code).toBe("backend_misconfigured");
		});

		it("reads the real 4.1.7 fake as healthy, with its formats", async () => {
			const report = await getMineruStatusReport({
				config: config({ mineruApiUrl: server.baseUrl }),
				now,
			});
			expect(report.reachable).toBe(true);
			expect(report.version).toBe("4.1.7");
			expect(report.outputFormats).toEqual([
				"default",
				"docx",
				"html",
				"latex",
			]);
			expect(report.tiers.map((tier) => tier.id)).toEqual([
				"flash",
				"basic",
				"standard",
			]);
		});

		it("keeps a 4.0.12-voiced health answer retryable (the cutover window)", async () => {
			// A typed error body on /v1/health itself is the OLD server, not a
			// different product: the URL is about to be flipped.
			setMineruProbeClientFactory(
				(cfg) =>
					new MineruClient({
						config: cfg,
						fetchImpl: async () =>
							Response.json(
								{
									error: {
										type: "api_error",
										code: "internal_error",
										message: "boom",
										param: null,
									},
								},
								{ status: 500 },
							),
					}),
			);
			const report = await getMineruStatusReport({
				config: config({ mineruApiUrl: server.baseUrl }),
				now,
			});
			expect(report.error?.code).toBe("unavailable");
		});
	});

	function apiError(init: { status: number; code: string; message: string }) {
		return new MineruApiError({ ...init, requestPath: "/v1/health" });
	}

	it("calls a wrong API key auth_failed", async () => {
		const report = await reportFor(
			apiError({
				status: 401,
				code: "invalid_api_key",
				message:
					"MinerU /v1/health failed with 401: Invalid or missing API key",
			}),
		);
		expect(report.error?.code).toBe("auth_failed");
		expect(report.error?.message).toContain("401");
	});

	it("calls a bare 401 with no MinerU code auth_failed too", async () => {
		// A reverse proxy in front of MinerU answers 401 without MinerU's error
		// envelope. `mapMineruError`'s 4xx fallback would call that `protocol`;
		// for three plain GETs it is an authentication problem and nothing else.
		const report = await reportFor(
			apiError({ status: 401, code: "", message: "HTTP 401" }),
		);
		expect(report.error?.code).toBe("auth_failed");
	});

	it("calls a refused connection, a DNS miss and a TLS failure unavailable", async () => {
		for (const code of ["ECONNREFUSED", "ENOTFOUND", "UND_ERR_SOCKET"]) {
			const report = await reportFor(
				Object.assign(new TypeError("fetch failed"), { cause: { code } }),
			);
			resetMineruCapabilitiesCacheForTests();
			// Retryable, and it stays retryable: this one really is an outage.
			expect(report.error?.code).toBe("unavailable");
			expect(report.error?.message).toContain(code);
		}
	});

	it("keeps 429 as rate_limited rather than a protocol fault", async () => {
		const report = await reportFor(
			apiError({ status: 429, code: "", message: "HTTP 429" }),
		);
		expect(report.error?.code).toBe("rate_limited");
	});

	it("never puts the API key into the report or the log", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		setMineruProbeClientFactory((cfg) =>
			createDefaultMineruProbeClient(
				cfg,
				vi.fn(
					async () =>
						// A server that echoes the Authorization header back in its 401
						// body. Nothing stops one from doing that, and the message it
						// produces reaches the document owner's own job row.
						new Response(
							JSON.stringify({
								error: {
									type: "authentication_error",
									code: "invalid_api_key",
									message: "rejected Bearer sk-super-secret",
								},
							}),
							{ status: 401 },
						),
				) as unknown as typeof fetch,
			),
		);

		const report = await getMineruStatusReport({
			config: config({ mineruApiKey: "sk-super-secret" }),
			now,
		});

		expect(report.error?.code).toBe("auth_failed");
		expect(JSON.stringify(report)).not.toContain("sk-super-secret");
		expect(report.error?.message).toContain("[redacted]");
		expect(JSON.stringify(warn.mock.calls)).not.toContain("sk-super-secret");
		warn.mockRestore();
	});
});
