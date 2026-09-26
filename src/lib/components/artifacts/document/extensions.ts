/**
 * The Document's Tiptap extension list (Feature 2 · Artifacts, Slice 1, T7).
 *
 * This file, and everything it imports, is reachable only from
 * `document-editor.ts`'s dynamic `import()` — never from the panel shell, the
 * toolbar host, the margin, the chips module or `artifact-bodies.ts`, which
 * must stay free of `@tiptap/*` so a chat page that never opens a Document
 * never pays for it (T7.8's source-scan test enforces this).
 *
 * Two custom pieces keep the id markers alive through the round trip:
 *
 * - `BlockIds` gives every addressable node type a `blockId` attribute and an
 *   `appendTransaction` plugin that fills in any that are missing after an
 *   edit (a split paragraph, a pasted heading), dispatched with
 *   `addToHistory: false` so bookkeeping never appears in the user's own undo
 *   stack.
 * - `BlockMarker` is the `<!--b:id-->` marker as a real (but invisible) node,
 *   so Tiptap's own Markdown tokenizer/renderer can produce and consume it.
 *   It is never left in the LIVE document: `absorbBlockMarkers` (on load)
 *   moves each marker's id onto the block that follows it and deletes the
 *   marker node itself, and `document-editor.ts`'s `readMarkdown` re-inserts
 *   markers in a throwaway transaction only for the instant it takes to call
 *   `editor.getMarkdown()`, then reverts it — verified empirically against
 *   this exact installed version (3.31.3): `editor.getMarkdown()` takes no
 *   arguments and serialises `editor.state.doc`, so there is no way to hand
 *   it an already-marked JSON blob instead.
 *
 * Ids are minted through `$lib/shared/artifact-document/blocks`'s
 * `mintBlockId`, not a second generator, so the browser and the server share
 * one id format and one collision-free sequence rule.
 */

import type {
	JSONContent,
	MarkdownParseHelpers,
	MarkdownToken,
} from "@tiptap/core";
import { createInlineMarkdownSpec, Extension, Node } from "@tiptap/core";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extension-placeholder";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "@tiptap/markdown";
import type { Node as PMNode } from "@tiptap/pm/model";
import {
	type EditorState,
	Plugin,
	PluginKey,
	type Transaction,
} from "@tiptap/pm/state";
import { StarterKit } from "@tiptap/starter-kit";
import { get } from "svelte/store";
import {
	type BlockKind,
	MARKER_PREFIX,
	mintBlockId,
} from "$lib/shared/artifact-document/blocks";
import { uiLanguage } from "$lib/stores/settings";
import { BLOCK_ID_ATTR, BLOCK_MARKER_NODE } from "./block-attrs";
import { chipLabel, chipValues } from "./chips";
import { AlfyChange } from "./marks";

// Re-exported for every existing caller (`document-editor.ts`,
// `document-editor.test.ts`) that already imports these two from this file —
// `block-attrs.ts` only exists to break the cycle `marks.ts` would otherwise
// have with this module (see its header comment); it is not a second source
// of truth.
export { BLOCK_ID_ATTR, BLOCK_MARKER_NODE };

/**
 * Tiptap's node type name → the shared `BlockKind`, so a minted id carries the
 * same kind-prefix scheme `blocks.ts` uses server-side. `taskList` maps to
 * `taskList` on purpose: the canonical stored form puts a blank line between
 * every task item (each is its own block, per `blocks.ts`'s
 * `LIST_ITEM_START_RE` comment), and a blank line between two `- [ ]` lines
 * is exactly what makes Tiptap's own markdown parser split them into two
 * separate `taskList` nodes of one item each — verified empirically, not
 * assumed. So one `taskList` node here is always one task item there, and a
 * single `blockId` per node is enough; no per-`taskItem` id is needed.
 */
const NODE_TYPE_TO_BLOCK_KIND: Record<string, BlockKind> = {
	paragraph: "paragraph",
	heading: "heading",
	blockquote: "blockquote",
	codeBlock: "code",
	bulletList: "list",
	orderedList: "list",
	taskList: "taskList",
	table: "table",
	horizontalRule: "hr",
};

/** Every top-level node type the Document addresses as a block. */
const BLOCK_ID_TYPES = Object.keys(NODE_TYPE_TO_BLOCK_KIND);

function blockKindFor(typeName: string): BlockKind | null {
	return NODE_TYPE_TO_BLOCK_KIND[typeName] ?? null;
}

