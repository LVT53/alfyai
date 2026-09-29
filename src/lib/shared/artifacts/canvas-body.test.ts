import { describe, expect, it } from "vitest";
import type { Annotation, CanvasBody, CanvasNode } from "./canvas";
import {
	boardJson,
	emptyCanvasBody,
	MAX_ANNOTATIONS_PER_BOARD,
	MAX_POINTS_PER_STROKE,
	normalizeCanvasBody,
} from "./canvas-body";
import { cloneBoard, sampleBoard } from "./canvas-fixtures.test-helpers";

function sticky(id: string, extra: Partial<CanvasNode> = {}): CanvasNode {
	return {
		id,
		type: "sticky",
		position: { x: 0, y: 0 },
		data: { kind: "sticky", text: id, tone: "plain" },
		...extra,
	};
}

function withX(x: number): CanvasBody {
	const board = sampleBoard();
	board.nodes[2] = { ...board.nodes[2], position: { x, y: 60 } };
	return board;
}

describe("boardJson — the canonical form (ruling 12)", () => {
	it("round-trips a canonical body through normalizeCanvasBody and boardJson unchanged", () => {
		const sample = sampleBoard();
		const { body, dropped } = normalizeCanvasBody(sample);
		expect(dropped).toEqual({ nodes: [], edges: [], annotations: [] });
		expect(body).toEqual(sample);
		expect(JSON.parse(boardJson(body))).toEqual(sample);
	});

	it("open → boardJson → normalizeCanvasBody → boardJson gives an identical body with no user edit", () => {
		const once = boardJson(normalizeCanvasBody(sampleBoard()).body);
		const twice = boardJson(normalizeCanvasBody(JSON.parse(once)).body);
		expect(twice).toBe(once);
	});

	it("is a fixed point for a hand-edited body too: whatever normalize repairs, one more pass changes nothing", () => {
		const messy = {
			nodes: [
				{
					...sticky("late-child"),
					parentId: "frame-x",
					position: { x: 1.00004, y: 2 },
				},
				{
					id: "frame-x",
					type: "frame",
					position: { x: 10, y: 10 },
					data: { kind: "frame", label: "F", width: 100, height: 80 },
				},
				{ id: "junk", type: "nonsense", position: { x: 0, y: 0 }, data: {} },
			],
			edges: [{ id: "e", source: "late-child", target: "junk" }],
			annotations: [
				{
					id: "a",
					kind: "pen",
					color: "red",
					size: 2,
					points: [{ x: 0, y: 0 }],
				},
			],
		};
		const once = boardJson(normalizeCanvasBody(messy).body);
		const twice = boardJson(normalizeCanvasBody(JSON.parse(once)).body);
		expect(twice).toBe(once);
	});

	it("emits the keys in the documented order", () => {
		const json = boardJson(sampleBoard());
		expect(Object.keys(JSON.parse(json))).toEqual([
			"version",
			"nodes",
			"edges",
			"viewport",
			"annotations",
		]);
		const node = JSON.parse(json).nodes[1];
		expect(Object.keys(node)).toEqual([
			"id",
			"type",
			"position",
			"parentId",
			"width",
			"height",
			"data",
		]);
		expect(Object.keys(JSON.parse(json).annotations[0])).toEqual([
			"id",
			"kind",
			"color",
			"size",
			"points",
		]);
	});

	it("hashes the same body identically when the library reordered a live node's fields and wrote its state back", () => {
		const plain = sampleBoard();
		const live = sampleBoard();
		live.nodes = live.nodes.map((node) => {
			// Svelte Flow writes these onto the object it was handed, and a
			// spread in another order moves the keys around.
			const { id, type, position, data, ...rest } = node;
			return {
				measured: { width: 190, height: 84 },
				selected: true,
				dragging: false,
				zIndex: 3,
				extent: "parent",
				highlight: true,
				data,
				position,
				type,
				id,
				...rest,
			} as CanvasNode;
		});
		expect(boardJson(live)).toBe(boardJson(plain));
		expect(boardJson(live)).not.toContain("measured");
		expect(boardJson(live)).not.toContain("selected");
		expect(boardJson(live)).not.toContain("dragging");
		expect(boardJson(live)).not.toContain("zIndex");
		expect(boardJson(live)).not.toContain("extent");
		expect(boardJson(live)).not.toContain("highlight");
	});

	it("rounds a float-noise position to the same body as its rounded twin", () => {
		expect(boardJson(withX(412.00000000000006))).toBe(boardJson(withX(412)));
		expect(boardJson(withX(412.0004))).toBe(boardJson(withX(412)));
		expect(boardJson(withX(412.0006))).not.toBe(boardJson(withX(412)));
	});

	it("rounds every geometry field: sizes, the camera and the strokes", () => {
		const board = sampleBoard();
		board.viewport = { x: -20.0000001, y: 10.0004, zoom: 0.80000001 };
		board.nodes[0] = { ...board.nodes[0], width: 360.0000002 };
		const parsed = JSON.parse(boardJson(board));
		expect(parsed.viewport).toEqual({ x: -20, y: 10, zoom: 0.8 });
		expect(parsed.nodes[0].width).toBe(360);
	});

	it("omits an undefined optional field instead of emitting null", () => {
		const board = sampleBoard();
		board.nodes[2] = {
			...board.nodes[2],
			parentId: undefined,
			width: undefined,
			height: undefined,
		};
		board.edges = [
			{ id: "e", source: "note-1", target: "text-1", label: undefined },
		];
		const parsed = JSON.parse(boardJson(board));
		expect(parsed.nodes[2]).not.toHaveProperty("parentId");
		expect(parsed.nodes[2]).not.toHaveProperty("width");
		expect(parsed.edges[0]).not.toHaveProperty("label");
	});

	it("keeps an empty annotations array as [] rather than omitting it", () => {
		expect(JSON.parse(boardJson(emptyCanvasBody()))).toEqual({
			version: 1,
			nodes: [],
			edges: [],
			viewport: { x: 0, y: 0, zoom: 1 },
			annotations: [],
		});
	});

	it("includes the camera: two boards that differ only in viewport have different canonical JSON, so the client must compare boardJson, not object identity", () => {
		const a = sampleBoard();
		const b = sampleBoard();
		b.viewport = { x: 500, y: 500, zoom: 1 };
		expect(boardJson(a)).not.toBe(boardJson(b));
	});

	it("never emits a non-finite number: null in the JSON would silently change the meaning", () => {
		const board = sampleBoard();
		board.nodes[2] = {
			...board.nodes[2],
			position: { x: Number.NaN, y: Number.POSITIVE_INFINITY },
		};
		board.viewport = { x: 0, y: 0, zoom: Number.NaN };
		const parsed = JSON.parse(boardJson(board));
		expect(parsed.nodes[2].position).toEqual({ x: 0, y: 0 });
		expect(parsed.viewport.zoom).toBe(1);
	});

	it("orders every kind's data the same way whatever order it arrived in", () => {
		const a = sampleBoard();
		const b = sampleBoard();
		b.nodes = b.nodes.map((node) => {
			const entries = Object.entries(node.data).reverse();
			return {
				...node,
				data: Object.fromEntries(entries) as CanvasNode["data"],
			};
		});
		expect(boardJson(b)).toBe(boardJson(a));
	});
});

