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
	readTaskBlock,
	splitTableCells,
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
			// Each checklist item is its own block (see the comment on
			// `LIST_ITEM_START_RE`): `toggleTask` addresses one block with only
			// `checked`, no item locator, so a five-item checklist grouped into one
			// block would make individual items unaddressable.
			"taskList",
			"taskList",
			"blockquote",
			"code",
			"table",
			"hr",
		]);
	});

	it("gives every checklist item its own block, so toggleTask can address one", () => {
		const result = parseDocument(
			"- [ ] Book flights\n- [x] Book hotel\n- [ ] Pack bags",
		);
		const taskBlocks = result.blocks.filter((b) => b.kind === "taskList");
		expect(taskBlocks).toHaveLength(3);
		expect(taskBlocks[0].label).toBe("Book flights");
		expect(taskBlocks[1].label).toBe("Book hotel");
		expect(new Set(taskBlocks.map((b) => b.id)).size).toBe(3);
	});

	it("a block's markdown never contains the marker", () => {
		const result = parseDocument("<!--b:abc12-->\nHello world");
		for (const block of result.blocks) {
			expect(block.markdown).not.toContain("<!--b:");
		}
	});
});

describe("readTaskBlock — the one checked-state/text reader for card previews", () => {
	it("reads a checked task's text", () => {
		const result = parseDocument("- [x] Book flights");
		expect(readTaskBlock(result.blocks[0])).toEqual({
			checked: true,
			text: "Book flights",
		});
	});

	it("reads an unchecked task's text", () => {
		const result = parseDocument("- [ ] Book hotel");
		expect(readTaskBlock(result.blocks[0])).toEqual({
			checked: false,
			text: "Book hotel",
		});
	});

	it("is null for a non-task block", () => {
		const result = parseDocument("Just a paragraph.");
		expect(readTaskBlock(result.blocks[0])).toBeNull();
	});
});

// RV-1A (independent review of Slice 1's engine). Each case here was red
// before its fix; the review file (docs/plans/claude-at-home-2/review-1a.md)
// quotes the failing line.
describe("RV-1A: the canonical form never rewrites a code block's content", () => {
	it("keeps a fenced code block verbatim: a diff's + lines, * and 1) markers, blank runs, chips", () => {
		const code = [
			"```diff",
			"+ added line",
			"- removed line",
			"  * star bullet",
			"1) first",
			"",
			"",
			"| a  |  b |",
			"| -- | -- |",
			"[chip value='y' kind='x']",
			"```",
		].join("\n");
		expect(normalizeMarkdown(code)).toBe(code);
		const parsed = parseDocument(code);
		expect(parsed.blocks).toHaveLength(1);
		expect(parsed.blocks[0].kind).toBe("code");
		expect(parsed.blocks[0].markdown).toBe(code);
		// Still the canonical form: reloading the stored text is a no-op.
		expect(parseDocument(parsed.markdown).markdown).toBe(parsed.markdown);
	});

	it("still trims trailing whitespace and edge blank lines around a code block (rule 1 and rule 4 hold)", () => {
		expect(normalizeMarkdown("\n```\nx = 1   \n```\n\n")).toBe(
			"```\nx = 1\n```",
		);
	});
});

describe("RV-1A: an escaped pipe is cell text, not a column separator", () => {
	it("keeps `\\|` inside its cell through normalisation, and counts the cells GFM counts", () => {
		const table = "| a | b |\n| --- | --- |\n| x \\| y | z |";
		expect(normalizeMarkdown(table)).toBe(table);
		expect(splitTableCells("| x \\| y | z |").map((c) => c.trim())).toEqual([
			"x \\| y",
			"z",
		]);
		// An escaped backslash before a real separator is still a separator.
		expect(splitTableCells("| a \\\\| b |").map((c) => c.trim())).toEqual([
			"a \\\\",
			"b",
		]);
		// A row whose last cell ends in an escaped pipe keeps it.
		expect(splitTableCells("| a | b \\|").map((c) => c.trim())).toEqual([
			"a",
			"b \\|",
		]);
	});
});

