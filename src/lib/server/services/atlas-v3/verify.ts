// Atlas v3 stage 9a: verification (ADR 0063).
//
// v2's figure-level checking is kept wholesale — `number-match.ts` already
// knows `8 GW` from `8,000 MW` from `8 gigawatts`, and already knows that a
// year, a version token and an ordinal are not quantities to hunt for. What
// changes is what a failure DOES.
//
// v2 had two outcomes: rewrite once, then cut. The reader was then told "five
// sentences were removed because no cited source supported them" and never told
// what was lost. v3 adds a third, `needs_evidence`, which hands the claim to the
// critic's targeted research budget; `cut` is what happens when that also fails.
//
// Verification here is deterministic. The entailment model call v2 spends on
// non-numeric claims is not needed: a v3 sentence cites QUOTES, not pages, and a
// quote is 400 characters the read stage already chose for this goal — the
// figure check over that span is a stronger test than an entailment judgement
// over a 12,000-character page excerpt.

import {
	extractFigures,
	figureAppearsInText,
	isCheckableFigure,
} from "../atlas-v2/number-match";
import { atlasV3CorroboratingPublishersFor } from "./evidence-bank";
import type {
	AtlasV3AnswerTable,
	AtlasV3EvidenceBank,
	AtlasV3Sentence,
	AtlasV3VerificationResult,
	AtlasV3VerificationTotals,
	AtlasV3VerifiedSection,
	AtlasV3VerifiedSentence,
	AtlasV3WrittenSection,
} from "./types";

export interface VerifyAtlasV3ReportInput {
	sections: AtlasV3WrittenSection[];
	bank: AtlasV3EvidenceBank;
	answerTable: AtlasV3AnswerTable | null;
	staleMonths: number;
	now: Date;
	/**
	 * The LAST pass. A sentence that still cannot be supported is cut here;
	 * before it, it is handed to the critic as `needs_evidence`.
	 */
	finalPass?: boolean;
}

export function verifyAtlasV3Report(
	input: VerifyAtlasV3ReportInput,
): AtlasV3VerificationResult {
	const quotesById = new Map(
		input.bank.quotes.map((quote) => [quote.id, quote]),
	);
	const sourcesById = new Map(
		input.bank.sources.map((source) => [source.id, source]),
	);
	const derivedById = new Map(
		(input.answerTable?.derived ?? []).map((entry) => [entry.id, entry]),
	);
	const totals: AtlasV3VerificationTotals = {
		corroborated: 0,
		single: 0,
		inferred: 0,
		repeated: 0,
		cut: 0,
		needsEvidence: 0,
	};
	const citedEvidenceIds: string[] = [];
	const needsEvidence: AtlasV3VerificationResult["needsEvidence"] = [];
	const staleSourceIds = new Set<string>();

	const sections: AtlasV3VerifiedSection[] = input.sections.map((section) => ({
		nodeId: section.nodeId,
		title: section.title,
		table: section.table,
		paragraphs: section.paragraphs
			.map((paragraph) =>
				paragraph
					.map((sentence) => {
						const verified = verifyAtlasV3Sentence({
							sentence,
							quotesById,
							derivedById,
							finalPass: input.finalPass === true,
						});
						if (verified.outcome === "cut") {
							totals.cut += 1;
							return verified;
						}
						if (verified.outcome === "needs_evidence") {
							totals.needsEvidence += 1;
							needsEvidence.push({
								nodeId: section.nodeId,
								text: sentence.text,
								query: atlasV3EvidenceQueryFor(sentence, section.title),
							});
						}
						// Corroboration is a property of the FACT, not of how many ids
						// the writer happened to attach to the sentence.
						const publishers = atlasV3CorroboratingPublishersFor(
							input.bank,
							sentence.evidenceIds,
						);
						verified.confidence =
							publishers.length >= 2
								? "corroborated"
								: sentence.evidenceIds.length > 0
									? "single"
									: "inferred";
						totals[verified.confidence] += 1;
						for (const id of sentence.evidenceIds) {
							if (!citedEvidenceIds.includes(id)) citedEvidenceIds.push(id);
							const quote = quotesById.get(id);
							const source = quote
								? sourcesById.get(quote.sourceId)
								: undefined;
							if (
								source &&
								isAtlasV3StaleSource(source.date, input.now, input.staleMonths)
							) {
								staleSourceIds.add(source.id);
							}
						}
						return verified;
					})
					.filter((sentence) => sentence.outcome !== "cut"),
			)
			.filter((paragraph) => paragraph.length > 0),
	}));

	return {
		sections,
		totals,
		citedEvidenceIds,
		needsEvidence,
		staleSourceIds: [...staleSourceIds],
	};
}

