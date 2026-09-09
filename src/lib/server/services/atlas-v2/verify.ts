// Atlas v2 stage 5: verification (ADR 0062).
//
// Deterministic first, model only where deterministic checking cannot reach.
// The order matters: a citation that does not resolve, a figure the source does
// not state, or a figure in a sentence claiming to be inferred are all decided
// without a model. Only a NON-numeric cited claim reaches the entailment check,
// and those are BATCHED — up to `entailmentBatchSize` claims per call — because
// one call per claim was the single largest cost in the first live evaluation.
//
// A failing sentence goes back to the writer ONCE with the exact mismatch. If
// it still fails, it is cut. Cutting is a real outcome: a v2 report can be
// shorter than a v1 report on the same query, and Limitations says so.
//
// Contradiction detection changed after the first live evaluation. It used to
// compare the sentence's figure against EVERY indexed source, which turned one
// energy report's Limitations into 26 lines of "sources disagree" — every GW
// figure in every source compared as if it were the same quantity. It now looks
// only at the sources the writer's own sentence cites, and only at figures
// sitting in a text window that shares keywords, entity and year with the
// figure's own context in the sentence.

import {
	ATLAS_V2_MAX_CITATIONS_PER_SENTENCE,
	ATLAS_V2_MAX_CONTRADICTION_LINES,
} from "./config";
import { sourceEvidenceText } from "./evidence-index";
import {
	competingFigures,
	type ExtractedFigure,
	extractFigures,
	figureAppearsInText,
	findUnsupportedFigures,
	isCheckableFigure,
} from "./number-match";
import { mapWithConcurrency } from "./research";
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
/** Window around the figure IN THE SENTENCE that names what it measures. */
const CLAIM_WINDOW_CHARS = 140;
const MIN_SHARED_CONTENT_WORDS = 2;
/** Context words the quantity phrase in Limitations may carry, in total. */
const QUANTITY_PHRASE_CONTEXT_WORDS = 6;
/** Of those, how many may sit before the figure. */
const QUANTITY_PHRASE_WORDS_BEFORE = 3;

// Re-exported so the verifier's own callers keep one import path for the cap;
// it lives in config.ts because the renderer enforces it too.
export { ATLAS_V2_MAX_CITATIONS_PER_SENTENCE };

export interface AtlasV2EntailmentRequest {
	claim: string;
	sourceNumber: number;
	sourceTitle: string;
	sourceText: string;
}

export type AtlasV2EntailmentCheck = (
	input: AtlasV2EntailmentRequest,
) => Promise<boolean | null>;

/**
 * Batched entailment: one call, many claims, an answer per claim in order.
 * Returning null (or an array of the wrong length) means "could not read the
 * answer", and the caller falls back to one call per claim.
 */
export type AtlasV2BatchEntailmentCheck = (
	inputs: AtlasV2EntailmentRequest[],
) => Promise<Array<boolean | null> | null>;

/** Batched entailment calls in flight at once; they are independent. */
export const ATLAS_V2_ENTAILMENT_BATCH_CONCURRENCY = 3;
/** Section rewrite calls in flight at once. */
export const ATLAS_V2_REWRITE_CONCURRENCY = 3;

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
	/** Preferred over `checkEntailment` when both are given. */
	checkEntailmentBatch?: AtlasV2BatchEntailmentCheck;
	/** Claims per batched call. Defaults to 10; 1 disables batching. */
	entailmentBatchSize?: number;
	/** Omitted when run_python is unavailable; calc sentences then go inferred. */
	runCalculation?: AtlasV2CalculationRunner;
	/** Omitted to skip the rewrite pass and cut on first failure. */
	rewriteSection?: AtlasV2SectionRewriter;
	/** Section rewrites in flight at once. Defaults to 3. */
	rewriteConcurrency?: number;
	/** Cap on the disagreements Limitations may report. Defaults to 3. */
	maxContradictions?: number;
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

function yearsIn(text: string): Set<string> {
	return new Set(
		[...text.matchAll(/\b(?:1[89]\d{2}|20\d{2}|21\d{2})\b/g)].map(
			(match) => match[0],
		),
	);
}

