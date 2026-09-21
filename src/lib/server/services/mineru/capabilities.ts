/**
 * What the configured MinerU server can do, read once and reused.
 *
 * Two callers, two shapes:
 *
 *  - `getMineruCapabilities()` is the hot path. Every extraction consults it
 *    before a byte moves, because a tier the server does not offer must fail
 *    fast (a 400 "Tier 'standard' not available" is a misconfiguration, not an
 *    outage, and must not look like one), and because requesting an output
 *    format the server cannot produce is the same kind of mistake.
 *  - `getMineruStatusReport()` is the admin card. Same probe, more fields, and
 *    it never throws: "unreachable, here is why" is the answer, not an error.
 *
 * THE PROBE SEAM. The full V1 protocol client (`client.ts`, `schemas.ts`) is a
 * separate slice and is not imported here — this module would otherwise be the
 * one place a config surface drags the whole extraction protocol into its
 * bundle. Instead it defines the narrow, three-method shape it needs and
 * ships a minimal default implementation over `fetch`. `MineruClient`
 * satisfies `MineruProbeClient` structurally, so swapping it in is
 * `setMineruProbeClientFactory((config) => new MineruClient({ config }))` and
 * nothing else changes.
 */

import type { ExtractionErrorCode } from "$lib/shared/extraction-status";
import {
	isMineruConfigured,
	MINERU_TIER_IDS,
	type MineruConfig,
	type MineruTierId,
	mineruDisplayOrigin,
	mineruUrl,
	resolveMineruConfig,
} from "./config";
import {
	isMineruApiError,
	mapMineruError,
	redactMineruSecrets,
} from "./errors";

// ---------------------------------------------------------------------------
// The shapes read from the server
// ---------------------------------------------------------------------------

/**
 * Structural mirrors of the three responses this module reads. Everything
 * optional, because a minor server upgrade must not turn a working probe into
 * a failure, and because `MineruClient`'s zod-inferred return types have to be
 * assignable to these without either slice importing the other.
 */
export interface MineruHealthLike {
	status?: string;
	version: string;
	features?: {
		webhook?: boolean;
		output_formats?: readonly string[];
		sources?: readonly string[];
	} | null;
}

export interface MineruTierLike {
	id: string;
	description?: string;
	/** Does NOT join to /v1/models[].id — "hybrid-basic" vs "Hybrid-Basic". */
	current_model?: string | null;
}

export interface MineruUsageLike {
	access_level?: string | null;
	limits?: {
		max_pages_per_file?: number | null;
		max_file_size_bytes?: number | null;
		max_files_per_job?: number | null;
		max_concurrent_jobs?: number | null;
	} | null;
}

/** The three calls a capability read needs, and nothing else. */
export interface MineruProbeClient {
	getHealth(signal: AbortSignal): Promise<MineruHealthLike>;
	getTiers(signal: AbortSignal): Promise<MineruTierLike[]>;
	getUsage(signal: AbortSignal): Promise<MineruUsageLike>;
}

export type MineruProbeClientFactory = (
	config: MineruConfig,
) => MineruProbeClient;

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** What the extractor needs before it commits to a job. */
export interface MineruCapabilities {
	version: string;
	outputFormats: readonly string[];
	/** Only the ids this app knows how to ask for. */
	tiers: readonly MineruTierId[];
}

export interface MineruStatusTier {
	/** Not narrowed to MineruTierId: a server that grows a fifth tier should
	 * show it on the admin card rather than vanish from it. */
	id: string;
	description: string;
	currentModel: string | null;
}

export interface MineruStatusReport {
	/** ISO. */
	checkedAt: string;
	/** Origin only — never the key, never a path that could carry a token. */
	baseUrl: string;
	reachable: boolean;
	version: string | null;
	webhook: boolean | null;
	outputFormats: readonly string[];
	sources: readonly string[];
	tiers: readonly MineruStatusTier[];
	accessLevel: "anonymous" | "registered" | null;
	limits: {
		maxFileSizeBytes: number | null;
		maxPagesPerFile: number | null;
		maxFilesPerJob: number | null;
		maxConcurrentJobs: number | null;
	} | null;
	/** Taxonomy code plus a message when `reachable` is false. Never a stack. */
	error: { code: ExtractionErrorCode; message: string } | null;
	/** True when this came from the TTL cache rather than a live probe. */
	cached: boolean;
}

// ---------------------------------------------------------------------------
// The default probe
// ---------------------------------------------------------------------------

