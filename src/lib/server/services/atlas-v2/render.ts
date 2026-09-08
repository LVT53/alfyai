// Atlas v2 stage 6: render (ADR 0062). Builds the file-production
// `documentSource` directly out of verified sentences, so heading levels are
// produced rather than reconstructed and no report-shape repair is needed.
//
// Citation confidence rides INSIDE the paragraph text as a superscript key
// after the citation group. That is deliberate: the HTML renderer already turns
// `[n]` in paragraph text into a linked, numbered source chip, and the PDF and
// Markdown renderers pass the text through, so one mechanism renders in all
// three outputs without changing file-production. The `basisMarkers`
// annotation was rejected for this because Markdown and PDF turn it into
// "(Basis: Partial)" prose — the defect this pipeline exists to remove.

import type {
	GeneratedDocumentBlock,
	GeneratedDocumentSource,
	GeneratedDocumentSourceChip,
} from "$lib/server/services/file-production/source-schema";
import type { SupportedLanguage } from "$lib/server/services/language";
import { formatSourceLine } from "./evidence-index";
import type {
	AtlasV2Confidence,
	AtlasV2Contradiction,
	AtlasV2EvidenceIndex,
	AtlasV2IndexedSource,
	AtlasV2VerificationResult,
	AtlasV2VerifiedSection,
} from "./types";

/** The per-claim confidence key, in every output. */
export const ATLAS_V2_CONFIDENCE_MARKS: Record<AtlasV2Confidence, string> = {
	corroborated: "ᶜ",
	single: "ˢ",
	inferred: "ⁱ",
};

interface AtlasV2RenderChrome {
	executiveSummary: string;
	limitations: string;
	sources: string;
	confidenceLegend: string;
	thinQuestion: (question: string) => string;
	staleSources: (input: { citations: string; months: number }) => string;
	contradiction: (input: AtlasV2Contradiction) => string;
	cutSentences: (count: number) => string;
	noLimitations: string;
	sourceReasoning: string;
}

const CHROME: Record<SupportedLanguage, AtlasV2RenderChrome> = {
	en: {
		executiveSummary: "Executive summary",
		limitations: "Limitations",
		sources: "Sources",
		confidenceLegend:
			"Confidence key: ᶜ corroborated by two independent organisations · ˢ a single source · ⁱ inferred synthesis with no direct source.",
		thinQuestion: (question) => `No usable evidence was found for: ${question}`,
		staleSources: ({ citations, months }) =>
			`Statistics cited from ${citations} are more than ${months} months old.`,
		contradiction: (contradiction) =>
			`Sources disagree: [${contradiction.statedCitation}] gives ${contradiction.statedValue} where [${contradiction.competingCitation}] gives ${contradiction.competingValue}.`,
		cutSentences: (count) =>
			count === 1
				? "One sentence was removed because no cited source supported it."
				: `${count} sentences were removed because no cited source supported them.`,
		noLimitations:
			"Every cited figure was matched against its source and no contradiction was found.",
		sourceReasoning: "Cited in this report",
	},
	hu: {
		executiveSummary: "Vezetői összefoglaló",
		limitations: "Korlátok",
		sources: "Források",
		confidenceLegend:
			"Bizonyossági jelölés: ᶜ két független szervezet is megerősíti · ˢ egyetlen forrás · ⁱ következtetett szintézis, közvetlen forrás nélkül.",
		thinQuestion: (question) =>
			`Nem találtunk használható bizonyítékot erre: ${question}`,
		staleSources: ({ citations, months }) =>
			`A ${citations} forrásból hivatkozott statisztikák ${months} hónapnál régebbiek.`,
		contradiction: (contradiction) =>
			`A források nem egyeznek: a [${contradiction.statedCitation}] szerint ${contradiction.statedValue}, a [${contradiction.competingCitation}] szerint ${contradiction.competingValue}.`,
		cutSentences: (count) =>
			count === 1
				? "Egy mondatot eltávolítottunk, mert egyik hivatkozott forrás sem támasztotta alá."
				: `${count} mondatot eltávolítottunk, mert egyik hivatkozott forrás sem támasztotta alá.`,
		noLimitations:
			"Minden hivatkozott számot összevetettünk a forrásával, és nem találtunk ellentmondást.",
		sourceReasoning: "Ebben a jelentésben hivatkozva",
	},
};

