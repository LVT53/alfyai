// Evidence source filters for Atlas v3 (ADR 0062, ADR 0063).
//
// Copied out of v2's evidence-index module, which still owns them for v2.
// Every rule here exists because a real staging report shipped the defect it
// removes:
//
//   * a "301 Moved Permanently" entry in the source list  -> redirect stubs
//   * a LinkedIn company page                             -> social profiles
//   * the same article three times via CDN/staging hosts   -> article identity
//
// v3's evidence bank (`evidence-bank.ts`) is the only caller, and it decides
// what a dropped source means for the bank; this module only classifies text
// and hosts.

import { stripMirrorPrefixes } from "./publishers";

const SOCIAL_PROFILE_HOSTS: readonly string[] = [
	"linkedin.com",
	"facebook.com",
	"x.com",
	"twitter.com",
	"instagram.com",
	"threads.net",
	"tiktok.com",
	"pinterest.com",
	"vk.com",
	"weibo.com",
];

/**
 * Titles and snippets a fetch produces when it landed on a redirect, an error
 * page or a bot wall rather than on an article.
 */
const REDIRECT_TITLE_PATTERNS: readonly RegExp[] = [
	/\b30[1278]\b/,
	/moved\s+(permanently|temporarily)/i,
	/^\s*redirect(ing)?\b/i,
	/temporary\s+redirect/i,
	/document\s+has\s+moved/i,
];

const STATUS_STUB_PATTERNS: readonly RegExp[] = [
	/\b(400|401|402|403|404|405|408|410|429|500|502|503|504)\b\s*[-—:]?\s*(bad\s+request|unauthori[sz]ed|payment\s+required|forbidden|not\s+found|method\s+not\s+allowed|request\s+timeout|gone|too\s+many\s+requests|internal\s+server\s+error|bad\s+gateway|service\s+unavailable|gateway\s+time-?out)/i,
	/^\s*(page\s+)?not\s+found\s*$/i,
	/^\s*forbidden\s*$/i,
	/^\s*access\s+denied\s*$/i,
	/^\s*error\s*\d{3}\s*$/i,
	/just\s+a\s+moment/i,
	/are\s+you\s+a\s+(robot|human)/i,
	/attention\s+required.*cloudflare/i,
	/enable\s+javascript\s+(and\s+cookies\s+)?to\s+continue/i,
	/checking\s+if\s+the\s+site\s+connection\s+is\s+secure/i,
];

/**
 * Fragments that make up navigation chrome. A snippet built only out of these
 * carries no evidence, however long it is.
 */
const BOILERPLATE_FRAGMENTS: readonly RegExp[] = [
	/skip\s+to\s+(main\s+)?content/gi,
	/cookie\s+(policy|settings|preferences|notice)/gi,
	/accept\s+(all\s+)?cookies/gi,
	/privacy\s+(policy|notice)/gi,
	/terms\s+(of\s+use|and\s+conditions|of\s+service)/gi,
	/all\s+rights\s+reserved/gi,
	/sign\s+(in|up)\b/gi,
	/log\s+in\b/gi,
	/subscribe\s+(now|today)?/gi,
	/newsletter\s+signup/gi,
	/share\s+on\s+(facebook|twitter|linkedin|x)/gi,
	/follow\s+us\s+on\b/gi,
	/back\s+to\s+top/gi,
	/main\s+menu/gi,
	/(^|\s)(home|about|about\s+us|contact|contact\s+us|careers|news|blog|products|services|support|search|menu|login|register|sitemap)(\s*[|·•>/–-]\s*|$)/gi,
	/©\s*\d{4}/g,
	/\badvertisement\b/gi,
];

/** A snippet must retain this much real prose after chrome is removed. */
const MIN_EVIDENCE_CHARS = 40;

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function stripBoilerplate(value: string): string {
	let text = ` ${normalizeWhitespace(value)} `;
	for (const pattern of BOILERPLATE_FRAGMENTS) {
		text = text.replace(pattern, " ");
	}
	return normalizeWhitespace(text.replace(/[|·•]+/g, " "));
}

/** True when nothing but navigation chrome survives. */
export function isBoilerplateOnly(value: string): boolean {
	const stripped = stripBoilerplate(value);
	if (stripped.length >= MIN_EVIDENCE_CHARS) return false;
	// A short snippet still counts as evidence when it carries a figure.
	return !/\d/.test(stripped);
}

export function isRedirectStubText(value: string): boolean {
	const text = normalizeWhitespace(value);
	if (!text) return false;
	return REDIRECT_TITLE_PATTERNS.some((pattern) => pattern.test(text));
}

export function isStatusStubText(value: string): boolean {
	const text = normalizeWhitespace(value);
	if (!text) return false;
	return STATUS_STUB_PATTERNS.some((pattern) => pattern.test(text));
}

export function isSocialProfileHost(host: string): boolean {
	const stripped = stripMirrorPrefixes(host.toLowerCase());
	return SOCIAL_PROFILE_HOSTS.some(
		(social) => stripped === social || stripped.endsWith(`.${social}`),
	);
}

const TITLE_STOPWORDS = new Set([
	"the",
	"a",
	"an",
	"of",
	"and",
	"or",
	"in",
	"on",
	"for",
	"to",
	"with",
	"is",
	"are",
	"at",
	"by",
	"from",
	"as",
	"az",
	"egy",
	"és",
	"de",
	"het",
	"een",
	"van",
]);

/** Significant, order-preserving title tokens used for article identity. */
export function titleIdentityTokens(title: string): string[] {
	return normalizeWhitespace(title)
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.split(/\s+/)
		.filter((token) => token.length > 2 && !TITLE_STOPWORDS.has(token))
		.slice(0, 8);
}

/**
 * The last meaningful path segment, with extensions, ids and pagination
 * removed. `/2026/03/eu-solar-record-8gw.amp.html` -> `eu-solar-record-8gw`.
 */
export function pathIdentitySlug(canonicalUrl: string): string {
	let pathname: string;
	try {
		pathname = new URL(canonicalUrl).pathname;
	} catch {
		return "";
	}
	const segments = pathname
		.split("/")
		.map((segment) => decodeURIComponent(segment))
		.filter(Boolean)
		.filter((segment) => !/^(amp|index|default|home|page|p)$/i.test(segment))
		.filter((segment) => !/^\d{1,4}$/.test(segment));
	let last = (segments[segments.length - 1] ?? "").toLowerCase();
	// `.amp.html` needs both suffixes gone, so strip until nothing matches.
	for (;;) {
		const stripped = last.replace(/\.(html?|php|aspx?|jsp|amp|md)$/i, "");
		if (stripped === last) break;
		last = stripped;
	}
	return last.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Identity of the ARTICLE rather than of the URL: the same story served from
 * `cdn.`, `staging.` or `amp.` hosts collapses onto one key. Returns null when
 * there is not enough signal to claim two hits are the same article.
 */
export function articleIdentityKey(input: {
	canonicalUrl: string;
	host: string;
	title: string;
}): string | null {
	const slug = pathIdentitySlug(input.canonicalUrl);
	const tokens = titleIdentityTokens(input.title);
	const domain = stripMirrorPrefixes(input.host);
	if (slug.length >= 8) return `${domain}::slug:${slug}`;
	if (tokens.length >= 3) return `${domain}::title:${tokens.join("-")}`;
	return null;
}
