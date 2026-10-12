import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "$lib/i18n";
import { BLOCK_DATA_SCHEMAS } from "$lib/shared/artifacts/canvas-blocks";
import {
	type CanvasChatBlocks,
	type ChatMapBlock,
	type ChatPhotoBlock,
	type ChatSearchBlock,
	emptyChatBlocks,
} from "$lib/shared/artifacts/chat-blocks";
import { uiLanguage } from "$lib/stores/settings";
import { chatBlockGroups, mapBlockData } from "./chat-block-data";

// What the Insert menu's "From this chat" section shows for each thing the chat
// made, and what a pick puts on the board. The labels are the chat's own: a
// route reads exactly as its activity row reads it, in the reader's language.

const translate = () => get(t);

beforeEach(() => {
	uiLanguage.set("en");
});

const MAP = {
	bounds: { minLat: 51.7, minLng: -8.5, maxLat: 51.9, maxLng: -8.4 },
	distanceM: 27_000,
	durationS: 2040,
	originLabel: "Cork",
	destinationLabel: "Kinsale",
	attribution: "© OpenStreetMap contributors",
};

function mapItem(overrides: Partial<ChatMapBlock> = {}): ChatMapBlock {
	return {
		key: "map:m1:c1",
		at: 1_000,
		action: "route",
		map: MAP,
		...overrides,
	};
}

describe("a route map, as a block", () => {
	it("reads its route and its summary the way the chat's own activity row reads them", () => {
		const data = mapBlockData(mapItem(), translate());
		expect(data).toEqual({
			kind: "map",
			route: "Cork → Kinsale",
			meta: "27.0 km · 34 min",
			map: MAP,
		});
	});

	it("keeps the map exactly as the chat's card draws it, and passes the map block's own schema", () => {
		const data = mapBlockData(mapItem(), translate());
		expect(data.map).toBe(MAP);
		expect(BLOCK_DATA_SCHEMAS.map.safeParse(data).success).toBe(true);
	});

	it("reads a public-transport journey by its own grammar: time and changes, not distance", () => {
		const data = mapBlockData(
			mapItem({
				action: "transit",
				map: { ...MAP, mode: "transit", transfers: 1, durationS: 4320 },
			}),
			translate(),
		);
		expect(data.meta).toBe("1 h 12 min · 1 transfer");
	});

	it("says a transit summary in Hungarian in Hungarian", () => {
		uiLanguage.set("hu");
		const data = mapBlockData(
			mapItem({
				action: "transit",
				map: { ...MAP, mode: "transit", transfers: 2, durationS: 1800 },
			}),
			translate(),
		);
		expect(data.meta).toContain("30 min");
		expect(data.meta).not.toContain("transfers");
	});

	it("leaves the summary out when the route has none to give", () => {
		const data = mapBlockData(
			mapItem({ map: { ...MAP, distanceM: undefined, durationS: undefined } }),
			translate(),
		);
		expect(data.meta).toBeUndefined();
		expect(BLOCK_DATA_SCHEMAS.map.safeParse(data).success).toBe(true);
	});

	it("names no route for a map with no labels, and stays a valid block", () => {
		const data = mapBlockData(
			mapItem({
				map: { ...MAP, originLabel: undefined, destinationLabel: undefined },
			}),
			translate(),
		);
		expect(data.route).toBe("");
		expect(BLOCK_DATA_SCHEMAS.map.safeParse(data).success).toBe(true);
	});

	it("cuts a route name at the limit the block keeps, so a block is never dropped on save for its label", () => {
		const long = "x".repeat(900);
		const data = mapBlockData(
			mapItem({ map: { ...MAP, originLabel: long, destinationLabel: long } }),
			translate(),
		);
		expect(data.route.length).toBeLessThanOrEqual(500);
		expect(BLOCK_DATA_SCHEMAS.map.safeParse(data).success).toBe(true);
	});

	it("takes a call with no action as a plain route", () => {
		const data = mapBlockData(mapItem({ action: null }), translate());
		expect(data.meta).toBe("27.0 km · 34 min");
	});
});

