import { describe, expect, it } from "vitest";
import {
	alignDocuments,
	changeBlocks,
	diffWords,
	foldUnchanged,
} from "./document-diff";

// A Document body the way the server stores it: one marker line before every
// block, the block's id written into the Markdown (never minted by a reader).
function body(...blocks: Array<[string, string]>): string {
	return blocks.map(([id, text]) => `<!--b:${id}-->\n${text}`).join("\n\n");
}

describe("diffWords", () => {
	it("marks the words added and the words removed, keeping the unchanged ones", () => {
		const ops = diffWords(
			"Morning at the Belvedere, then a walk.",
			"Morning at the Belvedere, then a cafe and a walk.",
		);
		expect(
			ops.filter((op) => op.type === "add").map((op) => op.text.trim()),
		).toEqual(["cafe and a"]);
		expect(ops.filter((op) => op.type === "del")).toEqual([]);
		// Joining what stays and what is added gives the new text back.
		expect(
			ops
				.filter((op) => op.type !== "del")
				.map((op) => op.text)
				.join(""),
		).toBe("Morning at the Belvedere, then a cafe and a walk.");
	});

	it("reads a replaced word as a deletion and an addition", () => {
		const ops = diffWords(
			"Visit the Belvedere on Saturday",
			"Visit the Albertina on Saturday",
		);
		expect(ops.find((op) => op.type === "del")?.text).toBe("Belvedere");
		expect(ops.find((op) => op.type === "add")?.text).toBe("Albertina");
	});

	it("tokenises Hungarian letters as words, not as punctuation", () => {
		const ops = diffWords("Reggel a Belvederében", "Reggel az Albertinában");
		const joined = (type: "add" | "del") =>
			ops
				.filter((op) => op.type === type)
				.map((op) => op.text)
				.join("|");
		// Whole words go, whole words come: no "é" or "á" split off as punctuation.
		expect(joined("del")).toBe("a|Belvederében");
		expect(joined("add")).toBe("az|Albertinában");
	});

	it("is one deletion and one addition when the texts are too long to compare word by word", () => {
		const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join(" ");
		const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join(" ");
		const ops = diffWords(a, b);
		expect(ops.map((op) => op.type)).toEqual(["del", "add"]);
	});

	it("is empty-handed for equal texts", () => {
		expect(diffWords("same words", "same words")).toEqual([
			{ type: "same", text: "same words" },
		]);
	});
});

describe("alignDocuments", () => {
	it("matches blocks by id: an edited block is changed, an untouched one is the same", () => {
		const before = body(
			["a", "Friday"],
			["b", "Arrive and walk."],
			["c", "Saturday"],
		);
		const after = body(
			["a", "Friday"],
			["b", "Arrive, walk and eat."],
			["c", "Saturday"],
		);
		const blocks = alignDocuments(before, after);
		expect(blocks.map((block) => block.type)).toEqual([
			"same",
			"changed",
			"same",
		]);
		const changed = blocks[1];
		expect(changed.type === "changed" && changed.baseMarkdown).toBe(
			"Arrive and walk.",
		);
	});

	it("reads a block only the new text has as added, and one only the old text has as removed, in the place it stood", () => {
		const before = body(["a", "One"], ["b", "Two"], ["c", "Three"]);
		const after = body(["a", "One"], ["n", "New"], ["c", "Three"]);
		const blocks = alignDocuments(before, after);
		expect(blocks.map((block) => block.type)).toEqual([
			"same",
			"removed",
			"added",
			"same",
		]);
		expect(blocks[1].type === "removed" && blocks[1].label).toBe("Two");
		expect(blocks[2].markdown).toBe("New");
	});

	it("puts removed blocks at the end when nothing after them is left", () => {
		const blocks = alignDocuments(
			body(["a", "One"], ["b", "Two"]),
			body(["a", "One"]),
		);
		expect(blocks.map((block) => block.type)).toEqual(["same", "removed"]);
	});

	it("treats every block as the same when there is nothing to compare with", () => {
		const blocks = alignDocuments(null, body(["a", "One"], ["b", "Two"]));
		expect(blocks.map((block) => block.type)).toEqual(["same", "same"]);
	});

	it("falls back to the block's text when a body has no markers (an old or foreign body), so equal paragraphs still match", () => {
		const blocks = alignDocuments(
			"Friday\n\nArrive.\n\nSaturday",
			"Friday\n\nArrive.\n\nSaturday\n\nSunday",
		);
		expect(blocks.map((block) => block.type)).toEqual([
			"same",
			"same",
			"same",
			"added",
		]);
	});

	it("keeps a moved block a block of its own place: same text is the same, edited text is changed", () => {
		const blocks = alignDocuments(
			body(["a", "One"], ["b", "Two"]),
			body(["b", "Two"], ["a", "One"]),
		);
		expect(blocks.map((block) => block.type)).toEqual(["same", "same"]);
	});
});

describe("changeBlocks", () => {
	it("lists the blocks that changed, in order: the stepper's stops", () => {
		const blocks = alignDocuments(
			body(["a", "One"], ["b", "Two"], ["c", "Three"], ["d", "Four"]),
			body(["a", "One!"], ["c", "Three"], ["d", "Four"], ["e", "Five"]),
		);
		expect(changeBlocks(blocks).map((block) => block.type)).toEqual([
			"changed",
			"removed",
			"added",
		]);
	});
});

describe("foldUnchanged", () => {
	const make = (types: Array<"same" | "changed">) =>
		types.map((type, index) => ({
			type,
			id: `b${index}`,
			markdown: `Block ${index}`,
			...(type === "changed" ? { baseMarkdown: "old" } : {}),
		})) as ReturnType<typeof alignDocuments>;

	it("folds a long stretch of unchanged blocks, keeping a block of context on each side of a change", () => {
		const blocks = make([
			"same",
			"same",
			"same",
			"same",
			"same",
			"changed",
			"same",
			"same",
			"same",
			"same",
			"same",
		]);
		const folded = foldUnchanged(blocks);
		expect(
			folded.map((item) =>
				item.type === "fold" ? `fold:${item.count}` : item.block.type,
			),
		).toEqual(["fold:4", "same", "changed", "same", "fold:4"]);
	});

	it("leaves a short stretch alone", () => {
		const folded = foldUnchanged(make(["same", "same", "changed", "same"]));
		expect(folded.every((item) => item.type === "block")).toBe(true);
	});

	it("leaves everything alone when nothing changed (there is nothing to fold around)", () => {
		const folded = foldUnchanged(
			make(["same", "same", "same", "same", "same", "same"]),
		);
		expect(folded.every((item) => item.type === "block")).toBe(true);
	});

	it("carries the folded blocks, so a fold can open", () => {
		const folded = foldUnchanged(
			make(["same", "same", "same", "same", "same", "changed"]),
		);
		const fold = folded.find((item) => item.type === "fold");
		expect(
			fold && fold.type === "fold" && fold.blocks.map((block) => block.id),
		).toEqual(["b0", "b1", "b2", "b3"]);
	});
});
