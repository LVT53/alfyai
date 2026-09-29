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
import type { DocumentTab } from "$lib/server/services/artifacts/serialize/document";
import { ANCHOR_CONTEXT_CHARS } from "$lib/shared/artifact-document/anchor";
import {
	EMPTY_TAB_ANCHOR_PLACEHOLDER,
	MARKER_PREFIX,
} from "$lib/shared/artifact-document/blocks";
import type {
	PatchResult,
	PatchSet,
} from "$lib/shared/artifact-document/patch";
import { MOTION_EASING, prefersReducedMotion } from "$lib/utils/motion";
import {
	type AlfyWritingTarget,
	alfyWritingPluginKey,
	findBlockNodeRange,
	type RefusedLinesTarget,
	refusedLinesPluginKey,
	type SelectionPendingTarget,
	selectionPendingPluginKey,
} from "./alfy-writing-decoration";
import {
	type ChangePillCallbacks,
	type ChangePillEntry,
	changePillPluginKey,
} from "./change-pill-decoration";
import {
	BLOCK_ID_ATTR,
	BLOCK_MARKER_NODE,
	blockIdPluginKey,
	buildDocumentExtensions,
	type CommentAnchorTarget,
	commentAnchorDocRange,
	commentAnchorPluginKey,
	ensureBlockIds,
	SKIP_BLOCK_ID_PLUGIN,
	tabSectionPluginKey,
} from "./extensions";
import {
	type AlfyChangeEntry,
	alfyChangeDocRange,
	applyAlfyChangeMarks,
	keepAlfyChange,
	refusalReasonI18nKey,
	remarkAlfyChange,
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
	/** Wave 2.5 Step 10: the inline pill's own Keep/Undo/Redo — see `change-pill-decoration.ts`. */
	changePillCallbacks?: ChangePillCallbacks;
	/**
	 * Review 2.5 (rd/review-2-5.md:198-207): Tab from a non-collapsed
	 * selection reached the editor's OWN next focusable DOM node first (a
	 * comment highlight span, a chip select, a change pill, a task
	 * checkbox) — the selection bubble/pill came after every one of those,
	 * so keyboard-only Ask Alfy/Comment was unreachable (only the
	 * ⌘/Ctrl+Alt+M shortcut worked). Called from `handleKeyDown` below on a
	 * plain Tab press over a non-empty selection; returning `true` (it
	 * focused the pill's first button) suppresses Tab's own default so
	 * focus does not ALSO jump to that next highlight. `DocumentBody.svelte`
	 * implements this — the bubble itself is a Tiptap-free, purely
	 * presentational sibling this module has no reference to.
	 */
	onTabIntoSelectionPill?: () => boolean;
}

