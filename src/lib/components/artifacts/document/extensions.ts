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
 *   It is never left in the LIVE document: `ensureBlockIds` (on load)
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
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { StarterKit } from "@tiptap/starter-kit";
import { get } from "svelte/store";
import type { DocumentTab } from "$lib/server/services/artifacts/serialize/document";
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
	let tr: Transaction | null = null;

	// RV-1B: a markdown construct this schema has no node for (this Document
	// registers no Image extension, so a lone `![alt](url)` line is the
	// reproduction) can leave `@tiptap/markdown`'s fallback parsing with a
	// bare inline node sitting directly under "doc" once it runs out of
	// block-level structure for the unrecognised token. "doc"'s content
	// expression is block-only, so the parse itself does not throw, but the
	// very next transaction crashes with "Invalid content for node doc" —
	// confirmed by instrumenting the exact call below, which is why this
	// runs FIRST, before absorption/minting ever inspects the document.
	// Wrapping the orphan in its own paragraph makes unrecognised markdown
	// degrade to plain, visible text instead of crashing the editor.
	const paragraphType = state.schema.nodes.paragraph;
	const docContentMatch = state.schema.nodes.doc.contentMatch;
	if (paragraphType) {
		const orphans: { pos: number; size: number }[] = [];
		let scanOffset = 0;
		state.doc.forEach((node) => {
			if (!docContentMatch.matchType(node.type)) {
				orphans.push({ pos: scanOffset, size: node.nodeSize });
			}
			scanOffset += node.nodeSize;
		});
		if (orphans.length > 0) {
			tr = state.tr;
			for (const orphan of orphans) {
				const from = tr.mapping.map(orphan.pos);
				const to = tr.mapping.map(orphan.pos + orphan.size);
				const node = tr.doc.nodeAt(from);
				if (!node) continue;
				tr.replaceWith(from, to, paragraphType.create(null, node));
			}
		}
	}

	const docForAbsorption = tr ? tr.doc : state.doc;
	const assignments: { pos: number; id: string }[] = [];
	const markersToDelete: { pos: number; size: number }[] = [];
	let pending: string | null = null;

	docForAbsorption.forEach((node, offset) => {
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

	if (markersToDelete.length > 0) {
		tr = tr ?? state.tr;
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
	// re-minted a second one. A DUPLICATE id counts as missing: splitting a
	// block (Enter) or pasting one copies its id onto the new node, and while
	// the editor held both, every save's canonicalisation minted a different
	// id for the second half — its id changed on every autosave, so Alfy's
	// next patch on it found no such block (RV-1A). The first holder keeps it.
	const docForMinting = tr ? tr.doc : state.doc;
	const missing: { pos: number; kind: BlockKind }[] = [];
	const seenIds = new Set<string>();
	docForMinting.forEach((node, offset) => {
		const id = node.attrs?.[BLOCK_ID_ATTR];
		if (typeof id === "string" && id.length > 0 && !seenIds.has(id)) {
			seenIds.add(id);
			return;
		}
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
 * see `ensureBlockIds` below and `document-editor.ts`'s `readMarkdown`.
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
 * Load-time id pass: absorb any hand-written markers and mint whatever is
 * still missing, as one transaction (never two — see
 * `buildAbsorbAndMintTransaction`). Dispatches with `addToHistory: false`, so
 * opening a document never gives the user a first Undo step that does
 * nothing visible, and `preventUpdate: true` (Tiptap's own `Editor.
 * dispatchTransaction` checks this exact meta key before emitting `update`),
 * because absorbing/minting ids is bookkeeping, never a user edit — without
 * it, this dispatch fires `DocumentBody.svelte`'s `onUpdate` (`handleUpdate`),
 * which calls `readMarkdown`, whose OWN throwaway marker transactions would
 * then re-enter `onUpdate` again, recursing until the call stack overflows
 * (the T7 crash T8/T9/T11's e2e suite found; see `readMarkdown`'s matching
 * comment). A no-op (already fully identified) dispatches nothing.
 */
export function ensureBlockIds(editor: {
	state: EditorState;
	view: { dispatch: (tr: Transaction) => void };
}): void {
	const tr = buildAbsorbAndMintTransaction(editor.state);
	if (!tr) return;
	tr.setMeta("addToHistory", false);
	tr.setMeta("preventUpdate", true);
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
/**
 * RV-1B: this Document registers no Image node (`@tiptap/extension-image`
 * is not one of the pinned dependencies — slice-1.md's own extension list
 * never named it, and a Document export explicitly has no image source
 * either). Alfy can still write `![alt](url)` into a document body — a
 * completely ordinary thing to type — and without a handler,
 * `@tiptap/markdown`'s fallback parsing for an unrecognised inline token
 * left a bare inline node with only the alt text sitting directly under
 * "doc", which crashed the very next transaction (confirmed by
 * instrumenting `buildAbsorbAndMintTransaction`'s own crash site: `Invalid
 * content for node doc`). `buildAbsorbAndMintTransaction`'s orphan-wrapping
 * pass is the general safety net that keeps THIS (or any similar future
 * case) from crashing even without this handler — verified directly: with
 * this handler removed, `![alt](url)` still does not crash, because the
 * generic wrap catches marked's own bare-alt-text fallback the same way.
 * This handler earns its place for the OTHER case, `![](url)` (no alt
 * text): without it, the generic wrap has nothing to wrap and the image
 * silently becomes a blank paragraph with no visible trace it was ever
 * there; this handler gives it a visible placeholder instead.
 *
 * Deliberately renders the alt text ALONE, not `![alt](url)`: reconstructing
 * the full reference puts a bare `https://…` back into the text, and this
 * app's markdown pipeline auto-links a bare URL on the very next parse
 * regardless of `Link`'s own `autolink: false` (confirmed separately, with
 * plain text containing nothing image-related — a pre-existing behaviour of
 * this editor, not something this fix should paper over by guessing at a
 * second, untested escaping scheme). Losing the URL is an accepted,
 * narrower trade-off than an unstable canonical form (ruling 12: open →
 * serialise → reload → serialise must be a no-op).
 */
const ImageAsPlainText = Extension.create({
	name: "documentImageAsText",
	markdownTokenName: "image",
	parseMarkdown: (token: { text?: string }) => ({
		type: "text",
		text: token.text?.trim() ? token.text : "[image]",
	}),
});

/**
 * Redesign §5.2 "Tabs switch sections", Wave 2.5 Step 5. The plugin's own
 * state is `{ tabs, activeTabId }`, updated ONLY via `setMeta` (never
 * derived from the document itself) — `document-editor.ts`'s
 * `setActiveDocumentTab` is the one place that dispatches it, mirroring how
 * `blockIdPluginKey`'s skip flag works above. `Tabs.svelte`'s own
 * `onActivate` stays a pure UI notification (T9.1): it never touches the
 * editor, so THIS is what turns "the user clicked a tab" into "the editor
 * hides the other sections."
 */
export const tabSectionPluginKey = new PluginKey<TabSectionPluginState>(
	"documentTabSections",
);

/** Not exported: only `tabSectionPluginKey`'s own `PluginKey<T>` and the plugin below need this shape. */
interface TabSectionPluginState {
	tabs: DocumentTab[];
	activeTabId: string;
}

const EMPTY_TAB_SECTION_STATE: TabSectionPluginState = {
	tabs: [],
	activeTabId: "",
};

/**
 * One node decoration per top-level block OUTSIDE the active tab's range —
 * never a decoration spanning multiple blocks, since `Decoration.node` only
 * covers exactly one node's bounds. A block belongs to whichever tab's
 * `startBlockId` most recently appeared at or before it, in document order;
 * anything before the first recognised start marker (or every block, when a
 * stale `startBlockId` names a block that's gone — `DocumentTab`'s own
 * contract: "re-pointed on read if the block it once named is gone") falls
 * back to the document's first tab, exactly like a document with no
 * recognised markers at all would.
 *
 * `display:none` hides the block from the RENDERED DOM only: the doc itself
 * — block ids, marks, comment anchors, patch targets — is completely
 * untouched, so search, export, the card preview and Alfy's reads (which all
 * work from the markdown/doc, never from what is currently painted) still
 * see the whole document (ruling 61's third point).
 *
 * `tabs.length <= 1` (including the empty registry the panel falls back to
 * before any tabs exist) hides nothing — there is only one section, so
 * nothing is "outside" it.
 */
export function buildTabSectionDecorations(
	doc: PMNode,
	tabs: DocumentTab[],
	activeTabId: string,
): DecorationSet {
	if (tabs.length <= 1) return DecorationSet.empty;
	const startBlockIdToTabId = new Map(
		tabs.map((tab) => [tab.startBlockId, tab.id] as const),
	);
	const decorations: Decoration[] = [];
	let currentTabId = tabs[0]?.id ?? activeTabId;
	let activeTabOwnsABlock = false;
	doc.forEach((node, offset) => {
		const blockId = node.attrs?.[BLOCK_ID_ATTR];
		const owningTabId =
			typeof blockId === "string"
				? startBlockIdToTabId.get(blockId)
				: undefined;
		if (owningTabId !== undefined) currentTabId = owningTabId;
		if (currentTabId === activeTabId) activeTabOwnsABlock = true;
		if (currentTabId !== activeTabId) {
			decorations.push(
				Decoration.node(offset, offset + node.nodeSize, {
					style: "display:none",
				}),
			);
		}
	});
	// A brand-new tab (`Tabs.svelte`'s `addTab`) is activated immediately but
	// starts with no block of its own to anchor to — every existing block's
	// `startBlockId` still resolves to some OTHER, real tab, so the walk above
	// would otherwise hide the entire document the moment it is created,
	// leaving nothing visible and nowhere to type. Showing everything (no
	// decorations) is the safe fallback for that edge case: it is never worse
	// than hiding the whole document, and it self-corrects the moment the new
	// tab's own `startBlockId` is set to a real block.
	if (!activeTabOwnsABlock) return DecorationSet.empty;
	return DecorationSet.create(doc, decorations);
}

const TabSections = Extension.create({
	name: "documentTabSections",

	addProseMirrorPlugins() {
		return [
			new Plugin<TabSectionPluginState>({
				key: tabSectionPluginKey,
				state: {
					init: () => EMPTY_TAB_SECTION_STATE,
					apply(tr, value) {
						return tr.getMeta(tabSectionPluginKey) ?? value;
					},
				},
				props: {
					decorations(state) {
						const pluginState =
							tabSectionPluginKey.getState(state) ?? EMPTY_TAB_SECTION_STATE;
						return buildTabSectionDecorations(
							state.doc,
							pluginState.tabs,
							pluginState.activeTabId,
						);
					},
				},
			}),
		];
	},
});

/**
 * Two-way linking between a comment thread and its anchored words (redesign
 * §3.2/§9.2, Wave 2.5 Step 7): a resting `.comment-anchor` mark
 * (`DocumentBody.svelte`'s own styles — Step 2.3, unwired until this),
 * `.is-active` while its thread is linked (hover/focus on the card, or the
 * words themselves were clicked/focused), `.is-resolved` once its thread is
 * resolved. Plugin state only, exactly like `tabSectionPluginKey` above:
 * `document-editor.ts`'s `setCommentAnchors` is the one place that
 * dispatches it, driven by whatever `MarginPanel.svelte` already resolved
 * (`resolveTextAnchor` against `blocks`) — this file never re-derives anchor
 * resolution itself, only turns an already-resolved (blockId, from, to)
 * window into a live decoration.
 */
export const commentAnchorPluginKey = new PluginKey<CommentAnchorPluginState>(
	"documentCommentAnchors",
);

/**
 * One already-resolved comment thread's anchor. Deliberately the SAME shape
 * `MarginPanel.svelte` builds locally under its own name — that component
 * must stay free of `@tiptap/*` (its own header comment), so it cannot
 * import this type; duplicating a five-field shape is cheaper than crossing
 * that boundary.
 */
export interface CommentAnchorTarget {
	commentId: string;
	blockId: string;
	/** Character offsets into that block's OWN visible text (`blockVisibleText`'s contract) — never a ProseMirror position; see `commentAnchorDocRange` below for why. */
	from: number;
	to: number;
	resolved: boolean;
}

interface CommentAnchorPluginState {
	anchors: CommentAnchorTarget[];
	activeCommentId: string | null;
}

const EMPTY_COMMENT_ANCHOR_STATE: CommentAnchorPluginState = {
	anchors: [],
	activeCommentId: null,
};

/**
 * Maps a block-relative character offset (`blockVisibleText`'s own contract
 * — `resolveTextAnchor`'s `from`/`to`) onto the LIVE document's ProseMirror
 * position, by binary search over `doc.textBetween(blockStart, p, "\n")`'s
 * length. `blockVisibleText`'s own doc comment guarantees "'\n' between the
 * text blocks inside it... exactly where the editor puts one", so this reuses
 * the SAME separator `readSelectionAnchorContext` already captures anchors
 * with, rather than a second, hand-rolled Markdown-stripping walk that could
 * silently drift from it. `textBetween`'s length only grows as `p` grows, so
 * the search always converges on the first position whose accumulated text
 * reaches `target` — exactly at a real character boundary, since a text
 * anchor's own `from`/`to` are always real character offsets, never inside a
 * non-text atom.
 */
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

/** The live doc's own top-level block node matching `blockId`, and its content bounds — `null` when that block is not (or not currently) in the doc. */
function findBlockContentRange(
	doc: PMNode,
	blockId: string,
): { start: number; end: number } | null {
	let result: { start: number; end: number } | null = null;
	doc.forEach((node, offset) => {
		if (result !== null) return;
		if (node.attrs?.[BLOCK_ID_ATTR] !== blockId) return;
		result = { start: offset + 1, end: offset + node.nodeSize - 1 };
	});
	return result;
}

/**
 * The live doc range for one already-resolved comment anchor, or `null` when
 * its block is not currently in the doc. Exported for `document-editor.ts`'s
 * own scroll-to-anchor helper — the ONE other place that needs this mapping,
 * so it is never re-derived a second way.
 */
export function commentAnchorDocRange(
	doc: PMNode,
	blockId: string,
	from: number,
	to: number,
): { from: number; to: number } | null {
	const range = findBlockContentRange(doc, blockId);
	if (!range) return null;
	return {
		from: positionAtCharOffset(doc, range.start, range.end, from),
		to: positionAtCharOffset(doc, range.start, range.end, to),
	};
}

/**
 * One decoration per resolved, non-orphaned comment anchor. Interactive
 * (focusable, clickable) only while its thread is OPEN: a resolved thread's
 * highlight goes back to reading as plain text (redesign §3.4's own a11y
 * note — "highlights are focusable only while their thread is open"), which
 * also matches the rail's own Open-by-default filter (ruling 61): a
 * resolved anchor with nothing reachable to jump to by default should not be
 * a live tab stop either.
 */
export function buildCommentAnchorDecorations(
	doc: PMNode,
	anchors: CommentAnchorTarget[],
	activeCommentId: string | null,
): DecorationSet {
	if (anchors.length === 0) return DecorationSet.empty;
	const decorations: Decoration[] = [];
	for (const anchor of anchors) {
		const range = commentAnchorDocRange(
			doc,
			anchor.blockId,
			anchor.from,
			anchor.to,
		);
		if (!range || range.from >= range.to) continue;
		const classes = ["comment-anchor"];
		if (anchor.commentId === activeCommentId) classes.push("is-active");
		if (anchor.resolved) classes.push("is-resolved");
		const attrs: Record<string, string> = {
			class: classes.join(" "),
			"data-comment-anchor-id": anchor.commentId,
		};
		if (!anchor.resolved) {
			attrs.tabindex = "0";
			attrs.role = "button";
		}
		decorations.push(Decoration.inline(range.from, range.to, attrs));
	}
	return DecorationSet.create(doc, decorations);
}

const CommentAnchors = Extension.create({
	name: "documentCommentAnchors",

	addProseMirrorPlugins() {
		return [
			new Plugin<CommentAnchorPluginState>({
				key: commentAnchorPluginKey,
				state: {
					init: () => EMPTY_COMMENT_ANCHOR_STATE,
					apply(tr, value) {
						return tr.getMeta(commentAnchorPluginKey) ?? value;
					},
				},
				props: {
					decorations(state) {
						const pluginState =
							commentAnchorPluginKey.getState(state) ??
							EMPTY_COMMENT_ANCHOR_STATE;
						return buildCommentAnchorDecorations(
							state.doc,
							pluginState.anchors,
							pluginState.activeCommentId,
						);
					},
				},
			}),
		];
	},
});

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
		ImageAsPlainText,
		TabSections,
		CommentAnchors,
	];
}
