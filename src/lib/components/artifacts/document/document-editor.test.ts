import type { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentTab } from "$lib/server/services/artifacts/serialize/document";
import {
	buildIndex,
	countMarkers,
	parseDocument,
} from "$lib/shared/artifact-document/blocks";
import {
	appendEmptyTabSection,
	blockRect,
	createDocumentEditor,
	loadMarkdown,
	readMarkdown,
	readSelectionAnchorContext,
	scrollToCommentAnchor,
	selectAndScrollToBlock,
	setAlfyWritingBlock,
	setCommentAnchors,
	setRefusedLines,
	setSelectionPending,
} from "./document-editor";
import {
	BLOCK_ID_ATTR,
	BLOCK_MARKER_NODE,
	buildTabSectionDecorations,
} from "./extensions";

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

// The empty state's one question to the editor: is the page empty? It is asked
// of EVERY transaction, not only of the ones that emit an update, because Alfy's
// landing content and a restored version arrive silently (`preventUpdate`).
describe("createDocumentEditor's onEmptyChange", () => {
	function mountReporting(markdown: string) {
		element = document.createElement("div");
		document.body.appendChild(element);
		const reports: boolean[] = [];
		const editor = createDocumentEditor({
			element,
			markdown,
			placeholder: "Write anything, or ask Alfy to.",
			onEmptyChange: (empty) => reports.push(empty),
		});
		return { editor, reports };
	}

	it("says at creation whether the page is empty", () => {
		expect(mountReporting("").reports).toEqual([true]);
		expect(mountReporting("Hello.\n").reports).toEqual([false]);
	});

	it("says it again only when the answer changes", () => {
		const { editor, reports } = mountReporting("");

		editor.commands.insertContent("Fri");
		editor.commands.insertContent("day");
		expect(reports).toEqual([true, false]);

		editor.commands.selectAll();
		editor.commands.deleteSelection();
		expect(reports).toEqual([true, false, true]);
	});

	it("hears a silent change too, such as content landing without an update", () => {
		const { editor, reports } = mountReporting("");
		const { schema } = editor.state;

		editor.view.dispatch(
			editor.state.tr
				.replaceWith(
					0,
					editor.state.doc.content.size,
					schema.nodes.paragraph.create(null, schema.text("Landed.")),
				)
				.setMeta("preventUpdate", true),
		);

		expect(reports).toEqual([true, false]);
	});

	it("is optional: an editor with no one listening still works", () => {
		const editor = mountEditor("");
		editor.commands.insertContent("Fine.");
		expect(editor.isEmpty).toBe(false);
	});
});

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

	// G3 (keyboard undo/redo): loading the server's content into the open
	// editor (Alfy's edit landing, a comment refresh that found a newer
	// version) is not something the reader typed. It used to be ONE undoable
	// step that replaced the whole document, so Ctrl/Cmd+Z after Alfy's edit
	// took Alfy's change back through the reader's own history — around
	// Keep/Undo and the version bookkeeping — and, whatever the reader had
	// typed elsewhere, a later Undo had nothing valid left to undo. The load
	// is applied as the smallest replacement of whole blocks, outside the
	// history, so what the reader typed in blocks the load left alone stays
	// undoable and the loaded blocks are not part of it.
	describe("loadMarkdown and the reader's own undo history (G3)", () => {
		function textOf(editor: Editor): string {
			return editor.getText({ blockSeparator: " | " });
		}
		function typeAt(editor: Editor, blockIndex: number, text: string): void {
			let pos = 0;
			editor.state.doc.forEach((node, offset, index) => {
				if (index === blockIndex) pos = offset + node.nodeSize - 1;
			});
			editor.commands.insertContentAt(pos, text);
		}

		afterEach(() => {
			vi.useRealTimers();
		});

		it("is not an undo step: undo() after a load leaves the loaded text alone", () => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
			const editor = mountEditor("<!--b:p1-->\nAlpha.\n\n<!--b:p2-->\nBeta.");
			typeAt(editor, 0, " typed");
			expect(textOf(editor)).toBe("Alpha. typed | Beta.");

			vi.setSystemTime(new Date("2026-01-01T00:00:10Z"));
			loadMarkdown(
				editor,
				"<!--b:p1-->\nAlpha. typed\n\n<!--b:p2-->\nBeta, rewritten by Alfy.",
			);
			expect(textOf(editor)).toBe("Alpha. typed | Beta, rewritten by Alfy.");

			// One undo takes back what the reader typed — not what Alfy wrote.
			editor.commands.undo();
			expect(textOf(editor)).toBe("Alpha. | Beta, rewritten by Alfy.");
			editor.destroy();
		});

		it("keeps what the reader typed in a block the load left alone undoable, and redoable, after the load", () => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
			const editor = mountEditor("<!--b:p1-->\nAlpha.\n\n<!--b:p2-->\nBeta.");
			typeAt(editor, 0, " one");
			vi.setSystemTime(new Date("2026-01-01T00:00:05Z"));
			typeAt(editor, 0, " two");
			editor.commands.undo();
			expect(textOf(editor)).toBe("Alpha. one | Beta.");

			vi.setSystemTime(new Date("2026-01-01T00:00:10Z"));
			loadMarkdown(
				editor,
				"<!--b:p1-->\nAlpha. one\n\n<!--b:p2-->\nBeta, rewritten.",
			);

			// The undone " two" is still there to redo...
			expect(editor.can().redo()).toBe(true);
			editor.commands.redo();
			expect(textOf(editor)).toBe("Alpha. one two | Beta, rewritten.");
			// ...and " one" is still there to undo.
			editor.commands.undo();
			editor.commands.undo();
			expect(textOf(editor)).toBe("Alpha. | Beta, rewritten.");
			editor.destroy();
		});

		it("drops the reader's earlier edits INSIDE a block the load replaced (they no longer apply), never undoing Alfy's text", () => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
			const editor = mountEditor("<!--b:p1-->\nAlpha.\n\n<!--b:p2-->\nBeta.");
			typeAt(editor, 1, " mine");
			vi.setSystemTime(new Date("2026-01-01T00:00:10Z"));
			loadMarkdown(
				editor,
				"<!--b:p1-->\nAlpha.\n\n<!--b:p2-->\nBeta, rewritten by Alfy.",
			);
			editor.commands.undo();
			expect(textOf(editor)).toBe("Alpha. | Beta, rewritten by Alfy.");
			editor.destroy();
		});

		it("touches only the blocks that differ: an untouched block keeps its node, and the caret in it stays put", () => {
			const editor = mountEditor(
				"<!--b:p1-->\nAlpha.\n\n<!--b:p2-->\nBeta.\n\n<!--b:p3-->\nGamma.",
			);
			const untouchedBefore = editor.state.doc.child(0);
			editor.commands.setTextSelection(4);
			loadMarkdown(
				editor,
				"<!--b:p1-->\nAlpha.\n\n<!--b:p2-->\nBeta, longer now.\n\n<!--b:p3-->\nGamma.",
			);
			expect(editor.state.doc.child(0)).toBe(untouchedBefore);
			expect(editor.state.selection.from).toBe(4);
			expect(textOf(editor)).toBe("Alpha. | Beta, longer now. | Gamma.");
			editor.destroy();
		});

		it("handles blocks added in front, in the middle and at the end, and blocks removed", () => {
			const editor = mountEditor(
				"<!--b:p1-->\nAlpha.\n\n<!--b:p2-->\nBeta.\n\n<!--b:p3-->\nGamma.",
			);
			loadMarkdown(
				editor,
				"<!--b:p0-->\nNew first.\n\n<!--b:p1-->\nAlpha.\n\n<!--b:p3-->\nGamma.\n\n<!--b:p4-->\nNew last.",
			);
			expect(textOf(editor)).toBe("New first. | Alpha. | Gamma. | New last.");
			expect(readMarkdown(editor)).toBe(
				"<!--b:p0-->\n\nNew first.\n\n<!--b:p1-->\n\nAlpha.\n\n<!--b:p3-->\n\nGamma.\n\n<!--b:p4-->\n\nNew last.",
			);
			editor.destroy();
		});

		it("is a no-op for content the editor already has: no transaction, no history entry", () => {
			const editor = mountEditor("<!--b:p1-->\nAlpha.\n\n<!--b:p2-->\nBeta.");
			const before = editor.state;
			loadMarkdown(editor, readMarkdown(editor));
			expect(editor.state.doc.eq(before.doc)).toBe(true);
			expect(editor.can().undo()).toBe(false);
			editor.destroy();
		});

		it("still loads a whole different document (nothing in common)", () => {
			const editor = mountEditor("<!--b:p1-->\nAlpha.\n\n<!--b:p2-->\nBeta.");
			loadMarkdown(editor, "<!--b:q1-->\nCompletely new.");
			expect(textOf(editor)).toBe("Completely new.");
			expect(readMarkdown(editor)).toContain("<!--b:q1-->");
			editor.destroy();
		});

		it("does not fire onUpdate — a content sync is not a user edit", () => {
			const onUpdate = vi.fn();
			element = document.createElement("div");
			document.body.appendChild(element);
			const editor = createDocumentEditor({
				element,
				markdown: "<!--b:p1-->\nAlpha.",
				placeholder: "x",
				onUpdate,
			});
			loadMarkdown(editor, "<!--b:p1-->\nAlpha, changed.");
			expect(onUpdate).not.toHaveBeenCalled();
			editor.destroy();
		});
	});

	// Review 2.5 (rd/review-2-5.md:191-197): a brand-new tab used to start
	// with no block of its own, so the whole document showed inside what
	// should have been an empty new section — `Tabs.svelte`'s own
	// `addTab`/`DocumentBody.svelte`'s `handleTabsChange` call this to give
	// it a real one.
	//
	// A LITERALLY empty paragraph does NOT work for this, even though it
	// looks right in the live session: `blocks.ts`'s own `splitIntoSegments`
	// documents, by design, that "a trailing marker with no following block
	// is dropped" — a blank line has no Markdown syntax for "an empty block
	// with this id" at all. `saveDocumentBody` (the server) re-canonicalises
	// through that exact same parser on every save
	// (`parseDocument(params.body.markdown).markdown`), so a truly empty
	// anchor paragraph's marker silently vanished from the STORED body on
	// the very first save — reviving the whole-document bug the moment the
	// tab was revisited after a reload, even though `Tabs.svelte`'s own
	// metadata still pointed at that (now nonexistent) block id. Confirmed
	// empirically while writing this suite (the first version of these
	// tests used a truly empty paragraph and passed every one of THEM, since
	// none reused `parseDocument`'s own canonical round trip the way the
	// server actually does — see "survives the server's own re-canonicalising
	// save" below, the test that caught it). `appendEmptyTabSection` inserts
	// a zero-width space instead: invisible to the user, but not blank to
	// `.trim()`, so the block survives every layer.
	describe("appendEmptyTabSection", () => {
		it("appends a paragraph (a single zero-width space) with a freshly minted id, and returns that id", () => {
			const editor = mountEditor("<!--b:p1-->\nFirst paragraph.");
			const id = appendEmptyTabSection(editor);
			expect(id).not.toBeNull();
			expect(editor.state.doc.childCount).toBe(2);
			const lastNode = editor.state.doc.lastChild;
			expect(lastNode?.type.name).toBe("paragraph");
			expect(lastNode?.textContent).toBe("​");
			expect(lastNode?.attrs?.[BLOCK_ID_ATTR]).toBe(id);
			editor.destroy();
		});

		it("selects the zero-width space so the user's first keystroke replaces it outright", () => {
			const editor = mountEditor("<!--b:p1-->\nFirst paragraph.");
			appendEmptyTabSection(editor);
			const lastNode = editor.state.doc.lastChild;
			expect(lastNode?.type.name).toBe("paragraph");
			expect(lastNode?.textContent).toBe("​");
			const { selection } = editor.state;
			expect(selection.empty).toBe(false);
			expect(selection.to - selection.from).toBe(1);
			editor.commands.insertContent("x");
			expect(editor.state.doc.lastChild?.textContent).toBe("x");
			editor.destroy();
		});

		it("mints a different id for a second tab added right after the first", () => {
			const editor = mountEditor("<!--b:p1-->\nFirst paragraph.");
			const id1 = appendEmptyTabSection(editor);
			const id2 = appendEmptyTabSection(editor);
			expect(id1).not.toBeNull();
			expect(id2).not.toBeNull();
			expect(id1).not.toBe(id2);
			expect(editor.state.doc.childCount).toBe(3);
			editor.destroy();
		});

		it("is a real, undo-able edit, unlike setActiveDocumentTab's own no-op-for-history dispatch", () => {
			const editor = mountEditor("<!--b:p1-->\nFirst paragraph.");
			const before = readMarkdown(editor);
			appendEmptyTabSection(editor);
			expect(readMarkdown(editor)).not.toBe(before);
			editor.commands.undo();
			expect(readMarkdown(editor)).toBe(before);
			editor.destroy();
		});

		it("gives buildTabSectionDecorations a real anchor, so its own 'show everything' fallback never fires", () => {
			const editor = mountEditor("<!--b:p1-->\nFirst paragraph.");
			const newId = appendEmptyTabSection(editor);
			expect(newId).not.toBeNull();
			const existingTab: DocumentTab = {
				id: "tab-existing",
				title: "Plan",
				startBlockId: "p1",
			};
			const newTab: DocumentTab = {
				id: "tab-new",
				title: "New section",
				startBlockId: newId as string,
			};
			const decorations = buildTabSectionDecorations(
				editor.state.doc,
				[existingTab, newTab],
				newTab.id,
			);
			// The fallback (rd2's own safety net) returns an EMPTY decoration
			// set for "active tab owns zero blocks" — the exact bug this
			// finding reports. A real anchor means the new tab instead hides
			// the OTHER tab's block: exactly one decoration, on the first
			// paragraph, not zero.
			expect(decorations.find()).toHaveLength(1);
			editor.destroy();
		});

		it("the new block's id survives a real reload (loadMarkdown re-parses the trailing marker the same way)", () => {
			const editor = mountEditor("<!--b:p1-->\nFirst paragraph.");
			const id = appendEmptyTabSection(editor);
			const stored = readMarkdown(editor);
			editor.destroy();

			const reopened = mountEditor(stored);
			expect(reopened.state.doc.childCount).toBe(2);
			const lastNode = reopened.state.doc.lastChild;
			expect(lastNode?.attrs?.[BLOCK_ID_ATTR]).toBe(id);
			expect(lastNode?.textContent).toBe("​");
			reopened.destroy();
		});

		// The actual bug: `saveDocumentBody` (document-ops.ts) stores
		// `parseDocument(markdown).markdown`, never the caller's raw string —
		// this is the ONE assertion that exercises that exact recanonicalising
		// step (`document-ops.test.ts`'s own domain, mirrored here since a
		// server-only test cannot mount a real editor to produce the input).
		it("survives the server's own re-canonicalising save (parseDocument(markdown).markdown), not just this editor's own round trip", () => {
			const editor = mountEditor("<!--b:p1-->\nFirst paragraph.");
			const id = appendEmptyTabSection(editor);
			const clientMarkdown = readMarkdown(editor);
			editor.destroy();

			const canonical = parseDocument(clientMarkdown).markdown;
			const blocks = parseDocument(canonical, { mint: false }).blocks;
			expect(
				blocks.some((block) => block.id === id),
				`the new block's marker must survive re-canonicalisation; got blocks ${JSON.stringify(blocks.map((b) => b.id))}`,
			).toBe(true);
		});
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

	// G3: keyboard undo and redo. Dispatches REAL key events at the editor's
	// own DOM, so this is the actual `editorProps.handleKeyDown` wiring. jsdom
	// reports no platform, so ⌘ is Ctrl here unless a test says it is a Mac.
	describe("keyboard undo and redo (G3)", () => {
		function press(editor: Editor, init: KeyboardEventInit): KeyboardEvent {
			const event = new KeyboardEvent("keydown", {
				bubbles: true,
				cancelable: true,
				...init,
			});
			editor.view.dom.dispatchEvent(event);
			return event;
		}
		const ctrl = (key: string, extra: KeyboardEventInit = {}) => ({
			key,
			code: `Key${key.toUpperCase()}`,
			ctrlKey: true,
			...extra,
		});
		const meta = (key: string, extra: KeyboardEventInit = {}) => ({
			key,
			code: `Key${key.toUpperCase()}`,
			metaKey: true,
			...extra,
		});
		function textOf(editor: Editor): string {
			return editor.getText({ blockSeparator: " | " });
		}
		function typeAtEnd(editor: Editor, text: string): void {
			editor.commands.insertContentAt(
				editor.state.doc.child(0).nodeSize - 1,
				text,
			);
		}
		function setPlatform(value: string | undefined): void {
			Object.defineProperty(window.navigator, "platform", {
				value,
				configurable: true,
			});
		}

		afterEach(() => {
			vi.useRealTimers();
			Reflect.deleteProperty(window.navigator, "platform");
		});

		function typedTwice(): Editor {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
			const editor = mountEditor("<!--b:p1-->\nAlpha.");
			typeAtEnd(editor, " one");
			vi.setSystemTime(new Date("2026-01-01T00:00:05Z"));
			typeAtEnd(editor, " two");
			expect(textOf(editor)).toBe("Alpha. one two");
			return editor;
		}

		it("Ctrl+Z undoes, Ctrl+Shift+Z and Ctrl+Y redo (Windows and Linux keys)", () => {
			const editor = typedTwice();
			const undo = press(editor, ctrl("z"));
			expect(undo.defaultPrevented).toBe(true);
			expect(textOf(editor)).toBe("Alpha. one");
			press(editor, ctrl("z"));
			expect(textOf(editor)).toBe("Alpha.");

			press(editor, ctrl("Z", { shiftKey: true }));
			expect(textOf(editor)).toBe("Alpha. one");
			const redo = press(editor, ctrl("y"));
			expect(redo.defaultPrevented).toBe(true);
			expect(textOf(editor)).toBe("Alpha. one two");
			editor.destroy();
		});

		it("Cmd+Z undoes, Cmd+Shift+Z and Cmd+Y redo on a Mac", () => {
			// (`prosemirror-keymap` reads the platform once, at import, so the
			// editor's own binding still thinks it is ⌘-less here; the Mac chords
			// are this module's own, which read it live.)
			setPlatform("MacIntel");
			const editor = typedTwice();
			press(editor, meta("z"));
			expect(textOf(editor)).toBe("Alpha. one");
			press(editor, meta("Z", { shiftKey: true }));
			expect(textOf(editor)).toBe("Alpha. one two");
			press(editor, meta("z"));
			press(editor, meta("y"));
			expect(textOf(editor)).toBe("Alpha. one two");
			editor.destroy();
		});

		it("claims the key even with nothing to undo or redo, so the browser's own undo never runs on a document ProseMirror owns", () => {
			const editor = mountEditor("<!--b:p1-->\nAlpha.");
			expect(editor.can().undo()).toBe(false);
			expect(press(editor, ctrl("z")).defaultPrevented).toBe(true);
			expect(
				press(editor, ctrl("Z", { shiftKey: true })).defaultPrevented,
			).toBe(true);
			expect(press(editor, ctrl("y")).defaultPrevented).toBe(true);
			expect(textOf(editor)).toBe("Alpha.");
			editor.destroy();
		});

		it("undoes once per press, not twice (the editor's own binding and this one do not both run)", () => {
			const editor = typedTwice();
			press(editor, ctrl("z"));
			expect(textOf(editor)).toBe("Alpha. one");
			editor.destroy();
		});

		it("leaves Alfy's own chord (Alt held) and other letters to whoever owns them", () => {
			const editor = typedTwice();
			expect(press(editor, ctrl("z", { altKey: true })).defaultPrevented).toBe(
				false,
			);
			expect(press(editor, ctrl("x")).defaultPrevented).toBe(false);
			expect(textOf(editor)).toBe("Alpha. one two");
			editor.destroy();
		});
	});

	// Review 2.5 Important finding (rd/review-2-5.md:198-207): Tab from a
	// non-collapsed selection reached the editor's own next focusable DOM
	// node first (a comment highlight, a chip select, a change pill, a task
	// checkbox) — the selection pill came after every one of those, so
	// keyboard-only Ask Alfy/Comment was unreachable. Dispatches a REAL
	// `KeyboardEvent` at `editor.view.dom`, the same object ProseMirror's own
	// internal listener is attached to, so this exercises the actual
	// `editorProps.handleKeyDown` wiring rather than calling some exported
	// handler function directly.
	describe("Tab into the selection pill", () => {
		function dispatchTab(
			editor: Editor,
			extra: KeyboardEventInit = {},
		): KeyboardEvent {
			const event = new KeyboardEvent("keydown", {
				key: "Tab",
				bubbles: true,
				cancelable: true,
				...extra,
			});
			editor.view.dom.dispatchEvent(event);
			return event;
		}

		it("a plain Tab over a non-empty selection calls onTabIntoSelectionPill and suppresses the default", () => {
			const onTabIntoSelectionPill = vi.fn().mockReturnValue(true);
			element = document.createElement("div");
			document.body.appendChild(element);
			const editor = createDocumentEditor({
				element,
				markdown: "<!--b:p1-->\nSelect this text.",
				placeholder: "x",
				onTabIntoSelectionPill,
			});
			editor.commands.setTextSelection({ from: 1, to: 7 });
			expect(editor.state.selection.empty).toBe(false);

			const event = dispatchTab(editor);
			expect(onTabIntoSelectionPill).toHaveBeenCalledOnce();
			expect(event.defaultPrevented).toBe(true);
			editor.destroy();
		});

		it("does not intercept Tab when the selection is empty (a caret)", () => {
			const onTabIntoSelectionPill = vi.fn().mockReturnValue(true);
			element = document.createElement("div");
			document.body.appendChild(element);
			const editor = createDocumentEditor({
				element,
				markdown: "<!--b:p1-->\nSelect this text.",
				placeholder: "x",
				onTabIntoSelectionPill,
			});
			editor.commands.setTextSelection(1);
			expect(editor.state.selection.empty).toBe(true);

			const event = dispatchTab(editor);
			expect(onTabIntoSelectionPill).not.toHaveBeenCalled();
			expect(event.defaultPrevented).toBe(false);
			editor.destroy();
		});

		it("does not intercept Shift+Tab, even over a non-empty selection", () => {
			const onTabIntoSelectionPill = vi.fn().mockReturnValue(true);
			element = document.createElement("div");
			document.body.appendChild(element);
			const editor = createDocumentEditor({
				element,
				markdown: "<!--b:p1-->\nSelect this text.",
				placeholder: "x",
				onTabIntoSelectionPill,
			});
			editor.commands.setTextSelection({ from: 1, to: 7 });

			const event = dispatchTab(editor, { shiftKey: true });
			expect(onTabIntoSelectionPill).not.toHaveBeenCalled();
			expect(event.defaultPrevented).toBe(false);
			editor.destroy();
		});

		it("lets Tab fall through to its own default when there is nothing to focus (onTabIntoSelectionPill returns false)", () => {
			const onTabIntoSelectionPill = vi.fn().mockReturnValue(false);
			element = document.createElement("div");
			document.body.appendChild(element);
			const editor = createDocumentEditor({
				element,
				markdown: "<!--b:p1-->\nSelect this text.",
				placeholder: "x",
				onTabIntoSelectionPill,
			});
			editor.commands.setTextSelection({ from: 1, to: 7 });

			const event = dispatchTab(editor);
			expect(onTabIntoSelectionPill).toHaveBeenCalledOnce();
			expect(event.defaultPrevented).toBe(false);
			editor.destroy();
		});

		it("does nothing when no onTabIntoSelectionPill callback was supplied at all", () => {
			element = document.createElement("div");
			document.body.appendChild(element);
			const editor = createDocumentEditor({
				element,
				markdown: "<!--b:p1-->\nSelect this text.",
				placeholder: "x",
			});
			editor.commands.setTextSelection({ from: 1, to: 7 });

			const event = dispatchTab(editor);
			expect(event.defaultPrevented).toBe(false);
			editor.destroy();
		});
	});
});

