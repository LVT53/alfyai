/**
 * The MinerU V1 client's view of the runtime configuration.
 *
 * A pure projection: no I/O, no caching, no module-level state. Everything
 * here is read through `getConfig()` at the moment it is needed, which is what
 * lets all twelve MinerU keys be marked `effect: "live"` on the admin screen
 * honestly.
 *
 * This module is also where the tier and OCR vocabularies live, because they
 * are shared: `capabilities.ts` reports which tiers a server offers, the tier
 * policy decides which one to ask for, and the admin registry validates the
 * configured value against the same list.
 */

import { getConfig, type RuntimeConfig } from "$lib/server/config-store";

/** The four tiers the V1 API defines. `auto` is NOT one of them. */
export const MINERU_TIER_IDS = [
	"flash",
	"basic",
	"standard",
	"advanced",
] as const;
export type MineruTierId = (typeof MINERU_TIER_IDS)[number];

/**
 * What `MINERU_DEFAULT_TIER` may hold. `auto` means "send no `tier` key at
 * all": the API rejects `tier: null` with a 400, so omission is the only way
 * to defer to the server's own start-up tier.
 */
export const MINERU_DEFAULT_TIER_VALUES = ["auto", ...MINERU_TIER_IDS] as const;
export type MineruDefaultTier = (typeof MINERU_DEFAULT_TIER_VALUES)[number];

/** `auto` again means "omit the key" — `ocr_mode: null` is also a 400. */
export const MINERU_OCR_MODES = ["auto", "txt", "ocr"] as const;
export type MineruOcrMode = (typeof MINERU_OCR_MODES)[number];

/**
 * The formats every recorded fixture requested, in the recorded order. Asking
 * for a format costs server-side generation, not transfer, and only the `zip`
 * is downloaded — it is the sole artifact that carries the extracted images.
 */
export const MINERU_OUTPUT_FORMATS = [
	"markdown",
	"middle_json",
	"structured_content",
	"zip",
] as const;

export interface MineruConfig {
	/** MINERU_API_URL, trailing slash stripped. */
	readonly baseUrl: string;
	/** MINERU_API_KEY. "" means anonymous, which a local server allows. */
	readonly apiKey: string;
	readonly defaultTier: MineruDefaultTier;
	readonly ocrMode: MineruOcrMode;
	/** Whole-job deadline, upload through download. */
	readonly jobTimeoutMs: number;
	readonly pollMinMs: number;
	readonly pollMaxMs: number;
	/** Control-plane calls: health, tiers, usage, job create, job poll. */
	readonly requestTimeoutMs: number;
	/** Byte movement: PUT the upload, GET the result zip. */
	readonly transferTimeoutMs: number;
	readonly capabilitiesTtlMs: number;
	/** Phase 4: the on-disk parse bundle's size budget. */
	readonly bundleMaxBytes: number;
	/** Phase 4: structure-aware chunking, with the flag as the rollback. */
	readonly structureChunking: boolean;
}

function isTierValue(value: string): value is MineruDefaultTier {
	return (MINERU_DEFAULT_TIER_VALUES as readonly string[]).includes(value);
}

function isOcrMode(value: string): value is MineruOcrMode {
	return (MINERU_OCR_MODES as readonly string[]).includes(value);
}

/**
 * Pure projection of the runtime config. No I/O, no caching.
 *
 * Both enum-valued keys clamp to `auto` rather than throwing. The admin route
 * already validates them against their `select` specs, so the only way an
 * unrecognised value reaches here is a hand-edited environment — and there,
 * deferring to the server beats refusing to extract anything at all.
 */
export function resolveMineruConfig(
	config: RuntimeConfig = getConfig(),
): MineruConfig {
	const tier = config.mineruDefaultTier.trim().toLowerCase();
	const ocr = config.mineruOcrMode.trim().toLowerCase();

	return {
		baseUrl: config.mineruApiUrl.trim().replace(/\/+$/, ""),
		apiKey: config.mineruApiKey.trim(),
		defaultTier: isTierValue(tier) ? tier : "auto",
		ocrMode: isOcrMode(ocr) ? ocr : "auto",
		jobTimeoutMs: config.mineruJobTimeoutMs,
		pollMinMs: config.mineruPollMinMs,
		pollMaxMs: config.mineruPollMaxMs,
		requestTimeoutMs: config.mineruRequestTimeoutMs,
		transferTimeoutMs: config.mineruTransferTimeoutMs,
		capabilitiesTtlMs: config.mineruCapabilitiesTtlMs,
		bundleMaxBytes: config.mineruBundleMaxBytes,
		structureChunking: config.mineruStructureChunkingEnabled,
	};
}

/** `${baseUrl}${path}` with exactly one slash. Throws on a non-absolute base. */
export function mineruUrl(config: MineruConfig, path: `/v1/${string}`): string {
	if (!/^https?:\/\//i.test(config.baseUrl)) {
		throw new Error(
			`MINERU_API_URL must be an absolute http(s) URL, got "${config.baseUrl}"`,
		);
	}
	return `${config.baseUrl}${path}`;
}

/**
 * The same-origin rule for the API key.
 *
 * `upload_url` comes back from the server as an absolute URL, and the client
 * must never forward `Authorization` to an origin that is not
 * `MINERU_API_URL`'s. Compares protocol, hostname and port only — the path is
 * the server's business.
 *
 * Deliberately NOT `connections/host-locality.ts:assertPublicHttpsUrl`: MinerU
 * is normally on loopback or a private address, which is exactly what that
 * SSRF guard exists to reject.
 */
export function isSameMineruOrigin(config: MineruConfig, url: string): boolean {
	try {
		const base = new URL(config.baseUrl);
		const target = new URL(url);
		return (
			base.protocol === target.protocol &&
			base.hostname === target.hostname &&
			base.port === target.port
		);
	} catch {
		return false;
	}
}

/** True when the endpoint is configured at all. */
export function isMineruConfigured(config: MineruConfig): boolean {
	return config.baseUrl.length > 0;
}

/**
 * The endpoint as it may be shown to an admin: origin only, never a path and
 * never a credential.
 */
export function mineruDisplayOrigin(config: MineruConfig): string {
	try {
		return new URL(config.baseUrl).origin;
	} catch {
		return config.baseUrl;
	}
}
