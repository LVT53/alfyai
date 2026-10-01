import { describe, expect, it } from "vitest";
import { canvasReadBlocks } from "$lib/server/services/normal-chat-tools/artifact-tools/canvas-model";
import type { CanvasBody, CanvasNode } from "$lib/shared/artifacts/canvas";
import { NODE_WIDTH } from "$lib/shared/artifacts/canvas-blocks";
import {
	absoluteOf,
	facingHandles,
	frameAt,
	heldRect,
	nodeRect,
	parentsFirst,
	rehomeOnRemoval,
	reparentOnDrop,
	resizeFloor,
	withoutDanglingEdges,
} from "./board";

function frame(
	id: string,
	x: number,
	y: number,
	width = 300,
	height = 200,
	parentId?: string,
): CanvasNode {
	return {
		id,
		type: "frame",
		position: { x, y },
		width,
		height,
		...(parentId ? { parentId } : {}),
		data: { kind: "frame", label: id, width, height },
	};
}

function note(
	id: string,
	x: number,
	y: number,
	parentId?: string,
	size?: { width: number; height: number },
): CanvasNode {
	return {
		id,
		type: "sticky",
		position: { x, y },
		...(size ?? {}),
		...(parentId ? { parentId } : {}),
		data: { kind: "sticky", text: id, tone: "yellow" },
	};
}

describe("absoluteOf", () => {
	it("is the position itself for a node on the board", () => {
		const n = note("n", 12, 34);
		expect(absoluteOf(n, [n])).toEqual({ x: 12, y: 34 });
	});

	it("adds the frame's position to a child's, which is frame-relative", () => {
		const f = frame("f", 40, 50);
		const n = note("n", 10, 20, "f");
		expect(absoluteOf(n, [f, n])).toEqual({ x: 50, y: 70 });
	});

	it("walks a chain of frames (the protocol allows a frame inside a frame)", () => {
		const outer = frame("outer", 100, 100, 600, 500);
		const inner = frame("inner", 20, 30, 300, 200, "outer");
		const n = note("n", 5, 6, "inner");
		expect(absoluteOf(n, [outer, inner, n])).toEqual({ x: 125, y: 136 });
	});

	it("takes a child whose frame is gone at the position it has, and never loops on a cycle", () => {
		const orphan = note("o", 7, 8, "nowhere");
		expect(absoluteOf(orphan, [orphan])).toEqual({ x: 7, y: 8 });
		const a = frame("a", 1, 1, 100, 100, "b");
		const b = frame("b", 2, 2, 100, 100, "a");
		expect(() => absoluteOf(a, [a, b])).not.toThrow();
	});
});

describe("nodeRect", () => {
	it("prefers what the panel measured, then the stored size, then the footprint the model is told", () => {
		const n = note("n", 10, 20, undefined, { width: 200, height: 120 });
		expect(nodeRect(n, [n], { width: 300, height: 60 })).toEqual({
			x: 10,
			y: 20,
			width: 300,
			height: 60,
		});
		expect(nodeRect(n, [n])).toEqual({ x: 10, y: 20, width: 200, height: 120 });
		// Not measured, not stored: the shared width, and as tall as its words make
		// a note (a short one is 64: RV-3 C2 — the model reads the same number).
		const bare = note("bare", 0, 0);
		expect(nodeRect(bare, [bare])).toEqual({
			x: 0,
			y: 0,
			width: NODE_WIDTH,
			height: 64,
		});
	});

	// RC-3 N1: an unmeasured chart or checklist is the size the panel draws it at,
	// the very numbers the model reads (a chart is not a note's 190 by 84).
	it("takes an unsized chart and checklist at their own default size", () => {
		const chart: CanvasNode = {
			id: "c",
			type: "chart",
			position: { x: 0, y: 0 },
			data: {
				kind: "chart",
				code: '{"type":"bar","data":{"datasets":[{"data":[1]}]}}',
			},
		};
		const list: CanvasNode = {
			id: "l",
			type: "checklist",
			position: { x: 0, y: 0 },
			data: {
				kind: "checklist",
				items: [{ id: "i", text: "x", done: false }],
			},
		};
		expect(nodeRect(chart, [chart])).toEqual({
			x: 0,
			y: 0,
			width: 360,
			height: 228,
		});
		expect(nodeRect(list, [list])).toEqual({
			x: 0,
			y: 0,
			width: 340,
			height: 100,
		});
	});

	it("is in board space: a child's rect sits inside its frame's", () => {
		const f = frame("f", 40, 50);
		const n = note("n", 10, 20, "f", { width: 100, height: 40 });
		expect(nodeRect(n, [f, n])).toEqual({
			x: 50,
			y: 70,
			width: 100,
			height: 40,
		});
	});

	it("takes a frame's size from its data when the node stores none", () => {
		const f: CanvasNode = { ...frame("f", 0, 0, 320, 240) };
		delete f.width;
		delete f.height;
		expect(nodeRect(f, [f])).toMatchObject({ width: 320, height: 240 });
	});

	it("agrees, to the number, with the size the model reads for a node with no stored size", () => {
		const body: CanvasBody = {
			version: 1,
			nodes: [note("bare", 0, 0)],
			edges: [],
			viewport: { x: 0, y: 0, zoom: 1 },
			annotations: [],
		};
		const [block] = canvasReadBlocks(body);
		const rect = nodeRect(body.nodes[0], body.nodes);
		expect(block).toMatchObject({ width: rect.width, height: rect.height });
	});
});

