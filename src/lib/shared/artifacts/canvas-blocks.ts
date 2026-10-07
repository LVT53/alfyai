/**
 * The Canvas's block data — one zod schema per block kind, declared once
 * (ruling 64). Zod only: the server validates a stored board and a model's diff
 * with these, so nothing here may import a Svelte component or an icon. The
 * component registry (`_lib/block-registry.ts`) imports them and adds its own
 * component, icon, label, size and poster policy on top.
 *
 * Two strictnesses, on purpose. What the board STORES is lenient about keys it
 * does not read (they are stripped, never fatal: a board that is a version
 * behind still opens) and strict about the fields it does read. What the MODEL
 * writes goes through `modelCreatableBlockDataSchema`, the strict variants of
 * the six kinds it may add: a misspelt field is refused by name instead of
 * being stripped into an op that "worked" and changed nothing.
 */
import { z } from "zod";
import type { ToolCallMapData } from "$lib/server/services/messages-types";
import { isHttpSourceUrl, isPhotoProxyPath } from "./block-urls";
import {
	CHECKLIST_ITEM_MAX_CHARS,
	CHECKLIST_MAX_ITEMS,
	LABEL_MAX_CHARS,
	PHOTO_MAX_ITEMS,
	SOURCES_MAX,
	TEXT_MAX_CHARS,
} from "./canvas-limits";
import { estimatedDiagramHeight } from "./mermaid-size";
import type { ArtifactSource } from "./sources";

// ── Limits ───────────────────────────────────────────────────────────────
// The four a reader's own inputs also enforce live in `canvas-limits.ts` (the
// numbers alone, for code that needs no schema) and are re-exported here.
export {
	CHECKLIST_ITEM_MAX_CHARS,
	CHECKLIST_MAX_ITEMS,
	LABEL_MAX_CHARS,
	TEXT_MAX_CHARS,
};

const CHART_CODE_MAX_CHARS = 100_000;
/** A Mermaid source past this is not a diagram a reader drew or a model wrote; the chat's own longest ones are a few KB. */
const MERMAID_CODE_MAX_CHARS = 50_000;
const ID_MAX_CHARS = 128;

/**
 * What a node that stores no size of its own is taken to occupy until the
 * panel has measured it. Declared once, here, because two readers must agree
 * to the pixel: the board's geometry (`_lib/board.ts`: where a dropped block's
 * centre is, which frame it lands in) and the model's view of a board
 * (`canvas-model.ts`: the sizes Alfy arranges notes by). A number defined in
 * each would drift, and the model would leave gaps the board does not have.
 */
export const NODE_WIDTH = 190;
export const DEFAULT_NODE_HEIGHT = 84;

/**
 * The widths that differ from `NODE_WIDTH`, one per kind (RC-3 N1): a chart's
 * plot and a checklist's rows are made of more than a note's words. A chart 190
 * wide was a sliver of a plot under its legend; a checklist 190 wide cut its
 * items off at about 16 characters. These are the widths a reader's Insert gives
 * the two kinds, and the ONE place they are said: what the model's add stores,
 * what the board draws a block with no width at, what the model's read reports
 * and what the eval's geometry measures all come from `defaultNodeWidth`. The
 * checklist's holds an item of about 37 natural characters, measured in the
 * browser. A diagram is drawn as wide as its block and scales down to fit, so a
 * flowchart of ten boxes or a sequence of four lifelines needs more than a
 * chart's 360 to keep its words above ten pixels.
 */
const KIND_WIDTHS: Readonly<Partial<Record<BlockKind, number>>> = {
	checklist: 340,
	chart: 360,
	mermaid: 480,
};

/** The width a block of this kind is given when it is added, and drawn at when it stores none. */
export function defaultNodeWidth(kind: BlockKind): number {
	return KIND_WIDTHS[kind] ?? NODE_WIDTH;
}

// ── The height a block is drawn at (RV-3 C2) ─────────────────────────────

