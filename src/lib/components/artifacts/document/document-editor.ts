/**
 * The lazy boundary (Feature 2 · Artifacts, Slice 1, T7). This is the ONLY
 * module `DocumentBody.svelte` imports with `await import(...)` — everything
 * Tiptap-shaped is reachable from here and nowhere the panel shell, the
 * toolbar host or the margin loads eagerly, so a chat page that never opens a
 * Document never pays for Tiptap/ProseMirror's bytes.
 */
import { Editor } from "@tiptap/core";
import type { ResolvedPos } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { ANCHOR_CONTEXT_CHARS } from "$lib/shared/artifact-document/anchor";
import type {
	PatchResult,
	PatchSet,
} from "$lib/shared/artifact-document/patch";
import {
	BLOCK_ID_ATTR,
	BLOCK_MARKER_NODE,
	blockIdPluginKey,
	buildDocumentExtensions,
	ensureBlockIds,
	SKIP_BLOCK_ID_PLUGIN,
} from "./extensions";
import {
	type AlfyChangeEntry,
	alfyChangeRect,
	applyAlfyChangeMarks,
	keepAlfyChange,
	refusalReasonI18nKey,
	scrollToAlfyChange,
	summarizeRefusals,
	undoAlfyChange,
} from "./marks";

export interface CreateDocumentEditorOptions {
	element: HTMLElement;
	markdown: string;
	placeholder: string;
	editable?: boolean;
	onDirty?: () => void;
	onSelectionUpdate?: () => void;
	onUpdate?: () => void;
}

/** Builds the one editor instance a `DocumentBody` owns, with ids already ensured. */
export function createDocumentEditor(
	options: CreateDocumentEditorOptions,
): Editor {
	const editor = new Editor({
		element: options.element,
		extensions: buildDocumentExtensions(options.placeholder),
		content: options.markdown,
		contentType: "markdown",
		editable: options.editable ?? true,
		editorProps: {
			attributes: { class: "document-content", spellcheck: "true" },
		},
		onUpdate: () => {
			options.onDirty?.();
			options.onUpdate?.();
		},
		onSelectionUpdate: () => {
			options.onSelectionUpdate?.();
		},
	});
	ensureBlockIds(editor);
	return editor;
}

/**
 * Replaces the document's content wholesale: used after Alfy's patch result
 * comes back (the new full markdown) and after an Undo (Contracts: Undo
 * reloads from a locally-recomputed markdown with one block reverted, never a
 * ProseMirror-position-based edit, so it cannot hit the wrong text). Absorbs
 * markers and mints anything missing, exactly like the initial load.
 */
export function loadMarkdown(editor: Editor, markdown: string): void {
	// `emitUpdate: false` (Tiptap's own `setContent` option) for the same
	// reason `ensureBlockIds` below sets `preventUpdate` on its dispatch:
	// replacing the whole document (Alfy's patch result, or an Undo) is a
	// programmatic content sync, not a user edit, so it must not fire
	// `DocumentBody.svelte`'s `onUpdate`/`onDirty` — see `readMarkdown`'s
	// comment for what happens when an internal dispatch fires `onUpdate`.
	editor.commands.setContent(markdown, {
		contentType: "markdown",
		emitUpdate: false,
	});
	ensureBlockIds(editor);
}

