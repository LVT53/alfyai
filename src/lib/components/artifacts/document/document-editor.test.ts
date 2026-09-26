import type { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildIndex,
	countMarkers,
	parseDocument,
} from "$lib/shared/artifact-document/blocks";
import {
	createDocumentEditor,
	loadMarkdown,
	readMarkdown,
	readSelectionAnchorContext,
} from "./document-editor";
import { BLOCK_MARKER_NODE } from "./extensions";

/** Selects the first occurrence of `substring` inside whichever top-level block contains it. */
function selectSubstring(editor: Editor, substring: string): void {
	let from = -1;
	let to = -1;
	editor.state.doc.forEach((node, offset) => {
		if (from !== -1) return;
		const idx = node.textContent.indexOf(substring);
		if (idx === -1) return;
		from = offset + 1 + idx;
		to = from + substring.length;
	});
	if (from === -1)
		throw new Error(`fixture substring "${substring}" not found`);
	editor.commands.setTextSelection({ from, to });
}

let element: HTMLElement | null = null;

afterEach(() => {
	element?.remove();
	element = null;
});

function mountEditor(markdown: string) {
	element = document.createElement("div");
	document.body.appendChild(element);
	return createDocumentEditor({
		element,
		markdown,
		placeholder: "Write anything, or ask Alfy to.",
	});
}

/**
 * Sets the whole document to a single code block with EXACTLY `text` as its
 * content, bypassing markdown parsing entirely — a markdown SOURCE string
 * containing a triple-backtick line inside a fence is already ambiguous at
 * the very first parse (CommonMark itself closes the fence early), which
 * would prove nothing about `readMarkdown`'s own re-serialization. Going
 * through the live node directly is what a real paste or keystroke into an
 * already-open code block does: the text arrives as ProseMirror content, not
 * as markdown source ever parsed by anyone.
 */
function replaceWithCodeBlock(editor: Editor, text: string): void {
	const { schema } = editor.state;
	const doc = schema.nodes.doc.create(null, [
		schema.nodes.codeBlock.create(null, schema.text(text)),
	]);
	editor.view.dispatch(
		editor.state.tr.replaceWith(0, editor.state.doc.content.size, doc.content),
	);
}

/**
 * Sets the whole document to a single plain paragraph with EXACTLY `text` as
 * its content, the same live-node route `replaceWithCodeBlock` uses above and
 * for the same reason: markdown SOURCE starting with "2024. " or "- " is
 * already ambiguous at the very first parse (a real reader cannot tell a
 * numeral from a list marker either), so loading it as source would prove
 * nothing about `readMarkdown`'s own re-serialization of a paragraph the user
 * actually typed.
 */
function replaceWithParagraph(editor: Editor, text: string): void {
	const { schema } = editor.state;
	const doc = schema.nodes.doc.create(null, [
		schema.nodes.paragraph.create(null, schema.text(text)),
	]);
	editor.view.dispatch(
		editor.state.tr.replaceWith(0, editor.state.doc.content.size, doc.content),
	);
}