/**
 * Exported so `document-editor.ts`'s `readMarkdown` can tag its own
 * throwaway marker-insertion transaction with `setMeta(blockIdPluginKey,
 * SKIP)`: without it, dispatching that insertion is itself a doc-changing
 * transaction, which re-triggers THIS plugin's `appendTransaction` — which
 * would see the marker `readMarkdown` just inserted for OUTPUT purposes, find
 * the block after it already identified (nothing to absorb), and delete the
 * marker anyway as part of its normal cleanup, before `readMarkdown` ever
 * gets to call `editor.getMarkdown()`. The output-only marker never survives
 * long enough to be serialised. The skip flag is what tells this plugin
 * "this transaction is not a load/paste; leave it alone."
 */
export const blockIdPluginKey = new PluginKey("documentBlockIds");
export const SKIP_BLOCK_ID_PLUGIN = "skip";

function isIdentified(node: PMNode): boolean {
	return (
		typeof node.attrs?.[BLOCK_ID_ATTR] === "string" &&
		node.attrs[BLOCK_ID_ATTR].length > 0
	);
}

/**
 * Absorption and minting, as ONE transaction builder — not two separate
 * passes. This is not a style choice: ProseMirror's `appendTransaction` fires
 * synchronously for every doc-changing transaction the editor dispatches,
 * INCLUDING `setContent`'s own — so a later call's `setContent` (Undo, a
 * fresh patch result, `loadMarkdown`) races the plugin's own auto-mint
 * against an explicit `absorb-then-mint` pair of calls made after
 * `setContent` returns. Splitting the two steps let the plugin mint an id for
 * a still-marker-only block BEFORE the caller's explicit absorption step got
 * to claim it — the marker's own id was silently discarded, and the block got
 * a random one instead. Doing both in one transaction, from one place both
 * the plugin and `ensureBlockIds` call, makes that race impossible: whichever
 * caller runs first does the complete, correct sequence, and a second caller
 * finds nothing left to do.
 */
function buildAbsorbAndMintTransaction(state: EditorState): Transaction | null {
	const assignments: { pos: number; id: string }[] = [];
	const markersToDelete: { pos: number; size: number }[] = [];
	let pending: string | null = null;

	state.doc.forEach((node, offset) => {
		if (node.type.name === BLOCK_MARKER_NODE) {
			markersToDelete.push({ pos: offset, size: node.nodeSize });
			pending = (node.attrs.id as string) || pending;
			return;
		}
		if (
			pending &&
			BLOCK_ID_TYPES.includes(node.type.name) &&
			!isIdentified(node)
		) {
			assignments.push({ pos: offset, id: pending });
		}
		pending = null;
	});

	let tr: Transaction | null = null;
	if (markersToDelete.length > 0) {
		tr = state.tr;
		for (const entry of assignments) {
			const node = tr.doc.nodeAt(entry.pos);
			if (!node) continue;
			tr.setNodeMarkup(entry.pos, undefined, {
				...node.attrs,
				[BLOCK_ID_ATTR]: entry.id,
			});
		}
		// Delete last-to-first so earlier positions stay valid as later ones are removed.
		for (const marker of [...markersToDelete].sort((a, b) => b.pos - a.pos)) {
			const node = tr.doc.nodeAt(marker.pos);
			if (node?.type.name === BLOCK_MARKER_NODE)
				tr.delete(marker.pos, marker.pos + node.nodeSize);
		}
	}

	// Mint whatever is STILL missing after absorption — reading `tr.doc` when
	// absorption ran, so a block that just received an absorbed id is not
	// re-minted a second one.
	const docForMinting = tr ? tr.doc : state.doc;
	const missing: { pos: number; kind: BlockKind }[] = [];
	docForMinting.forEach((node, offset) => {
		const id = node.attrs?.[BLOCK_ID_ATTR];
		if (typeof id === "string" && id.length > 0) return;
		const kind = blockKindFor(node.type.name);
		if (kind) missing.push({ pos: offset, kind });
	});
	if (missing.length > 0) {
		tr = tr ?? state.tr;
		for (const entry of missing) {
			const node = tr.doc.nodeAt(entry.pos);
			if (!node) continue;
			tr.setNodeMarkup(entry.pos, undefined, {
				...node.attrs,
				[BLOCK_ID_ATTR]: mintBlockId(entry.kind),
			});
		}
	}

	return tr;
}

