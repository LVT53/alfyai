// Atlas v2 stage 5: verification (ADR 0062).
//
// Deterministic first, model only where deterministic checking cannot reach.
// The order matters: a citation that does not resolve, a figure the source does
// not state, or a figure in a sentence claiming to be inferred are all decided
// without a model. Only a NON-numeric cited claim reaches the entailment check,
// one claim per call.
//
// A failing sentence goes back to the writer ONCE with the exact mismatch. If
// it still fails, it is cut. Cutting is a real outcome: a v2 report can be
// shorter than a v1 report on the same query, and Limitations says so.

import { sourceEvidenceText } from "./evidence-index";
import {
	competingFigures,
	extractFigures,
	figureAppearsInText,
	findUnsupportedFigures,
} from "./number-match";
import type {
	AtlasV2Confidence,
	AtlasV2Contradiction,
	AtlasV2EvidenceIndex,
	AtlasV2Failure,
	AtlasV2IndexedSource,
	AtlasV2VerificationResult,
	AtlasV2VerificationTotals,
	AtlasV2VerifiedSection,
	AtlasV2VerifiedSentence,
	AtlasV2WrittenSection,
	AtlasV2WrittenSentence,
} from "./types";

/** Shared content words between a claim and a source window, for relevance. */
const CONTENT_STOPWORDS = new Set([
	"the",
	"and",
	"for",
	"that",
	"this",
	"with",
	"from",
	"have",
	"has",
	"was",
	"were",
	"been",
	"are",
	"its",
	"their",
	"which",
	"than",
	"into",
	"over",
	"about",
	"more",
	"most",
	"also",
	"but",
	"not",
	"per",
	"cent",
	"year",
	"years",
	"hogy",
	"volt",
	"lesz",
	"mint",
	"amely",
	"azonban",
	"illetve",
	"voor",
	"deze",
	"heeft",
	"werd",
	"maar",
	"ook",
]);

const CONTRADICTION_WINDOW_CHARS = 320;
const MIN_SHARED_CONTENT_WORDS = 2;

export type AtlasV2EntailmentCheck = (input: {
	claim: string;
	sourceNumber: number;
	sourceTitle: string;
	sourceText: string;
}) => Promise<boolean | null>;

export type AtlasV2CalculationRunner = (input: {
	expression: string;
}) => Promise<{ ok: boolean; value: string | null }>;

export type AtlasV2SectionRewriter = (input: {
	section: AtlasV2WrittenSection;
	failed: Array<{
		paragraphIndex: number;
		sentenceIndex: number;
		text: string;
		citations: number[];
		reasons: string[];
	}>;
}) => Promise<AtlasV2WrittenSection | null>;

export interface VerifyAtlasV2ReportInput {
	sections: AtlasV2WrittenSection[];
	index: AtlasV2EvidenceIndex;
	staleMonths: number;
	now: Date;
	/** Omitted in tests and when no audit model is available. */
	checkEntailment?: AtlasV2EntailmentCheck;
	/** Omitted when run_python is unavailable; calc sentences then go inferred. */
	runCalculation?: AtlasV2CalculationRunner;
	/** Omitted to skip the rewrite pass and cut on first failure. */
	rewriteSection?: AtlasV2SectionRewriter;
}

function contentWords(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\s]/gu, " ")
			.split(/\s+/)
			.filter((word) => word.length > 3 && !CONTENT_STOPWORDS.has(word)),
	);
}

function sharedContentWordCount(left: Set<string>, right: Set<string>): number {
	let shared = 0;
	for (const word of left) {
		if (right.has(word)) shared += 1;
	}
	return shared;
}

function monthsBetween(from: Date, to: Date): number {
	return (
		(to.getFullYear() - from.getFullYear()) * 12 +
		(to.getMonth() - from.getMonth())
	);
}

export function isStaleSource(
	source: AtlasV2IndexedSource,
	staleMonths: number,
	now: Date,
): boolean {
	if (!source.date) return false;
	const parsed = new Date(
		source.date.length === 7 ? `${source.date}-01` : source.date,
	);
	if (Number.isNaN(parsed.getTime())) return false;
	return monthsBetween(parsed, now) > staleMonths;
}

