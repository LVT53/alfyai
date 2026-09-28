/**
 * Three small, ephemeral, single-purpose ProseMirror decorations for the
 * Artifacts redesign's Ask-Alfy chain (redesign.md §4.2 items 2/4/"Refusal",
 * §9.2's `extensions.ts`/`document-editor.ts` row: "Alfy writing on blocks,
 * refused-line rule"; Wave 2.5 Step 9/11). Kept in their own module per this
 * step's brief ("new decorations in their own module, registered from
 * extensions.ts with a small change") rather than growing that already-large
 * file — `extensions.ts` only gains the three plugins' registration.
 *
 * All three follow the SAME shape `extensions.ts`'s own `CommentAnchors`
 * plugin already established (rd3a's hand-off: "the one other place in this
 * feature that will eventually need an anchor decoration... should follow
 * the SAME shape"): plugin STATE only (never touching the document), written
 * exclusively through a no-op-for-history transaction
 * (`document-editor.ts`'s `setAlfyWritingBlock`/`setSelectionPending`/
 * `setRefusedLines`), resolved from data the CALLER already has —
 * `DocumentBody.svelte` never re-derives block lookup a second way, and this
 * module never touches `editor.state`/`dispatch` itself.
 *
 * Imports `BLOCK_ID_ATTR` from `./block-attrs`, never `./extensions` —
 * `extensions.ts` registers this module's plugins (`buildDocumentExtensions`
 * spreads `alfyWritingChainExtensions`), so this module importing back FROM
 * `extensions.ts` would be exactly the circular import `block-attrs.ts`'s own
 * header comment already explains Fallow's gate does not allow a new one of.
 * The character-offset walk below is a small, deliberate duplicate of
 * `extensions.ts`'s own private `positionAtCharOffset` for the same reason.
 */

import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { BLOCK_ID_ATTR } from "./block-attrs";

/** The live doc's own top-level block node matching `blockId`, and its own (not just its content's) bounds. Mirrors `extensions.ts`'s private `findBlockContentRange`, duplicated rather than exported/shared — an ~8-line node walk is cheaper than widening that file's own export surface for one more caller. */
function findBlockNodeRange(
	doc: PMNode,
	blockId: string,
): { nodeStart: number; nodeEnd: number; contentEnd: number } | null {
	let result: {
		nodeStart: number;
		nodeEnd: number;
		contentEnd: number;
	} | null = null;
	doc.forEach((node, offset) => {
		if (result !== null) return;
		if (node.attrs?.[BLOCK_ID_ATTR] !== blockId) return;
		result = {
			nodeStart: offset,
			nodeEnd: offset + node.nodeSize,
			contentEnd: offset + node.nodeSize - 1,
		};
	});
	return result;
}

// ---------------------------------------------------------------------------
// 1. "Alfy is writing" in place (redesign §4.2 item 4): shown only while the
//    target block is known synchronously — the composer-driven Ask-Alfy
//    reply (`DocumentBody.svelte`'s `maybeAskAlfy`), never the T8-live
//    chat-tool-call path, whose own `DocumentAlfyActivity.patches` is
//    deliberately empty while `status === "running"` (`alfy-activity.ts`'s
//    own doc comment: "there is nothing to mark until the call has
//    settled") — that path keeps the existing global `AlfyWriting.svelte`
//    banner, which needs no block id at all.
// ---------------------------------------------------------------------------

export interface AlfyWritingTarget {
	blockId: string;
	/** Already-localised (`artifacts.document.writing.tag`) — this module stays i18n-free, matching `card-view.ts`'s own convention. */
	tagLabel: string;
}

export const alfyWritingPluginKey = new PluginKey<AlfyWritingTarget | null>(
	"documentAlfyWritingBlock",
);

/** Exported for its own focused unit tests; `DocumentBody.svelte` never calls this directly. */
export function buildAlfyWritingDecorations(
	doc: PMNode,
	target: AlfyWritingTarget | null,
): DecorationSet {
	if (!target) return DecorationSet.empty;
	const range = findBlockNodeRange(doc, target.blockId);
	if (!range) return DecorationSet.empty;
	const decorations: Decoration[] = [
		// The gutter bar + dimmed content (DocumentBody.svelte's own
		// `.alfy-writing-block` styles) — a `Decoration.node`, so it survives
		// re-renders of the block's own inline content untouched.
		Decoration.node(range.nodeStart, range.nodeEnd, {
			class: "alfy-writing-block",
		}),
		// The inline tag at the end of the block's text (redesign: "an inline
		// tag ✦ Alfy is writing… at the end of the block") — a raw DOM widget,
		// exactly like `document-editor.ts`'s own change-bar predecessor: no
		// Svelte mount, just plain nodes, since this is non-interactive text.
		Decoration.widget(
			range.contentEnd,
			() => {
				const el = document.createElement("span");
				el.className = "alfy-writing-tag";
				el.setAttribute("aria-live", "polite");
				const icon = document.createElement("span");
				icon.className = "alfy-writing-tag-icon";
				icon.setAttribute("aria-hidden", "true");
				icon.textContent = "✦";
				el.append(icon, document.createTextNode(` ${target.tagLabel}`));
				return el;
			},
			{ side: 1 },
		),
	];
	return DecorationSet.create(doc, decorations);
}