const LISTING: CanvasChatBlocks = {
	files: [
		{
			key: "file:f1",
			at: 5_000,
			origin: "produced",
			version: 1,
			data: {
				kind: "file",
				fileId: "f1",
				name: "Vienna trip.pdf",
				mime: "application/pdf",
				bytes: 2048,
				label: "PDF",
			},
		},
		{
			key: "attachment:a1",
			at: 4_000,
			origin: "attached",
			version: null,
			data: {
				kind: "file",
				fileId: "artifact:a1",
				name: "notes",
				mime: "",
				bytes: 0,
				label: "",
			},
		},
	],
	apps: [
		{
			key: "app:app-1",
			at: 3_000,
			versionNumber: 3,
			data: { kind: "app", artifactId: "app-1", title: "Tip calculator" },
		},
	],
	maps: [mapItem()],
	charts: [
		{
			key: "chart:m:0",
			at: 2_000,
			title: "Sales",
			chartType: "bar",
			data: { kind: "chart", code: '{"type":"bar"}' },
		},
		{
			key: "chart:m:1",
			at: 1_000,
			title: null,
			chartType: "line",
			data: { kind: "chart", code: '{"type":"line"}' },
		},
		{
			key: "chart:m:2",
			at: 500,
			title: null,
			chartType: null,
			data: { kind: "chart", code: "{}" },
		},
	],
	diagrams: [],
	photos: [],
	searches: [],
};

const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);

/** What a chat that drew three Mermaid diagrams lists: one titled, two by their kind, one of a kind with no name of its own. */
const DIAGRAMS: CanvasChatBlocks["diagrams"] = [
	{
		key: "mermaid:m:0",
		at: NOW - 60_000,
		title: "Release plan",
		diagramType: "gantt",
		data: {
			kind: "mermaid",
			label: "Release plan",
			code: "gantt\n  title Release plan",
		},
	},
	{
		key: "mermaid:m:1",
		at: NOW - 120_000,
		title: null,
		diagramType: "sequenceDiagram",
		data: { kind: "mermaid", code: "sequenceDiagram\n  A->>B: hi" },
	},
	{
		key: "mermaid:m:2",
		at: NOW - 180_000,
		title: null,
		diagramType: "stateDiagram-v2",
		data: { kind: "mermaid", code: "stateDiagram-v2\n  [*] --> A" },
	},
	{
		key: "mermaid:m:3",
		at: NOW - 240_000,
		title: null,
		diagramType: "mindmap",
		data: { kind: "mermaid", code: "mindmap\n  root" },
	},
	{
		key: "mermaid:m:4",
		at: NOW - 300_000,
		title: null,
		diagramType: null,
		data: { kind: "mermaid", code: "x" },
	},
];

function photoItem(
	overrides: Partial<ChatPhotoBlock> & { count?: number } = {},
): ChatPhotoBlock {
	const { count = 3, ...rest } = overrides;
	return {
		key: "photos:m1:c1",
		at: NOW - 5 * 60_000,
		query: "beach",
		data: {
			kind: "photo",
			items: Array.from({ length: count }, (_, index) => ({
				id: `asset-${index}`,
				imageUrl: `/api/connections/immich/thumbnail/asset-${index}`,
			})),
		},
		...rest,
	};
}

function searchItem(
	overrides: Partial<ChatSearchBlock> & { count?: number; query?: string } = {},
): ChatSearchBlock {
	const { count = 4, query = "cork weather", ...rest } = overrides;
	return {
		key: "search:m1:c1",
		at: NOW - 90 * 60_000,
		data: {
			kind: "liveweb",
			query,
			fetchedAt: NOW - 90 * 60_000,
			sources: Array.from({ length: count }, (_, index) => ({
				id: `s${index}`,
				title: `Result ${index}`,
				url: `https://example.com/${index}`,
				provider: "parallel",
				authorityClass: "primary",
				authorityScore: 0.9,
				publishedAt: null,
				updatedAt: null,
			})),
		},
		...rest,
	};
}

