// Atlas v2 novelty guard (ADR 0062).
//
// The second live evaluation produced reports whose sections restated one
// another: the energy report stated "65.1 GW in 2025, down 0.7% from 65.6 GW in
// 2024" in three of its three sections, and then reported itself as 377 words
// short of its band. Padding a report with the same fact three times is worse
// than a short report, so a repeat is DROPPED here rather than counted toward
// the length budget — and the writer is separately told what earlier sections
// already said (see the section lead pass in pipeline.ts), so the drop is the
// backstop rather than the mechanism.
//
// Two sentences are the same fact when their normalised text matches, or when
// the later sentence's quantities are all quantities an earlier sentence
// already stated AND the two sentences talk about the same things (measured as
// content-word overlap). The subset rule matters: the repeat is usually the
// shorter restatement, carrying a subset of the original's figures.

import { extractFigures, isCheckableFigure } from "./number-match";
import type { AtlasV2VerifiedSection, AtlasV2VerifiedSentence } from "./types";

/** Share of the shorter sentence's content words the two must share. */
const MIN_CONTENT_OVERLAP = 0.5;
/** Below this many content words a sentence is too short to judge. */
const MIN_CONTENT_WORDS = 3;

function normalisedText(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function contentWords(text: string): Set<string> {
	return new Set(
		normalisedText(text)
			.split(" ")
			.filter((word) => word.length > 3),
	);
}

/** The quantities a sentence states, as `value+unit` keys. */
export function figureKeys(text: string): Set<string> {
	const keys = new Set<string>();
	for (const figure of extractFigures(text)) {
		if (!isCheckableFigure(figure) || figure.value === null) continue;
		keys.add(`${figure.value}${figure.unit}`);
	}
	return keys;
}

function overlapShare(left: Set<string>, right: Set<string>): number {
	const smaller = left.size <= right.size ? left : right;
	if (smaller.size === 0) return 0;
	let shared = 0;
	for (const word of smaller) {
		if ((smaller === left ? right : left).has(word)) shared += 1;
	}
	return shared / smaller.size;
}

/**
 * True when `later` says nothing `earlier` did not already say. Order matters:
 * the earlier sentence is the one that is kept.
 */
export function isAtlasV2RepeatedFact(later: string, earlier: string): boolean {
	const laterText = normalisedText(later);
	const earlierText = normalisedText(earlier);
	if (!laterText || !earlierText) return false;
	if (laterText === earlierText) return true;

	const laterFigures = figureKeys(later);
	if (laterFigures.size === 0) return false;
	const earlierFigures = figureKeys(earlier);
	for (const key of laterFigures) {
		if (!earlierFigures.has(key)) return false;
	}

	const laterWords = contentWords(later);
	const earlierWords = contentWords(earlier);
	if (
		laterWords.size < MIN_CONTENT_WORDS ||
		earlierWords.size < MIN_CONTENT_WORDS
	) {
		return false;
	}
	return overlapShare(laterWords, earlierWords) >= MIN_CONTENT_OVERLAP;
}

export interface AtlasV2NoveltyResult {
	sections: AtlasV2VerifiedSection[];
	/** Sentences dropped as repeats of an earlier section's fact. */
	droppedSentenceCount: number;
}

/**
 * Drops every sentence that restates a fact an EARLIER SECTION already stated.
 * Repetition inside one section is left alone — that is the writer elaborating
 * on its own claim, and the section's own sentence budget already bounds it.
 *
 * A section never loses its every sentence: if all of them are repeats, the
 * first survives, so the outline the plan promised still stands.
 */
export function dropRepeatedAtlasV2Sentences(input: {
	sections: readonly AtlasV2VerifiedSection[];
}): AtlasV2NoveltyResult {
	const earlierSentences: string[] = [];
	let droppedSentenceCount = 0;
	const sections = input.sections.map((section) => {
		const sectionSentences: AtlasV2VerifiedSentence[] = [];
		const paragraphs = section.paragraphs.map((paragraph) =>
			paragraph.filter((sentence) => {
				const repeated = earlierSentences.some((earlier) =>
					isAtlasV2RepeatedFact(sentence.text, earlier),
				);
				if (repeated) return false;
				sectionSentences.push(sentence);
				return true;
			}),
		);
		const kept = paragraphs.reduce(
			(total, paragraph) => total + paragraph.length,
			0,
		);
		const sentencesInSection = section.paragraphs.reduce(
			(total, paragraph) => total + paragraph.length,
			0,
		);
		if (kept === 0 && sentencesInSection > 0) {
			// Everything in this section repeated an earlier one; keep its first
			// sentence so the section does not vanish from the outline.
			const first = section.paragraphs.find(
				(paragraph) => paragraph.length > 0,
			)?.[0];
			if (first) {
				droppedSentenceCount += sentencesInSection - 1;
				earlierSentences.push(...section.paragraphs.flat().map((s) => s.text));
				return {
					...section,
					paragraphs: [[first]],
				};
			}
		}
		droppedSentenceCount += sentencesInSection - kept;
		earlierSentences.push(...sectionSentences.map((sentence) => sentence.text));
		return {
			...section,
			paragraphs: paragraphs.filter((paragraph) => paragraph.length > 0),
		};
	});
	return { sections, droppedSentenceCount };
}