/**
 * Only a frame stores a height: every other block is as tall as its content,
 * so a note that grows with its words never clips them. The model plans a board
 * with sizes, though (what to leave between notes, how big a frame must be), so
 * what it is told of a block's height has to be what the panel draws. These are
 * the panel's own numbers for a block `NODE_WIDTH` wide, measured in the
 * browser: a note (`StickyNode.svelte`: 12.5px type at 1.45, 9px above and
 * below) is 64 tall for one or two lines and 18 more for each further one, a
 * checklist row is 26 with 74 above and below its rows. About 18 characters
 * fit a line of a note that wide: the width holds 24, and word wrap costs the
 * rest, more in Hungarian, whose long words waste the end of a line (natural
 * English and Hungarian notes measured at 16.5 to 23 a line). 18 is the most
 * that no natural note came out taller than, so the estimate is up to two lines
 * too tall and, in what was measured, never too short: an arrangement made from
 * it leaves slack, never an overlap.
 */
export const NOTE_MIN_HEIGHT = 64;
export const NOTE_LINE_HEIGHT = 18;
const NOTE_PADDING_HEIGHT = 18;
const TEXT_MIN_HEIGHT = 32;
const TEXT_PADDING_HEIGHT = 14;
const NOTE_SIDE_PADDING = 20;
/** Board units a character takes, word wrap's waste included (170 wide holds 18, not 24). */
const NOTE_CHAR_WIDTH = 9.4;
export const CHECKLIST_BASE_HEIGHT = 74;
export const CHECKLIST_ROW_HEIGHT = 26;
/**
 * A chart block is its card's header and padding (this much, measured) above a
 * plot as wide as the block less its side insets, and as tall as that width over
 * the plot's aspect ratio: Chart.js draws radial charts (pie, doughnut, polar
 * area, radar) square and the others twice as wide as tall, unless the config
 * asks for a ratio. The chart node lays the plot out at exactly that ratio, so
 * the estimate is the height drawn at any zoom (RC-3 N1).
 */
const CHART_CHROME_HEIGHT = 59;
const CHART_SIDE_INSET = 22;
const RADIAL_CHART_TYPES = new Set(["pie", "doughnut", "polararea", "radar"]);

/**
 * The width-over-height a chart's plot is drawn at, read off its Chart.js
 * config the way Chart.js reads it: the config's own `aspectRatio` when it keeps
 * one, else the type's (radial 1, the rest 2). A config that is not JSON is drawn
 * as its source, and is taken as a bar.
 */
export function chartAspectRatio(code: string): number {
	let config: unknown;
	try {
		config = JSON.parse(code);
	} catch {
		return 2;
	}
	if (typeof config !== "object" || config === null || Array.isArray(config)) {
		return 2;
	}
	const { type, options } = config as { type?: unknown; options?: unknown };
	if (typeof options === "object" && options !== null) {
		const { aspectRatio, maintainAspectRatio } = options as {
			aspectRatio?: unknown;
			maintainAspectRatio?: unknown;
		};
		if (
			maintainAspectRatio !== false &&
			typeof aspectRatio === "number" &&
			Number.isFinite(aspectRatio) &&
			aspectRatio > 0
		) {
			return aspectRatio;
		}
	}
	return typeof type === "string" &&
		RADIAL_CHART_TYPES.has(type.trim().toLowerCase())
		? 1
		: 2;
}

/** How many characters of a note's words fit a line of a block `width` wide (about 18 at `NODE_WIDTH`). */
export function charsPerLine(width: number = NODE_WIDTH): number {
	return Math.max(1, Math.floor((width - NOTE_SIDE_PADDING) / NOTE_CHAR_WIDTH));
}

/** How many lines `text` takes in a block `width` wide: each line a reader typed, wrapped at `charsPerLine`. */
function wrappedLines(text: string, width: number): number {
	const perLine = charsPerLine(width);
	return text
		.split("\n")
		.reduce(
			(lines, line) =>
				lines + Math.max(1, Math.ceil(Array.from(line).length / perLine)),
			0,
		);
}

type SizedNode = {
	type: BlockKind;
	width?: number;
	height?: number;
	data: CanvasBlockData;
};

