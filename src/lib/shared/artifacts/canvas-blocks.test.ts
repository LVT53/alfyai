import { describe, expect, it } from "vitest";
import {
	BLOCK_DATA_SCHEMAS,
	BLOCK_KINDS,
	isBlockKind,
	MODEL_CREATABLE_KINDS,
	modelCreatableBlockDataSchema,
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
