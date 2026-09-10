import { describe, expect, it } from "vitest";
import {
	addAtlasV3Claim,
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

/** The same two quotes, now bound into ONE claim of two publishers. */
function bankWithClaim() {
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
	const first = addAtlasV3Quote(state, {
		sourceId: iea?.id ?? "",
		text: "The EU added 65.1 GW of solar capacity in 2025, the first fall since 2016.",
		goal: "g",
	});
	const second = addAtlasV3Quote(state, {
		sourceId: bbc?.id ?? "",
		text: "Europe installed 65.1 GW of solar last year, according to industry data.",
		goal: "g",
	});
	addAtlasV3Claim(state, {
		entity: "EU-27",
		metric: "solar additions",
		value: "65.1",
		unit: "GW",
		period: "2025",
		asOf: null,
		series: "grid-connected additions",
		evidenceIds: [first?.id ?? "", second?.id ?? ""],
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

	it("corroborates from the CLAIM when the sentence cites one quote", () => {
		// The writer cites one quote per figure. Corroboration is a property of the
		// fact: e1's claim also holds e2, from a second publisher.
		const result = verifyAtlasV3Report({
			...base,
			bank: bankWithClaim(),
			sections: [
				section([
					{ text: "The EU added 65.1 GW in 2025.", evidenceIds: ["e1"] },
				]),
			],
		});
		expect(result.sections[0].paragraphs[0][0].confidence).toBe("corroborated");
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

	it("cuts a sentence restating an earlier one's ids and figures", () => {
		const result = verifyAtlasV3Report({
			...base,
			finalPass: true,
			sections: [
				section([
					{
						text: "Harmonised standards enter into force on 65.1 GW terms.",
						evidenceIds: ["e1"],
					},
					{
						text: "Standards take effect once 65.1 GW is reached.",
						evidenceIds: ["e1"],
					},
				]),
			],
		});
		expect(result.totals.repeated).toBe(1);
		expect(result.sections[0].paragraphs[0]).toHaveLength(1);
	});

	it("keeps a restatement before the final pass", () => {
		const result = verifyAtlasV3Report({
			...base,
			sections: [
				section([
					{ text: "The EU added 65.1 GW.", evidenceIds: ["e1"] },
					{ text: "Additions reached 65.1 GW.", evidenceIds: ["e1"] },
				]),
			],
		});
		expect(result.totals.repeated).toBe(0);
		expect(result.sections[0].paragraphs[0]).toHaveLength(2);
	});

	it("stops a fourth sentence resting on a quote that adds no figure", () => {
		const result = verifyAtlasV3Report({
			...base,
			finalPass: true,
			sections: [
				section([
					{ text: "The EU added 65.1 GW in 2025.", evidenceIds: ["e1"] },
					{
						text: "That total was the first fall since 2016.",
						evidenceIds: ["e1"],
					},
					{
						text: "Capacity is measured at the grid connection.",
						evidenceIds: ["e1"],
					},
					{
						text: "The connection point defines the series.",
						evidenceIds: ["e1"],
					},
					{
						text: "Installers describe the same slowdown.",
						evidenceIds: ["e1"],
					},
				]),
			],
		});
		expect(result.sections[0].paragraphs[0]).toHaveLength(3);
		expect(result.totals.repeated).toBe(2);
	});

	it("caps inferred sentences at one per paragraph and a fifth of a section", () => {
		const result = verifyAtlasV3Report({
			...base,
			finalPass: true,
			sections: [
				{
					nodeId: "n1",
					title: "t",
					table: null,
					paragraphs: [
						[
							{
								text: "The EU added 65.1 GW in 2025.",
								evidenceIds: ["e1"],
								kind: "claim",
								calcId: null,
							},
							{
								text: "Demand cooled across the bloc.",
								evidenceIds: [],
								kind: "synthesis",
								calcId: null,
							},
							{
								text: "Installers expect the trend to continue.",
								evidenceIds: [],
								kind: "synthesis",
								calcId: null,
							},
						],
					],
				},
			],
		});
		const kept = result.sections[0].paragraphs.flat();
		expect(kept).toHaveLength(2);
		expect(kept[1].text).toBe("Demand cooled across the bloc.");
	});

	it("never lets an inferred sentence open a section", () => {
		const result = verifyAtlasV3Report({
			...base,
			finalPass: true,
			sections: [
				section([
					{ text: "Recent generations retain this soldered RAM design." },
					{ text: "The EU added 65.1 GW in 2025.", evidenceIds: ["e1"] },
				]),
			],
		});
		expect(result.sections[0].paragraphs.flat().map((s) => s.text)).toEqual([
			"The EU added 65.1 GW in 2025.",
		]);
	});

	it("leaves the caps off when the caller asks, as the verdict does", () => {
		const result = verifyAtlasV3Report({
			...base,
			finalPass: true,
			qualityCaps: false,
			sections: [
				section([
					{ text: "This report could not establish an answer." },
					{ text: "The EU added 65.1 GW in 2025.", evidenceIds: ["e1"] },
					{ text: "Additions were 65.1 GW.", evidenceIds: ["e1"] },
				]),
			],
		});
		expect(result.sections[0].paragraphs.flat()).toHaveLength(3);
		expect(result.totals.repeated).toBe(0);
	});

	it("keeps the section's opening sentence when the rules empty it", () => {
		const result = verifyAtlasV3Report({
			...base,
			finalPass: true,
			sections: [section([{ text: "Demand cooled across the bloc." }])],
		});
		expect(result.sections[0].paragraphs.flat()).toHaveLength(1);
	});

	/**
	 * The restored opener is a sentence the report PRINTS. Leaving it charged to
	 * `cut` made the diagnostics claim a removal the reader never suffered.
	 */
	it("gives back the count of the sentence it restores", () => {
		const result = verifyAtlasV3Report({
			...base,
			finalPass: true,
			sections: [section([{ text: "Demand cooled across the bloc." }])],
		});
		const kept = result.sections[0].paragraphs.flat().length;
		expect(kept).toBe(1);
		expect(
			result.totals.corroborated +
				result.totals.single +
				result.totals.inferred,
		).toBe(kept);
		expect(result.totals.cut).toBe(0);
		expect(result.totals.repeated).toBe(0);
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

describe("verifyAtlasV3AnswerTable, uncited and placeholder cells", () => {
	const cellTable = (
		text: string,
		evidenceIds: string[],
	): AtlasV3AnswerTable => ({
		kind: "comparison",
		title: "t",
		columns: [
			{ key: "model", label: "Model" },
			{ key: "memory", label: "Memory" },
		],
		rows: [
			{
				model: { text: "Dell XPS 13", evidenceIds: [] },
				memory: { text, evidenceIds },
			},
		],
		derived: [],
	});

	it("fails a non-numeric factual cell with no evidence at all", () => {
		const failures = verifyAtlasV3AnswerTable({
			table: cellTable("Soldered RAM", []),
			bank: bank(),
		});
		expect(failures).toHaveLength(1);
		expect(failures[0].kind).toBe("unsupported");
		expect(failures[0].rowLabel).toBe("Dell XPS 13");
		expect(failures[0].columnLabel).toBe("Memory");
		expect(failures[0].detail).toBe("stated with no evidence behind it");
	});

	it("leaves a cited non-numeric cell alone", () => {
		expect(
			verifyAtlasV3AnswerTable({
				table: cellTable("Soldered RAM", ["e1"]),
				bank: bank(),
			}),
		).toEqual([]);
	});

	it("treats a placeholder that then lists figures as the placeholder", () => {
		const failures = verifyAtlasV3AnswerTable({
			table: cellTable(
				"not published (July 2026 range $1,099.99-$1,599.00)",
				[],
			),
			bank: bank(),
		});
		expect(failures).toHaveLength(1);
		expect(failures[0].kind).toBe("placeholder");
	});

	it("says nothing about a bare placeholder", () => {
		expect(
			verifyAtlasV3AnswerTable({
				table: cellTable("nincs közzétéve", []),
				bank: bank(),
			}),
		).toEqual([]);
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
