import { beforeEach, describe, expect, it } from "vitest";
import { type CachedFavicon, FaviconCache } from "./lru";

function makeEntry(overrides: Partial<CachedFavicon> = {}): CachedFavicon {
	return {
		bytes: overrides.bytes ?? new Uint8Array([1, 2, 3]),
		contentType: overrides.contentType ?? "image/x-icon",
		// Fixed timestamp so assertions are deterministic.
		expiresAt: overrides.expiresAt ?? Number.MAX_SAFE_INTEGER,
	};
}

describe("FaviconCache", () => {
	let cache: FaviconCache;

	beforeEach(() => {
		cache = new FaviconCache({ maxSize: 3, ttlMs: 1000 });
	});

	it("has/set/get round-trips an entry", () => {
		expect(cache.has("a.com")).toBe(false);
		cache.set("a.com", makeEntry());
		expect(cache.has("a.com")).toBe(true);
		const got = cache.get("a.com");
		expect(got).not.toBeNull();
		expect(got?.bytes).toEqual(new Uint8Array([1, 2, 3]));
	});

	it("get returns null for a missing key", () => {
		expect(cache.get("missing.com")).toBeNull();
	});

	it("get treats an expired entry as a miss (and evicts it)", () => {
		cache = new FaviconCache({ maxSize: 3, ttlMs: 0 });
		cache.set("a.com", makeEntry({ expiresAt: Date.now() - 1 }));
		expect(cache.has("a.com")).toBe(true); // not evicted until read
		expect(cache.get("a.com")).toBeNull();
		// A subsequent has() reflects the lazy eviction.
		expect(cache.has("a.com")).toBe(false);
	});

	it("evicts the least-recently-used entry when capacity is exceeded", () => {
		cache.set("a.com", makeEntry());
		cache.set("b.com", makeEntry());
		cache.set("c.com", makeEntry());
		// Touch a.com so b.com becomes LRU.
		cache.get("a.com");
		cache.set("d.com", makeEntry()); // over capacity -> evict b.com
		expect(cache.has("a.com")).toBe(true);
		expect(cache.has("b.com")).toBe(false);
		expect(cache.has("c.com")).toBe(true);
		expect(cache.has("d.com")).toBe(true);
	});

	it("set on an existing key updates the value without growing size", () => {
		cache.set("a.com", makeEntry({ contentType: "image/x-icon" }));
		cache.set("a.com", makeEntry({ contentType: "image/png" }));
		expect(cache.size()).toBe(1);
		expect(cache.get("a.com")?.contentType).toBe("image/png");
	});

	it("respects the configured maxSize", () => {
		const big = new FaviconCache({ maxSize: 100, ttlMs: 1000 });
		for (let i = 0; i < 250; i++) {
			big.set(`d${i}.com`, makeEntry());
		}
		expect(big.size()).toBe(100);
		// Oldest entries evicted, newest kept.
		expect(big.has("d0.com")).toBe(false);
		expect(big.has("d249.com")).toBe(true);
	});

	it("clear() empties the cache", () => {
		cache.set("a.com", makeEntry());
		cache.clear();
		expect(cache.size()).toBe(0);
		expect(cache.get("a.com")).toBeNull();
	});
});