const LOG_PREFIX = "[MINERU]";
const MAX_ERROR_BODY_CHARS = 300;

/** A probe failure, already mapped onto the extraction taxonomy. */
export class MineruProbeError extends Error {
	readonly code: ExtractionErrorCode;

	constructor(code: ExtractionErrorCode, message: string) {
		super(message);
		this.name = "MineruProbeError";
		this.code = code;
	}
}

function clampBody(text: string, apiKey = ""): string {
	// Scrubbed BEFORE it is clamped: a 401 body that echoes the Authorization
	// header would otherwise reach the admin card AND, through the extractor,
	// the document owner's own error message on the job row.
	const single = redactMineruSecrets(text, apiKey).replace(/\s+/g, " ").trim();
	return single.length > MAX_ERROR_BODY_CHARS
		? `${single.slice(0, MAX_ERROR_BODY_CHARS)}…`
		: single;
}

/**
 * Maps a probe outcome onto the extraction error taxonomy.
 *
 * Only the codes a *capability read* can legitimately produce appear here. The
 * full request/response table belongs to the protocol client; this is the
 * subset three GETs can reach.
 */
function mapProbeFailure(
	status: number,
	body: string,
	apiKey: string,
): { code: ExtractionErrorCode; message: string } {
	const message = clampBody(body, apiKey) || `HTTP ${status}`;
	if (status === 401 || status === 403) {
		return { code: "auth_failed", message };
	}
	if (status === 429) return { code: "rate_limited", message };
	if (status >= 500) return { code: "unavailable", message };
	return { code: "protocol", message };
}

/**
 * Everything a probe can throw, on the taxonomy.
 *
 * This used to recognise only its own `MineruProbeError` and map every other
 * `Error` to `unavailable` — retryable. The moment `MineruClient` became the
 * probe (which is the whole point of the seam), that turned the one failure
 * which must be PERMANENT into an infinite retry: a deployment still pointing
 * at MinerU 3.x answers 404 on `/v1/health`, which is `protocol`, and it would
 * have been re-probed forever while every upload failed. A wrong API key had
 * the same problem in the other direction.
 *
 * So the protocol client's own table decides. The only thing added on top is a
 * status backstop: `mapMineruError`'s 4xx fallback is deliberately coarse, and
 * a capability read knows more than it does about what a bare 401 or 429 on
 * three plain GETs means.
 */
function describeTransportError(
	error: unknown,
	signal: AbortSignal,
	apiKey = "",
): { code: ExtractionErrorCode; message: string } {
	if (signal.aborted) return { code: "timeout", message: "probe timed out" };
	if (error instanceof MineruProbeError) {
		return { code: error.code, message: error.message };
	}

	const mapping = mapMineruError(error);
	let code = mapping.taxonomy;
	if (!mapping.known && isMineruApiError(error) && error.status !== null) {
		if (error.status === 401 || error.status === 403) code = "auth_failed";
		else if (error.status === 429) code = "rate_limited";
	}

	if (error instanceof Error) {
		const cause = (error as { cause?: { code?: string } }).cause;
		const base = redactMineruSecrets(error.message, apiKey);
		return {
			code,
			message:
				cause?.code && code === "unavailable"
					? `${base} (${cause.code})`
					: base,
		};
	}
	return { code, message: redactMineruSecrets(String(error), apiKey) };
}

/**
 * The one failure that has to be said by name.
 *
 * A MinerU 3.x server has no `/v1` namespace at all, so the probe gets a 404
 * rather than a version. "unreachable" would send an admin looking at the
 * network; this sends them at `MINERU_API_URL`. Applied here rather than in the
 * extractor's adapter so the built-in fetch probe — the one the admin card uses
 * before anything imports the extractor — says it too.
 */
function describeHealthFailure(
	error: unknown,
	signal: AbortSignal,
	config: MineruConfig,
): { code: ExtractionErrorCode; message: string } {
	const described = describeTransportError(error, signal, config.apiKey);
	if (described.code !== "protocol") return described;
	return {
		code: "protocol",
		message: `${mineruDisplayOrigin(config)} is not a MinerU 4 server: ${described.message}. MinerU 3.x is no longer supported; point MINERU_API_URL at a MinerU 4 endpoint.`,
	};
}

