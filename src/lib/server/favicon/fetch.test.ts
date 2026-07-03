import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchFavicon } from "./fetch";
import type { CachedFavicon } from "./lru";
import { FaviconCache } from "./lru";

/** Build a minimal fetch-like stub that returns the given status/content-type. */
function makeResponse(
	body: Uint8Array,
	init: { status?: number; contentType?: string } = {},
) {
	const status = init.status ?? 200;
	const contentType = init.contentType ?? "image/x-icon";
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: new Headers({ "content-type": contentType }),
		arrayBuffer: () => Promise.resolve(body.buffer.slice(0)),
	};
}

function makeBytes(n: number): Uint8Array {
	const b = new Uint8Array(n);
	for (let i = 0; i < n; i++) b[i] = i % 256;
	return b;
}

describe("fetchFavicon orchestration", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("tries the source /favicon.ico first and returns its bytes", async () => {
		const ico = makeBytes(8);
		const fetchMock = vi.fn(async (url: string | URL) => {
			if (String(url).includes("example.com/favicon.ico")) {
				return makeResponse(ico, { contentType: "image/x-icon" });
			}
			throw new Error("unexpected");
		});
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

		const result = await fetchFavicon("example.com");
		expect(result.kind).toBe("image");
		if (result.kind === "image") {
			expect(result.bytes).toEqual(ico);
			expect(result.contentType).toBe("image/x-icon");
		}
		// Source was the only call.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0][0])).toBe(
			"https://example.com/favicon.ico",
		);
	});

	it("falls back to DuckDuckGo when source 404s", async () => {
		const ddg = makeBytes(5);
		const fetchMock = vi.fn(async (url: string | URL) => {
			const s = String(url);
			if (s.endsWith("example.com/favicon.ico")) {
				return makeResponse(new Uint8Array(), { status: 404 });
			}
			if (s.includes("icons.duckduckgo.com")) {
				return makeResponse(ddg, { contentType: "image/png" });
			}
			throw new Error("unexpected");
		});
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

		const result = await fetchFavicon("example.com");
		expect(result.kind).toBe("image");
		if (result.kind === "image") {
			expect(result.bytes).toEqual(ddg);
			expect(result.contentType).toBe("image/png");
		}
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(String(fetchMock.mock.calls[1][0])).toBe(
			"https://icons.duckduckgo.com/ip3/example.com.ico",
		);
	});

	it("falls back to DuckDuckGo when source returns a non-image content-type", async () => {
		// e.g. a misconfigured server returns text/html for /favicon.ico.
		const ddg = makeBytes(4);
		const fetchMock = vi.fn(async (url: string | URL) => {
			const s = String(url);
			if (s.endsWith("example.com/favicon.ico")) {
				return makeResponse(new Uint8Array(20), {
					status: 200,
					contentType: "text/html; charset=utf-8",
				});
			}
			if (s.includes("icons.duckduckgo.com")) {
				return makeResponse(ddg, { contentType: "image/png" });
			}
			throw new Error("unexpected");
		});
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

		const result = await fetchFavicon("example.com");
		expect(result.kind).toBe("image");
		if (result.kind === "image") {
			expect(result.contentType).toBe("image/png");
		}
	});

	it("returns the globe fallback when both source and DDG fail", async () => {
		const fetchMock = vi.fn(async () =>
			makeResponse(new Uint8Array(), { status: 502 }),
		);
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

		const result = await fetchFavicon("example.com");
		expect(result.kind).toBe("globe");
	});

	it("returns the globe fallback when fetch throws", async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error("network down");
		}) as unknown as typeof globalThis.fetch;

		const result = await fetchFavicon("example.com");
		expect(result.kind).toBe("globe");
	});

	it("returns the globe fallback when the image body is empty", async () => {
		const fetchMock = vi.fn(async (url: string | URL) => {
			const s = String(url);
			if (s.endsWith("example.com/favicon.ico")) {
				return makeResponse(new Uint8Array(), {
					status: 200,
					contentType: "image/x-icon",
				});
			}
			if (s.includes("icons.duckduckgo.com")) {
				return makeResponse(new Uint8Array(), {
					status: 200,
					contentType: "image/png",
				});
			}
			throw new Error("unexpected");
		});
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

		const result = await fetchFavicon("example.com");
		expect(result.kind).toBe("globe");
	});

	it("always uses https (never http) for outbound requests", async () => {
		const fetchMock = vi.fn(async (url: string | URL) => {
			const s = String(url);
			if (s.startsWith("http://")) {
				throw new Error("must not use http");
			}
			return makeResponse(makeBytes(3), { contentType: "image/x-icon" });
		});
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

		await fetchFavicon("example.com");
		for (const call of fetchMock.mock.calls) {
			expect(String(call[0]).startsWith("https://")).toBe(true);
		}
	});

	it("does not follow redirects (redirect: 'manual'); treats 3xx as failure", async () => {
		const impl = async (url: string | URL, _init?: RequestInit) => {
			const s = String(url);
			if (s.endsWith("example.com/favicon.ico")) {
				return makeResponse(new Uint8Array(0), { status: 302 });
			}
			// DDG also redirects -> total failure.
			if (s.includes("icons.duckduckgo.com")) {
				return makeResponse(new Uint8Array(0), { status: 301 });
			}
			throw new Error("unexpected");
		};
		const fetchMock = vi.fn(impl);
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

		const result = await fetchFavicon("example.com");
		expect(result.kind).toBe("globe");
		// Inspect that redirect:'manual' was passed.
		const init = fetchMock.mock.calls[0][1] as RequestInit | undefined;
		expect(init?.redirect).toBe("manual");
	});

	it("uses the cache: a second call for the same domain does not fetch", async () => {
		const cache = new FaviconCache({ maxSize: 4, ttlMs: 60_000 });
		const ico = makeBytes(6);
		const fetchMock = vi.fn(async () =>
			makeResponse(ico, { contentType: "image/x-icon" }),
		);
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

		const first = await fetchFavicon("cached.com", { cache });
		const second = await fetchFavicon("cached.com", { cache });

		expect(first.kind).toBe("image");
		expect(second.kind).toBe("image");
		if (second.kind === "image") {
			expect(second.bytes).toEqual(ico);
		}
		// Only the first call hit the network.
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("caches the globe fallback as well (negative caching) so repeats are cheap", async () => {
		const cache = new FaviconCache({ maxSize: 4, ttlMs: 60_000 });
		const fetchMock = vi.fn(async () => {
			throw new Error("offline");
		});
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

		await fetchFavicon("down.com", { cache });
		// First call hits source + DDG = 2 network attempts.
		expect(fetchMock).toHaveBeenCalledTimes(2);
		await fetchFavicon("down.com", { cache });
		// Second call is served entirely from the negative cache — no new fetch.
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("returns the cached content-type alongside the bytes", async () => {
		const cache = new FaviconCache({ maxSize: 4, ttlMs: 60_000 });
		const entry: CachedFavicon = {
			bytes: makeBytes(2),
			contentType: "image/svg+xml",
			expiresAt: Number.MAX_SAFE_INTEGER,
		};
		cache.set("preset.com", entry);

		const result = await fetchFavicon("preset.com", { cache });
		expect(result.kind).toBe("image");
		if (result.kind === "image") {
			expect(result.contentType).toBe("image/svg+xml");
		}
	});
});
