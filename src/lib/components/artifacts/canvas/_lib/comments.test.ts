import { describe, expect, it } from "vitest";
import type { ArtifactComment } from "$lib/server/services/artifacts/types";
import type { Anchor } from "$lib/shared/artifacts/anchor";
import type { CanvasNode } from "$lib/shared/artifacts/canvas";
import {
	isOrphaned,
	nodeAt,
	nodeWords,
	pinAt,
	pinLabel,
	threadCounts,
} from "./comments";

// What a thread means on a board: where its pin sits, whether its block is
// still there, the number it wears, and which block a click landed on. All
// pure: the components draw what these say.

function thread(
	id: string,
	anchor: Anchor | null,
	status: "open" | "resolved" = "open",
): ArtifactComment {
	return {
		id,
		artifactId: "board-1",
		parentId: null,
		anchor,
		author: "user",
		body: `comment ${id}`,
		status,
		createdAt: 1,
		replies: [],
	};
}

function sticky(
	id: string,
	x: number,
	y: number,
	extra: Partial<CanvasNode> = {},
): CanvasNode {
	return {
		id,
		type: "sticky",
		position: { x, y },
		width: 200,
		height: 100,
		data: { kind: "sticky", text: `note ${id}`, tone: "yellow" },
		...extra,
	};
}

const FRAME: CanvasNode = {
	id: "frame-a",
	type: "frame",
	position: { x: 100, y: 100 },
	width: 400,
	height: 300,
	data: { kind: "frame", label: "Saturday", width: 400, height: 300 },
};
const CHILD = sticky("child", 20, 60, { parentId: "frame-a" });
const NODES: CanvasNode[] = [FRAME, CHILD, sticky("free", 700, 50)];

describe("pinAt", () => {
	it("pins a node thread at its node's top-right corner, in board space", () => {
		expect(pinAt(thread("t", { kind: "node", nodeId: "free" }), NODES)).toEqual(
			{
				x: 900,
				y: 50,
			},
		);
	});

	it("adds the frame's own place for a note inside one, since the pin is drawn in board space", () => {
		// child is frame-relative (20, 60) inside a frame at (100, 100): 120, 160 + width 200.
		expect(
			pinAt(thread("t", { kind: "node", nodeId: "child" }), NODES),
		).toEqual({ x: 320, y: 160 });
	});

	it("prefers what the panel measured over what is stored", () => {
		const measured = [
			sticky("free", 700, 50, { measured: { width: 260, height: 90 } }),
		];
		expect(
			pinAt(thread("t", { kind: "node", nodeId: "free" }), measured),
		).toEqual({
			x: 960,
			y: 50,
		});
	});

	it("pins a point thread at its board coordinates, whatever the board holds", () => {
		const point: Anchor = { kind: "point", x: -30.5, y: 412 };
		expect(pinAt(thread("t", point), NODES)).toEqual({ x: -30.5, y: 412 });
		expect(pinAt(thread("t", point), [])).toEqual({ x: -30.5, y: 412 });
	});

	it("draws no pin for a thread whose node is gone", () => {
		expect(
			pinAt(thread("t", { kind: "node", nodeId: "deleted" }), NODES),
		).toBeNull();
	});

	it("draws no pin for an anchor that could not be read, or one a board cannot place", () => {
		expect(pinAt(thread("t", null), NODES)).toBeNull();
		expect(
			pinAt(
				thread("t", {
					kind: "text",
					blockId: "b",
					quote: "q",
					prefix: "",
					suffix: "",
				}),
				NODES,
			),
		).toBeNull();
	});
});

describe("isOrphaned", () => {
	it("marks a thread orphaned when its node is gone, and only then", () => {
		expect(
			isOrphaned(thread("t", { kind: "node", nodeId: "deleted" }), NODES),
		).toBe(true);
		expect(
			isOrphaned(thread("t", { kind: "node", nodeId: "free" }), NODES),
		).toBe(false);
		expect(isOrphaned(thread("t", { kind: "point", x: 1, y: 2 }), [])).toBe(
			false,
		);
	});

	it("takes an anchor that could not be read for an orphan, never for a crash", () => {
		expect(isOrphaned(thread("t", null), NODES)).toBe(true);
	});
});

