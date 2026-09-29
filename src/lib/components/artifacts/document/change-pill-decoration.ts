/**
 * The inline "✦ Alfy · Keep · Undo" pill (Artifacts redesign §4.2 item 5,
 * §7.2 rows #11/#13/#14, §9.2's `ChangeBar.svelte` row: "becomes the inline
 * pill... as a ProseMirror widget decoration", Wave 2.5 Step 10): a real
 * `ChangeBar.svelte` instance, mounted with Svelte 5's own `mount`/`unmount`
 * (the supported way to embed a component in DOM a framework other than
 * Svelte's own rendering owns — here, ProseMirror's widget decoration) into
 * the span a widget decoration creates. The widget flows with the text
 * (§4.2: "never covers another line"), unlike the rect-positioned overlay
 * this replaces.
 *
 * `alfy-writing-decoration.ts`'s own non-interactive tag widget uses plain
 * DOM instead (its own header comment: "no Svelte mount... since this is
 * non-interactive text") — this one needs real, accessible, already-tested
 * buttons (Keep/Undo/Redo), so it reaches for the one supported way to get
 * them from a real component rather than hand-rolling a second interactive
 * DOM tree with its own focus/ARIA wiring.
 *
 * Plugin state only, mirroring that same module's shape: `document-editor.ts`'s
 * `setChangePills` is the one write side, driven by `DocumentBody.svelte`'s
 * own `pendingChanges` map — this module never touches that map itself, only
 * the `ChangePillEntry[]` it is handed.
 *
 * A widget's own DOM node (and the Svelte instance mounted into it) is reused
 * across re-renders as long as its `key` (`${changeId}:${status}`) stays the
 * same — ProseMirror's own decoration diffing compares widgets by `key`
 * instead of DOM identity when one is given — so `toDOM` (and the `mount()`
 * call inside it) only runs again when a change's STATUS actually transitions
 * (pending → kept/undone), never on an unrelated re-render elsewhere in the
 * document. `destroy` unmounts the Svelte instance in step, so a change that
 * leaves the pending list (settled, or the artifact reloads) never leaks one.
 */
import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { mount, unmount } from "svelte";
import ChangeBar from "./ChangeBar.svelte";
import { findAlfyChangeMarkRange } from "./marks";

export type ChangePillStatus = "pending" | "kept" | "undone";

export interface ChangePillEntry {
	changeId: string;
	blockId: string;
	status: ChangePillStatus;
	commentCount: number;
	/**
	 * The changed block's own label — `ChangeBar`'s `role="group"` accessible
	 * name is "Alfy's change: {blockLabel}" (rd/review-2-5.md:210-216: this
	 * field was missing entirely, so the name always rendered with an empty
	 * quote, e.g. "Alfy módosítása: ").
	 */
	blockLabel: string;
	/**
	 * A document position captured BEFORE an action that removes the mark
	 * structurally (Undo replaces the whole node — `marks.ts`'s own doc
	 * comment) — the fallback anchor for the brief "Undone · Redo" window,
	 * once the live mark lookup can no longer find anything. Unused while the
	 * mark is still live (pending, and kept — Keep's own mark-clear is
	 * deferred to the end of its 1.4s window, so the live lookup keeps working
	 * throughout; see `DocumentBody.svelte`'s `handleKeepChange`).
	 */
	fallbackPos?: number;
}

export interface ChangePillCallbacks {
	onKeep: (changeId: string) => void;
	onUndo: (changeId: string) => void;
	onRedo: (changeId: string) => void;
}

const NOOP_CALLBACKS: ChangePillCallbacks = {
	onKeep: () => {},
	onUndo: () => {},
	onRedo: () => {},
};

export const changePillPluginKey = new PluginKey<ChangePillEntry[]>(
	"documentChangePills",
);

/** Exported for its own focused unit tests. */
export function buildChangePillDecorations(
	doc: PMNode,
	entries: ChangePillEntry[],
	callbacks: ChangePillCallbacks,
): DecorationSet {
	if (entries.length === 0) return DecorationSet.empty;
	const decorations: Decoration[] = [];
	for (const entry of entries) {
		const range = findAlfyChangeMarkRange(doc, entry.changeId);
		const pos = range ? range.to : entry.fallbackPos;
		if (pos === undefined || pos < 0 || pos > doc.content.size) continue;

		// Closed over by this entry's own `toDOM`/`destroy` pair — never shared
		// across entries, and never the DOM node itself (no `as` cast needed to
		// stash it there).
		let instance: Record<string, unknown> | null = null;

		decorations.push(
			Decoration.widget(
				pos,
				() => {
					const el = document.createElement("span");
					el.className = "change-pill-mount";
					instance = mount(ChangeBar, {
						target: el,
						props: {
							status: entry.status,
							commentCount: entry.commentCount,
							blockLabel: entry.blockLabel,
							onKeep: () => callbacks.onKeep(entry.changeId),
							onUndo: () => callbacks.onUndo(entry.changeId),
							onRedo: () => callbacks.onRedo(entry.changeId),
						},
					});
					return el;
				},
				{
					side: 1,
					key: `${entry.changeId}:${entry.status}`,
					destroy: () => {
						if (instance) {
							void unmount(instance);
							instance = null;
						}
					},
				},
			),
		);
	}
	return DecorationSet.create(doc, decorations);
}

const ChangePills = Extension.create<{ callbacks: ChangePillCallbacks }>({
	name: "documentChangePills",
	addOptions() {
		return { callbacks: NOOP_CALLBACKS };
	},
	addProseMirrorPlugins() {
		const { callbacks } = this.options;
		return [
			new Plugin<ChangePillEntry[]>({
				key: changePillPluginKey,
				state: {
					init: () => [],
					apply(tr, value) {
						return tr.getMeta(changePillPluginKey) ?? value;
					},
				},
				props: {
					decorations(state) {
						return buildChangePillDecorations(
							state.doc,
							changePillPluginKey.getState(state) ?? [],
							callbacks,
						);
					},
				},
			}),
		];
	},
});

/** `extensions.ts`'s own registration point — one configured instance per editor, so each editor's pill buttons call THAT editor's own callbacks. */
export function buildChangePillExtension(callbacks: ChangePillCallbacks) {
	return ChangePills.configure({ callbacks });
}
