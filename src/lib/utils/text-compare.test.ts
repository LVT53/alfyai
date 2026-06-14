import { describe, expect, it } from "vitest";
import { computeSideBySideDiff, summarizeTextComparison } from "./text-compare";

describe("summarizeTextComparison", () => {
	it("identifies a changed line as remove+add pair using Myers diff", () => {
		expect(
			summarizeTextComparison(
				"alpha\nbeta updated\ngamma",
				"alpha\nbeta\ngamma",
			),
		).toEqual({
			addedLines: 1,
			removedLines: 1,
			changedLines: 1,
			totalCurrentLines: 3,
			totalComparedLines: 3,
		});
	});

	it("identifies inserted lines when new text is longer", () => {
		expect(
			summarizeTextComparison("alpha\nbeta\ngamma\ndelta", "alpha\nbeta"),
		).toEqual({
			addedLines: 2,
			removedLines: 0,
			changedLines: 0,
			totalCurrentLines: 4,
			totalComparedLines: 2,
		});
	});

	it("aligns lines correctly when a line is inserted in the middle", () => {
		const result = summarizeTextComparison(
			"alpha\ninserted\nbeta\ngamma",
			"alpha\nbeta\ngamma",
		);
		expect(result.addedLines).toBe(1);
		expect(result.removedLines).toBe(0);
		expect(result.changedLines).toBe(0);
		expect(result.totalCurrentLines).toBe(4);
		expect(result.totalComparedLines).toBe(3);
	});

	it("handles identical text", () => {
		expect(summarizeTextComparison("alpha\nbeta", "alpha\nbeta")).toEqual({
			addedLines: 0,
			removedLines: 0,
			changedLines: 0,
			totalCurrentLines: 2,
			totalComparedLines: 2,
		});
	});
});

describe("computeSideBySideDiff", () => {
	it("produces aligned left/right line arrays", () => {
		const diff = computeSideBySideDiff(
			"alpha\nbeta updated\ngamma",
			"alpha\nbeta\ngamma",
		);

		expect(diff.leftLines).toEqual([
			{ text: "alpha", type: "equal" },
			{ text: "beta updated", type: "add" },
			{ text: "gamma", type: "equal" },
		]);
		expect(diff.rightLines).toEqual([
			{ text: "alpha", type: "equal" },
			{ text: "beta", type: "remove" },
			{ text: "gamma", type: "equal" },
		]);
	});

	it("aligns insertions with empty rows on the other side", () => {
		const diff = computeSideBySideDiff("alpha\ninserted\nbeta", "alpha\nbeta");

		expect(diff.leftLines).toEqual([
			{ text: "alpha", type: "equal" },
			{ text: "inserted", type: "add" },
			{ text: "beta", type: "equal" },
		]);
		expect(diff.rightLines).toEqual([
			{ text: "alpha", type: "equal" },
			{ text: "", type: "add" },
			{ text: "beta", type: "equal" },
		]);
	});

	it("aligns deletions with empty rows on the other side", () => {
		const diff = computeSideBySideDiff("alpha\nbeta", "alpha\nremoved\nbeta");

		expect(diff.leftLines).toEqual([
			{ text: "alpha", type: "equal" },
			{ text: "", type: "remove" },
			{ text: "beta", type: "equal" },
		]);
		expect(diff.rightLines).toEqual([
			{ text: "alpha", type: "equal" },
			{ text: "removed", type: "remove" },
			{ text: "beta", type: "equal" },
		]);
	});
});
