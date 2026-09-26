/**
 * Alfy's change mark (Feature 2 · Artifacts, Slice 1, T8): the visible trace
 * of an applied patch, "your words win" (spec §2.4/§2.5) made concrete in the
 * editor. This module owns:
 *
 *  - the `AlfyChange` Tiptap mark itself, applied over exactly the text an
 *    applied op inserted or replaced;
 *  - `applyAlfyChangeMarks`, which marks a patch's applied ops (never a
 *    refused one — a refused op never touched the document);
 *  - `keepAlfyChange` / `undoAlfyChange`, the mark's two resolutions. `Undo`
 *    replays `patch.ts`'s own recorded inverse (`PatchInverse.previousMarkdown`)
 *    rather than re-parsing an earlier snapshot of the whole document — a
 *    re-parse could silently drop a change the user made to a DIFFERENT block
 *    in between, which is exactly what "undo restores exactly" (spec §2.4)
 *    forbids;
 *  - `summarizeRefusals` / `refusalReasonI18nKey`, the pure half of the
 *    refusal notice (Review Focus 4: "the refusal being invisible" is a bug).
 *
 * `AlfyChange` deliberately has no `markdownTokenizer` / `parseMarkdown` /
 * `renderMarkdown`: verified against the installed `@tiptap/markdown` 3.31.3
 * (`getMarkOpening`/`getMarkClosing` in `dist/index.js` both return `""` for a
 * mark whose handler has no `renderMarkdown`), so the mark never contributes a
 * character to `readMarkdown(editor)`'s output. It is a purely visual,
 * in-session annotation — never part of the canonical form `blocks.ts` hashes
 * (Global Constraints; ruling 12).
 *
 * This file imports `@tiptap/*` and is reachable only from `extensions.ts` /
 * `document-editor.ts`'s dynamic `import()` boundary (T7.8) — never from
 * `DocumentBody.svelte`, the toolbar, or the margin directly.
 */
import { Editor, type Extensions, Mark, mergeAttributes } from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";
import type {
	PatchResult,
	PatchSet,
	RefusalReason,
} from "$lib/shared/artifact-document/patch";
import { BLOCK_ID_ATTR } from "./block-attrs";

// Not exported: nothing outside this file names the mark/attribute directly
// today (callers go through the functions below), and Fallow's public-API
// scan flags an export with no external importer.
const ALFY_CHANGE_MARK = "alfyChange";
const ALFY_CHANGE_ATTR = "changeId";

/** One applied op's block, kept alive across the mark → Keep/Undo lifecycle. */
export interface AlfyChangeEntry {
	changeId: string;
	blockId: string;
	blockLabel: string;
	/** `patch.ts`'s own recorded inverse: the block's markdown immediately before this op. */
	previousMarkdown: string;
}

/**
 * The mark itself. `changeId` is the applied op's `opId` — unique per op, so
 * two ops touching the same block (rare, but the engine allows it inside one
 * `PatchSet`) get two independently Keep/Undo-able marks rather than one that
 * conflates them.
 */
export const AlfyChange = Mark.create({
	name: ALFY_CHANGE_MARK,

	addAttributes() {
		return {
			[ALFY_CHANGE_ATTR]: {
				default: null,
				parseHTML: (element: HTMLElement) =>
					element.getAttribute("data-alfy-change-id"),
				renderHTML: (attributes: Record<string, unknown>) =>
					attributes[ALFY_CHANGE_ATTR]
						? { "data-alfy-change-id": attributes[ALFY_CHANGE_ATTR] }
						: {},
			},
		};
	},

	parseHTML() {
		return [{ tag: "span[data-alfy-change-id]" }];
	},

	renderHTML({ HTMLAttributes }: { HTMLAttributes: Record<string, unknown> }) {
		return [
			"span",
			mergeAttributes(HTMLAttributes, { class: "alfy-change" }),
			0,
		];
	},
});

function findBlockRange(
	editor: Editor,
	blockId: string,
): { from: number; to: number; node: PMNode } | null {
	let found: { from: number; to: number; node: PMNode } | null = null;
	editor.state.doc.forEach((node, offset) => {
		if (found) return;
		if (node.attrs?.[BLOCK_ID_ATTR] === blockId) {
			found = { from: offset, to: offset + node.nodeSize, node };
		}
	});
	return found;
}

/**
 * The exact substring range of `needle` inside `node`'s flattened text,
 * mapped back to document positions. Used for `insertText`/`replaceRange`, the
 * two op kinds where the model's own `text` names precisely what it added —
 * everything else (a whole-block replace, a toggled checkbox, a new table row)
 * marks the whole block, because the whole block IS the changed unit for
 * those ops. `null` when the needle cannot be found verbatim (e.g. Tiptap's
 * Markdown round trip re-wrapped it across two text nodes) — the caller falls
 * back to marking the whole block rather than silently marking nothing.
 */