/**
 * The mint-only half, kept internal: `ensureBlockIds`/the plugin both go
 * through the combined builder above so absorption and minting can never
 * race each other. Not exported — nothing outside this file addresses
 * minting in isolation from absorption today; widen this back to `export`
 * if a future test genuinely needs that split.
 */
function buildBlockIdTransaction(state: EditorState): Transaction | null {
	const missing: { pos: number; kind: BlockKind }[] = [];
	state.doc.forEach((node, offset) => {
		const id = node.attrs?.[BLOCK_ID_ATTR];
		if (typeof id === "string" && id.length > 0) return;
		const kind = blockKindFor(node.type.name);
		if (kind) missing.push({ pos: offset, kind });
	});
	if (missing.length === 0) return null;

	const tr = state.tr;
	for (const entry of missing) {
		const node = tr.doc.nodeAt(entry.pos);
		if (!node) continue;
		tr.setNodeMarkup(entry.pos, undefined, {
			...node.attrs,
			[BLOCK_ID_ATTR]: mintBlockId(entry.kind),
		});
	}
	return tr;
}

/** Every top-level block carries a stable `blockId`, filled in after every change (typing, pasting, or a whole-content replace). */
const BlockIds = Extension.create({
	name: "documentBlockIds",

	addGlobalAttributes() {
		return [
			{
				types: BLOCK_ID_TYPES,
				attributes: {
					[BLOCK_ID_ATTR]: {
						default: null,
						parseHTML: (element: HTMLElement) =>
							element.getAttribute("data-block-id"),
						renderHTML: (attributes: Record<string, unknown>) =>
							attributes[BLOCK_ID_ATTR]
								? { "data-block-id": attributes[BLOCK_ID_ATTR] }
								: {},
					},
				},
			},
		];
	},

	addProseMirrorPlugins() {
		return [
			new Plugin({
				key: blockIdPluginKey,
				appendTransaction: (transactions, _oldState, newState) => {
					if (
						transactions.some(
							(tr) => tr.getMeta(blockIdPluginKey) === SKIP_BLOCK_ID_PLUGIN,
						)
					) {
						return null;
					}
					if (!transactions.some((tr) => tr.docChanged)) return null;
					const tr = buildAbsorbAndMintTransaction(newState);
					if (tr) tr.setMeta("addToHistory", false);
					return tr;
				},
			}),
		];
	},
});

/**
 * The persisted marker itself: a block-level atom whose Markdown tokenizer
 * parses `<!--b:id-->` and whose renderer writes it back. It is a real schema
 * node (not a text hack) so the Markdown manager can produce and consume it,
 * but nothing in this module ever leaves one sitting in the live document —
 * see `absorbBlockMarkers` below and `document-editor.ts`'s `readMarkdown`.
 */
const BlockMarker = Node.create({
	name: BLOCK_MARKER_NODE,

	group: "block",
	atom: true,
	selectable: false,
	draggable: false,

	addAttributes() {
		return {
			id: {
				default: "",
				parseHTML: (element: HTMLElement) =>
					element.getAttribute("data-block-marker"),
			},
		};
	},

	parseHTML() {
		return [{ tag: "span[data-block-marker]" }];
	},

	renderHTML({ HTMLAttributes }: { HTMLAttributes: Record<string, unknown> }) {
		return [
			"span",
			{ "data-block-marker": HTMLAttributes.id, style: "display:none" },
		];
	},

	// Top level, not nested under `markdown:` — the markdown manager reads
	// these fields off the extension config itself. Nesting them would leave
	// the marker as literal text in the round trip (confirmed against this
	// installed version's `@tiptap/core` NodeConfig, which declares
	// `markdownTokenizer`/`parseMarkdown`/`renderMarkdown` at the top level).
	markdownTokenizer: {
		name: BLOCK_MARKER_NODE,
		level: "block" as const,
		start(src: string) {
			const match = new RegExp(`^${MARKER_PREFIX}[A-Za-z0-9_.-]+-->`, "m").exec(
				src,
			);
			return match?.index ?? -1;
		},
		tokenize(src: string) {
			const match = new RegExp(`^${MARKER_PREFIX}([A-Za-z0-9_.-]+)-->`).exec(
				src,
			);
			if (!match) return undefined;
			const line = new RegExp(
				`^${MARKER_PREFIX}[A-Za-z0-9_.-]+-->[ \\t]*(?:\\n|$)`,
			).exec(src);
			if (!line) return undefined;
			return {
				type: BLOCK_MARKER_NODE,
				raw: line[0],
				attributes: { id: match[1] },
			};
		},
	},

	parseMarkdown: (token: MarkdownToken, h: MarkdownParseHelpers) =>
		h.createNode(BLOCK_MARKER_NODE, {
			id: (token as { attributes?: { id?: string } }).attributes?.id ?? "",
		}),

	renderMarkdown: (node: JSONContent) =>
		`${MARKER_PREFIX}${(node.attrs?.id as string) ?? ""}-->`,
});