/** The width a block is drawn at: the one it stores, a frame's own, or its kind's default. */
function estimatedNodeWidth(node: SizedNode): number {
	if (node.width !== undefined) return node.width;
	return node.data.kind === "frame"
		? node.data.width
		: defaultNodeWidth(node.type);
}

/**
 * The height a block is drawn at: the one it stores, a frame's own, or an
 * estimate from its words (a note, a text), its items (a checklist), its plot
 * (a chart) or its layout (a diagram: `mermaid-size.ts` reads the source the way
 * Mermaid lays it out). The kinds whose height the app decides (a map, a file, an
 * App, photos, a web search) are left at `DEFAULT_NODE_HEIGHT`.
 */
export function estimatedNodeHeight(node: SizedNode): number {
	if (node.height !== undefined) return node.height;
	const data = node.data;
	const width = estimatedNodeWidth(node);
	switch (data.kind) {
		case "frame":
			return data.height;
		case "sticky":
			return Math.max(
				NOTE_MIN_HEIGHT,
				NOTE_PADDING_HEIGHT + NOTE_LINE_HEIGHT * wrappedLines(data.text, width),
			);
		case "text":
			return Math.max(
				TEXT_MIN_HEIGHT,
				TEXT_PADDING_HEIGHT + NOTE_LINE_HEIGHT * wrappedLines(data.text, width),
			);
		case "checklist":
			return CHECKLIST_BASE_HEIGHT + CHECKLIST_ROW_HEIGHT * data.items.length;
		case "chart":
			return Math.ceil(
				CHART_CHROME_HEIGHT +
					Math.max(0, width - CHART_SIDE_INSET) / chartAspectRatio(data.code),
			);
		case "mermaid":
			return estimatedDiagramHeight(data.code, width);
		default:
			return DEFAULT_NODE_HEIGHT;
	}
}

/**
 * The box a block is taken to occupy until the panel has measured it: what the
 * model's read reports, what the board's geometry places by and what the eval's
 * rubric judges overlap with. One function, so the three cannot drift.
 */
export function estimatedNodeSize(node: SizedNode): {
	width: number;
	height: number;
} {
	return {
		width: estimatedNodeWidth(node),
		height: estimatedNodeHeight(node),
	};
}

const idSchema = z.string().min(1).max(ID_MAX_CHARS);
const labelSchema = z.string().max(LABEL_MAX_CHARS);

// ── Shared pieces ────────────────────────────────────────────────────────

export const STICKY_TONES = ["yellow", "mint", "blue", "plain"] as const;
const stickyToneSchema = z.enum(STICKY_TONES);

/** A poster is a generated PNG file, produced by the existing chat-files storage. */
const posterRefSchema = z.object({
	fileId: idSchema, // /api/chat/files/{fileId}/preview and /download
	width: z.number().positive(),
	height: z.number().positive(),
	capturedAt: z.number(),
});

export type PosterRef = z.infer<typeof posterRefSchema>;

// ── The six kinds Alfy may write: five note-shaped, and a diagram ────────

const frameDataSchema = z.object({
	kind: z.literal("frame"),
	label: labelSchema,
	width: z.number().positive(),
	height: z.number().positive(),
});

const stickyDataSchema = z.object({
	kind: z.literal("sticky"),
	text: z.string().max(TEXT_MAX_CHARS),
	tone: stickyToneSchema,
});

const textDataSchema = z.object({
	kind: z.literal("text"),
	text: z.string().max(TEXT_MAX_CHARS),
});

const chartDataSchema = z.object({
	kind: z.literal("chart"),
	label: labelSchema.optional(),
	subtitle: labelSchema.optional(),
	/** The chat's chart fence body: a Chart.js config as JSON, passed to `Chart.svelte` exactly as the chat does. */
	code: z.string().min(1).max(CHART_CODE_MAX_CHARS),
});

