import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "$lib/server/config-store";
import {
	createDefaultMineruProbeClient,
	getMineruCapabilities,
	getMineruStatusReport,
	type MineruProbeClient,
	MineruProbeError,
	resetMineruCapabilitiesCacheForTests,
	setMineruProbeClientFactory,
} from "./capabilities";
import { type MineruConfig, resolveMineruConfig } from "./config";

// The recorded 4.0.4 responses, so the probe is tested against what the real
// server actually sends rather than against a hand-written idea of it.
const HEALTH = JSON.parse(
	readFileSync("fixtures/mineru-v1/server/health.json", "utf8"),
);
const TIERS = JSON.parse(
	readFileSync("fixtures/mineru-v1/server/tiers.json", "utf8"),
);
const FLASH_TIERS = JSON.parse(
	readFileSync("fixtures/mineru-v1/server/flash.tiers.json", "utf8"),
);
const USAGE = JSON.parse(
	readFileSync("fixtures/mineru-v1/server/usage.json", "utf8"),
);

function config(overrides: Partial<RuntimeConfig> = {}): MineruConfig {
	return resolveMineruConfig({
		mineruApiUrl: "http://127.0.0.1:8001",
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
		getTiers: vi.fn(async () => TIERS.data),
		getUsage: vi.fn(async () => USAGE),
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
	it("reports the recorded server's version, tiers, formats and limits", async () => {
		setMineruProbeClientFactory(() => fakeClient());

		const report = await getMineruStatusReport({ config: config(), now });

		expect(report.reachable).toBe(true);
		expect(report.version).toBe("4.0.4");
		expect(report.webhook).toBe(false);
		expect(report.outputFormats).toEqual([
			"markdown",
			"middle_json",
			"structured_content",
			"zip",
		]);
		expect(report.tiers).toEqual([
			{
				id: "flash",
				description: "Fast local text extraction.",
				currentModel: "flash",
			},
			{
				id: "basic",
				description: "Basic parsing with local lightweight models.",
				// Deliberately NOT joined to /v1/models[].id — the server spells
				// the same model "hybrid-basic" here and "Hybrid-Basic" there.
				currentModel: "hybrid-basic",
			},
		]);
		expect(report.accessLevel).toBe("anonymous");
		expect(report.limits).toEqual({
			maxFileSizeBytes: 209715200,
			maxPagesPerFile: 1000,
			maxFilesPerJob: 100,
			maxConcurrentJobs: 1,
		});
		expect(report.error).toBeNull();
	});

	it("shows the origin only, never the key or a path", async () => {
		setMineruProbeClientFactory(() => fakeClient());
		const report = await getMineruStatusReport({
			config: config({
				mineruApiUrl: "http://mineru.internal:8001/base",
				mineruApiKey: "sk-secret",
			}),
			now,
		});
		expect(report.baseUrl).toBe("http://mineru.internal:8001");
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
		// /v1/health is public even under --api-key. "Reachable, 4.0.4, tiers
		// unknown" is a more useful answer than "unreachable" because
		// /v1/usage came back 401.
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
		expect(report.version).toBe("4.0.4");
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

describe("getMineruCapabilities", () => {
	it("returns the version, formats and known tier ids", async () => {
		setMineruProbeClientFactory(() => fakeClient());
		const capabilities = await getMineruCapabilities(undefined, {
			config: config(),
			now,
		});
		expect(capabilities.version).toBe("4.0.4");
		expect(capabilities.tiers).toEqual(["flash", "basic"]);
		expect(capabilities.outputFormats).toContain("structured_content");
	});

	it("reports a flash-only server as exactly that", async () => {
		// The tier the extractor may ask for depends on this list: omitting the
		// tier on a flash-only server is a 503 for a PDF, so knowing the list is
		// what turns that failure into a parse.
		setMineruProbeClientFactory(() =>
			fakeClient({ getTiers: vi.fn(async () => FLASH_TIERS.data) }),
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

		expect((await client.getHealth(signal)).version).toBe("4.0.4");
		expect(await client.getTiers(signal)).toHaveLength(2);
		expect((await client.getUsage(signal)).access_level).toBe("anonymous");
		expect(seen).toEqual([
			"http://127.0.0.1:8001/v1/health",
			"http://127.0.0.1:8001/v1/tiers",
			"http://127.0.0.1:8001/v1/usage",
		]);
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
	// RETRYABLE. The seam exists so `MineruClient` can be the probe — and
	// `MineruClient` throws `MineruApiError`. The day that swap happened, "this
	// is a MinerU 3.x server" (a permanent 404) became an outage that re-probed
	// forever while every upload failed. P2-B papered over it with an adapter
	// inside the extractor, which left the admin card — the one surface that
	// loads `capabilities.ts` without the extractor — still reading the wrong
	// answer.

	function apiError(init: {
		status: number | null;
		code: string;
		message: string;
	}) {
		return Object.assign(new Error(init.message), {
			name: "MineruApiError",
			status: init.status,
			code: init.code,
			type: null,
			param: null,
			detail: null,
			fastapiValidation: false,
			bodyExcerpt: null,
			retryAfterMs: null,
			requestPath: "/v1/health",
		});
	}

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

	it("calls a MinerU 3.x backend a permanent protocol failure, by name", async () => {
		const report = await reportFor(
			apiError({
				status: 404,
				code: "",
				message: "MinerU /v1/health failed with 404: Not Found",
			}),
		);
		expect(report.reachable).toBe(false);
		// `protocol`, not `unavailable`: there is no dual-protocol fallback, so
		// retrying a server that does not speak V1 only delays the honest message.
		expect(report.error?.code).toBe("protocol");
		expect(report.error?.message).toContain("not a MinerU 4 server");
		expect(report.error?.message).toContain(
			"MinerU 3.x is no longer supported",
		);
		expect(report.error?.message).toContain("MINERU_API_URL");
	});

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
	});
});