describe("frameAt", () => {
	const outer = frame("outer", 0, 0, 600, 500);
	const inner = frame("inner", 100, 100, 200, 150, "outer");
	const lone = frame("lone", 800, 0, 200, 200);
	const all = [outer, inner, lone];

	it("finds the frame that holds a point, and null when none does", () => {
		expect(frameAt({ x: 850, y: 50 }, all)?.id).toBe("lone");
		expect(frameAt({ x: 700, y: 700 }, all)).toBeNull();
	});

	it("chooses the innermost frame when frames nest", () => {
		// Inside `inner` (absolute 100..300 x 100..250) and inside `outer`.
		expect(frameAt({ x: 150, y: 150 }, all)?.id).toBe("inner");
		expect(frameAt({ x: 400, y: 400 }, all)?.id).toBe("outer");
	});

	it("chooses the smaller frame when two frames overlap, and the later one on a tie", () => {
		const big = frame("big", 0, 0, 400, 400);
		const small = frame("small", 50, 50, 100, 100);
		expect(frameAt({ x: 60, y: 60 }, [big, small])?.id).toBe("small");
		const twinA = frame("twin-a", 0, 0, 100, 100);
		const twinB = frame("twin-b", 0, 0, 100, 100);
		expect(frameAt({ x: 10, y: 10 }, [twinA, twinB])?.id).toBe("twin-b");
	});

	it("leaves out the node being asked about and whatever sits inside it", () => {
		expect(frameAt({ x: 150, y: 150 }, all, "inner")?.id).toBe("outer");
		// A frame is never its own target, nor is anything inside it.
		expect(frameAt({ x: 150, y: 150 }, all, "outer")).toBeNull();
	});
});

