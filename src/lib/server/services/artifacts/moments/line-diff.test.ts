import { describe, expect, it } from "vitest";
import { diffLineCounts } from "./line-diff";

const lines = (...rows: string[]) => rows.join("\n");

describe("diffLineCounts", () => {
	it("counts nothing for equal texts, however they end their lines", () => {
		expect(diffLineCounts("a\nb\nc", "a\nb\nc")).toEqual({
			added: 0,
			removed: 0,
		});
		expect(diffLineCounts("a\r\nb", "a\nb")).toEqual({ added: 0, removed: 0 });
		expect(diffLineCounts("", "")).toEqual({ added: 0, removed: 0 });
	});

	it("counts a changed line as one removed and one added", () => {
		expect(diffLineCounts(lines("a", "b", "c"), lines("a", "B", "c"))).toEqual({
			added: 1,
			removed: 1,
		});
	});

	it("counts inserted and deleted runs", () => {
		expect(diffLineCounts(lines("a", "d"), lines("a", "b", "c", "d"))).toEqual({
			added: 2,
			removed: 0,
		});
		expect(diffLineCounts(lines("a", "b", "c", "d"), lines("a", "d"))).toEqual({
			added: 0,
			removed: 2,
		});
		expect(diffLineCounts("", lines("a", "b"))).toEqual({
			added: 2,
			removed: 0,
		});
		expect(diffLineCounts(lines("a", "b"), "")).toEqual({
			added: 0,
			removed: 2,
		});
	});

	it("counts a moved line as the removal and the insertion it is", () => {
		expect(
			diffLineCounts(lines("a", "b", "c", "d"), lines("a", "c", "d", "b")),
		).toEqual({ added: 1, removed: 1 });
	});

	it("finds the shortest edit across repeated lines", () => {
		expect(
			diffLineCounts(lines("x", "y", "x", "y"), lines("y", "x", "y", "x")),
		).toEqual({ added: 1, removed: 1 });
	});

	it("stays correct and fast on a large document with scattered edits", () => {
		const before = Array.from({ length: 6000 }, (_, i) => `line ${i}`);
		const after = [...before];
		for (const at of [10, 500, 2999, 5990]) after[at] = `changed ${at}`;
		after.splice(3000, 0, "inserted one", "inserted two");
		const started = Date.now();
		expect(diffLineCounts(before.join("\n"), after.join("\n"))).toEqual({
			added: 6,
			removed: 4,
		});
		expect(Date.now() - started).toBeLessThan(1000);
	});

	it("falls back to comparing the lines as bags once the edit count passes its cap, never throwing", () => {
		const before = Array.from({ length: 300 }, (_, i) => `a ${i}`).join("\n");
		const after = Array.from({ length: 300 }, (_, i) => `b ${i}`).join("\n");
		expect(diffLineCounts(before, after, 50)).toEqual({
			added: 300,
			removed: 300,
		});
	});
});