function findTextRange(
	node: PMNode,
	basePos: number,
	needle: string,
): { from: number; to: number } | null {
	if (!needle) return null;
	let result: { from: number; to: number } | null = null;
	node.descendants((child, pos) => {
		if (result) return false;
		if (child.isText && typeof child.text === "string") {
			const idx = child.text.indexOf(needle);
			if (idx !== -1) {
				const from = basePos + 1 + pos + idx;
				result = { from, to: from + needle.length };
				return false;
			}
		}
		return true;
	});
	return result;
}

/** Ops whose `text` is exactly the substring that changed — everything else marks the whole block. */
const PRECISE_TEXT_OPS = new Set(["insertText", "replaceRange"]);

/**
 * Marks every APPLIED op's block with `AlfyChange{changeId: opId}` — a
 * refused op never touched the document, so it is never marked. Call this
 * AFTER the editor's content already reflects `result.markdown` (e.g. via
 * `loadMarkdown(editor, result.markdown)`): this function only locates
 * already-updated blocks by id and marks them, it never edits text itself, so
 * it works the same regardless of how much the applied text grew or shrank.
 *
 * `patch` is optional and is the ORIGINAL `PatchSet` this `result` came from
 * (the caller usually still has it — it is what it just sent the server).
 * When supplied, `insertText`/`replaceRange` ops mark exactly the substring
 * the op's own `text` names (T8.1: "marks exactly its inserted/replaced
 * text"); every other op kind, and a precise op whose text cannot be found
 * verbatim in the block (Tiptap's Markdown round trip can re-wrap it across
 * two text nodes), marks the whole block — the whole block genuinely IS the
 * changed unit for `replaceBlock`, `toggleTask` and `addTableRow`.
 *
 * Dispatched with `addToHistory: false` — a mark Alfy added is not a step in
 * the USER's own undo stack (mirrors `BlockIds`' bookkeeping transactions in
 * `extensions.ts`).
 */
export function applyAlfyChangeMarks(
	editor: Editor,
	result: PatchResult,
	patch?: PatchSet,
): AlfyChangeEntry[] {
	const markType = editor.schema.marks[ALFY_CHANGE_MARK];
	if (!markType) return [];

	const inverseByOpId = new Map(
		result.inverses.map((inverse) => [inverse.opId, inverse]),
	);
	const opById = new Map((patch?.ops ?? []).map((op) => [op.opId, op]));
	const entries: AlfyChangeEntry[] = [];
	const tr = editor.state.tr;
	let changed = false;

	for (const outcome of result.outcomes) {
		if (outcome.status !== "applied") continue;
		const inverse = inverseByOpId.get(outcome.opId);
		if (!inverse) continue;

		const range = findBlockRange(editor, outcome.blockId);
		if (!range) continue;

		let markFrom = range.from + 1;
		let markTo = range.to - 1;
		const sourceOp = opById.get(outcome.opId);
		if (sourceOp && PRECISE_TEXT_OPS.has(outcome.kind) && sourceOp.text) {
			const precise = findTextRange(range.node, range.from, sourceOp.text);
			if (precise) {
				markFrom = precise.from;
				markTo = precise.to;
			}
		}
		if (markFrom < markTo) {
			tr.addMark(
				markFrom,
				markTo,
				markType.create({ [ALFY_CHANGE_ATTR]: outcome.opId }),
			);
			changed = true;
		}

		entries.push({
			changeId: outcome.opId,
			blockId: outcome.blockId,
			blockLabel: outcome.blockLabel,
			previousMarkdown: inverse.previousMarkdown,
		});
	}

	if (changed) {
		tr.setMeta("addToHistory", false);
		editor.view.dispatch(tr);
	}
	return entries;
}

/** Keep: clears the mark, leaves the text exactly as applied. `true` when a mark was actually found and cleared. */
export function keepAlfyChange(editor: Editor, changeId: string): boolean {
	const markType = editor.schema.marks[ALFY_CHANGE_MARK];
	if (!markType) return false;

	let from = Number.POSITIVE_INFINITY;
	let to = -1;
	editor.state.doc.descendants((node, pos) => {
		if (
			node.marks.some(
				(m) => m.type === markType && m.attrs[ALFY_CHANGE_ATTR] === changeId,
			)
		) {
			from = Math.min(from, pos);
			to = Math.max(to, pos + node.nodeSize);
		}
	});
	if (to < 0) return false;

	const tr = editor.state.tr.removeMark(from, to, markType);
	tr.setMeta("addToHistory", false);
	editor.view.dispatch(tr);
	return true;
}