export function verifyAtlasV3Sentence(input: {
	sentence: AtlasV3Sentence;
	quotesById: Map<string, { id: string; text: string }>;
	derivedById: Map<string, { id: string; value: string | null }>;
	finalPass: boolean;
}): AtlasV3VerifiedSentence {
	const { sentence } = input;
	const base: AtlasV3VerifiedSentence = {
		text: sentence.text,
		evidenceIds: sentence.evidenceIds,
		kind: sentence.kind,
		confidence: "inferred",
		outcome: "kept",
		failures: [],
	};
	const figures = extractFigures(sentence.text).filter(isCheckableFigure);
	if (figures.length === 0) return base;

	// A computed figure is supported by the sandbox's own answer, not by a quote:
	// this is the rule that replaces v2's "an inferred sentence may carry no
	// figure", which is what made every synthesis sentence hollow.
	const derived = sentence.calcId
		? input.derivedById.get(sentence.calcId)
		: undefined;
	const haystack = [
		...sentence.evidenceIds.map((id) => input.quotesById.get(id)?.text ?? ""),
		derived?.value ?? "",
	]
		.filter(Boolean)
		.join("\n");

	const unsupported = figures.filter(
		(figure) => !figureAppearsInText(figure, haystack),
	);
	if (unsupported.length === 0) return base;

	const failures = unsupported.map((figure) =>
		sentence.evidenceIds.length === 0 && !derived
			? `"${figure.text}" is stated with no evidence behind it`
			: `"${figure.text}" does not appear in any quote this sentence cites`,
	);
	// Fetch better evidence FIRST, delete last. Only the final pass cuts.
	return {
		...base,
		outcome: input.finalPass ? "cut" : "needs_evidence",
		failures,
	};
}

/** The targeted query a failed sentence hands to the critic's research. */
export function atlasV3EvidenceQueryFor(
	sentence: AtlasV3Sentence,
	sectionTitle: string,
): string {
	const figure = extractFigures(sentence.text).filter(isCheckableFigure)[0];
	return [figure?.text ?? "", sectionTitle]
		.filter(Boolean)
		.join(" ")
		.slice(0, 200);
}

export function isAtlasV3StaleSource(
	date: string | null,
	now: Date,
	staleMonths: number,
): boolean {
	if (!date) return false;
	const published = new Date(date);
	if (Number.isNaN(published.getTime())) return false;
	const months =
		(now.getFullYear() - published.getFullYear()) * 12 +
		(now.getMonth() - published.getMonth());
	return months > staleMonths;
}

/**
 * What an unsupported cell is replaced by, in either report language. A cell
 * whose text STARTS with one of these is already an admission that the figure
 * was not published — "not published (July 2026 range $1,099.99–$1,599.00)" —
 * and the honest repair is to keep the admission and drop the figures, not to
 * report the figures as unsupported.
 */
export const ATLAS_V3_TABLE_PLACEHOLDERS = [
	"not published",
	"nincs közzétéve",
] as const;

export function isAtlasV3TablePlaceholder(text: string): boolean {
	const normalized = text.trim().toLowerCase();
	return ATLAS_V3_TABLE_PLACEHOLDERS.some((placeholder) =>
		normalized.startsWith(placeholder),
	);
}

export interface AtlasV3TableFailure {
	column: string;
	/** The column's own label, for a Limitations line a reader can follow. */
	columnLabel: string;
	/** The row's label-column text. */
	rowLabel: string;
	text: string;
	detail: string;
	/**
	 * `unsupported` — a figure no cited quote states, or a factual cell with no
	 * evidence at all. `placeholder` — the cell already says "not published" and
	 * only its trailing figures have to go; no Limitations line is owed.
	 */
	kind: "unsupported" | "placeholder";
}

/**
 * Cells the table may not keep. The table is verified with the same rule as the
 * prose, because a table cell is the easiest thing in the report to get wrong
 * and the easiest to check.
 *
 * Two rules beyond v2's figure check, both from the staging run:
 *
 *  - a cell that already SAYS "not published" but then lists figures is reduced
 *    to the placeholder, with no Limitations line; and
 *  - a non-numeric factual cell with no evidence at all ("Soldered RAM",
 *    "SSD (replaceable)") is unsupported too. The figure check never saw those,
 *    so they shipped uncited.
 */
export function verifyAtlasV3AnswerTable(input: {
	table: AtlasV3AnswerTable | null;
	bank: AtlasV3EvidenceBank;
}): AtlasV3TableFailure[] {
	if (!input.table) return [];
	const quotesById = new Map(
		input.bank.quotes.map((quote) => [quote.id, quote]),
	);
	const labelKey = input.table.columns[0]?.key ?? "";
	const failures: AtlasV3TableFailure[] = [];
	for (const row of input.table.rows) {
		const rowLabel = (row[labelKey]?.text ?? "").trim();
		for (const column of input.table.columns.slice(1)) {
			const cell = row[column.key];
			if (!cell?.text) continue;
			const base = {
				column: column.key,
				columnLabel: column.label || column.key,
				rowLabel,
				text: cell.text,
			};
			const figures = extractFigures(cell.text).filter(isCheckableFigure);
			if (isAtlasV3TablePlaceholder(cell.text)) {
				if (figures.length > 0) {
					failures.push({
						...base,
						detail: "the cell says the figure is not published",
						kind: "placeholder",
					});
				}
				continue;
			}
			if (cell.evidenceIds.length === 0) {
				// Non-numeric or numeric alike: a cell outside the label column that
				// nothing backs is a claim with no source.
				failures.push({
					...base,
					detail:
						figures.length > 0
							? `"${figures[0].text}" is stated with no evidence behind it`
							: "stated with no evidence behind it",
					kind: "unsupported",
				});
				continue;
			}
			if (figures.length === 0) continue;
			const haystack = cell.evidenceIds
				.map((id) => quotesById.get(id)?.text ?? "")
				.filter(Boolean)
				.join("\n");
			for (const figure of figures) {
				if (figureAppearsInText(figure, haystack)) continue;
				failures.push({
					...base,
					detail: haystack
						? `"${figure.text}" does not appear in the quotes this cell cites`
						: `"${figure.text}" is stated with no evidence behind it`,
					kind: "unsupported",
				});
			}
		}
	}
	return failures;
}