/**
 * Confidence for a numeric claim: `corroborated` when the figure appears in
 * sources from at least two DIFFERENT organisations (see publishers.ts), so
 * two mirrors or two aggregators carrying one wire story stay `single`.
 */
export function figureCorroboration(input: {
	sentence: string;
	sources: AtlasV2IndexedSource[];
}): { organisations: string[]; supportingNumbers: number[] } {
	const figures = extractFigures(input.sentence).filter(
		(figure) => !figure.isDate && figure.value !== null,
	);
	if (figures.length === 0) {
		return { organisations: [], supportingNumbers: [] };
	}
	const organisations = new Set<string>();
	const supportingNumbers: number[] = [];
	for (const source of input.sources) {
		const text = sourceEvidenceText(source);
		// A source corroborates the claim only when it states EVERY figure in it.
		const statesAll = figures.every((figure) =>
			figureAppearsInText(figure, text),
		);
		if (!statesAll) continue;
		organisations.add(source.organisation);
		supportingNumbers.push(source.n);
	}
	return { organisations: [...organisations], supportingNumbers };
}

/**
 * Independent sources that state a DIFFERENT figure for what looks like the
 * same metric. Relevance is content-word overlap between the claim and the
 * text window around the competing figure, so "8 GW of solar" is not treated
 * as contradicted by "6 GW of wind" in the same document.
 */
export function findContradictions(input: {
	sentence: string;
	citedSources: AtlasV2IndexedSource[];
	allSources: AtlasV2IndexedSource[];
}): AtlasV2Contradiction[] {
	const claimWords = contentWords(input.sentence);
	const citedOrganisations = new Set(
		input.citedSources.map((source) => source.organisation),
	);
	const contradictions: AtlasV2Contradiction[] = [];
	const figures = extractFigures(input.sentence).filter(
		(figure) => !figure.isDate && figure.value !== null && figure.unit !== "",
	);
	if (figures.length === 0) return contradictions;

	for (const figure of figures) {
		for (const source of input.allSources) {
			if (citedOrganisations.has(source.organisation)) continue;
			const text = sourceEvidenceText(source);
			// A source that also states our figure agrees; it cannot contradict.
			if (figureAppearsInText(figure, text)) continue;
			for (const competing of competingFigures(figure, text)) {
				const index = text.indexOf(competing.text);
				const window =
					index < 0
						? text
						: text.slice(
								Math.max(0, index - CONTRADICTION_WINDOW_CHARS),
								index + CONTRADICTION_WINDOW_CHARS,
							);
				if (
					sharedContentWordCount(claimWords, contentWords(window)) <
					MIN_SHARED_CONTENT_WORDS
				) {
					continue;
				}
				const statedCitation = input.citedSources[0]?.n ?? 0;
				if (
					contradictions.some(
						(existing) =>
							existing.competingCitation === source.n &&
							existing.competingValue === competing.text,
					)
				) {
					continue;
				}
				contradictions.push({
					statedValue: figure.text,
					statedCitation,
					competingValue: competing.text,
					competingCitation: source.n,
					sentence: input.sentence,
				});
				break;
			}
		}
	}
	return contradictions;
}

/** True when the sentence already states the competing figure too. */
function statesBothFigures(
	sentence: string,
	contradiction: AtlasV2Contradiction,
): boolean {
	const figures = extractFigures(sentence);
	const competing = extractFigures(contradiction.competingValue)[0];
	if (!competing) return false;
	return figures.some(
		(figure) =>
			figure.value !== null &&
			competing.value !== null &&
			figure.unit === competing.unit &&
			Math.abs(figure.value - competing.value) < 1e-9,
	);
}

interface SentenceVerdict {
	confidence: AtlasV2Confidence;
	failures: AtlasV2Failure[];
	contradictions: AtlasV2Contradiction[];
	staleCitations: number[];
}

