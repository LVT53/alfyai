// Atlas v3: the abstaining report (ADR 0063, amended 2026-09-10).
//
// ADR 0063 promised a goal test whose failing outcome is an ABSTENTION — "a
// report that says the 2025 member-state breakdown has not been published is
// more useful than one that pads around the hole". The pipeline shipped the
// test but not the outcome: a question whose research found nothing usable
// threw `atlas_v3_no_sections` and the job died, which is the one thing an
// abstention is supposed to prevent. The staging run's Kerry-slug query read
// eight sources, bound no evidence to any outline node, wrote nothing, and
// failed.
//
// What is built here is deliberately DETERMINISTIC and bypasses verification:
// every sentence is assembled from the bank, so there is nothing to check and
// nothing that can be cut. The sources read still render as `[n]` — a reader
// who wants to continue the search by hand needs them more here than in a
// report that answered.

import type { SupportedLanguage } from "$lib/server/services/language";
import { atlasV3PublishersFor, formatAtlasV3SourceLine } from "./evidence-bank";
import type {
	AtlasV3EvidenceBank,
	AtlasV3Source,
	AtlasV3SourceTier,
	AtlasV3VerificationTotals,
	AtlasV3VerifiedSection,
	AtlasV3VerifiedSentence,
} from "./types";

/** Sources named in "What was searched". More is a directory, not a report. */
const MAX_SOURCES_LISTED = 6;
const MAX_QUESTIONS_LISTED = 6;

const TIER_ORDER: Record<AtlasV3SourceTier, number> = {
	primary: 0,
	press: 1,
	aggregator: 2,
	weak: 3,
};

interface AbstentionChrome {
	sectionTitle: string;
	noAnswer: (question: string) => string;
	budget: (input: { searches: number; pagesRead: number }) => string;
	asked: (question: string) => string;
	read: (source: string) => string;
	nothingRead: string;
}

const CHROME: Record<SupportedLanguage, AbstentionChrome> = {
	en: {
		sectionTitle: "What was searched",
		noAnswer: (question) =>
			`This report does not answer the question it was asked: ${question}`,
		budget: ({ searches, pagesRead }) =>
			`${searches} searches were issued and ${pagesRead} pages were read; none of them stated a figure that answers it.`,
		asked: (question) => `Researched: ${question}`,
		read: (source) => `Read: ${source}`,
		nothingRead: "No page that was reached carried a usable published figure.",
	},
	hu: {
		sectionTitle: "Amit megkerestünk",
		noAnswer: (question) =>
			`Ez a jelentés nem válaszolja meg a feltett kérdést: ${question}`,
		budget: ({ searches, pagesRead }) =>
			`${searches} keresés indult és ${pagesRead} oldal került elolvasásra; egyikük sem közölt olyan adatot, amely megválaszolná.`,
		asked: (question) => `Kutatott kérdés: ${question}`,
		read: (source) => `Elolvasva: ${source}`,
		nothingRead:
			"Egyetlen elért oldal sem hordozott használható közzétett adatot.",
	},
};

export interface AtlasV3AbstentionReport {
	verdict: AtlasV3VerifiedSentence[];
	sections: AtlasV3VerifiedSection[];
	totals: AtlasV3VerificationTotals;
	/** Sources the report names but no sentence cites; published all the same. */
	extraSourceIds: string[];
}

export interface BuildAtlasV3AbstentionReportInput {
	coreQuestion: string;
	subQuestions: readonly string[];
	bank: AtlasV3EvidenceBank;
	language: SupportedLanguage;
	searches: number;
	pagesRead: number;
}