describe("reparentOnDrop", () => {
	const friday = frame("friday", 40, 40, 300, 200);
	const saturday = frame("saturday", 500, 40, 300, 200);

	it("adopts a node whose centre is inside a frame", () => {
		const n = note("n", 100, 100, undefined, { width: 100, height: 40 });
		const patch = reparentOnDrop(n, [friday, saturday, n]);
		expect(patch?.parentId).toBe("friday");
	});

	it("decides on the centre, not a corner: half over the edge either way", () => {
		// Friday spans x 40..340. Top-left outside (10), centre inside (60 + 50).
		const spilling = note("a", 10, 100, undefined, { width: 100, height: 40 });
		expect(reparentOnDrop(spilling, [friday, spilling])?.parentId).toBe(
			"friday",
		);
		// Top-left inside (300), centre outside (300 + 50 = 350 > 340).
		const hanging = note("b", 300, 100, undefined, { width: 100, height: 40 });
		expect(reparentOnDrop(hanging, [friday, hanging])).toBeNull();
	});

	it("re-bases the adopted node's position to be frame-relative", () => {
		const n = note("n", 100, 100, undefined, { width: 100, height: 40 });
		const patch = reparentOnDrop(n, [friday, n]);
		expect(patch?.position).toEqual({ x: 60, y: 60 });
	});

	it("releases a node dragged fully out of its frame and keeps its absolute position", () => {
		// Frame-relative (700, 20) in a frame at (40, 40): absolute (740, 60), outside it.
		const n = note("n", 700, 20, "friday", { width: 100, height: 40 });
		const patch = reparentOnDrop(n, [friday, n]);
		expect(patch).not.toBeNull();
		expect("parentId" in (patch ?? {})).toBe(true);
		expect(patch?.parentId).toBeUndefined();
		expect(patch?.position).toEqual({ x: 740, y: 60 });
	});

	it("does nothing when an unparented node is dropped outside every frame", () => {
		const n = note("n", 900, 600, undefined, { width: 100, height: 40 });
		expect(reparentOnDrop(n, [friday, saturday, n])).toBeNull();
	});

	it("never adopts a frame into another frame", () => {
		const f = frame("f", 100, 100, 100, 80);
		expect(reparentOnDrop(f, [friday, f])).toBeNull();
	});

	it("chooses the innermost frame when frames nest or overlap", () => {
		const outer = frame("outer", 0, 0, 600, 500);
		const inner = frame("inner", 100, 100, 200, 150, "outer");
		const n = note("n", 150, 150, undefined, { width: 40, height: 20 });
		expect(reparentOnDrop(n, [outer, inner, n])?.parentId).toBe("inner");
	});

	it("does not adopt a node into the frame it is already in, so a nudge is not rewritten", () => {
		const n = note("n", 30, 30, "friday", { width: 100, height: 40 });
		expect(reparentOnDrop(n, [friday, n])).toBeNull();
	});

	it("clears a stale extent when the node leaves its frame, and always names the key so a merge overwrites it", () => {
		const n = note("n", 700, 20, "friday", { width: 100, height: 40 });
		const patch = reparentOnDrop(n, [friday, n]);
		expect(patch && "extent" in patch).toBe(true);
		expect(patch?.extent).toBeUndefined();
		const adopted = reparentOnDrop(
			note("m", 100, 100, undefined, { width: 100, height: 40 }),
			[friday, note("m", 100, 100, undefined, { width: 100, height: 40 })],
		);
		expect(adopted && "extent" in adopted).toBe(true);
	});

	it("moves a node straight from one frame to another, re-based to the new one", () => {
		// Frame-relative (480, 20) in Friday: absolute (520, 60), inside Saturday (500..800).
		const n = note("n", 480, 20, "friday", { width: 100, height: 40 });
		const patch = reparentOnDrop(n, [friday, saturday, n]);
		expect(patch?.parentId).toBe("saturday");
		expect(patch?.position).toEqual({ x: 20, y: 20 });
	});

	it("takes the drop point to be the node's centre, from what the panel measured", () => {
		const f = frame("f", 100, 100, 200, 200);
		// Top-left outside the frame, but 400x400 wide: the centre (200, 200) is inside.
		const wide = note("w", 0, 0);
		expect(
			reparentOnDrop(wide, [f, wide], { width: 400, height: 400 })?.parentId,
		).toBe("f");
		// The default footprint's centre (95, 42) is outside.
		expect(reparentOnDrop(wide, [f, wide])).toBeNull();
	});

	it("releases a nested frame dragged out of its frame to the board, and never adopts it elsewhere", () => {
		const outer = frame("outer", 0, 0, 400, 300);
		const inner = frame("inner", 500, 20, 150, 100, "outer");
		// Absolute (500, 20): outside `outer`.
		const patch = reparentOnDrop(inner, [outer, inner]);
		expect(patch?.parentId).toBeUndefined();
		expect(patch?.position).toEqual({ x: 500, y: 20 });
		const other = frame("other", 480, 0, 400, 300);
		const moved = reparentOnDrop(inner, [outer, other, inner]);
		expect(moved?.parentId).toBeUndefined();
	});
});

