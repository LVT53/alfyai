import type { Decoration } from "@tiptap/pm/view";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildAlfyWritingDecorations,
	buildRefusedLineDecorations,
	buildSelectionPendingDecorations,
} from "./alfy-writing-decoration";
import { createDocumentEditor } from "./document-editor";
import { BLOCK_ID_ATTR } from "./extensions";

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

function blockIds(editor: ReturnType<typeof createDocumentEditor>): string[] {
	const ids: string[] = [];
	editor.state.doc.forEach((node) => {
		const id = node.attrs?.[BLOCK_ID_ATTR];
		if (typeof id === "string") ids.push(id);
	});
	return ids;
}

/** `attrs` is readable at runtime but not part of prosemirror-view's public `.d.ts` — mirrors `extensions.test.ts`'s own `decorationAttrs`. */
function decorationAttrs(decoration: Decoration): Record<string, string> {
	return (decoration as unknown as { type: { attrs: Record<string, string> } })
		.type.attrs;
}

describe("buildAlfyWritingDecorations", () => {
	it("decorates the target block and appends the inline tag widget at its end", () => {
		const editor = mountEditor("First paragraph.\n\nSecond paragraph.");
		const [firstId] = blockIds(editor);
		const set = buildAlfyWritingDecorations(editor.state.doc, {
			blockId: firstId,
			tagLabel: "Alfy is writing…",
		});
		const decorations = set.find();
		// One node decoration (the gutter bar/dimming) plus one widget (the tag).
		expect(decorations).toHaveLength(2);
		const nodeDecoration = decorations.find((d) => d.spec.inline !== true);
		expect(nodeDecoration && decorationAttrs(nodeDecoration).class).toBe(
			"alfy-writing-block",
		);
		editor.destroy();
	});

	it("renders the tag widget with the already-localised label and a polite live region", () => {
		const editor = mountEditor("First paragraph.");
		const [firstId] = blockIds(editor);
		const set = buildAlfyWritingDecorations(editor.state.doc, {
			blockId: firstId,
			tagLabel: "Alfy is writing…",
		});
		// `DecorationSet` does not expose a widget's own DOM without a live
		// view attached — exercise the widget factory directly, the same way
		// ProseMirror's own renderer would call it.
		const widget = (
			set.find() as unknown as { type: { toDOM?: () => Node } }[]
		).find((d) => typeof d.type.toDOM === "function");
		const node = widget?.type.toDOM?.();
		expect(node).toBeInstanceOf(HTMLElement);
		const el = node as HTMLElement;
		expect(el.getAttribute("aria-live")).toBe("polite");
		expect(el.textContent).toContain("Alfy is writing…");
		editor.destroy();
	});

	it("decorates nothing once the target is cleared", () => {
		const editor = mountEditor("First paragraph.");
		const set = buildAlfyWritingDecorations(editor.state.doc, null);
		expect(set.find()).toHaveLength(0);
		editor.destroy();
	});

	it("decorates nothing when the target block no longer exists in the doc", () => {
		const editor = mountEditor("First paragraph.");
		const set = buildAlfyWritingDecorations(editor.state.doc, {
			blockId: "not-a-real-block",
			tagLabel: "Alfy is writing…",
		});
		expect(set.find()).toHaveLength(0);
		editor.destroy();
	});
});

describe("buildSelectionPendingDecorations", () => {
	it("marks exactly the given live selection range as pending", () => {
		const editor = mountEditor("Hello world, this is a test.");
		const from = "Hello world, this is a test.".indexOf("world") + 1; // +1: the paragraph's own opening position
		const to = from + "world".length;
		const set = buildSelectionPendingDecorations(editor.state.doc, {
			from,
			to,
		});
		const [decoration] = set.find();
		expect(decoration).toBeDefined();
		expect(decorationAttrs(decoration).class).toBe("selection-pending");
		expect(editor.state.doc.textBetween(decoration.from, decoration.to)).toBe(
			"world",
		);
		editor.destroy();
	});

	it("is empty once the pending target clears (composer closed/sent)", () => {
		const editor = mountEditor("Hello world.");
		const set = buildSelectionPendingDecorations(editor.state.doc, null);
		expect(set.find()).toHaveLength(0);
		editor.destroy();
	});

	it("is empty for an inverted or empty range rather than throwing", () => {
		const editor = mountEditor("Hello world.");
		const set = buildSelectionPendingDecorations(editor.state.doc, {
			from: 5,
			to: 5,
		});
		expect(set.find()).toHaveLength(0);
		editor.destroy();
	});

	it("clamps a stale (past the doc's current end) range instead of throwing", () => {
		const editor = mountEditor("Hi.");
		const set = buildSelectionPendingDecorations(editor.state.doc, {
			from: 1,
			to: 9999,
		});
		// Clamped to the doc's own bounds — still a valid, findable decoration.
		expect(set.find()).toHaveLength(1);
		editor.destroy();
	});
});

describe("buildRefusedLineDecorations", () => {
	it("dashes every refused block, even more than one at once", () => {
		const editor = mountEditor("First paragraph.\n\nSecond paragraph.");
		const ids = blockIds(editor);
		const set = buildRefusedLineDecorations(editor.state.doc, {
			blockIds: ids,
		});
		expect(set.find()).toHaveLength(2);
		for (const decoration of set.find()) {
			expect(decorationAttrs(decoration).class).toBe("alfy-refused-line");
		}
		editor.destroy();
	});

	it("skips a refused blockId no longer present without throwing", () => {
		const editor = mountEditor("First paragraph.");
		const set = buildRefusedLineDecorations(editor.state.doc, {
			blockIds: ["gone"],
		});
		expect(set.find()).toHaveLength(0);
		editor.destroy();
	});

	it("is empty for an empty refusal list", () => {
		const editor = mountEditor("First paragraph.");
		const set = buildRefusedLineDecorations(editor.state.doc, { blockIds: [] });
		expect(set.find()).toHaveLength(0);
		editor.destroy();
	});
});
