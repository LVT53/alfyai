import { describe, expect, it } from "vitest";
import { markRegenerable } from "./artifact-calls";

describe("markRegenerable", () => {
	const rows = [
		{ id: "doc-1", title: "One" },
		{ id: "doc-2", title: "Two", regenerable: true as const },
		{ id: "doc-3", title: "Three" },
	];

	it("marks exactly the rows whose ids are given, and leaves the others as they were", () => {
		const marked = markRegenerable(rows, new Set(["doc-3", "not-a-row"]));
		expect(marked).toEqual([
			{ id: "doc-1", title: "One" },
			{ id: "doc-2", title: "Two", regenerable: true },
			{ id: "doc-3", title: "Three", regenerable: true },
		]);
		// The row it did not mark is the very object it was given.
		expect(marked[0]).toBe(rows[0]);
	});

	it("hands back the same array when nothing needs marking, so a caller's dependents see nothing new", () => {
		expect(markRegenerable(rows, new Set())).toBe(rows);
		// An id that names a row already marked is nothing to do either.
		expect(markRegenerable(rows, new Set(["doc-2"]))).toBe(rows);
	});
});