describe("rehomeOnRemoval", () => {
	it("moves a removed frame's children up to the board, keeping their place on screen", () => {
		const f = frame("f", 40, 50);
		const n = note("n", 10, 20, "f");
		const patches = rehomeOnRemoval(new Set(["f"]), [f, n]);
		expect(patches.get("n")).toEqual({
			parentId: undefined,
			position: { x: 50, y: 70 },
		});
	});

	it("moves them to the removed frame's own frame when it has one", () => {
		const outer = frame("outer", 100, 100, 600, 500);
		const inner = frame("inner", 20, 30, 300, 200, "outer");
		const n = note("n", 5, 6, "inner");
		const patches = rehomeOnRemoval(new Set(["inner"]), [outer, inner, n]);
		expect(patches.get("n")).toEqual({
			parentId: "outer",
			position: { x: 25, y: 36 },
		});
	});

	it("goes to the nearest frame that survives when a chain of frames is removed", () => {
		const outer = frame("outer", 100, 100, 600, 500);
		const inner = frame("inner", 20, 30, 300, 200, "outer");
		const n = note("n", 5, 6, "inner");
		const patches = rehomeOnRemoval(new Set(["outer", "inner"]), [
			outer,
			inner,
			n,
		]);
		expect(patches.get("n")).toEqual({
			parentId: undefined,
			position: { x: 125, y: 136 },
		});
	});

	it("leaves alone what does not sit directly in a removed frame", () => {
		const f = frame("f", 40, 50);
		const inside = note("inside", 10, 20, "f");
		const stray = note("stray", 5, 5);
		const patches = rehomeOnRemoval(new Set(["stray"]), [f, inside, stray]);
		expect(patches.size).toBe(0);
	});
});

describe("parentsFirst", () => {
	it("returns the very same array when every parent is already ahead of its children", () => {
		const list = [frame("f", 0, 0), note("n", 1, 1, "f"), note("m", 2, 2)];
		expect(parentsFirst(list)).toBe(list);
	});

	it("moves a parent ahead of a child that was adopted into it later in the list", () => {
		const child = note("n", 1, 1, "f");
		const parent = frame("f", 0, 0);
		const other = note("m", 2, 2);
		expect(parentsFirst([child, other, parent]).map((n) => n.id)).toEqual([
			"f",
			"n",
			"m",
		]);
	});

	it("survives a cycle without dropping or repeating a node", () => {
		const a = frame("a", 0, 0, 10, 10, "b");
		const b = frame("b", 0, 0, 10, 10, "a");
		expect(
			parentsFirst([a, b])
				.map((n) => n.id)
				.sort(),
		).toEqual(["a", "b"]);
	});
});

describe("facingHandles", () => {
	const at = (x: number, y: number) => note(`n${x}-${y}`, x, y);

	it("leaves the side of the source that faces the target, and arrives at the side facing back", () => {
		const a = at(0, 0);
		expect(facingHandles(a, at(400, 10), [a])).toEqual({
			sourceHandle: "right",
			targetHandle: "left",
		});
		expect(facingHandles(a, at(-400, 10), [a])).toEqual({
			sourceHandle: "left",
			targetHandle: "right",
		});
		expect(facingHandles(a, at(10, 300), [a])).toEqual({
			sourceHandle: "bottom",
			targetHandle: "top",
		});
		expect(facingHandles(a, at(10, -300), [a])).toEqual({
			sourceHandle: "top",
			targetHandle: "bottom",
		});
	});

	it("runs bottom to top for two blocks in the same place", () => {
		const a = at(0, 0);
		const b = at(0, 0);
		expect(facingHandles(a, b, [a, b])).toEqual({
			sourceHandle: "bottom",
			targetHandle: "top",
		});
	});

	it("measures from the blocks' centres in board space, so a framed note compares like a loose one", () => {
		const f = frame("f", 1000, 0);
		const inFrame = note("in", 10, 10, "f");
		const loose = note("loose", 0, 0);
		// The framed note sits at x = 1010, far to the right of the loose one.
		expect(facingHandles(loose, inFrame, [f, inFrame, loose])).toEqual({
			sourceHandle: "right",
			targetHandle: "left",
		});
	});
});

describe("withoutDanglingEdges", () => {
	const nodes = [note("a", 0, 0), note("b", 1, 1)];

	it("drops an edge whose end is not on the board, and nothing else", () => {
		const edges = [
			{ id: "1", source: "a", target: "b" },
			{ id: "2", source: "a", target: "gone" },
			{ id: "3", source: "gone", target: "b" },
		];
		expect(withoutDanglingEdges(edges, nodes).map((e) => e.id)).toEqual(["1"]);
	});

	it("hands back the same array when there was nothing to drop", () => {
		const edges = [{ id: "1", source: "a", target: "b" }];
		expect(withoutDanglingEdges(edges, nodes)).toBe(edges);
	});
});

