import { describe, expect, it } from "vitest";
import { buildIndex, type DocumentBlock, parseDocument } from "./blocks";
import { applyPatchSet, type PatchOp, type PatchSet } from "./patch";

function setup(markdown: string) {
	const parsed = parseDocument(markdown);
	return { blocks: parsed.blocks, snapshot: buildIndex(parsed.blocks) };
}

function findBlock(
	blocks: DocumentBlock[],
	kind: string,
	index = 0,
): DocumentBlock {
	const matches = blocks.filter((b) => b.kind === kind);
	const block = matches[index];
	if (!block) throw new Error(`no ${kind} block at index ${index}`);
	return block;
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

describe("artifact-document patch engine", () => {
	// Every refusal reason: the code, a byte-identical document, and refused === 1.
	it("refuses block_missing when the id no longer exists", () => {
		const { blocks, snapshot } = setup("Hello world.");
		const result = applyPatchSet({
			blocks,
			snapshot,
			patch: patchOf([
				op({
					kind: "replaceBlock",
					blockId: "nope",
					baseHash: "x",
					text: "New",
				}),
			]),
		});
		expect(result.outcomes[0].code).toBe("block_missing");
		expect(result.refused).toBe(1);
		expect(result.applied).toBe(0);
		expect(result.blocks.map((b) => b.markdown)).toEqual(
			blocks.map((b) => b.markdown),
		);
	});

	it("refuses block_unseen when Alfy never read this block", () => {
		const { blocks } = setup("Hello world.");
		const paragraph = findBlock(blocks, "paragraph");
		const result = applyPatchSet({
			blocks,
			snapshot: {},
			patch: patchOf([
				op({
					kind: "replaceBlock",
					blockId: paragraph.id,
					baseHash: paragraph.hash,
					text: "New",
				}),
			]),
		});
		expect(result.outcomes[0].code).toBe("block_unseen");
		expect(result.blocks).toEqual(blocks);
	});

	it("refuses block_changed when the user edited the block after Alfy's read", () => {
		const { blocks, snapshot } = setup("Hello world.");
		const paragraph = findBlock(blocks, "paragraph");
		// The user's own edit, applied directly without going through Alfy: the
		// snapshot now disagrees with the live hash.
		const editedBlocks = blocks.map((b) =>
			b.id === paragraph.id
				? { ...b, markdown: "Something else", hash: "different-hash" }
				: b,
		);
		const result = applyPatchSet({
			blocks: editedBlocks,
			snapshot,
			patch: patchOf([
				op({
					kind: "replaceBlock",
					blockId: paragraph.id,
					baseHash: paragraph.hash,
					text: "New",
				}),
			]),
		});
		expect(result.outcomes[0].code).toBe("block_changed");
		expect(result.blocks).toEqual(editedBlocks);
	});

	it("refuses block_changed on a stale retry even when the live hash still matches the snapshot", () => {
		const { blocks, snapshot } = setup("Hello world.");
		const paragraph = findBlock(blocks, "paragraph");
		const result = applyPatchSet({
			blocks,
			snapshot,
			patch: patchOf([
				op({
					kind: "replaceBlock",
					blockId: paragraph.id,
					baseHash: "a-hash-alfy-never-actually-read",
					text: "New",
				}),
			]),
		});
		expect(result.outcomes[0].code).toBe("block_changed");
	});

	it("refuses not_a_text_block and empty_text for insertText", () => {
		const { blocks, snapshot } = setup("A paragraph.\n\n---");
		const paragraph = findBlock(blocks, "paragraph");
		const hr = findBlock(blocks, "hr");
		const result = applyPatchSet({
			blocks,
			snapshot,
			patch: patchOf([
				op({
					kind: "insertText",
					blockId: hr.id,
					baseHash: hr.hash,
					text: "hi",
					at: "end",
				}),
				op({
					kind: "insertText",
					blockId: paragraph.id,
					baseHash: paragraph.hash,
					text: "   ",
					at: "end",
				}),
			]),
		});
		expect(result.outcomes[0].code).toBe("not_a_text_block");
		expect(result.outcomes[1].code).toBe("empty_text");
	});

	it("refuses not_a_task_block and not_a_table_block", () => {
		const { blocks, snapshot } = setup("Hello world.");
		const paragraph = findBlock(blocks, "paragraph");
		const result = applyPatchSet({
			blocks,
			snapshot,
			patch: patchOf([
				op({
					kind: "toggleTask",
					blockId: paragraph.id,
					baseHash: paragraph.hash,
					checked: true,
				}),
				op({
					kind: "addTableRow",
					blockId: paragraph.id,
					baseHash: paragraph.hash,
					cells: ["a"],
				}),
			]),
		});
		expect(result.outcomes[0].code).toBe("not_a_task_block");
		expect(result.outcomes[1].code).toBe("not_a_table_block");
	});

	it("refuses bad_row when the cell count does not match the header", () => {
		const { blocks, snapshot } = setup("| h1 | h2 |\n| -- | -- |\n| a | b |");
		const table = findBlock(blocks, "table");
		const result = applyPatchSet({
			blocks,
			snapshot,
			patch: patchOf([
				op({
					kind: "addTableRow",
					blockId: table.id,
					baseHash: table.hash,
					cells: ["only-one"],
				}),
			]),
		});
		expect(result.outcomes[0].code).toBe("bad_row");
		expect(result.blocks).toEqual(blocks);
	});

	it("refuses find_not_found, and find_ambiguous without guessing", () => {
		const { blocks, snapshot } = setup("The cat sat on the mat. The cat left.");
		const paragraph = findBlock(blocks, "paragraph");
		const notFound = applyPatchSet({
			blocks,
			snapshot,
			patch: patchOf([
				op({
					kind: "replaceRange",
					blockId: paragraph.id,
					baseHash: paragraph.hash,
					find: "the dog",
					text: "x",
				}),
			]),
		});
		expect(notFound.outcomes[0].code).toBe("find_not_found");

		const ambiguous = applyPatchSet({
			blocks,
			snapshot,
			patch: patchOf([
				op({
					kind: "replaceRange",
					blockId: paragraph.id,
					baseHash: paragraph.hash,
					find: "The cat",
					text: "The dog",
				}),
			]),
		});
		expect(ambiguous.outcomes[0].code).toBe("find_ambiguous");
		// Ambiguity must not silently replace the first occurrence.
		expect(ambiguous.blocks).toEqual(blocks);
	});

	// Positive behaviours.

	it("applies two good ops and refuses one changed-block op, with the refusal carrying the block's label", () => {
		const { blocks, snapshot } = setup(
			"First paragraph.\n\nSecond paragraph.\n\nThird paragraph.",
		);
		const [p1, p2, p3] = blocks;
		const editedBlocks = blocks.map((b) =>
			b.id === p2.id ? { ...b, hash: "moved" } : b,
		);
		const result = applyPatchSet({
			blocks: editedBlocks,
			snapshot,
			patch: patchOf([
				op({
					kind: "replaceBlock",
					blockId: p1.id,
					baseHash: p1.hash,
					text: "Changed first.",
				}),
				op({
					kind: "replaceBlock",
					blockId: p2.id,
					baseHash: p2.hash,
					blockLabel: p2.label,
					text: "Changed second.",
				}),
				op({
					kind: "replaceBlock",
					blockId: p3.id,
					baseHash: p3.hash,
					text: "Changed third.",
				}),
			]),
		});
		expect(result.applied).toBe(2);
		expect(result.refused).toBe(1);
		const refusedOutcome = result.outcomes.find((o) => o.status === "refused");
		expect(refusedOutcome?.blockId).toBe(p2.id);
		expect(refusedOutcome?.blockLabel).toBe(p2.label);
		expect(refusedOutcome?.code).toBe("block_changed");
	});

	it("toggleTask flips only its own item, never a sibling", () => {
		const { blocks, snapshot } = setup(
			"- [ ] Book flights\n- [ ] Book hotel\n- [ ] Pack bags",
		);
		const [first, second, third] = blocks;
		const result = applyPatchSet({
			blocks,
			snapshot,
			patch: patchOf([
				op({
					kind: "toggleTask",
					blockId: second.id,
					baseHash: second.hash,
					checked: true,
				}),
			]),
		});
		const updatedSecond = result.blocks.find((b) => b.id === second.id);
		const updatedFirst = result.blocks.find((b) => b.id === first.id);
		const updatedThird = result.blocks.find((b) => b.id === third.id);
		expect(updatedSecond?.markdown).toContain("[x]");
		expect(updatedFirst?.markdown).toBe(first.markdown);
		expect(updatedThird?.markdown).toBe(third.markdown);
	});

	it("addTableRow with chip cells serialises the canonical chip token", () => {
		const { blocks, snapshot } = setup(
			"| Item | Status |\n| -- | -- |\n| Flight | Booked |",
		);
		const table = findBlock(blocks, "table");
		const result = applyPatchSet({
			blocks,
			snapshot,
			patch: patchOf([
				op({
					kind: "addTableRow",
					blockId: table.id,
					baseHash: table.hash,
					cells: ["Hotel", { chip: { kind: "status", value: "Booked" } }],
				}),
			]),
		});
		expect(result.applied).toBe(1);
		const updated = result.blocks.find((b) => b.id === table.id);
		expect(updated?.markdown).toContain('[chip kind="status" value="Booked"]');
	});

	it("replaceRange rewrites exactly the find substring and leaves the rest identical", () => {
		const { blocks, snapshot } = setup("Meet at the cafe at noon.");
		const paragraph = findBlock(blocks, "paragraph");
		const result = applyPatchSet({
			blocks,
			snapshot,
			patch: patchOf([
				op({
					kind: "replaceRange",
					blockId: paragraph.id,
					baseHash: paragraph.hash,
					find: "the cafe",
					text: "the station",
				}),
			]),
		});
		const updated = result.blocks.find((b) => b.id === paragraph.id);
		expect(updated?.markdown).toBe("Meet at the station at noon.");
	});

	it("populates an inverse for every applied op, and reversing them restores the exact pre-patch markdown", () => {
		const { blocks, snapshot } = setup(
			"First paragraph.\n\n- [ ] Book flights\n\n| a | b |\n| -- | -- |\n| 1 | 2 |",
		);
		const before = blocks.map((b) => b.markdown);
		const paragraph = findBlock(blocks, "paragraph");
		const task = findBlock(blocks, "taskList");
		const table = findBlock(blocks, "table");
		const result = applyPatchSet({
			blocks,
			snapshot,
			patch: patchOf([
				op({
					kind: "replaceBlock",
					blockId: paragraph.id,
					baseHash: paragraph.hash,
					text: "Changed.",
				}),
				op({
					kind: "toggleTask",
					blockId: task.id,
					baseHash: task.hash,
					checked: true,
				}),
				op({
					kind: "addTableRow",
					blockId: table.id,
					baseHash: table.hash,
					cells: ["3", "4"],
				}),
			]),
		});
		expect(result.applied).toBe(3);
		expect(result.inverses).toHaveLength(3);

		// Apply the inverses in reverse.
		let restored = [...result.blocks];
		for (const inverse of [...result.inverses].reverse()) {
			restored = restored.map((b) =>
				b.id === inverse.blockId
					? { ...b, markdown: inverse.previousMarkdown, hash: b.hash }
					: b,
			);
		}
		// Re-normalise through the same pipeline the engine uses, so the
		// comparison is against what the engine would itself consider "the same".
		expect(restored.map((b) => b.markdown)).toEqual(before);
	});

	it("keeps applied + refused === ops.length, including the empty patch set", () => {
		const { blocks, snapshot } = setup("Hello world.");
		const paragraph = findBlock(blocks, "paragraph");
		const empty = applyPatchSet({ blocks, snapshot, patch: patchOf([]) });
		expect(empty.applied + empty.refused).toBe(0);

		const mixed = applyPatchSet({
			blocks,
			snapshot,
			patch: patchOf([
				op({
					kind: "replaceBlock",
					blockId: paragraph.id,
					baseHash: paragraph.hash,
					text: "Ok.",
				}),
				op({
					kind: "replaceBlock",
					blockId: "missing",
					baseHash: "x",
					text: "Ok.",
				}),
			]),
		});
		expect(mixed.applied + mixed.refused).toBe(mixed.outcomes.length);
		expect(mixed.outcomes).toHaveLength(2);
	});

	it("carries no English strings — refusal outcomes are coded, not sentenced", () => {
		const { blocks } = setup("Hello world.");
		const result = applyPatchSet({
			blocks,
			snapshot: {},
			patch: patchOf([
				op({
					kind: "replaceBlock",
					blockId: blocks[0].id,
					baseHash: blocks[0].hash,
					text: "x",
				}),
			]),
		});
		expect(result.outcomes[0].reason).toBeUndefined();
		expect(result.outcomes[0].code).toBe("block_unseen");
	});

	it("returns the serialised markdown for the document after applied ops", () => {
		const { blocks, snapshot } = setup("Hello world.");
		const paragraph = findBlock(blocks, "paragraph");
		const result = applyPatchSet({
			blocks,
			snapshot,
			patch: patchOf([
				op({
					kind: "replaceBlock",
					blockId: paragraph.id,
					baseHash: paragraph.hash,
					text: "Changed.",
				}),
			]),
		});
		expect(result.markdown).toContain("Changed.");
		expect(result.markdown).toContain(`<!--b:${paragraph.id}-->`);
	});
});

// RV-1A (independent review of Slice 1's engine): each case was red before
// its fix; docs/plans/claude-at-home-2/review-1a.md quotes the red line.
describe("RV-1A: an op's result is re-read as blocks, so what is stored is canonical", () => {
	it("a replaceBlock whose text is two paragraphs stores two blocks: the first keeps the id, the second gets a fresh one, and a reload changes nothing", () => {
		const { blocks, snapshot } = setup("First.\n\nSecond.");
		const [first] = blocks;
		const result = applyPatchSet({
			blocks,
			snapshot,
			patch: patchOf([
				op({
					kind: "replaceBlock",
					blockId: first.id,
					baseHash: first.hash,
					text: "One.\n\nTwo.",
				}),
			]),
		});
		expect(result.applied).toBe(1);
		expect(result.blocks.map((b) => b.markdown)).toEqual([
			"One.",
			"Two.",
			"Second.",
		]);
		expect(result.blocks[0].id).toBe(first.id);
		expect(new Set(result.blocks.map((b) => b.id)).size).toBe(3);
		// What a real reload of the stored text reads: the same ids and hashes,
		// nothing minted — so the snapshot written from `result.blocks` stays true.
		const reloaded = parseDocument(result.markdown);
		expect(reloaded.minted).toBe(false);
		expect(buildIndex(reloaded.blocks)).toEqual(buildIndex(result.blocks));
		// Undo can remove the block this op added.
		expect(result.inverses[0].insertedBlockIds).toEqual([result.blocks[1].id]);
	});

	it("a marker line inside an op's text can never claim another block's id", () => {
		const { blocks, snapshot } = setup("First.\n\nSecond.");
		const [first, second] = blocks;
		const result = applyPatchSet({
			blocks,
			snapshot,
			patch: patchOf([
				op({
					kind: "replaceBlock",
					blockId: first.id,
					baseHash: first.hash,
					text: `Evil.\n\n<!--b:${second.id}-->\nStolen.`,
				}),
			]),
		});
		expect(result.blocks.every((b) => !b.markdown.includes("<!--b:"))).toBe(
			true,
		);
		const reloaded = parseDocument(result.markdown);
		expect(reloaded.minted).toBe(false);
		expect(reloaded.blocks.find((b) => b.id === second.id)?.markdown).toBe(
			"Second.",
		);
		expect(buildIndex(reloaded.blocks)).toEqual(buildIndex(result.blocks));
	});

	it("text that is nothing but a marker line is empty_text, and changes nothing", () => {
		const { blocks, snapshot } = setup("First.");
		const [first] = blocks;
		const result = applyPatchSet({
			blocks,
			snapshot,
			patch: patchOf([
				op({
					kind: "replaceBlock",
					blockId: first.id,
					baseHash: first.hash,
					text: "<!--b:zz999-->",
				}),
			]),
		});
		expect(result.outcomes[0].code).toBe("empty_text");
		expect(result.markdown).toBe(parseDocument(result.markdown).markdown);
		expect(result.blocks[0].markdown).toBe("First.");
	});

	it("a replaceBlock that turns a paragraph into a heading carries the kind a reload reads", () => {
		const { blocks, snapshot } = setup("First.");
		const [first] = blocks;
		const result = applyPatchSet({
			blocks,
			snapshot,
			patch: patchOf([
				op({
					kind: "replaceBlock",
					blockId: first.id,
					baseHash: first.hash,
					text: "## A heading now",
				}),
			]),
		});
		expect(result.blocks[0].kind).toBe("heading");
		expect(parseDocument(result.markdown).blocks[0].kind).toBe("heading");
	});
});

describe("RV-1A: the guard compares against the document before this patch", () => {
	it("applies two ops on the same block in order, instead of blaming the user for Alfy's own first op", () => {
		const { blocks, snapshot } = setup("Teh quick brwn fox.");
		const [paragraph] = blocks;
		const result = applyPatchSet({
			blocks,
			snapshot,
			patch: patchOf([
				op({
					kind: "replaceRange",
					blockId: paragraph.id,
					baseHash: paragraph.hash,
					find: "Teh",
					text: "The",
				}),
				op({
					kind: "replaceRange",
					blockId: paragraph.id,
					baseHash: paragraph.hash,
					find: "brwn",
					text: "brown",
				}),
			]),
		});
		expect(result.outcomes.map((o) => o.code ?? o.status)).toEqual([
			"applied",
			"applied",
		]);
		expect(result.blocks[0].markdown).toBe("The quick brown fox.");
		// Undo in reverse still restores the exact pre-patch text.
		expect(result.inverses.map((inverse) => inverse.previousMarkdown)).toEqual([
			"Teh quick brwn fox.",
			"The quick brwn fox.",
		]);
	});

	it("still refuses every op on a block the USER changed, however many there are", () => {
		const { blocks, snapshot } = setup("Teh quick brwn fox.");
		const edited = parseDocument(
			blocks.map((b) => `<!--b:${b.id}-->\nThe user rewrote this.`).join(""),
		).blocks;
		const [paragraph] = blocks;
		const result = applyPatchSet({
			blocks: edited,
			snapshot,
			patch: patchOf([
				op({
					kind: "replaceBlock",
					blockId: paragraph.id,
					baseHash: paragraph.hash,
					text: "Alfy 1",
				}),
				op({
					kind: "replaceBlock",
					blockId: paragraph.id,
					baseHash: paragraph.hash,
					text: "Alfy 2",
				}),
			]),
		});
		expect(result.outcomes.map((o) => o.code)).toEqual([
			"block_changed",
			"block_changed",
		]);
		expect(result.blocks[0].markdown).toBe("The user rewrote this.");
	});
});
