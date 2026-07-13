import { describe, expect, it } from "vitest";
import { filterRows, sortRows, type TableRow } from "./table-sort";

const rows: TableRow[] = [
	{ name: "Charlie", cost: 12.5, tokens: 3000, spend: "$1,200.00" },
	{ name: "alice", cost: 3.2, tokens: 150000, spend: "$99.90" },
	{ name: "Bob", cost: 100, tokens: 250, spend: "$5.00" },
];

describe("sortRows", () => {
	it("sorts text ascending (case-insensitive)", () => {
		const out = sortRows(rows, "name", "asc", "text");
		expect(out.map((r) => r.name)).toEqual(["alice", "Bob", "Charlie"]);
	});

	it("sorts text descending", () => {
		const out = sortRows(rows, "name", "desc", "text");
		expect(out.map((r) => r.name)).toEqual(["Charlie", "Bob", "alice"]);
	});

	it("sorts numbers ascending", () => {
		const out = sortRows(rows, "cost", "asc", "number");
		expect(out.map((r) => r.cost)).toEqual([3.2, 12.5, 100]);
	});

	it("sorts numbers descending", () => {
		const out = sortRows(rows, "cost", "desc", "number");
		expect(out.map((r) => r.cost)).toEqual([100, 12.5, 3.2]);
	});

	it("sorts tokens numerically (not lexically)", () => {
		const out = sortRows(rows, "tokens", "desc", "tokens");
		expect(out.map((r) => r.tokens)).toEqual([150000, 3000, 250]);
	});

	it("sorts usd strings by numeric value, stripping currency formatting", () => {
		const asc = sortRows(rows, "spend", "asc", "usd");
		expect(asc.map((r) => r.spend)).toEqual(["$5.00", "$99.90", "$1,200.00"]);
		const desc = sortRows(rows, "spend", "desc", "usd");
		expect(desc.map((r) => r.spend)).toEqual(["$1,200.00", "$99.90", "$5.00"]);
	});

	it("does not mutate the input array", () => {
		const snapshot = [...rows];
		sortRows(rows, "cost", "asc", "number");
		expect(rows).toEqual(snapshot);
	});

	it("sends null/non-numeric values to the bottom when descending", () => {
		const withNulls: TableRow[] = [
			{ v: 5 },
			{ v: null },
			{ v: 10 },
			{ v: "n/a" },
		];
		const out = sortRows(withNulls, "v", "desc", "number");
		expect(out.map((r) => r.v)).toEqual([10, 5, null, "n/a"]);
	});
});

describe("filterRows", () => {
	it("returns all rows for an empty query", () => {
		expect(filterRows(rows, "").length).toBe(3);
		expect(filterRows(rows, "   ").length).toBe(3);
	});

	it("matches case-insensitively across all keys by default", () => {
		expect(filterRows(rows, "ALICE").map((r) => r.name)).toEqual(["alice"]);
	});

	it("matches substrings within numeric cell values", () => {
		// tokens 150000 contains "5000"
		expect(filterRows(rows, "5000").map((r) => r.name)).toEqual(["alice"]);
	});

	it("restricts matching to the given keys", () => {
		// "Bob" appears in name; restricting to spend should exclude it
		expect(filterRows(rows, "Bob", ["spend"]).length).toBe(0);
		expect(filterRows(rows, "Bob", ["name"]).map((r) => r.name)).toEqual([
			"Bob",
		]);
	});

	it("does not mutate the input array", () => {
		const snapshot = [...rows];
		filterRows(rows, "alice");
		expect(rows).toEqual(snapshot);
	});
});