const mermaidDataSchema = z.object({
	kind: z.literal("mermaid"),
	label: labelSchema.optional(),
	subtitle: labelSchema.optional(),
	/** The chat's diagram fence body: Mermaid source, passed to `Mermaid.svelte` exactly as the chat does. */
	code: z
		.string()
		.min(1)
		.max(MERMAID_CODE_MAX_CHARS)
		.describe(
			"Mermaid source as in a chat reply's ```mermaid fence, without the fence: a flowchart, sequence, state, class, ER, gantt or pie diagram. Quote a label that has ( ) : or \" in it.",
		),
});

const checklistDataSchema = z.object({
	kind: z.literal("checklist"),
	label: labelSchema.optional(),
	items: z
		.array(
			z.object({
				id: idSchema,
				text: z.string().max(CHECKLIST_ITEM_MAX_CHARS),
				done: z.boolean(),
			}),
		)
		.max(CHECKLIST_MAX_ITEMS),
});

// ── The five kinds that carry app-owned references ───────────────────────

const latLngSchema = z.tuple([z.number(), z.number()]);
const indexRangeSchema = z.tuple([z.number(), z.number()]);

const mapStepSchema = z.object({
	instruction: z.string(),
	maneuver: z.enum([
		"depart",
		"straight",
		"left",
		"slight-left",
		"sharp-left",
		"right",
		"slight-right",
		"sharp-right",
		"u-turn",
		"roundabout",
		"exit-roundabout",
		"keep-left",
		"keep-right",
		"merge",
		"arrive",
		"other",
	]),
	distanceM: z.number(),
	durationS: z.number(),
	name: z.string().optional(),
	wayPointRange: indexRangeSchema.optional(),
});

/**
 * A mirror of `ToolCallMapData` (`messages-types.ts`), the shape the chat's
 * `MapRouteCard.svelte` eats — not a second shape: the assertion below fails
 * the type check the day the two drift apart.
 */
const toolCallMapDataSchema = z.object({
	bounds: z.object({
		minLat: z.number(),
		minLng: z.number(),
		maxLat: z.number(),
		maxLng: z.number(),
	}),
	markers: z
		.array(
			z.object({
				lat: z.number(),
				lng: z.number(),
				label: z.string().optional(),
				kind: z.enum(["origin", "destination", "waypoint", "point"]).optional(),
			}),
		)
		.optional(),
	polyline: z.array(latLngSchema).optional(),
	polygons: z
		.array(
			z.object({
				points: z.array(latLngSchema),
				rangeS: z.number().optional(),
			}),
		)
		.optional(),
	distanceM: z.number().optional(),
	durationS: z.number().optional(),
	mode: z.enum(["drive", "walk", "bike", "transit", "journey"]).optional(),
	originLabel: z.string().optional(),
	destinationLabel: z.string().optional(),
	transitLegs: z
		.array(
			z.object({
				type: z.enum(["walk", "pt", "drive", "bike"]),
				line: z.string().optional(),
				headsign: z.string().optional(),
				from: z.string().optional(),
				to: z.string().optional(),
				depart: z.string().optional(),
				arrive: z.string().optional(),
				stops: z.number().optional(),
				minutes: z.number(),
				vehicle: z.string().optional(),
				platform: z.string().optional(),
				distanceM: z.number().optional(),
				color: z.string().optional(),
				steps: z.array(mapStepSchema).optional(),
				pointRange: indexRangeSchema.optional(),
			}),
		)
		.optional(),
	departures: z
		.array(
			z.object({
				depart: z.string().optional(),
				arrive: z.string().optional(),
				minutes: z.number(),
				transfers: z.number(),
				line: z.string().optional(),
			}),
		)
		.optional(),
	transfers: z.number().optional(),
	steps: z.array(mapStepSchema).optional(),
	ascentM: z.number().optional(),
	descentM: z.number().optional(),
	via: z.string().optional(),
	departAt: z.string().optional(),
	arriveAt: z.string().optional(),
	departDate: z.string().optional(),
	arriveBy: z.string().optional(),
	attribution: z.string(),
});

const mapDataSchema = z.object({
	kind: z.literal("map"),
	label: labelSchema.optional(),
	route: z.string().max(LABEL_MAX_CHARS),
	meta: labelSchema.optional(),
	map: toolCallMapDataSchema,
	poster: posterRefSchema.optional(),
});

