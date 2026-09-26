import { describe, expect, it } from "vitest";
import { ORPHANED_ANCHOR_RESOLUTION } from "$lib/shared/artifacts/anchor";
import {
	ANCHOR_CONTEXT_CHARS,
	makeAnchor,
	reanchor,
	resolveTextAnchor,
} from "./anchor";
import { makeBlock } from "./blocks";

describe("makeAnchor", () => {
	it("builds a text anchor from a selection's quote and its surrounding context", () => {
		const anchor = makeAnchor({
			blockId: "p1",
			quote: "the flight",
			prefix: "Book ",
			suffix: " to Vienna.",
		});
		expect(anchor).toEqual({
			kind: "text",
			blockId: "p1",
			quote: "the flight",
			prefix: "Book ",
			suffix: " to Vienna.",
		});
	});

	it("refuses an empty (whitespace-only) selection rather than anchoring nothing", () => {
		expect(
			makeAnchor({ blockId: "p1", quote: "   ", prefix: "", suffix: "" }),
		).toBeNull();
	});

	it("caps prefix/suffix at the shared context length, from the near edge", () => {
		const longPrefix = "x".repeat(ANCHOR_CONTEXT_CHARS + 10);
		const longSuffix = "y".repeat(ANCHOR_CONTEXT_CHARS + 10);
		const anchor = makeAnchor({
			blockId: "p1",
			quote: "quote",
			prefix: longPrefix,
			suffix: longSuffix,
		});
		if (anchor?.kind !== "text")
			throw new Error("makeAnchor must build a text anchor");
		expect(anchor.prefix).toBe(longPrefix.slice(-ANCHOR_CONTEXT_CHARS));
		expect(anchor.suffix).toBe(longSuffix.slice(0, ANCHOR_CONTEXT_CHARS));
		expect(anchor.prefix.length).toBe(ANCHOR_CONTEXT_CHARS);
		expect(anchor.suffix.length).toBe(ANCHOR_CONTEXT_CHARS);
	});
});

describe("resolveTextAnchor", () => {
	const anchor = makeAnchor({
		blockId: "p1",
		quote: "the flight",
		prefix: "Book ",
		suffix: " to Vienna soon.",
	});
	if (!anchor) throw new Error("fixture anchor must build");

	it("stays exact after an unrelated edit in a different block", () => {
		const blocks = [
			makeBlock("p0", "paragraph", "Different intro line entirely."),
			makeBlock("p1", "paragraph", "Book the flight to Vienna soon."),
		];
		const resolution = resolveTextAnchor(anchor, blocks);
		expect(resolution.state).toBe("exact");
		expect(resolution.blockId).toBe("p1");
	});

	it("reads as moved once the quote's own paragraph is edited around it", () => {
		const blocks = [
			makeBlock(
				"p1",
				"paragraph",
				"Reserve the flight for our trip to Vienna soon.",
			),
		];
		const resolution = resolveTextAnchor(anchor, blocks);
		expect(resolution.state).toBe("moved");
		expect(resolution.blockId).toBe("p1");
	});

	it("is orphaned once the quote's text is deleted, with the shared null/-1 shape", () => {
		const blocks = [
			makeBlock("p1", "paragraph", "Nothing about travel here now."),
		];
		expect(resolveTextAnchor(anchor, blocks)).toEqual(
			ORPHANED_ANCHOR_RESOLUTION,
		);
	});

	// [trap] the in-block bonus is what makes this true: without it, scanning
	// blocks in document order would find the FIRST identical sentence and stop
	// there, resolving a comment on the second occurrence to the wrong block.
	it("resolves two identical sentences in different blocks to the anchored block, not the first", () => {
		const duplicateAnchor = makeAnchor({
			blockId: "p2",
			quote: "hello",
			prefix: "He said ",
			suffix: " there.",
		});
		if (!duplicateAnchor) throw new Error("fixture anchor must build");
		const blocks = [
			makeBlock("p1", "paragraph", "He said hello there."),
			makeBlock("p2", "paragraph", "He said hello there."),
		];
		const resolution = resolveTextAnchor(duplicateAnchor, blocks);
		expect(resolution.blockId).toBe("p2");
		expect(resolution.state).toBe("exact");
	});

	// The cap must never cost correctness for the anchor's OWN block: a naive
	// scan that processes blocks in plain array order would exhaust its budget
	// on 55 decoys before ever reaching "target", which sits after them.
	it("bounds the scan at 50 candidates without losing the anchor's own block", () => {
		const targetAnchor = makeAnchor({
			blockId: "target",
			quote: "hello",
			prefix: "The ",
			suffix: " there friend.",
		});
		if (!targetAnchor) throw new Error("fixture anchor must build");
		const decoys = Array.from({ length: 55 }, (_, i) =>
			makeBlock(`decoy${i}`, "paragraph", "Some hello nonsense text."),
		);
		const blocks = [
			...decoys,
			makeBlock("target", "paragraph", "The hello there friend."),
		];
		const resolution = resolveTextAnchor(targetAnchor, blocks);
		expect(resolution.state).toBe("exact");
		expect(resolution.blockId).toBe("target");
	});
});

describe("reanchor", () => {
	it("re-baselines an anchor onto its new block id after a split, keeping its quote", () => {
		const anchor = makeAnchor({
			blockId: "p1",
			quote: "pack the bags",
			prefix: "Remember to ",
			suffix: " and passports.",
		});
		if (!anchor) throw new Error("fixture anchor must build");
		// The editor split the original "p1" into two freshly minted blocks —
		// neither carries the old id, exactly like a real ProseMirror split.
		const blocksAfterSplit = [
			makeBlock(
				"m9k2a1",
				"paragraph",
				"Remember to pack the bags and passports.",
			),
			makeBlock("m9k2a2", "paragraph", "Also check the weather."),
		];
		const result = reanchor(anchor, blocksAfterSplit);
		expect(result.kind).toBe("text");
		if (result.kind !== "text") throw new Error("unreachable");
		expect(result.blockId).toBe("m9k2a1");
		expect(result.quote).toBe("pack the bags");
	});

	it("keeps the original anchor, quote intact, when the text is gone (orphaned)", () => {
		const anchor = makeAnchor({
			blockId: "p1",
			quote: "pack the bags",
			prefix: "Remember to ",
			suffix: " and passports.",
		});
		if (!anchor) throw new Error("fixture anchor must build");
		const blocks = [
			makeBlock("p1", "paragraph", "Everything is already packed."),
		];
		expect(reanchor(anchor, blocks)).toEqual(anchor);
	});
});