async function verifySentence(input: {
	sentence: AtlasV2WrittenSentence;
	section: AtlasV2WrittenSection;
	sourcesByNumber: Map<number, AtlasV2IndexedSource>;
	allSources: AtlasV2IndexedSource[];
	staleMonths: number;
	now: Date;
	checkEntailment?: AtlasV2EntailmentCheck;
	calculationValues: Map<string, string | null>;
	onEntailmentCall: () => void;
}): Promise<SentenceVerdict> {
	const failures: AtlasV2Failure[] = [];
	const { sentence } = input;
	const figures = extractFigures(sentence.text);
	const hasFigure = figures.length > 0;

	// (a) every [n] resolves.
	const citedSources: AtlasV2IndexedSource[] = [];
	for (const citation of sentence.citations) {
		const source = input.sourcesByNumber.get(citation);
		if (!source) {
			failures.push({
				code: "unresolved_citation",
				detail: `citation [${citation}] does not exist in the source index`,
				citation,
			});
			continue;
		}
		citedSources.push(source);
	}

	// (e) an inferred sentence may not carry a figure.
	if (sentence.inferred) {
		if (hasFigure) {
			failures.push({
				code: "inferred_with_figure",
				detail: `an inferred sentence may not state a figure, but this one states "${figures[0].text}"`,
				citation: null,
			});
		}
		return {
			confidence: "inferred",
			failures,
			contradictions: [],
			staleCitations: [],
		};
	}

	// A factual sentence with a figure and no citation cannot be checked at all.
	if (citedSources.length === 0) {
		failures.push({
			code: hasFigure ? "uncited_figure" : "unresolved_citation",
			detail: hasFigure
				? `"${figures[0].text}" carries no citation; every figure must cite the source that states it`
				: "this sentence carries no citation and is not marked as inferred synthesis",
			citation: null,
		});
		return {
			confidence: "inferred",
			failures,
			contradictions: [],
			staleCitations: [],
		};
	}

	// (h) derived arithmetic must come from run_python.
	if (sentence.calcId) {
		const value = input.calculationValues.get(sentence.calcId);
		if (value === undefined || value === null) {
			failures.push({
				code: "calculation_unverified",
				detail: `the arithmetic behind this sentence (${sentence.calcId}) was not computed, so its figure cannot stand as sourced`,
				citation: null,
			});
			return {
				confidence: "inferred",
				failures,
				contradictions: [],
				staleCitations: [],
			};
		}
	}

	// (b) every figure appears in at least ONE cited source.
	if (hasFigure && !sentence.calcId) {
		for (const figure of figures) {
			const supported = citedSources.some((source) =>
				figureAppearsInText(figure, sourceEvidenceText(source)),
			);
			if (supported) continue;
			const perSource = citedSources.map(
				(source) =>
					findUnsupportedFigures({
						sentence: figure.text,
						sourceText: sourceEvidenceText(source),
						sourceNumber: source.n,
					})[0]?.detail ?? "",
			);
			failures.push({
				code: "number_not_in_source",
				detail:
					perSource.filter(Boolean).join("; ") ||
					`"${figure.text}" does not appear in any cited source`,
				citation: citedSources[0]?.n ?? null,
			});
		}
	}

	// (c) a non-numeric cited claim gets one yes/no entailment check.
	if (!hasFigure && input.checkEntailment && failures.length === 0) {
		const primary = citedSources[0];
		input.onEntailmentCall();
		const entailed = await input.checkEntailment({
			claim: sentence.text,
			sourceNumber: primary.n,
			sourceTitle: primary.title,
			sourceText: sourceEvidenceText(primary),
		});
		if (entailed === false) {
			failures.push({
				code: "entailment_failed",
				detail: `source [${primary.n}] does not support this claim`,
				citation: primary.n,
			});
		}
	}

	// (f) contradictions must be stated, not hidden.
	const contradictions = findContradictions({
		sentence: sentence.text,
		citedSources,
		allSources: input.allSources,
	}).filter(
		(contradiction) => !statesBothFigures(sentence.text, contradiction),
	);
	for (const contradiction of contradictions) {
		failures.push({
			code: "contradiction_unstated",
			detail: `source [${contradiction.competingCitation}] gives ${contradiction.competingValue} where this sentence gives ${contradiction.statedValue}; state both figures and cite both sources`,
			citation: contradiction.competingCitation,
		});
	}

	// (g) recency: a stale source behind a statistic goes into Limitations.
	const staleCitations = hasFigure
		? citedSources
				.filter((source) => isStaleSource(source, input.staleMonths, input.now))
				.map((source) => source.n)
		: [];

	// (e) confidence.
	let confidence: AtlasV2Confidence;
	if (sentence.calcId) {
		// A computed figure is only as strong as its cited inputs, and no source
		// states it verbatim, so it never claims corroboration.
		confidence = "single";
	} else if (hasFigure) {
		const { organisations } = figureCorroboration({
			sentence: sentence.text,
			sources: input.allSources,
		});
		confidence = organisations.length >= 2 ? "corroborated" : "single";
	} else {
		const organisations = new Set(
			citedSources.map((source) => source.organisation),
		);
		confidence = organisations.size >= 2 ? "corroborated" : "single";
	}

	return { confidence, failures, contradictions, staleCitations };
}

