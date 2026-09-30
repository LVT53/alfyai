import { describe, expect, it } from "vitest";
import {
	BLOCK_DATA_SCHEMAS,
	BLOCK_KINDS,
	type CanvasBlockData,
	chartAspectRatio,
	defaultNodeWidth,
	estimatedNodeHeight,
	estimatedNodeSize,
	isBlockKind,
	MODEL_CREATABLE_KINDS,
	modelCreatableBlockDataSchema,
	NODE_WIDTH,
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

// RV-3 C2: the model plans a board with the size of each block, so the size it is
// told must be the size the panel draws. These are the heights the panel drew,
// measured in the browser for a note 190 wide (a note is as tall as its words),
// and the estimate is allowed to be one line too tall and never too short.
describe("the height a block is drawn at, as the model is told it (RV-3 C2)", () => {
	const sticky = (text: string, width?: number) => ({
		type: "sticky" as const,
		...(width === undefined ? {} : { width }),
		data: { kind: "sticky" as const, text, tone: "yellow" as const },
	});

	it("is the stored height when the block stores one, and a frame's own", () => {
		expect(estimatedNodeHeight({ ...sticky("x"), height: 140 })).toBe(140);
		expect(
			estimatedNodeHeight({
				type: "frame",
				data: { kind: "frame", label: "F", width: 300, height: 240 },
			}),
		).toBe(240);
		expect(
			estimatedNodeHeight({
				type: "frame",
				height: 200,
				data: { kind: "frame", label: "F", width: 300, height: 240 },
			}),
		).toBe(200);
	});

	// [characters, height the panel drew a note of that length at, in board units]
	const DRAWN: [number, number][] = [
		[6, 64],
		[28, 64],
		[40, 64],
		[58, 72],
		[79, 91],
		[98, 109],
		[116, 109],
		[119, 127],
		[156, 145],
		[178, 163],
	];

	it("is as tall as the panel draws a note, or up to two lines taller, and never shorter", () => {
		for (const [chars, drawn] of DRAWN) {
			const estimate = estimatedNodeHeight(
				sticky("word ".repeat(200).slice(0, chars)),
			);
			expect(estimate, `${chars} characters`).toBeGreaterThanOrEqual(drawn - 2);
			expect(estimate, `${chars} characters`).toBeLessThanOrEqual(drawn + 36);
		}
	});

	// Natural notes, drawn in the browser at 190 wide: Hungarian wraps worse than
	// English (long words waste the end of a line: the 99-character one took six
	// lines, 16.5 to a line), so the estimate is what no note was ever taller than.
	const NATURAL: [string, number][] = [
		[
			"Ebéd a Nagycsarnokban, utána séta a Duna-parton a Szabadság hídtól a Margit-szigetig",
			91,
		],
		[
			"Vacsora egy kis étteremben a Belvárosban, majd esti koncert a Művészetek Palotájában, ha marad jegy",
			127,
		],
		[
			"Kiadós brunch a Naschmarkton, közben megnézzük a bolhapiacot is, ha nem esik az eső",
			109,
		],
		[
			"Indulás a pályaudvarra legkésőbb tizenegy órakor, hogy biztosan elérjük a vonatot Budapest felé",
			109,
		],
		[
			"Metrójegy vagy heti bérlet? Kiszámolni, hogy melyik éri meg három napra két személynek",
			91,
		],
		[
			"Csomagolás: útlevél, töltő, esőkabát, kényelmes cipő a sok gyaloglás miatt",
			91,
		],
		[
			"Lunch at the market hall, then a long walk along the river from the old bridge to the island",
			91,
		],
		[
			"Dinner at a small restaurant in the old town, then an evening concert at the palace if tickets remain",
			109,
		],
		[
			"The Belvedere: Klimt's The Kiss, a coffee in the garden, then back to the hotel for the luggage",
			91,
		],
		[
			"Museum tickets bought online in advance because the queue at the door is very long in the morning",
			109,
		],
		[
			"Book a table for the evening at a traditional Viennese restaurant known for its Wiener Schnitzel",
			109,
		],
		["Breakfast at Café Central, then a slow walk along the Kohlmarkt", 72],
	];

	it("is never shorter than a natural Hungarian or English note was drawn, and never more than two lines taller", () => {
		for (const [text, drawn] of NATURAL) {
			const estimate = estimatedNodeHeight(sticky(text));
			expect(estimate, text).toBeGreaterThanOrEqual(drawn - 2);
			expect(estimate, text).toBeLessThanOrEqual(drawn + 36);
		}
	});

	it("gives a short note the smallest a note is, and each further line 18 more", () => {
		expect(estimatedNodeHeight(sticky("Museum, 10:00"))).toBe(64);
		expect(estimatedNodeHeight(sticky("x".repeat(36)))).toBe(64);
		expect(estimatedNodeHeight(sticky("x".repeat(37)))).toBe(72);
		const one = estimatedNodeHeight(sticky("word ".repeat(40)));
		const more = estimatedNodeHeight(sticky("word ".repeat(80)));
		expect(more).toBeGreaterThan(one);
		expect((more - one) % 18).toBe(0);
	});

	it("counts the lines a reader typed, and a wider note wraps later", () => {
		expect(estimatedNodeHeight(sticky("a\nb\nc\nd\ne"))).toBe(108);
		const text = "word ".repeat(30);
		expect(estimatedNodeHeight(sticky(text, 380))).toBeLessThan(
			estimatedNodeHeight(sticky(text, 190)),
		);
	});

	it("reads a checklist by its items and leaves the kinds it cannot judge at the default", () => {
		const list = (n: number) => ({
			type: "checklist" as const,
			data: {
				kind: "checklist" as const,
				items: Array.from({ length: n }, (_, i) => ({
					id: `i${i}`,
					text: "x",
					done: false,
				})),
			},
		});
		expect(estimatedNodeHeight(list(1))).toBe(100);
		expect(estimatedNodeHeight(list(5))).toBe(204);
		expect(
			estimatedNodeHeight({
				type: "map",
				data: sampleBoard().nodes.find((n) => n.type === "map")
					?.data as CanvasBlockData,
			}),
		).toBe(84);
	});
});

// RC-3 N1: a chart and a checklist are not note-sized. A chart 190 wide was a
// sliver of a plot under its legend, and planned at 84 tall against the ~143 the
// panel draws; a checklist 190 wide cut every natural item off at about 16
// characters. Each kind has ONE default width (what Alfy's add stores, what the
// board draws an unsized block at, what the model's read and the eval's
// geometry report), and a chart's height is the one the panel draws: measured in
// the browser at zoom 1 for a chart of each type and width.
describe("the size a block has when it stores none (RC-3 N1)", () => {
	const chart = (type: string, width?: number, extra: object = {}) => ({
		type: "chart" as const,
		...(width === undefined ? {} : { width }),
		data: {
			kind: "chart" as const,
			code: JSON.stringify({
				type,
				data: { labels: ["A", "B"], datasets: [{ data: [1, 2] }] },
				...extra,
			}),
		},
	});

	it("has one width per kind: a note's 190, and the checklist's and the chart's own", () => {
		expect(NODE_WIDTH).toBe(190);
		expect(defaultNodeWidth("sticky")).toBe(190);
		expect(defaultNodeWidth("text")).toBe(190);
		expect(defaultNodeWidth("checklist")).toBe(340);
		expect(defaultNodeWidth("chart")).toBe(360);
		// A kind the model cannot make keeps the blanket width it always had.
		expect(defaultNodeWidth("map")).toBe(190);
	});

	// [type, width, the node height the panel drew, in board units]
	const DRAWN_CHARTS: [string, number, number][] = [
		["bar", 190, 143],
		["bar", 240, 168],
		["bar", 360, 228],
		["bar", 420, 258],
		["line", 360, 228],
		["scatter", 300, 198],
		["pie", 190, 227],
		["pie", 360, 397],
		["doughnut", 300, 337],
		["radar", 420, 457],
	];

	it("is as tall as the panel draws a chart: the header, and a plot twice as wide as tall (square for a pie), never shorter", () => {
		for (const [type, width, drawn] of DRAWN_CHARTS) {
			const estimate = estimatedNodeHeight(chart(type, width));
			expect(estimate, `${type} ${width}`).toBeGreaterThanOrEqual(drawn);
			expect(estimate, `${type} ${width}`).toBeLessThanOrEqual(drawn + 2);
		}
	});

	it("takes an unsized chart at its own width, so the model and the board agree on the box", () => {
		expect(estimatedNodeSize(chart("bar"))).toEqual({
			width: 360,
			height: 228,
		});
		expect(estimatedNodeSize(chart("pie"))).toEqual({
			width: 360,
			height: 397,
		});
		expect(
			estimatedNodeSize({
				type: "checklist",
				data: { kind: "checklist", items: [] },
			}),
		).toEqual({ width: 340, height: 74 });
		expect(
			estimatedNodeSize({
				type: "frame",
				data: { kind: "frame", label: "F", width: 300, height: 240 },
			}),
		).toEqual({ width: 300, height: 240 });
		expect(estimatedNodeSize({ ...chart("bar", 420), height: 300 })).toEqual({
			width: 420,
			height: 300,
		});
	});

	it("reads the aspect ratio a config asks for, and the type's own otherwise", () => {
		expect(chartAspectRatio(chart("bar").data.code)).toBe(2);
		expect(chartAspectRatio(chart("PolarArea").data.code)).toBe(1);
		expect(
			chartAspectRatio(
				chart("bar", 0, { options: { aspectRatio: 4 } }).data.code,
			),
		).toBe(4);
		// Not a ratio Chart.js would keep: the type's own.
		expect(
			chartAspectRatio(
				chart("pie", 0, { options: { maintainAspectRatio: false } }).data.code,
			),
		).toBe(1);
		expect(
			chartAspectRatio(
				chart("bar", 0, { options: { aspectRatio: 0 } }).data.code,
			),
		).toBe(2);
		// A config that is not JSON is drawn as its source, and is estimated like a bar.
		expect(chartAspectRatio("not json")).toBe(2);
		expect(chartAspectRatio("[1, 2]")).toBe(2);
	});
});
