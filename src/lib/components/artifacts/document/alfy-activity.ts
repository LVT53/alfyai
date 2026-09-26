/**
 * Alfy tool-call activity for the open Document panel (Feature 2 · Artifacts,
 * Slice 1, "T8 live"): the pure boundary between the chat stream's tool-call
 * segments (`ThinkingSegment`'s `tool_call` variant, as
 * `message.thinkingSegments` already carries it — see
 * `src/lib/utils/tool-evidence-presentation.ts`'s `ToolCallSegment`) and the
 * panel's "Alfy is writing" shimmer, change marks and refusal notice.
 *
 * The browser never receives a full server-side `PatchResult` for a live
 * `edit_artifact` call — only the model's raw INPUT (before the server mints
 * an `opId` per op or looks up each block's `blockLabel`) and a bounded
 * `metadata` bag on the tool-call entry (flat scalars only:
 * `ok`/`artifactId`/`artifactKind`/`artifactTitle`/`appliedCount`/
 * `refusedBlocksJson`, added by this slice's `EDIT_ARTIFACT_HANDLERS.document`
 * in `normal-chat-tools/artifact-tools/edit.ts`). So Keep/Undo's inverses are
 * rebuilt HERE, client-side, from three things the browser already has: the
 * tool's own input ops, which blockIds the output says were refused, and the
 * panel's OWN pre-edit block text (captured the instant before the new body
 * is loaded) — never by re-parsing an older snapshot of the whole document
 * (T8 Step 3's rule; `marks.ts`'s own `undoAlfyChange` doc comment makes the
 * same argument for Undo itself, one step later).
 *
 * Pure and Tiptap-free — safe for `DocumentBody.svelte` to import eagerly.
 */
import type { DocumentBlock } from "$lib/shared/artifact-document/blocks";
import type {
	OpOutcome,
	PatchInverse,
	PatchOp,
	PatchOpKind,
	PatchSet,
} from "$lib/shared/artifact-document/patch";

export type DocumentAlfyToolName = "create_artifact" | "edit_artifact";

/**
 * `"running"` while the call is in flight; once it settles, `"applied"` (ok,
 * nothing refused), `"refused"` (ok, at least one op refused — partial or
 * full, `appliedCount` tells them apart), or `"failed"` (the call itself
 * failed, or succeeded at the envelope level but the domain result was
 * `ok: false` — e.g. "not found", "not a document").
 */
export type DocumentAlfyActivityStatus =
	| "running"
	| "applied"
	| "refused"
	| "failed";

/** One raw patch op exactly as the MODEL sent it (`edit_artifact`'s advertised `[{op, blockId, baseHash, text, ...}]` shape) — before the server mints `opId`/`blockLabel`. */
export interface DocumentAlfyRawPatchOp {
	op: PatchOpKind;
	blockId: string;
	baseHash: string;
	text?: string;
	find?: string;
	at?: "start" | "end";
	checked?: boolean;
}

export interface DocumentRefusedBlock {
	blockId: string;
	reason: string;
}

export interface DocumentAlfyActivity {
	/** Stable per-call identity (the tool call's own `callId` when present), so the body can tell "this call, still running" from "a new call". */
	key: string;
	artifactId: string;
	toolName: DocumentAlfyToolName;
	status: DocumentAlfyActivityStatus;
	/** `edit_artifact`'s own `summary` input, or `create_artifact`'s `title` — `null` when neither is present (the caller falls back to the document's own title). */
	label: string | null;
	/** Only for `edit_artifact`, and only once the call has left "running" — there is nothing to mark until the call has settled. */
	patches: DocumentAlfyRawPatchOp[];
	refusedBlocks: DocumentRefusedBlock[];
	appliedCount: number;
}

/** The shape `message.thinkingSegments`' `tool_call` entries already have — see `messages-types.ts`'s `ThinkingSegment`. */
export interface RawAlfyToolCallSegment {
	name: string;
	callId?: string;
	status: "running" | "done" | "failed";
	input: Record<string, unknown>;
	metadata?: Record<string, string | number | boolean | null> | null;
}

