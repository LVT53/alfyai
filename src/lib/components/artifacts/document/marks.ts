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
import type { Transaction } from "@tiptap/pm/state";
import {
	EMPTY_TAB_ANCHOR_PLACEHOLDER,
	stripEmptyTabAnchorPlaceholder,
} from "$lib/shared/artifact-document/blocks";
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
	/**
	 * RV-1B, coordinator item 7: `patch.ts`'s own `PatchInverse.insertedBlockIds`,
	 * carried through unchanged — the extra blocks THIS op's text produced
	 * beyond `blockId` (a paragraph that became two, a new section). `undoAlfyChange`
	 * below removes them too, so Undo restores the document to what it was
	 * BEFORE the op, not just this one block's text.
	 */
	insertedBlockIds?: string[];
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
			// Artifacts redesign §7.2 #11/§9.1: "arrive" is the settle animation
			// — a CSS @keyframes rule (`DocumentBody.svelte`'s styles) tinting
			// from `--alfy-mark-arrive` to the resting `--alfy-mark` over
			// `--duration-settle`, unconditionally on every render of this mark
			// rather than only its first one. That is deliberately harmless, not
			// just tolerated: ProseMirror only reconstructs a mark's DOM node
			// when the mark is first created (or its node is otherwise dirtied),
			// so in practice the animation plays once, right when the change
			// actually lands, then the element sits at its resting appearance —
			// nothing keeps re-triggering it on unrelated re-renders elsewhere in
			// the document. `prefers-reduced-motion` collapses it to the resting
			// tint immediately via app.css's global animation-duration override.
			mergeAttributes(HTMLAttributes, { class: "alfy-change arrive" }),
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
	result: Pick<PatchResult, "outcomes" | "inverses">,
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
			insertedBlockIds: inverse.insertedBlockIds,
		});
	}

	if (changed) {
		tr.setMeta("addToHistory", false);
		// Mark-only (Fix agent C, rd/review-2-5.md:109-121): this transaction
		// only ADDS the AlfyChange mark over text a patch already applied
		// elsewhere — it is not itself a user edit. Without `preventUpdate`,
		// Tiptap's own `Editor` still treats a mark-only change as
		// `docChanged` and fires `update` regardless, which reached
		// `DocumentBody.svelte`'s `handleUpdate` → autosave and wrote a
		// spurious, byte-identical version.
		tr.setMeta("preventUpdate", true);
		editor.view.dispatch(tr);
	}
	return entries;
}

/**
 * The one place that searches a document for a change mark's range — DOC
 * only (never `Editor`), so it is reachable from a ProseMirror plugin's own
 * `decorations(state)` prop, which never has a live `Editor` to call
 * `.schema`/`.view` on, only `state.doc` (a `Node` still carries its own
 * schema via `.type.schema`). `findAlfyChangeRange` (editor-based, below) and
 * `findAlfyChangeMarkRange` (exported for `change-pill-decoration.ts`'s own
 * plugin, the one other caller with no `Editor` at hand) both go through this
 * instead of repeating the `descendants` walk.
 */
function findAlfyChangeRangeInDoc(
	doc: PMNode,
	changeId: string,
): { from: number; to: number } | null {
	const markType = doc.type.schema.marks[ALFY_CHANGE_MARK];
	if (!markType) return null;

	let from = Number.POSITIVE_INFINITY;
	let to = -1;
	doc.descendants((node, pos) => {
		if (
			node.marks.some(
				(m) => m.type === markType && m.attrs[ALFY_CHANGE_ATTR] === changeId,
			)
		) {
			from = Math.min(from, pos);
			to = Math.max(to, pos + node.nodeSize);
		}
	});
	return to < 0 ? null : { from, to };
}

function findAlfyChangeRange(
	editor: Editor,
	changeId: string,
): { from: number; to: number } | null {
	return findAlfyChangeRangeInDoc(editor.state.doc, changeId);
}