describe("pinLabel", () => {
	const threads = [
		thread("a", { kind: "point", x: 0, y: 0 }),
		thread("b", { kind: "point", x: 0, y: 0 }, "resolved"),
		thread("c", { kind: "point", x: 0, y: 0 }),
	];

	it("numbers pins by list position, from 1", () => {
		expect(pinLabel(threads, "a")).toBe("1");
		expect(pinLabel(threads, "c")).toBe("3");
	});

	it("keeps a resolved thread's number, so pin 3 stays 3 when pin 2 is done", () => {
		expect(pinLabel(threads, "b")).toBe("2");
	});

	it("prints ? for an id the list does not know, rather than pin 0", () => {
		expect(pinLabel(threads, "nope")).toBe("?");
		expect(pinLabel([], "a")).toBe("?");
	});
});

describe("threadCounts", () => {
	it("counts open and resolved threads", () => {
		expect(
			threadCounts([
				thread("a", null),
				thread("b", null, "resolved"),
				thread("c", null, "resolved"),
			]),
		).toEqual({ open: 1, resolved: 2 });
		expect(threadCounts([])).toEqual({ open: 0, resolved: 0 });
	});
});

describe("nodeAt", () => {
	it("finds the block a point falls on", () => {
		expect(nodeAt({ x: 750, y: 90 }, NODES)?.id).toBe("free");
	});

	it("prefers a note inside a frame to the frame around it", () => {
		// (150, 180) is inside both the frame and the child at (120, 160).
		expect(nodeAt({ x: 150, y: 180 }, NODES)?.id).toBe("child");
	});

	it("leaves a frame's empty inside to be a spot, not the frame", () => {
		expect(nodeAt({ x: 450, y: 350 }, NODES)).toBeNull();
	});

	it("finds nothing on empty board", () => {
		expect(nodeAt({ x: -500, y: -500 }, NODES)).toBeNull();
		expect(nodeAt({ x: 0, y: 0 }, [])).toBeNull();
	});

	it("uses the size the panel measured, so a block that grew is hit where it is", () => {
		const grown = [
			sticky("free", 700, 50, { measured: { width: 200, height: 300 } }),
		];
		expect(nodeAt({ x: 750, y: 300 }, grown)?.id).toBe("free");
		expect(nodeAt({ x: 750, y: 300 }, [sticky("free", 700, 50)])).toBeNull();
	});

	it("takes the later block when two overlap: it is drawn on top", () => {
		const overlapping = [sticky("under", 0, 0), sticky("over", 50, 20)];
		expect(nodeAt({ x: 100, y: 50 }, overlapping)?.id).toBe("over");
	});
});

describe("nodeWords", () => {
	it("names a note or a text block by its own words, cut short", () => {
		expect(nodeWords(sticky("s", 0, 0))).toBe("note s");
		const long = sticky("s", 0, 0, {
			data: { kind: "sticky", text: "a ".repeat(80), tone: "mint" },
		});
		expect((nodeWords(long) ?? "").length).toBeLessThanOrEqual(41);
	});

	it("names a frame, a checklist or a chart by its label, and says nothing when it has none", () => {
		expect(nodeWords(FRAME)).toBe("Saturday");
		const list: CanvasNode = {
			id: "l",
			type: "checklist",
			position: { x: 0, y: 0 },
			data: { kind: "checklist", label: "Pack", items: [] },
		};
		expect(nodeWords(list)).toBe("Pack");
		const bare: CanvasNode = {
			id: "l",
			type: "checklist",
			position: { x: 0, y: 0 },
			data: { kind: "checklist", items: [] },
		};
		expect(nodeWords(bare)).toBeNull();
	});
});
