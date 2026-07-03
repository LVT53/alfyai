/**
 * Bounded in-memory LRU cache for the favicon proxy (ADR 0043, Slice 12).
 *
 * One entry per validated domain. JS `Map` iterates in insertion order, so we
 * implement LRU recency by deleting + re-inserting a key whenever it is read
 * or written. When capacity is exceeded the oldest (least-recently-used) entry
 * is evicted. TTL is enforced lazily on read.
 */
export interface CachedFavicon {
	/** Raw image bytes (ico/png/svg/...). */
	bytes: Uint8Array;
	/** The content-type captured from the upstream response. */
	contentType: string;
	/** Epoch-ms after which the entry is stale. */
	expiresAt: number;
}

export interface FaviconCacheOptions {
	/** Maximum number of entries kept in memory. */
	maxSize: number;
	/** Entry lifetime in milliseconds. */
	ttlMs: number;
}

export class FaviconCache {
	private readonly store = new Map<string, CachedFavicon>();
	private readonly maxSize: number;
	private readonly ttlMs: number;

	constructor(opts: FaviconCacheOptions) {
		if (!Number.isFinite(opts.maxSize) || opts.maxSize <= 0) {
			throw new Error(
				`FaviconCache maxSize must be positive, got ${opts.maxSize}`,
			);
		}
		this.maxSize = Math.floor(opts.maxSize);
		this.ttlMs = opts.ttlMs;
	}

	/** Build a `CachedFavicon` with an expiry computed from this cache's TTL. */
	wrap(
		bytes: Uint8Array,
		contentType: string,
		now: number = Date.now(),
	): CachedFavicon {
		return { bytes, contentType, expiresAt: now + this.ttlMs };
	}

	has(key: string): boolean {
		return this.store.has(key);
	}

	get(key: string): CachedFavicon | null {
		const entry = this.store.get(key);
		if (entry === undefined) return null;
		if (entry.expiresAt <= Date.now()) {
			// Lazy TTL eviction.
			this.store.delete(key);
			return null;
		}
		// Bump recency: re-insert so this key is now the most-recently-used.
		this.store.delete(key);
		this.store.set(key, entry);
		return entry;
	}

	set(key: string, value: CachedFavicon): void {
		if (this.store.has(key)) this.store.delete(key);
		this.store.set(key, value);
		while (this.store.size > this.maxSize) {
			// Map iteration order = insertion order; first key is LRU.
			const oldest = this.store.keys().next().value;
			if (oldest === undefined) break;
			this.store.delete(oldest);
		}
	}

	size(): number {
		return this.store.size;
	}

	clear(): void {
		this.store.clear();
	}
}