describe("document-editor", () => {
	// T7's mint-before-hash equivalent, through the real editor: a fresh load
	// with no markers at all must still give every top-level block a stable id
	// the moment the editor is ready — the prototype's own bug was minting ids
	// lazily, which left a freshly opened document with no addressable
	// identity at all.
	it("gives every block a stable id on a fresh load with no markers", () => {
		const editor = mountEditor(
			"# Title\n\nA paragraph of text.\n\n- one\n- two",
		);
		const markdown = readMarkdown(editor);
		const parsed = parseDocument(markdown, { mint: false });
		expect(parsed.blocks.length).toBeGreaterThan(0);
		expect(parsed.blocks.every((b) => b.id.length > 0)).toBe(true);
		editor.destroy();
	});

	// RV-1B, coordinator item 1: this Document registers no Image node, and
	// without a handler for it, @tiptap/markdown's fallback parsing of an
	// unrecognised `![alt](url)` left a bare inline text node sitting
	// directly under "doc" — invalid per the schema's block-only top-level
	// content expression, crashing the very next transaction
	// (`buildAbsorbAndMintTransaction`'s own `ensureBlockIds` call) with
	// "Invalid content for node doc". Alfy can write an image into a
	// document as a completely ordinary thing to do; opening it must not
	// crash the editor.
	it("does not crash opening a document containing a Markdown image", () => {
		const editor = mountEditor(
			"Some text.\n\n![alt text](https://example.com/pic.png)\n\nMore text.",
		);
		const markdown = readMarkdown(editor);
		const parsed = parseDocument(markdown, { mint: false });
		// Degrades to plain text (the alt text) rather than crashing or
		// silently dropping the paragraph — every block still gets a stable id.
		expect(parsed.blocks.length).toBe(3);
		expect(parsed.blocks.every((b) => b.id.length > 0)).toBe(true);
		expect(markdown).toContain("alt text");
		editor.destroy();
	});

	it("falls back to a placeholder for an image with no alt text, and stays stable across two round trips", () => {
		const editor = mountEditor("![](https://example.com/pic.png)");
		const pass1 = readMarkdown(editor);
		loadMarkdown(editor, pass1);
		const pass2 = readMarkdown(editor);
		expect(pass2).toBe(pass1);
		editor.destroy();
	});

	// RV-1B, coordinator item 2: `@tiptap/markdown`'s own table serializer
	// does not escape a literal "|" inside a cell, so it wrote one bare —
	// which the next parse counts as an extra column, silently reflowing
	// (and, once padded back to the header's column count, silently
	// dropping) whatever cell came after it.
	it("escapes a literal pipe typed inside a table cell, and keeps the column count stable across a reload", () => {
		const editor = mountEditor(
			"| Col A | Col B |\n| --- | --- |\n| Rate: 10\\|20 | Discount |",
		);
		const markdown = readMarkdown(editor);
		expect(markdown).toContain("Rate: 10\\|20");
		expect(markdown).not.toMatch(/Rate: 10\|20/); // never the unescaped form
		const blocks = parseDocument(markdown, { mint: false }).blocks;
		const table = blocks.find((b) => b.kind === "table");
		expect(table?.markdown).toContain("Rate: 10\\|20 | Discount");
		editor.destroy();
	});

	it("keeps the user's own live text free of any escaping after readMarkdown returns", () => {
		const editor = mountEditor(
			"| Col A | Col B |\n| --- | --- |\n| Rate: 10\\|20 | Discount |",
		);
		readMarkdown(editor);
		expect(editor.state.doc.textContent).toContain("Rate: 10|20");
		expect(editor.state.doc.textContent).not.toContain("\\");
		editor.destroy();
	});

	// RV-1B, coordinator item 3: a code block's own content can legitimately
	// contain a line of 3+ backticks (documentation about Markdown fencing,
	// or a pasted snippet of Markdown source) — `getMarkdown()` still wrote a
	// plain 3-backtick outer fence regardless, and CommonMark closes a fence
	// at the FIRST line that is itself a matching-or-longer run of backticks,
	// so the inner line read as the block's OWN close on the very next
	// parse: one code block became three blocks (a truncated code block, a
	// paragraph made of what should still be code, and a stray second code
	// block).
	it("widens the fence when a code block's own content contains a triple-backtick line", () => {
		const editor = mountEditor("placeholder");
		const codeText = "Here is how to fence code:\n```\nlike this\n```";
		replaceWithCodeBlock(editor, codeText);

		const markdown = readMarkdown(editor);
		const blocks = parseDocument(markdown, { mint: false }).blocks;
		expect(blocks.length).toBe(1);
		expect(blocks[0].kind).toBe("code");
		expect(blocks[0].markdown).toContain(codeText);
		editor.destroy();
	});

	it("widens the fence again for a code block whose content has a 4-backtick line", () => {
		const editor = mountEditor("placeholder");
		const codeText = "Nested:\n````\ninner\n````";
		replaceWithCodeBlock(editor, codeText);

		const markdown = readMarkdown(editor);
		expect(markdown).toContain("`````"); // 5 backticks: one more than the 4 inside
		const blocks = parseDocument(markdown, { mint: false }).blocks;
		expect(blocks.length).toBe(1);
		expect(blocks[0].markdown).toContain(codeText);
		editor.destroy();
	});

	it("leaves an ordinary code block's fence at 3 backticks", () => {
		const editor = mountEditor("```js\nconst x = 1;\n```");
		const markdown = readMarkdown(editor);
		expect(markdown).toContain("```js");
		expect(markdown).not.toContain("````");
		editor.destroy();
	});

	// RV-1B, coordinator item 4: a plain paragraph whose own first line
	// happens to start with an ordered numeral ("2024. ") or a bullet
	// character ("- ") is, in bare Markdown, indistinguishable from a real
	// list — `blocks.ts`'s splitter read either shape as `kind: "list"` on the
	// very next parse, silently changing the block's own kind.
	it("keeps a paragraph starting with a numeral-and-period as a paragraph, not a list", () => {
		const editor = mountEditor("placeholder");
		replaceWithParagraph(editor, "2024. Some year in review.");

		const markdown = readMarkdown(editor);
		const blocks = parseDocument(markdown, { mint: false }).blocks;
		expect(blocks.length).toBe(1);
		expect(blocks[0].kind).toBe("paragraph");
		expect(blocks[0].label).toBe("2024. Some year in review.");
		editor.destroy();
	});

	it("keeps a paragraph starting with a dash as a paragraph, not a list", () => {
		const editor = mountEditor("placeholder");
		replaceWithParagraph(editor, "- this is not a list, just a sentence.");

		const markdown = readMarkdown(editor);
		const blocks = parseDocument(markdown, { mint: false }).blocks;
		expect(blocks.length).toBe(1);
		expect(blocks[0].kind).toBe("paragraph");
		expect(blocks[0].label).toBe("- this is not a list, just a sentence.");
		editor.destroy();
	});

	it("keeps a paragraph starting with a parenthesised numeral as a paragraph, not a list", () => {
		const editor = mountEditor("placeholder");
		replaceWithParagraph(editor, "1) Not actually a list item.");

		const markdown = readMarkdown(editor);
		const blocks = parseDocument(markdown, { mint: false }).blocks;
		expect(blocks.length).toBe(1);
		expect(blocks[0].kind).toBe("paragraph");
		expect(blocks[0].label).toBe("1) Not actually a list item.");
		editor.destroy();
	});

	it("does not touch a real list's own marker", () => {
		const editor = mountEditor("- one\n- two\n- three");
		const markdown = readMarkdown(editor);
		const blocks = parseDocument(markdown, { mint: false }).blocks;
		expect(blocks[0].kind).toBe("list");
		expect(blocks[0].markdown).toBe("- one\n- two\n- three");
		editor.destroy();
	});

	it("a numeral-paragraph's escape round-trips through a second read with no drift", () => {
		const editor = mountEditor("placeholder");
		replaceWithParagraph(editor, "2024. Some year in review.");
		const first = readMarkdown(editor);
		const second = readMarkdown(editor);
		expect(second).toBe(first);
		editor.destroy();
	});

	it("readMarkdown never leaves a blockMarker node in the live document", () => {
		const editor = mountEditor("<!--b:p00001-->\nHello there.");
		readMarkdown(editor);
		let liveMarkerCount = 0;
		editor.state.doc.forEach((node) => {
			if (node.type.name === BLOCK_MARKER_NODE) liveMarkerCount += 1;
		});
		expect(liveMarkerCount).toBe(0);
		editor.destroy();
	});

	it("readMarkdown is idempotent — calling it twice returns the identical string, with no accumulated state", () => {
		const editor = mountEditor(
			"# Title\n\nFirst paragraph.\n\nSecond paragraph.",
		);
		const first = readMarkdown(editor);
		const second = readMarkdown(editor);
		expect(second).toBe(first);
		editor.destroy();
	});

	it("absorbs a hand-written marker rather than minting a new id for it", () => {
		const editor = mountEditor("<!--b:pfixed1-->\nHello there.");
		const markdown = readMarkdown(editor);
		expect(markdown).toContain("<!--b:pfixed1-->");
		expect(countMarkers(markdown)).toBe(1);
		editor.destroy();
	});

	// 12 blocks load, the user types one character in block 5, and all 12 ids
	// are still the same 12 ids (T7.6).
	it("keeps all 12 ids stable after a single keystroke in one block", () => {
		const blocks = Array.from(
			{ length: 12 },
			(_, i) => `Paragraph number ${i}.`,
		);
		const editor = mountEditor(blocks.join("\n\n"));
		const before = parseDocument(readMarkdown(editor), { mint: false });
		expect(before.blocks).toHaveLength(12);
		const idsBefore = before.blocks.map((b) => b.id);

		// Type one character into the 5th paragraph (index 4).
		const target = before.blocks[4];
		let targetPos: number | null = null;
		editor.state.doc.forEach((node, offset) => {
			if (targetPos !== null) return;
			if (node.attrs?.blockId === target.id)
				targetPos = offset + node.nodeSize - 1;
		});
		expect(targetPos).not.toBeNull();
		editor.commands.insertContentAt(targetPos ?? 0, "!");

		const after = parseDocument(readMarkdown(editor), { mint: false });
		expect(after.blocks).toHaveLength(12);
		const idsAfter = after.blocks.map((b) => b.id);
		expect(idsAfter).toEqual(idsBefore);
		expect(after.blocks[4].markdown).toContain("Paragraph number 4.!");
		editor.destroy();
	});

	// [trap, ruling 12] The named gate's editor half: load a document with
	// every canonical-form trap at once, read it, reparse+reserialize through
	// the SAME pipeline the server uses, load THAT into a second editor, read
	// it again — with NO user edit anywhere — and the two passes must agree on
	// every hash. Two passes, not one: a single pass catches padding, the
	// second catches whatever the first pass's normalisation itself introduced
	// (a canonicaliser that is not idempotent passes once and fails forever after).
	it('"canonical form survives the editor round trip"', () => {
		const source = [
			"# Trip",
			"",
			"A paragraph  with trailing spaces.",
			"",
			"* one",
			"+ two",
			"",
			"- [X] booked",
			"",
			"- [ ] pending",
			"",
			"1) first",
			"2) second",
			"",
			"| a  |   b |",
			"| -- | --- |",
			"| 1  | 2   |",
			"",
			"> a quote",
			"",
			"```js",
			"code();",
			"",
			"more();",
			"```",
		].join("\n");

		const editor1 = mountEditor(source);
		const pass1Markdown = readMarkdown(editor1);
		const pass1 = parseDocument(pass1Markdown, { mint: false });
		editor1.destroy();

		// Feed the SERVER's own canonical serialisation back into a fresh editor.
		const canonicalAfterPass1 = pass1.markdown;
		const editor2 = mountEditor(canonicalAfterPass1);
		const pass2Markdown = readMarkdown(editor2);
		const pass2 = parseDocument(pass2Markdown, { mint: false });
		editor2.destroy();

		expect(buildIndex(pass2.blocks)).toEqual(buildIndex(pass1.blocks));
		expect(pass2.blocks.map((b) => b.markdown)).toEqual(
			pass1.blocks.map((b) => b.markdown),
		);
	});

	it("loadMarkdown replaces the content and keeps ids stable across the swap", () => {
		const editor = mountEditor("<!--b:p1-->\nOriginal text.");
		loadMarkdown(editor, "<!--b:p1-->\nReplaced text.");
		const markdown = readMarkdown(editor);
		expect(markdown).toContain("<!--b:p1-->");
		expect(markdown).toContain("Replaced text.");
		editor.destroy();
	});

	// T10.1: the SelectionBubble's own data source, and the one place the
	// live selection is ever read out of ProseMirror — everything downstream
	// (makeAnchor, resolveTextAnchor) stays plain strings and DocumentBlock[].
	describe("readSelectionAnchorContext", () => {
		it("is null when the selection is empty (a caret, not a range)", () => {
			const editor = mountEditor("<!--b:p1-->\nBook the flight to Vienna.");
			editor.commands.setTextSelection(5);
			expect(readSelectionAnchorContext(editor)).toBeNull();
			editor.destroy();
		});

		it("reads the containing block's id, the selected text, and its surrounding context", () => {
			const editor = mountEditor("<!--b:p1-->\nBook the flight to Vienna.");
			selectSubstring(editor, "flight");
			const context = readSelectionAnchorContext(editor);
			// jsdom has no real layout, so `rect` (from `coordsAtPos`) is only
			// asserted to exist with the right shape, never exact pixel values —
			// that belongs to a real-browser Playwright check.
			expect(context).toMatchObject({
				blockId: "p1",
				quote: "flight",
				prefix: "Book the ",
				suffix: " to Vienna.",
			});
			expect(context?.rect).toEqual({
				top: expect.any(Number),
				left: expect.any(Number),
				right: expect.any(Number),
				bottom: expect.any(Number),
			});
			editor.destroy();
		});

		it("finds the right block id when the selection is in the second block", () => {
			const editor = mountEditor(
				"<!--b:p1-->\nFirst paragraph.\n\n<!--b:p2-->\nSecond paragraph.",
			);
			selectSubstring(editor, "Second");
			expect(readSelectionAnchorContext(editor)?.blockId).toBe("p2");
			editor.destroy();
		});
	});
});
