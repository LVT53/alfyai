/**
 * What the MODEL may add to a board, and change on one (decisions.md rulings 64,
 * 67 and 74): the strict variants of the six kinds it writes and the fields of
 * each it may change afterwards (what a diagram source it writes may carry is
 * `mermaid-source.ts`'s rule). Its own module, and not part of `canvas-blocks.ts`, because
 * everything in that module is in the editor's first paint and none of this is
 * the editor's: the server judges what a model sends with it, and the editor
 * never needs a schema stricter than the one it stores (ruling 68's size gate).
 */
import { z } from "zod";
import { BLOCK_DATA_SCHEMAS, type BlockKind } from "./canvas-blocks";

/**
 * The chart the MODEL writes: the Chart.js config as an object, or as the JSON
 * text the block stores. JSON inside a JSON string is where a model's escaping
 * slips (an `ops` array sent as one string that cannot be read: three in five of
 * the first tries to add a chart in the Canvas eval), so the object is the way
 * the schema leads with, and `storedBlockData` turns it into the text the block
 * holds before anything is judged or kept.
 */
function modelChartDataSchema() {
	return BLOCK_DATA_SCHEMAS.chart
		.extend({
			code: z
				.union([
					BLOCK_DATA_SCHEMAS.chart.shape.code,
					z.record(z.string(), z.unknown()),
				])
				.describe(
					"The Chart.js config, as an object ({type, data, options}) or as JSON text.",
				),
		})
		.strict();
}

/**
 * The diagram the MODEL writes: the stored schema, with the one sentence the
 * model needs about `code` (what the editor, which never shows a schema to
 * anyone, does not carry).
 */
function modelMermaidDataSchema() {
	return BLOCK_DATA_SCHEMAS.mermaid
		.extend({
			code: BLOCK_DATA_SCHEMAS.mermaid.shape.code.describe(
				"Mermaid source as in a chat reply's ```mermaid fence, without the fence: a flowchart, sequence, state, class, ER, gantt or pie diagram. A label with ( ) in it must be quoted; otherwise avoid double quotes (inside this JSON each needs an escape).",
			),
		})
		.strict();
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
	frame: BLOCK_DATA_SCHEMAS.frame.strict(),
	sticky: BLOCK_DATA_SCHEMAS.sticky.strict(),
	text: BLOCK_DATA_SCHEMAS.text.strict(),
	checklist: BLOCK_DATA_SCHEMAS.checklist.strict(),
	chart: modelChartDataSchema(),
	mermaid: modelMermaidDataSchema(),
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What the model wrote, as the block stores it: a chart's config written as an
 * object becomes the JSON text the block holds. Everything else is as written.
 * Applied to what the model sends (an add's `data`, an update's fields) before it
 * is judged, so the one stored schema is the one a block is held to.
 */
export function storedBlockData<T>(data: T): T {
	if (isPlainObject(data) && isPlainObject(data.code)) {
		const kind = data.kind;
		if (kind === undefined || kind === "chart") {
			return { ...data, code: JSON.stringify(data.code) } as T;
		}
	}
	return data;
}
