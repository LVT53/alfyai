import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildIndex,
	parseDocument,
} from "$lib/shared/artifact-document/blocks";
import {
	applyPatchSet,
	type PatchOp,
	type PatchSet,
} from "$lib/shared/artifact-document/patch";
import {
	buildChangePillDecorations,
	type ChangePillCallbacks,
} from "./change-pill-decoration";
import { createDocumentEditor, loadMarkdown } from "./document-editor";
import { applyAlfyChangeMarks } from "./marks";

let element: HTMLElement | null = null;

afterEach(() => {
	element?.remove();
	element = null;
});

function setup(markdown: string) {
	element = document.createElement("div");
	document.body.appendChild(element);
	const editor = createDocumentEditor({
		element,
		markdown,
		placeholder: "Write anything, or ask Alfy to.",
	});
	const parsed = parseDocument(markdown);
	return { editor, blocks: parsed.blocks, snapshot: buildIndex(parsed.blocks) };
}

function op(
	overrides: Partial<PatchOp> & Pick<PatchOp, "blockId" | "baseHash" | "kind">,
): PatchOp {
	return {
		opId: overrides.opId ?? `op-${Math.random().toString(36).slice(2)}`,
		blockLabel: overrides.blockLabel ?? "block",
		...overrides,
	};
}

function patchOf(ops: PatchOp[]): PatchSet {
	return { patchId: "patch-1", label: "test patch", ops };
}

function noopCallbacks(): ChangePillCallbacks {
	return { onKeep: vi.fn(), onUndo: vi.fn(), onRedo: vi.fn() };
}

/** `DecorationSet` does not expose a widget's own DOM without a live view attached — exercise the widget factory directly, the same way `alfy-writing-decoration.test.ts` does. */
function widgetDom(
	set: ReturnType<typeof buildChangePillDecorations>,
): HTMLElement | null {
	const widget = (
		set.find() as unknown as { type: { toDOM?: () => Node } }[]
	).find((d) => typeof d.type.toDOM === "function");
	const node = widget?.type.toDOM?.();
	return node instanceof HTMLElement ? node : null;
}

describe("buildChangePillDecorations", () => {
	it("returns an empty set for no entries", () => {
		const { editor } = setup("First paragraph.");
		const set = buildChangePillDecorations(
			editor.state.doc,
			[],
			noopCallbacks(),
		);
		expect(set.find()).toHaveLength(0);
		editor.destroy();
	});

	it("mounts a real, interactive ChangeBar right after a live mark", () => {
		const { editor, blocks, snapshot } = setup(
			"First paragraph.\n\nSecond paragraph.",
		);
		const target = blocks[0];
		const replaceOp = op({
			kind: "replaceBlock",
			blockId: target.id,
			baseHash: target.hash,
			text: "First, edited.",
		});
		const patch = patchOf([replaceOp]);
		const result = applyPatchSet({ blocks, patch, snapshot });
		loadMarkdown(editor, result.markdown);
		const entries = applyAlfyChangeMarks(editor, result, patch);
		expect(entries).toHaveLength(1);
		const changeId = entries[0].changeId;

		const onKeep = vi.fn();
		const set = buildChangePillDecorations(
			editor.state.doc,
			[
				{
					changeId,
					blockId: target.id,
					status: "pending",
					commentCount: 0,
					blockLabel: "First, edited.",
				},
			],
			{ onKeep, onUndo: vi.fn(), onRedo: vi.fn() },
		);
		expect(set.find()).toHaveLength(1);

		const el = widgetDom(set);
		expect(el).not.toBeNull();
		document.body.appendChild(el as HTMLElement);

		const bar = el?.querySelector('[data-testid="alfy-change-bar"]');
		expect(bar).not.toBeNull();
		expect(bar?.textContent).toContain("Keep");
		// G3: the keyboard chord for Undo/Redo finds the change a focused pill
		// button belongs to through this.
		expect((el as HTMLElement).dataset.changeId).toBe(changeId);

		const keepButton = el?.querySelector(
			`button[aria-label="Keep Alfy's change"]`,
		) as HTMLButtonElement | null;
		expect(keepButton).not.toBeNull();
		keepButton?.click();
		expect(onKeep).toHaveBeenCalledOnce();

		el?.remove();
		editor.destroy();
	});

	// rd/review-2-5.md:210-216 — `blockLabel` was missing from `ChangePillEntry`
	// entirely, so the mounted pill's `role="group"` name always rendered with
	// an empty quote ("Alfy's change: ").
	it("names the mounted pill's group after the entry's own blockLabel", () => {
		const { editor, blocks, snapshot } = setup("First paragraph.");
		const target = blocks[0];
		const replaceOp = op({
			kind: "replaceBlock",
			blockId: target.id,
			baseHash: target.hash,
			text: "Book the hotel by Friday.",
		});
		const patch = patchOf([replaceOp]);
		const result = applyPatchSet({ blocks, patch, snapshot });
		loadMarkdown(editor, result.markdown);
		const entries = applyAlfyChangeMarks(editor, result, patch);
		const changeId = entries[0].changeId;

		const set = buildChangePillDecorations(
			editor.state.doc,
			[
				{
					changeId,
					blockId: target.id,
					status: "pending",
					commentCount: 0,
					blockLabel: "Book the hotel by Friday.",
				},
			],
			noopCallbacks(),
		);
		const el = widgetDom(set);
		document.body.appendChild(el as HTMLElement);

		const group = el?.querySelector('[role="group"]');
		expect(group?.getAttribute("aria-label")).toBe(
			"Alfy's change: Book the hotel by Friday.",
		);

		el?.remove();
		editor.destroy();
	});

	it("skips an entry whose mark is gone and has no fallback position", () => {
		const { editor } = setup("First paragraph.");
		const set = buildChangePillDecorations(
			editor.state.doc,
			[
				{
					changeId: "no-such-change",
					blockId: "no-such-block",
					status: "undone",
					commentCount: 0,
					blockLabel: "",
				},
			],
			noopCallbacks(),
		);
		expect(set.find()).toHaveLength(0);
		editor.destroy();
	});

	it("uses the captured fallback position once the mark is gone (Undo replaced the node)", () => {
		const { editor } = setup("First paragraph.");
		const set = buildChangePillDecorations(
			editor.state.doc,
			[
				{
					changeId: "undone-change",
					blockId: "does-not-matter",
					status: "undone",
					commentCount: 0,
					blockLabel: "First paragraph.",
					fallbackPos: 1,
				},
			],
			noopCallbacks(),
		);
		expect(set.find()).toHaveLength(1);
		editor.destroy();
	});

	it("ignores an out-of-range fallback position rather than throwing", () => {
		const { editor } = setup("First paragraph.");
		const set = buildChangePillDecorations(
			editor.state.doc,
			[
				{
					changeId: "undone-change",
					blockId: "does-not-matter",
					status: "undone",
					commentCount: 0,
					blockLabel: "First paragraph.",
					fallbackPos: 99_999,
				},
			],
			noopCallbacks(),
		);
		expect(set.find()).toHaveLength(0);
		editor.destroy();
	});
});
