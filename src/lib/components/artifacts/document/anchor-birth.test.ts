/**
 * RV-1A: a comment's anchor, made by the real editor from a real selection,
 * resolves as "exact" the moment it is made — against the stored Markdown's
 * blocks, which is what the margin and the @Alfy hook resolve it against.
 * Before the fix the resolver matched the editor's visible text against the
 * Markdown source, so any selection touching formatting was "Orphaned" at
 * birth, and @Alfy refused it without asking the model.
 */
import type { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import {
	makeAnchor,
	resolveTextAnchor,
} from "$lib/shared/artifact-document/anchor";
import { parseDocument } from "$lib/shared/artifact-document/blocks";
import {
	createDocumentEditor,
	readMarkdown,
	readSelectionAnchorContext,
} from "./document-editor";

let element: HTMLElement | null = null;

afterEach(() => {
	element?.remove();
	element = null;
});

/** Selects the first occurrence of `substring` in the document's text nodes. */
function select(editor: Editor, substring: string): void {
	let from = -1;
	editor.state.doc.descendants((node, pos) => {
		if (from !== -1 || !node.isText || !node.text) return;
		const idx = node.text.indexOf(substring);
		if (idx !== -1) from = pos + idx;
	});
	if (from === -1) throw new Error(`"${substring}" is not in one text node`);
	editor.commands.setTextSelection({ from, to: from + substring.length });
}

describe("RV-1A: an anchor made in the editor is exact at birth", () => {
	it("on bold text, a whole heading, a task's text, a quote and a table cell", () => {
		element = document.createElement("div");
		document.body.appendChild(element);
		const stored = parseDocument(
			[
				"## Day **one** in Vienna",
				"Book the **night** train & a *cheap* hotel.",
				"- [ ] Pack the **boots**",
				"> Bring the **tickets**, printed",
				"| Item | Status |\n| --- | --- |\n| Hotel | booked |",
			].join("\n\n"),
		).markdown;
		const editor = createDocumentEditor({
			element,
			markdown: stored,
			placeholder: "Write anything, or ask Alfy to.",
		});
		const blocks = parseDocument(readMarkdown(editor)).blocks;

		for (const quote of [
			"in Vienna",
			"train & a ",
			"Pack the ",
			"tickets",
			"booked",
		]) {
			select(editor, quote);
			const context = readSelectionAnchorContext(editor);
			if (!context) throw new Error(`no anchor context for "${quote}"`);
			const anchor = makeAnchor(context);
			if (!anchor) throw new Error(`no anchor for "${quote}"`);
			expect(
				resolveTextAnchor(anchor, blocks).state,
				`the anchor on "${quote}"`,
			).toBe("exact");
		}
		editor.destroy();
	});
});