describe("setCommentAnchors / scrollToCommentAnchor (redesign §3.2, Wave 2.5 Step 7)", () => {
	function firstBlockId(editor: Editor): string {
		let id: string | null = null;
		editor.state.doc.forEach((node) => {
			if (id !== null) return;
			const value = node.attrs?.[BLOCK_ID_ATTR];
			if (typeof value === "string") id = value;
		});
		if (id === null) throw new Error("fixture has no identified block");
		return id;
	}

	it("renders the live decoration span once anchors are set, and clears it back to nothing", () => {
		const editor = mountEditor("Hello world, this is a test.");
		const blockId = firstBlockId(editor);

		setCommentAnchors(
			editor,
			[{ commentId: "c1", blockId, from: 6, to: 11, resolved: false }],
			null,
		);
		let span = element?.querySelector(".comment-anchor");
		expect(span?.textContent).toBe("world");
		expect(span?.getAttribute("role")).toBe("button");

		setCommentAnchors(editor, [], null);
		span = element?.querySelector(".comment-anchor");
		expect(span).toBeNull();
		editor.destroy();
	});

	it("marks the active comment's own span is-active, and never adds a step to the undo stack", () => {
		const editor = mountEditor("Hello world, this is a test.");
		const blockId = firstBlockId(editor);
		const canUndoBefore = editor.can().undo();

		setCommentAnchors(
			editor,
			[{ commentId: "c1", blockId, from: 6, to: 11, resolved: false }],
			"c1",
		);
		expect(
			element?.querySelector(".comment-anchor.is-active")?.textContent,
		).toBe("world");
		expect(editor.can().undo()).toBe(canUndoBefore);
		editor.destroy();
	});

	it("a resolved anchor renders is-resolved with no tabindex, staying out of tab order", () => {
		const editor = mountEditor("Hello world, this is a test.");
		const blockId = firstBlockId(editor);

		setCommentAnchors(
			editor,
			[{ commentId: "c1", blockId, from: 6, to: 11, resolved: true }],
			null,
		);
		const span = element?.querySelector(".comment-anchor");
		expect(span?.classList.contains("is-resolved")).toBe(true);
		expect(span?.hasAttribute("tabindex")).toBe(false);
		editor.destroy();
	});

	it("scrollToCommentAnchor finds and flashes the resolved anchor's own element", () => {
		const editor = mountEditor("Hello world, this is a test.");
		const blockId = firstBlockId(editor);
		// jsdom implements neither `scrollIntoView` nor (until vitest-setup.ts's
		// own global stub) `Element.animate` — mirrors marks.test.ts's own
		// `scrollToAlfyChange` test for exactly the same reason.
		const scrollIntoView = vi.fn();
		Element.prototype.scrollIntoView = scrollIntoView;

		const found = scrollToCommentAnchor(editor, blockId, 6, 11);
		expect(found).toBe(true);
		expect(scrollIntoView).toHaveBeenCalled();
		editor.destroy();
	});

	it("scrollToCommentAnchor returns false for a block that is not in the live doc", () => {
		const editor = mountEditor("Hello world.");
		expect(scrollToCommentAnchor(editor, "missing-block", 0, 3)).toBe(false);
		editor.destroy();
	});
});