/** The strongest sources the research actually read, best tier first. */
export function atlasV3StrongestSources(
	bank: AtlasV3EvidenceBank,
	limit = MAX_SOURCES_LISTED,
): AtlasV3Source[] {
	const quoteCount = new Map<string, number>();
	for (const quote of bank.quotes) {
		quoteCount.set(quote.sourceId, (quoteCount.get(quote.sourceId) ?? 0) + 1);
	}
	return [...bank.sources]
		.sort((left, right) => {
			const readDelta = Number(right.read) - Number(left.read);
			if (readDelta !== 0) return readDelta;
			const tierDelta = TIER_ORDER[left.tier] - TIER_ORDER[right.tier];
			if (tierDelta !== 0) return tierDelta;
			const quoteDelta =
				(quoteCount.get(right.id) ?? 0) - (quoteCount.get(left.id) ?? 0);
			if (quoteDelta !== 0) return quoteDelta;
			return left.id.localeCompare(right.id, "en", { numeric: true });
		})
		.slice(0, limit);
}

function sentence(input: {
	text: string;
	evidenceIds: string[];
	bank: AtlasV3EvidenceBank;
}): AtlasV3VerifiedSentence {
	const publishers = atlasV3PublishersFor(input.bank, input.evidenceIds);
	return {
		text: input.text,
		evidenceIds: input.evidenceIds,
		kind: "claim",
		confidence:
			publishers.length >= 2
				? "corroborated"
				: input.evidenceIds.length > 0
					? "single"
					: "inferred",
		outcome: "kept",
		failures: [],
	};
}

export function buildAtlasV3AbstentionReport(
	input: BuildAtlasV3AbstentionReportInput,
): AtlasV3AbstentionReport {
	const chrome = CHROME[input.language];
	const bank = input.bank;
	const verdict: AtlasV3VerifiedSentence[] = [
		sentence({
			text: chrome.noAnswer(input.coreQuestion.replace(/\s+/g, " ").trim()),
			evidenceIds: [],
			bank,
		}),
		sentence({
			text: chrome.budget({
				searches: input.searches,
				pagesRead: input.pagesRead,
			}),
			evidenceIds: [],
			bank,
		}),
	];

	const questions: string[] = [];
	for (const question of input.subQuestions) {
		const cleaned = question.replace(/\s+/g, " ").trim();
		if (!cleaned) continue;
		if (
			questions.some((entry) => entry.toLowerCase() === cleaned.toLowerCase())
		)
			continue;
		questions.push(cleaned);
		if (questions.length >= MAX_QUESTIONS_LISTED) break;
	}
	const asked = questions.map((question) =>
		sentence({ text: chrome.asked(question), evidenceIds: [], bank }),
	);

	const sources = atlasV3StrongestSources(bank);
	const extraSourceIds: string[] = [];
	const read = sources.map((source) => {
		// A source with a quote is CITED, so it renders as `[n]` in the prose; one
		// without is named in the evidence card instead, which is why the caller is
		// handed `extraSourceIds`.
		const quote = bank.quotes.find((entry) => entry.sourceId === source.id);
		if (!quote) extraSourceIds.push(source.id);
		return sentence({
			text: chrome.read(formatAtlasV3SourceLine(source)),
			evidenceIds: quote ? [quote.id] : [],
			bank,
		});
	});
	if (read.length === 0) {
		read.push(sentence({ text: chrome.nothingRead, evidenceIds: [], bank }));
	}

	const paragraphs = [asked, read].filter(
		(paragraph) => paragraph.length > 0,
	) as AtlasV3VerifiedSentence[][];
	const sections: AtlasV3VerifiedSection[] = [
		{
			nodeId: "abstain",
			title: chrome.sectionTitle,
			paragraphs,
			table: null,
		},
	];

	const totals: AtlasV3VerificationTotals = {
		corroborated: 0,
		single: 0,
		inferred: 0,
		repeated: 0,
		cut: 0,
		needsEvidence: 0,
	};
	for (const entry of [...verdict, ...paragraphs.flat()]) {
		totals[entry.confidence] += 1;
	}
	return { verdict, sections, totals, extraSourceIds };
}

/**
 * True when nothing in the bank can carry a sentence. Sources alone are not
 * evidence: a page that was reached but yielded no quote and no claim is a URL,
 * and a report cannot be written from URLs.
 */
export function atlasV3BankIsUnusable(bank: AtlasV3EvidenceBank): boolean {
	return bank.claims.length === 0 && bank.quotes.length === 0;
}