const fileDataSchema = z.object({
	kind: z.literal("file"),
	/** A produced file's chat-file id, or `artifact:<id>` for a file the reader attached (`chat-blocks.ts`: `fileBlockSource`). */
	fileId: idSchema,
	name: z.string().min(1).max(300),
	mime: z.string().max(200),
	bytes: z.number().int().nonnegative(),
	/** Display type, e.g. "PDF". */
	label: z.string().max(50),
});

const appDataSchema = z.object({
	kind: z.literal("app"),
	artifactId: idSchema,
	title: labelSchema,
	poster: posterRefSchema.optional(),
});

/**
 * A photo is one of the app's own thumbnail proxies, and nothing else. A board
 * never loads a picture from outside the app: an image URL is a request the
 * browser makes on its own, so an address from anywhere else would let whatever
 * wrote the board (a model included) send a page's contents to a stranger in the
 * query string, and a path of the app's own that is not the proxy would make the
 * browser call another route with the reader's cookies. The rule is
 * `block-urls.ts`'s, which the listing and the block that draws it hold to as well.
 */
const photoUrlSchema = z
	.string()
	.refine(
		isPhotoProxyPath,
		"an image must be one of the app's own thumbnail paths",
	);

const photoDataSchema = z.object({
	kind: z.literal("photo"),
	items: z
		.array(
			z.object({
				id: idSchema,
				imageUrl: photoUrlSchema,
				alt: labelSchema.optional(),
			}),
		)
		.max(PHOTO_MAX_ITEMS),
	poster: posterRefSchema.optional(),
});

/** A mirror of the web-grounding payload source (`ArtifactSource`), pinned by the assertion below. */
const artifactSourceSchema = z.object({
	id: z.string(),
	title: z.string(),
	url: z
		.string()
		.refine(isHttpSourceUrl, "a source link must be a web address"),
	provider: z.string(),
	authorityClass: z.string(),
	authorityScore: z.number(),
	publishedAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
	snippet: z.string().optional(),
});

const livewebDataSchema = z.object({
	kind: z.literal("liveweb"),
	query: labelSchema,
	sources: z.array(artifactSourceSchema).max(SOURCES_MAX),
	fetchedAt: z.number(),
	poster: posterRefSchema.optional(),
});

// ── The registry of schemas ──────────────────────────────────────────────

/** kind → its data schema. The one place a new kind is added on the shared side. */
export const BLOCK_DATA_SCHEMAS = {
	frame: frameDataSchema,
	sticky: stickyDataSchema,
	text: textDataSchema,
	chart: chartDataSchema,
	mermaid: mermaidDataSchema,
	checklist: checklistDataSchema,
	map: mapDataSchema,
	file: fileDataSchema,
	app: appDataSchema,
	photo: photoDataSchema,
	liveweb: livewebDataSchema,
} as const;

export type BlockKind = keyof typeof BLOCK_DATA_SCHEMAS;
export type CanvasBlockData = z.infer<(typeof BLOCK_DATA_SCHEMAS)[BlockKind]>;

export const BLOCK_KINDS = Object.keys(BLOCK_DATA_SCHEMAS) as BlockKind[];

export function isBlockKind(value: unknown): value is BlockKind {
	return typeof value === "string" && Object.hasOwn(BLOCK_DATA_SCHEMAS, value);
}

/**
 * What the model may add to a board (ruling 64, amended by ruling 74): the six
 * kinds that carry only what it can write — the five note-shaped ones, and a
 * diagram, whose Mermaid source it writes exactly as it does in a chat reply
 * and which the board draws with the chat's own component. The others carry
 * app-owned references (a file, an App, a route, a photo, a fetched page) it
 * cannot mint, so the user places those, and an `add_node` of one is refused
 * `unknown_kind`. Strict variants of the stored schemas: what the model writes
 * must not carry a field the block does not read, or a misspelt one would be
 * stripped into an op that "worked" and changed nothing.
 */