/** Builds the one editor instance a `DocumentBody` owns, with ids already ensured. */
export function createDocumentEditor(
	options: CreateDocumentEditorOptions,
): Editor {
	const editor = new Editor({
		element: options.element,
		extensions: buildDocumentExtensions(
			options.placeholder,
			options.changePillCallbacks,
		),
		content: options.markdown,
		contentType: "markdown",
		editable: options.editable ?? true,
		editorProps: {
			attributes: { class: "document-content", spellcheck: "true" },
			handleKeyDown: (_view, event) => {
				if (event.key !== "Tab" || event.shiftKey || event.altKey) {
					return false;
				}
				if (editor.state.selection.empty) return false;
				if (!options.onTabIntoSelectionPill?.()) return false;
				event.preventDefault();
				return true;
			},
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
 * Redesign §5.2 "Tabs switch sections", Wave 2.5 Step 5: the one place that
 * turns `Tabs.svelte`'s `onActivate`/`onChange` notifications into the
 * editor actually hiding every other section's blocks — see
 * `extensions.ts`'s `tabSectionPluginKey`/`buildTabSectionDecorations` for
 * the decoration itself. `DocumentBody.svelte` calls this once right after
 * `createDocumentEditor` (so the very first paint already has the right
 * section visible) and again on every `onActivate`/`onChange`. A no-op
 * dispatch (nothing to mark as history, no document change) — the same
 * pattern `ensureBlockIds`'s own transactions use.
 */
export function setActiveDocumentTab(
	editor: Editor,
	tabs: DocumentTab[],
	activeTabId: string,
): void {
	const tr = editor.state.tr.setMeta(tabSectionPluginKey, {
		tabs,
		activeTabId,
	});
	tr.setMeta("addToHistory", false);
	tr.setMeta("preventUpdate", true);
	editor.view.dispatch(tr);
}

/**
 * Review 2.5 (rd/review-2-5.md:191-197, rd2's own suggested fix): a brand-new
 * tab used to start with no block of its own (`Tabs.svelte`'s `addTab` sets
 * `startBlockId: ""`), so `buildTabSectionDecorations`'s own "active tab
 * owns zero blocks -> show everything" safety net always fired — an empty
 * new section showed the WHOLE document instead.
 *
 * Appends one paragraph and returns its minted id: `extensions.ts`'s
 * `BlockIds` extension mints an id for any un-identified block on EVERY
 * doc-changing transaction (its own `appendTransaction`, the same mechanism
 * `ensureBlockIds` drives at load time), so by the time `.run()` returns the
 * new paragraph already carries a real one — nothing here mints it by hand.
 *
 * The paragraph's own text is a single zero-width space (`​`), not
 * truly empty — `blocks.ts`'s own `splitIntoSegments` documents, by design,
 * that "a trailing marker with no following block is dropped" (a blank line
 * has no Markdown syntax for "an empty block with this id" at all, and
 * `saveDocumentBody` re-canonicalises through that same parser on every
 * save), so a LITERALLY empty paragraph's marker — and with it, this tab's
 * only anchor — silently vanished on the very next save, reviving the exact
 * bug this function exists to fix the moment the document was reopened
 * (confirmed empirically while writing this function's own test suite). A
 * zero-width space is invisible to the user but not blank to `.trim()`, so
 * the block survives. The selection below SELECTS that one character (not a
 * collapsed caret after it) so the user's first keystroke replaces it
 * outright, leaving no stray invisible character behind.
 *
 * A real, undo-able transaction on purpose (never the load-time
 * `addToHistory: false` shape `setActiveDocumentTab` above uses) — this is
 * user-initiated content, not bookkeeping, so it autosaves and Undo removes
 * it like any other edit. `null` only if the schema has no paragraph node
 * (never true for this Document's own fixed schema — defensive, not a real
 * branch).
 *
 * The placeholder character itself is `blocks.ts`'s own exported
 * `EMPTY_TAB_ANCHOR_PLACEHOLDER` (a single source of truth for the one
 * function that writes it here and the one function that strips it,
 * `stripEmptyTabAnchorPlaceholder`, for every reader outside the live editor
 * — see that module's own doc comment).
 */
export function appendEmptyTabSection(editor: Editor): string | null {
	if (!editor.schema.nodes.paragraph) return null;
	const endPos = editor.state.doc.content.size;
	editor
		.chain()
		.focus()
		.insertContentAt(endPos, {
			type: "paragraph",
			content: [{ type: "text", text: EMPTY_TAB_ANCHOR_PLACEHOLDER }],
		})
		.run();
	const docEnd = editor.state.doc.content.size;
	const charStart = docEnd - 1 - EMPTY_TAB_ANCHOR_PLACEHOLDER.length;
	editor
		.chain()
		.focus()
		.setTextSelection({ from: charStart, to: docEnd - 1 })
		.scrollIntoView()
		.run();
	const id = editor.state.doc.lastChild?.attrs?.[BLOCK_ID_ATTR];
	return typeof id === "string" && id.length > 0 ? id : null;
}

export type { CommentAnchorTarget };

/**
 * Redesign §3.2/§9.2, Wave 2.5 Step 7: the two-way link's write side.
 * `MarginPanel.svelte` re-resolves every comment's anchor on every relevant
 * change (`resolveTextAnchor` against `blocks`, already its own job — T10)
 * and reports the result up through `DocumentBody.svelte`, which calls this
 * once per change, mirroring `setActiveDocumentTab`'s own no-op-for-history
 * dispatch pattern exactly. `activeCommentId` is whichever thread is
 * currently linked — hover/focus on its card, or its own words having been
 * clicked/focused — `null` when nothing is.
 */
export function setCommentAnchors(
	editor: Editor,
	anchors: CommentAnchorTarget[],
	activeCommentId: string | null,
): void {
	const tr = editor.state.tr.setMeta(commentAnchorPluginKey, {
		anchors,
		activeCommentId,
	});
	tr.setMeta("addToHistory", false);
	tr.setMeta("preventUpdate", true);
	editor.view.dispatch(tr);
}

export type { AlfyWritingTarget, RefusedLinesTarget, SelectionPendingTarget };

/**
 * Wave 2.5 Step 9/11: the Ask-Alfy chain's three write sides, all mirroring
 * `setCommentAnchors`'s own no-op-for-history dispatch pattern exactly (see
 * `alfy-writing-decoration.ts`'s header). `null` clears each one.
 */
export function setAlfyWritingBlock(
	editor: Editor,
	target: AlfyWritingTarget | null,
): void {
	const tr = editor.state.tr.setMeta(alfyWritingPluginKey, target);
	tr.setMeta("addToHistory", false);
	tr.setMeta("preventUpdate", true);
	editor.view.dispatch(tr);
}

export function setSelectionPending(
	editor: Editor,
	target: SelectionPendingTarget | null,
): void {
	const tr = editor.state.tr.setMeta(selectionPendingPluginKey, target);
	tr.setMeta("addToHistory", false);
	tr.setMeta("preventUpdate", true);
	editor.view.dispatch(tr);
}

export function setRefusedLines(
	editor: Editor,
	target: RefusedLinesTarget | null,
): void {
	const tr = editor.state.tr.setMeta(refusedLinesPluginKey, target);
	tr.setMeta("addToHistory", false);
	tr.setMeta("preventUpdate", true);
	editor.view.dispatch(tr);
}

/**
 * Wave 2.5 Step 10: pushes the CURRENT pending/kept/undone change list into
 * the editor — `DocumentBody.svelte`'s own `pendingChanges` map, mapped to
 * `ChangePillEntry[]`, is the one source; this is the one write side (mirrors
 * `setAlfyWritingBlock`/`setSelectionPending`/`setRefusedLines` above
 * exactly). A no-op when the editor's own extension list never registered
 * `changePillCallbacks` (`buildDocumentExtensions`'s optional third
 * argument) — `changePillPluginKey.getState` simply finds no plugin.
 */
export type { ChangePillCallbacks, ChangePillEntry };

export function setChangePills(
	editor: Editor,
	entries: ChangePillEntry[],
): void {
	const tr = editor.state.tr.setMeta(changePillPluginKey, entries);
	tr.setMeta("addToHistory", false);
	tr.setMeta("preventUpdate", true);
	editor.view.dispatch(tr);
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
	const withPipesEscaped = markdown.split(TABLE_CELL_PIPE_SENTINEL).join("\\|");
	return escapeParagraphListMarkerLookalikes(
		editor,
		widenCodeFencesForBacktickContent(editor, withPipesEscaped),
	);
}

/**
 * RV-1B, coordinator item 4: a plain paragraph whose own first line happens
 * to start with an ordered numeral ("2024. ") or a bullet character ("- ")
 * is, in bare Markdown, indistinguishable from a real list — `blocks.ts`'s
 * splitter (`ORDERED_START_RE`/`BULLET_START_RE`) reads either shape as
 * `kind: "list"` on the very next parse, silently changing the block's own
 * kind (and, since a "list" block does not read back through the same rules
 * as a "paragraph" — different label derivation, different visible-text
 * joining — its label and any comment anchor resolved against it).
 *
 * Fixed the same way as the code-fence widening above: found in the LIVE
 * document, never guessed from the ambiguous output string. A real list's own
 * first item serialises to the exact same "- "/"1. " shape a look-alike
 * paragraph does, so the string alone cannot tell "the user typed a dash"
 * from "this really is a list" — only the live node's TYPE can. Only a
 * top-level `paragraph` node (`editor.state.doc.forEach`, the same top-level
 * scope `identified` above already uses — a `blocks.ts` block boundary is a
 * top-level construct; a look-alike start buried inside a blockquote or list
 * item does not change that outer block's own kind) whose own text starts
 * with the risky shape gets its block's first line escaped, one backslash
 * right before the marker character (`\-`) or before the ordered marker's
 * trailing punctuation (`2024\.`) — exactly where CommonMark's own escape
 * goes, and exactly what `blocks.ts`'s `inlinePlainText` already un-escapes
 * back to the literal character on every read (its escape range covers both
 * `-` and `.`).
 *
 * Applied to the STRING, after `getMarkdown()` has already run — never by
 * inserting the backslash into the live document first, which is the same
 * double-escaping trap `sentinelizeTableCellPipes` above already hit: a
 * literal backslash typed into a text node comes back from `getMarkdown()`
 * doubled (`\\`), because the serialiser escapes a text node's own backslash
 * too.
 */
function escapeParagraphListMarkerLookalikes(
	editor: Editor,
	markdown: string,
): string {
	let result = markdown;
	editor.state.doc.forEach((node) => {
		if (node.type.name !== "paragraph") return;
		const id = node.attrs?.[BLOCK_ID_ATTR];
		if (typeof id !== "string" || id.length === 0) return;
		if (!LIST_MARKER_LOOKALIKE_RE.test(node.textContent)) return;
		const markerAnchor = `${MARKER_PREFIX}${id}-->`;
		const anchorIndex = result.indexOf(markerAnchor);
		if (anchorIndex === -1) return;
		const afterMarker = anchorIndex + markerAnchor.length;
		result =
			result.slice(0, afterMarker) +
			result
				.slice(afterMarker)
				.replace(
					LEADING_LIST_MARKER_RE,
					(_match, lead: string, marker: string, ws: string) => {
						const escaped =
							marker.length === 1
								? `\\${marker}`
								: `${marker.slice(0, -1)}\\${marker.slice(-1)}`;
						return `${lead}${escaped}${ws}`;
					},
				);
	});
	return result;
}

/** Pre-check against the live paragraph's own text, before touching the output string at all. */
const LIST_MARKER_LOOKALIKE_RE = /^(?:[-*+]|\d+[.)])\s/;

/** Anchored to the start of "everything right after this block's own `<!--b:id-->` marker": the look-alike marker (a bullet character, or an ordered numeral plus its `.`/`)`) plus its required trailing whitespace, captured so only the marker's own punctuation gets escaped. */
const LEADING_LIST_MARKER_RE = /^(\n+)([-*+]|\d+[.)])(\s)/;

/**
 * RV-1B, coordinator item 3: a code block whose own content contains a line
 * of 3+ backticks (documentation about Markdown fencing is the obvious
 * example, but any pasted snippet of Markdown source qualifies) still gets a
 * plain 3-backtick fence from `getMarkdown()`, because `@tiptap/markdown`
 * always uses the minimum. CommonMark closes a fence at the FIRST line that
 * is itself a run of backticks at least as long as the opening fence, so
 * that inner line reads as the block's OWN closing fence on the very next
 * parse — cutting one code block into three pieces (a truncated code block,
 * a paragraph made of what should still be code, and a stray second code
 * block), confirmed by reparsing exactly this shape with `blocks.ts`.
 *
 * Fixed by finding, in the LIVE document (never the ambiguous output string
 * — by the time backtick content has forced an early close, the string
 * alone can no longer prove where one block ended and another began),
 * every code block whose content needs a longer fence, and replacing its
 * known `` ``` `` + content + `` ``` `` substring with the same content
 * wrapped in a fence one backtick longer than the longest all-backtick line
 * inside it.
 */
function widenCodeFencesForBacktickContent(
	editor: Editor,
	markdown: string,
): string {
	let result = markdown;
	editor.state.doc.descendants((node) => {
		if (node.type.name !== "codeBlock") return;
		const text = node.textContent;
		const requiredFenceLength = minimumFenceLength(text);
		if (requiredFenceLength <= 3 || !text) return;
		const language = (node.attrs.language as string | null) ?? "";
		const narrowFence = "`".repeat(3);
		const wideFence = "`".repeat(requiredFenceLength);
		const narrow = `${narrowFence}${language}\n${text}\n${narrowFence}`;
		const wide = `${wideFence}${language}\n${text}\n${wideFence}`;
		if (result.includes(narrow)) result = result.replace(narrow, wide);
	});
	return result;
}

/** The shortest fence (never below 3) that no all-backtick line inside `text` could close early. */
function minimumFenceLength(text: string): number {
	let longestBacktickLine = 0;
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length > 0 && /^`+$/.test(trimmed)) {
			longestBacktickLine = Math.max(longestBacktickLine, trimmed.length);
		}
	}
	return longestBacktickLine >= 3 ? longestBacktickLine + 1 : 3;
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
	entry: {
		blockId: string;
		previousMarkdown: string;
		insertedBlockIds?: string[];
		isNewBlock?: boolean;
	},
): boolean {
	return undoAlfyChange(editor, entry, buildDocumentExtensions(""));
}

/**
 * Re-marks a whole block as an Alfy change under `changeId` — Redo (the
 * pill's own "Undone · Redo") and ruling 61's reload-restore both have no
 * op-level precision to re-derive, only "this block".
 */
export function remarkChange(
	editor: Editor,
	changeId: string,
	blockId: string,
): boolean {
	return remarkAlfyChange(editor, changeId, blockId);
}

/** The change mark's own live document range, for the inline pill's widget decoration positioning while its mark is about to be replaced structurally (Undo). */
export function changeDocRange(
	editor: Editor,
	changeId: string,
): { from: number; to: number } | null {
	return alfyChangeDocRange(editor, changeId);
}

/** Scrolls a change's mark into view ("See what Alfy did", T8.4). */
export function scrollToChange(editor: Editor, changeId: string): boolean {
	return scrollToAlfyChange(editor, changeId);
}

/** A block's own on-screen rect, for the pinned refusal card's own positioning (redesign §4.2 "Refusal": "pinned beside the refused line") — mirrors `changeMarkRect`'s exact shape and jsdom fallback. */
export function blockRect(
	editor: Editor,
	blockId: string,
): { top: number; left: number; right: number; bottom: number } | null {
	const range = findBlockNodeRange(editor.state.doc, blockId);
	if (!range) return null;
	try {
		const start = editor.view.coordsAtPos(range.nodeStart + 1);
		const end = editor.view.coordsAtPos(range.contentEnd);
		return {
			top: start.top,
			left: start.left,
			right: end.right,
			bottom: end.bottom,
		};
	} catch {
		// jsdom (unit tests) does not implement real layout — a real browser
		// always has it (Playwright exercises this for real).
		return null;
	}
}

/**
 * Selects a whole block's text and scrolls it into view — the refusal
 * card's "Ask again" (redesign §4.2 "Refusal"): re-surfaces the selection
 * pill at the refused line rather than reopening a composer directly, so it
 * reads as the SAME ask flow the user would reach by selecting the text
 * themselves. `true` when the block was found and selected.
 */
export function selectAndScrollToBlock(
	editor: Editor,
	blockId: string,
): boolean {
	const range = findBlockNodeRange(editor.state.doc, blockId);
	if (!range) return false;
	const from = range.nodeStart + 1;
	const to = range.contentEnd;
	if (from >= to) return false;
	editor.chain().focus().setTextSelection({ from, to }).scrollIntoView().run();
	return true;
}

/**
 * The `.comment-anchor` mark's resting/peak visual states (motion #17: "a 3
 * px ring and deeper tint that fades"). Kept here, next to the one function
 * that plays them, rather than read back out of a computed style — mirrors
 * `--comment-mark`/`--comment-mark-active`/`--comment-rule`
 * (`DocumentBody.svelte`'s own Step 2.3 styles) by hand, the same trade-off
 * `motion.ts`'s own `MOTION_DURATION`/`MOTION_EASING` already make for every
 * other WAAPI call in this feature.
 */
const COMMENT_ANCHOR_FLASH_PEAK: Keyframe = {
	backgroundColor: "var(--comment-mark-active)",
	boxShadow: "0 0 0 3px var(--comment-rule)",
};
const COMMENT_ANCHOR_FLASH_RESTING: Keyframe = {
	backgroundColor: "var(--comment-mark)",
	boxShadow: "0 2px 0 -0.5px var(--comment-rule)",
};
/** Motion #17's own total, an explicit exception to `MOTION_DURATION.settle` (700 ms) — the spec names 900 ms for this one animation by hand. */
const COMMENT_ANCHOR_FLASH_MS = 900;

/**
 * "The quote button (goes to the anchor)" (Wave 2.5 Step 6) plus motion #17:
 * scrolls the live doc to a comment's resolved anchor and flashes it. Not
 * `reducedMotionAnimate` (`motion.ts`): that helper's reduced-motion path
 * jumps straight to the FINAL keyframe with no hold, but §7.3 rule 3
 * requires this ONE animation to hold a STATIC ring for the full 900 ms
 * under reduced motion too ("the flashed words get a static ring for
 * 900ms") — a real intermediate state, not just skipping to rest.
 */
export function scrollToCommentAnchor(
	editor: Editor,
	blockId: string,
	from: number,
	to: number,
): boolean {
	const range = commentAnchorDocRange(editor.state.doc, blockId, from, to);
	if (!range) return false;
	let element: HTMLElement | null = null;
	try {
		const dom = editor.view.domAtPos(range.from).node;
		element =
			dom.nodeType === Node.ELEMENT_NODE
				? (dom as HTMLElement)
				: dom.parentElement;
		element = element?.closest<HTMLElement>(".comment-anchor") ?? element;
		element?.scrollIntoView({ block: "center", behavior: "smooth" });
	} catch {
		// jsdom (unit tests) does not implement real layout — a real browser
		// always has it (Playwright exercises this for real).
		return false;
	}
	if (!element) return false;
	// A non-null `const` alias: TS cannot narrow a captured `let` inside the
	// closures below, and this element is never reassigned past this point.
	const el = element;

	if (prefersReducedMotion()) {
		Object.assign(el.style, COMMENT_ANCHOR_FLASH_PEAK);
		window.setTimeout(() => {
			el.style.backgroundColor = "";
			el.style.boxShadow = "";
		}, COMMENT_ANCHOR_FLASH_MS);
		return true;
	}
	const animation = el.animate(
		[COMMENT_ANCHOR_FLASH_PEAK, COMMENT_ANCHOR_FLASH_RESTING],
		{ duration: COMMENT_ANCHOR_FLASH_MS, easing: MOTION_EASING.out },
	);
	animation.addEventListener("finish", () => {
		el.style.backgroundColor = "";
		el.style.boxShadow = "";
	});
	return true;
}

export type { Editor };
