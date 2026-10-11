import { describe, expect, it } from "vitest";
import { diffLines, foldUnchanged, type LineOp } from "./line-diff";

// What History's Code view draws of an App's source: the lines a version added and
// removed against another, the unchanged runs folded, each change a stop for the
// stepper. The server only counts lines ("42 lines changed"); the lines themselves
// are drawn here.

const ops = (...pairs: Array<[LineOp["op"], string]>): LineOp[] =>
	pairs.map(([op, text]) => ({ op, text }));

describe("diffLines", () => {
	it("says nothing changed when the two sources are the same", () => {
		expect(diffLines("a\nb\nc", "a\nb\nc")).toEqual(
			ops(["same", "a"], ["same", "b"], ["same", "c"]),
		);
	});

	it("puts the removed line before the added one where a line was changed", () => {
		expect(diffLines("a\nold\nc", "a\nnew\nc")).toEqual(
			ops(["same", "a"], ["del", "old"], ["add", "new"], ["same", "c"]),
		);
	});

	it("finds an insertion and a deletion in the middle of a long run", () => {
		const before = ["h1", "p", "x", "y", "z", "end"].join("\n");
		const after = ["h1", "p", "y", "z", "new", "end"].join("\n");
		expect(diffLines(before, after)).toEqual(
			ops(
				["same", "h1"],
				["same", "p"],
				["del", "x"],
				["same", "y"],
				["same", "z"],
				["add", "new"],
				["same", "end"],
			),
		);
	});

	it("handles changes at the very start and the very end", () => {
		expect(diffLines("a\nb", "z\na\nb\nq")).toEqual(
			ops(["add", "z"], ["same", "a"], ["same", "b"], ["add", "q"]),
		);
		expect(diffLines("a\nb\nc", "b")).toEqual(
			ops(["del", "a"], ["same", "b"], ["del", "c"]),
		);
	});

	it("reads Windows and old Mac line ends as lines", () => {
		expect(
			diffLines("a\r\nb\rc", "a\nb\nc").every((o) => o.op === "same"),
		).toBe(true);
	});

	it("takes nothing as no lines, so a first version is all additions", () => {
		expect(diffLines("", "a\nb")).toEqual(ops(["add", "a"], ["add", "b"]));
		expect(diffLines("a", "")).toEqual(ops(["del", "a"]));
		expect(diffLines("", "")).toEqual([]);
	});

	it("keeps both sources whole whatever it decides: removed + unchanged is the first, added + unchanged the second", () => {
		const before = Array.from(
			{ length: 60 },
			(_, i) => `line ${i % 7} ${i}`,
		).join("\n");
		const after = Array.from(
			{ length: 70 },
			(_, i) => `line ${(i * 3) % 7} ${i}`,
		).join("\n");
		const result = diffLines(before, after);
		expect(
			result
				.filter((o) => o.op !== "add")
				.map((o) => o.text)
				.join("\n"),
		).toBe(before);
		expect(
			result
				.filter((o) => o.op !== "del")
				.map((o) => o.text)
				.join("\n"),
		).toBe(after);
	});

	it("gives a bounded answer for two sources too different to align line by line", () => {
		const before = Array.from({ length: 2500 }, (_, i) => `a${i}`).join("\n");
		const after = Array.from({ length: 2500 }, (_, i) => `b${i}`).join("\n");
		const result = diffLines(before, after);
		// Everything of the first, then everything of the second: honest, and quick.
		expect(result.filter((o) => o.op === "del")).toHaveLength(2500);
		expect(result.filter((o) => o.op === "add")).toHaveLength(2500);
		expect(result.filter((o) => o.op === "same")).toHaveLength(0);
	});
});

describe("foldUnchanged", () => {
	const unchanged = (count: number, prefix: string): LineOp[] =>
		Array.from({ length: count }, (_, i) => ({
			op: "same" as const,
			text: `${prefix}${i}`,
		}));

	it("keeps three lines of context round a change and folds the rest of a long run", () => {
		const input: LineOp[] = [
			...unchanged(20, "top"),
			{ op: "del", text: "old" },
			{ op: "add", text: "new" },
			...unchanged(20, "bottom"),
		];
		const { rows, changes } = foldUnchanged(input);
		expect(changes).toBe(1);
		const folds = rows.filter((row) => row.type === "fold");
		expect(folds.map((row) => row.type === "fold" && row.count)).toEqual([
			17, 17,
		]);
		const lines = rows.filter((row) => row.type === "line");
		// 3 above, the two changed lines, 3 below.
		expect(lines.map((row) => row.type === "line" && row.text)).toEqual([
			"top17",
			"top18",
			"top19",
			"old",
			"new",
			"bottom0",
			"bottom1",
			"bottom2",
		]);
	});

	it("numbers each change once, a removed run and its replacement being one", () => {
		const input: LineOp[] = [
			{ op: "del", text: "a" },
			{ op: "del", text: "b" },
			{ op: "add", text: "c" },
			...unchanged(12, "mid"),
			{ op: "add", text: "d" },
		];
		const { rows, changes } = foldUnchanged(input);
		expect(changes).toBe(2);
		const numbered = rows.flatMap((row) =>
			row.type === "line" && row.change !== null ? [row.change] : [],
		);
		expect(numbered).toEqual([0, 0, 0, 1]);
	});

	it("leaves a short unchanged run between two changes as it is", () => {
		const input: LineOp[] = [
			{ op: "del", text: "a" },
			...unchanged(5, "x"),
			{ op: "add", text: "b" },
		];
		const { rows } = foldUnchanged(input);
		expect(rows.some((row) => row.type === "fold")).toBe(false);
	});

	it("keeps the folded lines, so a reader can open the fold", () => {
		const input: LineOp[] = [
			{ op: "add", text: "a" },
			...unchanged(11, "u"),
			{ op: "add", text: "z" },
		];
		const { rows } = foldUnchanged(input);
		const fold = rows.find((row) => row.type === "fold");
		expect(fold?.type === "fold" && fold.lines.map((o) => o.text)).toEqual([
			"u3",
			"u4",
			"u5",
			"u6",
			"u7",
		]);
	});

	it("has no changes and one plain listing when nothing differs", () => {
		const { rows, changes } = foldUnchanged(unchanged(30, "s"));
		expect(changes).toBe(0);
		// Nothing changed: nothing to fold round, the whole source is shown.
		expect(rows.every((row) => row.type === "line")).toBe(true);
		expect(rows).toHaveLength(30);
	});
});