describe("normalizeCanvasBody — validate, never throw", () => {
	it("drops an unknown node kind and reports it instead of throwing", () => {
		const raw = cloneBoard(sampleBoard());
		raw.nodes.push({
			id: "future-1",
			type: "hologram",
			position: { x: 0, y: 0 },
			data: { kind: "hologram" },
		} as unknown as CanvasNode);
		const { body, dropped } = normalizeCanvasBody(raw);
		expect(body.nodes.map((n) => n.id)).not.toContain("future-1");
		expect(dropped.nodes).toEqual(["future-1"]);
	});

	it("drops a node whose data does not match its kind, and one whose type and data.kind disagree", () => {
		const raw = cloneBoard(sampleBoard());
		raw.nodes.push(
			{
				id: "bad-data",
				type: "sticky",
				position: { x: 0, y: 0 },
				data: { kind: "sticky", text: 12, tone: "plain" },
			} as unknown as CanvasNode,
			{
				id: "bad-mix",
				type: "text",
				position: { x: 0, y: 0 },
				data: { kind: "sticky", text: "x", tone: "plain" },
			} as unknown as CanvasNode,
		);
		const { body, dropped } = normalizeCanvasBody(raw);
		expect(dropped.nodes).toEqual(["bad-data", "bad-mix"]);
		expect(body.nodes).toHaveLength(sampleBoard().nodes.length);
	});

	it("drops a node with no usable position or id, naming it by its index when it has no id", () => {
		const { body, dropped } = normalizeCanvasBody({
			nodes: [
				{ id: "no-pos", type: "text", data: { kind: "text", text: "x" } },
				{
					type: "text",
					position: { x: 0, y: 0 },
					data: { kind: "text", text: "x" },
				},
				sticky("fine"),
			],
		});
		expect(body.nodes.map((n) => n.id)).toEqual(["fine"]);
		expect(dropped.nodes).toEqual(["no-pos", "#1"]);
	});

	it("drops an edge whose endpoint is missing", () => {
		const raw = cloneBoard(sampleBoard());
		raw.edges.push({ id: "dangling", source: "note-1", target: "ghost" });
		const { body, dropped } = normalizeCanvasBody(raw);
		expect(body.edges.map((e) => e.id)).toEqual(["edge-1"]);
		expect(dropped.edges).toEqual(["dangling"]);
	});

	it("drops the edges of a node it dropped", () => {
		const raw = cloneBoard(sampleBoard());
		raw.nodes.push({
			id: "future-1",
			type: "hologram",
			position: { x: 0, y: 0 },
			data: {},
		} as unknown as CanvasNode);
		raw.edges.push({ id: "to-future", source: "note-1", target: "future-1" });
		const { body, dropped } = normalizeCanvasBody(raw);
		expect(body.edges.map((e) => e.id)).toEqual(["edge-1"]);
		expect(dropped.edges).toEqual(["to-future"]);
	});

	it("takes a child whose frame is gone out of the frame and keeps it, at the position it was stored with", () => {
		const raw = cloneBoard(sampleBoard());
		raw.nodes = raw.nodes.filter((n) => n.id !== "frame-a");
		const { body, dropped } = normalizeCanvasBody(raw);
		const child = body.nodes.find((n) => n.id === "note-1");
		expect(child).toBeDefined();
		expect(child).not.toHaveProperty("parentId");
		expect(child?.position).toEqual({ x: 20, y: 60 });
		// Nothing was left out: the child is still on the board.
		expect(dropped.nodes).toEqual([]);
	});

	it("takes a child whose parent is not a frame out of it", () => {
		const raw = cloneBoard(sampleBoard());
		raw.nodes[2] = { ...raw.nodes[2], parentId: "text-1" };
		const { body } = normalizeCanvasBody(raw);
		expect(body.nodes.find((n) => n.id === "note-museum")).not.toHaveProperty(
			"parentId",
		);
	});

	it("breaks a frame cycle at the first node that closes it and keeps every node", () => {
		const frame = (id: string, parentId: string): CanvasNode => ({
			id,
			type: "frame",
			parentId,
			position: { x: 0, y: 0 },
			data: { kind: "frame", label: id, width: 100, height: 100 },
		});
		const { body } = normalizeCanvasBody({
			nodes: [
				frame("a", "b"),
				frame("b", "c"),
				frame("c", "b"),
				sticky("s", { parentId: "a" }),
			],
		});
		expect(body.nodes).toHaveLength(4);
		const byId = new Map(body.nodes.map((n) => [n.id, n]));
		// No chain of parents may revisit a node.
		for (const node of body.nodes) {
			const seen = new Set<string>();
			let cursor: CanvasNode | undefined = node;
			while (cursor) {
				expect(seen.has(cursor.id)).toBe(false);
				seen.add(cursor.id);
				cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
			}
		}
	});

	it("takes a frame out of itself", () => {
		const { body } = normalizeCanvasBody({
			nodes: [
				{
					id: "f",
					type: "frame",
					parentId: "f",
					position: { x: 0, y: 0 },
					data: { kind: "frame", label: "f", width: 10, height: 10 },
				},
			],
		});
		expect(body.nodes[0]).not.toHaveProperty("parentId");
	});

	it("puts a parent before its children, keeping every other node where it was", () => {
		const { body } = normalizeCanvasBody({
			nodes: [
				sticky("first"),
				sticky("child", { parentId: "frame" }),
				sticky("last"),
				{
					id: "frame",
					type: "frame",
					position: { x: 0, y: 0 },
					data: { kind: "frame", label: "F", width: 100, height: 100 },
				},
			],
		});
		expect(body.nodes.map((n) => n.id)).toEqual([
			"first",
			"frame",
			"child",
			"last",
		]);
	});

	it("keeps the first of two nodes with the same id and reports the second", () => {
		const { body, dropped } = normalizeCanvasBody({
			nodes: [
				sticky("dup", {
					data: { kind: "sticky", text: "first", tone: "plain" },
				}),
				sticky("dup", {
					data: { kind: "sticky", text: "second", tone: "plain" },
				}),
			],
		});
		expect(body.nodes).toHaveLength(1);
		expect(body.nodes[0].data).toMatchObject({ text: "first" });
		expect(dropped.nodes).toEqual(["dup"]);
	});

	it("keeps the first of two edges or annotations with the same id", () => {
		const raw = cloneBoard(sampleBoard());
		raw.edges.push({ id: "edge-1", source: "text-1", target: "note-1" });
		raw.annotations.push({ ...raw.annotations[0] });
		const { body, dropped } = normalizeCanvasBody(raw);
		expect(body.edges).toHaveLength(1);
		expect(dropped.edges).toEqual(["edge-1"]);
		expect(body.annotations).toHaveLength(3);
		expect(dropped.annotations).toEqual(["ann-pen"]);
	});

	it("strips the library's write-backs and any unknown key from a node and from its data", () => {
		const raw = cloneBoard(sampleBoard()) as unknown as {
			nodes: Record<string, unknown>[];
		};
		raw.nodes[1] = {
			...raw.nodes[1],
			selected: true,
			measured: { width: 1, height: 2 },
			stray: "x",
			data: { kind: "sticky", text: "Lunch", tone: "yellow", stray: 1 },
		};
		const { body } = normalizeCanvasBody(raw);
		const stored = JSON.stringify(body);
		expect(stored).not.toContain("selected");
		expect(stored).not.toContain("measured");
		expect(stored).not.toContain("stray");
	});

	it("tolerates a body with a missing or broken viewport by defaulting to the origin at zoom 1", () => {
		for (const viewport of [
			undefined,
			null,
			"far",
			{ x: "a" },
			{ x: 1, y: 2, zoom: 0 },
			{ x: 1, y: 2, zoom: -3 },
		]) {
			const { body } = normalizeCanvasBody({ nodes: [], viewport });
			expect(body.viewport.zoom).toBeGreaterThan(0);
			expect(Number.isFinite(body.viewport.x)).toBe(true);
		}
		expect(normalizeCanvasBody({ nodes: [] }).body.viewport).toEqual({
			x: 0,
			y: 0,
			zoom: 1,
		});
		expect(
			normalizeCanvasBody({ viewport: { x: 5, y: 6, zoom: 2 } }).body.viewport,
		).toEqual({
			x: 5,
			y: 6,
			zoom: 2,
		});
	});

	it("never throws, and answers an empty board, for anything that is not a body", () => {
		for (const raw of [
			undefined,
			null,
			0,
			"board",
			[],
			[[]],
			{ nodes: "x", edges: 3, annotations: {} },
			{ nodes: [null, 5, "x", []] },
		]) {
			const { body } = normalizeCanvasBody(raw);
			expect(body.version).toBe(1);
			expect(Array.isArray(body.nodes)).toBe(true);
		}
	});

	it("refuses a non-finite number rather than storing it", () => {
		const { body, dropped } = normalizeCanvasBody({
			nodes: [
				sticky("nan", { position: { x: Number.NaN, y: 0 } }),
				sticky("ok", { width: Number.POSITIVE_INFINITY, height: -5 }),
			],
		});
		expect(dropped.nodes).toEqual(["nan"]);
		expect(body.nodes[0]).not.toHaveProperty("width");
		expect(body.nodes[0]).not.toHaveProperty("height");
	});
});