export async function verifyAtlasV2Report(
	input: VerifyAtlasV2ReportInput,
): Promise<AtlasV2VerificationResult> {
	const sourcesByNumber = new Map(
		input.index.sources.map((source) => [source.n, source]),
	);
	const totals: AtlasV2VerificationTotals = {
		corroborated: 0,
		single: 0,
		inferred: 0,
		cut: 0,
	};
	const allContradictions: AtlasV2Contradiction[] = [];
	const staleCitations = new Set<number>();
	const citedSourceNumbers = new Set<number>();
	const verifiedSections: AtlasV2VerifiedSection[] = [];
	let entailmentCallCount = 0;
	const onEntailmentCall = () => {
		entailmentCallCount += 1;
	};

	for (const section of input.sections) {
		const calculationValues = await runSectionCalculations(
			section,
			input.runCalculation,
		);

		const verdicts = await Promise.all(
			section.paragraphs.map((paragraph) =>
				Promise.all(
					paragraph.sentences.map((sentence) =>
						verifySentence({
							sentence,
							section,
							sourcesByNumber,
							allSources: input.index.sources,
							staleMonths: input.staleMonths,
							now: input.now,
							checkEntailment: input.checkEntailment,
							calculationValues,
							onEntailmentCall,
						}),
					),
				),
			),
		);

		// (d) one rewrite pass, with the exact mismatch, then cut.
		const failed = verdicts.flatMap((paragraph, paragraphIndex) =>
			paragraph.flatMap((verdict, sentenceIndex) =>
				verdict.failures.length > 0
					? [
							{
								paragraphIndex,
								sentenceIndex,
								text: section.paragraphs[paragraphIndex].sentences[
									sentenceIndex
								].text,
								citations:
									section.paragraphs[paragraphIndex].sentences[sentenceIndex]
										.citations,
								reasons: verdict.failures.map((failure) => failure.detail),
							},
						]
					: [],
			),
		);

		let rewrittenVerdicts: Map<string, SentenceVerdict> | null = null;
		let rewrittenSentences: Map<string, AtlasV2WrittenSentence> | null = null;
		if (failed.length > 0 && input.rewriteSection) {
			const rewrite = await input.rewriteSection({ section, failed });
			if (rewrite) {
				rewrittenVerdicts = new Map();
				rewrittenSentences = new Map();
				const rewriteCalculations = await runSectionCalculations(
					rewrite,
					input.runCalculation,
				);
				for (const [
					paragraphIndex,
					paragraph,
				] of rewrite.paragraphs.entries()) {
					for (const [
						sentenceIndex,
						sentence,
					] of paragraph.sentences.entries()) {
						const key = `${paragraphIndex}:${sentenceIndex}`;
						rewrittenSentences.set(key, sentence);
						rewrittenVerdicts.set(
							key,
							await verifySentence({
								sentence,
								section: rewrite,
								sourcesByNumber,
								allSources: input.index.sources,
								staleMonths: input.staleMonths,
								now: input.now,
								checkEntailment: input.checkEntailment,
								calculationValues: rewriteCalculations,
								onEntailmentCall,
							}),
						);
					}
				}
			}
		}

		const paragraphs: AtlasV2VerifiedSentence[][] = [];
		for (const [paragraphIndex, paragraph] of section.paragraphs.entries()) {
			const keptSentences: AtlasV2VerifiedSentence[] = [];
			for (const [sentenceIndex, sentence] of paragraph.sentences.entries()) {
				const verdict = verdicts[paragraphIndex][sentenceIndex];
				const key = `${paragraphIndex}:${sentenceIndex}`;
				let finalSentence = sentence;
				let finalVerdict = verdict;
				let rewritten = false;
				if (verdict.failures.length > 0) {
					const replacementVerdict = rewrittenVerdicts?.get(key);
					const replacementSentence = rewrittenSentences?.get(key);
					if (
						replacementVerdict &&
						replacementSentence &&
						replacementVerdict.failures.length === 0
					) {
						finalSentence = replacementSentence;
						finalVerdict = replacementVerdict;
						rewritten = true;
					} else {
						totals.cut += 1;
						// A cut sentence still leaves the disagreement standing, so its
						// contradictions reach Limitations even though its prose does not.
						allContradictions.push(...verdict.contradictions);
						continue;
					}
				}
				for (const citation of finalSentence.citations) {
					if (sourcesByNumber.has(citation)) citedSourceNumbers.add(citation);
				}
				for (const stale of finalVerdict.staleCitations) {
					staleCitations.add(stale);
				}
				allContradictions.push(...finalVerdict.contradictions);
				totals[finalVerdict.confidence] += 1;
				keptSentences.push({
					sectionId: section.sectionId,
					text: finalSentence.text,
					citations: finalSentence.citations,
					confidence: finalVerdict.confidence,
					failures: [],
					kept: true,
					rewritten,
				});
			}
			if (keptSentences.length > 0) paragraphs.push(keptSentences);
		}

		verifiedSections.push({
			sectionId: section.sectionId,
			title: section.title,
			paragraphs,
		});
	}

	return {
		sections: verifiedSections,
		totals,
		contradictions: dedupeContradictions(allContradictions),
		staleCitations: [...staleCitations].sort((a, b) => a - b),
		citedSourceNumbers: [...citedSourceNumbers].sort((a, b) => a - b),
		entailmentCallCount,
	};
}

