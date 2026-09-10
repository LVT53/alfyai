import { describe, expect, it } from "vitest";
import {
	addAtlasV3Quote,
	addAtlasV3Source,
	createAtlasV3Bank,
	freezeAtlasV3Bank,
} from "./evidence-bank";
import type {
	AtlasV3AnswerTable,
	AtlasV3VerifiedSection,
	AtlasV3WrittenSection,
} from "./types";
import {
	atlasV3WordCount,
	capAtlasV3ToWordBudget,
	isAtlasV3StaleSource,
	pruneAtlasV3AnswerTable,
	verifyAtlasV3AnswerTable,
	verifyAtlasV3Report,
} from "./verify";

const NOW = new Date("2026-09-10T00:00:00Z");

function bank() {
	const state = createAtlasV3Bank();
	const iea = addAtlasV3Source(state, {
		url: "https://iea.org/a",
		title: "IEA",
		publishedAt: "2025-12-01",
	});
	const bbc = addAtlasV3Source(state, {
		url: "https://bbc.com/a",
		title: "BBC",
		publishedAt: "2019-01-01",
	});
	addAtlasV3Quote(state, {
		sourceId: iea?.id ?? "",
		text: "The EU added 65.1 GW of solar capacity in 2025, the first fall since 2016.",
		goal: "g",
	});
	addAtlasV3Quote(state, {
		sourceId: bbc?.id ?? "",
		text: "Europe installed 65.1 GW of solar last year, according to industry data.",
		goal: "g",
	});
	return freezeAtlasV3Bank(state);
}

function section(
	sentences: Array<{
		text: string;
		evidenceIds?: string[];
		calcId?: string | null;
	}>,
): AtlasV3WrittenSection {
	return {
		nodeId: "n1",
		title: "t",
		table: null,
		paragraphs: [
			sentences.map((entry) => ({
				text: entry.text,
				evidenceIds: entry.evidenceIds ?? [],
				kind: "claim" as const,
				calcId: entry.calcId ?? null,
			})),
		],
	};
}

const TABLE: AtlasV3AnswerTable = {
	kind: "comparison",
	title: "t",
	columns: [
		{ key: "year", label: "Year" },
		{ key: "additions", label: "Additions" },
	],
	rows: [
		{
			year: { text: "2025", evidenceIds: [] },
			additions: { text: "65.1 GW", evidenceIds: ["e1"] },
		},
		{
			year: { text: "2023", evidenceIds: [] },
			additions: { text: "56.9 GW", evidenceIds: ["e1"] },
		},
	],
	derived: [
		{
			id: "k1",
			label: "Change",
			expression: "(65.1-65.6)/65.6*100",
			inputs: ["e1"],
			value: "-0.76",
		},
	],
};

describe("verifyAtlasV3Report", () => {
	const base = {
		bank: bank(),
		answerTable: TABLE,
		staleMonths: 18,
		now: NOW,
	};

	it("keeps a figure its own quotes state and marks it corroborated", () => {
		const result = verifyAtlasV3Report({
			...base,
			sections: [
				section([
					{ text: "The EU added 65.1 GW in 2025.", evidenceIds: ["e1", "e2"] },
				]),
			],
		});
		const sentence = result.sections[0].paragraphs[0][0];
		expect(sentence.outcome).toBe("kept");
		expect(sentence.confidence).toBe("corroborated");
		expect(result.totals.corroborated).toBe(1);
		expect(result.citedEvidenceIds).toEqual(["e1", "e2"]);
	});

	it("calls one publisher single", () => {
		const result = verifyAtlasV3Report({
			...base,
			sections: [
				section([{ text: "The EU added 65.1 GW.", evidenceIds: ["e1"] }]),
			],
		});
		expect(result.sections[0].paragraphs[0][0].confidence).toBe("single");
	});

	it("asks for evidence rather than cutting on the first pass", () => {
		const result = verifyAtlasV3Report({
			...base,
			sections: [
				section([
					{ text: "The EU added 82.4 GW in 2025.", evidenceIds: ["e1"] },
				]),
			],
		});
		expect(result.totals.needsEvidence).toBe(1);
		expect(result.totals.cut).toBe(0);
		expect(result.needsEvidence[0].query).toContain("82.4");
		// The sentence SURVIVES so the critic can fix it.
		expect(result.sections[0].paragraphs[0]).toHaveLength(1);
	});

	it("cuts on the final pass", () => {
		const result = verifyAtlasV3Report({
			...base,
			finalPass: true,
			sections: [
				section([
					{ text: "The EU added 82.4 GW in 2025.", evidenceIds: ["e1"] },
					{ text: "The EU added 65.1 GW in 2025.", evidenceIds: ["e1"] },
				]),
			],
		});
		expect(result.totals.cut).toBe(1);
		expect(result.sections[0].paragraphs[0]).toHaveLength(1);
	});

	it("accepts a figure the sandbox computed", () => {
		const result = verifyAtlasV3Report({
			...base,
			finalPass: true,
			sections: [section([{ text: "That is a -0.76% change.", calcId: "k1" }])],
		});
		expect(result.totals.cut).toBe(0);
		expect(result.sections[0].paragraphs[0][0].confidence).toBe("inferred");
	});

	it("keeps a sentence with no figure at all", () => {
		const result = verifyAtlasV3Report({
			...base,
			finalPass: true,
			sections: [section([{ text: "Rooftop demand carried the decline." }])],
		});
		expect(result.sections[0].paragraphs[0]).toHaveLength(1);
		expect(result.totals.inferred).toBe(1);
	});

	it("reports a stale source", () => {
		const result = verifyAtlasV3Report({
			...base,
			sections: [
				section([{ text: "The EU added 65.1 GW.", evidenceIds: ["e2"] }]),
			],
		});
		expect(result.staleSourceIds).toEqual(["s2"]);
	});

	it("carries the section's table through", () => {
		const result = verifyAtlasV3Report({
			...base,
			sections: [
				{ ...section([{ text: "x", evidenceIds: ["e1"] }]), table: TABLE },
			],
		});
		expect(result.sections[0].table?.title).toBe("t");
	});
});