/**
 * The built-in probe: three plain GETs with tolerant parsing.
 *
 * It does not validate the bodies against zod — deliberately. A capability
 * read that refuses to answer because the server grew a field would take the
 * admin card down for a cosmetic reason, and every value read here is
 * re-checked where it matters (the tier list gates a job, the format list
 * gates a request).
 */
export function createDefaultMineruProbeClient(
	config: MineruConfig,
	fetchImpl: typeof fetch = fetch,
): MineruProbeClient {
	async function getJson(path: `/v1/${string}`, signal: AbortSignal) {
		const headers: Record<string, string> = { accept: "application/json" };
		// /v1/health stays public even under --api-key, but the other two do
		// not, and sending the key to our own configured origin is safe.
		if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;

		const response = await fetchImpl(mineruUrl(config, path), {
			method: "GET",
			headers,
			signal,
		});
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			const mapped = mapProbeFailure(response.status, body, config.apiKey);
			throw new MineruProbeError(mapped.code, mapped.message);
		}
		try {
			return (await response.json()) as unknown;
		} catch {
			// A 200 is not automatically valid.
			throw new MineruProbeError("protocol", `${path} returned invalid JSON`);
		}
	}

	return {
		async getHealth(signal) {
			const body = getJson("/v1/health", signal);
			const parsed = (await body) as Partial<MineruHealthLike> | null;
			if (!parsed || typeof parsed.version !== "string") {
				throw new MineruProbeError(
					"protocol",
					"/v1/health did not report a version",
				);
			}
			return parsed as MineruHealthLike;
		},
		async getTiers(signal) {
			const parsed = (await getJson("/v1/tiers", signal)) as {
				data?: unknown;
			} | null;
			const rows = Array.isArray(parsed?.data) ? parsed.data : [];
			return rows.filter(
				(row): row is MineruTierLike =>
					typeof (row as MineruTierLike | null)?.id === "string",
			);
		},
		async getUsage(signal) {
			return ((await getJson("/v1/usage", signal)) ?? {}) as MineruUsageLike;
		},
	};
}

let probeClientFactory: MineruProbeClientFactory = (config) =>
	createDefaultMineruProbeClient(config);

/**
 * Replaces the probe implementation. Pass `null` to go back to the built-in
 * one. The protocol slice uses this to route capability reads through the real
 * `MineruClient` (same three methods, same signatures) once it exists; tests
 * use it to answer without a socket.
 */
export function setMineruProbeClientFactory(
	factory: MineruProbeClientFactory | null,
): void {
	probeClientFactory =
		factory ?? ((config) => createDefaultMineruProbeClient(config));
}

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------

interface CacheEntry {
	fetchedAt: number;
	report: MineruStatusReport;
}

let cached: CacheEntry | null = null;
let inFlight: Promise<MineruStatusReport> | null = null;

/** Test seam: forget the cached probe. */
export function resetMineruCapabilitiesCacheForTests(): void {
	cached = null;
	inFlight = null;
}

function isFresh(entry: CacheEntry, ttlMs: number, now: number): boolean {
	return ttlMs > 0 && now - entry.fetchedAt < ttlMs;
}

/**
 * A failed refresh must not poison a still-valid entry, but it must not let a
 * stale one be served forever either. Two times the TTL is the grace window:
 * long enough to ride out a restart, short enough that an admin looking at the
 * card during a real outage is told the truth.
 */
function isServableWhileFailing(
	entry: CacheEntry,
	ttlMs: number,
	now: number,
): boolean {
	return ttlMs > 0 && now - entry.fetchedAt < ttlMs * 2;
}

function emptyLimits(): MineruStatusReport["limits"] {
	return null;
}

function normalizeAccessLevel(
	value: unknown,
): "anonymous" | "registered" | null {
	return value === "anonymous" || value === "registered" ? value : null;
}

