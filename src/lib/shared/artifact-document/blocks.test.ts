import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	blockHash,
	buildIndex,
	countMarkers,
	fnv1aHex,
	mintBlockId,
	normalizeMarkdown,
	parseDocument,
	serializeDocument,
} from "./blocks";

// The Document's pure engine (spec §2.6, ruling 12). No Tiptap, no ProseMirror,
// no DOM: the server has to be able to refuse a patch and it has no editor, so
// this module is what both sides run.
describe("artifact-document blocks", () => {
	// T1.1 — the trap, first. The prototype minted ids AFTER hashing, so the
	// first read of a freshly loaded document had no stable identity at all and
	// every patch against it was refused. Mint-before-hash is the fix, and it
	// must be true on the very first parse of markup with no markers.
	it("mints ids before hashing so the first read is addressable", () => {
		const result = parseDocument(
			"# Title\n\nA paragraph of text.\n\n- one\n- two\n",
		);
		expect(result.minted).toBe(true);
		expect(result.blocks.length).toBeGreaterThan(0);
		for (const block of result.blocks) {
			expect(block.id.length).toBeGreaterThan(0);
			expect(block.hash.length).toBeGreaterThan(0);
		}
	});

	// T1.2 — "ids survive a reload": parsing the serialised output again must
	// be a no-op for identity and content.
	it("is idempotent across a reload: same ids, same hashes, no re-mint", () => {
		const first = parseDocument("# Title\n\nSome text here.\n");
		const second = parseDocument(first.markdown);
		expect(second.minted).toBe(false);
		expect(second.blocks.length).toBe(first.blocks.length);
		expect(buildIndex(second.blocks)).toEqual(buildIndex(first.blocks));
		expect(second.blocks.map((b) => b.id)).toEqual(
			first.blocks.map((b) => b.id),
		);
	});

	// T1.3 — a hand-written marker is absorbed, not duplicated.
	it("absorbs a hand-written marker into the following block", () => {
		const result = parseDocument("<!--b:p1x2y3-->\nHello");
		expect(result.blocks).toHaveLength(1);
		expect(result.blocks[0].id).toBe("p1x2y3");
		expect(result.blocks[0].markdown).toBe("Hello");
		expect(countMarkers(result.markdown)).toBe(1);
	});

	// T1.4 — a marker with no following block is dropped; a duplicate id keeps
	// the first occurrence and re-mints the second.
	it("drops a trailing marker with no block, and re-mints a duplicate id", () => {
		const dropped = parseDocument("Just a paragraph.\n\n<!--b:orphan-->");
		expect(countMarkers(dropped.markdown)).toBe(1);
		expect(dropped.blocks.map((b) => b.id)).not.toContain("orphan");

		const duplicate = parseDocument(
			"<!--b:dup01-->\nFirst.\n\n<!--b:dup01-->\nSecond.",
		);
		expect(duplicate.blocks).toHaveLength(2);
		expect(duplicate.blocks[0].id).toBe("dup01");
		expect(duplicate.blocks[1].id).not.toBe("dup01");
		const ids = duplicate.blocks.map((b) => b.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	// T1.5 — serializeDocument writes exactly one marker per block.
	it("serializes exactly one marker line per block, immediately before it", () => {
		const result = parseDocument("# A\n\nOne.\n\nTwo.\n");
		const markers = countMarkers(result.markdown);
		expect(markers).toBe(result.blocks.length);
		const lines = result.markdown.split("\n");
		for (const block of result.blocks) {
			const markerIndex = lines.findIndex(
				(line) => line.trim() === `<!--b:${block.id}-->`,
			);
			expect(markerIndex).toBeGreaterThanOrEqual(0);
		}
	});

	// T1.6 — ruling 12's gate, named exactly. Open, serialise, reload, serialise
	// again with NO user edit: every hash must be identical, or "your words
	// win" refuses a patch on a document nobody touched.
	it("canonical form: open → serialise → reload → serialise keeps every hash", () => {
		const source = [
			"# Trip",
			"",
			"A paragraph  with trailing spaces.   ",
			"",
			"* one",
			"+ two",
			"- [X] booked",
			"- [ ] pending",
			"",
			"1) first",
			"2) second",
			"",
			"| a  |   b |",
			"| -- | --- |",
			"| 1  | 2   |",
			"",
			"",
			"",
			"Trailing blank runs above.",
			"",
		].join("\n");

		const first = parseDocument(source);
		const second = parseDocument(first.markdown);
		expect(buildIndex(second.blocks)).toEqual(buildIndex(first.blocks));
		expect(second.blocks.map((b) => b.markdown)).toEqual(
			first.blocks.map((b) => b.markdown),
		);
	});

	it("normalizeMarkdown collapses table padding to one key", () => {
		expect(normalizeMarkdown("| a  |   b |\n| -- | --- |")).toBe(
			normalizeMarkdown("| a | b |\n| -- | --- |"),
		);
	});

	it("normalizeMarkdown normalises bullet markers and checkbox case", () => {
		expect(normalizeMarkdown("* one")).toBe(normalizeMarkdown("- one"));
		expect(normalizeMarkdown("+ one")).toBe(normalizeMarkdown("- one"));
		expect(normalizeMarkdown("- [X] done")).toBe(
			normalizeMarkdown("- [x] done"),
		);
		expect(normalizeMarkdown("- [ ] todo")).toContain("[ ]");
	});

	it("normalizeMarkdown keeps an ordered marker's number", () => {
		expect(normalizeMarkdown("1) first")).toBe("1. first");
		expect(normalizeMarkdown("2. second")).toBe("2. second");
	});

	it("normalizeMarkdown drops trailing blank lines and collapses internal runs", () => {
		expect(normalizeMarkdown("Line one.\n\n\n\nLine two.\n\n\n")).toBe(
			"Line one.\n\nLine two.",
		);
	});

	it("normalizeMarkdown stabilises chip attribute order and quoting", () => {
		const a = normalizeMarkdown('[chip kind="status" value="Booked"]');
		const b = normalizeMarkdown("[chip value='Booked' kind='status']");
		expect(a).toBe(b);
		expect(a).toBe('[chip kind="status" value="Booked"]');
	});

	it("normalizeMarkdown is idempotent on every canonical-rule input", () => {
		const samples = [
			"| a  |   b |\n| -- | --- |",
			"* one\n+ two\n- [X] three",
			"1) first\n2) second",
			"Line.\n\n\n\nMore.\n\n\n",
			'[chip value="Booked" kind="status"]',
			"  leading space paragraph",
		];
		for (const sample of samples) {
			const once = normalizeMarkdown(sample);
			const twice = normalizeMarkdown(once);
			expect(twice).toBe(once);
		}
	});

	it("blockHash is fnv1aHex of the normalized markdown, never a second hasher", () => {
		const raw = "| a  |   b |\n| -- | --- |";
		expect(blockHash(raw)).toBe(fnv1aHex(normalizeMarkdown(raw)));
	});

	it("fnv1aHex is stable and differs for different inputs", () => {
		expect(fnv1aHex("a")).toBe(fnv1aHex("a"));
		expect(fnv1aHex("a")).not.toBe(fnv1aHex("b"));
		expect(fnv1aHex("a")).toMatch(/^[0-9a-f]{8}$/);
	});

	it("mintBlockId is kind-prefixed and does not collide across 10,000 calls", () => {
		const ids = new Set<string>();
		for (let i = 0; i < 10_000; i++) {
			const id = mintBlockId(i % 2 === 0 ? "paragraph" : "heading");
			expect(id).toMatch(/^[a-z]{1,2}[0-9a-z]{5}$/);
			ids.add(id);
		}
		expect(ids.size).toBe(10_000);
	});

	// T1.9 — the structural half of ruling 9's split budget: CI can assert
	// shape and a generous ceiling, never a strict fps-style number.
	it("parses a large document under a machine-independent ceiling", () => {
		const paragraph = "word ".repeat(20).trim();
		const blocksText = Array.from(
			{ length: 300 },
			(_, i) => `Paragraph ${i}: ${paragraph}`,
		).join("\n\n");
		const start = performance.now();
		const result = parseDocument(blocksText);
		const elapsed = performance.now() - start;
		expect(result.blocks).toHaveLength(300);
		expect(Object.keys(buildIndex(result.blocks))).toHaveLength(300);
		const reparsed = parseDocument(result.markdown);
		expect(reparsed.minted).toBe(false);
		expect(elapsed).toBeLessThan(30);
	});

	it("imports nothing from tiptap, prosemirror, svelte or the DOM", () => {
		const source = readFileSync(
			"src/lib/shared/artifact-document/blocks.ts",
			"utf8",
		);
		// A prose mention (explaining why the module has none) is fine; an actual
		// import specifier is the thing this guards against.
		const importLines = source
			.split("\n")
			.filter((line) => /^\s*import\s/.test(line));
		for (const line of importLines) {
			expect(line).not.toMatch(/tiptap|prosemirror|["']svelte/i);
		}
		expect(source).not.toMatch(/\bdocument\.\w/);
	});

	it("buildIndex maps every block id to its hash", () => {
		const result = parseDocument("# A\n\nOne.\n\nTwo.");
		const index = buildIndex(result.blocks);
		for (const block of result.blocks) {
			expect(index[block.id]).toBe(block.hash);
		}
	});

	it("recognises the documented block kinds", () => {
		const result = parseDocument(
			[
				"# Heading",
				"",
				"A paragraph.",
				"",
				"- a bullet list",
				"- second item",
				"",
				"- [ ] a task",
				"- [x] done",
				"",
				"> a quote",
				"",
				"```js",
				"code();",
				"```",
				"",
				"| h1 | h2 |",
				"| -- | -- |",
				"| a  | b  |",
				"",
				"---",
			].join("\n"),
		);
		const kinds = result.blocks.map((b) => b.kind);
		expect(kinds).toEqual([
			"heading",
			"paragraph",
			"list",
			"taskList",
			"blockquote",
			"code",
			"table",
			"hr",
		]);
	});

	it("a block's markdown never contains the marker", () => {
		const result = parseDocument("<!--b:abc12-->\nHello world");
		for (const block of result.blocks) {
			expect(block.markdown).not.toContain("<!--b:");
		}
	});
});
