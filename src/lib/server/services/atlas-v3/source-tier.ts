// Source tiering for Atlas v3 (ADR 0063).
//
// v2 treated every hit alike, which is how a frame.work marketplace navigation
// menu became "the marketplace lists 14 items … 32 mainboard options" — a nav
// menu read as a data table — and how a Hungarian minimum-wage report cited
// biztosdontes.hu instead of the Magyar Közlöny.
//
// Tiering does three jobs here: it orders the READ budget (pages are read
// top-tier first), it gates CORROBORATION (a claim resting only on `weak`
// sources is never `verified`), and it names the sources the researcher should
// reach for in its own prompt.
//
// The organisation identity itself is v2's (`atlas-v2/publishers.ts`), reused
// unchanged: two hosts corroborate each other only when their organisations
// differ, and every aggregator collapses onto one organisation.

import {
	isSyndicationHost,
	organisationForHost,
	registrableDomain,
} from "../atlas-v2/publishers";
import {
	type AtlasV3NativeSourceSet,
	isAtlasV3NativePrimaryHost,
} from "./language-standard";
import type { AtlasV3SourceTier } from "./types";

/** Host suffixes that are primary sources wherever the question is about. */
const PRIMARY_HOST_SUFFIXES: readonly string[] = [
	// Governments, regulators, parliaments, courts.
	"gov",
	"gov.uk",
	"gov.ie",
	"gov.au",
	"gov.hu",
	"europa.eu",
	"un.org",
	"who.int",
	"oecd.org",
	"imf.org",
	"worldbank.org",
	"bis.org",
	"ecb.europa.eu",
	"iea.org",
	"irena.org",
	"eia.gov",
	"esa.int",
	"nasa.gov",
	"noaa.gov",
	// National statistics offices and central banks. These are primary wherever
	// the question is about, not only when the request names their country.
	"cso.ie",
	"cbs.nl",
	"ksh.hu",
	"mnb.hu",
	"ons.gov.uk",
	"destatis.de",
	"insee.fr",
	"istat.it",
	"ine.es",
	"scb.se",
	"ssb.no",
	"dst.dk",
	"stat.fi",
	"statcan.gc.ca",
	"abs.gov.au",
	"stats.govt.nz",
	"bls.gov",
	"census.gov",
	"federalreserve.gov",
	"bundesbank.de",
	"banque-france.fr",
	// Standards bodies.
	"iso.org",
	"iec.ch",
	"ietf.org",
	"w3.org",
	"itu.int",
	"cenelec.eu",
	"cen.eu",
	"nist.gov",
	"etsi.org",
	// Research and primary literature.
	"nih.gov",
	"ncbi.nlm.nih.gov",
	"pubmed.ncbi.nlm.nih.gov",
	"arxiv.org",
	"nature.com",
	"science.org",
	"thelancet.com",
	"nejm.org",
	"bmj.com",
	"cochranelibrary.com",
	"sec.gov",
	"edgar.sec.gov",
];

/** Top-level domains that are institutional wherever they appear. */
const PRIMARY_TLDS: readonly string[] = [".gov", ".mil", ".int"];

/** Academic suffixes: `.edu`, `.ac.uk`, `.edu.au`, `.ac.jp`. */
const ACADEMIC_PATTERN = /(^|\.)(edu|ac)(\.[a-z]{2,3})?$/u;

/**
 * Newsrooms with their own reporting. Kept short deliberately: an unknown
 * host is `press` by default, and the tiers that matter for correctness are
 * `primary` (promoted) and `weak` (demoted).
 */
const PRESS_ORGANISATIONS: readonly string[] = [
	"bbc",
	"guardian",
	"nytimes",
	"ft",
	"reuters",
	"ap",
	"bloomberg",
	"economist",
	"wsj",
	"rte",
	"irishtimes",
	"nos",
	"nrc",
	"telex",
	"hvg",
	"444",
];

/**
 * Hosts and path shapes that are never evidence for a factual claim: user
 * forums, marketplaces, listing pages, menus and vendor marketing funnels.
 * This is what stops a nav menu becoming a cited datum.
 */
const WEAK_HOST_SUFFIXES: readonly string[] = [
	"reddit.com",
	"quora.com",
	"stackexchange.com",
	"answers.yahoo.com",
	"medium.com",
	"substack.com",
	"blogspot.com",
	"wordpress.com",
	"wixsite.com",
	"pinterest.com",
	"tripadvisor.com",
	"yelp.com",
	"amazon.com",
	"ebay.com",
	"aliexpress.com",
	"etsy.com",
	"alibaba.com",
	"temu.com",
	"facebook.com",
	"x.com",
	"twitter.com",
	"tiktok.com",
	"instagram.com",
	"youtube.com",
	"glassdoor.com",
	"indeed.com",
];