const EDIT_OP_KINDS: readonly PatchOpKind[] = [
	"replaceBlock",
	"insertText",
	"replaceRange",
	"toggleTask",
	"addTableRow",
];

function stringField(
	input: Record<string, unknown> | undefined,
	key: string,
): string | null {
	const value = input?.[key];
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isPatchOpKind(value: unknown): value is PatchOpKind {
	return (
		typeof value === "string" &&
		(EDIT_OP_KINDS as readonly string[]).includes(value)
	);
}

/** Defensive: the model's own JSON, never trusted further than "does this look like one op". Malformed entries are dropped, never thrown. */
function parseRawPatches(value: unknown): DocumentAlfyRawPatchOp[] {
	if (!Array.isArray(value)) return [];
	const ops: DocumentAlfyRawPatchOp[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		if (
			!isPatchOpKind(record.op) ||
			typeof record.blockId !== "string" ||
			typeof record.baseHash !== "string"
		) {
			continue;
		}
		ops.push({
			op: record.op,
			blockId: record.blockId,
			baseHash: record.baseHash,
			text: typeof record.text === "string" ? record.text : undefined,
			find: typeof record.find === "string" ? record.find : undefined,
			at:
				record.at === "start" || record.at === "end" ? record.at : undefined,
			checked:
				typeof record.checked === "boolean" ? record.checked : undefined,
		});
	}
	return ops;
}

/** `metadata.refusedBlocksJson`, parsed defensively — absent, malformed, or non-array JSON all read as "nothing refused" rather than throwing. */
function parseRefusedBlocks(value: unknown): DocumentRefusedBlock[] {
	if (typeof value !== "string" || value.length === 0) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const items: DocumentRefusedBlock[] = [];
	for (const entry of parsed) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		if (typeof record.blockId === "string" && typeof record.reason === "string") {
			items.push({ blockId: record.blockId, reason: record.reason });
		}
	}
	return items;
}

/**
 * Turns one raw tool-call segment into Document activity, or `null` when the
 * segment is not a Document `create_artifact`/`edit_artifact` call. The
 * caller (the chat page) picks which ONE segment to pass in — the latest
 * `create_artifact`/`edit_artifact` call, for the currently-open artifact,
 * on the message currently streaming (or that just finished); this function
 * only interprets that one segment.
 */
export function buildDocumentAlfyActivity(
	segment: RawAlfyToolCallSegment,
): DocumentAlfyActivity | null {
	if (segment.name !== "create_artifact" && segment.name !== "edit_artifact") {
		return null;
	}
	const toolName = segment.name;
	const metadata = segment.metadata ?? {};
	const metaKind = metadata.artifactKind;
	// create_artifact can make any of the five kinds; only Document matters
	// here, and every OTHER kind's tool call must map to no activity at all.
	if (typeof metaKind === "string" && metaKind !== "document") return null;

	const metaArtifactId =
		typeof metadata.artifactId === "string" ? metadata.artifactId : null;
	const inputArtifactId = stringField(segment.input, "artifactId");
	// create_artifact never carries an artifactId in its OWN input (nothing
	// exists yet to address) — so while it is still running there is no id to
	// correlate against an already-open panel, and no activity to report.
	const artifactId = metaArtifactId ?? inputArtifactId;
	if (!artifactId) return null;

	const key = segment.callId ?? `${toolName}-${artifactId}`;
	const label =
		toolName === "edit_artifact"
			? stringField(segment.input, "summary")
			: stringField(segment.input, "title");

	if (segment.status === "running") {
		return {
			key,
			artifactId,
			toolName,
			status: "running",
			label,
			patches: [],
			refusedBlocks: [],
			appliedCount: 0,
		};
	}

	const ok = metadata.ok !== false;
	if (segment.status === "failed" || !ok) {
		return {
			key,
			artifactId,
			toolName,
			status: "failed",
			label,
			patches: [],
			refusedBlocks: [],
			appliedCount: 0,
		};
	}

	const patches =
		toolName === "edit_artifact" ? parseRawPatches(segment.input.patches) : [];
	const refusedBlocks = parseRefusedBlocks(metadata.refusedBlocksJson);
	const appliedCount =
		typeof metadata.appliedCount === "number"
			? metadata.appliedCount
			: Math.max(0, patches.length - refusedBlocks.length);

	return {
		key,
		artifactId,
		toolName,
		status: refusedBlocks.length > 0 ? "refused" : "applied",
		label,
		patches,
		refusedBlocks,
		appliedCount,
	};
}