describe("the Ask-Alfy chain's decorations (Wave 2.5 Step 9/11)", () => {
	function firstBlockId(editor: Editor): string {
		let id: string | null = null;
		editor.state.doc.forEach((node) => {
			if (id !== null) return;
			const value = node.attrs?.[BLOCK_ID_ATTR];
			if (typeof value === "string") id = value;
		});
		if (id === null) throw new Error("fixture has no identified block");
		return id;
	}

	it("setAlfyWritingBlock renders the gutter/dim class and the inline tag, and clears back to nothing", () => {
		const editor = mountEditor("Hello world, this is a test.");
		const blockId = firstBlockId(editor);

		setAlfyWritingBlock(editor, { blockId, tagLabel: "Alfy is writing…" });
		expect(element?.querySelector(".alfy-writing-block")).not.toBeNull();
		expect(element?.querySelector(".alfy-writing-tag")?.textContent).toContain(
			"Alfy is writing…",
		);

		setAlfyWritingBlock(editor, null);
		expect(element?.querySelector(".alfy-writing-block")).toBeNull();
		editor.destroy();
	});

	it("setAlfyWritingBlock never adds a step to the undo stack", () => {
		const editor = mountEditor("Hello world.");
		const blockId = firstBlockId(editor);
		const canUndoBefore = editor.can().undo();
		setAlfyWritingBlock(editor, { blockId, tagLabel: "Alfy is writing…" });
		expect(editor.can().undo()).toBe(canUndoBefore);
		editor.destroy();
	});

	it("setSelectionPending marks exactly the given live selection range, and clears it", () => {
		const editor = mountEditor("Hello world, this is a test.");
		// PM position 1 is the paragraph's own opening content position; "world"
		// starts 6 characters in.
		setSelectionPending(editor, { from: 1 + 6, to: 1 + 11 });
		const span = element?.querySelector(".selection-pending");
		expect(span?.textContent).toBe("world");

		setSelectionPending(editor, null);
		expect(element?.querySelector(".selection-pending")).toBeNull();
		editor.destroy();
	});

	it("setRefusedLines dashes every refused block at once", () => {
		const editor = mountEditor("First paragraph.\n\nSecond paragraph.");
		const ids: string[] = [];
		editor.state.doc.forEach((node) => {
			const value = node.attrs?.[BLOCK_ID_ATTR];
			if (typeof value === "string") ids.push(value);
		});

		setRefusedLines(editor, { blockIds: ids });
		expect(element?.querySelectorAll(".alfy-refused-line")).toHaveLength(2);

		setRefusedLines(editor, null);
		expect(element?.querySelectorAll(".alfy-refused-line")).toHaveLength(0);
		editor.destroy();
	});

	it("blockRect returns null in a test environment with no real layout (jsdom), never throws", () => {
		const editor = mountEditor("Hello world.");
		const blockId = firstBlockId(editor);
		expect(blockRect(editor, blockId)).toBeNull();
		editor.destroy();
	});

	it("blockRect returns null for a block that is not in the live doc", () => {
		const editor = mountEditor("Hello world.");
		expect(blockRect(editor, "missing-block")).toBeNull();
		editor.destroy();
	});

	it("selectAndScrollToBlock selects the whole block's text", () => {
		// Tiptap's own chainable `.focus()`/`.scrollIntoView()` depend on real
		// DOM focus/layout that jsdom does not implement (unlike
		// `scrollToCommentAnchor`'s own hand-written `Element.scrollIntoView`
		// call above, which is directly stubbable) — nothing to assert on here;
		// Playwright covers the real, visible behaviour. The selection change
		// itself is pure ProseMirror state and IS observable here.
		const editor = mountEditor("Hello world, this is a test.");
		const blockId = firstBlockId(editor);

		const found = selectAndScrollToBlock(editor, blockId);
		expect(found).toBe(true);
		expect(
			editor.state.doc.textBetween(
				editor.state.selection.from,
				editor.state.selection.to,
			),
		).toBe("Hello world, this is a test.");
		editor.destroy();
	});

	it("selectAndScrollToBlock returns false for a block that is not in the live doc", () => {
		const editor = mountEditor("Hello world.");
		expect(selectAndScrollToBlock(editor, "missing-block")).toBe(false);
		editor.destroy();
	});
});