async function probe(
	config: MineruConfig,
	now: () => number,
): Promise<MineruStatusReport> {
	const origin = mineruDisplayOrigin(config);
	const base: MineruStatusReport = {
		checkedAt: new Date(now()).toISOString(),
		baseUrl: origin,
		reachable: false,
		version: null,
		webhook: null,
		outputFormats: [],
		sources: [],
		tiers: [],
		accessLevel: null,
		limits: emptyLimits(),
		error: null,
		cached: false,
	};

	if (!isMineruConfigured(config)) {
		return {
			...base,
			error: { code: "unavailable", message: "MINERU_API_URL is empty" },
		};
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => {
		controller.abort();
	}, config.requestTimeoutMs);

	try {
		const client = probeClientFactory(config);
		let health: MineruHealthLike;
		try {
			health = await client.getHealth(controller.signal);
		} catch (error) {
			const described = describeHealthFailure(error, controller.signal, config);
			throw new MineruProbeError(described.code, described.message);
		}
		const features = health.features ?? null;

		// Health is the only call that is public under `--api-key`, so the other
		// two may legitimately fail on a keyed server that we have no key for.
		// A card that says "reachable, 4.0.4, tiers unknown" is more useful than
		// one that says "unreachable" because /v1/usage was 401.
		let tiers: MineruTierLike[] = [];
		let usage: MineruUsageLike = {};
		try {
			tiers = await client.getTiers(controller.signal);
		} catch (error) {
			console.warn(
				`${LOG_PREFIX} tier list unavailable:`,
				describeTransportError(error, controller.signal, config.apiKey).message,
			);
		}
		try {
			usage = await client.getUsage(controller.signal);
		} catch {
			// Usage is admin-card decoration only; never worth a warning.
		}

		const limits = usage.limits ?? null;
		return {
			...base,
			reachable: true,
			version: health.version,
			webhook: typeof features?.webhook === "boolean" ? features.webhook : null,
			outputFormats: [...(features?.output_formats ?? [])],
			sources: [...(features?.sources ?? [])],
			tiers: tiers.map((tier) => ({
				id: tier.id,
				description: tier.description ?? "",
				currentModel: tier.current_model ?? null,
			})),
			accessLevel: normalizeAccessLevel(usage.access_level),
			limits: limits
				? {
						maxFileSizeBytes: limits.max_file_size_bytes ?? null,
						maxPagesPerFile: limits.max_pages_per_file ?? null,
						maxFilesPerJob: limits.max_files_per_job ?? null,
						maxConcurrentJobs: limits.max_concurrent_jobs ?? null,
					}
				: null,
		};
	} catch (error) {
		const described = describeTransportError(
			error,
			controller.signal,
			config.apiKey,
		);
		console.warn(`${LOG_PREFIX} status probe failed:`, described.message);
		return { ...base, error: described };
	} finally {
		clearTimeout(timeout);
	}
}

export interface MineruStatusOptions {
	/** Ignore the cache and probe now. */
	refresh?: boolean;
	config?: MineruConfig;
	now?: () => number;
}

/**
 * The admin card's read. Never throws; an unreachable server is a report with
 * `reachable: false` and a taxonomy code.
 *
 * One in-flight probe at a time, so a burst of extractions plus an admin
 * pressing "Re-check" issues one request, not three.
 */
export async function getMineruStatusReport(
	options: MineruStatusOptions = {},
): Promise<MineruStatusReport> {
	const config = options.config ?? resolveMineruConfig();
	const now = options.now ?? Date.now;
	const at = now();

	if (
		!options.refresh &&
		cached &&
		isFresh(cached, config.capabilitiesTtlMs, at)
	) {
		return { ...cached.report, cached: true };
	}

	if (inFlight) return inFlight;

	const previous = cached;
	inFlight = probe(config, now)
		.then((report) => {
			if (report.reachable) {
				cached = { fetchedAt: now(), report };
				return report;
			}
			// A failed refresh keeps a still-fresh entry alive rather than
			// replacing a good answer with a transient one.
			if (
				previous &&
				isServableWhileFailing(previous, config.capabilitiesTtlMs, now())
			) {
				return { ...previous.report, cached: true };
			}
			cached = null;
			return report;
		})
		.finally(() => {
			inFlight = null;
		});

	return inFlight;
}

/**
 * The hot path. Throws `MineruProbeError` when the server cannot be read at
 * all, because an extractor that cannot learn the tier list must fail before
 * it uploads anything rather than guess.
 */
export async function getMineruCapabilities(
	signal?: AbortSignal,
	options: MineruStatusOptions = {},
): Promise<MineruCapabilities> {
	signal?.throwIfAborted();
	const report = await getMineruStatusReport(options);
	if (!report.reachable) {
		throw new MineruProbeError(
			report.error?.code ?? "unavailable",
			report.error?.message ?? "MinerU is unreachable",
		);
	}
	const known = new Set<string>(MINERU_TIER_IDS);
	return {
		version: report.version ?? "",
		outputFormats: report.outputFormats,
		tiers: report.tiers
			.map((tier) => tier.id)
			.filter((id): id is MineruTierId => known.has(id)),
	};
}
