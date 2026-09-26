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
	createDocumentEditor,
	loadMarkdown,
	readMarkdown,
} from "./document-editor";
import { buildDocumentExtensions } from "./extensions";
import {
	alfyChangeRect,
	applyAlfyChangeMarks,
	keepAlfyChange,
	refusalReasonI18nKey,
	scrollToAlfyChange,
	summarizeRefusals,
	undoAlfyChange,
} from "./marks";

/** A fresh extension list for each undo — never the live editor's own resolved instances (see `marks.ts`'s `undoAlfyChange` comment). */
function undo(
	editor: ReturnType<typeof createDocumentEditor>,
	entry: { blockId: string; previousMarkdown: string },
): boolean {
	return undoAlfyChange(editor, entry, buildDocumentExtensions(""));
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
 * Builds a coherent (editor, blocks, snapshot) triple: the blocks/snapshot
 * are derived from the REAL editor's own `readMarkdown` output, so their ids
 * are exactly the ids the live editor already carries — the same discipline
 * `document-editor.test.ts` uses, and required here because
 * `applyAlfyChangeMarks` locates blocks in the live editor by id.
 */
function setup(markdown: string) {
	const editor = mountEditor(markdown);
	const parsed = parseDocument(readMarkdown(editor), { mint: false });
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
	return { patchId: "patch-1", label: "Alfy's edit", ops };
}

describe("marks: applyAlfyChangeMarks", () => {
	it("marks exactly the inserted text for an insertText op, not the whole block", () => {
		const { editor, blocks, snapshot } = setup(
			"First paragraph.\n\nSecond paragraph.",
		);
		const target = blocks[0];
		const insertOp = op({
			kind: "insertText",
			blockId: target.id,
			baseHash: target.hash,
			at: "end",
			text: "Extra detail.",
		});
		const patch = patchOf([insertOp]);
		const result = applyPatchSet({ blocks, patch, snapshot });
		expect(result.applied).toBe(1);

		loadMarkdown(editor, result.markdown);
		applyAlfyChangeMarks(editor, result, patch);

		const marked = element?.querySelectorAll("[data-alfy-change-id]");
		expect(marked?.length).toBe(1);
		expect(marked?.[0].textContent).toBe("Extra detail.");
		expect(marked?.[0].getAttribute("data-alfy-change-id")).toBe(insertOp.opId);
		editor.destroy();
	});

	it("marks the whole block for a replaceBlock op", () => {
		const { editor, blocks, snapshot } = setup("Old text here.");
		const target = blocks[0];
		const replaceOp = op({
			kind: "replaceBlock",
			blockId: target.id,
			baseHash: target.hash,
			text: "Brand new text here.",
		});
		const patch = patchOf([replaceOp]);
		const result = applyPatchSet({ blocks, patch, snapshot });
		expect(result.applied).toBe(1);

		loadMarkdown(editor, result.markdown);
		applyAlfyChangeMarks(editor, result, patch);

		const marked = element?.querySelector("[data-alfy-change-id]");
		expect(marked?.textContent).toBe("Brand new text here.");
		editor.destroy();
	});

	it("never marks a refused op's block — a refused op never touched the document", () => {
		const { editor, blocks, snapshot } = setup("Some text.");
		const target = blocks[0];
		const refusedOp = op({
			kind: "replaceBlock",
			blockId: target.id,
			baseHash: "stale-hash-not-what-is-stored",
			text: "Should not apply.",
		});
		const patch = patchOf([refusedOp]);
		const result = applyPatchSet({ blocks, patch, snapshot });
		expect(result.refused).toBe(1);
		expect(result.applied).toBe(0);

		loadMarkdown(editor, result.markdown);
		applyAlfyChangeMarks(editor, result, patch);

		expect(element?.querySelectorAll("[data-alfy-change-id]").length).toBe(0);
		editor.destroy();
	});
});

describe("marks: Keep and Undo", () => {
	it("Keep clears the mark and leaves the text, preserving every block id", () => {
		const { editor, blocks, snapshot } = setup("Alpha.\n\nBeta.\n\nGamma.");
		const target = blocks[1];
		const idsBefore = blocks.map((b) => b.id);
		const replaceOp = op({
			kind: "replaceBlock",
			blockId: target.id,
			baseHash: target.hash,
			text: "Beta, revised.",
		});
		const patch = patchOf([replaceOp]);
		const result = applyPatchSet({ blocks, patch, snapshot });

		loadMarkdown(editor, result.markdown);
		const entries = applyAlfyChangeMarks(editor, result, patch);
		expect(entries).toHaveLength(1);

		const cleared = keepAlfyChange(editor, entries[0].changeId);
		expect(cleared).toBe(true);
		expect(element?.querySelectorAll("[data-alfy-change-id]").length).toBe(0);

		const after = parseDocument(readMarkdown(editor), { mint: false });
		expect(after.blocks.map((b) => b.id)).toEqual(idsBefore);
		expect(after.blocks[1].markdown).toBe("Beta, revised.");
		editor.destroy();
	});

	it("Undo removes exactly that change and restores the previous text byte-for-byte, preserving ids", () => {
		const { editor, blocks, snapshot } = setup("Alpha.\n\nBeta.\n\nGamma.");
		const target = blocks[1];
		const idsBefore = blocks.map((b) => b.id);
		const replaceOp = op({
			kind: "replaceBlock",
			blockId: target.id,
			baseHash: target.hash,
			text: "Beta, revised.",
		});
		const patch = patchOf([replaceOp]);
		const result = applyPatchSet({ blocks, patch, snapshot });

		loadMarkdown(editor, result.markdown);
		const entries = applyAlfyChangeMarks(editor, result, patch);
		expect(result.inverses[0].previousMarkdown).toBe("Beta.");

		const undone = undo(editor, entries[0]);
		expect(undone).toBe(true);

		const after = parseDocument(readMarkdown(editor), { mint: false });
		expect(after.blocks.map((b) => b.id)).toEqual(idsBefore);
		expect(after.blocks[1].markdown).toBe("Beta.");
		// The OTHER blocks are untouched.
		expect(after.blocks[0].markdown).toBe("Alpha.");
		expect(after.blocks[2].markdown).toBe("Gamma.");
		// The mark is gone too — a fresh block carries no leftover annotation.
		expect(element?.querySelectorAll("[data-alfy-change-id]").length).toBe(0);
		editor.destroy();
	});

	it("Undo twice is an error-free no-op — the inverse is applied once, in effect", () => {
		const { editor, blocks, snapshot } = setup("Only paragraph.");
		const target = blocks[0];
		const replaceOp = op({
			kind: "replaceBlock",
			blockId: target.id,
			baseHash: target.hash,
			text: "Replaced.",
		});
		const patch = patchOf([replaceOp]);
		const result = applyPatchSet({ blocks, patch, snapshot });
		loadMarkdown(editor, result.markdown);
		const entries = applyAlfyChangeMarks(editor, result, patch);

		expect(() => undo(editor, entries[0])).not.toThrow();
		const afterFirst = readMarkdown(editor);
		expect(() => undo(editor, entries[0])).not.toThrow();
		const afterSecond = readMarkdown(editor);
		expect(afterSecond).toBe(afterFirst);
		editor.destroy();
	});

	it("a second patch to the same block after Keep applies; after Undo the same patch refuses block_changed", () => {
		const { editor, blocks, snapshot } = setup("Only paragraph.");
		const target = blocks[0];
		const firstOp = op({
			kind: "replaceBlock",
			blockId: target.id,
			baseHash: target.hash,
			text: "First edit.",
		});
		const firstPatch = patchOf([firstOp]);
		const firstResult = applyPatchSet({ blocks, patch: firstPatch, snapshot });
		expect(firstResult.applied).toBe(1);

		// A snapshot refreshed against the post-first-edit state (what a second
		// `read_artifact` would record) — Keep leaves the text as applied, so a
		// second edit against this hash is legitimate and applies.
		const snapshotAfterFirst = buildIndex(firstResult.blocks);
		const secondOp = op({
			kind: "replaceBlock",
			blockId: target.id,
			baseHash: firstResult.blocks[0].hash,
			text: "Second edit.",
		});
		const secondPatch = patchOf([secondOp]);
		const secondResult = applyPatchSet({
			blocks: firstResult.blocks,
			patch: secondPatch,
			snapshot: snapshotAfterFirst,
		});
		expect(secondResult.applied).toBe(1);

		// Now Undo the FIRST change instead: the live document (post-first-edit)
		// reverts to the pre-patch text, but the snapshot Alfy would still be
		// holding from writing the first edit remembers the POST-first-edit
		// hash — so the same second patch, addressed with that now-stale
		// baseHash, is refused: the user's Undo is itself a user edit.
		loadMarkdown(editor, firstResult.markdown);
		const entries = applyAlfyChangeMarks(editor, firstResult, firstPatch);
		undo(editor, entries[0]);

		const afterUndo = parseDocument(readMarkdown(editor), { mint: false });
		const replay = applyPatchSet({
			blocks: afterUndo.blocks,
			patch: secondPatch,
			snapshot: snapshotAfterFirst,
		});
		expect(replay.applied).toBe(0);
		expect(replay.refused).toBe(1);
		expect(replay.outcomes[0].code).toBe("block_changed");
		editor.destroy();
	});
});

describe("marks: summarizeRefusals / refusalReasonI18nKey", () => {
	it("returns null when nothing was refused", () => {
		const { blocks, snapshot } = setup("Text.");
		const result = applyPatchSet({
			blocks,
			patch: patchOf([
				op({
					kind: "replaceBlock",
					blockId: blocks[0].id,
					baseHash: blocks[0].hash,
					text: "New.",
				}),
			]),
			snapshot,
		});
		expect(summarizeRefusals(result)).toBeNull();
	});

	it("names the block label and code for every refused op", () => {
		const { blocks, snapshot } = setup("Text.");
		const result = applyPatchSet({
			blocks,
			patch: patchOf([
				op({
					kind: "replaceBlock",
					blockId: blocks[0].id,
					baseHash: "not-the-real-hash",
					blockLabel: "Hotel budget",
					text: "New.",
				}),
			]),
			snapshot,
		});
		const summary = summarizeRefusals(result);
		expect(summary).not.toBeNull();
		expect(summary?.count).toBe(1);
		expect(summary?.items[0]).toEqual({
			blockId: blocks[0].id,
			blockLabel: "Hotel budget",
			code: "block_changed",
		});
	});

	it("maps every RefusalReason onto one of the five defined notice keys", () => {
		expect(refusalReasonI18nKey("block_changed")).toBe(
			"artifacts.document.refused.changed",
		);
		expect(refusalReasonI18nKey("block_unseen")).toBe(
			"artifacts.document.refused.unseen",
		);
		expect(refusalReasonI18nKey("block_missing")).toBe(
			"artifacts.document.refused.missing",
		);
		expect(refusalReasonI18nKey("find_ambiguous")).toBe(
			"artifacts.document.refused.ambiguous",
		);
		expect(refusalReasonI18nKey("bad_row")).toBe(
			"artifacts.document.refused.other",
		);
		expect(refusalReasonI18nKey("not_a_text_block")).toBe(
			"artifacts.document.refused.other",
		);
	});
});

describe("marks: alfyChangeRect / scrollToAlfyChange (the inline bar's positioning)", () => {
	it("returns null for a changeId with no mark, without throwing", () => {
		const { editor } = setup("First paragraph.");
		expect(() => alfyChangeRect(editor, "no-such-change")).not.toThrow();
		expect(alfyChangeRect(editor, "no-such-change")).toBeNull();
		expect(scrollToAlfyChange(editor, "no-such-change")).toBe(false);
	});

	it("combines the mark's start/end coords into one rect", () => {
		const { editor, blocks, snapshot } = setup(
			"First paragraph.\n\nSecond paragraph.",
		);
		const target = blocks[0];
		const insertOp = op({
			kind: "insertText",
			blockId: target.id,
			baseHash: target.hash,
			at: "end",
			text: "Extra.",
		});
		const patch = patchOf([insertOp]);
		const result = applyPatchSet({ blocks, patch, snapshot });
		loadMarkdown(editor, result.markdown);
		const entries = applyAlfyChangeMarks(editor, result, patch);

		let call = 0;
		editor.view.coordsAtPos = (() => {
			call += 1;
			// First call is the range's `from`, second is `to` — distinct
			// values on each side prove the function combines both, not just
			// one repeated coordinate.
			return call === 1
				? { top: 10, left: 20, right: 21, bottom: 40 }
				: { top: 11, left: 29, right: 30, bottom: 41 };
		}) as typeof editor.view.coordsAtPos;

		const rect = alfyChangeRect(editor, entries[0].changeId);
		// top/left come from the range's start coords, right/bottom from its end.
		expect(rect).toEqual({ top: 10, left: 20, right: 30, bottom: 41 });
	});

	it("scrolls the mark's DOM node into view when one exists", () => {
		const { editor, blocks, snapshot } = setup(
			"First paragraph.\n\nSecond paragraph.",
		);
		const target = blocks[0];
		const insertOp = op({
			kind: "insertText",
			blockId: target.id,
			baseHash: target.hash,
			at: "end",
			text: "Extra.",
		});
		const patch = patchOf([insertOp]);
		const result = applyPatchSet({ blocks, patch, snapshot });
		loadMarkdown(editor, result.markdown);
		const entries = applyAlfyChangeMarks(editor, result, patch);

		const scrollIntoView = vi.fn();
		Element.prototype.scrollIntoView = scrollIntoView;

		expect(scrollToAlfyChange(editor, entries[0].changeId)).toBe(true);
		expect(scrollIntoView).toHaveBeenCalled();
	});
});
