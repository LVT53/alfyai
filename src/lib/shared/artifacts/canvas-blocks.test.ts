import { describe, expect, it } from "vitest";
import {
	BLOCK_DATA_SCHEMAS,
	BLOCK_KINDS,
	type CanvasBlockData,
	isBlockKind,
	MODEL_CREATABLE_KINDS,
	modelCreatableBlockDataSchema,
	repeatedEntryIds,
	withUniqueEntryIds,
} from "./canvas-blocks";
import { sampleBoard } from "./canvas-fixtures.test-helpers";

describe("the block data schemas (ruling 64)", () => {
	it("has exactly one schema per kind, and the kind list is derived from them", () => {
		expect([...BLOCK_KINDS].sort()).toEqual(
			[
				"app",
				"chart",
				"checklist",
				"file",
				"frame",
				"liveweb",
				"map",
				"photo",
				"sticky",
				"text",
			].sort(),
		);
		expect(Object.keys(BLOCK_DATA_SCHEMAS).sort()).toEqual(
			[...BLOCK_KINDS].sort(),
		);
	});

	it("accepts every kind's data from a real board through its own schema, and only its own", () => {
		const seen = new Set<string>();
		for (const node of sampleBoard().nodes) {
			seen.add(node.type);
			expect(BLOCK_DATA_SCHEMAS[node.type].safeParse(node.data).success).toBe(
				true,
			);
			for (const other of BLOCK_KINDS) {
				if (other === node.type) continue;
				expect(BLOCK_DATA_SCHEMAS[other].safeParse(node.data).success).toBe(
					false,
				);
			}
		}
		expect([...seen].sort()).toEqual([...BLOCK_KINDS].sort());
	});

	it("knows a kind from a string", () => {
		expect(isBlockKind("sticky")).toBe(true);
		expect(isBlockKind("hologram")).toBe(false);
		expect(isBlockKind(undefined)).toBe(false);
		expect(isBlockKind("toString")).toBe(false);
	});

	it("lets the model create the five note-shaped kinds and no other", () => {
		expect([...MODEL_CREATABLE_KINDS]).toEqual([
			"frame",
			"sticky",
			"text",
			"checklist",
			"chart",
		]);
		for (const kind of MODEL_CREATABLE_KINDS)
			expect(isBlockKind(kind)).toBe(true);
	});

	it("parses the model-creatable union to the same data the stored schema accepts", () => {
		for (const node of sampleBoard().nodes) {
			const viaUnion = modelCreatableBlockDataSchema.safeParse(node.data);
			expect(viaUnion.success).toBe(
				(MODEL_CREATABLE_KINDS as readonly string[]).includes(node.type),
			);
		}
	});

	it("rejects an unknown key in what the model writes, where the stored schema would only strip it", () => {
		const data = { kind: "sticky", text: "x", tone: "plain", content: "typo" };
		expect(modelCreatableBlockDataSchema.safeParse(data).success).toBe(false);
		expect(BLOCK_DATA_SCHEMAS.sticky.safeParse(data).success).toBe(true);
	});

	it("keeps the stored schema lenient about what it does not read, and strict about what it does", () => {
		expect(
			BLOCK_DATA_SCHEMAS.sticky.safeParse({
				kind: "sticky",
				text: "x",
				tone: "neon",
			}).success,
		).toBe(false);
		expect(
			BLOCK_DATA_SCHEMAS.frame.safeParse({
				kind: "frame",
				label: "F",
				width: 0,
				height: 10,
			}).success,
		).toBe(false);
		expect(
			BLOCK_DATA_SCHEMAS.checklist.safeParse({
				kind: "checklist",
				items: [{ id: "a", text: "t" }],
			}).success,
		).toBe(false);
		expect(
			BLOCK_DATA_SCHEMAS.chart.safeParse({ kind: "chart", code: "" }).success,
		).toBe(false);
		expect(
			BLOCK_DATA_SCHEMAS.file.safeParse({
				kind: "file",
				fileId: "f",
				name: "n",
				mime: "m",
				bytes: -1,
				label: "l",
			}).success,
		).toBe(false);
	});
});

