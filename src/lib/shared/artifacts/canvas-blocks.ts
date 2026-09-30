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
 * the five note-shaped kinds: a misspelt field is refused by name instead of
 * being stripped into an op that "worked" and changed nothing.
 */
import { z } from "zod";
import type { ToolCallMapData } from "$lib/server/services/messages-types";
import { isHttpSourceUrl, isPhotoProxyPath } from "./block-urls";
import {
	CHECKLIST_ITEM_MAX_CHARS,
	CHECKLIST_MAX_ITEMS,
	LABEL_MAX_CHARS,
	TEXT_MAX_CHARS,
} from "./canvas-limits";
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
const ID_MAX_CHARS = 128;
const PHOTO_MAX_ITEMS = 50;
const SOURCES_MAX = 50;

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

// ── The five note-shaped kinds ───────────────────────────────────────────

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
 * What the model may add to a board (ruling 64): the five kinds that carry
 * only what it can write. The other five carry app-owned references (a file, an
 * App, a route, a photo, a fetched page) it cannot mint, so the user places
 * those, and an `add_node` of one is refused `unknown_kind`. Strict variants of
 * the stored schemas: what the model writes must not carry a field the block
 * does not read, or a misspelt one would be stripped into an op that "worked"
 * and changed nothing.
 */
export const MODEL_CREATABLE_DATA_SCHEMAS = {
	frame: frameDataSchema.strict(),
	sticky: stickyDataSchema.strict(),
	text: textDataSchema.strict(),
	checklist: checklistDataSchema.strict(),
	chart: chartDataSchema.strict(),
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

/** The advertised and the executed `data` of an `add_node`: one union of the five. */
export const modelCreatableBlockDataSchema = z.discriminatedUnion("kind", [
	MODEL_CREATABLE_DATA_SCHEMAS.frame,
	MODEL_CREATABLE_DATA_SCHEMAS.sticky,
	MODEL_CREATABLE_DATA_SCHEMAS.text,
	MODEL_CREATABLE_DATA_SCHEMAS.checklist,
	MODEL_CREATABLE_DATA_SCHEMAS.chart,
]);

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
