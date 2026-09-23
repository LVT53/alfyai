// Atlas v3 seed freshness (Phase D, ADR 0063; ADR 0037 edge case 5).
//
// A Continue or Revise child reuses its parent's evidence bank. A quote is only
// as good as the page it was copied from WHEN it was copied, so before a seeded
// quote may be cited this module decides, deterministically and without a model
// call, which parent sources can be trusted as they are and which must be
// re-read live first.
//
// "Fresh" (ADR 0037 edge case 5): a source is fresh when it is not
// time-sensitive, or when it was read inside the action's window. Anything else
// is rechecked within a budget; what the budget cannot reach is DROPPED, never
// trusted unread.

import {
	extractFigures,
	figureAppearsInText,
	isCheckableFigure,
} from "./number-match";
import type {
	AtlasV3Claim,
	AtlasV3EvidenceBank,
	AtlasV3Quote,
	AtlasV3Source,
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

function claimYears(claim: Pick<AtlasV3Claim, "period" | "asOf">): number[] {
	const years: number[] = [];
	for (const field of [claim.period, claim.asOf]) {
		for (const match of (field ?? "").matchAll(/\b(?:19|20)\d{2}\b/gu)) {
			years.push(Number(match[0]));
		}
	}
	return years;
}

/**
 * Whether a web source's evidence can go out of date. Either:
 *
 *  - it carries a claim that names no period and no publication date (a
 *    "current" figure — a price, a rate, a head count), or one whose latest
 *    year is this year or last year; or
 *  - it has quotes but no claims at all and comes from a tier that republishes
 *    or chatters (`aggregator`, `weak`): nothing structured says when its text
 *    was true.
 *
 * A source whose every claim names an explicit older period — a 2019 statute,
 * a 2023 annual statistic — is not time-sensitive: re-reading it cannot make
 * the 2023 figure a different 2023 figure. A claim whose period is written
 * without any year ("monthly", "Q3") cannot be dated and counts as sensitive.
 * A user document never is: it says what the user gave, and whether it changed
 * is the local re-resolve's question, not this one.
 */
export function atlasV3SourceIsTimeSensitive(input: {
	source: AtlasV3Source;
	claims: readonly AtlasV3Claim[];
	quotes?: readonly AtlasV3Quote[];
	now: Date;
}): boolean {
	if (input.source.kind === "local") return false;
	const recentYear = input.now.getUTCFullYear() - 1;
	if (input.claims.length > 0) {
		return input.claims.some((claim) => {
			if (!claim.period && !claim.asOf) return true;
			const years = claimYears(claim);
			if (years.length === 0) return true;
			return Math.max(...years) >= recentYear;
		});
	}
	const hasQuotes = (input.quotes ?? []).length > 0;
	return (
		hasQuotes &&
		(input.source.tier === "aggregator" || input.source.tier === "weak")
	);
}

/** The claims a source's quotes carry. */
function claimsForSource(
	bank: AtlasV3EvidenceBank,
	sourceId: string,
): AtlasV3Claim[] {
	const quoteIds = new Set(
		bank.quotes
			.filter((quote) => quote.sourceId === sourceId)
			.map((quote) => quote.id),
	);
	return bank.claims.filter((claim) =>
		claim.evidenceIds.some((id) => quoteIds.has(id)),
	);
}

export interface AtlasV3SeedRecheckPlan {
	/** Web sources used as they are. */
	trusted: string[];
	/** Web sources to re-read live, in priority order, within the budget. */
	recheck: string[];
	/** Time-sensitive web sources past the budget: dropped, never trusted. */
	overBudget: string[];
}

/**
 * Sorts a parent's WEB sources (user documents are re-resolved elsewhere) into
 * trusted, recheck and over-budget:
 *
 *  - not time-sensitive → trusted;
 *  - time-sensitive and read no more than `windowDays` ago → trusted (Continue
 *    only; a Revise's window is 0, so every time-sensitive source is rechecked);
 *  - otherwise → recheck, the parent's CITED sources first, then by how many
 *    claim readings rest on the source, then by id; past `budget` → over budget.
 *
 * A source with no retrieval time uses `fallbackRetrievedAt` (the parent's
 * completion time); with neither, its age is unknown and it is rechecked.
 * A source with no quote holds nothing to trust or recheck and is trusted.
 */
export function planAtlasV3SeedRechecks(input: {
	bank: AtlasV3EvidenceBank;
	action: "continue" | "revise";
	now: Date;
	windowDays: number;
	budget: number;
	citedSourceIds: readonly string[];
	fallbackRetrievedAt: string | null;
}): AtlasV3SeedRecheckPlan {
	const windowMs =
		input.action === "revise" ? 0 : Math.max(0, input.windowDays) * DAY_MS;
	const cited = new Set(input.citedSourceIds);
	const trusted: string[] = [];
	const stale: Array<{ id: string; cited: boolean; load: number }> = [];
	for (const source of input.bank.sources) {
		if (source.kind === "local") continue;
		const quotes = input.bank.quotes.filter(
			(quote) => quote.sourceId === source.id,
		);
		if (quotes.length === 0) {
			trusted.push(source.id);
			continue;
		}
		const claims = claimsForSource(input.bank, source.id);
		if (
			!atlasV3SourceIsTimeSensitive({ source, claims, quotes, now: input.now })
		) {
			trusted.push(source.id);
			continue;
		}
		const retrievedAt = source.retrievedAt ?? input.fallbackRetrievedAt;
		const retrievedMs = retrievedAt ? Date.parse(retrievedAt) : Number.NaN;
		const age = Number.isFinite(retrievedMs)
			? input.now.getTime() - retrievedMs
			: Number.POSITIVE_INFINITY;
		if (windowMs > 0 && age <= windowMs) {
			trusted.push(source.id);
			continue;
		}
		stale.push({
			id: source.id,
			cited: cited.has(source.id),
			load: claims.reduce(
				(total, claim) =>
					total +
					claim.evidenceIds.filter((id) =>
						quotes.some((quote) => quote.id === id),
					).length,
				0,
			),
		});
	}
	stale.sort(
		(left, right) =>
			Number(right.cited) - Number(left.cited) ||
			right.load - left.load ||
			left.id.localeCompare(right.id, "en", { numeric: true }),
	);
	const budget = Math.max(0, Math.floor(input.budget));
	return {
		trusted,
		recheck: stale.slice(0, budget).map((entry) => entry.id),
		overBudget: stale.slice(budget).map((entry) => entry.id),
	};
}

/**
 * Text folded for containment: markdown emphasis, code ticks and link targets
 * gone, typographic quotes and dashes folded, whitespace collapsed, lowercased.
 * A page re-read as markdown and a quote copied from it once must compare equal
 * when the words are the same words.
 */
function foldForContainment(value: string): string {
	return value
		.normalize("NFKC")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
		.replace(/[*_`#>|]+/gu, " ")
		.replace(/[‘’‚‛]/gu, "'")
		.replace(/[“”„‟]/gu, '"')
		.replace(/[‐‑‒–—]/gu, "-")
		.replace(/\s+/gu, " ")
		.trim()
		.toLowerCase();
}

/**
 * Whether the live page still states a seeded quote: the quote occurs in the
 * page (folded as above), and every checkable figure the quote carries still
 * appears in the page. A page that rephrased the sentence, or revised the
 * figure, no longer states it.
 */
export function atlasV3QuoteStillStated(
	quote: AtlasV3Quote,
	pageText: string,
): boolean {
	const needle = foldForContainment(quote.text).replace(/(?:\.\.\.|…)$/u, "");
	if (!needle) return false;
	if (!foldForContainment(pageText).includes(needle.trim())) return false;
	return extractFigures(quote.text)
		.filter(isCheckableFigure)
		.every((figure) => figureAppearsInText(figure, pageText));
}