describe("verifyAtlasV3AnswerTable", () => {
	it("passes a cell its quote supports and fails one it does not", () => {
		const failures = verifyAtlasV3AnswerTable({ table: TABLE, bank: bank() });
		expect(failures).toHaveLength(1);
		expect(failures[0].text).toBe("56.9 GW");
		expect(failures[0].detail).toContain("does not appear");
	});

	it("never checks the label column", () => {
		const failures = verifyAtlasV3AnswerTable({
			table: {
				...TABLE,
				rows: [
					{
						year: { text: "2019", evidenceIds: [] },
						additions: { text: "65.1 GW", evidenceIds: ["e1"] },
					},
				],
			},
			bank: bank(),
		});
		expect(failures).toEqual([]);
	});

	it("returns nothing for no table", () => {
		expect(verifyAtlasV3AnswerTable({ table: null, bank: bank() })).toEqual([]);
	});
});

describe("pruneAtlasV3AnswerTable", () => {
	it("replaces an unsupported cell rather than dropping the row", () => {
		const pruned = pruneAtlasV3AnswerTable({
			table: TABLE,
			failures: [{ column: "additions", text: "56.9 GW" }],
			placeholder: "not published",
		});
		expect(pruned?.rows).toHaveLength(2);
		expect(pruned?.rows[1].additions.text).toBe("not published");
		expect(pruned?.rows[0].additions.text).toBe("65.1 GW");
	});

	it("passes the table through with no failures", () => {
		expect(
			pruneAtlasV3AnswerTable({
				table: TABLE,
				failures: [],
				placeholder: "x",
			}),
		).toBe(TABLE);
	});
});

describe("isAtlasV3StaleSource", () => {
	it("measures months, not days, and ignores an unknown date", () => {
		expect(isAtlasV3StaleSource("2024-01-01", NOW, 18)).toBe(true);
		expect(isAtlasV3StaleSource("2025-12-01", NOW, 18)).toBe(false);
		expect(isAtlasV3StaleSource(null, NOW, 18)).toBe(false);
		expect(isAtlasV3StaleSource("not a date", NOW, 18)).toBe(false);
	});
});

describe("capAtlasV3ToWordBudget", () => {
	function verified(texts: string[], cited: boolean[]): AtlasV3VerifiedSection {
		return {
			nodeId: "n1",
			title: "t",
			table: null,
			paragraphs: [
				texts.map((text, index) => ({
					text,
					evidenceIds: cited[index] ? ["e1"] : [],
					kind: "claim" as const,
					confidence: "single" as const,
					outcome: "kept" as const,
					failures: [],
				})),
			],
		};
	}

	it("passes a body inside the budget through untouched", () => {
		const sections = [verified(["one two three"], [true])];
		const result = capAtlasV3ToWordBudget({ sections, maxWords: 100 });
		expect(result.droppedSentenceCount).toBe(0);
		expect(result.sections).toBe(sections);
	});

	it("drops uncited sentences before cited ones and never the lead", () => {
		const sections = [
			verified(
				["lead sentence here", "cited sentence here", "uncited sentence here"],
				[true, true, false],
			),
		];
		const result = capAtlasV3ToWordBudget({ sections, maxWords: 6 });
		const kept = result.sections[0].paragraphs.flat().map((s) => s.text);
		expect(kept[0]).toBe("lead sentence here");
		expect(kept).not.toContain("uncited sentence here");
	});
});

describe("atlasV3WordCount", () => {
	it("counts the verdict as well as the body", () => {
		expect(
			atlasV3WordCount(
				[
					{
						nodeId: "n1",
						title: "t",
						table: null,
						paragraphs: [
							[
								{
									text: "one two",
									evidenceIds: [],
									kind: "claim",
									confidence: "inferred",
									outcome: "kept",
									failures: [],
								},
							],
						],
					},
				],
				[
					{
						text: "three four five",
						evidenceIds: [],
						kind: "claim",
						confidence: "inferred",
						outcome: "kept",
						failures: [],
					},
				],
			),
		).toBe(5);
	});
});
