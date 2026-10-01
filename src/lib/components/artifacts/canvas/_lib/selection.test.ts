import { describe, expect, it } from "vitest";
import { withSelection } from "./selection";

type N = { id: string; selected?: boolean };

describe("withSelection", () => {
	it("selects exactly the named blocks and lets go of every other", () => {
		const nodes: N[] = [{ id: "a", selected: true }, { id: "b" }, { id: "c" }];
		const next = withSelection(nodes, ["b"]);
		expect(next.map((n) => [n.id, !!n.selected])).toEqual([
			["a", false],
			["b", true],
			["c", false],
		]);
	});

	it("keeps what is already selected when it is additive", () => {
		const nodes: N[] = [{ id: "a", selected: true }, { id: "b" }];
		const next = withSelection(nodes, ["b"], { additive: true });
		expect(next.map((n) => !!n.selected)).toEqual([true, true]);
	});

	it("answers the very same array when nothing changes, so a board does not redraw for nothing", () => {
		const nodes: N[] = [{ id: "a", selected: true }, { id: "b" }];
		expect(withSelection(nodes, ["a"])).toBe(nodes);
		expect(withSelection(nodes, [], { additive: true })).toBe(nodes);
	});

	it("does not touch a block that was not selected and stays so", () => {
		const nodes: N[] = [{ id: "a" }, { id: "b" }];
		const next = withSelection(nodes, ["a"]);
		expect(next[1]).toBe(nodes[1]);
	});

	it("clears everything for an empty selection", () => {
		const nodes: N[] = [
			{ id: "a", selected: true },
			{ id: "b", selected: true },
		];
		expect(withSelection(nodes, []).some((n) => n.selected)).toBe(false);
	});
});