describe("the section's groups", () => {
	it("groups by kind in one fixed order, and hides a kind the chat has none of", () => {
		expect(chatBlockGroups(LISTING, translate()).map((g) => g.kind)).toEqual([
			"file",
			"app",
			"map",
			"chart",
		]);
		expect(
			chatBlockGroups({ ...LISTING, files: [], maps: [] }, translate()).map(
				(g) => g.kind,
			),
		).toEqual(["app", "chart"]);
		expect(chatBlockGroups(emptyChatBlocks(), translate())).toEqual([]);
	});

	it("names each group by its kind, in both languages", () => {
		const en = chatBlockGroups(LISTING, translate()).map((g) => g.label);
		expect(en).toEqual(["Files", "Apps", "Maps", "Charts"]);
		uiLanguage.set("hu");
		const hu = chatBlockGroups(LISTING, translate()).map((g) => g.label);
		expect(hu).toEqual(["Fájlok", "Alkalmazások", "Térképek", "Diagramok"]);
	});

	it("reads a file by its name, with its type and its size beside it, and what a pick inserts is the file block itself", () => {
		const [files] = chatBlockGroups(LISTING, translate());
		expect(files.rows[0]).toMatchObject({
			key: "file:f1",
			name: "Vienna trip.pdf",
			meta: "PDF · 2.0 KB",
			data: LISTING.files[0].data,
		});
	});

	// Ruling 76 (Q2): a version number is printed in History's fine print and nowhere
	// else, so the Insert menu's rows do not say which version a file or an App is.
	it("never prints a version number: a file, once it is not the first version, reads as it did at version one", () => {
		const [files] = chatBlockGroups(
			{
				...LISTING,
				files: [{ ...LISTING.files[0], version: 3 }],
			},
			translate(),
		);
		expect(files.rows[0].meta).toBe("PDF · 2.0 KB");
	});

	it("gives a file with no type and no size only its name", () => {
		const [files] = chatBlockGroups(LISTING, translate());
		expect(files.rows[1]).toMatchObject({ name: "notes", meta: "" });
	});

	it("reads an App by its title alone, whichever version it is at", () => {
		const groups = chatBlockGroups(LISTING, translate());
		const apps = groups.find((g) => g.kind === "app");
		expect(apps?.rows[0]).toMatchObject({
			name: "Tip calculator",
			meta: "",
			data: LISTING.apps[0].data,
		});
	});

	// F9 (the friction audit): two Apps called "Tip calculator", or two exports of one
	// document that the menu's width cuts to the same words, read as one row twice.
	// Rows that read alike say when each was made (never which version it is); a row
	// with a name of its own stays as it was.
	describe("rows that read alike", () => {
		const SAME_DAY = new Date();
		SAME_DAY.setHours(14, 32, 7, 0);
		const sameDay = (secondsLater: number) =>
			SAME_DAY.getTime() + secondsLater * 1000;
		const appRow = (key: string, at: number) => ({
			key,
			at,
			versionNumber: 1,
			data: { kind: "app" as const, artifactId: key, title: "Tip calculator" },
		});
		const fileRow = (key: string, at: number) => ({
			key,
			at,
			origin: "produced" as const,
			version: 1,
			data: {
				kind: "file" as const,
				fileId: key,
				name: "becsi-hetvegi-utiterv-szombat-vasarnap.docx",
				mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				bytes: 10_637,
				label: "DOCX",
			},
		});

		it("tells two Apps of one name apart by the time each was made, and prints no version", () => {
			const groups = chatBlockGroups(
				{
					...emptyChatBlocks(),
					apps: [
						appRow("app:b", sameDay(0)),
						appRow("app:a", sameDay(0) - 25 * 60_000),
					],
				},
				translate(),
				"en",
			);
			const [newer, older] = groups[0].rows;
			expect(newer.meta).toBe("02:32 PM");
			expect(older.meta).toBe("02:07 PM");
			expect(`${newer.meta}${older.meta}`).not.toMatch(/\bv\d|version/i);
		});

		it("keeps a file's type and size and adds the time after them", () => {
			const groups = chatBlockGroups(
				{
					...emptyChatBlocks(),
					files: [
						fileRow("file:2", sameDay(0)),
						fileRow("file:1", sameDay(-3600)),
					],
				},
				translate(),
				"en",
			);
			expect(groups[0].rows.map((row) => row.meta)).toEqual([
				"DOCX · 10.4 KB · 02:32 PM",
				"DOCX · 10.4 KB · 01:32 PM",
			]);
		});

		it("adds the seconds when two of them were made in one minute, as two exports a few seconds apart are", () => {
			const groups = chatBlockGroups(
				{
					...emptyChatBlocks(),
					files: [
						fileRow("file:2", sameDay(11)),
						fileRow("file:1", sameDay(0)),
					],
				},
				translate(),
				"en",
			);
			const [second, first] = groups[0].rows;
			expect(second.meta).toBe("DOCX · 10.4 KB · 02:32:18 PM");
			expect(first.meta).toBe("DOCX · 10.4 KB · 02:32:07 PM");
		});

		it("says the day too for one that was not made today, and in the reader's language", () => {
			const groups = chatBlockGroups(
				{
					...emptyChatBlocks(),
					apps: [
						appRow("app:b", Date.UTC(2026, 8, 30, 12, 0, 0)),
						appRow("app:a", Date.UTC(2026, 8, 29, 12, 0, 0)),
					],
				},
				translate(),
				"hu",
			);
			const [newer, older] = groups[0].rows;
			expect(newer.meta).toContain("szept. 30.");
			expect(older.meta).toContain("szept. 29.");
		});

		it("leaves a row with a name of its own alone, and only the rows that share one get a time", () => {
			const groups = chatBlockGroups(
				{
					...emptyChatBlocks(),
					apps: [
						appRow("app:b", sameDay(0)),
						{
							...appRow("app:c", sameDay(-60)),
							data: {
								kind: "app" as const,
								artifactId: "app:c",
								title: "Budget",
							},
						},
						appRow("app:a", sameDay(-3600)),
					],
				},
				translate(),
				"en",
			);
			expect(groups[0].rows.map((row) => row.meta)).toEqual([
				"02:32 PM",
				"",
				"01:32 PM",
			]);
		});
	});

	it("reads a route as the block will read it, and inserts the map block built from it", () => {
		const groups = chatBlockGroups(LISTING, translate());
		const maps = groups.find((g) => g.kind === "map");
		expect(maps?.rows[0]).toMatchObject({
			name: "Cork → Kinsale",
			meta: "27.0 km · 34 min",
		});
		expect(maps?.rows[0].data).toEqual(mapBlockData(mapItem(), translate()));
	});

	it("reads a chart by its title, else by its kind of chart, else plainly; and says when it was drawn", () => {
		const groups = chatBlockGroups(LISTING, translate());
		const charts = groups.find((g) => g.kind === "chart");
		expect(charts?.rows.map((row) => row.name)).toEqual([
			"Sales",
			"Line chart",
			"Chart",
		]);
		for (const row of charts?.rows ?? [])
			expect(row.meta.length).toBeGreaterThan(0);
		expect(charts?.rows[0].data).toEqual(LISTING.charts[0].data);
	});

	it("names a chart's kind in Hungarian in Hungarian", () => {
		uiLanguage.set("hu");
		const groups = chatBlockGroups(LISTING, translate());
		const charts = groups.find((g) => g.kind === "chart");
		expect(charts?.rows.map((row) => row.name)).toEqual([
			"Sales",
			"Vonaldiagram",
			"Diagram",
		]);
	});

	it("lists diagrams under their own heading, right after the charts", () => {
		const groups = chatBlockGroups(
			{ ...LISTING, diagrams: DIAGRAMS },
			translate(),
		);
		expect(groups.map((g) => g.kind)).toEqual([
			"file",
			"app",
			"map",
			"chart",
			"mermaid",
		]);
		expect(groups.at(-1)?.label).toBe("Diagrams");
		uiLanguage.set("hu");
		expect(
			chatBlockGroups({ ...LISTING, diagrams: DIAGRAMS }, translate()).at(-1)
				?.label,
		).toBe("Ábrák");
	});

	it("reads a diagram by its title, else by its kind of diagram, else plainly; and what a pick inserts is the diagram block itself", () => {
		const group = chatBlockGroups(
			{ ...emptyChatBlocks(), diagrams: DIAGRAMS },
			translate(),
		)[0];
		expect(group.kind).toBe("mermaid");
		expect(group.rows.map((row) => row.name)).toEqual([
			"Release plan",
			"Sequence diagram",
			"State diagram",
			"Diagram",
			"Diagram",
		]);
		for (const row of group.rows) {
			expect(row.kind).toBe("mermaid");
			expect(row.meta.length).toBeGreaterThan(0);
		}
		expect(group.rows[1].data).toEqual(DIAGRAMS[1].data);
	});

	it("names a diagram's kind in Hungarian in Hungarian", () => {
		uiLanguage.set("hu");
		const [group] = chatBlockGroups(
			{ ...emptyChatBlocks(), diagrams: DIAGRAMS },
			translate(),
		);
		expect(group.rows.map((row) => row.name)).toEqual([
			"Release plan",
			"Szekvenciadiagram",
			"Állapotdiagram",
			"Ábra",
			"Ábra",
		]);
	});

	it("keeps each group's order as the listing gave it (newest first)", () => {
		const [files] = chatBlockGroups(LISTING, translate());
		expect(files.rows.map((row) => row.key)).toEqual([
			"file:f1",
			"attachment:a1",
		]);
	});

	it("gives every row a key of its own", () => {
		const keys = chatBlockGroups(LISTING, translate()).flatMap((g) =>
			g.rows.map((row) => row.key),
		);
		expect(new Set(keys).size).toBe(keys.length);
	});
});

