import { createHash } from "node:crypto";
import { logTeiRetrievalSummary } from "../tei-observability";
import { rerankItems } from "../tei-reranker";
import {
	ATLAS_WRITER_EVIDENCE_CARD_SCHEMA_VERSION,
	type AtlasEvidencePack,
	type AtlasEvidencePackSourceRef,
	type AtlasSectionBrief,
	type AtlasWriterEvidenceCard,
	type AtlasWriterEvidenceCardAuthority,
	type AtlasWriterEvidenceCardDiagnostic,
} from "./types";

export { ATLAS_WRITER_EVIDENCE_CARD_SCHEMA_VERSION };

const MAX_RELEVANT_FACTS = 3;
const MAX_FACT_LENGTH = 240;
const MAX_LIMITATIONS = 3;
const MAX_CONFLICTS = 3;
const MAX_NOTE_LENGTH = 200;
const MAX_SOURCE_TITLE_LENGTH = 120;
const MAX_SECTION_LENGTH = 80;
const MAX_SOURCE_REFS = 6;
const MAX_ROUTING_RERANK_CARDS = 24;
const MAX_SECTION_ROUTING_SECTIONS = 4;
const MAX_SECTION_ROUTING_CARDS = 8;
const MAX_RERANK_TEXT_LENGTH = 900;
const OFFICIAL_HOST_SUFFIXES = [
	".gov",
	".mil",
	".edu",
	"nist.gov",
	"europa.eu",
	"iso.org",
	"who.int",
	"oecd.org",
	"imf.org",
	"worldbank.org",
];
const VENDOR_HOST_SUFFIXES = [
	"anthropic.com",
	"aws.amazon.com",
	"azure.microsoft.com",
	"cloud.google.com",
	"docs.microsoft.com",
	"google.com",
	"meta.com",
	"microsoft.com",
	"nvidia.com",
	"openai.com",
];
const COMMUNITY_HOST_SUFFIXES = [
	"discourse.org",
	"github.com",
	"hackernews.com",
	"news.ycombinator.com",
	"reddit.com",
	"stackoverflow.com",
];
const AUTHORITY_RANK: Record<AtlasWriterEvidenceCardAuthority, number> = {
	user_provided: 0,
	library: 1,
	official: 2,
	benchmark: 3,
	vendor: 4,
	analysis: 5,
	community: 6,
	parent_seed: 7,
	unknown: 8,
};

export interface BuildAtlasWriterEvidenceCardsInput {
	evidencePacks: AtlasEvidencePack[];
	sectionHintsByEvidencePackId?: Record<string, string[]>;
	maxCards?: number;
}

export interface BuildAtlasWriterEvidenceCardsResult {
	version: typeof ATLAS_WRITER_EVIDENCE_CARD_SCHEMA_VERSION;
	writerEvidenceCards: AtlasWriterEvidenceCard[];
	diagnostics: AtlasWriterEvidenceCardDiagnostic[];
}

export interface RouteAtlasWriterEvidenceCardsInput {
	writerEvidenceCards: AtlasWriterEvidenceCard[];
	userQuery: string;
	sectionBriefs: AtlasSectionBrief[];
	maxCards?: number;
	reranker?: AtlasWriterEvidenceCardReranker;
}

export interface AtlasWriterEvidenceCardRerankParams {
	query: string;
	items: AtlasWriterEvidenceCard[];
	getText: (item: AtlasWriterEvidenceCard) => string;
	maxTexts?: number;
	truncate?: boolean;
}

export interface AtlasWriterEvidenceCardRerankResult {
	items: Array<{
		item: AtlasWriterEvidenceCard;
		index: number;
		score: number;
	}>;
}

export type AtlasWriterEvidenceCardReranker = (
	params: AtlasWriterEvidenceCardRerankParams,
) => Promise<AtlasWriterEvidenceCardRerankResult | null>;

