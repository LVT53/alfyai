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
	buildTabSectionDecorations,
	CHIP_VALUE_ATTR,
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
