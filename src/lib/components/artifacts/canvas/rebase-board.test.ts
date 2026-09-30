import { describe, expect, it } from "vitest";
import type {
	Annotation,
	CanvasBody,
	CanvasEdge,
	CanvasNode,
} from "$lib/shared/artifacts/canvas";
import { boardJson } from "$lib/shared/artifacts/canvas-body";
import { rebaseBoard, rebaseOnto } from "./rebase-board";

// The reader's step that is not saved yet, put on top of the board the server holds
// now (RV-3 I2). Three boards: `base` is what the reader started from (the last one
// the server acknowledged), `server` is what it holds now (Alfy changed `base`), and
// `reader` is what the reader has now. Where only one side changed something, that
// change stands; where both changed the same thing the reader's stands and the
// block is named, so the board can say so.

const CAMERA = { x: 0, y: 0, zoom: 1 };

function note(
	id: string,
	text: string,
	options: {
		x?: number;
		y?: number;
		tone?: "yellow" | "mint";
		parentId?: string;
	} = {},
): CanvasNode {
	return {
		id,
		type: "sticky",
		position: { x: options.x ?? 0, y: options.y ?? 0 },
		width: 180,
		...(options.parentId ? { parentId: options.parentId } : {}),
		data: { kind: "sticky", text, tone: options.tone ?? "yellow" },
	};
}

function frame(id: string, label: string): CanvasNode {
	return {
		id,
		type: "frame",
		position: { x: 0, y: 0 },
		width: 300,
		height: 200,
		data: { kind: "frame", label, width: 300, height: 200 },
	};
}

function board(
	nodes: CanvasNode[],
	extra: Partial<Pick<CanvasBody, "edges" | "annotations" | "viewport">> = {},
): CanvasBody {
	return {
		version: 1,
		nodes,
		edges: extra.edges ?? [],
		viewport: extra.viewport ?? CAMERA,
		annotations: extra.annotations ?? [],
	};
}

const byId = (body: CanvasBody, id: string) =>
	body.nodes.find((node) => node.id === id);
const textOf = (body: CanvasBody, id: string) => {
	const node = byId(body, id);
	return node && "text" in node.data ? node.data.text : undefined;
};