describe("heldRect", () => {
	it("is the rectangle around everything inside the frame, in board space", () => {
		const all = [
			frame("f", 100, 50, 400, 300),
			note("a", 20, 30, "f", { width: 100, height: 60 }),
			note("b", 200, 150, "f", { width: 120, height: 80 }),
		];
		expect(heldRect(all[0], all)).toEqual({
			x: 120,
			y: 80,
			width: 300,
			height: 200,
		});
	});

	it("leaves out what is not in the frame, and is null for a frame that holds nothing", () => {
		const all = [
			frame("f", 0, 0, 300, 200),
			note("loose", 10, 10, undefined, { width: 50, height: 50 }),
		];
		expect(heldRect(all[0], all)).toBeNull();
	});

	it("counts only the part of a block that is inside, so a block hanging out is not held against the reader", () => {
		const all = [
			frame("f", 0, 0, 300, 200),
			note("wide", 200, 20, "f", { width: 400, height: 50 }),
		];
		expect(heldRect(all[0], all)).toEqual({
			x: 200,
			y: 20,
			width: 100,
			height: 50,
		});
		const outside = [
			frame("f", 0, 0, 300, 200),
			note("gone", 500, 20, "f", { width: 50, height: 50 }),
		];
		expect(heldRect(outside[0], outside)).toBeNull();
	});

	it("takes a nested frame as one of the blocks it holds", () => {
		const all = [
			frame("outer", 0, 0, 500, 400),
			frame("inner", 100, 100, 200, 150, "outer"),
		];
		expect(heldRect(all[0], all)).toEqual({
			x: 100,
			y: 100,
			width: 200,
			height: 150,
		});
	});
});

describe("resizeFloor", () => {
	// A frame at (100, 50), 400 x 300, holding a block from (120, 80) to (420, 280).
	const frameRect = { x: 100, y: 50, width: 400, height: 300 };
	const held = { x: 120, y: 80, width: 300, height: 200 };

	it("lets the right side come in to the right edge of what is inside, and no further", () => {
		expect(resizeFloor(frameRect, held, "right")).toEqual({
			width: 320,
			height: 0,
		});
	});

	it("lets the bottom side come in to the bottom edge of what is inside", () => {
		expect(resizeFloor(frameRect, held, "bottom")).toEqual({
			width: 0,
			height: 230,
		});
	});

	it("measures the left and top sides from the far edge, which does not move", () => {
		// Right edge 500, what is inside starts at 120: the frame may be 380 wide.
		expect(resizeFloor(frameRect, held, "left")).toEqual({
			width: 380,
			height: 0,
		});
		// Bottom edge 350, what is inside starts at 80: the frame may be 270 high.
		expect(resizeFloor(frameRect, held, "top")).toEqual({
			width: 0,
			height: 270,
		});
	});

	it("asks both axes of a corner", () => {
		expect(resizeFloor(frameRect, held, "bottom-right")).toEqual({
			width: 320,
			height: 230,
		});
		expect(resizeFloor(frameRect, held, "top-left")).toEqual({
			width: 380,
			height: 270,
		});
		expect(resizeFloor(frameRect, held, "top-right")).toEqual({
			width: 320,
			height: 270,
		});
		expect(resizeFloor(frameRect, held, "bottom-left")).toEqual({
			width: 380,
			height: 230,
		});
	});

	it("asks nothing of a frame that holds nothing", () => {
		expect(resizeFloor(frameRect, null, "right")).toEqual({
			width: 0,
			height: 0,
		});
	});

	it("does not change when the frame is moved: a size, not a place", () => {
		const moved = { x: 400, y: 300, width: 400, height: 300 };
		const heldMoved = { x: 420, y: 330, width: 300, height: 200 };
		expect(resizeFloor(moved, heldMoved, "bottom-right")).toEqual(
			resizeFloor(frameRect, held, "bottom-right"),
		);
	});

	it("rounds up, so the stop is never a pixel short of the block", () => {
		expect(
			resizeFloor(frameRect, { ...held, width: 300.2 }, "right").width,
		).toBe(321);
	});
});
