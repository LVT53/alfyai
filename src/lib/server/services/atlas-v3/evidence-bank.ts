// Atlas v3 stage 2: the evidence bank (ADR 0063).
//
// The bank is the only thing that crosses from research into reasoning. Page
// text NEVER enters a later prompt: a read produces verbatim quotes with ids
// and structured claims, and the page itself is discarded. That is what stops
// a marketplace nav menu becoming "the marketplace lists 14 items", and it is
// also what makes the prompts small enough to stay cheap on a model with no
// prefix cache.
//
// Citations are ids here and numbers only at render (`assignCitationNumbers`).
// The writer emits `e12`; it never sees, and therefore cannot invent, a `[7]`
// or a URL.

import type { SupportedLanguage } from "$lib/server/services/language";
import { canonicalizeGroundedWebUrl } from "$lib/server/services/web-grounding";
import { parseJsonFromText } from "../atlas/json-extract";
import {
	articleIdentityKey,
	isBoilerplateOnly,
	isRedirectStubText,
	isSocialProfileHost,
	isStatusStubText,
} from "../atlas-v2/evidence-index";
import { organisationForHost } from "../atlas-v2/publishers";
import type { AtlasV3NativeSourceSet } from "./language-standard";
import { atlasV3SourceTier, tierCanCorroborate } from "./source-tier";
import type {
	AtlasV3Claim,
	AtlasV3ClaimStatus,
	AtlasV3EvidenceBank,
	AtlasV3Quote,
	AtlasV3Source,
	AtlasV3SourceTier,
} from "./types";

/** A quote is evidence, not an article. Anything longer is a page dump. */
export const ATLAS_V3_MAX_QUOTE_CHARS = 400;
export const ATLAS_V3_MIN_QUOTE_CHARS = 20;
/** Quotes one page read may contribute. */
export const ATLAS_V3_MAX_QUOTES_PER_READ = 8;
export const ATLAS_V3_MAX_CLAIMS_PER_READ = 8;

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export interface AtlasV3BankState extends AtlasV3EvidenceBank {
	/** Next numeric suffix per id prefix. Not part of the durable shape. */
	counters: { source: number; quote: number; claim: number };
	/** Canonical URL -> source id. */
	sourceIdByUrl: Record<string, string>;
	/** Article identity key -> source id, for CDN/staging duplicates. */
	sourceIdByArticle: Record<string, string>;
}

export function createAtlasV3Bank(): AtlasV3BankState {
	return {
		sources: [],
		quotes: [],
		claims: [],
		filteredCount: 0,
		counters: { source: 0, quote: 0, claim: 0 },
		sourceIdByUrl: {},
		sourceIdByArticle: {},
	};
}

/** Drops the working indexes, leaving the durable shape for a checkpoint. */
export function freezeAtlasV3Bank(
	state: AtlasV3BankState,
): AtlasV3EvidenceBank {
	return {
		sources: state.sources,
		quotes: state.quotes,
		claims: state.claims,
		filteredCount: state.filteredCount,
	};
}

/** Rebuilds the working indexes from a checkpointed bank. */
export function thawAtlasV3Bank(bank: AtlasV3EvidenceBank): AtlasV3BankState {
	const state = createAtlasV3Bank();
	state.sources = [...bank.sources];
	state.quotes = [...bank.quotes];
	state.claims = [...bank.claims];
	state.filteredCount = bank.filteredCount;
	state.counters = {
		source: maxSuffix(bank.sources.map((source) => source.id)),
		quote: maxSuffix(bank.quotes.map((quote) => quote.id)),
		claim: maxSuffix(bank.claims.map((claim) => claim.id)),
	};
	for (const source of bank.sources) {
		state.sourceIdByUrl[source.canonicalUrl] = source.id;
		const articleKey = articleIdentityKey({
			title: source.title,
			canonicalUrl: source.canonicalUrl,
			host: source.host,
		});
		if (articleKey) state.sourceIdByArticle[articleKey] = source.id;
	}
	return state;
}

