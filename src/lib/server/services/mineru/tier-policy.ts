/**
 * Which tier to ask for, and whether to ask at all.
 *
 * Three facts from the spike make this a policy rather than a config read:
 *
 *  1. `tier: null` is a 400. Omission and `null` are NOT the same thing, so the
 *     decision has to be "send this value" or "leave the key out entirely" —
 *     never a nullable field. `TierDecision.tier` is optional, never nullable.
 *  2. Asking for a tier the server does not offer is a 400 `invalid_request`
 *     ("Tier 'standard' not available in this server"), not a 503. It is a
 *     misconfiguration, and it must be caught BEFORE any bytes move rather than
 *     surfacing as an outage after a 40 MB upload.
 *  3. On a flash-only server, OMITTING the tier for a PDF or an image is a 503
 *     `quality_tier_unavailable`. Sending `flash` explicitly turns that same
 *     job into a successful parse.
 *
 * Office/HTML/CSV/EPUB inputs execute at `flash` anyway — `extensions.mineru.tier`
 * says `flash` for all six inside a `basic` job — so asking for it explicitly
 * costs nothing and removes any dependence on the server's start-up tier.
 */

import {
	MINERU_TIER_IDS,
	type MineruDefaultTier,
	type MineruOcrMode,
	type MineruTierId,
} from "./config";
import { MINERU_CLIENT_ERROR_CODES, MineruApiError } from "./errors";

// The vocabulary is `config.ts`'s. Re-exported, never redeclared: a second
// literal union of the same four strings is exactly how the two drift.
export { MINERU_TIER_IDS, type MineruTierId } from "./config";

export type TierDecisionReason =
	| "hint-override"
	| "hint-preferred"
	| "hint-flash"
	| "config-explicit"
	| "auto-quality"
	| "auto-flash-only";

export interface TierDecision {
	/** undefined ⇒ omit the `tier` key entirely. NEVER null. */
	readonly tier?: MineruTierId;
	readonly reason: TierDecisionReason;
	/** One line for the log; explains the row of the table that fired. */
	readonly explanation: string;
}

export interface DecideTierInput {
	/** `getIntakeTierHint(filename, mime)` — "flash" for Office/HTML/CSV/EPUB. */
	intakeTierHint?: "flash" | null;
	configuredTier: MineruDefaultTier;
	/** `/v1/tiers` `data[].id`, already narrowed to the ids we know. */
	availableTiers: readonly MineruTierId[];
	/** The re-extract override: "run this document again at <tier>". */
	hintedTier?: MineruTierId | null;
	/**
	 * A caller's PREFERENCE, not its demand (Phase 6 D10). The generated-file
	 * readback sets it to `flash`: a file this app rendered itself is
	 * born-digital, so OCR is waste and a cold `basic` PDF job costs 18 600 ms.
	 *
	 * Soft, and that is the entire point of the second key. `hintedTier` is a
	 * button the user pressed, so a tier the server lacks has to fail loudly;
	 * this one is a background job nobody is waiting on, and failing it
	 * permanently with `tier_unavailable` because a server dropped `flash` would
	 * trade a slower parse for no parse at all.
	 */
	preferredTier?: MineruTierId | null;
}

/** The tiers that mean "better than flash". */
const QUALITY_TIERS: readonly MineruTierId[] = [
	"basic",
	"standard",
	"advanced",
];

function tierUnavailable(tier: string, source: string): MineruApiError {
	return new MineruApiError({
		code: MINERU_CLIENT_ERROR_CODES.tierNotAvailable,
		message: `MinerU does not offer the ${source} tier "${tier}".`,
		details: { tier, source },
	});
}

export function isMineruTierId(value: string): value is MineruTierId {
	return (MINERU_TIER_IDS as readonly string[]).includes(value);
}

/**
 * Resolution order, first match wins. Throws `tier_unavailable` (via
 * `mapMineruError`) when an explicitly requested tier is not offered — before
 * any bytes move. A `preferredTier` is the one exception: an unavailable
 * preference falls through instead of throwing.
 */
