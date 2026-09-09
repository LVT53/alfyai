// Atlas v2 stage 3: the deterministic evidence index (ADR 0062). No model
// call happens here. Every rule in this module exists because the 2026-09-08
// staging report shipped the defect it removes:
//
//   * a "301 Moved Permanently" entry in the source list  -> redirect stubs
//   * a LinkedIn company page                             -> social profiles
//   * the same article three times via CDN/staging hosts   -> article identity
//
// The output is the ONLY thing the writer sees, and its `n` numbers are the
// citation numbers that appear in the report, so this module owns source
// identity for the whole job.

import { canonicalizeGroundedWebUrl } from "$lib/server/services/web-grounding";
import { organisationForHost, stripMirrorPrefixes } from "./publishers";
import type {
	AtlasV2DroppedSource,
	AtlasV2EvidenceIndex,
	AtlasV2IndexedSource,
	AtlasV2RawSource,
} from "./types";

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
/** Longest snippet kept per source; the rest is dropped, not truncated apart. */
const MAX_SNIPPET_CHARS = 1200;
const MAX_SNIPPETS_PER_SOURCE = 6;
const MAX_PAGE_EXCERPT_CHARS = 12_000;

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
		.replace(/[\u0300-\u036f]/g, "")
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

/**
 * Which of two hits for the same article to keep: the one whose host is not a
 * mirror, then the one with more evidence, then the shorter host.
 */
function preferSource(
	incumbent: AtlasV2IndexedSource,
	challenger: AtlasV2IndexedSource,
): AtlasV2IndexedSource {
	const incumbentMirrored =
		incumbent.host !== stripMirrorPrefixes(incumbent.host);
	const challengerMirrored =
		challenger.host !== stripMirrorPrefixes(challenger.host);
	if (incumbentMirrored !== challengerMirrored) {
		return incumbentMirrored ? challenger : incumbent;
	}
	const incumbentEvidence = evidenceWeight(incumbent);
	const challengerEvidence = evidenceWeight(challenger);
	if (incumbentEvidence !== challengerEvidence) {
		return challengerEvidence > incumbentEvidence ? challenger : incumbent;
	}
	return challenger.host.length < incumbent.host.length
		? challenger
		: incumbent;
}

function evidenceWeight(source: AtlasV2IndexedSource): number {
	return (
		source.snippets.join(" ").length + (source.pageExcerpt?.length ?? 0) / 4
	);
}

function mergeInto(
	target: AtlasV2IndexedSource,
	other: AtlasV2IndexedSource,
): void {
	for (const snippet of other.snippets) {
		if (
			target.snippets.length < MAX_SNIPPETS_PER_SOURCE &&
			!target.snippets.includes(snippet)
		) {
			target.snippets.push(snippet);
		}
	}
	if (!target.pageExcerpt && other.pageExcerpt) {
		target.pageExcerpt = other.pageExcerpt;
	}
	target.date ??= other.date;
	for (const questionId of other.questionIds) {
		if (!target.questionIds.includes(questionId)) {
			target.questionIds.push(questionId);
		}
	}
}

function normalizeDate(value: string | null): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const isoMatch = trimmed.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
	if (isoMatch) {
		return isoMatch[3]
			? `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`
			: `${isoMatch[1]}-${isoMatch[2]}`;
	}
	const parsed = new Date(trimmed);
	if (Number.isNaN(parsed.getTime())) return null;
	return parsed.toISOString().slice(0, 10);
}

function cleanTitle(title: string, host: string): string {
	const normalized = normalizeWhitespace(title);
	if (!normalized) return host;
	// Drop the trailing " | Publisher" / " - Publisher" site name.
	const withoutSite = normalized.replace(
		/\s+[|–—]\s+[^|–—]{2,40}$/u,
		(match) => (normalized.length - match.length >= 20 ? "" : match),
	);
	return normalizeWhitespace(withoutSite) || normalized;
}

function usableSnippets(raw: AtlasV2RawSource): string[] {
	const seen = new Set<string>();
	const kept: string[] = [];
	for (const snippet of raw.snippets) {
		const normalized = normalizeWhitespace(snippet).slice(0, MAX_SNIPPET_CHARS);
		if (!normalized || seen.has(normalized)) continue;
		if (isRedirectStubText(normalized) || isStatusStubText(normalized)) {
			continue;
		}
		if (isBoilerplateOnly(normalized)) continue;
		seen.add(normalized);
		kept.push(normalized);
		if (kept.length >= MAX_SNIPPETS_PER_SOURCE) break;
	}
	return kept;
}

