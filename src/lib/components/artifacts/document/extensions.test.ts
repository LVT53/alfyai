import { afterEach, describe, expect, it } from "vitest";
import type { DocumentTab } from "$lib/server/services/artifacts/serialize/document";
import { uiLanguage } from "$lib/stores/settings";
import {
	createDocumentEditor,
	readMarkdown,
	setActiveDocumentTab,
} from "./document-editor";
import {
	BLOCK_ID_ATTR,
	buildCommentAnchorDecorations,
	buildTabSectionDecorations,
	CHIP_VALUE_ATTR,
	type CommentAnchorTarget,
	commentAnchorDocRange,
	TRACKER_CHIP_NODE,
} from "./extensions";

let element: HTMLElement | null = null;

afterEach(() => {
	element?.remove();
	element = null;
	uiLanguage.set("en");
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

describe("extensions: TrackerChip", () => {
	it('parses [chip kind="status" value="Booked"] into a trackerChip node', () => {
		const editor = mountEditor('Room: [chip kind="status" value="Booked"]');
		let found: { kind: string; value: string } | null = null;
		editor.state.doc.descendants((node) => {
			if (node.type.name === TRACKER_CHIP_NODE) {
				found = { kind: node.attrs.kind, value: node.attrs[CHIP_VALUE_ATTR] };
			}
		});
		expect(found).toEqual({ kind: "status", value: "Booked" });
		editor.destroy();
	});

	it("round-trips the exact chip syntax back through readMarkdown", () => {
		const editor = mountEditor('Room: [chip kind="status" value="Booked"]');
		expect(readMarkdown(editor)).toContain(
			'[chip kind="status" value="Booked"]',
		);
		editor.destroy();
	});

	it("renders a listbox for a status chip with the localized labels", () => {
		uiLanguage.set("hu");
		const editor = mountEditor('[chip kind="status" value="Booked"]');
		const select = element?.querySelector<HTMLSelectElement>(
			".tracker-chip-select",
		);
		expect(select).toBeTruthy();
		const optionTexts = Array.from(select?.options ?? []).map(
			(o) => o.textContent,
		);
		expect(optionTexts).toEqual([
			"Lefoglalva",
			"Lefoglalandó",
			"Kifizetve",
			"Lemondva",
		]);
		expect(select?.value).toBe("Booked");
		editor.destroy();
	});

	it("choosing another status writes the canonical token, never a localized string, even under a Hungarian UI", () => {
		uiLanguage.set("hu");
		const editor = mountEditor('[chip kind="status" value="Booked"]');
		const select = element?.querySelector<HTMLSelectElement>(
			".tracker-chip-select",
		);
		expect(select).toBeTruthy();
		if (!select) throw new Error("no select rendered");

		// Simulate choosing "To book" (its OPTION VALUE is the canonical
		// token; only its visible text, "Lefoglalandó", is Hungarian).
		const targetOption = Array.from(select.options).find(
			(o) => o.value === "To book",
		);
		expect(targetOption).toBeTruthy();
		select.value = "To book";
		select.dispatchEvent(new Event("change", { bubbles: true }));

		const markdown = readMarkdown(editor);
		expect(markdown).toContain('value="To book"');
		expect(markdown).not.toContain("Lefoglalandó");
		editor.destroy();
	});
});

// Redesign §5.2 "Tabs switch sections", Wave 2.5 Step 5. Ruling 61's third
// point: "Search, export, the card preview and Alfy's reads still cover the
// whole document" — proved below by readMarkdown (search/export/Alfy's own
// read path) still returning every section regardless of which tab is
// "active" in the decoration.
describe("extensions: tab section visibility", () => {
	/** The real, minted block ids in document order — never hand-written, so a test's `startBlockId`s are always ones the doc actually has. */
	function blockIdsInOrder(
		editor: ReturnType<typeof createDocumentEditor>,
	): string[] {
		const ids: string[] = [];
		editor.state.doc.forEach((node) => {
			const id = node.attrs?.[BLOCK_ID_ATTR];
			if (typeof id === "string") ids.push(id);
		});
		return ids;
	}

	/** One tab per top-level block, for a clean, unambiguous 1:1 range mapping. */
	function tabsFromBlockIds(ids: string[]): DocumentTab[] {
		return ids.map((id, index) => ({
			id: `tab-${index}`,
			title: `Section ${index}`,
			startBlockId: id,
		}));
	}

	function paragraphDisplay(el: HTMLElement | null, index: number): string {
		const paragraphs = el?.querySelectorAll(".document-content > p") ?? [];
		return (paragraphs[index] as HTMLElement | undefined)?.style.display ?? "";
	}

	it("buildTabSectionDecorations hides every block outside the active tab's range", () => {
		const editor = mountEditor("First.\n\nSecond.\n\nThird.");
		const ids = blockIdsInOrder(editor);
		expect(ids).toHaveLength(3);
		const tabs = tabsFromBlockIds(ids);
		const blockOffsets: number[] = [];
		editor.state.doc.forEach((_node, offset) => {
			blockOffsets.push(offset);
		});

		const decorations = buildTabSectionDecorations(
			editor.state.doc,
			tabs,
			tabs[1].id,
		);
		const hiddenFrom = decorations
			.find()
			.map((deco) => deco.from)
			.sort((a, b) => a - b);
		// Exactly blocks 0 and 2 (outside tab 1's range) are hidden; block 1
		// (the active tab's own block) carries no decoration at all.
		expect(hiddenFrom).toEqual(
			[blockOffsets[0], blockOffsets[2]].sort((a, b) => a - b),
		);
		editor.destroy();
	});

	it("returns no decorations at all for a single-tab (or empty-tabs) document", () => {
		const editor = mountEditor("Only one section.");
		const ids = blockIdsInOrder(editor);
		const oneTab = tabsFromBlockIds(ids.slice(0, 1));
		expect(
			buildTabSectionDecorations(editor.state.doc, oneTab, oneTab[0].id).find(),
		).toHaveLength(0);
		expect(
			buildTabSectionDecorations(editor.state.doc, [], "").find(),
		).toHaveLength(0);
		editor.destroy();
	});

	it("setActiveDocumentTab hides the other sections' DOM and shows the active one", () => {
		const editor = mountEditor("First.\n\nSecond.\n\nThird.");
		const tabs = tabsFromBlockIds(blockIdsInOrder(editor));

		setActiveDocumentTab(editor, tabs, tabs[0].id);
		expect(paragraphDisplay(element, 0)).not.toBe("none");
		expect(paragraphDisplay(element, 1)).toBe("none");
		expect(paragraphDisplay(element, 2)).toBe("none");

		setActiveDocumentTab(editor, tabs, tabs[2].id);
		expect(paragraphDisplay(element, 0)).toBe("none");
		expect(paragraphDisplay(element, 1)).toBe("none");
		expect(paragraphDisplay(element, 2)).not.toBe("none");
		editor.destroy();
	});

	it("a block before the first recognised startBlockId falls back to the document's first tab", () => {
		const editor = mountEditor("Intro.\n\nFirst.\n\nSecond.");
		const ids = blockIdsInOrder(editor);
		// Only the LAST two blocks are named by a tab; "Intro." (block 0) has
		// no tab claiming it and must fall back to tabs[0], not stay
		// permanently orphaned/hidden regardless of the active tab.
		const tabs: DocumentTab[] = [
			{ id: "tab-0", title: "First", startBlockId: ids[1] },
			{ id: "tab-1", title: "Second", startBlockId: ids[2] },
		];

		setActiveDocumentTab(editor, tabs, "tab-0");
		expect(paragraphDisplay(element, 0)).not.toBe("none");
		expect(paragraphDisplay(element, 1)).not.toBe("none");
		expect(paragraphDisplay(element, 2)).toBe("none");
		editor.destroy();
	});

	// Regression: `Tabs.svelte`'s `addTab()` activates a brand-new tab in the
	// same breath it creates it, before that tab owns any block of its own —
	// every existing block's `startBlockId` still resolves to some OTHER,
	// real tab, so without this fallback the walk would hide the ENTIRE
	// document the instant "Add a tab" is clicked (found via
	// `artifact-document.spec.ts`'s "sustained edits" test timing out trying
	// to reach a status chip that this exact sequence had hidden).
	it("activating a brand-new tab with no block of its own shows everything, not nothing", () => {
		const editor = mountEditor("First.\n\nSecond.");
		const existingTabs = tabsFromBlockIds(blockIdsInOrder(editor));
		const tabsWithNewEmptyTab: DocumentTab[] = [
			...existingTabs,
			{ id: "tab-new", title: "New section", startBlockId: "" },
		];

		setActiveDocumentTab(editor, tabsWithNewEmptyTab, "tab-new");
		expect(paragraphDisplay(element, 0)).not.toBe("none");
		expect(paragraphDisplay(element, 1)).not.toBe("none");
		editor.destroy();
	});

	it("ruling 61: readMarkdown still returns every section's text regardless of which tab is active", () => {
		const editor = mountEditor("First.\n\nSecond.\n\nThird.");
		const tabs = tabsFromBlockIds(blockIdsInOrder(editor));

		setActiveDocumentTab(editor, tabs, tabs[1].id);
		expect(paragraphDisplay(element, 0)).toBe("none");

		const markdown = readMarkdown(editor);
		expect(markdown).toContain("First.");
		expect(markdown).toContain("Second.");
		expect(markdown).toContain("Third.");
		editor.destroy();
	});

	it("switching tabs never adds a step to the undo stack (a pure visibility change, not a document edit)", () => {
		const editor = mountEditor("First.\n\nSecond.");
		const tabs = tabsFromBlockIds(blockIdsInOrder(editor));
		const canUndoBefore = editor.can().undo();

		setActiveDocumentTab(editor, tabs, tabs[1].id);

		expect(editor.can().undo()).toBe(canUndoBefore);
	});
});

describe("extensions: CommentAnchors (redesign §3.2, Wave 2.5 Step 7)", () => {
	function firstBlockId(editor: ReturnType<typeof createDocumentEditor>): string {
		let id: string | null = null;
		editor.state.doc.forEach((node) => {
			if (id !== null) return;
			const value = node.attrs?.[BLOCK_ID_ATTR];
			if (typeof value === "string") id = value;
		});
		if (id === null) throw new Error("fixture has no identified block");
		return id;
	}

	describe("commentAnchorDocRange", () => {
		it("maps a block-relative character window onto the live doc's own positions", () => {
			const editor = mountEditor("Hello world, this is a test.");
			const blockId = firstBlockId(editor);
			const from = "Hello world, this is a test.".indexOf("world");
			const to = from + "world".length;

			const range = commentAnchorDocRange(editor.state.doc, blockId, from, to);
			expect(range).not.toBeNull();
			expect(editor.state.doc.textBetween(range?.from ?? 0, range?.to ?? 0)).toBe(
				"world",
			);
			editor.destroy();
		});

		it("returns null when the block id is not in the live doc", () => {
			const editor = mountEditor("Hello world.");
			const range = commentAnchorDocRange(editor.state.doc, "missing-block", 0, 5);
			expect(range).toBeNull();
			editor.destroy();
		});
	});

	describe("buildCommentAnchorDecorations", () => {
		it("decorates the resolved window with comment-anchor, focusable while open", () => {
			const editor = mountEditor("Hello world, this is a test.");
			const blockId = firstBlockId(editor);
			const anchors: CommentAnchorTarget[] = [
				{ commentId: "c1", blockId, from: 6, to: 11, resolved: false },
			];

			const decorations = buildCommentAnchorDecorations(
				editor.state.doc,
				anchors,
				null,
			).find();
			expect(decorations).toHaveLength(1);
			const attrs = decorations[0].type.attrs as Record<string, string>;
			expect(attrs.class).toBe("comment-anchor");
			expect(attrs["data-comment-anchor-id"]).toBe("c1");
			expect(attrs.tabindex).toBe("0");
			expect(attrs.role).toBe("button");
			editor.destroy();
		});

		it("adds is-active only for the active comment, and is-resolved for a resolved one, with no tabindex/role", () => {
			const editor = mountEditor("Hello world, this is a test.");
			const blockId = firstBlockId(editor);
			const anchors: CommentAnchorTarget[] = [
				{ commentId: "c1", blockId, from: 0, to: 5, resolved: false },
				{ commentId: "c2", blockId, from: 6, to: 11, resolved: true },
			];

			const decorations = buildCommentAnchorDecorations(
				editor.state.doc,
				anchors,
				"c1",
			).find();
			const byId = new Map(
				decorations.map((d) => [
					(d.type.attrs as Record<string, string>)["data-comment-anchor-id"],
					d.type.attrs as Record<string, string>,
				]),
			);
			expect(byId.get("c1")?.class).toBe("comment-anchor is-active");
			expect(byId.get("c2")?.class).toBe("comment-anchor is-resolved");
			expect(byId.get("c2")?.tabindex).toBeUndefined();
			expect(byId.get("c2")?.role).toBeUndefined();
			editor.destroy();
		});

		it("skips an anchor whose block is not in the live doc, without throwing", () => {
			const editor = mountEditor("Hello world.");
			const anchors: CommentAnchorTarget[] = [
				{ commentId: "gone", blockId: "missing", from: 0, to: 3, resolved: false },
			];
			expect(
				buildCommentAnchorDecorations(editor.state.doc, anchors, null).find(),
			).toHaveLength(0);
			editor.destroy();
		});

	});
});