export function decideTier(input: DecideTierInput): TierDecision {
	const available = new Set<string>(input.availableTiers);

	// 1 — the user pressed "Re-extract at …". Explicit intent beats everything.
	if (input.hintedTier) {
		if (!available.has(input.hintedTier)) {
			throw tierUnavailable(input.hintedTier, "requested");
		}
		return {
			tier: input.hintedTier,
			reason: "hint-override",
			explanation: `re-extract requested tier "${input.hintedTier}"`,
		};
	}

	// 1½ — the caller would like a tier. Taken only when the server offers it;
	// otherwise this rule is silent and the ladder continues, which is the one
	// behavioural difference from rule 1 (see `preferredTier`).
	if (input.preferredTier && available.has(input.preferredTier)) {
		return {
			tier: input.preferredTier,
			reason: "hint-preferred",
			explanation: `caller prefers tier "${input.preferredTier}"`,
		};
	}

	// 2 — the intake registry says this format runs at flash regardless. Only
	// taken when the server actually lists flash: asking for a tier a server
	// does not have is a 400, and a server without flash still parses these
	// formats at its own start-up tier.
	if (input.intakeTierHint === "flash" && available.has("flash")) {
		return {
			tier: "flash",
			reason: "hint-flash",
			explanation: "this format executes at flash even inside a basic job",
		};
	}

	// 3 — admin intent.
	if (input.configuredTier !== "auto") {
		if (!available.has(input.configuredTier)) {
			throw tierUnavailable(input.configuredTier, "configured");
		}
		return {
			tier: input.configuredTier,
			reason: "config-explicit",
			explanation: `MINERU_DEFAULT_TIER=${input.configuredTier}`,
		};
	}

	// 5 — a flash-only server: omitting is a 503 for PDF and images, so say it.
	const hasQuality = QUALITY_TIERS.some((tier) => available.has(tier));
	if (!hasQuality && available.has("flash")) {
		return {
			tier: "flash",
			reason: "auto-flash-only",
			explanation: "flash is the only tier this server offers",
		};
	}

	// 4 — defer to the server's start-up tier by leaving the key out. This is
	// what every recorded fixture did (`tier_requested: null`). An unreadable
	// tier list lands here too: omission is the one choice that cannot turn a
	// working server into a 400.
	return {
		reason: "auto-quality",
		explanation: hasQuality
			? "MINERU_DEFAULT_TIER=auto: defer to the server's start-up tier"
			: "MINERU_DEFAULT_TIER=auto with no tier list: omit and defer",
	};
}

/**
 * `auto` means OMIT the key.
 *
 * `ocr_mode: null` is a 400 `invalid_request` with `param: "ocr_mode"` despite
 * the upstream docs promising a default, and omitting keeps the request body
 * byte-identical to the recorded fixtures.
 */
export function decideOcrMode(
	configured: MineruOcrMode,
): "txt" | "ocr" | undefined {
	return configured === "auto" ? undefined : configured;
}

/**
 * Fails fast when we are about to ask for an output format the server cannot
 * produce. Anonymous, that is a 403 `feature_requires_api_key`; with a key it
 * is a 400 `unsupported_output_format` for the same input — neither is worth a
 * round trip, and neither is fixable by retrying.
 */
export function assertMineruOutputFormatsSupported(
	requested: readonly string[],
	available: readonly string[],
): void {
	// An empty advertisement means "health did not tell us", not "nothing is
	// supported". Refusing to extract because a probe was terse would be worse
	// than letting the server answer for itself.
	if (available.length === 0) return;
	const supported = new Set(available);
	const missing = requested.filter((format) => !supported.has(format));
	if (missing.length === 0) return;
	throw new MineruApiError({
		code: "unsupported_output_format",
		message: `MinerU does not offer the output format(s): ${missing.join(", ")}.`,
		details: { missing, available: [...available] },
	});
}