/** Drops the cells verification could not support, keeping the table honest. */
export function pruneAtlasV3AnswerTable(input: {
	table: AtlasV3AnswerTable | null;
	failures: ReadonlyArray<{ column: string; text: string }>;
	/** What an unsupported cell says instead. */
	placeholder: string;
}): AtlasV3AnswerTable | null {
	if (!input.table || input.failures.length === 0) return input.table;
	const failed = new Set(
		input.failures.map((entry) => `${entry.column}::${entry.text}`),
	);
	return {
		...input.table,
		rows: input.table.rows.map((row) => {
			const next = { ...row };
			for (const column of input.table?.columns ?? []) {
				const cell = next[column.key];
				if (!cell) continue;
				if (!failed.has(`${column.key}::${cell.text}`)) continue;
				next[column.key] = { text: input.placeholder, evidenceIds: [] };
			}
			return next;
		}),
	};
}

/** Every kept sentence, flattened. The critic and the harness both want this. */
export function atlasV3KeptSentences(
	sections: readonly AtlasV3VerifiedSection[],
): AtlasV3VerifiedSentence[] {
	return sections.flatMap((section) => section.paragraphs.flat());
}

export function atlasV3WordCount(
	sections: readonly AtlasV3VerifiedSection[],
	verdict: readonly AtlasV3VerifiedSentence[] = [],
): number {
	return [...atlasV3KeptSentences(sections), ...verdict].reduce(
		(total, sentence) =>
			total + sentence.text.split(/\s+/).filter(Boolean).length,
		0,
	);
}

/**
 * The word cap, applied to VERIFIED sentences. Only ever trims: a body inside
 * the bound passes through untouched, and cited sentences outlive uncited ones
 * when something has to go.
 */
export function capAtlasV3ToWordBudget(input: {
	sections: AtlasV3VerifiedSection[];
	maxWords: number;
}): { sections: AtlasV3VerifiedSection[]; droppedSentenceCount: number } {
	if (atlasV3WordCount(input.sections) <= input.maxWords) {
		return { sections: input.sections, droppedSentenceCount: 0 };
	}
	// Rank every sentence: a section's FIRST sentence is never dropped (it
	// carries the section's claim), then cited sentences, then the rest.
	interface Ranked {
		sectionIndex: number;
		paragraphIndex: number;
		sentenceIndex: number;
		words: number;
		rank: number;
	}
	const ranked: Ranked[] = [];
	input.sections.forEach((section, sectionIndex) => {
		section.paragraphs.forEach((paragraph, paragraphIndex) => {
			paragraph.forEach((sentence, sentenceIndex) => {
				const isLead = paragraphIndex === 0 && sentenceIndex === 0;
				ranked.push({
					sectionIndex,
					paragraphIndex,
					sentenceIndex,
					words: sentence.text.split(/\s+/).filter(Boolean).length,
					rank: isLead ? 0 : sentence.evidenceIds.length > 0 ? 1 : 2,
				});
			});
		});
	});
	let total = ranked.reduce((sum, entry) => sum + entry.words, 0);
	const dropped = new Set<string>();
	// Drop the worst-ranked, latest-first, until the body fits.
	for (const entry of [...ranked].sort(
		(left, right) =>
			right.rank - left.rank ||
			right.sectionIndex - left.sectionIndex ||
			right.paragraphIndex - left.paragraphIndex ||
			right.sentenceIndex - left.sentenceIndex,
	)) {
		if (total <= input.maxWords) break;
		if (entry.rank === 0) continue;
		dropped.add(
			`${entry.sectionIndex}:${entry.paragraphIndex}:${entry.sentenceIndex}`,
		);
		total -= entry.words;
	}
	const sections = input.sections.map((section, sectionIndex) => ({
		...section,
		paragraphs: section.paragraphs
			.map((paragraph, paragraphIndex) =>
				paragraph.filter(
					(_sentence, sentenceIndex) =>
						!dropped.has(`${sectionIndex}:${paragraphIndex}:${sentenceIndex}`),
				),
			)
			.filter((paragraph) => paragraph.length > 0),
	}));
	return { sections, droppedSentenceCount: dropped.size };
}
