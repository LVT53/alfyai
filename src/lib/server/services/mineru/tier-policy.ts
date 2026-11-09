/**
 * Which tier to ask for, and whether to ask at all (S4).
 *
 * Four facts from the 4.1 spike make this a policy rather than a config read:
 *
 *  1. **An omitted tier is not "the best one".** It silently falls back to the
 *     server's own start-up tier, which on a box started below Standard means a
 *     PDF is parsed at Basic or Flash and the task still succeeds (D14). So a PDF
 *     or an image always names its tier, and "auto" is resolved HERE, from the
 *     tiers `/v1/tiers` lists: standard, then basic, then flash. `advanced` is
 *     never picked for you; only a person or an admin who named it gets it.
 *  2. **A native document never names one.** Office, HTML, CSV and EPUB inputs
 *     execute at `flash` whatever is asked (`.docx` + `tier: standard` ran as
 *     flash), and `.docx` + `tier: advanced` was accepted at create and then never
 *     ran, a task that waits for nothing. There is nothing to gain and a stuck
 *     task to lose, so the key is left out, even for a re-extract hint.
 *  3. **`tier: null` is the same trap as an omission, and `ocr_mode: null` is a
 *     400.** The decision is therefore "send this value" or "leave the key out
 *     entirely", never a nullable field: `TierDecision.tier` is optional, never
 *     null.
 *  4. **A tier the server does not offer is a 400 `invalid_request` with
 *     `param: "tier"`** ("Tier 'standard' is not available"), a misconfiguration
 *     and never an outage. It is caught here, before the request, whenever the
 *     tier list says so; and when the list was stale, the 400 maps to the same
 *     non-retryable `tier_unavailable` (`mineru/errors.ts`), so it cannot loop.
 *     The exception is a list that was not read at all (empty, see the auto row):
 *     it cannot say the tier is missing, so an explicit tier is then a retryable
 *     `unavailable`, and the next attempt reads the list again.
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
	| "native-document"
	| "hint-override"
	| "hint-preferred"
	| "config-explicit"
	| "auto-best"
	| "auto-no-tier-list";

export interface TierDecision {
	/** undefined ⇒ omit the `tier` key entirely. NEVER null. */
	readonly tier?: MineruTierId;
	readonly reason: TierDecisionReason;
	/** One line for the log; explains the row of the table that fired. */
	readonly explanation: string;
}

export interface DecideTierInput {
	/**
	 * `getIntakeTierHint(filename, mime)`: "flash" for Office, HTML, CSV and EPUB,
	 * which is to say "this is a native document" (the registry's word for the
	 * tier such a file always executes at).
	 */
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

/**
 * What "auto" means for a PDF or an image: the best of these the server lists,
 * in this order (S4). `advanced` is deliberately not on it.
 */
const AUTO_TIER_ORDER: readonly MineruTierId[] = ["standard", "basic", "flash"];

/**
 * What "auto" means: the best tier of the standard, basic, flash ladder that
 * the server lists, or null when it lists none of them. The one definition: the
 * extractor asks it per document, and the backfill script asks it once for the
 * tier it requests a whole library at, so the two can never mean different
 * things by the same setting.
 */
export function bestAutoTier(
	availableTiers: readonly MineruTierId[],
): MineruTierId | null {
	const available = new Set<string>(availableTiers);
	return AUTO_TIER_ORDER.find((tier) => available.has(tier)) ?? null;
}

function tierUnavailable(tier: string, source: string): MineruApiError {
	return new MineruApiError({
		code: MINERU_CLIENT_ERROR_CODES.tierNotAvailable,
		message: `MinerU does not offer the ${source} tier "${tier}".`,
		details: { tier, source },
	});
}

/**
 * An explicit tier the list does not hold. A list that was read and lacks it is
 * the admin's misconfiguration, never retried. An empty list is one that was not
 * read (a healthy 4.1 server lists flash at least, and rule 4's "no tier list"
 * says the same), so it proves nothing about the tier: that is an outage's
 * `unavailable`, and a transient failure of `/v1/tiers` costs the document a
 * wait instead of its life.
 */
function explicitTierMissing(
	tier: string,
	source: string,
	available: ReadonlySet<string>,
): MineruApiError {
	if (available.size > 0) return tierUnavailable(tier, source);
	return new MineruApiError({
		code: MINERU_CLIENT_ERROR_CODES.tierListUnreadable,
		message: `MinerU's tier list could not be read, so the ${source} tier "${tier}" could not be checked.`,
		details: { tier, source },
	});
}

export function isMineruTierId(value: string): value is MineruTierId {
	return (MINERU_TIER_IDS as readonly string[]).includes(value);
}

/**
 * Resolution order, first match wins. Throws `tier_unavailable` (via
 * `mapMineruError`) when an explicitly requested tier is not offered, before
 * any request is made. A `preferredTier` is the one exception: an unavailable
 * preference falls through instead of throwing.
 */
export function decideTier(input: DecideTierInput): TierDecision {
	const available = new Set<string>(input.availableTiers);

	// 0: a native document. No tier is sent, whatever else was asked: the server
	// ignores a valid one and never runs `advanced` (see the header).
	if (input.intakeTierHint === "flash") {
		return {
			reason: "native-document",
			explanation:
				"a native document executes at flash whatever is asked: no tier is sent",
		};
	}

	// 1: the user pressed "Re-extract at …". Explicit intent beats everything.
	if (input.hintedTier) {
		if (!available.has(input.hintedTier)) {
			throw explicitTierMissing(input.hintedTier, "requested", available);
		}
		return {
			tier: input.hintedTier,
			reason: "hint-override",
			explanation: `re-extract requested tier "${input.hintedTier}"`,
		};
	}

	// 1½: the caller would like a tier. Taken only when the server offers it;
	// otherwise this rule is silent and the ladder continues, which is the one
	// behavioural difference from rule 1 (see `preferredTier`).
	if (input.preferredTier && available.has(input.preferredTier)) {
		return {
			tier: input.preferredTier,
			reason: "hint-preferred",
			explanation: `caller prefers tier "${input.preferredTier}"`,
		};
	}

	// 2: admin intent.
	if (input.configuredTier !== "auto") {
		if (!available.has(input.configuredTier)) {
			throw explicitTierMissing(input.configuredTier, "configured", available);
		}
		return {
			tier: input.configuredTier,
			reason: "config-explicit",
			explanation: `MINERU_DEFAULT_TIER=${input.configuredTier}`,
		};
	}

	// 3: auto means the best tier this server lists.
	const best = bestAutoTier(input.availableTiers);
	if (best) {
		return {
			tier: best,
			reason: "auto-best",
			explanation: `MINERU_DEFAULT_TIER=auto: the best tier this server lists is "${best}"`,
		};
	}

	// 4: nothing to choose from. An unreadable tier list is the only way here (a
	// healthy 4.1 server always lists flash at least), and omission is then the one
	// choice that cannot turn a working server into a 400.
	return {
		reason: "auto-no-tier-list",
		explanation:
			"MINERU_DEFAULT_TIER=auto with no tier list to choose from: no tier is sent",
	};
}

/**
 * `auto` means OMIT the key.
 *
 * `ocr_mode: null` is a 400 `invalid_request` with `param: "ocr_mode"` despite
 * the upstream docs promising a default (D19), and omitting leaves the choice to
 * the server's per-file detection.
 */
export function decideOcrMode(
	configured: MineruOcrMode,
): "txt" | "ocr" | undefined {
	return configured === "auto" ? undefined : configured;
}