const AlfyWritingBlock = Extension.create({
	name: "documentAlfyWritingBlock",
	addProseMirrorPlugins() {
		return [
			new Plugin<AlfyWritingTarget | null>({
				key: alfyWritingPluginKey,
				state: {
					init: () => null,
					apply(tr, value) {
						return tr.getMeta(alfyWritingPluginKey) ?? value;
					},
				},
				props: {
					decorations(state) {
						return buildAlfyWritingDecorations(
							state.doc,
							alfyWritingPluginKey.getState(state) ?? null,
						);
					},
				},
			}),
		];
	},
});

// ---------------------------------------------------------------------------
// 2. The selection's own "pending" highlight while the composer is open
//    (redesign §4.2 item 2: "the selection keeps a dashed amber 'pending'
//    highlight so you still see what you are asking about"; §4.3 states
//    table's "Composing" row). Same block-id + block-relative-character-
//    offset window a comment anchor resolves (`makeAnchor`'s `Anchor` in
//    `DocumentBody.svelte` is built from the identical
//    `readSelectionAnchorContext` shape) — the character-offset-to-position
//    walk is `extensions.ts`'s own `positionAtCharOffset`, duplicated here
//    rather than imported (this file's own header comment explains why).
// ---------------------------------------------------------------------------

export interface SelectionPendingTarget {
	blockId: string;
	from: number;
	to: number;
}

export const selectionPendingPluginKey =
	new PluginKey<SelectionPendingTarget | null>("documentSelectionPending");

/** Binary search over `doc.textBetween(blockStart, p, "\n")`'s length — see `extensions.ts`'s `positionAtCharOffset` for the full rationale (the same separator, the same convergence argument). */
function positionAtCharOffset(
	doc: PMNode,
	blockStart: number,
	blockEnd: number,
	target: number,
): number {
	let lo = blockStart;
	let hi = blockEnd;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		const length = doc.textBetween(blockStart, mid, "\n").length;
		if (length < target) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

export function buildSelectionPendingDecorations(
	doc: PMNode,
	target: SelectionPendingTarget | null,
): DecorationSet {
	if (!target) return DecorationSet.empty;
	const blockRange = findBlockNodeRange(doc, target.blockId);
	if (!blockRange) return DecorationSet.empty;
	const contentStart = blockRange.nodeStart + 1;
	const from = positionAtCharOffset(
		doc,
		contentStart,
		blockRange.contentEnd,
		target.from,
	);
	const to = positionAtCharOffset(
		doc,
		contentStart,
		blockRange.contentEnd,
		target.to,
	);
	if (from >= to) return DecorationSet.empty;
	return DecorationSet.create(doc, [
		Decoration.inline(from, to, { class: "selection-pending" }),
	]);
}

const SelectionPending = Extension.create({
	name: "documentSelectionPending",
	addProseMirrorPlugins() {
		return [
			new Plugin<SelectionPendingTarget | null>({
				key: selectionPendingPluginKey,
				state: {
					init: () => null,
					apply(tr, value) {
						return tr.getMeta(selectionPendingPluginKey) ?? value;
					},
				},
				props: {
					decorations(state) {
						return buildSelectionPendingDecorations(
							state.doc,
							selectionPendingPluginKey.getState(state) ?? null,
						);
					},
				},
			}),
		];
	},
});

// ---------------------------------------------------------------------------
// 3. The refused line's dashed amber rule (redesign §4.2 "Refusal": "the
//    refused line... gets a dashed amber rule in the gutter"; §9.2's own
//    "refused-line rule" row). Several blocks at once — a partial refusal
//    can leave more than one line untouched.
// ---------------------------------------------------------------------------

export interface RefusedLinesTarget {
	blockIds: string[];
}

export const refusedLinesPluginKey = new PluginKey<RefusedLinesTarget | null>(
	"documentRefusedLines",
);

export function buildRefusedLineDecorations(
	doc: PMNode,
	target: RefusedLinesTarget | null,
): DecorationSet {
	if (!target || target.blockIds.length === 0) return DecorationSet.empty;
	const decorations: Decoration[] = [];
	for (const blockId of target.blockIds) {
		const range = findBlockNodeRange(doc, blockId);
		if (!range) continue;
		decorations.push(
			Decoration.node(range.nodeStart, range.nodeEnd, {
				class: "alfy-refused-line",
			}),
		);
	}
	return DecorationSet.create(doc, decorations);
}

const RefusedLines = Extension.create({
	name: "documentRefusedLines",
	addProseMirrorPlugins() {
		return [
			new Plugin<RefusedLinesTarget | null>({
				key: refusedLinesPluginKey,
				state: {
					init: () => null,
					apply(tr, value) {
						return tr.getMeta(refusedLinesPluginKey) ?? value;
					},
				},
				props: {
					decorations(state) {
						return buildRefusedLineDecorations(
							state.doc,
							refusedLinesPluginKey.getState(state) ?? null,
						);
					},
				},
			}),
		];
	},
});

/** `extensions.ts`'s own "small change": spread this into `buildDocumentExtensions`'s returned list. */
export const alfyWritingChainExtensions = [
	AlfyWritingBlock,
	SelectionPending,
	RefusedLines,
];