describe("photo searches and web searches, as rows", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});
	afterEach(() => vi.useRealTimers());

	it("comes after the charts in the fixed order, one group each", () => {
		const groups = chatBlockGroups(
			{ ...LISTING, photos: [photoItem()], searches: [searchItem()] },
			translate(),
		);
		expect(groups.map((g) => g.kind)).toEqual([
			"file",
			"app",
			"map",
			"chart",
			"photo",
			"liveweb",
		]);
		expect(groups.slice(-2).map((g) => g.label)).toEqual([
			"Photos",
			"Web searches",
		]);
		uiLanguage.set("hu");
		expect(
			chatBlockGroups(
				{ ...LISTING, photos: [photoItem()], searches: [searchItem()] },
				translate(),
			)
				.slice(-2)
				.map((g) => g.label),
		).toEqual(["Fényképek", "Webes keresések"]);
	});

	it("reads a photo search by what was looked for, with how many photos it found and how long ago, and inserts exactly its block", () => {
		const item = photoItem();
		const [group] = chatBlockGroups(
			{ ...emptyChatBlocks(), photos: [item] },
			translate(),
		);
		expect(group.kind).toBe("photo");
		expect(group.rows[0]).toMatchObject({
			key: "photos:m1:c1",
			kind: "photo",
			name: "beach",
			meta: "3 photos · 5 min ago",
			data: item.data,
		});
		expect(BLOCK_DATA_SCHEMAS.photo.safeParse(group.rows[0].data).success).toBe(
			true,
		);
	});

	it("says one photo in the singular, and a search that named nothing plainly", () => {
		const [group] = chatBlockGroups(
			{
				...emptyChatBlocks(),
				photos: [
					photoItem({ count: 1, query: null }),
					photoItem({ key: "p2", count: 2, query: null }),
				],
			},
			translate(),
		);
		expect(group.rows[0].meta).toBe("1 photo · 5 min ago");
		expect(group.rows[0].name).toBe("Photo search");
		uiLanguage.set("hu");
		expect(
			chatBlockGroups(
				{ ...emptyChatBlocks(), photos: [photoItem({ query: null })] },
				translate(),
			)[0].rows[0].name,
		).toBe("Fényképkeresés");
	});

	it("reads a web search by its query, with how many sources came back and how long ago, and inserts exactly its block", () => {
		const item = searchItem();
		const [group] = chatBlockGroups(
			{ ...emptyChatBlocks(), searches: [item] },
			translate(),
		);
		expect(group.kind).toBe("liveweb");
		expect(group.rows[0]).toMatchObject({
			key: "search:m1:c1",
			kind: "liveweb",
			name: "cork weather",
			meta: "4 sources · 2 h ago",
			data: item.data,
		});
		expect(
			BLOCK_DATA_SCHEMAS.liveweb.safeParse(group.rows[0].data).success,
		).toBe(true);
	});

	it("says both in Hungarian, where the noun stays singular after a number", () => {
		uiLanguage.set("hu");
		const groups = chatBlockGroups(
			{
				...emptyChatBlocks(),
				photos: [photoItem()],
				searches: [searchItem({ count: 1 })],
			},
			translate(),
		);
		expect(groups[0].rows[0].meta).toBe("3 fénykép · 5 perce");
		expect(groups[1].rows[0].meta).toBe("1 forrás · 2 órája");
	});
});
