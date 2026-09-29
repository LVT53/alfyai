import { get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";
import { t } from "$lib/i18n";
import {
	BLOCK_DATA_SCHEMAS,
	BLOCK_KINDS,
	type BlockKind,
} from "$lib/shared/artifacts/canvas-blocks";
import {
	boardJson,
	normalizeCanvasBody,
} from "$lib/shared/artifacts/canvas-body";
import { uiLanguage } from "$lib/stores/settings";
import MissingKindNode from "../nodes/MissingKindNode.svelte";
import { BLOCK_META, metaFor } from "./block-meta";
import {
	BLOCK_REGISTRY,
	blockEntry,
	boardNodeTypes,
	defaultDataFor,
	insertableEntries,
	newBlockNode,
} from "./block-registry";

// The five kinds this slice draws; the chat-derived five have no row yet and
// draw as the missing-kind card.
const BUILT: BlockKind[] = ["frame", "sticky", "text", "chart", "checklist"];
const NOT_BUILT: BlockKind[] = ["map", "file", "app", "photo", "liveweb"];

vi.mock("@xyflow/svelte", async () =>
	(await import("../_test/xyflow-mock")).xyflowMock(),
);

describe("the block registry", () => {
	it("has a row for every note-shaped kind and none for the chat-derived kinds", () => {
		expect(Object.keys(BLOCK_REGISTRY).sort()).toEqual([...BUILT].sort());
		for (const kind of BUILT) expect(blockEntry(kind)?.kind).toBe(kind);
		for (const kind of NOT_BUILT) expect(blockEntry(kind)).toBeNull();
	});

	it("answers null for a kind it has never heard of, and for a name that is only on the prototype chain", () => {
		expect(blockEntry("nope")).toBeNull();
		expect(blockEntry("toString")).toBeNull();
		expect(blockEntry("__proto__")).toBeNull();
	});

	it("uses the shared schema of each kind as the row's schema (ruling 64: declared once)", () => {
		for (const kind of BUILT) {
			const row = blockEntry(kind);
			expect(row?.schema).toBe(BLOCK_DATA_SCHEMAS[kind]);
		}
	});

	it("accepts every kind's own default data through its own schema", () => {
		for (const kind of BUILT) {
			const data = defaultDataFor(kind as keyof typeof BLOCK_META);
			expect(data.kind).toBe(kind);
			expect(blockEntry(kind)?.schema.safeParse(data).success).toBe(true);
		}
	});

	it("rejects data whose kind does not match the node's kind", () => {
		for (const kind of BUILT) {
			for (const other of BUILT) {
				if (other === kind) continue;
				const foreign = defaultDataFor(other as keyof typeof BLOCK_META);
				expect(blockEntry(kind)?.schema.safeParse(foreign).success).toBe(false);
			}
		}
	});

	it("marks none of the note-shaped kinds as needing a poster", () => {
		for (const kind of BUILT) expect(blockEntry(kind)?.needsPoster).toBe(false);
	});

	it("marks only the frame as one that must not be a frame child", () => {
		expect(BUILT.filter((kind) => blockEntry(kind)?.structural).sort()).toEqual(
			["frame"],
		);
	});

	it("gives every kind a chrome, a size that is its own and a minimum that fits inside it", () => {
		for (const kind of BUILT) {
			const row = blockEntry(kind);
			expect(row).not.toBeNull();
			if (!row) continue;
			expect(row.size.width).toBeGreaterThanOrEqual(row.minSize.width);
			expect(row.size.height).toBeGreaterThanOrEqual(row.minSize.height);
		}
		expect(metaFor("frame").chrome).toBe("frame");
		expect(metaFor("sticky").chrome).toBe("note");
		expect(metaFor("text").chrome).toBe("bare");
		expect(metaFor("chart").chrome).toBe("card");
	});

	it("maps every insert label to a message in both languages", () => {
		for (const kind of BUILT) {
			const key = blockEntry(kind)?.labelKey ?? "";
			for (const language of ["en", "hu"] as const) {
				uiLanguage.set(language);
				const label = get(t)(key as never);
				expect(label, `${key} in ${language}`).not.toBe(key);
				expect(label.length).toBeGreaterThan(0);
			}
		}
		uiLanguage.set("en");
	});

	it("lists the Insert menu's rows in menu order, sections apart", () => {
		expect(insertableEntries().map((row) => row.kind)).toEqual([
			"sticky",
			"text",
			"frame",
			"chart",
			"checklist",
		]);
		expect(
			insertableEntries()
				.filter((row) => row.section === "text")
				.map((row) => row.kind),
		).toEqual(["sticky", "text", "frame"]);
		expect(
			insertableEntries()
				.filter((row) => row.section === "blocks")
				.map((row) => row.kind),
		).toEqual(["chart", "checklist"]);
	});
});

describe("boardNodeTypes", () => {
	it("maps EVERY block kind to a component, the missing-kind card for the ones with no row", () => {
		const types = boardNodeTypes();
		expect(Object.keys(types).sort()).toEqual([...BLOCK_KINDS].sort());
		for (const kind of BUILT) {
			expect(types[kind]).toBe(blockEntry(kind)?.component);
			expect(types[kind]).not.toBe(MissingKindNode);
		}
		for (const kind of NOT_BUILT) expect(types[kind]).toBe(MissingKindNode);
	});
});

describe("newBlockNode", () => {
	it("gives a frame a width and a height, and the same two numbers in its data", () => {
		const frame = newBlockNode("frame", { x: 10, y: 20 }, "frame-1");
		expect(frame).toMatchObject({
			id: "frame-1",
			type: "frame",
			position: { x: 10, y: 20 },
			width: 360,
			height: 260,
			data: { kind: "frame", width: 360, height: 260 },
		});
	});

	it("gives a block that grows with its content a width and no height", () => {
		for (const kind of ["sticky", "text", "chart", "checklist"] as const) {
			const node = newBlockNode(kind, { x: 0, y: 0 });
			expect(node.width).toBe(BLOCK_META[kind].size.width);
			expect(node.height).toBeUndefined();
		}
	});

	it("mints a distinct id per node, and the board it makes survives a canonical round trip untouched", () => {
		const nodes = BUILT.map((kind, index) =>
			newBlockNode(kind as keyof typeof BLOCK_META, { x: index * 300, y: 0 }),
		);
		expect(new Set(nodes.map((node) => node.id)).size).toBe(nodes.length);
		const body = { ...normalizeCanvasBody({}).body, nodes };
		const once = boardJson(body);
		const normalised = normalizeCanvasBody(JSON.parse(once));
		expect(normalised.dropped).toEqual({
			nodes: [],
			edges: [],
			annotations: [],
		});
		expect(boardJson(normalised.body)).toBe(once);
	});
});
