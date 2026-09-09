import { describe, expect, it } from "vitest";
import {
	ATLAS_V2_BUDGETS,
	atlasV2SectionWriterBudget,
	bodyWordBudget,
	bodyWordTarget,
	capAtlasV2SectionsToWordBudget,
	citedNumbersInSections,
	countWords,
} from "./budget";
import {
	ATLAS_V2_MAX_OUTPUT_TOKENS,
	atlasV2RunawayRetryMaxOutputTokens,
	atlasV2SectionMaxOutputTokens,
} from "./config";
import {
	buildAtlasV2EvidenceIndex,
	capAtlasV2EvidenceIndex,
} from "./evidence-index";
import type {
	AtlasV2RawSource,
	AtlasV2VerifiedSection,
	AtlasV2VerifiedSentence,
} from "./types";

function sentence(
	text: string,
	citations: number[] = [],
): AtlasV2VerifiedSentence {
	return {
		sectionId: "s1",
		text,
		citations,
		confidence: citations.length > 0 ? "single" : "inferred",
		failures: [],
		kept: true,
		rewritten: false,
	};
}

function section(
	sectionId: string,
	sentences: AtlasV2VerifiedSentence[],
): AtlasV2VerifiedSection {
	return {
		sectionId,
		title: sectionId,
		paragraphs: [sentences.map((entry) => ({ ...entry, sectionId }))],
	};
}

/** Ten words each, so the arithmetic in the assertions is obvious. */
const TEN = "one two three four five six seven eight nine ten";

describe("ATLAS_V2_BUDGETS", () => {
	it("gives each profile the band the evaluation settled on", () => {
		expect(ATLAS_V2_BUDGETS.overview).toMatchObject({
			minWords: 700,
			maxWords: 1100,
			minSections: 4,
			maxSections: 6,
			maxIndexedSources: 20,
			readPages: 1,
		});
		expect(ATLAS_V2_BUDGETS["in-depth"]).toMatchObject({
			minWords: 1800,
			maxWords: 2800,
			maxIndexedSources: 40,
			readPages: 3,
		});
		expect(ATLAS_V2_BUDGETS.exhaustive).toMatchObject({
			minWords: 3500,
			maxWords: 5500,
			maxIndexedSources: 80,
			readPages: 4,
		});
	});

	it("reserves words for the summary and Limitations", () => {
		for (const budget of Object.values(ATLAS_V2_BUDGETS)) {
			expect(bodyWordBudget(budget)).toBeLessThan(budget.maxWords);
		}
	});
});

describe("bodyWordTarget", () => {
	it("aims at the band's midpoint, not its ceiling", () => {
		// 700-1100 midpoint is 900; less the 150-word chrome reserve.
		expect(bodyWordTarget(ATLAS_V2_BUDGETS.overview)).toBe(750);
		expect(bodyWordTarget(ATLAS_V2_BUDGETS["in-depth"])).toBe(2100);
	});

	it("sits below the ceiling the post-cap enforces", () => {
		for (const budget of Object.values(ATLAS_V2_BUDGETS)) {
			expect(bodyWordTarget(budget)).toBeLessThan(bodyWordBudget(budget));
			expect(bodyWordTarget(budget)).toBeGreaterThan(0);
		}
	});
});

describe("atlasV2SectionWriterBudget", () => {
	it("splits the midpoint target over the sections the plan produced", () => {
		const three = atlasV2SectionWriterBudget({
			budget: ATLAS_V2_BUDGETS.overview,
			sectionCount: 3,
		});
		expect(three.targetWords).toBe(250);
		expect(three.minSentences).toBeLessThan(three.maxSentences);
		// Three sections at the target land inside the 700-1,100 band, which is
		// what the second evaluation's 219-464 word reports did not.
		expect(three.targetWords * 3).toBeGreaterThanOrEqual(
			ATLAS_V2_BUDGETS.overview.minWords - 100,
		);
	});

	it("asks a five-section in-depth plan for the whole band", () => {
		const five = atlasV2SectionWriterBudget({
			budget: ATLAS_V2_BUDGETS["in-depth"],
			sectionCount: 5,
		});
		expect(five.targetWords).toBe(420);
		expect(five.targetWords * 5).toBeGreaterThanOrEqual(
			ATLAS_V2_BUDGETS["in-depth"].minWords,
		);
		expect(five.maxSentences).toBeLessThanOrEqual(
			ATLAS_V2_BUDGETS["in-depth"].maxSentencesPerSection,
		);
	});

	it("never asks for more words than its own sentence cap can hold", () => {
		for (const budget of Object.values(ATLAS_V2_BUDGETS)) {
			for (const sectionCount of [1, 2, 3, 5, 8, 10]) {
				const section = atlasV2SectionWriterBudget({ budget, sectionCount });
				expect(section.maxSentences * 25).toBeGreaterThanOrEqual(
					section.targetWords,
				);
				expect(section.minSentences).toBeLessThanOrEqual(section.maxSentences);
				expect(section.minSentences).toBeGreaterThanOrEqual(3);
			}
		}
	});
});

