import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildIndex,
	EMPTY_TAB_ANCHOR_PLACEHOLDER,
	parseDocument,
	stripEmptyTabAnchorPlaceholder,
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
	alfyChangeDocRange,
	applyAlfyChangeMarks,
	keepAlfyChange,
	type RedoBlock,
	redoAlfyChange,
	refusalReasonI18nKey,
	remarkAlfyChange,
	scrollToAlfyChange,
	summarizeRefusals,
	undoAlfyChange,
} from "./marks";

/** A fresh extension list for each undo — never the live editor's own resolved instances (see `marks.ts`'s `undoAlfyChange` comment). */
function undo(
	editor: ReturnType<typeof createDocumentEditor>,
	entry: {
		blockId: string;
		previousMarkdown: string;
		insertedBlockIds?: string[];
		isNewBlock?: boolean;
	},
): boolean {
	return undoAlfyChange(editor, entry, buildDocumentExtensions(""));
}

/** Same fresh-extensions rule as `undo` above. */
function redo(
	editor: ReturnType<typeof createDocumentEditor>,
	entry: {
		blockId: string;
		appliedMarkdown: string;
		insertedBlocks?: RedoBlock[];
	},
): boolean {
	return redoAlfyChange(editor, entry, buildDocumentExtensions(""));
}

let element: HTMLElement | null = null;

afterEach(() => {
	element?.remove();
	element = null;
});

function mountEditor(markdown: string, onUpdate?: () => void) {
	element = document.createElement("div");
	document.body.appendChild(element);
	return createDocumentEditor({
		element,
		markdown,
		placeholder: "Write anything, or ask Alfy to.",
		onUpdate,
	});
}

/**
 * Builds a coherent (editor, blocks, snapshot) triple: the blocks/snapshot
 * are derived from the REAL editor's own `readMarkdown` output, so their ids
 * are exactly the ids the live editor already carries — the same discipline
 * `document-editor.test.ts` uses, and required here because
 * `applyAlfyChangeMarks` locates blocks in the live editor by id.
 */