// ---------------------------------------------------------------------------
// Reconstructing marks/inverses client-side — never from a full server
// `PatchResult`, which the live tool-call stream does not carry (see this
// file's header comment).
// ---------------------------------------------------------------------------

export interface ReconstructedDocumentPatch {
	/** Shaped like the ORIGINAL `PatchSet` `edit_artifact` ran, for `applyAlfyChangeMarks`'s precise-text-range marking. */
	patch: PatchSet;
	outcomes: OpOutcome[];
	inverses: PatchInverse[];
}

/**
 * Rebuilds the `(outcomes, inverses)` half of a `PatchResult` — everything
 * `applyAlfyChangeMarks`/`summarizeRefusals` need — from the tool's own raw
 * input ops, which blockIds the output says were refused, and the blocks the
 * PANEL held immediately before this edit landed. A block absent from
 * `refusedBlocks` is applied; its inverse is exactly its pre-edit markdown.
 *
 * `null` when there is nothing to mark: `create_artifact` (a whole new
 * document, nothing to diff against) or an `edit_artifact` call whose own
 * input carried no (recognisable) ops.
 */
export function reconstructDocumentPatch(
	activity: DocumentAlfyActivity,
	previousBlocksById: ReadonlyMap<string, DocumentBlock>,
): ReconstructedDocumentPatch | null {
	if (activity.patches.length === 0) return null;

	const refusedByBlockId = new Map(
		activity.refusedBlocks.map((item) => [item.blockId, item.reason]),
	);

	const ops: PatchOp[] = activity.patches.map((raw, index) => {
		const previous = previousBlocksById.get(raw.blockId);
		return {
			opId: `${activity.key}-${index}`,
			kind: raw.op,
			blockId: raw.blockId,
			baseHash: raw.baseHash,
			blockLabel: previous?.label ?? raw.blockId,
			text: raw.text,
			find: raw.find,
			at: raw.at,
			checked: raw.checked,
		};
	});

	const outcomes: OpOutcome[] = [];
	const inverses: PatchInverse[] = [];
	for (const op of ops) {
		const refusedReason = refusedByBlockId.get(op.blockId);
		if (refusedReason !== undefined) {
			outcomes.push({
				opId: op.opId,
				kind: op.kind,
				blockId: op.blockId,
				blockLabel: op.blockLabel,
				status: "refused",
				code: refusedReason as OpOutcome["code"],
			});
			continue;
		}
		outcomes.push({
			opId: op.opId,
			kind: op.kind,
			blockId: op.blockId,
			blockLabel: op.blockLabel,
			status: "applied",
		});
		const previous = previousBlocksById.get(op.blockId);
		inverses.push({
			opId: op.opId,
			blockId: op.blockId,
			// A truly-applied op's block always existed a moment ago (the
			// server itself refuses `block_missing` otherwise, so it would be
			// in `refusedBlocks`, not here) — the empty-string fallback is
			// defensive only, never expected to be read back by Undo.
			previousMarkdown: previous?.markdown ?? "",
		});
	}

	return {
		patch: {
			patchId: activity.key,
			label: activity.label ?? "Alfy's edit",
			ops,
		},
		outcomes,
		inverses,
	};
}