/**
 * The editor's own markdown, WITH id markers, for saving or hashing. Markers
 * are not live nodes in the document (see `extensions.ts`'s header comment):
 * this inserts one before every identified top-level block in a throwaway
 * transaction, calls `editor.getMarkdown()` (verified against the installed
 * 3.31.3 API: it takes no arguments and serialises `editor.state.doc`, so
 * there is no way to hand it an already-marked JSON blob instead), then
 * reverts the insertion. Both transactions dispatch with
 * `addToHistory: false`, so calling this never adds a step to the user's own
 * Undo stack, and the live document is byte-for-byte the same before and
 * after the call — verified by a two-call idempotency test (T7.5).
 *
 * CRITICAL: both transactions also carry `preventUpdate: true` (Tiptap's own
 * `Editor.dispatchTransaction` checks this meta key and skips emitting
 * `update` when it is set). Without it, each dispatch below fires Tiptap's
 * `update` event, which `document-editor.ts`'s caller wires straight to
 * `DocumentBody.svelte`'s `handleUpdate` — which calls
 * `currentCanonicalMarkdown()`, which calls `readMarkdown` again, whose two
 * dispatches would fire `update` again, and so on: unbounded synchronous
 * re-entrant recursion that overflows the call stack on the very first real
 * edit (typing, a toolbar action, a chip change — anything that reaches
 * `currentCanonicalMarkdown`). This was previously reported as a ProseMirror
 * bug ("Maximum call stack size exceeded" inside `Fragment.nodesBetween`,
 * reached through `fixTables`'s `appendTransaction` or `Editor.isActive`) —
 * that stack trace is real, but it is a SYMPTOM: whichever tree-walk happens
 * to run at the moment the recursion finally exhausts the stack is what the
 * trace shows, not the cause. `preventUpdate` marks these two transactions as
 * bookkeeping, not a user edit, which stops `handleUpdate` from ever being
 * re-entered from inside itself. Regression coverage: `tests/e2e/
 * artifact-document.spec.ts`'s "sustained edits" test drives typing, a table
 * cell, "Add a tab" and a chip change back to back in one open editor.
 */
export function readMarkdown(editor: Editor): string {
	const identified: { pos: number; id: string }[] = [];
	editor.state.doc.forEach((node, offset) => {
		const id = node.attrs?.[BLOCK_ID_ATTR];
		if (typeof id === "string" && id.length > 0)
			identified.push({ pos: offset, id });
	});

	const markerType = editor.state.schema.nodes[BLOCK_MARKER_NODE];
	const insertTr = editor.state.tr;
	// Reverse order: inserting before block[i] must not shift the position of
	// any block[j] with j < i that has not been processed yet.
	for (let i = identified.length - 1; i >= 0; i -= 1) {
		const { pos, id } = identified[i];
		insertTr.insert(pos, markerType.create({ id }));
	}
	// RV-1B, coordinator item 2: a literal "|" the user typed inside a table
	// cell is an ordinary character to them but a column separator to
	// Markdown's table syntax. `@tiptap/markdown`'s own table serializer does
	// not escape it, so `getMarkdown()` below would write it bare — and on
	// the very next parse, blocks.ts's table reader counts it as an extra
	// column, silently reflowing (and, once the row is padded back down to
	// the header's column count, silently DROPPING) the cell after it.
	// Replaced with a sentinel here, for the duration of this call only, and
	// reverted below alongside the markers — the live document the user sees
	// never gains a character they did not type. A sentinel, not `\|`
	// directly: `getMarkdown()` ALSO escapes a literal backslash in cell text
	// (confirmed empirically — inserting `\|` came back as `\\|`, which still
	// reads as an unescaped separator), so injecting the escape before
	// serialization does not survive it; the sentinel passes through
	// untouched and becomes `\|` only in the returned STRING, after
	// `getMarkdown()` has already run its own escaping pass.
	sentinelizeTableCellPipes(insertTr);
	insertTr.setMeta("addToHistory", false);
	// Without this, dispatching the insertion re-triggers BlockIds' own
	// appendTransaction, which would see a marker whose following block is
	// already identified, decide there is nothing to absorb, and delete the
	// marker anyway as routine cleanup — before `getMarkdown()` below ever
	// runs. The output-only marker would never survive to be serialised.
	insertTr.setMeta(blockIdPluginKey, SKIP_BLOCK_ID_PLUGIN);
	// See this function's own header comment: without this, dispatching below
	// fires Tiptap's `update` event and recurses back into this very function
	// through `DocumentBody.svelte`'s `onUpdate` wiring.
	insertTr.setMeta("preventUpdate", true);
	editor.view.dispatch(insertTr);

	const markdown = editor.getMarkdown();

	const deleteTr = editor.state.tr;
	const markers: { pos: number; size: number }[] = [];
	editor.state.doc.forEach((node, offset) => {
		if (node.type.name === BLOCK_MARKER_NODE)
			markers.push({ pos: offset, size: node.nodeSize });
	});
	for (const marker of [...markers].sort((a, b) => b.pos - a.pos)) {
		deleteTr.delete(marker.pos, marker.pos + marker.size);
	}
	unsentinelizeTableCellPipes(deleteTr);
	deleteTr.setMeta("addToHistory", false);
	deleteTr.setMeta(blockIdPluginKey, SKIP_BLOCK_ID_PLUGIN);
	deleteTr.setMeta("preventUpdate", true);
	editor.view.dispatch(deleteTr);

	// The sentinel becomes a real, correctly-escaped pipe only in the
	// returned STRING — see `sentinelizeTableCellPipes`'s own comment for why
	// this cannot happen before `getMarkdown()` runs.
	return markdown.split(TABLE_CELL_PIPE_SENTINEL).join("\\|");
}