/**
 * Renumbers the report for publication: only sources at least one surviving
 * sentence cites are published, renumbered 1..k in their original order, and
 * every inline citation, contradiction and stale-source reference is remapped.
 *
 * This matters beyond tidiness: the HTML renderer resolves `[n]` against the
 * Sources block's order, so the published numbering and the Sources list must
 * agree exactly.
 */
export interface AtlasV2Publication {
	sources: AtlasV2IndexedSource[];
	sections: AtlasV2VerifiedSection[];
	contradictions: AtlasV2Contradiction[];
	staleCitations: number[];
	/** Original source number -> published number. */
	renumberMap: Map<number, number>;
}

export function renumberAtlasV2ForPublication(input: {
	index: AtlasV2EvidenceIndex;
	verification: AtlasV2VerificationResult;
}): AtlasV2Publication {
	const cited = new Set(input.verification.citedSourceNumbers);
	// A contradiction names a source the report may not otherwise cite; it still
	// has to be resolvable from the Limitations line, so it is published too.
	for (const contradiction of input.verification.contradictions) {
		cited.add(contradiction.statedCitation);
		cited.add(contradiction.competingCitation);
	}
	const ordered = input.index.sources
		.filter((source) => cited.has(source.n))
		.sort((left, right) => left.n - right.n);
	const renumberMap = new Map<number, number>(
		ordered.map((source, index) => [source.n, index + 1]),
	);
	const remap = (value: number): number => renumberMap.get(value) ?? value;

	return {
		sources: ordered.map((source) => ({ ...source, n: remap(source.n) })),
		sections: input.verification.sections.map((section) => ({
			...section,
			paragraphs: section.paragraphs.map((paragraph) =>
				paragraph.map((sentence) => ({
					...sentence,
					citations: sentence.citations
						.filter((citation) => renumberMap.has(citation))
						.map(remap),
				})),
			),
		})),
		contradictions: input.verification.contradictions.map((contradiction) => ({
			...contradiction,
			statedCitation: remap(contradiction.statedCitation),
			competingCitation: remap(contradiction.competingCitation),
		})),
		staleCitations: input.verification.staleCitations
			.filter((citation) => renumberMap.has(citation))
			.map(remap)
			.sort((a, b) => a - b),
		renumberMap,
	};
}

/** `"Solar reached 8 GW. [3][7]ᶜ"` — citations, then one confidence mark. */
export function renderSentenceWithCitations(sentence: {
	text: string;
	citations: number[];
	confidence: AtlasV2Confidence;
}): string {
	const mark = ATLAS_V2_CONFIDENCE_MARKS[sentence.confidence];
	const citations = sentence.citations
		.map((citation) => `[${citation}]`)
		.join("");
	return citations
		? `${sentence.text} ${citations}${mark}`
		: `${sentence.text} ${mark}`;
}

function paragraphBlock(
	sentences: Array<{
		text: string;
		citations: number[];
		confidence: AtlasV2Confidence;
	}>,
): GeneratedDocumentBlock {
	return {
		type: "paragraph",
		text: sentences.map(renderSentenceWithCitations).join(" "),
	};
}

function sourceChip(
	source: AtlasV2IndexedSource,
	chrome: AtlasV2RenderChrome,
): GeneratedDocumentSourceChip {
	return {
		title: formatSourceLine(source),
		url: source.canonicalUrl,
		kind: "web",
		provided: false,
		reasoning: chrome.sourceReasoning,
	};
}

export interface BuildAtlasV2DocumentSourceInput {
	title: string;
	subtitle?: string | null;
	date?: string | null;
	language: SupportedLanguage;
	publication: AtlasV2Publication;
	/** Verified executive-summary paragraphs, written last from the sections. */
	summary: AtlasV2VerifiedSection | null;
	/** Research questions no usable evidence answered. */
	thinQuestions: string[];
	cutSentenceCount: number;
	staleMonths: number;
}