/** Path segments that mark a listing, cart or menu page rather than a document. */
const WEAK_PATH_PATTERN =
	/\/(cart|checkout|basket|marketplace|shop|store|catalog|catalogue|category|collections|search|tag|tags|author|login|signup|register|menu|etlap|kosar|kosár|arlista|árlista)(\/|$)/iu;

/** Query shapes that mark a search-results page. */
const WEAK_QUERY_PATTERN = /[?&](q|query|s|search|keyword)=/iu;

function hostMatches(host: string, suffixes: readonly string[]): boolean {
	const normalized = host.toLowerCase().replace(/\.$/, "");
	return suffixes.some(
		(suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
	);
}

export interface AtlasV3TierInput {
	host: string;
	canonicalUrl: string;
	title?: string | null;
	/** Native primary sources for the jurisdictions the request is about. */
	nativeSources?: readonly AtlasV3NativeSourceSet[];
	/**
	 * Hosts the ask named as the subject's own documentation — a manufacturer
	 * for a product question, an issuer for a filings question. A first-party
	 * specification is a primary source; the same host's shop page is not.
	 */
	manufacturerHosts?: readonly string[];
}

/**
 * The tier of one source. Order of decision matters: a marketplace path on a
 * manufacturer's own domain is `weak`, not `primary`, because the page is a
 * listing whatever the domain says.
 */
export function atlasV3SourceTier(input: AtlasV3TierInput): AtlasV3SourceTier {
	const host = input.host.toLowerCase().replace(/\.$/, "");
	let path = "";
	let query = "";
	try {
		const url = new URL(input.canonicalUrl);
		path = url.pathname;
		query = url.search;
	} catch {
		path = "";
	}

	if (
		WEAK_PATH_PATTERN.test(path) ||
		WEAK_QUERY_PATTERN.test(query) ||
		hostMatches(host, WEAK_HOST_SUFFIXES)
	) {
		return "weak";
	}
	if (isSyndicationHost(host)) return "aggregator";

	if (
		hostMatches(host, PRIMARY_HOST_SUFFIXES) ||
		PRIMARY_TLDS.some((tld) => host.endsWith(tld)) ||
		ACADEMIC_PATTERN.test(host) ||
		isAtlasV3NativePrimaryHost(host, input.nativeSources ?? [])
	) {
		return "primary";
	}
	// A manufacturer's own documentation, spec sheet or support page.
	if (
		input.manufacturerHosts?.some(
			(candidate) =>
				registrableDomain(host) === registrableDomain(candidate.toLowerCase()),
		)
	) {
		return "primary";
	}
	if (PRESS_ORGANISATIONS.includes(organisationForHost(host))) return "press";
	// Unknown but not obviously bad: treat as press, one rank below primary.
	return "press";
}

/** Sort key, best first, so the read budget is spent top-down. */
export const ATLAS_V3_TIER_RANK: Record<AtlasV3SourceTier, number> = {
	primary: 0,
	press: 1,
	aggregator: 2,
	weak: 3,
};

/**
 * A claim resting only on these tiers can never be `verified`, however many
 * hosts state it: two aggregators carrying one wire story are one publisher,
 * and a forum post is not a publisher at all.
 */
export function tierCanCorroborate(tier: AtlasV3SourceTier): boolean {
	return tier === "primary" || tier === "press";
}

/** The pages worth reading, best tier first, capped at the profile budget. */
export function selectAtlasV3PagesToRead<
	T extends { canonicalUrl: string; host: string },
>(
	candidates: readonly T[],
	limit: number,
	tierInput?: Omit<AtlasV3TierInput, "host" | "canonicalUrl">,
): T[] {
	const seenPublishers = new Set<string>();
	const ranked = [...candidates]
		.map((candidate, position) => ({
			candidate,
			position,
			tier: atlasV3SourceTier({
				host: candidate.host,
				canonicalUrl: candidate.canonicalUrl,
				...tierInput,
			}),
		}))
		.filter((entry) => entry.tier !== "weak")
		.sort(
			(left, right) =>
				ATLAS_V3_TIER_RANK[left.tier] - ATLAS_V3_TIER_RANK[right.tier] ||
				left.position - right.position,
		);
	const chosen: T[] = [];
	// One page per publisher first: reading three pages from one newsroom buys
	// one publisher's view at three times the cost.
	for (const entry of ranked) {
		if (chosen.length >= limit) break;
		const publisher = organisationForHost(entry.candidate.host);
		if (seenPublishers.has(publisher)) continue;
		seenPublishers.add(publisher);
		chosen.push(entry.candidate);
	}
	for (const entry of ranked) {
		if (chosen.length >= limit) break;
		if (chosen.includes(entry.candidate)) continue;
		chosen.push(entry.candidate);
	}
	return chosen;
}