/**
 * A placeholder for a literal `|` inside a table cell, chosen to be
 * vanishingly unlikely in real document text and to contain NO character
 * `getMarkdown()`'s own escaping treats specially — confirmed empirically
 * the hard way: a first attempt using `_` as a separator came back with the
 * underscores themselves escaped to `\_` (markdown's own emphasis
 * character), which broke the exact-string match this sentinel depends on.
 * Plain letters and digits between two NUL bytes pass through untouched.
 */
const TABLE_CELL_PIPE_SENTINEL = "\u0000RV1BTABLEPIPE7QX\u0000";

/** True when `$pos` resolves to somewhere inside a table cell, at any depth (a cell's own content is typically wrapped in a paragraph, so the cell is rarely the DIRECT parent). */
function isInsideTableCell($pos: ResolvedPos): boolean {
	for (let d = $pos.depth; d >= 0; d -= 1) {
		const name = $pos.node(d).type.name;
		if (name === "tableCell" || name === "tableHeader") return true;
	}
	return false;
}

/** Shared by `sentinelizeTableCellPipes`/`unsentinelizeTableCellPipes`: finds every table-cell text node `transform` would change, then applies the replacements last-to-first so earlier positions stay valid. */
function transformTableCellText(
	tr: Transaction,
	transform: (text: string) => string,
): void {
	const edits: { from: number; to: number; text: string }[] = [];
	tr.doc.descendants((node, pos) => {
		if (!node.isText || !node.text) return;
		const transformed = transform(node.text);
		if (transformed === node.text) return;
		if (!isInsideTableCell(tr.doc.resolve(pos))) return;
		edits.push({ from: pos, to: pos + node.text.length, text: transformed });
	});
	for (const edit of [...edits].sort((a, b) => b.from - a.from)) {
		tr.insertText(edit.text, edit.from, edit.to);
	}
}

function sentinelizeTableCellPipes(tr: Transaction): void {
	transformTableCellText(tr, (text) =>
		text.includes("|") ? text.split("|").join(TABLE_CELL_PIPE_SENTINEL) : text,
	);
}

function unsentinelizeTableCellPipes(tr: Transaction): void {
	transformTableCellText(tr, (text) =>
		text.includes(TABLE_CELL_PIPE_SENTINEL)
			? text.split(TABLE_CELL_PIPE_SENTINEL).join("|")
			: text,
	);
}

/** Viewport coordinates (`EditorView.coordsAtPos`'s own shape) spanning the selection, for the bubble's own placement. */
export interface SelectionScreenRect {
	top: number;
	left: number;
	right: number;
	bottom: number;
}

/**
 * The SelectionBubble's own data source (T10.1) — the ONE place the live
 * selection is ever read out of ProseMirror, including where it sits on
 * screen (`rect`), so `DocumentBody.svelte` never has to touch
 * `editor.state`/`editor.view` itself just to position the bubble. Returns
 * plain strings, a block id and a plain rect — never a ProseMirror position
 * or node — so everything downstream (`makeAnchor`, the margin) stays free of
 * this module's import. `null` for an empty selection (a caret, not a range)
 * or one that falls outside any identified top-level block.
 */
