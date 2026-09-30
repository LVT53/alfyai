import { get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";
import { t } from "$lib/i18n";
import {
	BLOCK_DATA_SCHEMAS,
	BLOCK_KINDS,
	type BlockKind,
	type CanvasBlockData,
} from "$lib/shared/artifacts/canvas-blocks";
import {
	boardJson,
	normalizeCanvasBody,
} from "$lib/shared/artifacts/canvas-body";
import { uiLanguage } from "$lib/stores/settings";
import LazyNode from "../nodes/LazyNode.svelte";
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

// The kinds this build draws; the two it has no row for yet (photos, live web)
// draw as the missing-kind card.
const NOTE_SHAPED: BlockKind[] = [
	"frame",
	"sticky",
	"text",
	"chart",
	"checklist",
];
// The blocks made from the chat: picked from "From this chat", never inserted
// bare, and loaded only when one mounts.
const FROM_CHAT: BlockKind[] = ["map", "file", "app"];
const BUILT: BlockKind[] = [...NOTE_SHAPED, ...FROM_CHAT];
const NOT_BUILT: BlockKind[] = ["photo", "liveweb"];

vi.mock("@xyflow/svelte", async () =>
	(await import("../_test/xyflow-mock")).xyflowMock(),
);

/** What the reader would have picked, for a kind that has no default: valid data of that kind. */
function blockOf(kind: BlockKind): CanvasBlockData | undefined {
	switch (kind) {
		case "file":
			return {
				kind: "file",
				fileId: "chat-file-1",
				name: "trip.pdf",
				mime: "application/pdf",
				bytes: 2048,
				label: "PDF",
			};
		case "app":
			return { kind: "app", artifactId: "app-1", title: "Tip calculator" };
		case "map":
			return {
				kind: "map",
				route: "Cork → Kinsale",
				meta: "27.0 km · 34 min",
				map: {
					bounds: { minLat: 51.7, minLng: -8.5, maxLat: 51.9, maxLng: -8.4 },
					attribution: "© OpenStreetMap contributors",
				},
			};
		default:
			return undefined;
	}
}

describe("the block registry", () => {
	it("has a row for every kind this build draws and none for the two it does not", () => {
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

	it("accepts every note-shaped kind's own default data through its own schema", () => {
		for (const kind of NOTE_SHAPED) {
			const data = defaultDataFor(kind as keyof typeof BLOCK_META);
			expect(data?.kind).toBe(kind);
			expect(blockEntry(kind)?.schema.safeParse(data).success).toBe(true);
		}
	});

	it("has no default data for a block made from the chat: its data is what the chat made, picked by the reader", () => {
		for (const kind of FROM_CHAT) {
			expect(defaultDataFor(kind as keyof typeof BLOCK_META)).toBeNull();
		}
	});

	it("rejects data whose kind does not match the node's kind", () => {
		for (const kind of NOTE_SHAPED) {
			for (const other of NOTE_SHAPED) {
				if (other === kind) continue;
				const foreign = defaultDataFor(other as keyof typeof BLOCK_META);
				expect(blockEntry(kind)?.schema.safeParse(foreign).success).toBe(false);
			}
		}
	});

	it("marks as needing a poster exactly what a snapshot cannot be drawn from a stored value: the map and the App (the spec's poster policy)", () => {
		expect(
			BUILT.filter((kind) => blockEntry(kind)?.needsPoster).sort(),
		).toEqual(["app", "map"]);
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
		expect(metaFor("map").chrome).toBe("card");
		expect(metaFor("app").chrome).toBe("card");
		expect(metaFor("file").chrome).toBe("bare");
	});

	it("keeps the map and the App on their own footprint: an App is drawn at a height it stores, a map grows with its content", () => {
		expect(BLOCK_META.app.fixedHeight).toBe(true);
		expect(BLOCK_META.map.fixedHeight).toBe(false);
		expect(BLOCK_META.file.fixedHeight).toBe(false);
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

	it("files the blocks made from the chat under their own section, so the menu never lists them bare", () => {
		for (const kind of FROM_CHAT) {
			expect(blockEntry(kind)?.section).toBe("chat");
		}
	});

	it("lists the Insert menu's rows in menu order, sections apart, and none of the blocks that are picked from the chat", () => {
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

	// The editor's first paint pays for none of the blocks made from the chat:
	// each is a loader the board calls when one is on the board.
	it("draws the blocks made from the chat through the loading wrapper, and the note-shaped ones directly", () => {
		const types = boardNodeTypes();
		for (const kind of FROM_CHAT) expect(types[kind]).toBe(LazyNode);
		for (const kind of NOTE_SHAPED) expect(types[kind]).not.toBe(LazyNode);
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
		for (const kind of [
			"sticky",
			"text",
			"chart",
			"checklist",
			"map",
			"file",
		] as const) {
			const node = newBlockNode(kind, { x: 0, y: 0 }, undefined, blockOf(kind));
			expect(node.width).toBe(BLOCK_META[kind].size.width);
			expect(node.height).toBeUndefined();
		}
	});

	it("gives an App the width and the height it is drawn at, because a frame has no content height of its own", () => {
		const node = newBlockNode(
			"app",
			{ x: 0, y: 0 },
			"app-node",
			blockOf("app"),
		);
		expect(node).toMatchObject({
			width: BLOCK_META.app.size.width,
			height: BLOCK_META.app.size.height,
		});
	});

	it("puts the data the reader picked on the node, not a default", () => {
		const data = blockOf("file");
		expect(newBlockNode("file", { x: 1, y: 2 }, "f", data).data).toEqual(data);
	});

	it("refuses to make a block from the chat out of nothing", () => {
		for (const kind of FROM_CHAT) {
			expect(() =>
				newBlockNode(kind as keyof typeof BLOCK_META, { x: 0, y: 0 }),
			).toThrow();
		}
	});

	it("mints a distinct id per node, and the board it makes survives a canonical round trip untouched", () => {
		const nodes = BUILT.map((kind, index) =>
			newBlockNode(
				kind as keyof typeof BLOCK_META,
				{ x: index * 300, y: 0 },
				undefined,
				blockOf(kind),
			),
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