/**
 * Builds the numbered evidence index from every raw hit collected across all
 * research rounds. Numbering follows first-appearance order, which is search
 * relevance order for round 1, so `[1]` is the strongest hit for the first
 * question.
 */
export function buildAtlasV2EvidenceIndex(
	rawSources: AtlasV2RawSource[],
): AtlasV2EvidenceIndex {
	const dropped: AtlasV2DroppedSource[] = [];
	const byCanonicalUrl = new Map<string, AtlasV2IndexedSource>();
	const byArticleKey = new Map<string, string>();

	for (const raw of rawSources) {
		const canonical = canonicalizeGroundedWebUrl(raw.url);
		if (!canonical) {
			dropped.push({
				url: raw.url,
				host: null,
				title: normalizeWhitespace(raw.title),
				reason: "unparsable_url",
			});
			continue;
		}
		const { canonicalUrl, host } = canonical;
		const title = normalizeWhitespace(raw.title);

		if (isSocialProfileHost(host)) {
			dropped.push({
				url: canonicalUrl,
				host,
				title,
				reason: "social_profile",
			});
			continue;
		}
		if (isRedirectStubText(title)) {
			dropped.push({ url: canonicalUrl, host, title, reason: "redirect_stub" });
			continue;
		}
		if (isStatusStubText(title)) {
			dropped.push({ url: canonicalUrl, host, title, reason: "status_stub" });
			continue;
		}

		const snippets = usableSnippets(raw);
		const pageExcerpt = raw.pageExcerpt
			? normalizeWhitespace(raw.pageExcerpt).slice(0, MAX_PAGE_EXCERPT_CHARS)
			: null;
		if (snippets.length === 0 && !pageExcerpt) {
			// Every snippet was chrome, or there were none at all.
			const chromeOnly = raw.snippets.length > 0;
			dropped.push({
				url: canonicalUrl,
				host,
				title,
				reason: chromeOnly ? "boilerplate_only" : "empty",
			});
			continue;
		}
		if (pageExcerpt && isStatusStubText(pageExcerpt.slice(0, 200))) {
			dropped.push({ url: canonicalUrl, host, title, reason: "status_stub" });
			continue;
		}

		const candidate: AtlasV2IndexedSource = {
			n: 0,
			canonicalUrl,
			host,
			organisation: organisationForHost(host),
			title: cleanTitle(title, host),
			date: normalizeDate(raw.publishedAt),
			snippets,
			pageExcerpt,
			questionIds: [raw.questionId],
		};

		const existing = byCanonicalUrl.get(canonicalUrl);
		if (existing) {
			mergeInto(existing, candidate);
			dropped.push({
				url: canonicalUrl,
				host,
				title,
				reason: "duplicate_canonical",
			});
			continue;
		}

		const articleKey = articleIdentityKey({
			canonicalUrl,
			host,
			title: candidate.title,
		});
		const twinUrl = articleKey ? byArticleKey.get(articleKey) : undefined;
		if (twinUrl) {
			const twin = byCanonicalUrl.get(twinUrl);
			if (twin) {
				const winner = preferSource(twin, candidate);
				const loser = winner === twin ? candidate : twin;
				mergeInto(winner, loser);
				if (winner !== twin) {
					byCanonicalUrl.delete(twinUrl);
					byCanonicalUrl.set(winner.canonicalUrl, winner);
					if (articleKey) byArticleKey.set(articleKey, winner.canonicalUrl);
				}
				dropped.push({
					url: loser.canonicalUrl,
					host: loser.host,
					title: loser.title,
					reason: "duplicate_article",
				});
				continue;
			}
		}

		byCanonicalUrl.set(canonicalUrl, candidate);
		if (articleKey) byArticleKey.set(articleKey, canonicalUrl);
	}

	const sources = [...byCanonicalUrl.values()].map((source, index) => ({
		...source,
		n: index + 1,
	}));

	const byQuestion: Record<string, number[]> = {};
	for (const source of sources) {
		for (const questionId of source.questionIds) {
			const existingNumbers = byQuestion[questionId];
			if (existingNumbers) {
				existingNumbers.push(source.n);
			} else {
				byQuestion[questionId] = [source.n];
			}
		}
	}

	return {
		sources,
		dropped,
		filteredCount: dropped.length,
		byQuestion,
	};
}