function setup(markdown: string, onUpdate?: () => void) {
	const editor = mountEditor(markdown, onUpdate);
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

	it("renders the mark with the visible alfy-change class and the arrive settle animation (§7.2/§9.1)", () => {
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

		loadMarkdown(editor, result.markdown);
		applyAlfyChangeMarks(editor, result, patch);

		const marked = element?.querySelector("[data-alfy-change-id]");
		expect(marked?.classList.contains("alfy-change")).toBe(true);
		expect(marked?.classList.contains("arrive")).toBe(true);
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

	// RV-1B, coordinator item 7: an op's own `text` can read back as MORE than
	// one block (a paragraph Alfy split in two, a new section appended) —
	// `patch.ts`'s `reblock` mints a fresh id for every block beyond the
	// first and records them as `PatchInverse.insertedBlockIds`. An exact
	// Undo has to remove those too, not just restore the first block's text,
	// or "blocks Alfy added" stay in the document forever.
	it("Undo also removes the extra blocks an op's own text produced, not just the first block's content", () => {
		const { editor, blocks, snapshot } = setup("Alpha.\n\nBeta.\n\nGamma.");
		const target = blocks[1];
		const idsBefore = blocks.map((b) => b.id);
		const replaceOp = op({
			kind: "replaceBlock",
			blockId: target.id,
			baseHash: target.hash,
			text: "Beta, revised.\n\nBeta's new second paragraph.",
		});
		const patch = patchOf([replaceOp]);
		const result = applyPatchSet({ blocks, patch, snapshot });
		expect(result.inverses[0].insertedBlockIds).toHaveLength(1);
		const insertedId = result.inverses[0].insertedBlockIds?.[0];

		loadMarkdown(editor, result.markdown);
		const entries = applyAlfyChangeMarks(editor, result, patch);
		expect(entries[0].insertedBlockIds).toEqual([insertedId]);

		// Confirms the inserted block genuinely landed in the live document
		// first — otherwise its absence after Undo would prove nothing.
		const beforeUndo = parseDocument(readMarkdown(editor), { mint: false });
		expect(beforeUndo.blocks.map((b) => b.id)).toContain(insertedId);
		expect(beforeUndo.blocks).toHaveLength(4);

		const undone = undo(editor, entries[0]);
		expect(undone).toBe(true);

		const after = parseDocument(readMarkdown(editor), { mint: false });
		expect(after.blocks.map((b) => b.id)).toEqual(idsBefore);
		expect(after.blocks.map((b) => b.id)).not.toContain(insertedId);
		expect(after.blocks[1].markdown).toBe("Beta.");
		expect(after.blocks[0].markdown).toBe("Alpha.");
		expect(after.blocks[2].markdown).toBe("Gamma.");
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

	it("Undo of a ruling-61 reload-restored NEW block deletes it instead of replacing it with empty content", () => {
		// A real op that produces a genuinely new block (`reblock`'s own mint),
		// exactly like the "extra blocks" test above — but here the NEW block
		// itself is what ruling 61's reload path would report as pending (no
		// parent counterpart), never the first (existing) block.
		const { editor, blocks, snapshot } = setup("Alpha.\n\nBeta.\n\nGamma.");
		const target = blocks[1];
		const replaceOp = op({
			kind: "replaceBlock",
			blockId: target.id,
			baseHash: target.hash,
			text: "Beta, revised.\n\nBeta's new second paragraph.",
		});
		const patch = patchOf([replaceOp]);
		const result = applyPatchSet({ blocks, patch, snapshot });
		const insertedId = result.inverses[0].insertedBlockIds?.[0];
		if (!insertedId) throw new Error("expected an inserted block id");

		loadMarkdown(editor, result.markdown);
		const beforeUndo = parseDocument(readMarkdown(editor), { mint: false });
		expect(beforeUndo.blocks.map((b) => b.id)).toContain(insertedId);

		const undone = undo(editor, {
			blockId: insertedId,
			previousMarkdown: "",
			isNewBlock: true,
		});
		expect(undone).toBe(true);

		const after = parseDocument(readMarkdown(editor), { mint: false });
		expect(after.blocks.map((b) => b.id)).not.toContain(insertedId);
		// The block it was NOT undoing (the first, existing one) is untouched.
		expect(after.blocks.some((b) => b.markdown === "Beta, revised.")).toBe(
			true,
		);
		editor.destroy();
	});
});

// Follow-up chip (rd4b deviation 5) — a block that already existed but whose
// text was blank before Alfy filled it in is NOT a block Alfy added: Undo has
// to put a blank block back, not delete it and not let it fall out of the
// document. The Markdown model cannot store an empty block at all (a marker
// with no text after it is dropped on the next save — `blocks.ts`'s
// `splitIntoSegments`), so "restore a blank block" has to mean the one
// blank a save keeps: the zero-width-space anchor a new tab already uses.
describe("marks: Undo of an existing block whose previous text is blank", () => {
	it("keeps the block, with its id, through a save and reload — the document does not lose a block", () => {
		const { editor, blocks } = setup("Alpha.\n\nBeta.\n\nGamma.");
		const idsBefore = blocks.map((b) => b.id);

		const undone = undo(editor, {
			blockId: blocks[1].id,
			previousMarkdown: "",
		});
		expect(undone).toBe(true);

		// What the autosave posts and the server stores: the canonical form.
		const saved = parseDocument(readMarkdown(editor), { mint: false });
		expect(saved.blocks.map((b) => b.id)).toEqual(idsBefore);
		expect(stripEmptyTabAnchorPlaceholder(saved.blocks[1].markdown)).toBe("");
		expect(saved.blocks[0].markdown).toBe("Alpha.");
		expect(saved.blocks[2].markdown).toBe("Gamma.");

		// ...and reading it back gives the same three blocks again.
		element?.remove();
		const reloaded = mountEditor(saved.markdown);
		const reread = parseDocument(readMarkdown(reloaded), { mint: false });
		expect(reread.blocks.map((b) => b.id)).toEqual(idsBefore);
		reloaded.destroy();
		editor.destroy();
	});

	it("reads as blank to everyone outside the editor (the placeholder is the only text)", () => {
		const { editor, blocks } = setup("Alpha.\n\nBeta.");
		undo(editor, { blockId: blocks[1].id, previousMarkdown: "" });
		const after = parseDocument(readMarkdown(editor), { mint: false });
		expect(after.blocks[1].markdown).toBe(EMPTY_TAB_ANCHOR_PLACEHOLDER);
		editor.destroy();
	});

	it("a block that Alfy ADDED (isNewBlock) is still removed, never left behind as a blank one", () => {
		const { editor, blocks } = setup("Alpha.\n\nBeta.\n\nGamma.");
		const undone = undo(editor, {
			blockId: blocks[1].id,
			previousMarkdown: "",
			isNewBlock: true,
		});
		expect(undone).toBe(true);
		const after = parseDocument(readMarkdown(editor), { mint: false });
		expect(after.blocks.map((b) => b.id)).toEqual([blocks[0].id, blocks[2].id]);
		editor.destroy();
	});

	it("tells the two apart in the same document: one Undo deletes the added block, the next restores the blank one", () => {
		const { editor, blocks } = setup("Alpha.\n\nBeta.\n\nGamma.");
		undo(editor, {
			blockId: blocks[0].id,
			previousMarkdown: "",
			isNewBlock: true,
		});
		undo(editor, { blockId: blocks[2].id, previousMarkdown: "" });
		const after = parseDocument(readMarkdown(editor), { mint: false });
		expect(after.blocks.map((b) => b.id)).toEqual([blocks[1].id, blocks[2].id]);
		expect(after.blocks[0].markdown).toBe("Beta.");
		expect(stripEmptyTabAnchorPlaceholder(after.blocks[1].markdown)).toBe("");
		editor.destroy();
	});
});

// rd4b deviation 1: Redo after Undo restored the first block only — the extra
// blocks a multi-block insert had produced stayed gone.
describe("marks: Redo after Undo of a multi-block change", () => {
	function multiBlockChange() {
		const { editor, blocks, snapshot } = setup("Alpha.\n\nBeta.\n\nGamma.");
		const target = blocks[1];
		const patch = patchOf([
			op({
				kind: "replaceBlock",
				blockId: target.id,
				baseHash: target.hash,
				text: "Beta, revised.\n\nBeta's second paragraph.\n\n- a list Alfy added",
			}),
		]);
		const result = applyPatchSet({ blocks, patch, snapshot });
		loadMarkdown(editor, result.markdown);
		const entries = applyAlfyChangeMarks(editor, result, patch);
		const applied = parseDocument(readMarkdown(editor), { mint: false });
		return { editor, blocks, entries, applied };
	}

	it("puts back the first block's applied text AND every block the insert added, in order, with their ids", () => {
		const { editor, entries, applied } = multiBlockChange();
		const entry = entries[0];
		expect(entry.insertedBlockIds).toHaveLength(2);
		expect(applied.blocks).toHaveLength(5);

		// What DocumentBody captures from its blocks state before it undoes.
		const appliedMarkdown = applied.blocks.find((b) => b.id === entry.blockId)
			?.markdown as string;
		const insertedBlocks: RedoBlock[] = (entry.insertedBlockIds ?? []).map(
			(blockId) => ({
				blockId,
				markdown: applied.blocks.find((b) => b.id === blockId)
					?.markdown as string,
			}),
		);

		expect(undo(editor, entry)).toBe(true);
		const undone = parseDocument(readMarkdown(editor), { mint: false });
		expect(undone.blocks).toHaveLength(3);

		expect(
			redo(editor, { blockId: entry.blockId, appliedMarkdown, insertedBlocks }),
		).toBe(true);
		const redone = parseDocument(readMarkdown(editor), { mint: false });
		expect(redone.blocks.map((b) => [b.id, b.markdown])).toEqual(
			applied.blocks.map((b) => [b.id, b.markdown]),
		);
		editor.destroy();
	});

	it("Undo, Redo, Undo again lands on the original document each time", () => {
		const { editor, blocks, entries, applied } = multiBlockChange();
		const entry = entries[0];
		const appliedMarkdown = applied.blocks.find((b) => b.id === entry.blockId)
			?.markdown as string;
		const insertedBlocks: RedoBlock[] = (entry.insertedBlockIds ?? []).map(
			(blockId) => ({
				blockId,
				markdown: applied.blocks.find((b) => b.id === blockId)
					?.markdown as string,
			}),
		);
		undo(editor, entry);
		redo(editor, { blockId: entry.blockId, appliedMarkdown, insertedBlocks });
		undo(editor, entry);
		const after = parseDocument(readMarkdown(editor), { mint: false });
		expect(after.blocks.map((b) => [b.id, b.markdown])).toEqual(
			blocks.map((b) => [b.id, b.markdown]),
		);
		editor.destroy();
	});

	it("is a no-op for a block that is already there (a second Redo adds nothing twice)", () => {
		const { editor, entries, applied } = multiBlockChange();
		const entry = entries[0];
		const appliedMarkdown = applied.blocks.find((b) => b.id === entry.blockId)
			?.markdown as string;
		const insertedBlocks: RedoBlock[] = (entry.insertedBlockIds ?? []).map(
			(blockId) => ({
				blockId,
				markdown: applied.blocks.find((b) => b.id === blockId)
					?.markdown as string,
			}),
		);
		undo(editor, entry);
		redo(editor, { blockId: entry.blockId, appliedMarkdown, insertedBlocks });
		redo(editor, { blockId: entry.blockId, appliedMarkdown, insertedBlocks });
		const after = parseDocument(readMarkdown(editor), { mint: false });
		expect(after.blocks.map((b) => b.id)).toEqual(
			applied.blocks.map((b) => b.id),
		);
		editor.destroy();
	});

	it("a change with no inserted blocks redoes exactly like before (the first block's text)", () => {
		const { editor, blocks, snapshot } = setup("Alpha.\n\nBeta.\n\nGamma.");
		const target = blocks[1];
		const patch = patchOf([
			op({
				kind: "replaceBlock",
				blockId: target.id,
				baseHash: target.hash,
				text: "Beta, revised.",
			}),
		]);
		const result = applyPatchSet({ blocks, patch, snapshot });
		loadMarkdown(editor, result.markdown);
		const entries = applyAlfyChangeMarks(editor, result, patch);
		undo(editor, entries[0]);
		redo(editor, {
			blockId: entries[0].blockId,
			appliedMarkdown: "Beta, revised.",
		});
		const after = parseDocument(readMarkdown(editor), { mint: false });
		expect(after.blocks.map((b) => b.markdown)).toEqual([
			"Alpha.",
			"Beta, revised.",
			"Gamma.",
		]);
		editor.destroy();
	});
});

describe("marks: remarkAlfyChange", () => {
	it("marks a whole block, for a caller with no op-level precision (Redo, ruling 61's reload restore)", () => {
		const { editor, blocks } = setup("Alpha.\n\nBeta.");
		const target = blocks[1];

		const marked = remarkAlfyChange(editor, "resurrected-change", target.id);
		expect(marked).toBe(true);
		expect(
			element?.querySelector(`[data-alfy-change-id="resurrected-change"]`)
				?.textContent,
		).toBe("Beta.");

		const range = alfyChangeDocRange(editor, "resurrected-change");
		expect(range).not.toBeNull();
		editor.destroy();
	});

	it("returns false for a block that is not in the document", () => {
		const { editor } = setup("Alpha.");
		expect(remarkAlfyChange(editor, "change-1", "no-such-block")).toBe(false);
		editor.destroy();
	});
});

// rd/review-2-5.md:109-121 — opening a Document with pending changes wrote an
// empty "Edited" user version: `applyAlfyChangeMarks`/`keepAlfyChange`/
// `remarkAlfyChange` are mark-only transactions (they add or remove the
// AlfyChange mark over text a patch already applied elsewhere), but none of
// them told Tiptap so — `DocumentBody.svelte`'s `handleUpdate` treated the
// resulting `onUpdate` fire as a real user edit and autosaved. `undoAlfyChange`
// is the control: Undo genuinely changes the document's content (ruling 61:
// "Undo restores the parent's content... as a user edit") and must keep firing
// `onUpdate` so it keeps producing a real saved version.
describe("marks: mark-only transactions never fire onUpdate (rd/review-2-5.md:109-121)", () => {
	it("applyAlfyChangeMarks does not fire onUpdate — a patch's mark-add is not itself a user edit", () => {
		const onUpdate = vi.fn();
		const { editor, blocks, snapshot } = setup("Alpha.\n\nBeta.", onUpdate);
		const target = blocks[0];
		const replaceOp = op({
			kind: "replaceBlock",
			blockId: target.id,
			baseHash: target.hash,
			text: "Alpha, revised.",
		});
		const patch = patchOf([replaceOp]);
		const result = applyPatchSet({ blocks, patch, snapshot });

		loadMarkdown(editor, result.markdown);
		onUpdate.mockClear(); // isolate applyAlfyChangeMarks's own dispatch
		const entries = applyAlfyChangeMarks(editor, result, patch);
		expect(entries).toHaveLength(1);
		expect(onUpdate).not.toHaveBeenCalled();
		editor.destroy();
	});

	it("keepAlfyChange does not fire onUpdate — Keep's own persistence goes through the review API, not a body save", () => {
		const onUpdate = vi.fn();
		const { editor, blocks, snapshot } = setup("Alpha.\n\nBeta.", onUpdate);
		const target = blocks[0];
		const replaceOp = op({
			kind: "replaceBlock",
			blockId: target.id,
			baseHash: target.hash,
			text: "Alpha, revised.",
		});
		const patch = patchOf([replaceOp]);
		const result = applyPatchSet({ blocks, patch, snapshot });
		loadMarkdown(editor, result.markdown);
		const entries = applyAlfyChangeMarks(editor, result, patch);
		onUpdate.mockClear();

		const cleared = keepAlfyChange(editor, entries[0].changeId);
		expect(cleared).toBe(true);
		expect(onUpdate).not.toHaveBeenCalled();
		editor.destroy();
	});

	it("remarkAlfyChange does not fire onUpdate — merely opening a document with a ruling-61 pending block must not autosave", () => {
		const onUpdate = vi.fn();
		const { editor, blocks } = setup("Alpha.\n\nBeta.", onUpdate);
		onUpdate.mockClear();

		const marked = remarkAlfyChange(editor, "restored-change", blocks[0].id);
		expect(marked).toBe(true);
		expect(onUpdate).not.toHaveBeenCalled();
		editor.destroy();
	});

	it("undoAlfyChange DOES still fire onUpdate — Undo is a real, save-worthy edit, not a mark-only transaction", () => {
		const onUpdate = vi.fn();
		const { editor, blocks, snapshot } = setup("Alpha.\n\nBeta.", onUpdate);
		const target = blocks[0];
		const replaceOp = op({
			kind: "replaceBlock",
			blockId: target.id,
			baseHash: target.hash,
			text: "Alpha, revised.",
		});
		const patch = patchOf([replaceOp]);
		const result = applyPatchSet({ blocks, patch, snapshot });
		loadMarkdown(editor, result.markdown);
		const entries = applyAlfyChangeMarks(editor, result, patch);
		onUpdate.mockClear();

		const undone = undo(editor, entries[0]);
		expect(undone).toBe(true);
		expect(onUpdate).toHaveBeenCalledTimes(1);
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

describe("marks: alfyChangeDocRange / scrollToAlfyChange (the inline pill's positioning)", () => {
	it("returns null for a changeId with no mark, without throwing", () => {
		const { editor } = setup("First paragraph.");
		expect(() => alfyChangeDocRange(editor, "no-such-change")).not.toThrow();
		expect(alfyChangeDocRange(editor, "no-such-change")).toBeNull();
		expect(scrollToAlfyChange(editor, "no-such-change")).toBe(false);
	});

	it("finds the mark's own live document range", () => {
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

		const range = alfyChangeDocRange(editor, entries[0].changeId);
		expect(range).not.toBeNull();
		expect(range?.from).toBeLessThan(range?.to ?? 0);
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