export const MODEL_CREATABLE_DATA_SCHEMAS = {
	frame: frameDataSchema.strict(),
	sticky: stickyDataSchema.strict(),
	text: textDataSchema.strict(),
	checklist: checklistDataSchema.strict(),
	chart: chartDataSchema.strict(),
	mermaid: mermaidDataSchema.strict(),
} as const;

export type ModelCreatableKind = keyof typeof MODEL_CREATABLE_DATA_SCHEMAS;

export const MODEL_CREATABLE_KINDS = Object.keys(
	MODEL_CREATABLE_DATA_SCHEMAS,
) as ModelCreatableKind[];

export function isModelCreatableKind(
	value: unknown,
): value is ModelCreatableKind {
	return (
		typeof value === "string" &&
		Object.hasOwn(MODEL_CREATABLE_DATA_SCHEMAS, value)
	);
}

/**
 * What the model may change on a block that is already on the board (ruling 67).
 * The six kinds the model may add are its own words, so every field of them
 * (but `kind`). The other five carry what the app vouches for — the search a web
 * block claims to be, the photos, the file, the App a block shows, a map's route,
 * and any block's poster — and those are set only by the app (the Insert menu,
 * Refresh, the poster capture): a turn that could rewrite them could plant its
 * own links, dressed as the app's search result with a fresh "Updated" line, and
 * every source's favicon would then contact whatever host it names on each open.
 * On them the model may change the descriptive part only. (A diagram is not one
 * of the five: ruling 74 made it the model's own words, so every field of it is
 * the model's to change, its source included.)
 */
const APP_OWNED_UPDATABLE_FIELDS = {
	map: ["label", "route", "meta"],
	file: [],
	app: ["title"],
	photo: [],
	liveweb: [],
} as const;

export function modelUpdatableFields(kind: BlockKind): readonly string[] {
	if (isModelCreatableKind(kind)) {
		return Object.keys(BLOCK_DATA_SCHEMAS[kind].shape).filter(
			(field) => field !== "kind",
		);
	}
	return APP_OWNED_UPDATABLE_FIELDS[kind];
}

/** The advertised and the executed `data` of an `add_node`: one union of the six. */
export const modelCreatableBlockDataSchema = z.discriminatedUnion("kind", [
	MODEL_CREATABLE_DATA_SCHEMAS.frame,
	MODEL_CREATABLE_DATA_SCHEMAS.sticky,
	MODEL_CREATABLE_DATA_SCHEMAS.text,
	MODEL_CREATABLE_DATA_SCHEMAS.checklist,
	MODEL_CREATABLE_DATA_SCHEMAS.chart,
	MODEL_CREATABLE_DATA_SCHEMAS.mermaid,
]);

/**
 * What a diagram's source may not carry when the MODEL writes it (ruling 74, on
 * the reasoning of ruling 67). The board draws it with the chat's own component
 * under the chat's own security settings (`securityLevel: "strict"`, labels as
 * SVG text, the SVG through the app's sanitizer), and what the chat draws from a
 * reply is by nature the model's words. But a board keeps them, and draws them
 * again on every open, so what asks the reader's browser to fetch an address, or
 * hands them a link inside the picture, is not written onto one: an image or icon
 * shape (Mermaid fetches the picture while it draws, before any sanitizer
 * runs), a `click` line (it makes a box a link), a `%%{ … }%%` directive (it
 * reconfigures the renderer the app has configured), a web address. What the
 * reader inserts from the chat is the chat's own and is not judged here.
 */