/**
 * Undo: replaces exactly `entry.blockId`'s node with the pre-patch content
 * (`entry.previousMarkdown`, `patch.ts`'s own recorded inverse), preserving
 * the block id and leaving every other block untouched. A second call for the
 * same entry is a harmless no-op — the block already reads
 * `previousMarkdown`, so replacing it again produces the identical document
 * (T8.5: "Undo twice is an error-free no-op").
 *
 * Builds the replacement node through a throwaway, detached `Editor` rather
 * than a second, hand-rolled Markdown-to-ProseMirror parser:
 * `previousMarkdown` is one block's canonical Markdown (never a marker —
 * `DocumentBlock.markdown` never carries one), so parsing it alone through the
 * real pipeline and lifting out its one resulting node is the same
 * transformation the main editor would have done, guaranteed to agree with it
 * on every construct the schema supports.
 *
 * `extensions` must be a FRESH extension list (e.g. a new
 * `buildDocumentExtensions("")` call) — never `editor.extensionManager.extensions`
 * reused from the live editor. Passing already-resolved instances into a
 * second `Editor` throws `RangeError: Adding different instances of a keyed
 * plugin` (verified empirically against 3.31.3: some extensions' ProseMirror
 * plugins are keyed by identity, and Tiptap re-resolves whatever list it is
 * given on every `new Editor(...)`, so two editors must never share one
 * resolved list). This is also why this function takes `extensions` as a
 * parameter instead of importing `buildDocumentExtensions` from
 * `extensions.ts` itself: that module registers `AlfyChange` (this file) in
 * its own list, so importing it back here would be a circular import —
 * `document-editor.ts`, which already imports both modules, supplies a fresh
 * list at the one call site that matters.
 *
 * The temp editor's `Schema` is a SEPARATE INSTANCE from `editor`'s own, even
 * though built from an identical extension list — verified empirically that
 * splicing one of its `Node` objects directly into `editor`'s transaction
 * (`rawNode.type.create(...)`, `tr.replaceWith(...)`) does not throw, but
 * silently drops the inserted content instead of the block it was meant to
 * replace (`rawNode.type !== editor.state.schema.nodes[rawNode.type.name]`,
 * so ProseMirror's step machinery is comparing two node types that only look
 * alike). The fix is to never let a temp-schema `Node` reach `editor`'s
 * transaction at all: round-trip through plain JSON
 * (`Node.fromJSON(editor.state.schema, rawNode.toJSON())`), which resolves
 * every node and mark against `editor`'s OWN schema, the same way loading a
 * document from its stored JSON always would.
 */
export function undoAlfyChange(
	editor: Editor,
	entry: { blockId: string; previousMarkdown: string },
	extensions: Extensions,
): boolean {
	const target = findBlockRange(editor, entry.blockId);
	if (!target) return false;

	const scratch = document.createElement("div");
	document.body.appendChild(scratch);
	const temp = new Editor({
		element: scratch,
		extensions,
		content: entry.previousMarkdown,
		contentType: "markdown",
	});
	const rawNode = temp.state.doc.firstChild;
	if (!rawNode) {
		temp.destroy();
		scratch.remove();
		return false;
	}
	const rawJSON = rawNode.toJSON() as { attrs?: Record<string, unknown> };
	temp.destroy();
	scratch.remove();

	const replacement = PMNode.fromJSON(editor.state.schema, {
		...rawJSON,
		attrs: { ...rawJSON.attrs, [BLOCK_ID_ATTR]: entry.blockId },
	});

	const tr = editor.state.tr.replaceWith(target.from, target.to, replacement);
	tr.setMeta("addToHistory", false);
	editor.view.dispatch(tr);
	return true;
}

// ---------------------------------------------------------------------------
// The refusal notice's pure half (Review Focus 4: a guard the user cannot see
// is indistinguishable from Alfy forgetting). No Tiptap dependency — kept
// here anyway so a caller already inside the dynamic-import boundary (which
// is exactly where a `PatchResult` becomes available) reaches both halves of
// "what did Alfy just do" from one module.
// ---------------------------------------------------------------------------

export interface RefusalSummary {
	count: number;
	items: { blockId: string; blockLabel: string; code: RefusalReason }[];
}

/** `null` when nothing was refused — the caller renders no notice at all. */
export function summarizeRefusals(result: PatchResult): RefusalSummary | null {
	const items = result.outcomes
		.filter((outcome) => outcome.status === "refused")
		.map((outcome) => ({
			blockId: outcome.blockId,
			blockLabel: outcome.blockLabel,
			code: (outcome.code ?? "block_missing") as RefusalReason,
		}));
	if (items.length === 0) return null;
	return { count: items.length, items };
}

/**
 * The ten engine-level `RefusalReason`s collapse onto the five sentences
 * `slice-1.md`'s i18n table actually defines: `changed`/`unseen`/`missing`/
 * `ambiguous` are the distinctions worth a different sentence, and every
 * other reason (wrong block kind, an empty replacement, an unfound
 * `find`, a malformed table row) reads as the honest, generic
 * `refused.other` — "Alfy could not apply this change" — rather than eight
 * near-duplicate sentences nobody asked for.
 */
const REFUSAL_KEY_SUFFIX: Record<
	RefusalReason,
	"changed" | "unseen" | "missing" | "ambiguous" | "other"
> = {
	block_missing: "missing",
	block_unseen: "unseen",
	block_changed: "changed",
	not_a_text_block: "other",
	empty_text: "other",
	find_not_found: "other",
	find_ambiguous: "ambiguous",
	not_a_task_block: "other",
	not_a_table_block: "other",
	bad_row: "other",
};

export function refusalReasonI18nKey(
	code: RefusalReason,
): `artifacts.document.refused.${"changed" | "unseen" | "missing" | "ambiguous" | "other"}` {
	return `artifacts.document.refused.${REFUSAL_KEY_SUFFIX[code]}`;
}