export function buildAtlasWriterEvidenceCards(
	input: BuildAtlasWriterEvidenceCardsInput,
): BuildAtlasWriterEvidenceCardsResult {
	const diagnostics: AtlasWriterEvidenceCardDiagnostic[] = [];
	const cards = input.evidencePacks
		.map((pack) => buildWriterEvidenceCard(pack, input))
		.sort(compareWriterEvidenceCards);
	const maxCards = normalizeMaxCards(input.maxCards);
	const writerEvidenceCards =
		maxCards === null ? cards : cards.slice(0, maxCards);

	if (input.evidencePacks.length === 0) {
		diagnostics.push({
			code: "atlas_writer_evidence_cards_empty",
			severity: "warning",
			message:
				"No Atlas Evidence Packs were available for Writer Evidence Card creation.",
		});
	}
	if (maxCards !== null && cards.length > writerEvidenceCards.length) {
		diagnostics.push({
			code: "atlas_writer_evidence_cards_truncated",
			severity: "info",
			message: `Writer Evidence Cards were limited to ${writerEvidenceCards.length} of ${cards.length} available cards.`,
		});
	}

	return {
		version: ATLAS_WRITER_EVIDENCE_CARD_SCHEMA_VERSION,
		writerEvidenceCards,
		diagnostics,
	};
}

export async function routeAtlasWriterEvidenceCards(
	input: RouteAtlasWriterEvidenceCardsInput,
): Promise<BuildAtlasWriterEvidenceCardsResult> {
	const deterministicCards = deterministicWriterEvidenceCards(
		input.writerEvidenceCards,
	);
	const maxCards = normalizeMaxCards(input.maxCards);
	const fallbackCards = limitCards(deterministicCards, maxCards);
	if (deterministicCards.length === 0) {
		return {
			version: ATLAS_WRITER_EVIDENCE_CARD_SCHEMA_VERSION,
			writerEvidenceCards: [],
			diagnostics: [],
		};
	}

	const reranker = input.reranker ?? defaultWriterEvidenceCardReranker;
	const rerankLimit = Math.min(
		deterministicCards.length,
		MAX_ROUTING_RERANK_CARDS,
	);
	const rerankCandidates = deterministicCards.slice(0, rerankLimit);
	const remainder = deterministicCards.slice(rerankLimit);
	const rerankStartedAt = Date.now();
	let reranked: {
		items: Array<{
			item: AtlasWriterEvidenceCard;
			index: number;
		}>;
	} | null = null;
	try {
		reranked = await reranker({
			query: input.userQuery,
			items: rerankCandidates,
			getText: textForWriterCardRerank,
			maxTexts: rerankLimit,
			truncate: true,
		});
	} catch {
		logAtlasWriterEvidenceCardRouting({
			query: input.userQuery,
			candidateCount: deterministicCards.length,
			limitedCount: rerankCandidates.length,
			outputCount: fallbackCards.length,
			startedAt: rerankStartedAt,
			fallbackReason: "reranker_error",
			winnerId: fallbackCards[0]?.id ?? null,
		});
		return {
			version: ATLAS_WRITER_EVIDENCE_CARD_SCHEMA_VERSION,
			writerEvidenceCards: fallbackCards,
			diagnostics: [routingFallbackDiagnostic("reranker_error", fallbackCards)],
		};
	}

	if (!reranked) {
		logAtlasWriterEvidenceCardRouting({
			query: input.userQuery,
			candidateCount: deterministicCards.length,
			limitedCount: rerankCandidates.length,
			outputCount: fallbackCards.length,
			startedAt: rerankStartedAt,
			fallbackReason: "reranker_unavailable",
			winnerId: fallbackCards[0]?.id ?? null,
		});
		return {
			version: ATLAS_WRITER_EVIDENCE_CARD_SCHEMA_VERSION,
			writerEvidenceCards: fallbackCards,
			diagnostics: [
				routingFallbackDiagnostic("reranker_unavailable", fallbackCards),
			],
		};
	}

	const routedCards = cardsFromRerankResult({
		rerankedItems: reranked.items,
		candidates: rerankCandidates,
		remainder,
	});
	if (routedCards.length === 0) {
		logAtlasWriterEvidenceCardRouting({
			query: input.userQuery,
			candidateCount: deterministicCards.length,
			limitedCount: rerankCandidates.length,
			outputCount: fallbackCards.length,
			startedAt: rerankStartedAt,
			fallbackReason: "empty_rerank_results",
			winnerId: fallbackCards[0]?.id ?? null,
		});
		return {
			version: ATLAS_WRITER_EVIDENCE_CARD_SCHEMA_VERSION,
			writerEvidenceCards: fallbackCards,
			diagnostics: [
				routingFallbackDiagnostic("empty_rerank_results", fallbackCards),
			],
		};
	}

	const sectionRouting = await applySectionRouting({
		cards: routedCards,
		userQuery: input.userQuery,
		sectionBriefs: input.sectionBriefs,
		reranker,
	});
	const writerEvidenceCards = limitCards(sectionRouting.cards, maxCards);
	logAtlasWriterEvidenceCardRouting({
		query: input.userQuery,
		candidateCount: deterministicCards.length,
		limitedCount: rerankCandidates.length,
		outputCount: writerEvidenceCards.length,
		startedAt: rerankStartedAt,
		fallbackReason: null,
		winnerId: writerEvidenceCards[0]?.id ?? null,
		extra: {
			sectionMatchCount: sectionRouting.matchCount,
			sectionFallbackCount: sectionRouting.fallbackCount,
		},
	});
	return {
		version: ATLAS_WRITER_EVIDENCE_CARD_SCHEMA_VERSION,
		writerEvidenceCards,
		diagnostics: [
			routingRerankedDiagnostic({
				inputCount: deterministicCards.length,
				outputCount: writerEvidenceCards.length,
				limitedCount: rerankCandidates.length,
				sectionMatchCount: sectionRouting.matchCount,
				sectionFallbackCount: sectionRouting.fallbackCount,
			}),
		],
	};
}

