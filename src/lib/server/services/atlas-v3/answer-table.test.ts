import { describe, expect, it } from "vitest";
import {
	atlasV3AnswerTableEvidenceIds,
	atlasV3TableKindForShape,
	atlasV3UncitedFigureCells,
	buildAtlasV3Answer,
	buildAtlasV3AnswerTablePrompt,
	computeAtlasV3Derived,
	deterministicAtlasV3AnswerTable,
	parseAtlasV3AnswerTable,
	roundForProse,
} from "./answer-table";
import {
	addAtlasV3Claim,
	addAtlasV3Quote,
	addAtlasV3Source,
	createAtlasV3Bank,
	freezeAtlasV3Bank,
} from "./evidence-bank";
import { fakeModel } from "./test-support";
import type { AtlasV3Ask, AtlasV3Memo } from "./types";

const ASK: AtlasV3Ask = {
	decision: "d",
	implicitRequirements: [],
	perspectives: [],
	shape: "comparison",
	coreQuestion: "EU solar 2025 versus 2024",
	title: "t",
	subQuestions: [],
};

function bank() {
	const state = createAtlasV3Bank();
	const iea = addAtlasV3Source(state, {
		url: "https://iea.org/a",
		title: "IEA",
		publishedAt: null,
	});
	const q1 = addAtlasV3Quote(state, {
		sourceId: iea?.id ?? "",
		text: "The EU added 65.1 GW of solar capacity in 2025, industry data show.",
		goal: "g",
	});
	const q2 = addAtlasV3Quote(state, {
		sourceId: iea?.id ?? "",
		text: "That is below the 65.6 GW the bloc added in 2024.",
		goal: "g",
	});
	addAtlasV3Claim(state, {
		entity: "EU-27",
		metric: "solar additions",
		value: "65.1",
		unit: "GW",
		period: "2025",
		asOf: null,
		series: "grid-connected",
		evidenceIds: [q1?.id ?? ""],
	});
	addAtlasV3Claim(state, {
		entity: "EU-27",
		metric: "solar additions",
		value: "65.6",
		unit: "GW",
		period: "2024",
		asOf: null,
		series: "grid-connected",
		evidenceIds: [q2?.id ?? ""],
	});
	return freezeAtlasV3Bank(state);
}

const MEMO: AtlasV3Memo = {
	answerSoFar: "a",
	claimIds: ["c1", "c2"],
	openQuestions: [],
	deadEnds: [],
	budgetUsed: { searches: 1, pagesRead: 1, rounds: 1 },
};

const GOOD_TABLE = JSON.stringify({
	title: "EU solar additions",
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
			year: { text: "2024", evidenceIds: [] },
			additions: { text: "65.6 GW", evidenceIds: ["e2"] },
		},
	],
	derived: [
		{
			id: "k1",
			label: "Change 2024-2025",
			expression: "(65.1-65.6)/65.6*100",
			inputs: ["e1", "e2"],
		},
	],
});

describe("atlasV3TableKindForShape", () => {
	it("maps the shape onto the table the question implies", () => {
		expect(atlasV3TableKindForShape("comparison")).toBe("comparison");
		expect(atlasV3TableKindForShape("timeline")).toBe("timeline");
		expect(atlasV3TableKindForShape("forecast")).toBe("figures");
	});
});

