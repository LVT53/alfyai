/**
 * An Alfy edit of a BOARD, as the open panel sees it (Feature 2 · Artifacts,
 * Slice 3 T6, client half): the pure boundary between the chat stream's
 * `edit_artifact` tool-call segment and the board's arranging frame, landing
 * and refusal notice. The Document's twin is `document/alfy-activity.ts`, and
 * the object is the same one (`DocumentAlfyActivity`), so the chat page's scan,
 * the panel's once-only rule and the chat card need nothing new: this fills in
 * `ops` (the model's raw input, which is complete before the tool runs) where
 * the Document's fills in `patches`.
 *
 * What the browser does NOT get is the server's per-op answer, only the flat
 * metadata the call leaves (`appliedCount`, `refusedBlocksJson`: the refused
 * ops by their place in the call). So which ops were accepted is rebuilt here
 * from the call's own ops minus the refused places. Pure and free of the flow
 * library: the chat page imports it eagerly.
 */
import {
	type AlfyRawBoardOp,
	type DocumentAlfyActivity,
	parseRefusedBlocks,
	type RawAlfyToolCallSegment,
	stringField,
} from "../document/alfy-activity";

/** The model's own JSON, never trusted further than "does this look like one op". Malformed entries are dropped, never thrown. */
function parseRawOps(value: unknown): AlfyRawBoardOp[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(entry): entry is AlfyRawBoardOp =>
			entry !== null &&
			typeof entry === "object" &&
			typeof (entry as Record<string, unknown>).op === "string",
	);
}

/** A highlight only points: it changes nothing on the board and writes no version. */
function changesTheBoard(op: AlfyRawBoardOp): boolean {
	return op.op !== "highlight";
}

/** The ops that were accepted: the call's own ops without the places the server refused. */
export function acceptedCanvasOps(
	activity: Pick<DocumentAlfyActivity, "ops" | "refusedBlocks">,
): AlfyRawBoardOp[] {
	const refused = new Set(
		activity.refusedBlocks.flatMap((item) =>
			item.opIndex !== undefined ? [item.opIndex] : [],
		),
	);
	return (activity.ops ?? []).filter((_, index) => !refused.has(index));
}

/**
 * Turns one raw tool-call segment into a board's activity, or `null` when the
 * segment is not an `edit_artifact` of a board. A call that has not settled has
 * no metadata yet, so the kind is read off the input's own shape (`ops`, which a
 * Document's edit never has); a settled one says what it is.
 */
export function buildCanvasAlfyActivity(
	segment: RawAlfyToolCallSegment,
): DocumentAlfyActivity | null {
	if (segment.name !== "edit_artifact") return null;
	const metadata = segment.metadata ?? {};
	const kind = metadata.artifactKind;
	if (typeof kind === "string") {
		if (kind !== "canvas") return null;
	} else if (!Array.isArray(segment.input?.ops)) {
		return null;
	}

	const artifactId =
		typeof metadata.artifactId === "string"
			? metadata.artifactId
			: stringField(segment.input, "artifactId");
	if (!artifactId) return null;

	const key = segment.callId ?? `edit_artifact-${artifactId}`;
	const label = stringField(segment.input, "summary");
	const base = {
		key,
		artifactId,
		toolName: "edit_artifact" as const,
		label,
		patches: [],
	};

	if (segment.status === "running") {
		return {
			...base,
			status: "running",
			ops: parseRawOps(segment.input.ops),
			refusedBlocks: [],
			appliedCount: 0,
		};
	}
	if (segment.status === "failed" || metadata.ok === false) {
		return {
			...base,
			status: "failed",
			ops: [],
			refusedBlocks: [],
			appliedCount: 0,
		};
	}

	const ops = parseRawOps(segment.input.ops);
	const refusedBlocks = parseRefusedBlocks(metadata.refusedBlocksJson);
	const accepted = acceptedCanvasOps({ ops, refusedBlocks });
	return {
		...base,
		status: refusedBlocks.length > 0 ? "refused" : "applied",
		ops,
		refusedBlocks,
		appliedCount:
			ops.length > 0
				? accepted.filter(changesTheBoard).length
				: typeof metadata.appliedCount === "number"
					? metadata.appliedCount
					: 0,
	};
}

function idField(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The blocks already on the board that ops address, once each and in the order
 * the ops name them: what "Alfy is arranging" draws its frame around. A block
 * the ops create is not on the board yet, so it is not here; a frame an op puts
 * a new block in is.
 */
export function canvasOpTargets(ops: readonly AlfyRawBoardOp[]): string[] {
	const ids: string[] = [];
	const add = (value: unknown): void => {
		const id = idField(value);
		if (id && !ids.includes(id)) ids.push(id);
	};
	for (const op of ops) {
		switch (op.op) {
			case "move":
			case "update_node":
			case "remove_node":
				add(op.id);
				break;
			case "add_node": {
				const node = op.node as Record<string, unknown> | undefined;
				add(node?.parentId);
				break;
			}
			case "add_edge": {
				const edge = op.edge as Record<string, unknown> | undefined;
				add(edge?.source);
				add(edge?.target);
				break;
			}
			case "highlight":
				if (Array.isArray(op.ids)) for (const id of op.ids) add(id);
				break;
			default:
				break;
		}
	}
	return ids;
}

/** The blocks a `highlight` op pointed at: ringed for a moment, never part of what is reviewed. */
export function highlightedByOps(ops: readonly AlfyRawBoardOp[]): string[] {
	const ids: string[] = [];
	for (const op of ops) {
		if (op.op !== "highlight" || !Array.isArray(op.ids)) continue;
		for (const id of op.ids) {
			const named = idField(id);
			if (named && !ids.includes(named)) ids.push(named);
		}
	}
	return ids;
}
