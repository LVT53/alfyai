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
//
// The second evaluation reversed the original problem: every one of ten reports
// came in UNDER its band (219-464 words against 700-1,100), because the writer
// was handed a sentence CEILING and no target. The writer is now asked for the
// per-section word MIDPOINT of the band, with the sentence caps derived from
// that target rather than from the ceiling, and the post-cap only trims a body
// that is genuinely over the upper bound.

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
	/**
	 * Absolute sentence ceiling for one section. This is a GUARD, not the
	 * target: the number handed to the writer comes from
	 * `atlasV2SectionWriterBudget`, which derives it from the band's midpoint.
	 */
	maxSentencesPerSection: number;
	maxParagraphsPerSection: number;
}

/**
 * Words per sentence the writer actually produces, measured over the second
 * evaluation's ten reports (1,314 words / 60 sentences and similar). Used to
 * turn a word target into a sentence count.
 */
export const ATLAS_V2_AVERAGE_SENTENCE_WORDS = 20;

export const ATLAS_V2_BUDGETS: Record<AtlasProfile, AtlasV2Budget> = {
	overview: {
		minWords: 700,
		maxWords: 1100,
		chromeReserveWords: 150,
		minSections: 4,
		maxSections: 6,
		maxIndexedSources: 20,
		// One page per source on an overview: the second evaluation read two and
		// spent the extra fetch on evidence the 700-1,100 word band cannot carry.
		readPages: 1,
		maxSentencesPerSection: 14,
		maxParagraphsPerSection: 4,
	},
	"in-depth": {
		minWords: 1800,
		maxWords: 2800,
		chromeReserveWords: 200,
		minSections: 5,
		maxSections: 8,
		maxIndexedSources: 40,
		readPages: 3,
		maxSentencesPerSection: 24,
		maxParagraphsPerSection: 5,
	},
	exhaustive: {
		minWords: 3500,
		maxWords: 5500,
		chromeReserveWords: 260,
		minSections: 6,
		maxSections: 10,
		maxIndexedSources: 80,
		readPages: 4,
		maxSentencesPerSection: 36,
		maxParagraphsPerSection: 6,
	},
};

/** Words the section bodies may use once the chrome reserve is subtracted. */
export function bodyWordBudget(budget: AtlasV2Budget): number {
	return Math.max(200, budget.maxWords - budget.chromeReserveWords);
}

/**
 * What the section bodies should AIM at: the midpoint of the band, less the
 * chrome reserve. Aiming at the midpoint rather than the ceiling is what keeps
 * a report that runs a little short still inside the band, and aiming at
 * anything at all is what the second evaluation was missing.
 */
export function bodyWordTarget(budget: AtlasV2Budget): number {
	const midpoint = Math.round((budget.minWords + budget.maxWords) / 2);
	return Math.max(200, midpoint - budget.chromeReserveWords);
}

export interface AtlasV2SectionWriterBudget {
	/** Words this section should aim at; the number the writer is given. */
	targetWords: number;
	/** Sentences below which the section is too thin to hit the band. */
	minSentences: number;
	/** Sentences past which extra prose is discarded on parse. */
	maxSentences: number;
}

/**
 * The per-section budget handed to one writer call, derived from the band's
 * midpoint and the number of sections the plan actually produced — so a
 * 3-section overview is written to a 3-section budget rather than to a
 * 6-section one and then reported as short.
 */
export function atlasV2SectionWriterBudget(input: {
	budget: AtlasV2Budget;
	sectionCount: number;
}): AtlasV2SectionWriterBudget {
	const sections = Math.max(1, input.sectionCount);
	const share = Math.max(
		60,
		Math.round(bodyWordTarget(input.budget) / sections),
	);
	const shareSentences = Math.max(
		3,
		Math.round(share / ATLAS_V2_AVERAGE_SENTENCE_WORDS),
	);
	const maxSentences = Math.max(
		4,
		Math.min(
			input.budget.maxSentencesPerSection,
			Math.ceil(shareSentences * 1.3),
		),
	);
	// The word target may never exceed what the sentence cap can hold: asking for
	// words the parse step would then discard is how a budget lies to the writer.
	const targetWords = Math.min(
		share,
		maxSentences * ATLAS_V2_AVERAGE_SENTENCE_WORDS,
	);
	const targetSentences = Math.round(
		targetWords / ATLAS_V2_AVERAGE_SENTENCE_WORDS,
	);
	return {
		targetWords,
		minSentences: Math.max(3, Math.min(maxSentences, targetSentences - 2)),
		maxSentences,
	};
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
 * Drops sentences ONLY when the section bodies are over `maxWords`, which is
 * the body's upper bound. A report inside the bound is returned untouched, and
 * a report that is merely short is never touched at all.
 *
 * Removal order is the reverse of importance: uncited sentences from the end of
 * the report first, then cited ones from the end, and never a section's lead
 * (so no section collapses and the outline survives). Removing from the end
 * rather than selecting from the front is what stops the cap from discarding an
 * early cited sentence in favour of a later short one; the kept sentences stay
 * in their original order either way.
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

	const removable = flat.filter((entry) => !entry.isLead);
	const removalOrder = [
		...removable.filter((entry) => !entry.isCited).reverse(),
		...removable.filter((entry) => entry.isCited).reverse(),
	];
	const dropped = new Set<string>();
	let used = total;
	for (const entry of removalOrder) {
		if (used <= input.maxWords) break;
		dropped.add(entry.key);
		used -= entry.words;
	}

	const sections = input.sections.map((section) => ({
		...section,
		paragraphs: section.paragraphs
			.map((paragraph) =>
				paragraph.filter((sentence) => !dropped.has(keys.get(sentence) ?? "")),
			)
			.filter((paragraph) => paragraph.length > 0),
	}));
	return {
		sections,
		droppedSentenceCount: dropped.size,
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