function logAtlasWriterEvidenceCardRouting(input: {
	query: string;
	candidateCount: number;
	limitedCount: number;
	outputCount: number;
	startedAt: number;
	fallbackReason: string | null;
	winnerId: string | null;
	extra?: Record<string, unknown>;
}): void {
	logTeiRetrievalSummary({
		scope: "atlas_writer_evidence_cards",
		queryLength: input.query.length,
		candidateCount: input.candidateCount,
		semantic: null,
		rerank: {
			queryLength: input.query.length,
			inputCount: input.candidateCount,
			limitedCount: input.limitedCount,
			outputCount: input.outputCount,
			latencyMs: Math.max(0, Date.now() - input.startedAt),
			fallbackReason: input.fallbackReason,
			confidence: null,
		},
		winningMode: input.fallbackReason ? "deterministic" : "rerank",
		winnerId: input.winnerId,
		extra: input.extra,
	});
}

async function defaultWriterEvidenceCardReranker(
	params: AtlasWriterEvidenceCardRerankParams,
): Promise<AtlasWriterEvidenceCardRerankResult | null> {
	return rerankItems<AtlasWriterEvidenceCard>(params);
}

function buildWriterEvidenceCard(
	pack: AtlasEvidencePack,
	input: BuildAtlasWriterEvidenceCardsInput,
): AtlasWriterEvidenceCard {
	const sourceRefs = uniqueSourceRefs(pack.sourceRefs).slice(
		0,
		MAX_SOURCE_REFS,
	);
	const sourceTitle = sourceTitleForCard(pack, sourceRefs);
	const url = firstSourceUrl(sourceRefs);
	const freshnessNote = freshnessNoteForPack(pack);
	return {
		version: ATLAS_WRITER_EVIDENCE_CARD_SCHEMA_VERSION,
		id: stableWriterEvidenceCardId(pack, sourceRefs),
		sourceTitle,
		url,
		authority: mapWriterCardAuthority(pack, sourceRefs),
		sourceRefs,
		relevantFacts: relevantFactsForPack(pack),
		limitations: limitationsForPack(pack),
		conflicts: uniqueCompactTexts(pack.conflicts, {
			maxItems: MAX_CONFLICTS,
			maxLength: MAX_NOTE_LENGTH,
		}),
		supportsSections: supportsSectionsForPack(pack, input),
		evidencePackIds: [pack.id],
		freshnessNote,
	};
}

