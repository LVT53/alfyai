import { describe, expect, it } from "vitest";
import {
	FRAME_INSET,
	PLACEMENT_GAP,
	type Placed,
	type PlacementRequest,
	placeBlock,
} from "./board-placement";
import type { CanvasBody, CanvasNode } from "./canvas";
import { defaultNodeWidth, estimatedNodeSize } from "./canvas-blocks";

const NOTE = { width: 190, height: 64 };
const CHART = { width: 360, height: 228 };
const DIAGRAM = { width: 480, height: 420 };

function board(
	nodes: CanvasNode[],
	viewport = { x: 0, y: 0, zoom: 1 },
): CanvasBody {
	return { version: 1, nodes, edges: [], viewport, annotations: [] };
}

function frame(
	id: string,
	x: number,
	y: number,
	width: number,
	height: number,
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
	text = "A short note",
): CanvasNode {
	return {
		id,
		type: "sticky",
		position: { x, y },
		width: 190,
		...(parentId ? { parentId } : {}),
		data: { kind: "sticky", text, tone: "yellow" },
	};
}

/** The tidy Vienna board of the eval: a Saturday frame holding four notes in two columns, a title and a checklist beside it. */
function vienna(): CanvasBody {
	return board([
		frame("sat", 40, 40, 460, 360),
		note("breakfast", 20, 56, "sat", "Breakfast at Café Central, 9:00"),
		note("museum", 230, 56, "sat", "Kunsthistorisches Museum, 11:00"),
		note("lunch", 20, 152, "sat", "Lunch at the Naschmarkt, 13:30"),
		note("walk", 230, 152, "sat", "Walk along the Ringstrasse, 16:00"),
		{
			id: "title",
			type: "text",
			position: { x: 560, y: 40 },
			data: { kind: "text", text: "Weekend in Vienna" },
		},
		{
			id: "pack",
			type: "checklist",
			position: { x: 560, y: 140 },
			data: {
				kind: "checklist",
				label: "Pack",
				items: [
					{ id: "p1", text: "Tickets", done: false },
					{ id: "p2", text: "Umbrella", done: false },
				],
			},
		},
	]);
}

/** A placed block as a node of the board, so the next one is placed against it. */
function withPlaced(
	body: CanvasBody,
	request: PlacementRequest,
	placed: Placed,
): CanvasBody {
	const added: CanvasNode = {
		id: request.id,
		type: "sticky",
		position: placed.position,
		width: request.size.width,
		...(placed.parentId ? { parentId: placed.parentId } : {}),
		data: { kind: "sticky", text: "x".repeat(10), tone: "plain" },
	};
	return { ...body, nodes: [...body.nodes, added] };
}

describe("placeBlock — the model's own place", () => {
	it("keeps a place that is free, at the top level and in a frame", () => {
		expect(
			placeBlock(vienna(), {
				id: "n",
				size: NOTE,
				position: { x: 700, y: 600 },
			}),
		).toEqual({ position: { x: 700, y: 600 }, how: "kept" });
		expect(
			placeBlock(vienna(), {
				id: "n",
				size: NOTE,
				parentId: "sat",
				position: { x: 20, y: 240 },
			}),
		).toEqual({ position: { x: 20, y: 240 }, parentId: "sat", how: "kept" });
	});

	it("moves a place that is taken to the nearest free ground, a gap from what is there", () => {
		const body = board([note("a", 100, 100)]);
		const placed = placeBlock(body, {
			id: "n",
			size: NOTE,
			position: { x: 120, y: 110 },
		});
		expect(placed).toEqual({ position: { x: 100, y: 188 }, how: "moved" });
	});

	it("moves a block that sticks out of its frame, and keeps one that is only close to the edge", () => {
		const body = vienna();
		const sticks = placeBlock(body, {
			id: "n",
			size: NOTE,
			parentId: "sat",
			position: { x: 400, y: 240 },
		});
		expect(sticks.how).toBe("moved");
		expect(sticks.parentId).toBe("sat");
		const at = sticks.position;
		expect(at.x + NOTE.width).toBeLessThanOrEqual(460 - FRAME_INSET.x);
		const snug = placeBlock(body, {
			id: "n",
			size: NOTE,
			parentId: "sat",
			position: { x: 262, y: 250 },
		});
		expect(snug).toEqual({
			position: { x: 262, y: 250 },
			parentId: "sat",
			how: "kept",
		});
	});

	it("makes a block a child of the frame its middle is over, as dropping it there does", () => {
		const placed = placeBlock(vienna(), {
			id: "n",
			size: NOTE,
			position: { x: 100, y: 260 },
		});
		expect(placed).toEqual({
			position: { x: 60, y: 220 },
			parentId: "sat",
			how: "kept",
		});
	});

	it("does not make a frame a child of another", () => {
		const placed = placeBlock(vienna(), {
			id: "f",
			asFrame: true,
			size: { width: 300, height: 200 },
			position: { x: 100, y: 100 },
		});
		expect(placed.parentId).toBeUndefined();
		expect(placed.how).toBe("moved");
	});
});

