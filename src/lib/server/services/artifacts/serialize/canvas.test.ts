import { describe, expect, it } from "vitest";
import type { CanvasNode } from "$lib/shared/artifacts/canvas";
import {
	boardJson,
	normalizeCanvasBody,
} from "$lib/shared/artifacts/canvas-body";
import {
	cloneBoard,
	sampleBoard,
} from "$lib/shared/artifacts/canvas-fixtures.test-helpers";
import { hashArtifactBody } from "../hash";
import {
	canvasBodyHash,
	canvasSerializer,
	MAX_BODY_BYTES,
	MAX_NODES_PER_BOARD,
	prepareCanvasBoard,
} from "./canvas";
import { getArtifactSerializer } from "./index";

function stickies(count: number, text = "note"): CanvasNode[] {
	return Array.from({ length: count }, (_, i) => ({
		id: `n${i}`,
		type: "sticky" as const,
		position: { x: i, y: 0 },
		data: { kind: "sticky" as const, text, tone: "plain" as const },
	}));
}

describe("the canvas body hash (ruling 12)", () => {
	it("is the family's one hasher over the canonical JSON", () => {
		const canonical = boardJson(sampleBoard());
		expect(canvasBodyHash(canonical)).toBe(hashArtifactBody(canonical));
		expect(canvasBodyHash(canonical)).toMatch(/^[0-9a-f]{64}$/);
	});

	it("open → boardJson → normalizeCanvasBody → boardJson produces an identical body hash with no user edit", () => {
		const once = boardJson(normalizeCanvasBody(sampleBoard()).body);
		const twice = boardJson(normalizeCanvasBody(JSON.parse(once)).body);
		expect(canvasBodyHash(twice)).toBe(canvasBodyHash(once));
	});

	it("rounds a float-noise position to the same hash as its rounded twin", () => {
		const at = (x: number) => {
			const board = sampleBoard();
			board.nodes[2] = { ...board.nodes[2], position: { x, y: 60 } };
			return canvasBodyHash(boardJson(board));
		};
		expect(at(412.00000000000006)).toBe(at(412));
	});
});

describe("the canvas serializer", () => {
	it("is what the registry resolves for the canvas kind", () => {
		const serializer = getArtifactSerializer("canvas");
		expect(serializer).toBe(canvasSerializer);
		expect(serializer?.kind).toBe("canvas");
	});

	it("serialises to the canonical JSON and parses back to the same board", () => {
		const board = sampleBoard();
		const stored = canvasSerializer.serialize(board);
		expect(stored).toBe(boardJson(board));
		expect(canvasSerializer.parse(stored)).toEqual(board);
	});

	it("answers null — not a throw — for a string that is not a board", () => {
		for (const stored of ["", "{not json", "null", "[]", "42", '"board"']) {
			expect(canvasSerializer.parse(stored)).toBeNull();
		}
		expect(canvasSerializer.parse("{}")?.nodes).toEqual([]);
	});
});

describe("prepareCanvasBoard — what a client's board becomes before it is stored", () => {
	it("stores the canonical form, hashed as such, whatever the client sent", () => {
		const live = cloneBoard(sampleBoard()) as unknown as {
			nodes: Record<string, unknown>[];
		};
		live.nodes[1] = {
			...live.nodes[1],
			selected: true,
			dragging: false,
			measured: { width: 1, height: 1 },
		};
		const raw = JSON.stringify(live, null, 2);
		const result = prepareCanvasBoard(raw);
		if (!result.ok) throw new Error(result.reason);
		expect(result.json).toBe(boardJson(sampleBoard()));
		expect(result.json).not.toContain("selected");
		expect(result.hash).toBe(canvasBodyHash(result.json));
		expect(result.dropped).toEqual({ nodes: [], edges: [], annotations: [] });
	});

	it("reports what it dropped instead of hiding it", () => {
		const raw = cloneBoard(sampleBoard());
		raw.edges.push({ id: "dangling", source: "note-1", target: "ghost" });
		const result = prepareCanvasBoard(JSON.stringify(raw));
		if (!result.ok) throw new Error(result.reason);
		expect(result.dropped.edges).toEqual(["dangling"]);
	});

	it("refuses a string that is not a board", () => {
		for (const raw of ["", "{nope", "null", "[]", "7"]) {
			expect(prepareCanvasBoard(raw)).toEqual({
				ok: false,
				reason: "invalid_body",
			});
		}
	});

	it("accepts a board at the node cap and refuses one past it, without truncating it", () => {
		expect(MAX_NODES_PER_BOARD).toBe(400);
		const atCap = prepareCanvasBoard(
			JSON.stringify({ nodes: stickies(MAX_NODES_PER_BOARD) }),
		);
		expect(atCap.ok).toBe(true);
		const over = prepareCanvasBoard(
			JSON.stringify({ nodes: stickies(MAX_NODES_PER_BOARD + 1) }),
		);
		expect(over).toEqual({ ok: false, reason: "too_many_nodes" });
	});

	it("refuses a board whose canonical JSON is over the body cap", () => {
		expect(MAX_BODY_BYTES).toBe(1024 * 1024);
		// 60 notes of 20,000 characters is under the node cap and over 1 MiB.
		const fat = prepareCanvasBoard(
			JSON.stringify({ nodes: stickies(60, "x".repeat(20_000)) }),
		);
		expect(fat).toEqual({ ok: false, reason: "too_large" });
	});

	it("does not spend a parse on a payload that is absurdly large", () => {
		const huge = `{"nodes":[],"pad":"${"x".repeat(MAX_BODY_BYTES * 4)}"}`;
		expect(prepareCanvasBoard(huge)).toEqual({
			ok: false,
			reason: "too_large",
		});
	});
});