describe("normalizeCanvasBody — what a block may carry", () => {
	it("refuses an image that is not one of the app's own paths, so a board never loads a picture from outside", () => {
		const raw = cloneBoard(sampleBoard());
		raw.nodes[9] = {
			id: "photo-evil",
			type: "photo",
			position: { x: 0, y: 0 },
			data: {
				kind: "photo",
				items: [
					{ id: "p", imageUrl: "https://evil.example/pixel.png?d=secret" },
				],
			},
		} as CanvasNode;
		const { body, dropped } = normalizeCanvasBody(raw);
		expect(body.nodes.find((n) => n.id === "photo-evil")).toBeUndefined();
		expect(dropped.nodes).toEqual(["photo-evil"]);
		for (const imageUrl of [
			"//evil.example/x.png",
			"javascript:alert(1)",
			"data:image/png;base64,AAAA",
		]) {
			const r = cloneBoard(sampleBoard());
			r.nodes[9] = {
				...r.nodes[9],
				data: { kind: "photo", items: [{ id: "p", imageUrl }] },
			} as CanvasNode;
			expect(normalizeCanvasBody(r).dropped.nodes).toEqual(["photo-1"]);
		}
	});

	it("refuses a source link that is not http or https", () => {
		const raw = cloneBoard(sampleBoard());
		const web = raw.nodes[10];
		if (web.data.kind !== "liveweb") throw new Error("fixture");
		web.data.sources[0] = {
			...web.data.sources[0],
			url: "javascript:alert(1)",
		};
		expect(normalizeCanvasBody(raw).dropped.nodes).toEqual(["web-1"]);
	});

	it("caps a checklist's length instead of letting one node hold the board's whole budget", () => {
		const raw = cloneBoard(sampleBoard());
		raw.nodes[4] = {
			id: "todo-1",
			type: "checklist",
			position: { x: 0, y: 0 },
			data: {
				kind: "checklist",
				items: Array.from({ length: 300 }, (_, i) => ({
					id: `i${i}`,
					text: "x",
					done: false,
				})),
			},
		};
		expect(normalizeCanvasBody(raw).dropped.nodes).toEqual(["todo-1"]);
	});
});