/** The PMNode-only variant of `alfyChangeDocRange`, for a ProseMirror plugin's own `decorations(state)` prop — `change-pill-decoration.ts`'s one caller. */
export function findAlfyChangeMarkRange(
	doc: PMNode,
	changeId: string,
): { from: number; to: number } | null {
	return findAlfyChangeRangeInDoc(doc, changeId);
}

/** Keep: clears the mark, leaves the text exactly as applied. `true` when a mark was actually found and cleared. */
export function keepAlfyChange(editor: Editor, changeId: string): boolean {
	const markType = editor.schema.marks[ALFY_CHANGE_MARK];
	const range = markType ? findAlfyChangeRange(editor, changeId) : null;
	if (!markType || !range) return false;

	const tr = editor.state.tr.removeMark(range.from, range.to, markType);
	tr.setMeta("addToHistory", false);
	// Mark-only, like `applyAlfyChangeMarks` above: Keep's own persistence
	// (acknowledging the block) goes through `acknowledgeDocumentReviewBlocks`,
	// not a document body save — clearing the mark here must not also queue
	// an autosave.
	tr.setMeta("preventUpdate", true);
	editor.view.dispatch(tr);
	return true;
}

/**
 * The change mark's own live document range — `null` once the mark is gone
 * (already Kept — Keep clears it — or Undone: Undo replaces the whole node,
 * so nothing carries `changeId` any more). The inline pill's own widget
 * decoration (Wave 2.5 Step 10) uses this to position itself while pending,
 * and callers that are ABOUT to remove the mark structurally (Undo) capture
 * it first, as a fallback anchor for the brief "Undone · Redo" window when
 * the live lookup can no longer find anything.
 */
export function alfyChangeDocRange(
	editor: Editor,
	changeId: string,
): { from: number; to: number } | null {
	return findAlfyChangeRange(editor, changeId);
}

/**
 * Marks a WHOLE block with `AlfyChange{changeId}` — the same coarse
 * whole-block fallback `applyAlfyChangeMarks` already uses when a precise
 * text range cannot be found, reused here for two callers that have no
 * op-level precision to re-derive: Redo (the original precise range is gone
 * once Undo replaced the node) and ruling 61's reload-restored pending set
 * (the server only ever answers "this block changed", never which
 * characters). `false` when the block is not currently in the document.
 */
export function remarkAlfyChange(
	editor: Editor,
	changeId: string,
	blockId: string,
): boolean {
	const markType = editor.schema.marks[ALFY_CHANGE_MARK];
	const range = markType ? findBlockRange(editor, blockId) : null;
	if (!markType || !range) return false;
	const tr = editor.state.tr.addMark(
		range.from + 1,
		range.to - 1,
		markType.create({ [ALFY_CHANGE_ATTR]: changeId }),
	);
	tr.setMeta("addToHistory", false);
	// Mark-only, like `applyAlfyChangeMarks`/`keepAlfyChange` above. Ruling
	// 61's reload-restore is the case that matters most: without this, merely
	// OPENING a Document with unreviewed Alfy changes re-marked every pending
	// block and each mark-add fired `update` → autosave → a new, empty
	// "Edited" version, every single time the document was opened.
	tr.setMeta("preventUpdate", true);
	editor.view.dispatch(tr);
	return true;
}

