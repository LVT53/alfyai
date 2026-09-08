// Publisher identity for Atlas v2 corroboration (ADR 0062).
//
// "Corroborated" means the same figure appears in ≥2 sources from DIFFERENT
// organisations. Host equality is too weak (bbc.com and bbc.co.uk are one
// newsroom) and too strong (two unrelated .gov.uk sites are independent), so
// this module maps a host onto an organisation id through three rules, in
// order:
//
//   1. an explicit publisher table (one newsroom, several hostnames);
//   2. a syndication table — aggregators that republish other outlets' copy.
//      They all collapse onto ONE `aggregator:*` id so two aggregators
//      carrying the same wire story never count as two organisations;
//   3. the registrable domain, after stripping CDN/staging/mirror prefixes.

/** Hostnames of one newsroom or institution, keyed by organisation id. */
const PUBLISHER_HOST_GROUPS: Record<string, readonly string[]> = {
	bbc: ["bbc.com", "bbc.co.uk", "bbci.co.uk"],
	guardian: ["theguardian.com", "guardian.co.uk", "guardianapis.com"],
	nytimes: ["nytimes.com", "nyt.com"],
	ft: ["ft.com", "ftalphaville.ft.com"],
	reuters: ["reuters.com", "reutersagency.com"],
	ap: ["apnews.com", "ap.org"],
	bloomberg: ["bloomberg.com", "bloomberglaw.com"],
	economist: ["economist.com"],
	wsj: ["wsj.com", "dowjones.com"],
	rte: ["rte.ie"],
	irishtimes: ["irishtimes.com"],
	nos: ["nos.nl"],
	nrc: ["nrc.nl"],
	telex: ["telex.hu"],
	hvg: ["hvg.hu"],
	"444": ["444.hu"],
	// Institutions whose statistics Atlas quotes most often.
	iea: ["iea.org", "iea.blob.core.windows.net"],
	irena: ["irena.org"],
	eia: ["eia.gov"],
	eurostat: ["ec.europa.eu", "europa.eu", "eurostat.ec.europa.eu"],
	oecd: ["oecd.org", "data.oecd.org", "stats.oecd.org"],
	worldbank: ["worldbank.org", "data.worldbank.org"],
	imf: ["imf.org"],
	who: ["who.int"],
	nice: ["nice.org.uk"],
	nih: ["nih.gov", "ncbi.nlm.nih.gov", "pubmed.ncbi.nlm.nih.gov"],
	cdc: ["cdc.gov"],
	ema: ["ema.europa.eu"],
	cso: ["cso.ie"],
	cbs: ["cbs.nl"],
	ksh: ["ksh.hu"],
};

/**
 * Aggregators, syndicators and mirrors. Two of these carrying the same wire
 * story are ONE organisation, not two, so they cannot corroborate each other.
 */
const SYNDICATION_HOSTS: readonly string[] = [
	"msn.com",
	"yahoo.com",
	"news.yahoo.com",
	"finance.yahoo.com",
	"uk.finance.yahoo.com",
	"news.google.com",
	"flipboard.com",
	"biztoc.com",
	"newsbreak.com",
	"smartnews.com",
	"apple.news",
	"investing.com",
	"tradingview.com",
	"marketscreener.com",
	"stocktitan.net",
	"webcache.googleusercontent.com",
	"prnewswire.com",
	"businesswire.com",
	"globenewswire.com",
	"einpresswire.com",
	"openpr.com",
];

/**
 * Hostname prefixes that address the SAME publication through a different
 * edge, mirror or environment. Stripped before the registrable domain is
 * taken, so `cdn.example.com` and `staging.example.com` are one organisation.
 */
export const MIRROR_HOST_PREFIXES: readonly string[] = [
	"www",
	"www1",
	"www2",
	"www3",
	"amp",
	"cdn",
	"cdn1",
	"cdn2",
	"static",
	"assets",
	"media",
	"m",
	"mobile",
	"staging",
	"stage",
	"dev",
	"test",
	"preview",
	"beta",
	"edge",
	"origin",
	"cache",
];

/** Multi-label public suffixes we must not mistake for a registrable domain. */
const MULTI_LABEL_SUFFIXES: readonly string[] = [
	"co.uk",
	"org.uk",
	"gov.uk",
	"ac.uk",
	"co.jp",
	"com.au",
	"co.nz",
	"com.br",
	"co.in",
	"co.za",
	"com.tr",
	"gov.ie",
	"co.ie",
	"com.hk",
	"com.sg",
];

export function stripMirrorPrefixes(host: string): string {
	let labels = host.toLowerCase().split(".").filter(Boolean);
	while (labels.length > 2 && MIRROR_HOST_PREFIXES.includes(labels[0])) {
		labels = labels.slice(1);
	}
	// `www.example.com` -> `example.com` even at exactly two remaining labels.
	if (labels.length > 1 && MIRROR_HOST_PREFIXES.includes(labels[0])) {
		labels = labels.slice(1);
	}
	return labels.join(".");
}

export function registrableDomain(host: string): string {
	const labels = stripMirrorPrefixes(host).split(".").filter(Boolean);
	if (labels.length <= 2) return labels.join(".");
	const lastTwo = labels.slice(-2).join(".");
	if (MULTI_LABEL_SUFFIXES.includes(lastTwo)) {
		return labels.slice(-3).join(".");
	}
	return lastTwo;
}

const HOST_TO_ORGANISATION = new Map<string, string>();
for (const [organisation, hosts] of Object.entries(PUBLISHER_HOST_GROUPS)) {
	for (const host of hosts) {
		HOST_TO_ORGANISATION.set(host, organisation);
	}
}

/**
 * The organisation id used for corroboration independence. Two sources
 * corroborate each other only when these differ.
 */
export function organisationForHost(host: string): string {
	const normalized = host.toLowerCase().replace(/\.$/, "");
	const direct = HOST_TO_ORGANISATION.get(normalized);
	if (direct) return direct;
	const stripped = stripMirrorPrefixes(normalized);
	const strippedMatch = HOST_TO_ORGANISATION.get(stripped);
	if (strippedMatch) return strippedMatch;
	if (
		SYNDICATION_HOSTS.includes(normalized) ||
		SYNDICATION_HOSTS.includes(stripped)
	) {
		return "aggregator:syndicated";
	}
	const domain = registrableDomain(normalized);
	const domainMatch = HOST_TO_ORGANISATION.get(domain);
	if (domainMatch) return domainMatch;
	if (SYNDICATION_HOSTS.includes(domain)) return "aggregator:syndicated";
	return domain || normalized;
}

/** True when the two hosts belong to different organisations. */
export function areIndependentHosts(left: string, right: string): boolean {
	return organisationForHost(left) !== organisationForHost(right);
}

/** True when the host only ever republishes someone else's reporting. */
export function isSyndicationHost(host: string): boolean {
	return organisationForHost(host) === "aggregator:syndicated";
}
