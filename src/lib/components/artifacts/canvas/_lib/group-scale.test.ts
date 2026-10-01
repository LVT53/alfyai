import { describe, expect, it } from "vitest";
import type { CanvasNode } from "$lib/shared/artifacts/canvas";
import { groupOf, resizeGroup } from "./group-scale";

function sticky(
	id: string,
	x: number,
	y: number,
	width = 100,
	height = 60,
	extra: Partial<CanvasNode> = {},
): CanvasNode {
	return {
		id,
		type: "sticky",
		position: { x, y },
		width,
		height,
		measured: { width, height },
		data: { kind: "sticky", text: id, tone: "yellow" },
		...extra,
	} as CanvasNode;
}

function frame(
	id: string,
	x: number,
	y: number,
	width: number,
	height: number,
	extra: Partial<CanvasNode> = {},
): CanvasNode {
	return {
		id,
		type: "frame",
		position: { x, y },
		width,
		height,
		measured: { width, height },
		data: { kind: "frame", label: id, width, height },
		...extra,
	} as CanvasNode;
}

const picked = (node: CanvasNode): CanvasNode => ({ ...node, selected: true });

/** A 2 x 2 arrangement: the box around it is x 100..400, y 50..270. */
function square(): CanvasNode[] {
	return [
		picked(sticky("a", 100, 50)),
		picked(sticky("b", 300, 50)),
		picked(sticky("c", 100, 210)),
		picked(sticky("d", 300, 210)),
	];
}

describe("groupOf", () => {
	it("needs two blocks picked to be a group", () => {
		expect(groupOf([])).toBeNull();
		expect(groupOf([picked(sticky("a", 0, 0)), sticky("b", 200, 0)])).toBeNull();
	});

	it("is the box around what was picked, and nothing else", () => {
		const group = groupOf([...square(), sticky("e", 900, 900)]);
		expect(group?.box).toEqual({ x: 100, y: 50, width: 300, height: 220 });
		expect(group?.items.map((item) => item.id).sort()).toEqual([
			"a",
			"b",
			"c",
			"d",
		]);
	});

	it("reads a block's size as drawn (measured) before what it stores", () => {
		const wide = { ...picked(sticky("a", 0, 0, 100, 60)), measured: { width: 140, height: 80 } };
		const group = groupOf([wide, picked(sticky("b", 300, 0))]);
		expect(group?.box.width).toBe(400);
		expect(group?.box.height).toBe(80);
	});

	it("takes the notes of a picked frame along, picked or not, and no others", () => {
		const nodes = [
			picked(frame("f", 0, 0, 400, 300)),
			sticky("inside", 20, 40, 100, 60, { parentId: "f" }),
			picked(sticky("loose", 500, 0)),
			sticky("elsewhere", 700, 700),
		];
		const group = groupOf(nodes);
		expect(group?.items.map((item) => item.id).sort()).toEqual([
			"f",
			"inside",
			"loose",
		]);
		// The box is round what was picked: the frame and the loose note.
		expect(group?.box).toEqual({ x: 0, y: 0, width: 600, height: 300 });
	});
});