describe("capAtlasV2SectionsToWordBudget", () => {
	it("leaves a report inside its budget untouched", () => {
		const sections = [section("s1", [sentence(TEN, [1]), sentence(TEN, [2])])];
		const result = capAtlasV2SectionsToWordBudget({ sections, maxWords: 100 });
		expect(result.sections).toBe(sections);
		expect(result.droppedSentenceCount).toBe(0);
		expect(result.wordCount).toBe(20);
	});

	it("does not trim a report that is merely SHORT", () => {
		const sections = [section("s1", [sentence(TEN, [1])])];
		const result = capAtlasV2SectionsToWordBudget({
			sections,
			maxWords: 950,
		});
		expect(result.sections).toBe(sections);
		expect(result.droppedSentenceCount).toBe(0);
	});

	it("drops uncited sentences before cited ones", () => {
		const sections = [
			section("s1", [
				sentence(`lead ${TEN}`, [1]),
				sentence(`uncited ${TEN}`),
				sentence(`cited ${TEN}`, [2]),
			]),
		];
		const result = capAtlasV2SectionsToWordBudget({ sections, maxWords: 23 });
		const kept = result.sections[0].paragraphs
			.flat()
			.map((entry) => entry.text.split(" ")[0]);
		expect(kept).toEqual(["lead", "cited"]);
		expect(result.droppedSentenceCount).toBe(1);
	});

	it("keeps each section's lead sentence, so no section disappears", () => {
		const sections = [
			section("s1", [sentence(`a ${TEN}`, [1]), sentence(`b ${TEN}`, [1])]),
			section("s2", [sentence(`c ${TEN}`, [2]), sentence(`d ${TEN}`, [2])]),
			section("s3", [sentence(`e ${TEN}`, [3])]),
		];
		const result = capAtlasV2SectionsToWordBudget({ sections, maxWords: 35 });
		expect(
			result.sections.map((entry) => entry.paragraphs.flat().length),
		).toEqual([1, 1, 1]);
		expect(result.droppedSentenceCount).toBe(2);
	});

	it("keeps the surviving sentences in their original order", () => {
		const sections = [
			section("s1", [
				sentence(`first ${TEN}`, [1]),
				sentence(`second ${TEN}`),
				sentence(`third ${TEN}`, [2]),
				sentence(`fourth ${TEN}`, [3]),
			]),
		];
		const result = capAtlasV2SectionsToWordBudget({ sections, maxWords: 34 });
		expect(
			result.sections[0].paragraphs
				.flat()
				.map((entry) => entry.text.split(" ")[0]),
		).toEqual(["first", "third", "fourth"]);
	});

	it("keeps an early cited sentence rather than a later short one", () => {
		// The old cap selected forward and skipped anything that did not fit, so a
		// long cited sentence could be dropped in favour of a short later one.
		const sections = [
			section("s1", [
				sentence(`lead ${TEN}`, [1]),
				sentence(`long ${TEN} ${TEN}`, [2]),
				sentence("short tail", [3]),
			]),
		];
		const result = capAtlasV2SectionsToWordBudget({ sections, maxWords: 32 });
		expect(
			result.sections[0].paragraphs
				.flat()
				.map((entry) => entry.text.split(" ")[0]),
		).toEqual(["lead", "long"]);
	});

	it("recomputes which sources the trimmed report still cites", () => {
		const sections = [
			section("s1", [
				sentence(`lead ${TEN}`, [1]),
				sentence(`tail ${TEN}`, [9]),
			]),
		];
		const result = capAtlasV2SectionsToWordBudget({ sections, maxWords: 12 });
		expect(citedNumbersInSections(result.sections)).toEqual([1]);
	});
});

describe("countWords", () => {
	it("counts whitespace-separated words", () => {
		expect(countWords("  one   two\nthree ")).toBe(3);
		expect(countWords("")).toBe(0);
	});
});

