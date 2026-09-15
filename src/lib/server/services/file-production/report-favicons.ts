/**
 * Source favicons for rendered reports, inlined as self-contained `data:` URIs.
 *
 * Why not just point an `<img>` at the source domain (what the renderer did
 * before `a2eebf60`)? A rendered report is a STANDALONE file the reader opens
 * outside the app, often from disk over `file://`. A remote
 * `https://<domain>/favicon.ico` per cited source makes the reader's browser
 * call every cited domain when they open the report, telling those domains
 * which report was read. The chat UI dodges that with the same-origin
 * `/api/favicon` proxy, but a root-relative path cannot resolve inside a
 * downloaded file and the renderer runs in a background worker with no request
 * context to build an absolute URL from.
 *
 * So we resolve the icons HERE, on the server, through the very same
 * `fetchFavicon` path the `/api/favicon` proxy uses, and hand the renderer
 * bytes it can inline. The report keeps its real favicons, and opening it still
 * makes zero outbound requests.
 */
import { validateFaviconDomain } from "$lib/server/favicon/domain";
import { fetchFavicon } from "$lib/server/favicon/fetch";
import { FaviconCache } from "$lib/server/favicon/lru";
import type {
	GeneratedDocumentBlock,
	GeneratedDocumentSource,
} from "./source-schema";

/** Validated host -> `data:` URI carrying that host's icon. */
export type ReportFavicons = ReadonlyMap<string, string>;

export const EMPTY_REPORT_FAVICONS: ReportFavicons = new Map<string, string>();

/** A report cites a bounded number of domains; refuse to fan out past this. */
const MAX_HOSTS = 48;
/** In-flight fetches. Keeps a 40-source report from opening 40 sockets. */
const CONCURRENCY = 6;
/** A slow icon must never hold up the report. */
const TIMEOUT_MS = 2500;
/**
 * Base64 inflates by ~4/3, so this caps a single icon's contribution to the
 * HTML at ~32 KB. Anything larger is a banner, not a favicon.
 */
const MAX_ICON_BYTES = 24 * 1024;

const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Shared across renders in a process, exactly like the proxy route's cache. */
const sharedCache = new FaviconCache({ maxSize: 512, ttlMs: TTL_MS });

export interface ResolveReportFaviconsOptions {
	/** Injectable for tests. Defaults to the global fetch. */
	fetch?: typeof globalThis.fetch;
	/** Injectable for tests; defaults to the module-level shared cache. */
	cache?: FaviconCache;
	/** Set to 0 to disable the per-request timeout (tests). */
	timeoutMs?: number;
}

/**
 * The host a source chip's icon belongs to, or `null` when the URL is absent,
 * unparseable, or points somewhere we refuse to fetch (SSRF guard shared with
 * the proxy route).
 */
export function reportFaviconHost(
	url: string | null | undefined,
): string | null {
	if (!url) return null;
	try {
		return validateFaviconDomain(new URL(url).hostname);
	} catch {
		return null;
	}
}

/** Every source URL the rendered report can show an icon next to. */
export function collectReportFaviconHosts(
	source: GeneratedDocumentSource,
): string[] {
	const hosts = new Set<string>();
	const add = (url: string | null | undefined) => {
		const host = reportFaviconHost(url);
		if (host) hosts.add(host);
	};
	for (const block of source.blocks) {
		collectBlockFaviconHosts(block, add);
	}
	return [...hosts].slice(0, MAX_HOSTS);
}

function collectBlockFaviconHosts(
	block: GeneratedDocumentBlock,
	add: (url: string | null | undefined) => void,
): void {
	if (block.type === "sourceChips") {
		for (const chip of block.sources) add(chip.url);
		return;
	}
	if (block.type === "basisMarker") {
		for (const ref of block.sourceRefs ?? []) add(ref.url);
		return;
	}
	if (block.type === "paragraph") {
		for (const chip of block.sources ?? []) add(chip.url);
		for (const marker of block.basisMarkers ?? []) {
			for (const ref of marker.sourceRefs ?? []) add(ref.url);
		}
	}
}

/**
 * Resolve every cited domain's icon into a `data:` URI. Hosts whose icon does
 * not resolve are simply absent from the map — the renderer draws its inline
 * globe for those, which is the same glyph it has always used for a source with
 * no icon.
 */
export async function resolveReportFavicons(
	source: GeneratedDocumentSource,
	options: ResolveReportFaviconsOptions = {},
): Promise<ReportFavicons> {
	const hosts = collectReportFaviconHosts(source);
	if (hosts.length === 0) return EMPTY_REPORT_FAVICONS;

	const resolved = new Map<string, string>();
	const queue = [...hosts];
	const workers = Array.from(
		{ length: Math.min(CONCURRENCY, queue.length) },
		async () => {
			for (;;) {
				const host = queue.shift();
				if (host === undefined) return;
				const dataUri = await resolveOne(host, options);
				if (dataUri) resolved.set(host, dataUri);
			}
		},
	);
	await Promise.all(workers);
	return resolved;
}

async function resolveOne(
	host: string,
	options: ResolveReportFaviconsOptions,
): Promise<string | null> {
	try {
		const result = await fetchFavicon(host, {
			cache: options.cache ?? sharedCache,
			fetch: withTimeout(options.fetch ?? globalThis.fetch, options.timeoutMs),
		});
		if (result.kind !== "image") return null;
		// The proxy negative-caches failures AS the globe SVG; that is the
		// renderer's own fallback, so do not inline a second copy of it per source.
		if (
			result.contentType === "image/svg+xml" &&
			isGlobeFallback(result.bytes)
		) {
			return null;
		}
		if (result.bytes.byteLength === 0) return null;
		if (result.bytes.byteLength > MAX_ICON_BYTES) return null;
		return `data:${result.contentType};base64,${Buffer.from(result.bytes).toString("base64")}`;
	} catch {
		return null;
	}
}

function isGlobeFallback(bytes: Uint8Array): boolean {
	// Cheap shape check: our globe is a tiny hand-written SVG with this marker.
	if (bytes.byteLength > 1024) return false;
	return Buffer.from(bytes).toString("utf8").includes('aria-label="link"');
}

function withTimeout(
	fetchImpl: typeof globalThis.fetch,
	timeoutMs: number | undefined,
): typeof globalThis.fetch {
	const ms = timeoutMs ?? TIMEOUT_MS;
	if (ms <= 0) return fetchImpl;
	return ((input, init) =>
		fetchImpl(input, {
			...init,
			signal: AbortSignal.timeout(ms),
		})) as typeof globalThis.fetch;
}
