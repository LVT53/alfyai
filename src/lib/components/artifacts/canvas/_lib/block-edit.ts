/**
 * What changing a block after it was inserted means, for the blocks whose change
 * is a small form: a chart's and a diagram's own source and title, the title of a
 * checklist, a map, an App and a photo block. A leaf module of pure functions, so
 * what is checked and what is written is tested without a board.
 *
 * The block's own schema (`canvas-blocks.ts`) is the judge, the same one a saved
 * board is read with: a source it would refuse (empty, past the limit) cannot be
 * applied, and a patch is parsed through the schema once more before the board is
 * asked to take it. The write is one `updateNodeData`, which the board settles into
 * ONE step of the reader's own undo (ruling 16).
 */
import type { z } from "zod";
import {
	BLOCK_DATA_SCHEMAS,
	type CanvasBlockData,
} from "$lib/shared/artifacts/canvas-blocks";
import { parseJsonLenient } from "$lib/utils/lenient-json";

/** The kinds that open a form: each has a title, and a chart and a diagram a source too. */
export type EditedKind =
	| "chart"
	| "mermaid"
	| "checklist"
	| "map"
	| "app"
	| "photo";

/** Why a source cannot be applied, as the i18n key suffix the form says it with. */
export type SourceProblem = "empty" | "tooLong" | "notChart";

/** The field a kind keeps its title in: an App's is `title`, every other kind's the optional `label`. */
export function titleFieldOf(kind: EditedKind): "title" | "label" {
	return kind === "app" ? "title" : "label";
}

type Titled = Record<string, unknown>;

/** What a block's header says now, which is what the form starts with: a map falls back to its route when it has no title of its own. */
export function shownTitle(kind: EditedKind, data: CanvasBlockData): string {
	const record = data as Titled;
	const own = record[titleFieldOf(kind)];
	if (typeof own === "string" && own.length > 0) return own;
	if (kind === "map" && typeof record.route === "string") return record.route;
	return "";
}

/** True when the source is something the chat's own component can draw as a chart: a JSON object with a `type` and a `data`. */
function isChartConfig(code: string): boolean {
	const value = parseJsonLenient(code);
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const config = value as Record<string, unknown>;
	return (
		typeof config.type === "string" &&
		typeof config.data === "object" &&
		config.data !== null
	);
}

/**
 * Whether `code` can be applied as the source of a block of this kind: the schema's
 * own verdict on the field (empty, too long), and for a chart that it is a chart
 * config at all. A diagram's syntax is Mermaid's to judge: a source it cannot draw is
 * shown as its source with a note, exactly as in the chat, and can be edited again.
 */
export function sourceProblem(
	kind: "chart" | "mermaid",
	code: string,
): SourceProblem | null {
	const field = BLOCK_DATA_SCHEMAS[kind].shape.code.safeParse(code);
	if (!field.success) {
		return field.error.issues.some((issue) => issue.code === "too_big")
			? "tooLong"
			: "empty";
	}
	if (code.trim().length === 0) return "empty";
	return kind === "chart" && !isChartConfig(code) ? "notChart" : null;
}

/** A source as a reader edits it: a chart's, when it is plain JSON, laid out over lines (the board keeps it on one); anything else as it is. */
export function sourceToEdit(kind: "chart" | "mermaid", code: string): string {
	if (kind !== "chart") return code;
	try {
		return JSON.stringify(JSON.parse(code), null, 2);
	} catch {
		return code;
	}
}

/** The source to keep: a chart's plain JSON goes back to the one line the board keeps it on, anything else as it was typed. */
export function sourceToKeep(kind: "chart" | "mermaid", typed: string): string {
	if (kind !== "chart") return typed;
	try {
		return JSON.stringify(JSON.parse(typed));
	} catch {
		return typed;
	}
}

/**
 * What to write to the block for what the reader changed, or `null` when nothing
 * changed (no step is made for an Edit that changed nothing) or when the result would
 * not be a block the schema accepts. Only the fields that changed are in the patch.
 */
export function editPatch(
	kind: EditedKind,
	data: CanvasBlockData,
	next: { title: string; source?: string },
): Record<string, unknown> | null {
	const patch: Record<string, unknown> = {};
	const title = next.title.trim();
	if (title !== shownTitle(kind, data)) {
		// A cleared title is no title: the header falls back to the kind's (or the map's route). An App's is always a string.
		patch[titleFieldOf(kind)] = title || (kind === "app" ? "" : undefined);
	}
	if (next.source !== undefined && (kind === "chart" || kind === "mermaid")) {
		const { code } = data as { code: string };
		if (next.source !== sourceToEdit(kind, code)) {
			patch.code = sourceToKeep(kind, next.source);
		}
	}
	if (Object.keys(patch).length === 0) return null;
	const schema = BLOCK_DATA_SCHEMAS[kind] as z.ZodType<CanvasBlockData>;
	return schema.safeParse({ ...data, ...patch }).success ? patch : null;
}