/**
 * Load-time absorption on its own, kept internal (nothing outside this file
 * calls it directly today — `ensureBlockIds` below is the one load-time
 * entry point other modules use). Internally this is still the SAME
 * combined builder `ensureBlockIds` and the plugin use — see
 * `buildAbsorbAndMintTransaction`'s comment for why the two steps cannot be
 * split into independently-dispatched transactions.
 */
function absorbBlockMarkers(editor: {
	state: EditorState;
	view: { dispatch: (tr: Transaction) => void };
}): number {
	let markerCount = 0;
	editor.state.doc.forEach((node) => {
		if (node.type.name === BLOCK_MARKER_NODE) markerCount += 1;
	});
	const tr = buildAbsorbAndMintTransaction(editor.state);
	if (tr) {
		tr.setMeta("addToHistory", false);
		editor.view.dispatch(tr);
	}
	return markerCount;
}

/**
 * Load-time id pass: absorb any hand-written markers and mint whatever is
 * still missing, as one transaction (never two — see
 * `buildAbsorbAndMintTransaction`). Dispatches with `addToHistory: false`, so
 * opening a document never gives the user a first Undo step that does
 * nothing visible. A no-op (already fully identified) dispatches nothing.
 */
export function ensureBlockIds(editor: {
	state: EditorState;
	view: { dispatch: (tr: Transaction) => void };
}): void {
	const tr = buildAbsorbAndMintTransaction(editor.state);
	if (!tr) return;
	tr.setMeta("addToHistory", false);
	editor.view.dispatch(tr);
}

export const TRACKER_CHIP_NODE = "trackerChip";
// Not exported: only this file reads a chip's "kind" attribute by name today
// (`CHIP_VALUE_ATTR`, just below, IS imported by `extensions.test.ts`, which
// is why it stays exported).
const CHIP_KIND_ATTR = "kind";
export const CHIP_VALUE_ATTR = "value";

/**
 * The tracker chip (T9): an inline atom that serialises as
 * `[chip kind="status" value="Booked"]` — a self-closing shortcode, built on
 * `@tiptap/core`'s own `createInlineMarkdownSpec` helper rather than a
 * hand-rolled tokenizer (the same helper the installed 3.31.3's own
 * `mention`/`emoji` examples use for this exact `[name attrs]` shape). Its
 * three markdown fields (`parseMarkdown`/`markdownTokenizer`/`renderMarkdown`)
 * are spread at the TOP level of the node config, matching `BlockMarker`
 * above — nesting them under a `markdown:` key was verified empirically
 * (`BlockMarker`'s own comment) to leave a node's markdown as literal text in
 * this installed version, so this node follows the same, already-proven
 * shape rather than the alternative the upstream doc comment shows.
 *
 * `chipLabel`/`chipValues` (`chips.ts`) own the canonical-value → localized-
 * label mapping; this node calls `chipLabel` with the CURRENT UI language
 * read via `get(uiLanguage)` (a plain store read, not a Svelte subscription —
 * `renderHTML` runs outside any component) because the value shown here must
 * follow the same rule as everywhere else: the stored `value` attribute is
 * always the canonical English token, and only the rendered label changes
 * with the locale (Review Focus 8).
 */
