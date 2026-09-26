import { describe, expect, it } from "vitest";
import { layoutMarginThreads, type MarginThreadInput } from "./margin-layout";

function thread(overrides: Partial<MarginThreadInput> = {}): MarginThreadInput {
	return {
		id: "c1",
		anchorTop: 0,
		height: 80,
		order: 0,
		...overrides,
	};
}

describe("layoutMarginThreads", () => {
	it("returns nothing for an empty input", () => {
		expect(layoutMarginThreads([])).toEqual({ placed: [], orphanedIds: [] });
	});

	it("places a single anchored thread at its own desired top", () => {
		const result = layoutMarginThreads([
			thread({ id: "c1", anchorTop: 120, height: 60, order: 0 }),
		]);
		expect(result.placed).toEqual([{ id: "c1", top: 120 }]);
		expect(result.orphanedIds).toEqual([]);
	});

	it("keeps two well-separated threads at their own desired positions", () => {
		const result = layoutMarginThreads([
			thread({ id: "a", anchorTop: 0, height: 60, order: 0 }),
			thread({ id: "b", anchorTop: 400, height: 60, order: 1 }),
		]);
		expect(result.placed).toEqual([
			{ id: "a", top: 0 },
			{ id: "b", top: 400 },
		]);
	});

	// The core requirement: "threads must never overlap: push them down in
	// document order."
	it("pushes a later thread down when its desired top would overlap the earlier one", () => {
		const result = layoutMarginThreads([
			thread({ id: "a", anchorTop: 100, height: 80, order: 0 }),
			// b wants to start at 130, well inside a's 100-180 box (plus the gap).
			thread({ id: "b", anchorTop: 130, height: 50, order: 1 }),
		]);
		const a = result.placed.find((p) => p.id === "a");
		const b = result.placed.find((p) => p.id === "b");
		expect(a?.top).toBe(100);
		// b is pushed to (at least) a's bottom plus the minimum gap, never to
		// its own raw desired top.
		expect(b?.top).toBeGreaterThanOrEqual(100 + 80);
		expect(b?.top).not.toBe(130);
	});

	it("never lets two placed threads' boxes overlap, for a cluster of many close anchors", () => {
		const inputs = Array.from({ length: 6 }, (_, i) =>
			thread({ id: `t${i}`, anchorTop: i * 5, height: 40, order: i }),
		);
		const { placed } = layoutMarginThreads(inputs);
		const byOrder = inputs.map((input) =>
			placed.find((p) => p.id === input.id),
		);
		for (let i = 1; i < byOrder.length; i += 1) {
			const prev = byOrder[i - 1];
			const cur = byOrder[i];
			const prevInput = inputs[i - 1];
			expect(prev).toBeDefined();
			expect(cur).toBeDefined();
			// The next box may not start before the previous one's bottom.
			expect(cur?.top ?? 0).toBeGreaterThanOrEqual(
				(prev?.top ?? 0) + prevInput.height,
			);
		}
	});

	// Document order is the ground truth for STACKING sequence, not the raw
	// measured desired-top value (which could be noisy, or — as tested here —
	// simply out of step with reading order for some transient DOM state).
	it("stacks by document order even when a later thread's raw desired top is numerically smaller", () => {
		const result = layoutMarginThreads([
			thread({ id: "first", anchorTop: 300, height: 50, order: 0 }),
			thread({ id: "second", anchorTop: 50, height: 50, order: 1 }),
		]);
		const first = result.placed.find((p) => p.id === "first");
		const second = result.placed.find((p) => p.id === "second");
		expect(first?.top).toBe(300);
		// second still comes AFTER first in the stack, never above it, because
		// order (1) follows first's order (0).
		expect(second?.top).toBeGreaterThanOrEqual(300 + 50);
	});

	it("puts a thread with no anchor position in orphanedIds, never in placed", () => {
		const result = layoutMarginThreads([
			thread({ id: "a", anchorTop: 0, order: 0 }),
			thread({ id: "orphan", anchorTop: null, order: 1 }),
			thread({ id: "b", anchorTop: 200, order: 2 }),
		]);
		expect(result.orphanedIds).toEqual(["orphan"]);
		expect(result.placed.map((p) => p.id)).toEqual(["a", "b"]);
	});

	it("orders orphanedIds by document order, regardless of input array order", () => {
		const result = layoutMarginThreads([
			thread({ id: "later-orphan", anchorTop: null, order: 5 }),
			thread({ id: "earlier-orphan", anchorTop: null, order: 1 }),
		]);
		expect(result.orphanedIds).toEqual(["earlier-orphan", "later-orphan"]);
	});

	it("is a pure function: the same input always produces the same output, and never mutates its argument", () => {
		const input = [
			thread({ id: "a", anchorTop: 10, height: 30, order: 0 }),
			thread({ id: "b", anchorTop: 20, height: 30, order: 1 }),
		];
		const snapshot = JSON.parse(JSON.stringify(input));
		const first = layoutMarginThreads(input);
		const second = layoutMarginThreads(input);
		expect(input).toEqual(snapshot);
		expect(first).toEqual(second);
	});

	it("treats input order as irrelevant — only `order` decides the stack", () => {
		const inOrder = layoutMarginThreads([
			thread({ id: "a", anchorTop: 0, height: 40, order: 0 }),
			thread({ id: "b", anchorTop: 10, height: 40, order: 1 }),
		]);
		const reversed = layoutMarginThreads([
			thread({ id: "b", anchorTop: 10, height: 40, order: 1 }),
			thread({ id: "a", anchorTop: 0, height: 40, order: 0 }),
		]);
		expect(reversed).toEqual(inOrder);
	});
});