describe("parseAtlasV3AnswerTable", () => {
	const options = {
		kind: "comparison" as const,
		knownEvidenceIds: ["e1", "e2"],
	};

	it("reads columns, cells and derived figures", () => {
		const table = parseAtlasV3AnswerTable(GOOD_TABLE, options);
		expect(table?.columns).toHaveLength(2);
		expect(table?.rows).toHaveLength(2);
		expect(table?.rows[0].additions.evidenceIds).toEqual(["e1"]);
		expect(table?.derived[0].expression).toBe("(65.1-65.6)/65.6*100");
		expect(table?.derived[0].value).toBeNull();
	});

	it("drops an evidence id the bank does not hold", () => {
		const table = parseAtlasV3AnswerTable(
			JSON.stringify({
				columns: [{ key: "a", label: "A" }],
				rows: [{ a: { text: "1", evidenceIds: ["e1", "e99"] } }],
			}),
			options,
		);
		expect(table?.rows[0].a.evidenceIds).toEqual(["e1"]);
	});

	it("refuses an expression that is not pure arithmetic", () => {
		const table = parseAtlasV3AnswerTable(
			JSON.stringify({
				columns: [{ key: "a", label: "A" }],
				rows: [{ a: { text: "1", evidenceIds: [] } }],
				derived: [
					{ id: "k1", label: "l", expression: "__import__('os').system('ls')" },
					{ id: "k2", label: "l", expression: "65.1 GW - 65.6 GW" },
					{ id: "k3", label: "l", expression: "(65.1-65.6)/65.6" },
				],
			}),
			options,
		);
		expect(table?.derived.map((entry) => entry.id)).toEqual(["k3"]);
	});

	it("accepts a bare string cell as a label", () => {
		const table = parseAtlasV3AnswerTable(
			JSON.stringify({
				columns: [{ key: "a", label: "A" }],
				rows: [{ a: "Framework 13" }],
			}),
			options,
		);
		expect(table?.rows[0].a).toEqual({ text: "Framework 13", evidenceIds: [] });
	});

	it("returns null without columns or rows", () => {
		expect(parseAtlasV3AnswerTable("{}", options)).toBeNull();
		expect(
			parseAtlasV3AnswerTable(
				JSON.stringify({ columns: [{ key: "a", label: "A" }], rows: [] }),
				options,
			),
		).toBeNull();
		expect(
			parseAtlasV3AnswerTable(
				JSON.stringify({ columns: [], rows: [{ a: "x" }] }),
				options,
			),
		).toBeNull();
	});

	it("drops a row with no text in any column", () => {
		const table = parseAtlasV3AnswerTable(
			JSON.stringify({
				columns: [{ key: "a", label: "A" }],
				rows: [{ a: { text: "", evidenceIds: [] } }, { a: "kept" }],
			}),
			options,
		);
		expect(table?.rows).toHaveLength(1);
	});
});

describe("computeAtlasV3Derived", () => {
	it("computes through the sandbox and rounds for prose", async () => {
		const table = parseAtlasV3AnswerTable(GOOD_TABLE, {
			kind: "comparison",
			knownEvidenceIds: ["e1", "e2"],
		});
		if (!table) throw new Error("expected a table");
		const computed = await computeAtlasV3Derived({
			table,
			runPython: async () => ({ ok: true, value: "-0.7621951219512195" }),
		});
		expect(computed.derived[0].value).toBe("-0.76");
	});

	it("leaves the value null when the sandbox fails", async () => {
		const table = parseAtlasV3AnswerTable(GOOD_TABLE, {
			kind: "comparison",
			knownEvidenceIds: ["e1", "e2"],
		});
		if (!table) throw new Error("expected a table");
		const computed = await computeAtlasV3Derived({
			table,
			runPython: async () => ({ ok: false, value: null }),
		});
		expect(computed.derived[0].value).toBeNull();
	});

	it("passes the table through when there is no sandbox", async () => {
		const table = parseAtlasV3AnswerTable(GOOD_TABLE, {
			kind: "comparison",
			knownEvidenceIds: ["e1", "e2"],
		});
		if (!table) throw new Error("expected a table");
		expect(await computeAtlasV3Derived({ table })).toBe(table);
	});
});

describe("roundForProse", () => {
	it("rounds by magnitude and leaves integers alone", () => {
		expect(roundForProse("-0.7621951219512195")).toBe("-0.76");
		expect(roundForProse("0.000123456")).toBe("0.000123");
		expect(roundForProse("1234.56789")).toBe("1234.6");
		expect(roundForProse("42")).toBe("42");
		expect(roundForProse("not a number")).toBe("not a number");
	});
});