const TrackerChip = Node.create({
	name: TRACKER_CHIP_NODE,
	group: "inline",
	inline: true,
	atom: true,

	addAttributes() {
		return {
			[CHIP_KIND_ATTR]: { default: "status" },
			[CHIP_VALUE_ATTR]: { default: "" },
		};
	},

	parseHTML() {
		return [{ tag: `span[data-chip-kind]` }];
	},

	renderHTML({ HTMLAttributes }: { HTMLAttributes: Record<string, unknown> }) {
		const kind = (HTMLAttributes[CHIP_KIND_ATTR] as string) ?? "status";
		const value = (HTMLAttributes[CHIP_VALUE_ATTR] as string) ?? "";
		const locale = get(uiLanguage) === "hu" ? "hu" : "en";
		return [
			"span",
			{
				"data-chip-kind": kind,
				"data-chip-value": value,
				class: "tracker-chip",
			},
			chipLabel(kind === "date" ? "date" : "status", value, locale),
		];
	},

	/**
	 * The editable half of "the UI shows a localized label and edits the
	 * token" — a status chip is a real `<select>` (a listbox, matching the UI
	 * states table's "the chip dropdown is a listbox driven by arrow keys");
	 * a date chip has no fixed vocabulary (`chipValues("date")` is `[]`) and
	 * is shown as plain (for now non-editable) text. Choosing an option
	 * dispatches `setNodeMarkup` with the OPTION'S OWN VALUE — `chipValues`'
	 * canonical English tokens, never the localized text the option displays
	 * — so the stored attribute (and therefore the serialised
	 * `[chip value="…"]`) never changes with the locale (Review Focus 8;
	 * T9.5's own assertion).
	 */
	addNodeView() {
		return ({ node, getPos, editor: nodeEditor }) => {
			const dom = document.createElement("span");
			dom.className = "tracker-chip";
			dom.dataset.chipKind = node.attrs[CHIP_KIND_ATTR];
			dom.dataset.chipValue = node.attrs[CHIP_VALUE_ATTR];

			const locale = get(uiLanguage) === "hu" ? "hu" : "en";
			const kind = node.attrs[CHIP_KIND_ATTR] === "date" ? "date" : "status";
			const options = chipValues(kind);

			if (options.length > 0) {
				const select = document.createElement("select");
				select.className = "tracker-chip-select";
				select.setAttribute("aria-label", kind);
				for (const value of options) {
					const option = document.createElement("option");
					option.value = value;
					option.textContent = chipLabel(kind, value, locale);
					if (value === node.attrs[CHIP_VALUE_ATTR]) option.selected = true;
					select.appendChild(option);
				}
				// A mousedown inside the dropdown must not fall through to
				// ProseMirror's own selection handling, which would otherwise
				// steal focus from the listbox before the user can pick an option.
				select.addEventListener("mousedown", (event) =>
					event.stopPropagation(),
				);
				select.addEventListener("change", () => {
					if (typeof getPos !== "function") return;
					const pos = getPos();
					if (pos == null) return;
					nodeEditor.view.dispatch(
						nodeEditor.view.state.tr.setNodeMarkup(pos, undefined, {
							...node.attrs,
							[CHIP_VALUE_ATTR]: select.value,
						}),
					);
				});
				dom.appendChild(select);
			} else {
				dom.textContent = chipLabel(kind, node.attrs[CHIP_VALUE_ATTR], locale);
			}

			return { dom };
		};
	},

	...createInlineMarkdownSpec({
		nodeName: TRACKER_CHIP_NODE,
		name: "chip",
		selfClosing: true,
		allowedAttributes: [CHIP_KIND_ATTR, CHIP_VALUE_ATTR],
	}),
});

/**
 * The Document's full extension list. `TaskList`/`TaskItem` come from
 * `@tiptap/extension-list` and `TableKit` from `@tiptap/extension-table` —
 * confirmed present in the installed 3.31.3 packages before use, per
 * AGENTS.md's mandatory docs check (no Context7/Svelte MCP tool in this
 * session; the installed `.d.ts` is the version-exact fallback).
 *
 * `AlfyChange` (T8, `marks.ts`) and `TrackerChip` (T9, this file) are the two
 * Document-specific pieces added on top of the T7 baseline: the change mark
 * never round-trips to Markdown (it is a purely visual, in-session
 * annotation — see `marks.ts`'s header comment), and the chip node keeps
 * `[chip kind="…" value="…"]` alive through the round trip the same way
 * `BlockMarker` keeps `<!--b:id-->` alive.
 */
export function buildDocumentExtensions(placeholder: string) {
	return [
		StarterKit.configure({
			link: { openOnClick: false, autolink: false },
		}),
		TaskList,
		TaskItem.configure({ nested: true }),
		TableKit.configure({ table: { resizable: false } }),
		Placeholder.configure({ placeholder }),
		Markdown.configure({ indentation: { style: "space", size: 2 } }),
		BlockIds,
		BlockMarker,
		AlfyChange,
		TrackerChip,
	];
}