describe("normalizeCanvasBody — annotations", () => {
	function stroke(id: string, points: { x: number; y: number }[]): Annotation {
		return { id, kind: "pen", color: "#2f6fd0", size: 3, points };
	}

	it("caps a 5000-point stroke by decimating on distance, not on index, and never clips an end", () => {
		// 4500 points jittering inside one unit, then 500 points along a
		// 1000-unit line. Thinning by index would keep ~1125 of the cluster
		// and ~125 of the line; thinning by distance keeps the line's shape.
		const points = [
			...Array.from({ length: 4500 }, (_, i) => ({
				x: (i % 10) * 0.001,
				y: (i % 7) * 0.001,
			})),
			...Array.from({ length: 500 }, (_, i) => ({ x: 10 + i * 2, y: 0 })),
		];
		const { body, dropped } = normalizeCanvasBody({
			annotations: [stroke("s", points)],
		});
		const kept = body.annotations[0].points ?? [];
		expect(kept.length).toBeLessThanOrEqual(MAX_POINTS_PER_STROKE);
		expect(kept[0]).toEqual(points[0]);
		expect(kept[kept.length - 1]).toEqual(points[points.length - 1]);
		expect(kept.filter((p) => p.x >= 10).length).toBeGreaterThanOrEqual(400);
		// Every kept point is one the user drew, and the line's points stay in order.
		const drawn = new Set(points.map((p) => `${p.x},${p.y}`));
		expect(kept.every((p) => drawn.has(`${p.x},${p.y}`))).toBe(true);
		const lineXs = kept.filter((p) => p.x >= 10).map((p) => p.x);
		expect(lineXs).toEqual([...lineXs].sort((a, b) => a - b));
		expect(dropped.annotations).toEqual([]);
	});

	it("leaves a stroke at or under the cap alone", () => {
		const points = Array.from({ length: MAX_POINTS_PER_STROKE }, (_, i) => ({
			x: i,
			y: i,
		}));
		const { body } = normalizeCanvasBody({
			annotations: [stroke("s", points)],
		});
		expect(body.annotations[0].points).toHaveLength(MAX_POINTS_PER_STROKE);
	});

	it("keeps a stroke that never moved as its two ends", () => {
		const points = Array.from({ length: 2000 }, () => ({ x: 5, y: 5 }));
		const { body } = normalizeCanvasBody({
			annotations: [stroke("dot", points)],
		});
		expect(body.annotations[0].points).toEqual([
			{ x: 5, y: 5 },
			{ x: 5, y: 5 },
		]);
	});

	it("caps the annotation count, keeps the earliest, and reports the ids it dropped", () => {
		const annotations = Array.from(
			{ length: MAX_ANNOTATIONS_PER_BOARD + 3 },
			(_, i) => stroke(`s${i}`, [{ x: i, y: 0 }]),
		);
		const { body, dropped } = normalizeCanvasBody({ annotations });
		expect(body.annotations).toHaveLength(MAX_ANNOTATIONS_PER_BOARD);
		expect(body.annotations[0].id).toBe("s0");
		expect(dropped.annotations).toEqual([
			`s${MAX_ANNOTATIONS_PER_BOARD}`,
			`s${MAX_ANNOTATIONS_PER_BOARD + 1}`,
			`s${MAX_ANNOTATIONS_PER_BOARD + 2}`,
		]);
	});

	it("drops an annotation that lacks what its kind needs and keeps only what its kind reads", () => {
		const { body, dropped } = normalizeCanvasBody({
			annotations: [
				{ id: "pen-empty", kind: "pen", color: "red", size: 2, points: [] },
				{
					id: "line-no-to",
					kind: "line",
					color: "red",
					size: 2,
					from: { x: 0, y: 0 },
				},
				{
					id: "text-empty",
					kind: "text",
					color: "red",
					size: 12,
					at: { x: 0, y: 0 },
					text: "",
				},
				{ id: "weird", kind: "spray", color: "red", size: 2 },
				{
					id: "bad-size",
					kind: "arrow",
					color: "red",
					size: 0,
					from: { x: 0, y: 0 },
					to: { x: 1, y: 1 },
				},
				{
					id: "rect",
					kind: "rect",
					color: "red",
					size: 2,
					from: { x: 0, y: 0 },
					to: { x: 4, y: 4 },
					points: [{ x: 9, y: 9 }],
					text: "stray",
				},
			],
		});
		expect(dropped.annotations).toEqual([
			"pen-empty",
			"line-no-to",
			"text-empty",
			"weird",
			"bad-size",
		]);
		expect(body.annotations).toEqual([
			{
				id: "rect",
				kind: "rect",
				color: "red",
				size: 2,
				from: { x: 0, y: 0 },
				to: { x: 4, y: 4 },
			},
		]);
	});
});

describe("the structural budget for a heavy board (ruling 9)", () => {
	it("keeps the 150-note + 200-stroke fixture under 512 kB of canonical JSON", () => {
		const nodes: CanvasNode[] = Array.from({ length: 150 }, (_, i) =>
			sticky(`n${i}`, {
				position: { x: (i % 15) * 220, y: Math.floor(i / 15) * 120 },
				data: {
					kind: "sticky",
					text: `Note ${i}: ${"a plan for the day ".repeat(6)}`,
					tone: "yellow",
				},
			}),
		);
		const annotations: Annotation[] = Array.from({ length: 200 }, (_, i) => ({
			id: `a${i}`,
			kind: "pen",
			color: "#2f6fd0",
			size: 3,
			// A decimated stroke is a few dozen points, not the raw pointer stream.
			points: Array.from({ length: 40 }, (_, j) => ({
				x: i * 3 + j * 1.234567,
				y: Math.sin(j / 7) * 40 + i,
			})),
		}));
		const { body } = normalizeCanvasBody({ nodes, annotations });
		expect(body.nodes).toHaveLength(150);
		expect(body.annotations).toHaveLength(200);
		expect(boardJson(body).length).toBeLessThanOrEqual(512 * 1024);
	});
});