/** All text a citation can be checked against: snippets plus the page read. */
export function sourceEvidenceText(source: AtlasV2IndexedSource): string {
	return [...source.snippets, source.pageExcerpt ?? ""]
		.filter(Boolean)
		.join("\n");
}

/** `title — host, date`, the Sources-section line format from ADR 0062. */
export function formatSourceLine(source: AtlasV2IndexedSource): string {
	return source.date
		? `${source.title} — ${source.host}, ${source.date}`
		: `${source.title} — ${source.host}`;
}

/** Merges an evidence index seeded from a parent job with a fresh one. */
export function mergeAtlasV2EvidenceIndexes(
	seed: AtlasV2EvidenceIndex | null,
	fresh: AtlasV2EvidenceIndex,
): AtlasV2EvidenceIndex {
	if (!seed || seed.sources.length === 0) return fresh;
	const raw: AtlasV2RawSource[] = [...seed.sources, ...fresh.sources].flatMap(
		(source) =>
			source.questionIds.map((questionId) => ({
				questionId,
				round: 0,
				url: source.canonicalUrl,
				title: source.title,
				snippets: source.snippets,
				publishedAt: source.date,
				pageExcerpt: source.pageExcerpt,
			})),
	);
	const merged = buildAtlasV2EvidenceIndex(raw);
	return {
		...merged,
		filteredCount: seed.filteredCount + fresh.filteredCount,
	};
}

/**
 * Caps the index at `maxSources`, then renumbers 1..k.
 *
 * The choice of which sources survive is round-robin over the research
 * questions in `questionOrder`, taking each question's lowest-numbered unused
 * source in turn. That keeps every question represented instead of spending the
 * whole budget on whichever question the search engine was most generous about,
 * and it is deterministic, so a resumed job caps identically.
 *
 * Renumbering is safe here because the cap runs before the write phase, so no
 * citation has been minted against the pre-cap numbering yet.
 */
export function capAtlasV2EvidenceIndex(input: {
	index: AtlasV2EvidenceIndex;
	maxSources: number;
	/** Question ids in plan order; questions missing from it come last. */
	questionOrder: readonly string[];
}): { index: AtlasV2EvidenceIndex; droppedForBudget: number } {
	const { index } = input;
	if (index.sources.length <= input.maxSources) {
		return { index, droppedForBudget: 0 };
	}
	const order = [
		...input.questionOrder,
		...Object.keys(index.byQuestion).filter(
			(questionId) => !input.questionOrder.includes(questionId),
		),
	];
	const cursors = new Map<string, number>(
		order.map((questionId) => [questionId, 0]),
	);
	const keep = new Set<number>();
	let progressed = true;
	while (keep.size < input.maxSources && progressed) {
		progressed = false;
		for (const questionId of order) {
			if (keep.size >= input.maxSources) break;
			const numbers = index.byQuestion[questionId] ?? [];
			let cursor = cursors.get(questionId) ?? 0;
			while (cursor < numbers.length && keep.has(numbers[cursor])) cursor += 1;
			cursors.set(questionId, cursor);
			if (cursor >= numbers.length) continue;
			keep.add(numbers[cursor]);
			cursors.set(questionId, cursor + 1);
			progressed = true;
		}
	}
	// A source attached to no question at all would otherwise be unreachable.
	if (keep.size < input.maxSources) {
		for (const source of index.sources) {
			if (keep.size >= input.maxSources) break;
			keep.add(source.n);
		}
	}

	const kept = index.sources.filter((source) => keep.has(source.n));
	const renumberMap = new Map(
		kept.map((source, position) => [source.n, position + 1]),
	);
	const sources = kept.map((source) => ({
		...source,
		n: renumberMap.get(source.n) ?? source.n,
	}));
	const byQuestion: Record<string, number[]> = {};
	for (const source of sources) {
		for (const questionId of source.questionIds) {
			const numbers = byQuestion[questionId];
			if (numbers) {
				numbers.push(source.n);
			} else {
				byQuestion[questionId] = [source.n];
			}
		}
	}
	return {
		index: { ...index, sources, byQuestion },
		droppedForBudget: index.sources.length - sources.length,
	};
}