describe("deterministicAtlasV3AnswerTable", () => {
	it("makes one row per claim with its evidence", () => {
		const table = deterministicAtlasV3AnswerTable({
			ask: ASK,
			memo: MEMO,
			bank: bank(),
		});
		expect(table?.rows).toHaveLength(2);
		expect(table?.rows[0].value.text).toBe("65.1 GW");
		expect(table?.rows[0].value.evidenceIds).toEqual(["e1"]);
	});

	it("returns null when the memo named no claim", () => {
		expect(
			deterministicAtlasV3AnswerTable({
				ask: ASK,
				memo: { ...MEMO, claimIds: [] },
				bank: bank(),
			}),
		).toBeNull();
	});
});

describe("buildAtlasV3Answer", () => {
	const base = {
		ask: ASK,
		memo: MEMO,
		bank: bank(),
		language: "en" as const,
		currentDate: "2026-09-10",
	};

	it("builds and computes the model's table", async () => {
		const model = fakeModel({ "v3:answer": GOOD_TABLE });
		const table = await buildAtlasV3Answer({
			...base,
			runModel: model.call,
			runPython: async () => ({ ok: true, value: "-0.762" }),
		});
		expect(table?.rows).toHaveLength(2);
		expect(table?.derived[0].value).toBe("-0.76");
	});

	it("falls back to the deterministic table", async () => {
		const model = fakeModel({ "v3:answer": "not json" });
		const table = await buildAtlasV3Answer({ ...base, runModel: model.call });
		expect(table?.rows).toHaveLength(2);
		expect(table?.columns.map((column) => column.key)).toContain("series");
	});

	it("returns null when there is nothing to tabulate", async () => {
		const model = fakeModel({ "v3:answer": "no" });
		expect(
			await buildAtlasV3Answer({
				...base,
				memo: { ...MEMO, claimIds: [] },
				runModel: model.call,
			}),
		).toBeNull();
	});

	it("survives a model that throws", async () => {
		const table = await buildAtlasV3Answer({
			...base,
			runModel: async () => {
				throw new Error("down");
			},
		});
		expect(table?.rows).toHaveLength(2);
	});
});

describe("atlasV3AnswerTableEvidenceIds", () => {
	it("collects every id the table cites, cells and derived inputs", () => {
		const table = parseAtlasV3AnswerTable(GOOD_TABLE, {
			kind: "comparison",
			knownEvidenceIds: ["e1", "e2"],
		});
		expect(atlasV3AnswerTableEvidenceIds(table)).toEqual(["e1", "e2"]);
		expect(atlasV3AnswerTableEvidenceIds(null)).toEqual([]);
	});
});

describe("atlasV3UncitedFigureCells", () => {
	it("flags a figure cell with no citation and ignores a label", () => {
		const table = parseAtlasV3AnswerTable(
			JSON.stringify({
				columns: [
					{ key: "option", label: "Option" },
					{ key: "price", label: "Price" },
				],
				rows: [
					{
						option: "Framework 13",
						price: { text: "$1,099", evidenceIds: [] },
					},
				],
			}),
			{ kind: "comparison", knownEvidenceIds: ["e1"] },
		);
		expect(atlasV3UncitedFigureCells(table)).toEqual([
			{ column: "price", text: "$1,099" },
		]);
	});
});

describe("buildAtlasV3AnswerTablePrompt", () => {
	it("carries the claims and only the quotes they rest on", () => {
		const parsed = JSON.parse(
			buildAtlasV3AnswerTablePrompt({
				ask: ASK,
				memo: MEMO,
				bank: bank(),
				language: "en",
				currentDate: "2026-09-10",
			}),
		);
		expect(parsed.kind).toBe("comparison");
		expect(parsed.claims).toHaveLength(2);
		expect(parsed.quotes.map((quote: { id: string }) => quote.id)).toEqual([
			"e1",
			"e2",
		]);
	});
});