async function runSectionCalculations(
	section: AtlasV2WrittenSection,
	runCalculation?: AtlasV2CalculationRunner,
): Promise<Map<string, string | null>> {
	const values = new Map<string, string | null>();
	if (!runCalculation) return values;
	for (const calculation of section.calculations) {
		try {
			const result = await runCalculation({
				expression: calculation.expression,
			});
			values.set(calculation.id, result.ok ? result.value : null);
		} catch {
			values.set(calculation.id, null);
		}
	}
	return values;
}

function dedupeContradictions(
	contradictions: AtlasV2Contradiction[],
): AtlasV2Contradiction[] {
	const seen = new Set<string>();
	const unique: AtlasV2Contradiction[] = [];
	for (const contradiction of contradictions) {
		const key = `${contradiction.statedCitation}:${contradiction.statedValue}:${contradiction.competingCitation}:${contradiction.competingValue}`;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(contradiction);
	}
	return unique;
}

// ---------------------------------------------------------------------------
// The entailment prompt
// ---------------------------------------------------------------------------

export const ATLAS_V2_ENTAILMENT_SYSTEM =
	'Answer with one word, "yes" or "no", and nothing else. Say "yes" only when the source text states or directly implies the claim. Say "no" when the source is silent, says something different, or only touches an adjacent topic. Do not explain.';

export function buildAtlasV2EntailmentPrompt(input: {
	claim: string;
	sourceTitle: string;
	sourceText: string;
	maxSourceChars?: number;
}): string {
	return JSON.stringify({
		task: "entailment",
		claim: input.claim,
		source: {
			title: input.sourceTitle,
			text: input.sourceText.slice(0, input.maxSourceChars ?? 6000),
		},
	});
}

/** Reads the entailment answer. Anything ambiguous is null, not a failure. */
export function parseAtlasV2EntailmentAnswer(text: string): boolean | null {
	const normalized = text.trim().toLowerCase();
	if (/^(yes|igen|ja)\b/.test(normalized)) return true;
	if (/^(no|nem|nee)\b/.test(normalized)) return false;
	if (/\byes\b/.test(normalized) && !/\bno\b/.test(normalized)) return true;
	if (/\bno\b/.test(normalized) && !/\byes\b/.test(normalized)) return false;
	return null;
}