describe("rebaseBoard", () => {
	it("leaves a board alone when nobody changed anything", () => {
		const base = board([note("a", "Lunch")]);
		const result = rebaseBoard(base, base, base);
		expect(boardJson(result.body)).toBe(boardJson(base));
		expect(result.kept).toEqual([]);
	});

	it("takes the server's board as it is when the reader has taken no step", () => {
		const base = board([note("a", "Lunch"), note("b", "Museum", { x: 200 })]);
		const server = board([
			note("a", "Lunch"),
			note("b", "Museum", { x: 260, y: 40 }),
			note("c", "Booked"),
		]);
		const result = rebaseBoard(base, server, base);
		expect(boardJson(result.body)).toBe(boardJson(server));
		expect(result.kept).toEqual([]);
	});

	it("keeps both when the reader added a block and the server added another", () => {
		const base = board([note("a", "Lunch")]);
		const server = board([note("a", "Lunch"), note("alfy", "Booked")]);
		const reader = board([note("a", "Lunch"), note("mine", "Buy tickets")]);
		const result = rebaseBoard(base, server, reader);
		expect(result.body.nodes.map((node) => node.id)).toEqual([
			"a",
			"alfy",
			"mine",
		]);
		expect(result.kept).toEqual([]);
	});

	it("keeps the reader's words and the server's move when they changed different things of one block", () => {
		const base = board([note("a", "Lunch", { x: 10, y: 10 })]);
		const server = board([note("a", "Lunch", { x: 300, y: 80 })]);
		const reader = board([note("a", "Lunch (two seats)", { x: 10, y: 10 })]);
		const result = rebaseBoard(base, server, reader);
		expect(textOf(result.body, "a")).toBe("Lunch (two seats)");
		expect(byId(result.body, "a")?.position).toEqual({ x: 300, y: 80 });
		expect(result.kept).toEqual([]);
	});

	it("merges the fields of a block's content one by one: the reader's words and the server's tone", () => {
		const base = board([note("a", "Lunch")]);
		const server = board([note("a", "Lunch", { tone: "mint" })]);
		const reader = board([note("a", "Lunch (two seats)")]);
		const result = rebaseBoard(base, server, reader);
		const merged = byId(result.body, "a");
		expect(merged?.data).toMatchObject({
			text: "Lunch (two seats)",
			tone: "mint",
		});
		expect(result.kept).toEqual([]);
	});

	it("keeps the reader's words where both changed the same words, and names the block", () => {
		const base = board([note("a", "Lunch")]);
		const server = board([note("a", "Lunch at noon")]);
		const reader = board([note("a", "Lunch (two seats)")]);
		const result = rebaseBoard(base, server, reader);
		expect(textOf(result.body, "a")).toBe("Lunch (two seats)");
		expect(result.kept).toEqual(["a"]);
	});

	it("does not call it a conflict when both made the same change", () => {
		const base = board([note("a", "Lunch")]);
		const same = board([note("a", "Lunch at noon")]);
		const result = rebaseBoard(base, same, same);
		expect(textOf(result.body, "a")).toBe("Lunch at noon");
		expect(result.kept).toEqual([]);
	});

	it("keeps the reader's place where both moved the same block", () => {
		const base = board([note("a", "Lunch", { x: 10, y: 10 })]);
		const server = board([note("a", "Lunch", { x: 500, y: 10 })]);
		const reader = board([note("a", "Lunch", { x: 10, y: 400 })]);
		const result = rebaseBoard(base, server, reader);
		expect(byId(result.body, "a")?.position).toEqual({ x: 10, y: 400 });
		expect(result.kept).toEqual(["a"]);
	});

	it("takes a block's frame and its place inside it as one: the reader's move into a frame is not torn from its position", () => {
		const base = board([frame("f", "Sunday"), note("a", "Lunch", { x: 500 })]);
		// The reader took the note into the frame (its position is frame-relative now).
		const reader = board([
			frame("f", "Sunday"),
			note("a", "Lunch", { x: 20, y: 30, parentId: "f" }),
		]);
		// Alfy moved it somewhere else on the board.
		const server = board([
			frame("f", "Sunday"),
			note("a", "Lunch", { x: 700, y: 40 }),
		]);
		const result = rebaseBoard(base, server, reader);
		const merged = byId(result.body, "a");
		expect(merged?.parentId).toBe("f");
		expect(merged?.position).toEqual({ x: 20, y: 30 });
		expect(result.kept).toEqual(["a"]);
	});

	it("lets the server's removal of a block the reader did not touch stand", () => {
		const base = board([note("a", "Lunch"), note("b", "Museum")]);
		const server = board([note("a", "Lunch")]);
		const reader = board([note("a", "Lunch (two seats)"), note("b", "Museum")]);
		const result = rebaseBoard(base, server, reader);
		expect(result.body.nodes.map((node) => node.id)).toEqual(["a"]);
		expect(result.kept).toEqual([]);
	});

	it("keeps a block the server removed when the reader had changed it: their words are not lost", () => {
		const base = board([note("a", "Lunch"), note("b", "Museum")]);
		const server = board([note("a", "Lunch")]);
		const reader = board([note("a", "Lunch"), note("b", "Museum, 14:00")]);
		const result = rebaseBoard(base, server, reader);
		expect(textOf(result.body, "b")).toBe("Museum, 14:00");
		expect(result.kept).toEqual(["b"]);
	});

	it("lets the reader's removal of a block stand, and names it when the server had changed it", () => {
		const base = board([note("a", "Lunch"), note("b", "Museum")]);
		const server = board([note("a", "Lunch"), note("b", "Museum, 14:00")]);
		const reader = board([note("a", "Lunch")]);
		const result = rebaseBoard(base, server, reader);
		expect(result.body.nodes.map((node) => node.id)).toEqual(["a"]);
		expect(result.kept).toEqual(["b"]);

		// One the server did not touch is simply gone.
		const quiet = rebaseBoard(
			base,
			board([note("a", "Lunch"), note("b", "Museum")]),
			reader,
		);
		expect(quiet.body.nodes.map((node) => node.id)).toEqual(["a"]);
		expect(quiet.kept).toEqual([]);
	});

	it("does not lose a block the server put in a frame the reader deleted: it stays, out of the frame", () => {
		const base = board([frame("f", "Sunday")]);
		const server = board([
			frame("f", "Sunday"),
			note("alfy", "Brunch", { x: 20, y: 40, parentId: "f" }),
		]);
		const reader = board([]);
		const result = rebaseBoard(base, server, reader);
		const kept = byId(result.body, "alfy");
		expect(kept).toBeDefined();
		expect(kept?.parentId).toBeUndefined();
		expect(byId(result.body, "f")).toBeUndefined();
	});

	it("keeps the reader's new connection and the server's, and lets a removal of one stand", () => {
		const edge = (id: string, source: string, target: string): CanvasEdge => ({
			id,
			source,
			target,
		});
		const nodes = [note("a", "A"), note("b", "B"), note("c", "C")];
		const base = board(nodes, { edges: [edge("e1", "a", "b")] });
		const server = board(nodes, {
			edges: [edge("e1", "a", "b"), edge("e-alfy", "b", "c")],
		});
		const reader = board(nodes, { edges: [edge("e-mine", "a", "c")] });
		const result = rebaseBoard(base, server, reader);
		// The reader removed e1 and added e-mine; Alfy added e-alfy.
		expect(result.body.edges.map((e) => e.id).sort()).toEqual([
			"e-alfy",
			"e-mine",
		]);
	});

	it("drops a connection whose block is gone once the steps are put together", () => {
		const edge: CanvasEdge = { id: "e1", source: "a", target: "b" };
		const base = board([note("a", "A"), note("b", "B")], { edges: [edge] });
		// The server removed b (and with it the connection); the reader kept the connection as it was.
		const server = board([note("a", "A")], { edges: [] });
		const reader = board([note("a", "A (edited)"), note("b", "B")], {
			edges: [edge],
		});
		const result = rebaseBoard(base, server, reader);
		expect(result.body.edges).toEqual([]);
		expect(textOf(result.body, "a")).toBe("A (edited)");
	});

	it("keeps the marks the reader drew, and the server's own", () => {
		const mark = (id: string, x: number): Annotation => ({
			id,
			kind: "line",
			color: "ink",
			size: 2,
			from: { x, y: 0 },
			to: { x: x + 10, y: 10 },
		});
		const base = board([], { annotations: [mark("m1", 0)] });
		const server = board([], {
			annotations: [mark("m1", 0), mark("m-far", 90)],
		});
		const reader = board([], {
			annotations: [mark("m1", 0), mark("m-mine", 40)],
		});
		const result = rebaseBoard(base, server, reader);
		expect(result.body.annotations.map((a) => a.id)).toEqual([
			"m1",
			"m-far",
			"m-mine",
		]);
	});

	it("keeps the reader's camera", () => {
		const base = board([note("a", "Lunch")]);
		const server = board([note("a", "Lunch at noon")], {
			viewport: { x: 5, y: 5, zoom: 2 },
		});
		const reader = board([note("a", "Lunch")], {
			viewport: { x: -120, y: 40, zoom: 0.75 },
		});
		const result = rebaseBoard(base, server, reader);
		expect(result.body.viewport).toEqual({ x: -120, y: 40, zoom: 0.75 });
		expect(textOf(result.body, "a")).toBe("Lunch at noon");
	});

	it("names a block once, however many of its fields both sides changed", () => {
		const base = board([note("a", "Lunch", { x: 1, y: 1 })]);
		const server = board([
			note("a", "Lunch at noon", { x: 50, y: 1, tone: "mint" }),
		]);
		const reader = board([note("a", "Lunch (two seats)", { x: 1, y: 90 })]);
		const result = rebaseBoard(base, server, reader);
		expect(result.kept).toEqual(["a"]);
		// The reader's words and place win; the tone nobody else touched is the server's.
		expect(textOf(result.body, "a")).toBe("Lunch (two seats)");
		expect(byId(result.body, "a")?.position).toEqual({ x: 1, y: 90 });
		expect(byId(result.body, "a")?.data).toMatchObject({ tone: "mint" });
	});

	it("does not carry the live fields the reader's board has (selection, measurement) into what is saved", () => {
		const base = board([note("a", "Lunch")]);
		const server = board([note("a", "Lunch"), note("alfy", "Booked")]);
		const live: CanvasNode = {
			...note("a", "Lunch (two seats)"),
			selected: true,
			dragging: false,
			measured: { width: 180, height: 80 },
		};
		const result = rebaseBoard(base, server, board([live]));
		const merged = byId(result.body, "a") as Record<string, unknown>;
		expect(merged.selected).toBeUndefined();
		expect(merged.measured).toBeUndefined();
		expect(merged.dragging).toBeUndefined();
	});
});

describe("rebaseOnto", () => {
	const base = board([note("a", "Lunch")]);
	const server = board([note("a", "Lunch"), note("alfy", "Booked")]);
	const reader = board([note("a", "Lunch (two seats)")]);

	it("takes the saved board and the reader's board as their JSON, which is what the editor keeps", () => {
		const result = rebaseOnto(boardJson(base), server, boardJson(reader));
		expect(result.body.nodes.map((node) => node.id)).toEqual(["a", "alfy"]);
		expect(textOf(result.body, "a")).toBe("Lunch (two seats)");
		expect(result.kept).toEqual([]);
	});

	it("takes the reader's board as it is when the board is drawn", () => {
		const result = rebaseOnto(boardJson(base), server, reader);
		expect(boardJson(result.body)).toBe(
			boardJson(rebaseBoard(base, server, reader).body),
		);
	});
});