describe("placeBlock — a place it leaves out", () => {
	it("fills a new frame the way text is read: across, then the next row", () => {
		let body = board([frame("sun", 40, 460, 460, 360)]);
		const seen: Array<[number, number]> = [];
		for (let i = 0; i < 4; i += 1) {
			const request: PlacementRequest = {
				id: `n${i}`,
				size: NOTE,
				parentId: "sun",
			};
			const placed = placeBlock(body, request);
			expect(placed.how).toBe("placed");
			seen.push([placed.position.x, placed.position.y]);
			body = withPlaced(body, request, placed);
		}
		expect(seen).toEqual([
			[20, 56],
			[234, 56],
			[20, 144],
			[234, 144],
		]);
	});

	it("puts a block beside the one it names: to its right when that is free", () => {
		const body = board([note("a", 100, 100)]);
		expect(placeBlock(body, { id: "n", size: NOTE, near: "a" })).toEqual({
			position: { x: 314, y: 100 },
			how: "placed",
		});
	});

	it("puts it under the one it names when the right is taken", () => {
		const body = board([note("a", 100, 100), note("b", 314, 100)]);
		expect(placeBlock(body, { id: "n", size: NOTE, near: "a" })).toEqual({
			position: { x: 100, y: 188 },
			how: "placed",
		});
	});

	it("puts it in the frame of the one it names, on the nearest free ground there, when the block's own sides are taken", () => {
		const placed = placeBlock(vienna(), {
			id: "n",
			size: NOTE,
			near: "museum",
		});
		expect(placed).toEqual({
			position: { x: 230, y: 240 },
			parentId: "sat",
			how: "placed",
		});
	});

	it("puts it beside a frame, not in it, when the one it names is a frame", () => {
		const placed = placeBlock(vienna(), { id: "n", size: NOTE, near: "sat" });
		expect(placed.parentId).toBeUndefined();
		const absoluteBox = { ...placed.position, ...NOTE };
		expect(
			absoluteBox.x >= 500 + PLACEMENT_GAP ||
				absoluteBox.y >= 400 + PLACEMENT_GAP,
		).toBe(true);
	});

	it("takes an unnamed place on the board nearest the middle of what is on it", () => {
		const placed = placeBlock(vienna(), { id: "n", size: NOTE });
		expect(placed.how).toBe("placed");
		expect(placed.parentId).toBeUndefined();
		const box = { ...placed.position, ...NOTE };
		const taken = [
			{ x: 40, y: 40, width: 460, height: 360 },
			{ x: 560, y: 40, ...estimatedNodeSize(vienna().nodes[5]) },
			{ x: 560, y: 140, ...estimatedNodeSize(vienna().nodes[6]) },
		];
		for (const other of taken) {
			const apart =
				box.x + box.width + PLACEMENT_GAP <= other.x ||
				other.x + other.width + PLACEMENT_GAP <= box.x ||
				box.y + box.height + PLACEMENT_GAP <= other.y ||
				other.y + other.height + PLACEMENT_GAP <= box.y;
			expect(apart).toBe(true);
		}
	});

	it("puts the first block of an empty board where the first frame of a board goes", () => {
		expect(placeBlock(board([]), { id: "n", size: NOTE })).toEqual({
			position: { x: 40, y: 40 },
			how: "placed",
		});
	});

	it("puts a block where the reader is looking when the board was saved with a camera", () => {
		const body = board([note("a", 40, 40)], { x: -2000, y: -1500, zoom: 1 });
		const placed = placeBlock(body, { id: "n", size: NOTE });
		// The camera shows (2000, 1500) to (2900, 2100): the block is centred in it.
		expect(placed.position).toEqual({ x: 2355, y: 1768 });
	});
});