function deterministicWriterEvidenceCards(
	cards: AtlasWriterEvidenceCard[],
): AtlasWriterEvidenceCard[] {
	const seen = new Set<string>();
	const deduped: AtlasWriterEvidenceCard[] = [];
	for (const card of cards) {
		if (seen.has(card.id)) continue;
		seen.add(card.id);
		deduped.push(card);
	}
	return deduped.sort(compareWriterEvidenceCards);
}

function limitCards(
	cards: AtlasWriterEvidenceCard[],
	maxCards: number | null,
): AtlasWriterEvidenceCard[] {
	return maxCards === null ? cards : cards.slice(0, maxCards);
}

function cardsFromRerankResult(input: {
	rerankedItems: Array<{ item: AtlasWriterEvidenceCard; index: number }>;
	candidates: AtlasWriterEvidenceCard[];
	remainder: AtlasWriterEvidenceCard[];
}): AtlasWriterEvidenceCard[] {
	const candidatesById = new Map(
		input.candidates.map((card) => [card.id, card]),
	);
	const seen = new Set<string>();
	const rerankedCards: AtlasWriterEvidenceCard[] = [];
	for (const ranked of input.rerankedItems) {
		const candidate =
			candidatesById.get(ranked.item.id) ?? input.candidates[ranked.index];
		if (!candidate || seen.has(candidate.id)) continue;
		seen.add(candidate.id);
		rerankedCards.push(candidate);
	}
	if (rerankedCards.length === 0) return [];
	return [
		...rerankedCards,
		...input.candidates.filter((card) => !seen.has(card.id)),
		...input.remainder,
	];
}

async function applySectionRouting(input: {
	cards: AtlasWriterEvidenceCard[];
	userQuery: string;
	sectionBriefs: AtlasSectionBrief[];
	reranker: AtlasWriterEvidenceCardReranker;
}): Promise<{
	cards: AtlasWriterEvidenceCard[];
	matchCount: number;
	fallbackCount: number;
}> {
	let cards = input.cards;
	let matchCount = 0;
	let fallbackCount = 0;
	for (const section of routableSectionBriefs(input.sectionBriefs)) {
		const candidates = cards.slice(0, MAX_SECTION_ROUTING_CARDS);
		if (candidates.length === 0) break;
		let sectionResult: AtlasWriterEvidenceCardRerankResult | null = null;
		try {
			sectionResult = await input.reranker({
				query: sectionRoutingQuery(input.userQuery, section),
				items: candidates,
				getText: textForWriterCardRerank,
				maxTexts: candidates.length,
				truncate: true,
			});
		} catch {
			fallbackCount += 1;
			continue;
		}
		const topCard = firstRankedCard(sectionResult, candidates);
		if (!topCard) {
			fallbackCount += 1;
			continue;
		}
		cards = cards.map((card) =>
			card.id === topCard.id
				? {
						...card,
						supportsSections: uniqueCompactLabels(
							[...card.supportsSections, section.sectionTitle],
							{
								maxItems: 4,
								maxLength: MAX_SECTION_LENGTH,
							},
						),
					}
				: card,
		);
		matchCount += 1;
	}
	return { cards, matchCount, fallbackCount };
}

function routableSectionBriefs(
	sectionBriefs: AtlasSectionBrief[],
): AtlasSectionBrief[] {
	const seen = new Set<string>();
	const sections: AtlasSectionBrief[] = [];
	for (const section of sectionBriefs) {
		const title = compactLabel(section.sectionTitle, {
			maxLength: MAX_SECTION_LENGTH,
		});
		if (!title) continue;
		const key = normalizedDedupeKey(title);
		if (seen.has(key)) continue;
		seen.add(key);
		sections.push({
			...section,
			sectionTitle: title,
		});
		if (sections.length >= MAX_SECTION_ROUTING_SECTIONS) break;
	}
	return sections;
}