describe("resizeGroup", () => {
	function resized(handle: Parameters<typeof resizeGroup>[1], dx: number, dy: number) {
		const group = groupOf(square());
		if (!group) throw new Error("no group");
		return { group, ...resizeGroup(group, handle, { x: dx, y: dy }) };
	}

	it("scales places and sizes about the corner opposite the handle", () => {
		const { box, patches } = resized("se", 150, 110);
		// 300 -> 450 (x1.5), 220 -> 330 (x1.5).
		expect(box).toEqual({ x: 100, y: 50, width: 450, height: 330 });
		expect(patches.get("a")).toEqual({
			position: { x: 100, y: 50 },
			width: 150,
			height: 90,
		});
		expect(patches.get("b")).toEqual({
			position: { x: 400, y: 50 },
			width: 150,
			height: 90,
		});
		expect(patches.get("c")).toEqual({
			position: { x: 100, y: 290 },
			width: 150,
			height: 90,
		});
		expect(patches.get("d")).toEqual({
			position: { x: 400, y: 290 },
			width: 150,
			height: 90,
		});
	});

	it("holds the bottom-right corner still when the top-left handle is dragged", () => {
		const { box, patches } = resized("nw", -150, -110);
		expect(box).toEqual({ x: -50, y: -60, width: 450, height: 330 });
		const d = patches.get("d");
		expect(d && d.position.x + d.width).toBe(400);
		expect(d && d.position.y + d.height).toBe(270);
		expect(patches.get("a")).toEqual({
			position: { x: -50, y: -60 },
			width: 150,
			height: 90,
		});
	});

	it("scales one way only from an edge handle, and ignores the other part of the drag", () => {
		const { box, patches } = resized("e", 150, 999);
		expect(box).toEqual({ x: 100, y: 50, width: 450, height: 220 });
		expect(patches.get("b")).toEqual({
			position: { x: 400, y: 50 },
			width: 150,
			height: 60,
		});
		const north = resized("n", 999, -110);
		expect(north.box).toEqual({ x: 100, y: -60, width: 300, height: 330 });
		expect(north.patches.get("c")?.width).toBe(100);
	});

	it("stops at the smallest the most constrained block may be, in proportion", () => {
		// A sticky's smallest is 96 x 64: the 60 px tall notes already sit under it
		// vertically, so only the width has a floor to meet here.
		const { box, patches } = resized("se", -9999, -9999);
		const a = patches.get("a");
		const b = patches.get("b");
		expect(a && a.width).toBeGreaterThanOrEqual(96);
		expect(b && b.width).toBeGreaterThanOrEqual(96);
		// The box never turns inside out.
		expect(box.width).toBeGreaterThan(0);
		expect(box.height).toBeGreaterThan(0);
		// And what is left is the same arrangement, smaller: widths all alike.
		expect(new Set([...patches.values()].map((patch) => patch.width)).size).toBe(1);
		// The gap between the columns shrank by the same factor as the widths.
		const factor = (a?.width ?? 0) / 100;
		expect((b?.position.x ?? 0) - (a?.position.x ?? 0)).toBeCloseTo(200 * factor, 0);
	});

	it("does not make a block that is already smaller than its minimum grow when shrinking", () => {
		const small = [
			picked(sticky("a", 0, 0, 60, 40)),
			picked(sticky("b", 200, 0, 60, 40)),
		];
		const group = groupOf(small);
		if (!group) throw new Error("no group");
		const { patches } = resizeGroup(group, "e", { x: -50, y: 0 });
		// Never larger than before on a shrink, because of a floor above its size.
		expect(patches.get("a")?.width).toBeLessThanOrEqual(60);
	});

	it("keeps whole numbers", () => {
		const { patches } = resized("se", 37, 23);
		for (const patch of patches.values()) {
			expect(Number.isInteger(patch.position.x)).toBe(true);
			expect(Number.isInteger(patch.position.y)).toBe(true);
			expect(Number.isInteger(patch.width)).toBe(true);
			expect(Number.isInteger(patch.height)).toBe(true);
		}
	});

	it("scales a frame's notes with it, in the frame's own space", () => {
		const nodes = [
			picked(frame("f", 100, 100, 400, 300)),
			sticky("inside", 40, 60, 100, 60, { parentId: "f" }),
			picked(sticky("loose", 600, 100, 100, 60)),
		];
		const group = groupOf(nodes);
		if (!group) throw new Error("no group");
		// The box is x 100..700, y 100..400: x1.5 across, unchanged down.
		const { patches } = resizeGroup(group, "e", { x: 300, y: 0 });
		expect(patches.get("f")).toEqual({ position: { x: 100, y: 100 }, width: 600, height: 300 });
		// Its note: places and sizes scale; its position stays relative to the frame.
		expect(patches.get("inside")).toEqual({
			position: { x: 60, y: 60 },
			width: 150,
			height: 60,
		});
		expect(patches.get("loose")?.position).toEqual({ x: 850, y: 100 });
	});

	it("keeps a picked note's frame where it is, and re-bases the note against it", () => {
		const nodes = [
			frame("f", 100, 100, 400, 300),
			picked(sticky("inside", 40, 60, 200, 100, { parentId: "f" })),
			picked(sticky("loose", 600, 100, 200, 100)),
		];
		const group = groupOf(nodes);
		if (!group) throw new Error("no group");
		// The notes run x 140..800: the left edge dragged in by half of that, about x 800.
		expect(group.box).toEqual({ x: 140, y: 100, width: 660, height: 160 });
		const { patches } = resizeGroup(group, "w", { x: 330, y: 0 });
		expect(patches.has("f")).toBe(false);
		// Absolute left 800 - 660 / 2 = 470, which is 370 from the frame's corner at 100.
		expect(patches.get("inside")).toEqual({
			position: { x: 370, y: 60 },
			width: 100,
			height: 100,
		});
		expect(patches.get("loose")?.position).toEqual({ x: 700, y: 100 });
	});

	it("a zero-sized block cannot make the scale blow up", () => {
		const group = groupOf([
			picked(sticky("a", 0, 0, 100, 60)),
			{ ...picked(sticky("b", 200, 0, 0, 0)), measured: { width: 0, height: 0 } },
		]);
		if (!group) throw new Error("no group");
		const { box } = resizeGroup(group, "se", { x: 40, y: 40 });
		expect(Number.isFinite(box.width)).toBe(true);
	});
});