/** Scrolls the change mark into view — "See what Alfy did" (T8.4). `true` when a mark was found to scroll to. */
export function scrollToAlfyChange(editor: Editor, changeId: string): boolean {
	const range = findAlfyChangeRange(editor, changeId);
	if (!range) return false;
	try {
		const dom = editor.view.domAtPos(range.from).node;
		const element =
			dom.nodeType === Node.ELEMENT_NODE
				? (dom as HTMLElement)
				: dom.parentElement;
		element?.scrollIntoView({ block: "center", behavior: "smooth" });
		return true;
	} catch {
		return false;
	}
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
 *
 * RV-1B, coordinator item 7: `entry.insertedBlockIds` (`patch.ts`'s own
 * `PatchInverse` field, carried through by `applyAlfyChangeMarks` above) are
 * ALSO removed, in the same transaction — an op whose text read as more than
 * one block (a paragraph Alfy split in two, a new section appended) left
 * every block after the first one sitting in the document forever, because
 * this function only ever replaced `entry.blockId`'s own node. Undo is
 * defined as restoring the document to what it was BEFORE the op (spec
 * §2.4), not just restoring one block's text.
 *
 * `entry.isNewBlock` (ruling 61: a reload-restored pending change for a block
 * Alfy ADDED, with no parent counterpart) means "restoring the parent" is
 * removing the block. That is the caller's explicit answer to the one
 * question an empty `previousMarkdown` cannot answer by itself: a block Alfy
 * added (delete it) and a block that existed but was itself blank before the
 * op (put a blank one back — never let the document lose a block). The
 * Markdown model has no way to store an empty block (a marker with nothing
 * after it is dropped on the next save, `blocks.ts`'s `splitIntoSegments`), so
 * a blank one is restored as the same single zero-width space a brand-new
 * tab's anchor paragraph uses (`EMPTY_TAB_ANCHOR_PLACEHOLDER`): invisible,
 * kept by a save, and read as empty text by every reader outside the editor.
 * Only ruling 61's reload path ever sets `isNewBlock`; the live session's own
 * `AlfyChangeEntry` never does.
 */
export function undoAlfyChange(
	editor: Editor,
	entry: {
		blockId: string;
		previousMarkdown: string;
		insertedBlockIds?: string[];
		isNewBlock?: boolean;
	},
	extensions: Extensions,
): boolean {
	const target = findBlockRange(editor, entry.blockId);
	if (!target) return false;

	if (entry.isNewBlock) {
		const tr = editor.state.tr.delete(target.from, target.to);
		tr.setMeta("addToHistory", false);
		editor.view.dispatch(tr);
		return true;
	}

	const restored = parseBlockNodes(
		editor,
		[{ blockId: entry.blockId, markdown: entry.previousMarkdown }],
		extensions,
	);
	const replacement = restored?.[0];
	if (!replacement) return false;

	const tr = editor.state.tr.replaceWith(target.from, target.to, replacement);
	if (entry.insertedBlockIds && entry.insertedBlockIds.length > 0) {
		deleteBlocksById(tr, entry.insertedBlockIds);
	}
	tr.setMeta("addToHistory", false);
	editor.view.dispatch(tr);
	return true;
}

/** A block Undo took out of the document, kept by the caller so Redo can put it back: its id and its own Markdown as of just before Undo ran. */
export interface RedoBlock {
	blockId: string;
	markdown: string;
}

/**
 * Redo, the mirror of `undoAlfyChange`: sets `entry.blockId`'s node back to
 * the text Alfy had applied (`appliedMarkdown`) AND puts back every extra
 * block the op's text had produced (`insertedBlocks`, the ones Undo deleted
 * through `insertedBlockIds`), in order and directly after that block, each
 * with the id it had — so a later Undo, the review state and any comment
 * anchored there all still find them. Before this, Redo restored the first
 * block only and a multi-block change came back short.
 *
 * A block already in the document is skipped, so a second call adds nothing
 * twice. Dispatched with `addToHistory: false`, exactly like Undo: neither
 * direction is a step in the user's own text history.
 */
export function redoAlfyChange(
	editor: Editor,
	entry: {
		blockId: string;
		appliedMarkdown: string;
		insertedBlocks?: RedoBlock[];
	},
	extensions: Extensions,
): boolean {
	const target = findBlockRange(editor, entry.blockId);
	if (!target) return false;

	const present = new Set<string>();
	editor.state.doc.forEach((node) => {
		const id = node.attrs?.[BLOCK_ID_ATTR];
		if (typeof id === "string") present.add(id);
	});
	const missing = (entry.insertedBlocks ?? []).filter(
		(block) => !present.has(block.blockId),
	);

	const nodes = parseBlockNodes(
		editor,
		[{ blockId: entry.blockId, markdown: entry.appliedMarkdown }, ...missing],
		extensions,
	);
	if (!nodes) return false;
	const [primary, ...extras] = nodes;

	const tr = editor.state.tr.replaceWith(target.from, target.to, primary);
	let insertAt = target.from + primary.nodeSize;
	for (const node of extras) {
		tr.insert(insertAt, node);
		insertAt += node.nodeSize;
	}
	tr.setMeta("addToHistory", false);
	editor.view.dispatch(tr);
	return true;
}

/**
 * Builds the top-level node each `items[i].markdown` reads as, carrying
 * `items[i].blockId`, in `editor`'s OWN schema — or `null` when a snippet
 * yields no node at all. The one throwaway, detached `Editor` parses every
 * snippet (one per call, not one per block): see `undoAlfyChange`'s comment
 * above for why the node is rebuilt from plain JSON and why `extensions`
 * must be a fresh list.
 *
 * A blank snippet becomes the zero-width-space placeholder paragraph (see
 * `undoAlfyChange`): an empty node would not survive the next save.
 */
function parseBlockNodes(
	editor: Editor,
	items: RedoBlock[],
	extensions: Extensions,
): PMNode[] | null {
	const scratch = document.createElement("div");
	document.body.appendChild(scratch);
	const temp = new Editor({
		element: scratch,
		extensions,
		content: "",
		contentType: "markdown",
	});
	try {
		const nodes: PMNode[] = [];
		for (const item of items) {
			const blank = stripEmptyTabAnchorPlaceholder(item.markdown).trim() === "";
			temp.commands.setContent(
				blank ? EMPTY_TAB_ANCHOR_PLACEHOLDER : item.markdown,
				{
					contentType: "markdown",
					emitUpdate: false,
				},
			);
			const raw = temp.state.doc.firstChild;
			if (!raw) return null;
			const rawJSON = raw.toJSON() as { attrs?: Record<string, unknown> };
			nodes.push(
				PMNode.fromJSON(editor.state.schema, {
					...rawJSON,
					attrs: { ...rawJSON.attrs, [BLOCK_ID_ATTR]: item.blockId },
				}),
			);
		}
		return nodes;
	} finally {
		temp.destroy();
		scratch.remove();
	}
}

/**
 * Deletes every top-level block whose `BLOCK_ID_ATTR` is in `blockIds`, from
 * `tr.doc` — the transaction's OWN current document, which already reflects
 * whatever steps `tr` carries so far (the preceding `replaceWith` above), not
 * the stale `editor.state.doc` the transaction started from. Reverse
 * position order, like `document-editor.ts`'s own marker deletion: deleting
 * block `i` must not shift the position of any block `j` with `j < i` that
 * has not been deleted yet. A missing id (already removed by some other
 * means) is silently skipped — Undo restores what it can, it does not throw
 * over a block that is already gone.
 */
function deleteBlocksById(tr: Transaction, blockIds: string[]): void {
	const wanted = new Set(blockIds);
	const matches: { pos: number; size: number }[] = [];
	tr.doc.forEach((node, offset) => {
		const id = node.attrs?.[BLOCK_ID_ATTR];
		if (typeof id === "string" && wanted.has(id)) {
			matches.push({ pos: offset, size: node.nodeSize });
		}
	});
	for (const match of matches.sort((a, b) => b.pos - a.pos)) {
		tr.delete(match.pos, match.pos + match.size);
	}
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
export function summarizeRefusals(
	result: Pick<PatchResult, "outcomes">,
): RefusalSummary | null {
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