function firstRankedCard(
	result: AtlasWriterEvidenceCardRerankResult | null,
	candidates: AtlasWriterEvidenceCard[],
): AtlasWriterEvidenceCard | null {
	if (!result || result.items.length === 0) return null;
	const candidatesById = new Map(candidates.map((card) => [card.id, card]));
	for (const ranked of result.items) {
		const candidate =
			candidatesById.get(ranked.item.id) ?? candidates[ranked.index];
		if (candidate) return candidate;
	}
	return null;
}

function sectionRoutingQuery(
	userQuery: string,
	section: AtlasSectionBrief,
): string {
	return compactText(
		[userQuery, section.sectionTitle, section.brief].filter(Boolean).join(" "),
		{ maxLength: MAX_RERANK_TEXT_LENGTH },
	);
}

function textForWriterCardRerank(card: AtlasWriterEvidenceCard): string {
	return compactText(
		[
			card.sourceTitle,
			card.authority,
			...card.supportsSections,
			...card.relevantFacts,
			...card.limitations,
			...card.conflicts,
			card.freshnessNote,
		]
			.filter((value): value is string => Boolean(value))
			.join(" "),
		{ maxLength: MAX_RERANK_TEXT_LENGTH },
	);
}

function routingFallbackDiagnostic(
	reason: "reranker_unavailable" | "empty_rerank_results" | "reranker_error",
	cards: AtlasWriterEvidenceCard[],
): AtlasWriterEvidenceCardDiagnostic {
	const reasonText: Record<typeof reason, string> = {
		reranker_unavailable: "TEI reranker was unavailable",
		empty_rerank_results: "TEI reranker returned no routing results",
		reranker_error: "TEI reranker failed",
	};
	return {
		code: "atlas_writer_evidence_cards_routing_fallback",
		severity: "info",
		message: `${reasonText[reason]}; deterministic Writer Evidence Card order was used for ${cards.length} card${cards.length === 1 ? "" : "s"}.`,
	};
}

function routingRerankedDiagnostic(input: {
	inputCount: number;
	outputCount: number;
	limitedCount: number;
	sectionMatchCount: number;
	sectionFallbackCount: number;
}): AtlasWriterEvidenceCardDiagnostic {
	const sectionText =
		input.sectionMatchCount > 0 || input.sectionFallbackCount > 0
			? ` Section routing matched ${input.sectionMatchCount} section${input.sectionMatchCount === 1 ? "" : "s"} with ${input.sectionFallbackCount} fallback${input.sectionFallbackCount === 1 ? "" : "s"}.`
			: "";
	return {
		code: "atlas_writer_evidence_cards_routing_reranked",
		severity: "info",
		message: `TEI reranking routed ${input.outputCount} of ${input.inputCount} deterministic Writer Evidence Cards using ${input.limitedCount} candidate${input.limitedCount === 1 ? "" : "s"}.${sectionText}`,
	};
}

function uniqueSourceRefs(
	sourceRefs: AtlasEvidencePackSourceRef[],
): AtlasEvidencePackSourceRef[] {
	const seen = new Set<string>();
	const unique: AtlasEvidencePackSourceRef[] = [];
	for (const sourceRef of sourceRefs) {
		const key = [
			sourceRef.kind,
			sourceRef.id,
			sourceRef.title,
			sourceRef.url ?? "",
			sourceRef.authority,
		]
			.join("\u0000")
			.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(sourceRef);
	}
	return unique;
}

function sourceTitleForCard(
	pack: AtlasEvidencePack,
	sourceRefs: AtlasEvidencePackSourceRef[],
): string {
	return (
		compactLabel(sourceRefs[0]?.title ?? pack.supportedFacets[0] ?? pack.id, {
			maxLength: MAX_SOURCE_TITLE_LENGTH,
		}) || "Accepted Atlas evidence"
	);
}

