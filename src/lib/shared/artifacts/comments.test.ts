import { describe, expect, it } from "vitest";
import {
	type Anchor,
	ORPHANED_ANCHOR_RESOLUTION,
} from "$lib/shared/artifacts/anchor";
import { canvasAnchorResolver, mentionsAlfy } from "./comments";

// The Canvas's half of ruling 11's one comment layer: a pure resolver over the
// board's nodes that answers with the ONE resolution shape every kind shares
// (`anchor.ts`), and the list of anchor kinds a board accepts at intake.

const NODES = [{ id: "note-1" }, { id: "frame-a" }];

describe("canvasAnchorResolver", () => {
	it("accepts node and point anchors, and only those", () => {
		expect([...canvasAnchorResolver.kinds]).toEqual(["node", "point"]);
	});

	it("resolves a node anchor as exact while its node exists, naming the node", () => {
		const anchor: Anchor = { kind: "node", nodeId: "note-1" };
		expect(canvasAnchorResolver.resolve(anchor, NODES)).toMatchObject({
			state: "exact",
			blockId: "note-1",
		});
	});

	it("resolves a node anchor as orphaned, with reason node_missing, once its node is gone", () => {
		const anchor: Anchor = { kind: "node", nodeId: "deleted" };
		const resolution = canvasAnchorResolver.resolve(anchor, NODES);
		expect(resolution).toMatchObject({
			state: "orphaned",
			blockId: null,
			from: -1,
			to: -1,
			reason: "node_missing",
		});
	});

	it("resolves a point anchor as moved rather than orphaned, whatever the board holds", () => {
		const anchor: Anchor = { kind: "point", x: 120, y: -40 };
		expect(canvasAnchorResolver.resolve(anchor, NODES).state).toBe("moved");
		expect(canvasAnchorResolver.resolve(anchor, []).state).toBe("moved");
	});

	it("never resolves a text anchor: that is the Document's, and it is the shared orphan", () => {
		const anchor: Anchor = {
			kind: "text",
			blockId: "b1",
			quote: "hello",
			prefix: "",
			suffix: "",
		};
		expect(canvasAnchorResolver.resolve(anchor, NODES)).toEqual(
			ORPHANED_ANCHOR_RESOLUTION,
		);
	});

	it("is pure: the same anchor and board resolve identically twice, and the board is left alone", () => {
		const nodes = [{ id: "note-1" }];
		const before = JSON.stringify(nodes);
		const anchor: Anchor = { kind: "node", nodeId: "note-1" };
		expect(canvasAnchorResolver.resolve(anchor, nodes)).toEqual(
			canvasAnchorResolver.resolve(anchor, nodes),
		);
		expect(JSON.stringify(nodes)).toBe(before);
	});
});

describe("mentionsAlfy", () => {
	it("detects an @Alfy mention case-insensitively, as a whole word", () => {
		expect(mentionsAlfy("please @Alfy tidy this")).toBe(true);
		expect(mentionsAlfy("@alfy?")).toBe(true);
		expect(mentionsAlfy("@ALFY, again")).toBe(true);
	});

	it("does not take a longer name, or a mention with no @, for a mention", () => {
		expect(mentionsAlfy("@Alfyn is a colleague")).toBe(false);
		expect(mentionsAlfy("ask alfy")).toBe(false);
		expect(mentionsAlfy("")).toBe(false);
	});
});
