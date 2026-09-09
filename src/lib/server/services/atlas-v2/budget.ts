// Atlas v2 length and source budgets (ADR 0062).
//
// The first live evaluation produced a 33,212-word in-depth report off 189
// sources, because nothing in the pipeline bounded either. Budgets here are
// enforced TWICE, deliberately:
//
//  1. as a per-section sentence cap handed to the writer, so the model aims at
//     the right size rather than being trimmed after the fact; and
//  2. as a deterministic post-cap over the verified sentences, so a model that
//     ignores the instruction cannot produce an over-length report anyway.
//
// The post-cap keeps cited sentences before uncited ones: when something has to
// go, prose without a source is what goes.

import type { AtlasProfile } from "../atlas/types";
import type { AtlasV2VerifiedSection, AtlasV2VerifiedSentence } from "./types";

export interface AtlasV2Budget {
	/** Target floor for the whole report; reported, never padded to. */
	minWords: number;
	/** Hard ceiling for the whole report, summary included. */
	maxWords: number;
	/**
	 * Words held back from `maxWords` for the executive summary and the
	 * Limitations list, so the section body plus chrome lands inside the budget.
	 */
	chromeReserveWords: number;
	minSections: number;
	maxSections: number;
	/** Cap on sources carried into the write phase (see capAtlasV2Index). */
	maxIndexedSources: number;
	/** `readPages` per research question. */
	readPages: number;
	/** Sentence cap for one section, handed to the writer and enforced on parse. */
	maxSentencesPerSection: number;
	maxParagraphsPerSection: number;
}

export const ATLAS_V2_BUDGETS: Record<AtlasProfile, AtlasV2Budget> = {
	overview: {
		minWords: 700,
		maxWords: 1100,
		chromeReserveWords: 150,
		minSections: 4,
		maxSections: 6,
		maxIndexedSources: 20,
		readPages: 2,
		maxSentencesPerSection: 9,
		maxParagraphsPerSection: 3,
	},
	"in-depth": {
		minWords: 1800,
		maxWords: 2800,
		chromeReserveWords: 200,
		minSections: 5,
		maxSections: 8,
		maxIndexedSources: 40,
		readPages: 3,
		maxSentencesPerSection: 17,
		maxParagraphsPerSection: 4,
	},
	exhaustive: {
		minWords: 3500,
		maxWords: 5500,
		chromeReserveWords: 260,
		minSections: 6,
		maxSections: 10,
		maxIndexedSources: 80,
		readPages: 4,
		maxSentencesPerSection: 28,
		maxParagraphsPerSection: 6,
	},
};

/** Words the section bodies may use once the chrome reserve is subtracted. */
export function bodyWordBudget(budget: AtlasV2Budget): number {
	return Math.max(200, budget.maxWords - budget.chromeReserveWords);
}

export function countWords(text: string): number {
	return text.split(/\s+/).filter(Boolean).length;
}

export interface AtlasV2BudgetCapResult {
	sections: AtlasV2VerifiedSection[];
	/** Sentences dropped purely for length, not for verification failure. */
	droppedSentenceCount: number;
	/** Words kept, after the cap. */
	wordCount: number;
}

/**
 * Drops trailing sentences until the section bodies fit `maxWords`.
 *
 * Selection order is: the lead sentence of every section (so no section
 * collapses and the outline survives), then cited sentences in reading order,
 * then uncited ones. Everything not selected is dropped, and the kept
 * sentences stay in their original order — the cap never reshuffles prose.
 */
export function capAtlasV2SectionsToWordBudget(input: {
	sections: AtlasV2VerifiedSection[];
	maxWords: number;
}): AtlasV2BudgetCapResult {
	const keys = new Map<AtlasV2VerifiedSentence, string>();
	const flat: Array<{
		sentence: AtlasV2VerifiedSentence;
		key: string;
		words: number;
		isLead: boolean;
		isCited: boolean;
	}> = [];
	for (const [sectionIndex, section] of input.sections.entries()) {
		let seenInSection = 0;
		for (const [paragraphIndex, paragraph] of section.paragraphs.entries()) {
			for (const [sentenceIndex, sentence] of paragraph.entries()) {
				const key = `${sectionIndex}:${paragraphIndex}:${sentenceIndex}`;
				keys.set(sentence, key);
				flat.push({
					sentence,
					key,
					words: countWords(sentence.text),
					isLead: seenInSection === 0,
					isCited: sentence.citations.length > 0,
				});
				seenInSection += 1;
			}
		}
	}

	const total = flat.reduce((sum, entry) => sum + entry.words, 0);
	if (total <= input.maxWords) {
		return {
			sections: input.sections,
			droppedSentenceCount: 0,
			wordCount: total,
		};
	}

	const kept = new Set<string>();
	let used = 0;
	const take = (entry: (typeof flat)[number]): void => {
		if (kept.has(entry.key)) return;
		if (used + entry.words > input.maxWords && used > 0) return;
		kept.add(entry.key);
		used += entry.words;
	};
	for (const entry of flat) {
		if (entry.isLead) take(entry);
	}
	for (const entry of flat) {
		if (entry.isCited) take(entry);
	}
	for (const entry of flat) {
		take(entry);
	}

	const sections = input.sections.map((section) => ({
		...section,
		paragraphs: section.paragraphs
			.map((paragraph) =>
				paragraph.filter((sentence) => kept.has(keys.get(sentence) ?? "")),
			)
			.filter((paragraph) => paragraph.length > 0),
	}));
	return {
		sections,
		droppedSentenceCount: flat.length - kept.size,
		wordCount: used,
	};
}

/** Citation numbers the kept sentences still cite, after a cap. */
export function citedNumbersInSections(
	sections: readonly AtlasV2VerifiedSection[],
): number[] {
	const cited = new Set<number>();
	for (const section of sections) {
		for (const paragraph of section.paragraphs) {
			for (const sentence of paragraph) {
				for (const citation of sentence.citations) cited.add(citation);
			}
		}
	}
	return [...cited].sort((left, right) => left - right);
}