const MERMAID_SOURCE_REFUSALS: ReadonlyArray<readonly [RegExp, string]> = [
	[/@\{[^}]*\b(?:img|icon)\b/i, "an image or icon shape"],
	[/^\s*click\s/im, "a click line"],
	[/%%\s*\{/, "a %%{ … }%% directive"],
	[/\bhttps?:\/\//i, "a web address"],
];

/** What is wrong with a diagram source the model wrote, in a sentence it can act on, or null. */
export function mermaidSourceProblem(code: string): string | null {
	for (const [pattern, what] of MERMAID_SOURCE_REFUSALS) {
		if (pattern.test(code)) {
			return `a diagram's source may not contain ${what}: the board draws boxes, arrows and words, and anything that loads or links an address would reach whoever opens it. Write the diagram without it.`;
		}
	}
	return null;
}

// ── The ids of a block's own entries (RV-3 C1) ───────────────────────────

/**
 * A checklist's rows, a photo block's pictures and a web block's links are each
 * drawn row by row and keyed by their entry's id, so two entries with one id
 * make Svelte throw and the panel never leaves its loading skeleton. Nothing in
 * a stored board's shape forbids it, so it is enforced at both doors: what the
 * model writes is refused when an id repeats (`repeatedEntryIds`, judged by
 * `board-ops.ts`), and a board that already holds a repeat is repaired on read
 * (`withUniqueEntryIds`, applied by `normalizeCanvasBody`), never dropped.
 */
function entriesOf(data: CanvasBlockData): { id: string }[] | null {
	switch (data.kind) {
		case "checklist":
		case "photo":
			return data.items;
		case "liveweb":
			return data.sources;
		default:
			return null;
	}
}

/** The ids that more than one entry of the block carries, each once, in the order they first repeat. */
export function repeatedEntryIds(data: CanvasBlockData): string[] {
	const entries = entriesOf(data);
	if (!entries) return [];
	const seen = new Set<string>();
	const repeated: string[] = [];
	for (const entry of entries) {
		if (seen.has(entry.id) && !repeated.includes(entry.id)) {
			repeated.push(entry.id);
		}
		seen.add(entry.id);
	}
	return repeated;
}

/** `base-2`, `base-3`, … the first that no entry has, cut short enough to stay inside the id cap. */
function freshEntryId(base: string, taken: ReadonlySet<string>): string {
	for (let n = 2; ; n += 1) {
		const suffix = `-${n}`;
		const candidate = base.slice(0, ID_MAX_CHARS - suffix.length) + suffix;
		if (!taken.has(candidate)) return candidate;
	}
}

function withEntryIds(data: CanvasBlockData, ids: string[]): CanvasBlockData {
	switch (data.kind) {
		case "checklist":
		case "photo":
			return {
				...data,
				items: data.items.map((item, index) => ({ ...item, id: ids[index] })),
			} as CanvasBlockData;
		case "liveweb":
			return {
				...data,
				sources: data.sources.map((source, index) => ({
					...source,
					id: ids[index],
				})),
			};
		default:
			return data;
	}
}

/**
 * The block with every entry id unique: the first entry of an id keeps it, each
 * later one gets `<id>-2`, `<id>-3`, … (never an id another entry already has),
 * and every word stays. `renamed` names the ids that had to be. A block with
 * nothing repeated is handed back as it is, so a caller can tell by identity.
 */
export function withUniqueEntryIds(data: CanvasBlockData): {
	data: CanvasBlockData;
	renamed: string[];
} {
	const entries = entriesOf(data);
	if (!entries || repeatedEntryIds(data).length === 0) {
		return { data, renamed: [] };
	}
	const taken = new Set(entries.map((entry) => entry.id));
	const seen = new Set<string>();
	const renamed: string[] = [];
	const ids = entries.map((entry) => {
		if (!seen.has(entry.id)) {
			seen.add(entry.id);
			return entry.id;
		}
		if (!renamed.includes(entry.id)) renamed.push(entry.id);
		const fresh = freshEntryId(entry.id, taken);
		taken.add(fresh);
		return fresh;
	});
	return { data: withEntryIds(data, ids), renamed };
}

// ── Compile-time pins: a mirror that drifted from its source fails `npm run check` ──

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;
const mapMirrorMatchesToolCallMapData: Equal<
	z.infer<typeof toolCallMapDataSchema>,
	ToolCallMapData
> = true;
const sourceMirrorMatchesArtifactSource: Equal<
	z.infer<typeof artifactSourceSchema>,
	ArtifactSource
> = true;
void mapMirrorMatchesToolCallMapData;
void sourceMirrorMatchesArtifactSource;