// RV-3 C1: a list a block draws row by row is keyed by its entries' ids, so two
// entries with one id take the whole board down. The two helpers say which ids
// repeat (what the model is refused for) and repair them (what a stored board is
// opened with).
describe("the ids of a block's own entries (RV-3 C1)", () => {
	const checklist = (ids: string[]): CanvasBlockData => ({
		kind: "checklist",
		items: ids.map((id, index) => ({ id, text: `item ${index}`, done: false })),
	});

	it("names the ids that repeat, once each, in the order they first repeat", () => {
		expect(repeatedEntryIds(checklist(["a", "b", "c"]))).toEqual([]);
		expect(repeatedEntryIds(checklist(["1", "1"]))).toEqual(["1"]);
		expect(repeatedEntryIds(checklist(["x", "y", "y", "x", "y"]))).toEqual([
			"y",
			"x",
		]);
	});

	it("looks at the entries of the photo and web blocks as well, and at nothing else", () => {
		const board = sampleBoard();
		const photo = board.nodes.find((node) => node.type === "photo");
		const web = board.nodes.find((node) => node.type === "liveweb");
		if (photo?.data.kind !== "photo" || web?.data.kind !== "liveweb") {
			throw new Error("the fixture must hold a photo and a web block");
		}
		expect(
			repeatedEntryIds({
				...photo.data,
				items: [photo.data.items[0], photo.data.items[0]],
			}),
		).toEqual([photo.data.items[0].id]);
		expect(
			repeatedEntryIds({
				...web.data,
				sources: [web.data.sources[0], web.data.sources[0]],
			}),
		).toEqual([web.data.sources[0].id]);
		for (const node of board.nodes) {
			expect(repeatedEntryIds(node.data)).toEqual([]);
		}
	});

	it("gives a later entry a fresh id and keeps the first one's, without touching a word", () => {
		const data = checklist(["1", "1"]);
		const repaired = withUniqueEntryIds(data);
		expect(repaired.renamed).toEqual(["1"]);
		if (repaired.data.kind !== "checklist")
			throw new Error("still a checklist");
		expect(repaired.data.items.map((item) => item.id)).toEqual(["1", "1-2"]);
		expect(repaired.data.items.map((item) => item.text)).toEqual([
			"item 0",
			"item 1",
		]);
		// The block it was given is never mutated.
		expect(data).toEqual(checklist(["1", "1"]));
	});

	it("never mints an id that another entry already has, and is stable once repaired", () => {
		const repaired = withUniqueEntryIds(checklist(["1", "1-2", "1", "1"]));
		if (repaired.data.kind !== "checklist")
			throw new Error("still a checklist");
		const ids = repaired.data.items.map((item) => item.id);
		expect(ids).toEqual(["1", "1-2", "1-3", "1-4"]);
		expect(new Set(ids).size).toBe(ids.length);
		expect(withUniqueEntryIds(repaired.data).renamed).toEqual([]);
	});

	it("keeps an id inside its length cap when it renames it", () => {
		const long = "z".repeat(128);
		const repaired = withUniqueEntryIds(checklist([long, long]));
		if (repaired.data.kind !== "checklist")
			throw new Error("still a checklist");
		const [first, second] = repaired.data.items.map((item) => item.id);
		expect(first).toBe(long);
		expect(second).not.toBe(long);
		expect(second.length).toBeLessThanOrEqual(128);
		expect(BLOCK_DATA_SCHEMAS.checklist.safeParse(repaired.data).success).toBe(
			true,
		);
	});

	it("hands back the very block it was given when nothing repeats", () => {
		const data = checklist(["a", "b"]);
		const result = withUniqueEntryIds(data);
		expect(result.data).toBe(data);
		expect(result.renamed).toEqual([]);
	});
});