function raw(overrides: Partial<AtlasV2RawSource>): AtlasV2RawSource {
	return {
		questionId: "q1",
		round: 1,
		url: "https://example.com/a",
		title: "A report with a reasonably distinct title",
		snippets: ["Placeholder evidence text with enough prose to survive."],
		publishedAt: "2026-05-01",
		pageExcerpt: null,
		...overrides,
	};
}

describe("capAtlasV2EvidenceIndex", () => {
	const index = buildAtlasV2EvidenceIndex([
		...Array.from({ length: 6 }, (_, position) =>
			raw({
				questionId: "q1",
				url: `https://q1-${position}.example/a`,
				title: `Question one source ${position}`,
			}),
		),
		...Array.from({ length: 6 }, (_, position) =>
			raw({
				questionId: "q2",
				url: `https://q2-${position}.example/a`,
				title: `Question two source ${position}`,
			}),
		),
	]);

	it("leaves an index inside the cap alone", () => {
		const result = capAtlasV2EvidenceIndex({
			index,
			maxSources: 20,
			questionOrder: ["q1", "q2"],
		});
		expect(result.index).toBe(index);
		expect(result.droppedForBudget).toBe(0);
	});

	it("caps to the budget and keeps every question represented", () => {
		const result = capAtlasV2EvidenceIndex({
			index,
			maxSources: 4,
			questionOrder: ["q1", "q2"],
		});
		expect(result.index.sources).toHaveLength(4);
		expect(result.droppedForBudget).toBe(8);
		expect(result.index.byQuestion.q1).toHaveLength(2);
		expect(result.index.byQuestion.q2).toHaveLength(2);
	});

	it("renumbers 1..k so no citation can point into a gap", () => {
		const result = capAtlasV2EvidenceIndex({
			index,
			maxSources: 4,
			questionOrder: ["q1", "q2"],
		});
		expect(result.index.sources.map((source) => source.n)).toEqual([
			1, 2, 3, 4,
		]);
		expect(
			Object.values(result.index.byQuestion)
				.flat()
				.every((n) => n >= 1 && n <= 4),
		).toBe(true);
	});

	it("is deterministic, so a resumed job caps identically", () => {
		const first = capAtlasV2EvidenceIndex({
			index,
			maxSources: 5,
			questionOrder: ["q1", "q2"],
		});
		const second = capAtlasV2EvidenceIndex({
			index,
			maxSources: 5,
			questionOrder: ["q1", "q2"],
		});
		expect(first.index.sources.map((source) => source.canonicalUrl)).toEqual(
			second.index.sources.map((source) => source.canonicalUrl),
		);
	});
});

describe("atlasV2SectionMaxOutputTokens", () => {
	it("sizes the cap from the section's word target", () => {
		expect(atlasV2SectionMaxOutputTokens(600)).toBe(2_400);
	});

	it("floors a tiny section and ceilings a huge one", () => {
		// Below the floor a section cannot even hold its minimum sentences; above
		// the ceiling the writer is back in runaway territory.
		expect(atlasV2SectionMaxOutputTokens(60)).toBe(1_500);
		expect(atlasV2SectionMaxOutputTokens(4_000)).toBe(6_000);
		expect(atlasV2SectionMaxOutputTokens(0)).toBe(1_500);
	});

	it("keeps every profile's section cap far below the 16,000 that ran away", () => {
		for (const profile of ["overview", "in-depth", "exhaustive"] as const) {
			for (const sectionCount of [2, 4, 6, 10]) {
				const { targetWords } = atlasV2SectionWriterBudget({
					budget: ATLAS_V2_BUDGETS[profile],
					sectionCount,
				});
				expect(atlasV2SectionMaxOutputTokens(targetWords)).toBeLessThanOrEqual(
					6_000,
				);
			}
		}
	});
});

describe("atlasV2RunawayRetryMaxOutputTokens", () => {
	it("cuts the cap that ran away by 30%", () => {
		expect(atlasV2RunawayRetryMaxOutputTokens(4_000)).toBe(2_800);
	});

	it("never retries below the floor", () => {
		// A retry at the same cap only truncates in the same place; a retry below
		// the floor cannot hold a section at all.
		expect(atlasV2RunawayRetryMaxOutputTokens(1_500)).toBe(1_500);
		expect(atlasV2RunawayRetryMaxOutputTokens(800)).toBe(1_500);
	});
});

describe("ATLAS_V2_MAX_OUTPUT_TOKENS", () => {
	it("caps every structured-JSON stage well under a runaway", () => {
		expect(ATLAS_V2_MAX_OUTPUT_TOKENS).toEqual({
			plan: 1_500,
			coverage: 800,
			summary: 2_500,
			entailment: 800,
		});
	});
});
