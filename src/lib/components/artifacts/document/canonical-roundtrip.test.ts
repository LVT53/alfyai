/**
 * RV-1A: ruling 12's gate, the editor half, for the constructs the review
 * found broken — the same path a real reopen takes: the stored canonical
 * Markdown loads into the real Tiptap editor, the editor serialises it, and
 * the client canonicalises it exactly as `DocumentBody.svelte`'s
 * `currentCanonicalMarkdown` does before an autosave. With no user edit in
 * between, every block's hash — and its content — must survive.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	buildIndex,
	parseDocument,
	serializeDocument,
} from "$lib/shared/artifact-document/blocks";
import { createDocumentEditor, readMarkdown } from "./document-editor";

/** Count the editor's hard-break nodes after opening `stored`. */
function hardBreaksAfterOpening(stored: string): number {
	element = document.createElement("div");
	document.body.appendChild(element);
	const editor = createDocumentEditor({
		element,
		markdown: stored,
		placeholder: "Write anything, or ask Alfy to.",
	});
	let count = 0;
	editor.state.doc.descendants((node) => {
		if (node.type.name === "hardBreak") count += 1;
	});
	editor.destroy();
	element.remove();
	element = null;
	return count;
}

let element: HTMLElement | null = null;

afterEach(() => {
	element?.remove();
	element = null;
});

/** Open the stored text in the real editor and canonicalise what it writes back. */
function reopen(stored: string): string {
	element = document.createElement("div");
	document.body.appendChild(element);
	const editor = createDocumentEditor({
		element,
		markdown: stored,
		placeholder: "Write anything, or ask Alfy to.",
	});
	const written = serializeDocument(parseDocument(readMarkdown(editor)).blocks);
	editor.destroy();
	element.remove();
	element = null;
	return written;
}

describe("RV-1A: the canonical form survives a real reopen", () => {
	it("keeps a diff code block's + lines and its blank lines through open → serialise → reload", () => {
		const stored = parseDocument(
			"Review this:\n\n```diff\n+ added\n- removed\n\n\n+ another\n```\n",
		).markdown;
		expect(stored).toContain("+ added");

		const once = reopen(stored);
		const twice = reopen(once);
		expect(once).toContain("+ added\n- removed\n\n\n+ another");
		expect(buildIndex(parseDocument(once).blocks)).toEqual(
			buildIndex(parseDocument(stored).blocks),
		);
		expect(buildIndex(parseDocument(twice).blocks)).toEqual(
			buildIndex(parseDocument(stored).blocks),
		);
	});

	it("keeps a nested checklist nested, and every hash, through open → serialise → reload", () => {
		const stored = parseDocument(
			"- [ ] parent task\n  - [x] child task\n- [ ] second\n",
		).markdown;

		const once = reopen(stored);
		const twice = reopen(once);
		expect(once).toContain("- [ ] parent task\n  - [x] child task");
		expect(buildIndex(parseDocument(once).blocks)).toEqual(
			buildIndex(parseDocument(stored).blocks),
		);
		expect(buildIndex(parseDocument(twice).blocks)).toEqual(
			buildIndex(parseDocument(stored).blocks),
		);
	});

	it("keeps a horizontal rule a horizontal rule through open → serialise → reload", () => {
		const stored = parseDocument("Above.\n\n---\n\nBelow.\n").markdown;
		const once = reopen(stored);
		expect(parseDocument(once).blocks.map((block) => block.kind)).toEqual([
			"paragraph",
			"hr",
			"paragraph",
		]);
		expect(once).not.toContain("| --- |");
	});

	it("keeps a table's hash through open → serialise → reload when a column is wider than its delimiter", () => {
		const stored = parseDocument(
			"| Item | Status |\n| --- | --- |\n| Train tickets to Vienna | booked |\n",
		).markdown;
		const once = reopen(stored);
		expect(buildIndex(parseDocument(once).blocks)).toEqual(
			buildIndex(parseDocument(stored).blocks),
		);
	});

	it("keeps a hard line break (Shift+Enter) through open → serialise → reload", () => {
		const stored = parseDocument("First line\\\nsecond line\n").markdown;
		expect(hardBreaksAfterOpening(stored)).toBe(1);
		const once = reopen(stored);
		expect(hardBreaksAfterOpening(once)).toBe(1);
		expect(buildIndex(parseDocument(once).blocks)).toEqual(
			buildIndex(parseDocument(stored).blocks),
		);
	});
});