export function buildAtlasV2DocumentSource(
	input: BuildAtlasV2DocumentSourceInput,
): GeneratedDocumentSource {
	const chrome = CHROME[input.language];
	const blocks: GeneratedDocumentBlock[] = [];

	if (input.summary && input.summary.paragraphs.length > 0) {
		blocks.push({ type: "heading", level: 2, text: chrome.executiveSummary });
		for (const paragraph of input.summary.paragraphs) {
			blocks.push(paragraphBlock(paragraph));
		}
		blocks.push({
			type: "paragraph",
			text: chrome.confidenceLegend,
		});
	}

	for (const section of input.publication.sections) {
		if (section.paragraphs.length === 0) continue;
		blocks.push({ type: "heading", level: 2, text: section.title });
		for (const paragraph of section.paragraphs) {
			blocks.push(paragraphBlock(paragraph));
		}
	}

	const limitations = buildAtlasV2Limitations({
		language: input.language,
		publication: input.publication,
		thinQuestions: input.thinQuestions,
		cutSentenceCount: input.cutSentenceCount,
		staleMonths: input.staleMonths,
	});
	blocks.push({ type: "heading", level: 2, text: chrome.limitations });
	blocks.push({ type: "list", style: "bullet", items: limitations });

	if (input.publication.sources.length > 0) {
		blocks.push({ type: "heading", level: 2, text: chrome.sources });
		blocks.push({
			type: "sourceChips",
			title: chrome.sources,
			sources: input.publication.sources.map((source) =>
				sourceChip(source, chrome),
			),
		});
	}

	return {
		version: 1,
		template: "alfyai_standard_report",
		title: input.title,
		subtitle: input.subtitle ?? null,
		date: input.date ?? null,
		language: input.language,
		blocks,
	};
}

export function buildAtlasV2Limitations(input: {
	language: SupportedLanguage;
	publication: AtlasV2Publication;
	thinQuestions: string[];
	cutSentenceCount: number;
	staleMonths: number;
}): string[] {
	const chrome = CHROME[input.language];
	const items: string[] = [];
	for (const question of input.thinQuestions) {
		items.push(chrome.thinQuestion(question));
	}
	if (input.publication.staleCitations.length > 0) {
		items.push(
			chrome.staleSources({
				citations: input.publication.staleCitations
					.map((citation) => `[${citation}]`)
					.join(", "),
				months: input.staleMonths,
			}),
		);
	}
	for (const contradiction of input.publication.contradictions) {
		items.push(chrome.contradiction(contradiction));
	}
	if (input.cutSentenceCount > 0) {
		items.push(chrome.cutSentences(input.cutSentenceCount));
	}
	if (items.length === 0) items.push(chrome.noLimitations);
	return items;
}

/**
 * The executive summary as Markdown. This becomes the assistant message's
 * `content` on a succeeded job, so chat follow-ups have the report's substance
 * in context (ADR 0062).
 */
export function buildAtlasV2ExecutiveSummaryMarkdown(input: {
	title: string;
	summary: AtlasV2VerifiedSection | null;
	publication: AtlasV2Publication;
	language: SupportedLanguage;
}): string {
	const chrome = CHROME[input.language];
	if (!input.summary || input.summary.paragraphs.length === 0) return "";
	const paragraphs = input.summary.paragraphs.map((paragraph) =>
		paragraph.map(renderSentenceWithCitations).join(" "),
	);
	const sourceLines = input.publication.sources.map(
		(source) => `[${source.n}] ${formatSourceLine(source)}`,
	);
	return [
		`## ${input.title}`,
		"",
		...paragraphs.flatMap((paragraph) => [paragraph, ""]),
		chrome.confidenceLegend,
		"",
		`**${chrome.sources}**`,
		...sourceLines,
	]
		.join("\n")
		.trim();
}