describe("placeBlock — a frame with no room", () => {
	it("grows the frame, downward, for a chart the four notes left no room for", () => {
		const placed = placeBlock(vienna(), {
			id: "chart",
			size: CHART,
			parentId: "sat",
		});
		expect(placed).toEqual({
			position: { x: 20, y: 240 },
			parentId: "sat",
			how: "grew",
		});
	});

	it("grows it sideways too, for a diagram wider than the frame", () => {
		const placed = placeBlock(board([frame("sat", 40, 40, 460, 360)]), {
			id: "diagram",
			size: DIAGRAM,
			parentId: "sat",
		});
		expect(placed).toEqual({
			position: { x: 20, y: 56 },
			parentId: "sat",
			how: "grew",
		});
	});

	it("puts the block beside the frame, and says so, when the ground it would grow into is taken", () => {
		const body = vienna();
		body.nodes.push(note("blocker", 40, 424));
		const placed = placeBlock(body, {
			id: "chart",
			size: CHART,
			parentId: "sat",
		});
		expect(placed.how).toBe("outside");
		expect(placed.parentId).toBeUndefined();
		const box = { ...placed.position, ...CHART };
		for (const other of body.nodes.filter((n) => !n.parentId)) {
			const rect = {
				x: other.position.x,
				y: other.position.y,
				...estimatedNodeSize(other),
			};
			const across =
				Math.min(box.x + box.width, rect.x + rect.width) -
				Math.max(box.x, rect.x);
			const down =
				Math.min(box.y + box.height, rect.y + rect.height) -
				Math.max(box.y, rect.y);
			expect(across > 1 && down > 1, other.id).toBe(false);
		}
	});

	it("does not grow a frame past the frame it is in", () => {
		const body = board([
			frame("outer", 0, 0, 500, 400),
			frame("inner", 20, 56, 460, 200, "outer"),
		]);
		const placed = placeBlock(body, {
			id: "d",
			size: DIAGRAM,
			parentId: "inner",
		});
		expect(placed.how).toBe("outside");
	});
});

describe("placeBlock — what it will not do", () => {
	it("never puts a block on another, whatever place it is given", () => {
		let seed = 7;
		const random = () => {
			seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
			return seed / 2_147_483_648;
		};
		for (let trial = 0; trial < 150; trial += 1) {
			const nodes: CanvasNode[] = [frame("f", 40, 40, 460, 360)];
			const count = 2 + Math.floor(random() * 14);
			for (let i = 0; i < count; i += 1) {
				const inFrame = random() < 0.5;
				nodes.push(
					note(
						`n${i}`,
						inFrame
							? Math.floor(random() * 240)
							: 560 + Math.floor(random() * 500),
						inFrame
							? 56 + Math.floor(random() * 250)
							: Math.floor(random() * 700),
						inFrame ? "f" : undefined,
					),
				);
			}
			const body = board(nodes);
			const size = random() < 0.5 ? NOTE : CHART;
			const request: PlacementRequest = {
				id: "new",
				size,
				...(random() < 0.6
					? {
							position: {
								x: Math.floor(random() * 900),
								y: Math.floor(random() * 700),
							},
						}
					: {}),
				...(random() < 0.4 ? { parentId: "f" } : {}),
				...(random() < 0.4 ? { near: `n${Math.floor(random() * count)}` } : {}),
			};
			const placed = placeBlock(body, request);
			const siblings = body.nodes.filter((n) => n.parentId === placed.parentId);
			const box = { ...placed.position, ...size };
			for (const other of siblings) {
				if (other.id === placed.parentId) continue;
				const rect = {
					x: other.position.x,
					y: other.position.y,
					...estimatedNodeSize(other),
				};
				const across =
					Math.min(box.x + box.width, rect.x + rect.width) -
					Math.max(box.x, rect.x);
				const down =
					Math.min(box.y + box.height, rect.y + rect.height) -
					Math.max(box.y, rect.y);
				expect(
					across > 1 && down > 1,
					`trial ${trial}: ${JSON.stringify(request)} -> ${JSON.stringify(placed)} on ${other.id}`,
				).toBe(false);
			}
			if (placed.parentId && placed.how !== "grew") {
				expect(box.x).toBeGreaterThanOrEqual(-1);
				expect(box.y).toBeGreaterThanOrEqual(-1);
				expect(box.x + box.width).toBeLessThanOrEqual(461);
				expect(box.y + box.height).toBeLessThanOrEqual(361);
			}
		}
	});

	it("answers the same for the same board and request, and a place it gave is a place it keeps", () => {
		const request: PlacementRequest = { id: "n", size: NOTE, near: "walk" };
		const first = placeBlock(vienna(), request);
		expect(placeBlock(vienna(), request)).toEqual(first);
		const again = placeBlock(vienna(), {
			id: "n",
			size: NOTE,
			position: first.position,
			...(first.parentId ? { parentId: first.parentId } : {}),
		});
		expect(again.position).toEqual(first.position);
		expect(again.how).toBe("kept");
	});

	it("is quick on a full board", () => {
		const nodes: CanvasNode[] = [];
		for (let i = 0; i < 400; i += 1) {
			nodes.push(note(`n${i}`, (i % 20) * 240, Math.floor(i / 20) * 120));
		}
		const body = board(nodes);
		const started = performance.now();
		for (let i = 0; i < 24; i += 1) {
			placeBlock(body, { id: `new${i}`, size: NOTE, near: `n${i * 3}` });
		}
		expect(performance.now() - started).toBeLessThan(2500);
	});

	it("takes a diagram's width from the one table of widths the board draws it at", () => {
		expect(defaultNodeWidth("mermaid")).toBe(DIAGRAM.width);
	});
});
