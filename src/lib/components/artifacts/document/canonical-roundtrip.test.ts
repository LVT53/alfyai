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

	it("keeps a hard break inside a quote through open → serialise → reload", () => {
		const stored = parseDocument("> quoted line\\\n> second quoted\n").markdown;
		expect(hardBreaksAfterOpening(stored)).toBe(1);
		const once = reopen(stored);
		expect(hardBreaksAfterOpening(once)).toBe(1);
		expect(buildIndex(parseDocument(once).blocks)).toEqual(
			buildIndex(parseDocument(stored).blocks),
		);
	});

	it("keeps a hard break inside a list item through open → serialise → reload", () => {
		const stored = parseDocument(
			"- item one\\\nitem line two\n- item two\n",
		).markdown;
		expect(hardBreaksAfterOpening(stored)).toBe(1);
		const once = reopen(stored);
		expect(hardBreaksAfterOpening(once)).toBe(1);
		expect(buildIndex(parseDocument(once).blocks)).toEqual(
			buildIndex(parseDocument(stored).blocks),
		);
	});
});

describe("RV-1A: a split keeps one stable id per half", () => {
	it("gives the second half of a split paragraph its own id, the same one on every save", () => {
		element = document.createElement("div");
		document.body.appendChild(element);
		const stored = parseDocument("First half. Second half.\n\nOther.").markdown;
		const [first] = parseDocument(stored).blocks;
		const editor = createDocumentEditor({
			element,
			markdown: stored,
			placeholder: "Write anything, or ask Alfy to.",
		});
		let splitAt = -1;
		editor.state.doc.descendants((node, pos) => {
			if (
				splitAt === -1 &&
				node.isText &&
				node.text?.startsWith("First half.")
			) {
				splitAt = pos + "First half.".length;
			}
		});
		// Enter in the middle of the paragraph: ProseMirror copies the node's
		// attributes, id included, onto the new half.
		editor.chain().setTextSelection(splitAt).splitBlock().run();

		const save = () =>
			parseDocument(
				serializeDocument(parseDocument(readMarkdown(editor)).blocks),
			).blocks.map((block) => block.id);
		const once = save();
		const twice = save();
		editor.destroy();

		expect(once).toHaveLength(3);
		expect(once[0]).toBe(first.id);
		expect(new Set(once).size).toBe(3);
		expect(twice).toEqual(once);
	});
});

describe("RV-1A: an empty list item survives a save and a reopen", () => {
	it("keeps a just-added checklist item a checklist item, and a numbered one numbered", () => {
		element = document.createElement("div");
		document.body.appendChild(element);
		const editor = createDocumentEditor({
			element,
			markdown: "",
			placeholder: "Write anything, or ask Alfy to.",
		});
		const paragraph = (text?: string) =>
			text
				? { type: "paragraph", content: [{ type: "text", text }] }
				: { type: "paragraph" };
		editor.commands.setContent({
			type: "doc",
			content: [
				{
					type: "orderedList",
					attrs: { start: 1 },
					content: [
						{ type: "listItem", content: [paragraph("one")] },
						{ type: "listItem", content: [paragraph()] },
					],
				},
				{
					type: "taskList",
					content: [
						{
							type: "taskItem",
							attrs: { checked: false },
							content: [paragraph()],
						},
					],
				},
			],
		});
		const saved = serializeDocument(parseDocument(readMarkdown(editor)).blocks);
		editor.destroy();
		element.remove();
		element = document.createElement("div");
		document.body.appendChild(element);
		const reopened = createDocumentEditor({
			element,
			markdown: saved,
			placeholder: "Write anything, or ask Alfy to.",
		});
		const shape = (reopened.getJSON().content ?? []).map(
			(node) => `${node.type}:${node.content?.length ?? 0}`,
		);
		reopened.destroy();
		expect(shape.slice(0, 2)).toEqual(["orderedList:2", "taskList:1"]);
	});
});

describe("RV-1A: a list item with two paragraphs keeps both", () => {
	it("brings a list item's and a task item's second paragraph back inside the item after a reopen", () => {
		const paragraph = (text: string) => ({
			type: "paragraph",
			content: [{ type: "text", text }],
		});
		element = document.createElement("div");
		document.body.appendChild(element);
		const editor = createDocumentEditor({
			element,
			markdown: "",
			placeholder: "Write anything, or ask Alfy to.",
		});
		editor.commands.setContent({
			type: "doc",
			content: [
				{
					type: "bulletList",
					content: [
						{
							type: "listItem",
							content: [paragraph("first para"), paragraph("second para")],
						},
					],
				},
				{
					type: "taskList",
					content: [
						{
							type: "taskItem",
							attrs: { checked: true },
							content: [paragraph("first"), paragraph("second")],
						},
					],
				},
			],
		});
		const saved = serializeDocument(parseDocument(readMarkdown(editor)).blocks);
		editor.destroy();
		element.remove();
		element = document.createElement("div");
		document.body.appendChild(element);
		const reopened = createDocumentEditor({
			element,
			markdown: saved,
			placeholder: "Write anything, or ask Alfy to.",
		});
		// The paragraphs inside each list's first item, after the reopen.
		const items = [0, 1].map(
			(index) => reopened.state.doc.child(index).firstChild?.childCount ?? 0,
		);
		reopened.destroy();
		expect(items).toEqual([2, 2]);
	});
});