function firstSourceUrl(
	sourceRefs: AtlasEvidencePackSourceRef[],
): string | null {
	return sourceRefs.find((sourceRef) => sourceRef.url)?.url ?? null;
}

function relevantFactsForPack(pack: AtlasEvidencePack): string[] {
	const facts: string[] = [];
	for (const sentence of splitSentences(pack.evidence.summary).slice(0, 2)) {
		facts.push(sentence);
	}
	if (pack.supportedFacets.length > 0) {
		const facets = uniqueCompactLabels(pack.supportedFacets, {
			maxItems: 6,
			maxLength: 72,
		});
		if (facets.length > 0) {
			facts.push(`Relevant facets: ${facets.join("; ")}.`);
		}
	}
	for (const sentence of splitSentences(pack.evidence.excerpt).slice(0, 2)) {
		facts.push(sentence);
	}
	return uniqueCompactTexts(facts, {
		maxItems: MAX_RELEVANT_FACTS,
		maxLength: MAX_FACT_LENGTH,
	});
}

function limitationsForPack(pack: AtlasEvidencePack): string[] {
	const limitations = [...pack.limitations];
	if (pack.authority === "parent_seed") {
		limitations.push(
			"Parent seed evidence is context, not fresh current evidence.",
		);
	} else if (!pack.freshness.isCurrentEvidence) {
		limitations.push("Evidence is not marked as fresh current evidence.");
	}
	return uniqueCompactTexts(limitations, {
		maxItems: MAX_LIMITATIONS,
		maxLength: MAX_NOTE_LENGTH,
	});
}

function supportsSectionsForPack(
	pack: AtlasEvidencePack,
	input: BuildAtlasWriterEvidenceCardsInput,
): string[] {
	const explicitHints = input.sectionHintsByEvidencePackId?.[pack.id] ?? [];
	const directCandidates = [pack.affectedSectionHint, ...explicitHints].filter(
		(value): value is string => Boolean(value?.trim()),
	);
	const candidates =
		directCandidates.length > 0
			? directCandidates
			: [inferFallbackSection(pack)].filter((value): value is string =>
					Boolean(value?.trim()),
				);
	return uniqueCompactLabels(candidates, {
		maxItems: 4,
		maxLength: MAX_SECTION_LENGTH,
	});
}

function inferFallbackSection(pack: AtlasEvidencePack): string | null {
	const text = [
		pack.evidence.summary,
		pack.evidence.excerpt,
		...pack.supportedFacets,
		...pack.limitations,
	].join(" ");
	if (/\b(recommend|should|roadmap|implementation)\b/i.test(text)) {
		return "Recommendations";
	}
	if (/\b(limitation|risk|constraint|uncertain|stale|outdated)\b/i.test(text)) {
		return "Limitations";
	}
	return pack.supportedFacets.length > 0 ? "Findings" : null;
}

function freshnessNoteForPack(pack: AtlasEvidencePack): string | null {
	const parentSuffix = pack.freshness.parentAtlasJobId
		? ` from parent Atlas job ${pack.freshness.parentAtlasJobId}`
		: "";
	if (pack.authority === "parent_seed") {
		return compactText(
			`Parent seed evidence${parentSuffix} is not fresh current evidence.`,
			{ maxLength: MAX_NOTE_LENGTH },
		);
	}
	const note = pack.freshness.isCurrentEvidence
		? pack.freshness.note
		: pack.freshness.note || "Evidence is not fresh current evidence.";
	if (note) return compactText(note, { maxLength: MAX_NOTE_LENGTH });
	const freshnessParts = [
		pack.freshness.asOfDate
			? `Evidence as of ${pack.freshness.asOfDate}`
			: null,
		pack.freshness.retrievedAt
			? `retrieved ${pack.freshness.retrievedAt}`
			: null,
	].filter((part): part is string => Boolean(part));
	return freshnessParts.length > 0 ? `${freshnessParts.join("; ")}.` : null;
}

