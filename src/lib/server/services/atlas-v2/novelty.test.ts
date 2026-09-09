import { describe, expect, it } from "vitest";
import {
	dropRepeatedAtlasV2Sentences,
	figureKeys,
	isAtlasV2RepeatedFact,
} from "./novelty";
import type { AtlasV2VerifiedSection, AtlasV2VerifiedSentence } from "./types";

function sentence(
	text: string,
	citations: number[] = [1],
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

// The three sentences the energy-statistics report actually shipped, one per
// section, all stating the same two figures.
const FIRST =
	"The European Union installed 65.1 GW of new solar PV in 2025, down 0.7% from the 65.6 GW installed in 2024.";
const RESTATED =
	"SolarPower Europe's annual outlook reports 65.1 GW of new EU solar PV capacity in 2025 and 65.6 GW in 2024.";

describe("figureKeys", () => {
	it("keys a quantity by value and unit, ignoring years", () => {
		expect([...figureKeys("The union added 65.1 GW in 2025.")]).toEqual([
			"65.1gw",
		]);
	});

	it("is empty for a sentence with no quantity", () => {
		expect(figureKeys("A member-state ranking needs more evidence.").size).toBe(
			0,
		);
	});
});

describe("isAtlasV2RepeatedFact", () => {
	it("catches a restatement carrying a subset of the same figures", () => {
		expect(isAtlasV2RepeatedFact(RESTATED, FIRST)).toBe(true);
	});

	it("catches an identical sentence", () => {
		expect(isAtlasV2RepeatedFact(FIRST, FIRST)).toBe(true);
	});

	it("keeps a sentence that adds a figure the earlier one did not have", () => {
		expect(
			isAtlasV2RepeatedFact(
				"Germany alone added 18.8 GW of the 65.1 GW installed in 2025.",
				FIRST,
			),
		).toBe(false);
	});

	it("keeps a sentence about a different subject with the same figure", () => {
		expect(
			isAtlasV2RepeatedFact(
				"Offshore wind tenders in Poland cleared 65.1 GW of grid applications.",
				FIRST,
			),
		).toBe(false);
	});

	it("never treats a figure-free sentence as a repeat", () => {
		expect(
			isAtlasV2RepeatedFact(
				"A member-state ranking would require additional evidence.",
				"A member-state ranking would require more evidence.",
			),
		).toBe(false);
	});
});

describe("dropRepeatedAtlasV2Sentences", () => {
	it("drops a later section's restatement of an earlier section's fact", () => {
		const result = dropRepeatedAtlasV2Sentences({
			sections: [
				section("s1", [sentence(FIRST)]),
				section("s2", [
					sentence(RESTATED),
					sentence("Germany added more than 18.8 GW in 2024.", [4]),
				]),
			],
		});
		expect(result.droppedSentenceCount).toBe(1);
		expect(
			result.sections[1].paragraphs.flat().map((entry) => entry.text),
		).toEqual(["Germany added more than 18.8 GW in 2024."]);
	});

	it("leaves repetition inside one section to the sentence budget", () => {
		const result = dropRepeatedAtlasV2Sentences({
			sections: [section("s1", [sentence(FIRST), sentence(RESTATED)])],
		});
		expect(result.droppedSentenceCount).toBe(0);
	});

	it("never empties a section, so the outline survives", () => {
		const result = dropRepeatedAtlasV2Sentences({
			sections: [
				section("s1", [sentence(FIRST)]),
				section("s2", [sentence(RESTATED)]),
			],
		});
		expect(result.sections[1].paragraphs.flat()).toHaveLength(1);
		expect(result.droppedSentenceCount).toBe(0);
	});

	it("leaves a report with nothing repeated untouched", () => {
		const sections = [
			section("s1", [sentence(FIRST)]),
			section("s2", [sentence("Permits took 18 months on average.", [2])]),
		];
		const result = dropRepeatedAtlasV2Sentences({ sections });
		expect(result.droppedSentenceCount).toBe(0);
		expect(
			result.sections.map((entry) => entry.paragraphs.flat().length),
		).toEqual([1, 1]);
	});
});
