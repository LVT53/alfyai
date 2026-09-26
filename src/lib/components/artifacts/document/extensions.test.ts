import { afterEach, describe, expect, it } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import { createDocumentEditor, readMarkdown } from "./document-editor";
import { CHIP_VALUE_ATTR, TRACKER_CHIP_NODE } from "./extensions";

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