function mapWriterCardAuthority(
	pack: AtlasEvidencePack,
	sourceRefs: AtlasEvidencePackSourceRef[],
): AtlasWriterEvidenceCardAuthority {
	switch (pack.authority) {
		case "explicit_local":
			return "user_provided";
		case "working_document":
		case "automatic_local":
			return "library";
		case "parent_seed":
			return "parent_seed";
		case "accepted_web":
			return inferWebAuthority(pack, sourceRefs);
	}
}

function inferWebAuthority(
	pack: AtlasEvidencePack,
	sourceRefs: AtlasEvidencePackSourceRef[],
): AtlasWriterEvidenceCardAuthority {
	const urls = sourceRefs
		.map((sourceRef) => sourceRef.url)
		.filter((url): url is string => Boolean(url));
	const hosts = urls.map(hostnameFromUrl).filter(Boolean);
	const text = [
		pack.evidence.summary,
		...sourceRefs.map((ref) => ref.title),
		...urls,
	]
		.join(" ")
		.toLowerCase();

	if (
		hosts.some(isOfficialHost) ||
		/\b(regulator|standards?|government|official guidance|public agency)\b/i.test(
			text,
		)
	) {
		return "official";
	}
	if (/\b(benchmark|leaderboard|mlperf|evaluation suite)\b/i.test(text)) {
		return "benchmark";
	}
	if (
		hosts.some(isVendorHost) ||
		/\b(vendor|product docs?|pricing|release notes?|service documentation)\b/i.test(
			text,
		)
	) {
		return "vendor";
	}
	if (
		hosts.some(isCommunityHost) ||
		/\b(forum|community|discussion)\b/i.test(text)
	) {
		return "community";
	}
	if (
		/\b(analysis|analyst|research report|whitepaper|case study|blog)\b/i.test(
			text,
		)
	) {
		return "analysis";
	}
	return "unknown";
}

function hostnameFromUrl(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
	} catch {
		return "";
	}
}

function isOfficialHost(host: string): boolean {
	return hostMatchesAnySuffix(host, OFFICIAL_HOST_SUFFIXES);
}

function isVendorHost(host: string): boolean {
	return hostMatchesAnySuffix(host, VENDOR_HOST_SUFFIXES);
}

function isCommunityHost(host: string): boolean {
	return hostMatchesAnySuffix(host, COMMUNITY_HOST_SUFFIXES);
}

function hostMatchesAnySuffix(host: string, suffixes: string[]): boolean {
	return suffixes.some(
		(suffix) =>
			host === suffix ||
			host.endsWith(suffix.startsWith(".") ? suffix : `.${suffix}`),
	);
}

function splitSentences(text: string): string[] {
	const normalized = normalizeEvidenceText(text);
	const sentences = normalized
		.split(/(?<=[.!?])\s+/)
		.map((sentence) => sentence.trim())
		.filter(Boolean);
	return sentences.length > 0 ? sentences : [normalized].filter(Boolean);
}

function uniqueCompactTexts(
	values: Array<string | null | undefined>,
	options: { maxItems: number; maxLength: number },
): string[] {
	const seen = new Set<string>();
	const compacted: string[] = [];
	for (const value of values) {
		const compact = compactText(value ?? "", {
			maxLength: options.maxLength,
		});
		if (!compact) continue;
		const key = normalizedDedupeKey(compact);
		if (seen.has(key) || isSubstantiallyCovered(key, seen)) continue;
		seen.add(key);
		compacted.push(compact);
		if (compacted.length >= options.maxItems) break;
	}
	return compacted;
}

function isSubstantiallyCovered(key: string, seen: Set<string>): boolean {
	for (const existing of seen) {
		if (existing.includes(key) || key.includes(existing)) {
			return true;
		}
	}
	return false;
}

