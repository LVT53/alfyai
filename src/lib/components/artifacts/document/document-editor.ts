/**
 * The lazy boundary (Feature 2 · Artifacts, Slice 1, T7). This is the ONLY
 * module `DocumentBody.svelte` imports with `await import(...)` — everything
 * Tiptap-shaped is reachable from here and nowhere the panel shell, the
 * toolbar host or the margin loads eagerly, so a chat page that never opens a
 * Document never pays for Tiptap/ProseMirror's bytes.
 */
import { Editor } from "@tiptap/core";
import {
	BLOCK_ID_ATTR,
	BLOCK_MARKER_NODE,
	blockIdPluginKey,
	buildDocumentExtensions,
	ensureBlockIds,
	SKIP_BLOCK_ID_PLUGIN,
} from "./extensions";

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
	editor.commands.setContent(markdown, { contentType: "markdown" });
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
	insertTr.setMeta("addToHistory", false);
	// Without this, dispatching the insertion re-triggers BlockIds' own
	// appendTransaction, which would see a marker whose following block is
	// already identified, decide there is nothing to absorb, and delete the
	// marker anyway as routine cleanup — before `getMarkdown()` below ever
	// runs. The output-only marker would never survive to be serialised.
	insertTr.setMeta(blockIdPluginKey, SKIP_BLOCK_ID_PLUGIN);
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
	deleteTr.setMeta("addToHistory", false);
	deleteTr.setMeta(blockIdPluginKey, SKIP_BLOCK_ID_PLUGIN);
	editor.view.dispatch(deleteTr);

	return markdown;
}

export type { Editor };