function textWindow(text: string, needle: string, radius: number): string {
	const index = text.indexOf(needle);
	if (index < 0) return text;
	return text.slice(
		Math.max(0, index - radius),
		index + needle.length + radius,
	);
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
	const figures = extractFigures(input.sentence).filter(isCheckableFigure);
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

/** The words and years around a figure, i.e. what the figure measures. */
function figureContext(
	text: string,
	figure: ExtractedFigure,
	radius: number,
): { words: Set<string>; years: Set<string> } {
	const window = textWindow(text, figure.text, radius);
	return { words: contentWords(window), years: yearsIn(window) };
}

/**
 * The quantity phrase for the Limitations line: the figure and a few words of
 * the context that says what it measures, cut on WORD boundaries.
 *
 * It used to be a character window, which produced disagreement lines quoting
 * half a sentence — `Sources disagree on "…put 2025 addit"` — in the second
 * evaluation. A phrase is what the reader needs; a cut sentence is noise.
 */
export function quantityPhrase(
	sentence: string,
	figure: ExtractedFigure,
): string {
	const collapsed = sentence.replace(/\s+/g, " ").trim();
	const needle = figure.text.replace(/\s+/g, " ").trim();
	const index = collapsed.indexOf(needle);
	if (index < 0) return needle;
	const before = collapsed
		.slice(0, index)
		.split(" ")
		.filter((word) => word.length > 0);
	const after = collapsed
		.slice(index + needle.length)
		.split(" ")
		.filter((word) => word.length > 0);
	const lead = before.slice(-QUANTITY_PHRASE_WORDS_BEFORE);
	const trail = after.slice(
		0,
		Math.max(0, QUANTITY_PHRASE_CONTEXT_WORDS - lead.length),
	);
	// A phrase must not end on a dangling article or a stray comma: "…for 2025, a"
	// reads as a cut sentence, which is the defect this replaced.
	while (
		trail.length > 0 &&
		trail[trail.length - 1].replace(/[^\p{L}\p{N}]/gu, "").length <= 2
	) {
		trail.pop();
	}
	return [...lead, needle, ...trail]
		.join(" ")
		.replace(/^[^\p{L}\p{N}]+/u, "")
		.replace(/[\s,;:.]+$/u, "")
		.trim();
}

/**
 * Disagreements the sentence hides. ONLY the sources the sentence itself cites
 * are examined — never the whole index — and a competing figure counts only
 * when it sits in a passage about the same thing: same unit (enforced by
 * `competingFigures`), at least two shared content words with the figure's own
 * context in the sentence, and no clash of years between the two contexts.
 *
 * That covers both cases worth reporting: a cited source whose text carries a
 * different value for the figure, and two sources cited in the same sentence
 * that disagree with each other.
 */
export function findContradictions(input: {
	sentence: string;
	citedSources: AtlasV2IndexedSource[];
}): AtlasV2Contradiction[] {
	const contradictions: AtlasV2Contradiction[] = [];
	const figures = extractFigures(input.sentence).filter(
		(figure) => isCheckableFigure(figure) && figure.unit !== "",
	);
	if (figures.length === 0 || input.citedSources.length === 0) {
		return contradictions;
	}

	for (const figure of figures) {
		const claimContext = figureContext(
			input.sentence,
			figure,
			CLAIM_WINDOW_CHARS,
		);
		const statedCitation =
			input.citedSources.find((source) =>
				figureAppearsInText(figure, sourceEvidenceText(source)),
			)?.n ?? input.citedSources[0].n;
		for (const source of input.citedSources) {
			if (source.n === statedCitation) continue;
			const text = sourceEvidenceText(source);
			// A source that also states our figure agrees; it cannot contradict.
			if (figureAppearsInText(figure, text)) continue;
			for (const competing of competingFigures(figure, text)) {
				const sourceContext = figureContext(
					text,
					competing,
					CONTRADICTION_WINDOW_CHARS,
				);
				if (
					sharedContentWordCount(claimContext.words, sourceContext.words) <
					MIN_SHARED_CONTENT_WORDS
				) {
					continue;
				}
				// A figure for another year is a different quantity, not a rival one.
				if (claimContext.years.size > 0 && sourceContext.years.size > 0) {
					const sharesYear = [...claimContext.years].some((year) =>
						sourceContext.years.has(year),
					);
					if (!sharesYear) continue;
				}
				contradictions.push({
					quantity: quantityPhrase(input.sentence, figure),
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

/**
 * Keeps at most `ATLAS_V2_MAX_CITATIONS_PER_SENTENCE` citations per sentence,
 * preferring the sources that actually state the sentence's figures so the
 * trim never turns a supported figure into an unsupported one. Order among
 * equals is the writer's own.
 */
export function trimSentenceCitations(input: {
	sentence: AtlasV2WrittenSentence;
	sourcesByNumber: Map<number, AtlasV2IndexedSource>;
	limit?: number;
}): number[] {
	const limit = input.limit ?? ATLAS_V2_MAX_CITATIONS_PER_SENTENCE;
	// Deduplicated first: a sentence citing the same source twice must render one
	// citation, and the cap must count it once.
	const unique = [...new Set(input.sentence.citations)];
	const citations =
		unique.length === input.sentence.citations.length
			? input.sentence.citations
			: unique;
	if (citations.length <= limit) return citations;
	const figures = extractFigures(input.sentence.text).filter(isCheckableFigure);
	const score = (citation: number): number => {
		const source = input.sourcesByNumber.get(citation);
		if (!source) return -1;
		if (figures.length === 0) return 0;
		const text = sourceEvidenceText(source);
		const stated = figures.filter((figure) =>
			figureAppearsInText(figure, text),
		).length;
		return stated;
	};
	return [...citations]
		.map((citation, position) => ({
			citation,
			position,
			rank: score(citation),
		}))
		.sort((left, right) =>
			left.rank === right.rank
				? left.position - right.position
				: right.rank - left.rank,
		)
		.slice(0, limit)
		.sort((left, right) => left.position - right.position)
		.map((entry) => entry.citation);
}

export function trimSectionCitations(
	sections: readonly AtlasV2WrittenSection[],
	sourcesByNumber: Map<number, AtlasV2IndexedSource>,
): AtlasV2WrittenSection[] {
	return sections.map((section) => ({
		...section,
		paragraphs: section.paragraphs.map((paragraph) => ({
			sentences: paragraph.sentences.map((sentence) => {
				const citations = trimSentenceCitations({ sentence, sourcesByNumber });
				return citations === sentence.citations
					? sentence
					: { ...sentence, citations };
			}),
		})),
	}));
}

interface SentenceVerdict {
	confidence: AtlasV2Confidence;
	failures: AtlasV2Failure[];
	contradictions: AtlasV2Contradiction[];
	staleCitations: number[];
	/** Set when a non-numeric cited claim still needs a model check. */
	entailmentRequest: AtlasV2EntailmentRequest | null;
}

/**
 * Everything deterministic about one sentence. The entailment check is NOT
 * performed here: the request is returned so the caller can batch every claim
 * in the report into a handful of calls.
 */
function verifySentence(input: {
	sentence: AtlasV2WrittenSentence;
	sourcesByNumber: Map<number, AtlasV2IndexedSource>;
	allSources: AtlasV2IndexedSource[];
	staleMonths: number;
	now: Date;
	entailmentAvailable: boolean;
	calculationValues: Map<string, string | null>;
}): SentenceVerdict {
	const failures: AtlasV2Failure[] = [];
	const { sentence } = input;
	const figures = extractFigures(sentence.text);
	const checkableFigures = figures.filter(isCheckableFigure);
	const hasFigure = checkableFigures.length > 0;

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
				detail: `an inferred sentence may not state a figure, but this one states "${checkableFigures[0].text}"`,
				citation: null,
			});
		}
		return {
			confidence: "inferred",
			failures,
			contradictions: [],
			staleCitations: [],
			entailmentRequest: null,
		};
	}

	// A factual sentence with a figure and no citation cannot be checked at all.
	if (citedSources.length === 0) {
		failures.push({
			code: hasFigure ? "uncited_figure" : "unresolved_citation",
			detail: hasFigure
				? `"${checkableFigures[0].text}" carries no citation; every figure must cite the source that states it`
				: "this sentence carries no citation and is not marked as inferred synthesis",
			citation: null,
		});
		return {
			confidence: "inferred",
			failures,
			contradictions: [],
			staleCitations: [],
			entailmentRequest: null,
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
				entailmentRequest: null,
			};
		}
	}

	// (b) every figure appears in at least ONE cited source.
	if (hasFigure && !sentence.calcId) {
		for (const figure of checkableFigures) {
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

	// (c) a non-numeric cited claim gets one yes/no entailment check, batched.
	const entailmentRequest =
		!hasFigure && input.entailmentAvailable && failures.length === 0
			? {
					claim: sentence.text,
					sourceNumber: citedSources[0].n,
					sourceTitle: citedSources[0].title,
					sourceText: sourceEvidenceText(citedSources[0]),
				}
			: null;

	// (f) contradictions must be stated, not hidden.
	const contradictions = findContradictions({
		sentence: sentence.text,
		citedSources,
	}).filter(
		(contradiction) => !statesBothFigures(sentence.text, contradiction),
	);
	for (const contradiction of contradictions) {
		failures.push({
			code: "contradiction_unstated",
			detail: `source [${contradiction.competingCitation}] says ${contradiction.competingValue} where this sentence says ${contradiction.statedValue}; state both figures and cite both sources`,
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

	return {
		confidence,
		failures,
		contradictions,
		staleCitations,
		entailmentRequest,
	};
}

interface EntailmentOutcome {
	answers: Array<boolean | null>;
	claimCount: number;
	batchCount: number;
}

/**
 * Resolves every collected claim. Batched when a batch checker is given, with
 * a per-claim fallback whenever a batch answer does not parse, so a model that
 * mangles a JSON array degrades in cost rather than in correctness.
 */
async function resolveEntailments(input: {
	requests: AtlasV2EntailmentRequest[];
	checkEntailment?: AtlasV2EntailmentCheck;
	checkEntailmentBatch?: AtlasV2BatchEntailmentCheck;
	batchSize: number;
	batchConcurrency?: number;
}): Promise<EntailmentOutcome> {
	const answers: Array<boolean | null> = [];
	let batchCount = 0;
	if (input.requests.length === 0) {
		return { answers, claimCount: 0, batchCount };
	}
	const runOneByOne = async (
		requests: AtlasV2EntailmentRequest[],
	): Promise<Array<boolean | null>> => {
		const results: Array<boolean | null> = [];
		for (const request of requests) {
			results.push(
				input.checkEntailment ? await input.checkEntailment(request) : null,
			);
		}
		return results;
	};

	if (!input.checkEntailmentBatch || input.batchSize <= 1) {
		return {
			answers: await runOneByOne(input.requests),
			claimCount: input.requests.length,
			batchCount: 0,
		};
	}

	const chunks: AtlasV2EntailmentRequest[][] = [];
	for (let start = 0; start < input.requests.length; start += input.batchSize) {
		chunks.push(input.requests.slice(start, start + input.batchSize));
	}
	batchCount = chunks.length;
	// The batches are independent, so they go out together. Running them one
	// after another made verification the second-slowest phase in the second
	// evaluation (up to 249s on one report) for no gain in correctness.
	const perChunk = await mapWithConcurrency(
		chunks,
		Math.max(
			1,
			input.batchConcurrency ?? ATLAS_V2_ENTAILMENT_BATCH_CONCURRENCY,
		),
		async (chunk) => {
			let chunkAnswers: Array<boolean | null> | null = null;
			try {
				chunkAnswers = (await input.checkEntailmentBatch?.(chunk)) ?? null;
			} catch {
				chunkAnswers = null;
			}
			return chunkAnswers && chunkAnswers.length === chunk.length
				? chunkAnswers
				: await runOneByOne(chunk);
		},
	);
	for (const chunkAnswers of perChunk) answers.push(...chunkAnswers);
	return { answers, claimCount: input.requests.length, batchCount };
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

interface DeterministicPass {
	/** Per section, per paragraph, per sentence. */
	verdicts: SentenceVerdict[][][];
	requests: Array<{
		request: AtlasV2EntailmentRequest;
		sectionIndex: number;
		paragraphIndex: number;
		sentenceIndex: number;
	}>;
}

function runDeterministicPass(input: {
	sections: readonly AtlasV2WrittenSection[];
	calculationValues: Array<Map<string, string | null>>;
	sourcesByNumber: Map<number, AtlasV2IndexedSource>;
	allSources: AtlasV2IndexedSource[];
	staleMonths: number;
	now: Date;
	entailmentAvailable: boolean;
}): DeterministicPass {
	const verdicts: SentenceVerdict[][][] = [];
	const requests: DeterministicPass["requests"] = [];
	for (const [sectionIndex, section] of input.sections.entries()) {
		const sectionVerdicts: SentenceVerdict[][] = [];
		for (const [paragraphIndex, paragraph] of section.paragraphs.entries()) {
			const paragraphVerdicts: SentenceVerdict[] = [];
			for (const [sentenceIndex, sentence] of paragraph.sentences.entries()) {
				const verdict = verifySentence({
					sentence,
					sourcesByNumber: input.sourcesByNumber,
					allSources: input.allSources,
					staleMonths: input.staleMonths,
					now: input.now,
					entailmentAvailable: input.entailmentAvailable,
					calculationValues: input.calculationValues[sectionIndex] ?? new Map(),
				});
				if (verdict.entailmentRequest) {
					requests.push({
						request: verdict.entailmentRequest,
						sectionIndex,
						paragraphIndex,
						sentenceIndex,
					});
				}
				paragraphVerdicts.push(verdict);
			}
			sectionVerdicts.push(paragraphVerdicts);
		}
		verdicts.push(sectionVerdicts);
	}
	return { verdicts, requests };
}

export interface AtlasV2RewriteReplacements {
	sentences: Map<string, AtlasV2WrittenSentence>;
	verdicts: Map<string, SentenceVerdict>;
}

/**
 * Lines a rewrite up with the sentences it was asked to fix.
 *
 * The rewrite prompt asks for "the same paragraph structure", and a model that
 * obeys is matched by position. A model that instead returns ONLY the sentences
 * it rewrote — the common case, and what the prompt literally permits — used to
 * be discarded, because its paragraph 0 / sentence 0 did not match the failing
 * paragraph 2 / sentence 5, and the pipeline then cut a sentence the writer had
 * already repaired. When the structure does not line up and the rewrite is no
 * longer than the failed list, its sentences map onto the failed sentences in
 * order instead.
 */
export function mapRewriteToFailedSentences(input: {
	rewrite: AtlasV2WrittenSection;
	verdicts: SentenceVerdict[][];
	failed: Array<{ paragraphIndex: number; sentenceIndex: number }>;
}): AtlasV2RewriteReplacements {
	const sentences = new Map<string, AtlasV2WrittenSentence>();
	const verdicts = new Map<string, SentenceVerdict>();
	const flat: Array<{
		key: string;
		sentence: AtlasV2WrittenSentence;
		verdict: SentenceVerdict;
	}> = [];
	for (const [
		paragraphIndex,
		paragraph,
	] of input.rewrite.paragraphs.entries()) {
		for (const [sentenceIndex, sentence] of paragraph.sentences.entries()) {
			const verdict = input.verdicts[paragraphIndex]?.[sentenceIndex];
			if (!verdict) continue;
			flat.push({
				key: `${paragraphIndex}:${sentenceIndex}`,
				sentence,
				verdict,
			});
		}
	}
	const positional = new Set(flat.map((entry) => entry.key));
	const linesUp = input.failed.every((entry) =>
		positional.has(`${entry.paragraphIndex}:${entry.sentenceIndex}`),
	);
	if (linesUp) {
		for (const entry of flat) {
			sentences.set(entry.key, entry.sentence);
			verdicts.set(entry.key, entry.verdict);
		}
		return { sentences, verdicts };
	}
	if (flat.length === 0 || flat.length > input.failed.length) {
		// Neither reading is safe: a longer rewrite whose structure does not line
		// up could attach any sentence to any claim, and a wrong repair is worse
		// than a cut.
		return { sentences, verdicts };
	}
	for (const [position, entry] of flat.entries()) {
		const target = input.failed[position];
		const key = `${target.paragraphIndex}:${target.sentenceIndex}`;
		sentences.set(key, entry.sentence);
		verdicts.set(key, entry.verdict);
	}
	return { sentences, verdicts };
}

export async function verifyAtlasV2Report(
	input: VerifyAtlasV2ReportInput,
): Promise<AtlasV2VerificationResult> {
	const sourcesByNumber = new Map(
		input.index.sources.map((source) => [source.n, source]),
	);
	const sections = trimSectionCitations(input.sections, sourcesByNumber);
	const entailmentAvailable = Boolean(
		input.checkEntailment ?? input.checkEntailmentBatch,
	);
	const batchSize = Math.max(1, input.entailmentBatchSize ?? 10);
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

	const calculationValues: Array<Map<string, string | null>> = [];
	for (const section of sections) {
		calculationValues.push(
			await runSectionCalculations(section, input.runCalculation),
		);
	}

	const pass = runDeterministicPass({
		sections,
		calculationValues,
		sourcesByNumber,
		allSources: input.index.sources,
		staleMonths: input.staleMonths,
		now: input.now,
		entailmentAvailable,
	});
	const entailment = await resolveEntailments({
		requests: pass.requests.map((entry) => entry.request),
		checkEntailment: input.checkEntailment,
		checkEntailmentBatch: input.checkEntailmentBatch,
		batchSize,
	});
	let entailmentCallCount = entailment.claimCount;
	let entailmentBatchCount = entailment.batchCount;
	for (const [position, entry] of pass.requests.entries()) {
		if (entailment.answers[position] !== false) continue;
		pass.verdicts[entry.sectionIndex][entry.paragraphIndex][
			entry.sentenceIndex
		].failures.push({
			code: "entailment_failed",
			detail: `source [${entry.request.sourceNumber}] does not support this claim`,
			citation: entry.request.sourceNumber,
		});
	}

	// (d) one rewrite pass per failing section, with the exact mismatch, then
	// cut. The rewrites are independent of one another, so they go out together:
	// running one section's rewrite after another's put every failing section's
	// model call on the critical path.
	const failedBySection = sections.map((section, sectionIndex) =>
		pass.verdicts[sectionIndex].flatMap((paragraph, paragraphIndex) =>
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
		),
	);

	const rewrites = await mapWithConcurrency(
		sections,
		Math.max(1, input.rewriteConcurrency ?? ATLAS_V2_REWRITE_CONCURRENCY),
		async (section, sectionIndex) => {
			const failed = failedBySection[sectionIndex];
			if (failed.length === 0 || !input.rewriteSection) return null;
			const rewrite = await input.rewriteSection({ section, failed });
			if (!rewrite) return null;
			const [trimmedRewrite] = trimSectionCitations([rewrite], sourcesByNumber);
			const rewriteCalculations = await runSectionCalculations(
				trimmedRewrite,
				input.runCalculation,
			);
			const rewritePass = runDeterministicPass({
				sections: [trimmedRewrite],
				calculationValues: [rewriteCalculations],
				sourcesByNumber,
				allSources: input.index.sources,
				staleMonths: input.staleMonths,
				now: input.now,
				entailmentAvailable,
			});
			const rewriteEntailment = await resolveEntailments({
				requests: rewritePass.requests.map((entry) => entry.request),
				checkEntailment: input.checkEntailment,
				checkEntailmentBatch: input.checkEntailmentBatch,
				batchSize,
			});
			for (const [position, entry] of rewritePass.requests.entries()) {
				if (rewriteEntailment.answers[position] !== false) continue;
				rewritePass.verdicts[0][entry.paragraphIndex][
					entry.sentenceIndex
				].failures.push({
					code: "entailment_failed",
					detail: `source [${entry.request.sourceNumber}] does not support this claim`,
					citation: entry.request.sourceNumber,
				});
			}
			return {
				replacements: mapRewriteToFailedSentences({
					rewrite: trimmedRewrite,
					verdicts: rewritePass.verdicts[0],
					failed,
				}),
				claimCount: rewriteEntailment.claimCount,
				batchCount: rewriteEntailment.batchCount,
			};
		},
	);
	for (const rewrite of rewrites) {
		if (!rewrite) continue;
		entailmentCallCount += rewrite.claimCount;
		entailmentBatchCount += rewrite.batchCount;
	}

	for (const [sectionIndex, section] of sections.entries()) {
		const verdicts = pass.verdicts[sectionIndex];
		const replacements = rewrites[sectionIndex]?.replacements ?? null;
		const rewrittenSentences = replacements?.sentences ?? null;
		const rewrittenVerdicts = replacements?.verdicts ?? null;

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
		// Capped here rather than at render time, so the publication numbering
		// only ever carries sources the report actually names.
		contradictions: dedupeContradictions(allContradictions).slice(
			0,
			Math.max(0, input.maxContradictions ?? ATLAS_V2_MAX_CONTRADICTION_LINES),
		),
		staleCitations: [...staleCitations].sort((a, b) => a - b),
		citedSourceNumbers: [...citedSourceNumbers].sort((a, b) => a - b),
		entailmentCallCount,
		entailmentBatchCount,
	};
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
// Does the summary answer the question that was asked?
// ---------------------------------------------------------------------------

export interface AtlasV2CoreAnswerCheck {
	/** A kept summary sentence rests on the core question's own evidence. */
	present: boolean;
	/** That sentence also carries a figure, which is the stronger outcome. */
	citedFigure: boolean;
}

/**
 * The executive summary must answer the user's question, not open with a
 * tangent. `coreSourceNumbers` are the sources indexed against the core
 * question — the first plan question, which is the request verbatim — so a
 * summary that cites none of them is not answering it.
 */
export function checkAtlasV2CoreAnswer(input: {
	summary: AtlasV2VerifiedSection | null;
	coreSourceNumbers: readonly number[];
}): AtlasV2CoreAnswerCheck {
	const sentences = (input.summary?.paragraphs ?? []).flat();
	if (sentences.length === 0) return { present: false, citedFigure: false };
	const core = new Set(input.coreSourceNumbers);
	const onCore = sentences.filter((sentence) =>
		core.size === 0
			? sentence.citations.length > 0
			: sentence.citations.some((citation) => core.has(citation)),
	);
	return {
		present: onCore.length > 0,
		citedFigure: onCore.some((sentence) =>
			extractFigures(sentence.text).some(isCheckableFigure),
		),
	};
}

// ---------------------------------------------------------------------------
// The entailment prompts
// ---------------------------------------------------------------------------

export const ATLAS_V2_ENTAILMENT_SYSTEM =
	'Answer with one word, "yes" or "no", and nothing else. Say "yes" only when the source text states or directly implies the claim. Say "no" when the source is silent, says something different, or only touches an adjacent topic. Do not explain.';

export const ATLAS_V2_ENTAILMENT_BATCH_SYSTEM = [
	'You check several claims against their own source text. Return STRICT JSON only: an array of "yes"/"no" strings, no prose and no code fence.',
	'The array must have exactly one entry per numbered item, in the same order. Answer "yes" only when that item\'s source text states or directly implies that item\'s claim; "no" when the source is silent, says something different, or only touches an adjacent topic.',
	"Judge each item only against its own source. Do not explain and do not add any other field.",
].join("\n");

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

export function buildAtlasV2EntailmentBatchPrompt(input: {
	items: AtlasV2EntailmentRequest[];
	/** Per-item source budget; the batch shares one context window. */
	maxSourceChars?: number;
}): string {
	const perItem = input.maxSourceChars ?? 2400;
	return JSON.stringify({
		task: "entailment_batch",
		answerCount: input.items.length,
		items: input.items.map((item, index) => ({
			i: index + 1,
			claim: item.claim,
			source: {
				title: item.sourceTitle,
				text: item.sourceText.slice(0, perItem),
			},
		})),
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

/**
 * Reads a batched answer. Returns null — meaning "fall back to one call per
 * claim" — unless the array has exactly `expectedCount` readable entries.
 * Accepts the shapes a small model actually produces: bare strings, booleans,
 * or objects carrying the verdict under a recognisable key.
 */
export function parseAtlasV2EntailmentBatchAnswer(
	text: string,
	expectedCount: number,
): Array<boolean | null> | null {
	const parsed = readJsonArray(text);
	if (!parsed || parsed.length !== expectedCount) return null;
	return parsed.map((entry) => {
		if (typeof entry === "boolean") return entry;
		if (typeof entry === "string") return parseAtlasV2EntailmentAnswer(entry);
		if (entry && typeof entry === "object") {
			const record = entry as Record<string, unknown>;
			for (const key of [
				"answer",
				"entailed",
				"supported",
				"verdict",
				"value",
			]) {
				const value = record[key];
				if (typeof value === "boolean") return value;
				if (typeof value === "string") {
					return parseAtlasV2EntailmentAnswer(value);
				}
			}
		}
		return null;
	});
}

function readJsonArray(text: string): unknown[] | null {
	const trimmed = text
		.trim()
		.replace(/^```(?:json)?/i, "")
		.replace(/```$/, "");
	const start = trimmed.indexOf("[");
	const end = trimmed.lastIndexOf("]");
	if (start < 0 || end <= start) return null;
	try {
		const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
		return Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}