describe("RV-1A: a task item's nested items belong to its block", () => {
	it("keeps nested items (tasks and bullets) with their parent task item, so a reopen cannot un-nest them", () => {
		const parsed = parseDocument(
			"- [ ] parent task\n  - [x] child task\n  - plain sub-bullet\n    more text\n- [ ] second",
		);
		expect(parsed.blocks.map((block) => block.kind)).toEqual([
			"taskList",
			"taskList",
		]);
		expect(parsed.blocks[0].markdown).toBe(
			"- [ ] parent task\n  - [x] child task\n  - plain sub-bullet\n    more text",
		);
		expect(readTaskBlock(parsed.blocks[0])).toEqual({
			checked: false,
			text: "parent task",
		});
		expect(parsed.blocks[1].markdown).toBe("- [ ] second");
	});

	it("still splits sibling task items, including a 1-space-indented sibling", () => {
		const parsed = parseDocument("- [ ] one\n - [ ] two\n- [x] three");
		expect(parsed.blocks).toHaveLength(3);
	});
});

describe("RV-1A: a horizontal rule is not a table", () => {
	it("keeps `---` a horizontal rule through normalisation and a reload, instead of the text `| --- |`", () => {
		expect(normalizeMarkdown("---")).toBe("---");
		const parsed = parseDocument("Above.\n\n---\n\nBelow.");
		expect(parsed.blocks.map((b) => `${b.kind}:${b.markdown}`)).toEqual([
			"paragraph:Above.",
			"hr:---",
			"paragraph:Below.",
		]);
		const reloaded = parseDocument(parsed.markdown);
		expect(reloaded.blocks.map((b) => `${b.kind}:${b.markdown}`)).toEqual([
			"paragraph:Above.",
			"hr:---",
			"paragraph:Below.",
		]);
	});
});

describe("RV-1A: a table's delimiter row is padding too (ruling 12, rule 2)", () => {
	it("collapses the delimiter dashes the editor pads to the column width, keeping the alignment colons", () => {
		expect(
			normalizeMarkdown("| A | B |\n| ------- | --- |\n| x **y** | z |"),
		).toBe(normalizeMarkdown("| A | B |\n| --- | --- |\n| x **y** | z |"));
		expect(
			normalizeMarkdown(
				"| L | R | C |\n|:------|------:|:-----:|\n| a | b | c |",
			),
		).toBe("| L | R | C |\n| :--- | ---: | :---: |\n| a | b | c |");
	});
});

describe("RV-1A: a hard line break survives the canonical form", () => {
	it("writes the editor's two-space hard break as a backslash break, which rule 1's trim cannot delete", () => {
		expect(normalizeMarkdown("First line  \nsecond line")).toBe(
			"First line\\\nsecond line",
		);
		expect(normalizeMarkdown("First line\\\nsecond line")).toBe(
			"First line\\\nsecond line",
		);
		// Trailing spaces on a block's last line are not a break: still trimmed.
		expect(normalizeMarkdown("Only line  ")).toBe("Only line");
		// Code is content: its trailing spaces are just trimmed, never a break.
		expect(normalizeMarkdown("```\na  \nb\n```")).toBe("```\na\nb\n```");
	});
});

describe("RV-1A: a list item's lazy continuation line stays in the item", () => {
	it("keeps the line after a hard break inside its list item, as CommonMark reads it", () => {
		const list = parseDocument("- item one  \nitem line two\n- item two");
		expect(list.blocks.map((b) => b.kind)).toEqual(["list"]);
		expect(list.blocks[0].markdown).toBe(
			"- item one\\\nitem line two\n- item two",
		);
		// A task item is the exception: the editor's task-item reader keeps a
		// backslash break as literal text, so its trailing spaces are only
		// trimmed (never turned into a visible "\").
		expect(
			normalizeMarkdown("- [ ] book the hotel  \n  near the station"),
		).toBe("- [ ] book the hotel\n  near the station");
		// A line that starts a block of its own still ends the list.
		expect(
			parseDocument("- item\n# Heading").blocks.map((b) => b.kind),
		).toEqual(["list", "heading"]);
	});
});

describe("RV-1A: a task's card text is the text the user sees", () => {
	it("reads bold, links, entities and chips out of the task line, as the card and the preview show it", () => {
		const [task] = parseDocument(
			'- [x] Pay the **deposit** at [the hotel](https://x.y) &amp; bank [chip kind="status" value="Booked"]',
		).blocks;
		expect(readTaskBlock(task)).toEqual({
			checked: true,
			text: "Pay the deposit at the hotel & bank",
		});
	});
});