function compactText(text: string, options: { maxLength: number }): string {
	const normalized = normalizeEvidenceText(text);
	if (!normalized) return "";
	if (normalized.length <= options.maxLength) {
		return ensureTerminalPunctuation(normalized);
	}
	const truncated = normalized
		.slice(0, options.maxLength)
		.replace(/\s+\S*$/, "")
		.trim();
	return ensureTerminalPunctuation(`${truncated}...`);
}

function uniqueCompactLabels(
	values: Array<string | null | undefined>,
	options: { maxItems: number; maxLength: number },
): string[] {
	const seen = new Set<string>();
	const labels: string[] = [];
	for (const value of values) {
		const label = compactLabel(value ?? "", { maxLength: options.maxLength });
		if (!label) continue;
		const key = normalizedDedupeKey(label);
		if (seen.has(key)) continue;
		seen.add(key);
		labels.push(label);
		if (labels.length >= options.maxItems) break;
	}
	return labels;
}

function compactLabel(text: string, options: { maxLength: number }): string {
	const normalized = normalizeEvidenceText(text);
	if (!normalized) return "";
	if (normalized.length <= options.maxLength) return normalized;
	return normalized
		.slice(0, options.maxLength)
		.replace(/\s+\S*$/, "")
		.trim();
}

function normalizeEvidenceText(text: string): string {
	return collapseRepeatedTokenRuns(
		text
			.replace(/\bSearch result snippet:\s*/gi, "")
			.replace(/\bFetched page excerpt:\s*/gi, "")
			.replace(/\s+/g, " ")
			.trim(),
	);
}

function collapseRepeatedTokenRuns(text: string): string {
	const tokens = text.split(" ").filter(Boolean);
	if (tokens.length < 3) return text;
	const result: string[] = [];
	for (let index = 0; index < tokens.length; ) {
		let collapsed = false;
		for (let size = 6; size >= 1; size -= 1) {
			const phrase = tokens.slice(index, index + size);
			if (phrase.length < size) continue;
			let repeats = 1;
			while (
				sameTokenRun(
					phrase,
					tokens.slice(index + repeats * size, index + (repeats + 1) * size),
				)
			) {
				repeats += 1;
			}
			if (repeats >= 3) {
				result.push(...phrase);
				index += repeats * size;
				collapsed = true;
				break;
			}
		}
		if (!collapsed) {
			result.push(tokens[index]);
			index += 1;
		}
	}
	return result.join(" ");
}

function sameTokenRun(left: string[], right: string[]): boolean {
	if (left.length === 0 || left.length !== right.length) return false;
	return left.every(
		(token, index) => token.toLowerCase() === right[index]?.toLowerCase(),
	);
}

function normalizedDedupeKey(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function ensureTerminalPunctuation(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return "";
	return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function stableWriterEvidenceCardId(
	pack: AtlasEvidencePack,
	sourceRefs: AtlasEvidencePackSourceRef[],
): string {
	const hash = createHash("sha256")
		.update(
			JSON.stringify({
				version: ATLAS_WRITER_EVIDENCE_CARD_SCHEMA_VERSION,
				evidencePackId: pack.id,
				sourceRefs: sourceRefs.map((sourceRef) => ({
					id: sourceRef.id,
					kind: sourceRef.kind,
					url: sourceRef.url,
				})),
			}),
		)
		.digest("base64url")
		.slice(0, 16);
	return `atlas-card-v1-${hash}`;
}

function compareWriterEvidenceCards(
	left: AtlasWriterEvidenceCard,
	right: AtlasWriterEvidenceCard,
): number {
	return (
		authorityRank(left.authority) - authorityRank(right.authority) ||
		left.sourceTitle.localeCompare(right.sourceTitle) ||
		left.id.localeCompare(right.id)
	);
}

function authorityRank(authority: AtlasWriterEvidenceCardAuthority): number {
	return AUTHORITY_RANK[authority];
}

function normalizeMaxCards(maxCards: number | undefined): number | null {
	if (typeof maxCards !== "number" || !Number.isFinite(maxCards)) return null;
	return Math.max(0, Math.floor(maxCards));
}