export function readSelectionAnchorContext(editor: Editor): {
	blockId: string;
	quote: string;
	prefix: string;
	suffix: string;
	rect: SelectionScreenRect;
} | null {
	const { from, to, empty } = editor.state.selection;
	if (empty) return null;

	let blockId: string | null = null;
	let blockStart = 0;
	let blockEnd = 0;
	editor.state.doc.forEach((node, offset) => {
		if (blockId !== null) return;
		const nodeEnd = offset + node.nodeSize;
		if (offset > from || from >= nodeEnd) return;
		const id = node.attrs?.[BLOCK_ID_ATTR];
		if (typeof id !== "string" || id.length === 0) return;
		blockId = id;
		blockStart = offset;
		blockEnd = nodeEnd;
	});
	if (blockId === null) return null;

	const quote = editor.state.doc.textBetween(from, to, "\n");
	if (!quote.trim()) return null;

	// `coordsAtPos` measures real layout (`Range.getClientRects`), which a
	// test environment with no real rendering (jsdom) does not implement — a
	// zeroed rect there is harmless (the bubble just renders at the origin,
	// exercised for real by Playwright); a real browser always has it.
	let startCoords = { top: 0, left: 0, bottom: 0, right: 0 };
	let endCoords = { top: 0, left: 0, bottom: 0, right: 0 };
	try {
		startCoords = editor.view.coordsAtPos(from);
		endCoords = editor.view.coordsAtPos(to);
	} catch {
		// See above — measurement is best-effort.
	}

	return {
		blockId,
		quote,
		prefix: editor.state.doc.textBetween(
			Math.max(blockStart, from - ANCHOR_CONTEXT_CHARS),
			from,
			"\n",
		),
		suffix: editor.state.doc.textBetween(
			to,
			Math.min(blockEnd, to + ANCHOR_CONTEXT_CHARS),
			"\n",
		),
		rect: {
			top: startCoords.top,
			left: startCoords.left,
			right: endCoords.right,
			bottom: startCoords.bottom,
		},
	};
}

// ---------------------------------------------------------------------------
// T8 live: marks.ts's whole surface, reachable only through this boundary
// (marks.ts's own header comment) — `DocumentBody.svelte` never imports
// "./marks" directly, so mounting a Document body without any Alfy activity
// yet never pays for this module's `@tiptap/*` imports beyond what loading
// the editor itself already costs.
// ---------------------------------------------------------------------------

// `RefusalSummary` itself is not re-exported: every caller (DocumentBody.svelte)
// only ever holds a value returned by `summarizeRefusals` below, inferred
// rather than named — an unused re-export is exactly what Fallow's
// unused-types check exists to catch.
export type { AlfyChangeEntry };
export { refusalReasonI18nKey, summarizeRefusals };

/** Marks an applied patch's changed text/blocks. See `marks.ts`'s `applyAlfyChangeMarks`. */
export function applyAlfyChanges(
	editor: Editor,
	result: Pick<PatchResult, "outcomes" | "inverses">,
	patch?: PatchSet,
): AlfyChangeEntry[] {
	return applyAlfyChangeMarks(editor, result, patch);
}

/** Clears one change's mark, leaving its text. */
export function keepChange(editor: Editor, changeId: string): boolean {
	return keepAlfyChange(editor, changeId);
}

/**
 * Restores exactly one change's pre-edit text. Builds its own fresh
 * extension list per call (`marks.ts`'s `undoAlfyChange` doc comment: two
 * editors must never share one resolved list), so the caller never has to
 * know `Extensions`/`buildDocumentExtensions` exist.
 */
export function undoChange(
	editor: Editor,
	entry: { blockId: string; previousMarkdown: string },
): boolean {
	return undoAlfyChange(editor, entry, buildDocumentExtensions(""));
}

/** The change mark's on-screen rect, for the inline bar's own positioning. */
export function changeMarkRect(
	editor: Editor,
	changeId: string,
): { top: number; left: number; right: number; bottom: number } | null {
	return alfyChangeRect(editor, changeId);
}

/** Scrolls a change's mark into view ("See what Alfy did", T8.4). */
export function scrollToChange(editor: Editor, changeId: string): boolean {
	return scrollToAlfyChange(editor, changeId);
}

export type { Editor };