function maxSuffix(ids: readonly string[]): number {
	let largest = 0;
	for (const id of ids) {
		const parsed = Number.parseInt(id.slice(1), 10);
		if (Number.isFinite(parsed)) largest = Math.max(largest, parsed);
	}
	return largest;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export interface AddAtlasV3SourceInput {
	url: string;
	title: string;
	publishedAt: string | null;
	read?: boolean;
	nativeSources?: readonly AtlasV3NativeSourceSet[];
	manufacturerHosts?: readonly string[];
}

/**
 * Adds a source, or returns the existing one. Deduped twice: by canonical URL
 * and by article identity, so the same article reached through a CDN, a staging
 * host and an AMP mirror is ONE source with one citation number.
 *
 * Returns null when the hit is not evidence at all — an unparsable URL, a
 * redirect or HTTP-status stub, or a social profile. Those are counted in
 * `filteredCount` and never reach a prompt.
 */
export function addAtlasV3Source(
	state: AtlasV3BankState,
	input: AddAtlasV3SourceInput,
): AtlasV3Source | null {
	const canonical = canonicalizeGroundedWebUrl(input.url);
	if (!canonical) {
		state.filteredCount += 1;
		return null;
	}
	const { canonicalUrl, host } = canonical;
	const title = input.title.replace(/\s+/g, " ").trim();
	if (
		isSocialProfileHost(host) ||
		isRedirectStubText(title) ||
		isStatusStubText(title)
	) {
		state.filteredCount += 1;
		return null;
	}

	const existingByUrl = state.sourceIdByUrl[canonicalUrl];
	if (existingByUrl) {
		return markRead(state, existingByUrl, input.read === true);
	}
	const articleKey = articleIdentityKey({ title, canonicalUrl, host });
	const existingByArticle = articleKey
		? state.sourceIdByArticle[articleKey]
		: undefined;
	if (existingByArticle) {
		state.filteredCount += 1;
		state.sourceIdByUrl[canonicalUrl] = existingByArticle;
		return markRead(state, existingByArticle, input.read === true);
	}

	state.counters.source += 1;
	const source: AtlasV3Source = {
		id: `s${state.counters.source}`,
		canonicalUrl,
		host,
		publisher: organisationForHost(host),
		title: title || host,
		date: normalizeDate(input.publishedAt),
		tier: atlasV3SourceTier({
			host,
			canonicalUrl,
			title,
			nativeSources: input.nativeSources,
			manufacturerHosts: input.manufacturerHosts,
		}),
		read: input.read === true,
	};
	state.sources.push(source);
	state.sourceIdByUrl[canonicalUrl] = source.id;
	if (articleKey) state.sourceIdByArticle[articleKey] = source.id;
	return source;
}

function markRead(
	state: AtlasV3BankState,
	sourceId: string,
	read: boolean,
): AtlasV3Source | null {
	const source = state.sources.find((entry) => entry.id === sourceId);
	if (!source) return null;
	if (read) source.read = true;
	return source;
}

function normalizeDate(value: string | null): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	const iso = /^\d{4}-\d{2}-\d{2}/.exec(trimmed);
	if (iso) return iso[0];
	const year = /^\d{4}$/.exec(trimmed);
	return year ? `${year[0]}-01-01` : null;
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

/**
 * Adds a verbatim quote. Rejects boilerplate-only spans and spans too short to
 * support anything, and dedupes identical text from the same source, so a
 * researcher that quotes the same sentence twice does not mint two ids.
 */
export function addAtlasV3Quote(
	state: AtlasV3BankState,
	input: { sourceId: string; text: string; goal: string },
): AtlasV3Quote | null {
	const text = input.text.replace(/\s+/g, " ").trim();
	if (text.length < ATLAS_V3_MIN_QUOTE_CHARS) return null;
	if (isBoilerplateOnly(text)) return null;
	if (!state.sources.some((source) => source.id === input.sourceId))
		return null;
	const capped = text.slice(0, ATLAS_V3_MAX_QUOTE_CHARS);
	const existing = state.quotes.find(
		(quote) =>
			quote.sourceId === input.sourceId &&
			quote.text.toLowerCase() === capped.toLowerCase(),
	);
	if (existing) return existing;
	state.counters.quote += 1;
	const quote: AtlasV3Quote = {
		id: `e${state.counters.quote}`,
		sourceId: input.sourceId,
		text: capped,
		goal: input.goal.replace(/\s+/g, " ").trim().slice(0, 200),
	};
	state.quotes.push(quote);
	return quote;
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/** Identity of a measurement: same entity, metric, period and series. */
export function atlasV3ClaimKey(
	claim: Pick<AtlasV3Claim, "entity" | "metric" | "period" | "series">,
): string {
	return [claim.entity, claim.metric, claim.period ?? "", claim.series ?? ""]
		.map((part) => part.toLowerCase().replace(/\s+/g, " ").trim())
		.join("|");
}

/**
 * Adds a claim, merging it into an existing claim with the same identity.
 *
 * Merging is where series awareness lives. Two measurements of the same entity
 * and metric are the SAME claim only when their period and series agree; a
 * grid-connected additions figure and an installed-capacity figure for the same
 * year are two claims, not a disagreement — which is exactly the distinction
 * v2's "sources disagree on 380 GW" line failed to make.
 */
export function addAtlasV3Claim(
	state: AtlasV3BankState,
	input: Omit<AtlasV3Claim, "id" | "status">,
): AtlasV3Claim | null {
	const entity = clean(input.entity, 120);
	const metric = clean(input.metric, 120);
	const value = clean(input.value, 80);
	if (!entity || !metric || !value) return null;
	const evidenceIds = input.evidenceIds.filter((id) =>
		state.quotes.some((quote) => quote.id === id),
	);
	if (evidenceIds.length === 0) return null;

	const candidate = {
		entity,
		metric,
		value,
		unit: clean(input.unit ?? "", 40) || null,
		period: clean(input.period ?? "", 60) || null,
		asOf: clean(input.asOf ?? "", 40) || null,
		series: clean(input.series ?? "", 120) || null,
		evidenceIds,
	};
	const key = atlasV3ClaimKey(candidate);
	const existing = state.claims.find(
		(claim) => atlasV3ClaimKey(claim) === key && sameValue(claim.value, value),
	);
	if (existing) {
		for (const id of evidenceIds) {
			if (!existing.evidenceIds.includes(id)) existing.evidenceIds.push(id);
		}
		existing.asOf ??= candidate.asOf;
		existing.unit ??= candidate.unit;
		existing.status = atlasV3ClaimStatus(state, existing);
		return existing;
	}
	state.counters.claim += 1;
	const claim: AtlasV3Claim = {
		id: `c${state.counters.claim}`,
		...candidate,
		status: "open",
	};
	claim.status = atlasV3ClaimStatus(state, claim);
	state.claims.push(claim);
	// A claim with the same identity but a DIFFERENT value is a genuine
	// disagreement; both sides are marked contested so the writer must
	// adjudicate rather than pick one silently.
	const conflicting = state.claims.filter(
		(entry) =>
			entry.id !== claim.id &&
			atlasV3ClaimKey(entry) === key &&
			!sameValue(entry.value, claim.value),
	);
	if (conflicting.length > 0) {
		claim.status = "contested";
		for (const entry of conflicting) entry.status = "contested";
	}
	return claim;
}

function clean(value: string, maxChars: number): string {
	return value.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

/** Values match when their digits and letters match, ignoring formatting. */
function sameValue(left: string, right: string): boolean {
	const normalize = (value: string) =>
		value
			.toLowerCase()
			.replace(/[\s  ]/gu, "")
			.replace(/,(?=\d{3}\b)/gu, "")
			.replace(/,(\d)/gu, ".$1");
	return normalize(left) === normalize(right);
}

/**
 * A claim's status from the publishers behind its quotes. `verified` needs two
 * INDEPENDENT publishers, both of a tier that can corroborate: two aggregators
 * carrying one wire story are one publisher, and a forum is not one at all.
 */
export function atlasV3ClaimStatus(
	state: AtlasV3EvidenceBank,
	claim: Pick<AtlasV3Claim, "evidenceIds" | "status">,
): AtlasV3ClaimStatus {
	if (claim.status === "contested") return "contested";
	const publishers = new Set<string>();
	for (const evidenceId of claim.evidenceIds) {
		const quote = state.quotes.find((entry) => entry.id === evidenceId);
		if (!quote) continue;
		const source = state.sources.find((entry) => entry.id === quote.sourceId);
		if (!source || !tierCanCorroborate(source.tier)) continue;
		publishers.add(source.publisher);
	}
	if (publishers.size >= 2) return "verified";
	if (publishers.size === 1) return "single";
	return "open";
}

/** Recomputes every claim's status. Cheap, and run after every merge round. */
export function rescoreAtlasV3Claims(state: AtlasV3BankState): void {
	for (const claim of state.claims) {
		claim.status = atlasV3ClaimStatus(state, claim);
	}
}

// ---------------------------------------------------------------------------
// Lookups the later stages use
// ---------------------------------------------------------------------------

export function atlasV3QuoteById(
	bank: AtlasV3EvidenceBank,
	id: string,
): AtlasV3Quote | null {
	return bank.quotes.find((quote) => quote.id === id) ?? null;
}

export function atlasV3SourceForQuote(
	bank: AtlasV3EvidenceBank,
	id: string,
): AtlasV3Source | null {
	const quote = atlasV3QuoteById(bank, id);
	if (!quote) return null;
	return bank.sources.find((source) => source.id === quote.sourceId) ?? null;
}

/** Distinct publishers behind a set of quote ids. The independence count. */
export function atlasV3PublishersFor(
	bank: AtlasV3EvidenceBank,
	evidenceIds: readonly string[],
): string[] {
	const publishers = new Set<string>();
	for (const id of evidenceIds) {
		const source = atlasV3SourceForQuote(bank, id);
		if (source && tierCanCorroborate(source.tier))
			publishers.add(source.publisher);
	}
	return [...publishers];
}

/** Every quote's text for one source, joined. The verifier's haystack. */
export function atlasV3SourceEvidenceText(
	bank: AtlasV3EvidenceBank,
	sourceId: string,
): string {
	return bank.quotes
		.filter((quote) => quote.sourceId === sourceId)
		.map((quote) => quote.text)
		.join("\n");
}

/** `title — host, date`, the Sources-section line format ADR 0062 defined. */
export function formatAtlasV3SourceLine(source: AtlasV3Source): string {
	return source.date
		? `${source.title} — ${source.host}, ${source.date}`
		: `${source.title} — ${source.host}`;
}

// ---------------------------------------------------------------------------
// Mechanical citation numbering
// ---------------------------------------------------------------------------

export interface AtlasV3Citations {
	/** Source id -> published `[n]`. Only cited sources get one. */
	numberBySourceId: Map<string, number>;
	/** Quote id -> published `[n]` of its source. */
	numberByEvidenceId: Map<string, number>;
	/** Published sources in numbering order. */
	sources: AtlasV3Source[];
}

/**
 * Mints `[n]` from the bank, in the order the report first cites each source.
 *
 * This is the whole point of evidence ids: numbering is a RENDER concern, so a
 * writer cannot mis-number a citation, cannot cite a source that was dropped,
 * and cannot type a URL. Two quotes from one source share one number, which is
 * also what stops the `[2][2]` duplicates v2 shipped.
 */
export function assignAtlasV3CitationNumbers(input: {
	bank: AtlasV3EvidenceBank;
	/** Evidence ids in the order the finished report cites them. */
	citedEvidenceIds: readonly string[];
	/** Sources named only by a Limitations line; published, not cited. */
	extraSourceIds?: readonly string[];
}): AtlasV3Citations {
	const numberBySourceId = new Map<string, number>();
	const numberByEvidenceId = new Map<string, number>();
	const sources: AtlasV3Source[] = [];
	const take = (sourceId: string): number | null => {
		const existing = numberBySourceId.get(sourceId);
		if (existing !== undefined) return existing;
		const source = input.bank.sources.find((entry) => entry.id === sourceId);
		if (!source) return null;
		const number = sources.length + 1;
		numberBySourceId.set(sourceId, number);
		sources.push({ ...source });
		return number;
	};
	for (const evidenceId of input.citedEvidenceIds) {
		const quote = atlasV3QuoteById(input.bank, evidenceId);
		if (!quote) continue;
		const number = take(quote.sourceId);
		if (number !== null) numberByEvidenceId.set(evidenceId, number);
	}
	for (const sourceId of input.extraSourceIds ?? []) take(sourceId);
	return { numberBySourceId, numberByEvidenceId, sources };
}

// ---------------------------------------------------------------------------
// "Read for a goal": the one model call that turns a page into evidence
// ---------------------------------------------------------------------------

export const ATLAS_V3_READ_SYSTEM: Record<SupportedLanguage, string> = {
	en: [
		"You read ONE web page for ONE stated goal and return only what the page states. Return STRICT JSON only, no prose and no code fence.",
		'Shape: {"quotes":[{"text":"..."}],"claims":[{"entity":"...","metric":"...","value":"...","unit":"...","period":"...","asOf":"...","series":"...","quoteIndexes":[0]}],"useless":false}',
		"`quotes` are VERBATIM spans copied from the page, at most 400 characters each, at most 8. Never paraphrase, never join two distant sentences, never invent. Copy the sentence that carries the figure, with enough words around it to be readable.",
		"`claims` are the measurements the page states, one per row. `value` is the number or short answer exactly as the page gives it. `unit` is its unit or null. `period` is the time the value covers (a year, a quarter, a date). `asOf` is when the page says the value was published or revised, or null. `series` is the measurement's identity — 'grid-connected additions', 'installed capacity', 'list price', 'statutory rate' — or null if the page does not say.",
		"`quoteIndexes` are 0-based positions in your own `quotes` array that state the value. A claim with no quote is not a claim; drop it.",
		'Set "useless" to true and return empty arrays when the page is a navigation menu, a product listing, a search-results page, a cookie notice or a login wall. A list of links is NOT data.',
		"Do not answer the goal yourself. Extract only.",
	].join("\n"),
	hu: [
		"EGY weboldalt olvasol EGY megadott célra, és csak azt adod vissza, amit az oldal állít. KIZÁRÓLAG szigorú JSON-t adj vissza, próza és kódkerítés nélkül.",
		'Alak: {"quotes":[{"text":"..."}],"claims":[{"entity":"...","metric":"...","value":"...","unit":"...","period":"...","asOf":"...","series":"...","quoteIndexes":[0]}],"useless":false}',
		"A `quotes` SZÓ SZERINTI részletek az oldalról, egyenként legfeljebb 400 karakter, legfeljebb 8 darab. Ne fogalmazd át, ne fűzz össze távoli mondatokat, ne találj ki semmit.",
		"A `claims` az oldal által közölt mérések, soronként egy. A `value` a szám vagy rövid válasz pontosan úgy, ahogy az oldal írja. A `unit` a mértékegység vagy null. A `period` az az időszak, amelyre az érték vonatkozik. Az `asOf` a közlés vagy felülvizsgálat ideje, vagy null. A `series` a mérés azonosítója — „hálózatra kapcsolt bővülés”, „beépített kapacitás”, „listaár”, „törvényi mérték” — vagy null.",
		"A `quoteIndexes` a saját `quotes` tömböd 0-alapú pozíciói, amelyek az értéket kimondják. Idézet nélküli állítást hagyj el.",
		'A "useless" akkor true (és mindkét tömb üres), ha az oldal navigációs menü, terméklista, találati oldal, süti-értesítés vagy bejelentkező fal. A linkek listája NEM adat.',
		"Ne válaszold meg te a célt. Csak kivonatolj.",
	].join("\n"),
};

export interface BuildAtlasV3ReadPromptInput {
	/** The sub-question this page is being read FOR. */
	goal: string;
	language: SupportedLanguage;
	sourceTitle: string;
	sourceHost: string;
	sourceDate: string | null;
	tier: AtlasV3SourceTier;
	pageText: string;
	/** Characters of page text the call may see. */
	maxPageChars: number;
	currentDate: string;
}

export function buildAtlasV3ReadPrompt(
	input: BuildAtlasV3ReadPromptInput,
): string {
	return JSON.stringify({
		task: "read_for_goal",
		goal: input.goal,
		language: input.language,
		currentDate: input.currentDate,
		source: {
			title: input.sourceTitle,
			host: input.sourceHost,
			date: input.sourceDate,
			tier: input.tier,
		},
		page: input.pageText
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, input.maxPageChars),
	});
}

export interface AtlasV3ReadResult {
	quotes: string[];
	claims: Array<{
		entity: string;
		metric: string;
		value: string;
		unit: string | null;
		period: string | null;
		asOf: string | null;
		series: string | null;
		quoteIndexes: number[];
	}>;
	useless: boolean;
}

/**
 * Parses a read. A claim whose `quoteIndexes` point nowhere is dropped rather
 * than kept with empty evidence: an unsupported structured claim is worse than
 * no claim, because the answer table would then carry a cell with no citation.
 */
export function parseAtlasV3Read(text: string): AtlasV3ReadResult | null {
	const parsed = parseJsonFromText(text);
	if (!parsed || typeof parsed !== "object") return null;
	const record = parsed as Record<string, unknown>;
	const quotes: string[] = [];
	if (Array.isArray(record.quotes)) {
		for (const entry of record.quotes) {
			const quoteText =
				typeof entry === "string"
					? entry
					: entry && typeof entry === "object"
						? String((entry as { text?: unknown }).text ?? "")
						: "";
			const cleaned = quoteText.replace(/\s+/g, " ").trim();
			if (cleaned.length < ATLAS_V3_MIN_QUOTE_CHARS) continue;
			quotes.push(cleaned.slice(0, ATLAS_V3_MAX_QUOTE_CHARS));
			if (quotes.length >= ATLAS_V3_MAX_QUOTES_PER_READ) break;
		}
	}
	const claims: AtlasV3ReadResult["claims"] = [];
	if (Array.isArray(record.claims)) {
		for (const entry of record.claims) {
			if (!entry || typeof entry !== "object") continue;
			const claim = entry as Record<string, unknown>;
			const indexes = Array.isArray(claim.quoteIndexes)
				? claim.quoteIndexes
						.map((value) =>
							typeof value === "number" ? Math.trunc(value) : -1,
						)
						.filter((value) => value >= 0 && value < quotes.length)
				: [];
			if (indexes.length === 0) continue;
			const entity = optionalString(claim.entity, 120);
			const metric = optionalString(claim.metric, 120);
			const value = optionalString(claim.value, 80);
			if (!entity || !metric || !value) continue;
			claims.push({
				entity,
				metric,
				value,
				unit: optionalString(claim.unit, 40) || null,
				period: optionalString(claim.period, 60) || null,
				asOf: optionalString(claim.asOf, 40) || null,
				series: optionalString(claim.series, 120) || null,
				quoteIndexes: indexes,
			});
			if (claims.length >= ATLAS_V3_MAX_CLAIMS_PER_READ) break;
		}
	}
	return {
		quotes,
		claims,
		useless:
			record.useless === true || (quotes.length === 0 && claims.length === 0),
	};
}

function optionalString(value: unknown, maxChars: number): string {
	if (typeof value === "number" && Number.isFinite(value)) {
		return String(value).slice(0, maxChars);
	}
	if (typeof value !== "string") return "";
	const cleaned = value.replace(/\s+/g, " ").trim();
	return cleaned.toLowerCase() === "null" ? "" : cleaned.slice(0, maxChars);
}

/**
 * Files a parsed read into the bank: quotes first (so claims can reference
 * their ids), then claims. Returns what was added, for the researcher's note.
 */
export function fileAtlasV3Read(input: {
	state: AtlasV3BankState;
	sourceId: string;
	goal: string;
	read: AtlasV3ReadResult;
}): { quotes: AtlasV3Quote[]; claims: AtlasV3Claim[] } {
	const quotes: Array<AtlasV3Quote | null> = input.read.quotes.map((text) =>
		addAtlasV3Quote(input.state, {
			sourceId: input.sourceId,
			text,
			goal: input.goal,
		}),
	);
	const added = quotes.filter((quote): quote is AtlasV3Quote => quote !== null);
	const claims: AtlasV3Claim[] = [];
	for (const claim of input.read.claims) {
		const evidenceIds = claim.quoteIndexes
			.map((index) => quotes[index]?.id)
			.filter((id): id is string => Boolean(id));
		if (evidenceIds.length === 0) continue;
		const filed = addAtlasV3Claim(input.state, { ...claim, evidenceIds });
		if (filed) claims.push(filed);
	}
	return { quotes: added, claims };
}

/**
 * Caps the bank to the profile's source budget, best tier first and keeping
 * every source a claim rests on. Applied BEFORE anything is written, so no
 * citation is ever minted against a source the report cannot afford to carry.
 */
export function capAtlasV3Bank(input: {
	state: AtlasV3BankState;
	maxSources: number;
}): { dropped: number } {
	if (input.state.sources.length <= input.maxSources) return { dropped: 0 };
	const load = new Map<string, number>();
	for (const claim of input.state.claims) {
		for (const evidenceId of claim.evidenceIds) {
			const quote = input.state.quotes.find((entry) => entry.id === evidenceId);
			if (!quote) continue;
			load.set(quote.sourceId, (load.get(quote.sourceId) ?? 0) + 1);
		}
	}
	const ranked = [...input.state.sources].sort((left, right) => {
		const claimDelta = (load.get(right.id) ?? 0) - (load.get(left.id) ?? 0);
		if (claimDelta !== 0) return claimDelta;
		const tierDelta =
			ATLAS_V3_TIER_ORDER[left.tier] - ATLAS_V3_TIER_ORDER[right.tier];
		if (tierDelta !== 0) return tierDelta;
		return left.id.localeCompare(right.id, "en", { numeric: true });
	});
	const kept = new Set(
		ranked.slice(0, input.maxSources).map((source) => source.id),
	);
	const dropped = input.state.sources.length - kept.size;
	input.state.sources = input.state.sources.filter((source) =>
		kept.has(source.id),
	);
	input.state.quotes = input.state.quotes.filter((quote) =>
		kept.has(quote.sourceId),
	);
	const liveQuoteIds = new Set(input.state.quotes.map((quote) => quote.id));
	input.state.claims = input.state.claims
		.map((claim) => ({
			...claim,
			evidenceIds: claim.evidenceIds.filter((id) => liveQuoteIds.has(id)),
		}))
		.filter((claim) => claim.evidenceIds.length > 0);
	rescoreAtlasV3Claims(input.state);
	input.state.filteredCount += dropped;
	return { dropped };
}

const ATLAS_V3_TIER_ORDER: Record<AtlasV3SourceTier, number> = {
	primary: 0,
	press: 1,
	aggregator: 2,
	weak: 3,
};
