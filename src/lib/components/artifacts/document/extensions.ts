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
import { Extension, Node } from "@tiptap/core";
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
import {
	type BlockKind,
	MARKER_PREFIX,
	mintBlockId,
} from "$lib/shared/artifact-document/blocks";

export const BLOCK_ID_ATTR = "blockId";
export const BLOCK_MARKER_NODE = "blockMarker";

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
function buildBlockIdTransaction(
	state: EditorState,
): Transaction | null {
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

/**
 * The Document's full extension list. `TaskList`/`TaskItem` come from
 * `@tiptap/extension-list` and `TableKit` from `@tiptap/extension-table` —
 * confirmed present in the installed 3.31.3 packages before use, per
 * AGENTS.md's mandatory docs check (no Context7/Svelte MCP tool in this
 * session; the installed `.d.ts` is the version-exact fallback).
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
	];
}
