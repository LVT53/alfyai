import { describe, expect, it } from "vitest";
import { validateGeneratedDocumentSource } from "$lib/server/services/file-production/source-schema";
import { makeBlock } from "$lib/shared/artifact-document/blocks";
import {
	buildGeneratedDocumentSource,
	sanitizeDocumentFilename,
} from "./export";

describe("buildGeneratedDocumentSource", () => {
	it("maps one output block per input block, and the whole thing validates", () => {
		const blocks = [
			makeBlock("p1", "heading", "## Trip plan"),
			makeBlock("p2", "paragraph", "Book the flight to Vienna."),
		];
		const source = buildGeneratedDocumentSource({
			title: "Trip plan",
			blocks,
		});

		expect(source.blocks).toHaveLength(blocks.length);
		expect(source.blocks[0]).toEqual({
			type: "heading",
			level: 2,
			text: "Trip plan",
		});
		expect(source.blocks[1]).toEqual({
			type: "paragraph",
			text: "Book the flight to Vienna.",
		});

		const validated = validateGeneratedDocumentSource(source);
		expect(validated.ok).toBe(true);
	});

	it("never emits a <!--b: marker anywhere in the source", () => {
		const blocks = [
			makeBlock("p1", "paragraph", "Plain text."),
			makeBlock("p2", "table", "| A | B |\n| --- | --- |\n| 1 | 2 |"),
		];
		const source = buildGeneratedDocumentSource({ title: "Report", blocks });
		expect(JSON.stringify(source)).not.toContain("<!--b:");
	});

	it("maps a taskList's checked state onto structured list items, never [x] text", () => {
		const blocks = [
			makeBlock(
				"p1",
				"taskList",
				"- [x] Book the hotel\n- [ ] Confirm the flight",
			),
		];
		const source = buildGeneratedDocumentSource({ title: "Trip", blocks });
		expect(source.blocks[0]).toEqual({
			type: "list",
			style: "bullet",
			items: [
				{ text: "Book the hotel", checked: true },
				{ text: "Confirm the flight", checked: false },
			],
		});
		expect(JSON.stringify(source.blocks[0])).not.toContain("[x]");
		expect(JSON.stringify(source.blocks[0])).not.toContain("[ ]");

		const validated = validateGeneratedDocumentSource(source);
		expect(validated.ok).toBe(true);
	});

	it("maps a plain bullet list and a numbered list correctly", () => {
		const blocks = [
			makeBlock("p1", "list", "- EMEA grew fastest\n- Churn improved"),
			makeBlock("p2", "list", "1. First\n2. Second"),
		];
		const source = buildGeneratedDocumentSource({ title: "Lists", blocks });
		expect(source.blocks[0]).toEqual({
			type: "list",
			style: "bullet",
			items: ["EMEA grew fastest", "Churn improved"],
		});
		expect(source.blocks[1]).toEqual({
			type: "list",
			style: "numbered",
			items: ["First", "Second"],
		});
	});

	it("maps a markdown table into columns/rows, stripping a chip token to its plain value", () => {
		const blocks = [
			makeBlock(
				"p1",
				"table",
				'| Item | Status |\n| --- | --- |\n| Hotel | [chip kind="status" value="Booked"] |',
			),
		];
		const source = buildGeneratedDocumentSource({ title: "Table", blocks });
		expect(source.blocks[0]).toMatchObject({
			type: "table",
			columns: [
				{ key: "c0", label: "Item" },
				{ key: "c1", label: "Status" },
			],
			rows: [{ c0: "Hotel", c1: "Booked" }],
		});

		const validated = validateGeneratedDocumentSource(source);
		expect(validated.ok).toBe(true);
	});

	it("maps a fenced code block, stripping the fence and keeping the language", () => {
		const blocks = [makeBlock("p1", "code", '```json\n{"status":"ok"}\n```')];
		const source = buildGeneratedDocumentSource({ title: "Code", blocks });
		expect(source.blocks[0]).toEqual({
			type: "code",
			language: "json",
			text: '{"status":"ok"}',
		});
	});

	it("maps a blockquote, stripping the '>' markers", () => {
		const blocks = [makeBlock("p1", "blockquote", "> Book early.")];
		const source = buildGeneratedDocumentSource({ title: "Quote", blocks });
		expect(source.blocks[0]).toEqual({ type: "quote", text: "Book early." });
	});

	it("maps a horizontal rule to a divider", () => {
		const blocks = [makeBlock("p1", "hr", "---")];
		const source = buildGeneratedDocumentSource({ title: "HR", blocks });
		expect(source.blocks[0]).toEqual({ type: "divider" });
	});

	it("maps an 'other' block to a plain paragraph rather than dropping its text", () => {
		const blocks = [makeBlock("p1", "other", "Some unrecognized content.")];
		const source = buildGeneratedDocumentSource({ title: "Other", blocks });
		expect(source.blocks[0]).toEqual({
			type: "paragraph",
			text: "Some unrecognized content.",
		});
	});

	// chart/image/sourceChips/pageBreak are Atlas-report concepts a Document
	// has no native block for, and this mapper must never invent one.
	// T12.7: a document too large to render is refused by the intake's own
	// static limit (source_too_large), not silently truncated by this mapper.
	// A large document's own JSON must actually GROW with its content —
	// proof there is no hidden cap here for the intake's 2 MiB limit to catch.
	it("never truncates a large document — its JSON size scales with its content", () => {
		const bigBlocks = Array.from({ length: 500 }, (_, i) =>
			makeBlock(`p${i}`, "paragraph", "x".repeat(5000)),
		);
		const source = buildGeneratedDocumentSource({
			title: "Large report",
			blocks: bigBlocks,
		});
		expect(source.blocks).toHaveLength(500);
		const bytes = Buffer.byteLength(JSON.stringify(source), "utf8");
		// 500 * 5000 chars of body text alone already clears the 2 MiB the
		// intake refuses at (file-production/limits.ts's maxSourceJsonBytes).
		expect(bytes).toBeGreaterThan(2 * 1024 * 1024);

		const validated = validateGeneratedDocumentSource(source);
		expect(validated.ok).toBe(true);
	});

	it("never emits a chart, image, sourceChips or pageBreak block", () => {
		const blocks = [
			makeBlock("p1", "paragraph", "Text."),
			makeBlock("p2", "table", "| A |\n| --- |\n| 1 |"),
			makeBlock("p3", "list", "- one"),
		];
		const source = buildGeneratedDocumentSource({ title: "T", blocks });
		const types = source.blocks.map((b) => b.type);
		for (const forbidden of ["chart", "image", "sourceChips", "pageBreak"]) {
			expect(types).not.toContain(forbidden);
		}
	});
});

describe("sanitizeDocumentFilename", () => {
	it("keeps an ordinary, human-written title", () => {
		expect(sanitizeDocumentFilename("Vienna, 10–12 October")).toBe(
			"Vienna, 10–12 October",
		);
	});

	it("replaces path separators rather than letting them escape the basename", () => {
		expect(sanitizeDocumentFilename("Q3/Q4 plan")).toBe("Q3-Q4 plan");
		expect(sanitizeDocumentFilename("A\\B")).toBe("A-B");
	});

	it("falls back to 'document' for an empty or whitespace-only title", () => {
		expect(sanitizeDocumentFilename("")).toBe("document");
		expect(sanitizeDocumentFilename("   ")).toBe("document");
	});

	it("falls back to 'document' for a title that is only dots", () => {
		expect(sanitizeDocumentFilename("...")).toBe("document");
	});

	it("caps an unreasonably long title", () => {
		const long = "x".repeat(500);
		expect(sanitizeDocumentFilename(long).length).toBeLessThanOrEqual(100);
	});
});

// RV-1A (independent review of Slice 1): red before its fix; the review file
// (docs/plans/claude-at-home-2/review-1a.md) quotes the failing line.
describe("RV-1A: an exported Document reads as text, not as Markdown source", () => {
	it("renders inline Markdown as the text it shows — the report renderers print text verbatim", () => {
		const blocks = [
			makeBlock("h1", "heading", "## Day **one** in *Vienna*"),
			makeBlock(
				"p1",
				"paragraph",
				"Book **the** train &amp; a [cheap bus](https://x.y) at 5 &lt; 6 \\* fast, `code_here`.",
			),
			makeBlock("l1", "list", "- **Bold:** item\n- plain"),
			makeBlock("t1", "taskList", "- [x] Pay the **deposit**"),
			makeBlock("q1", "blockquote", "> A **quoted** line"),
			makeBlock(
				"tb1",
				"table",
				"| Item | Status |\n| --- | --- |\n| **Hotel** | booked |",
			),
		];
		const source = buildGeneratedDocumentSource({ title: "Trip", blocks });
		expect(source.blocks).toEqual([
			{ type: "heading", level: 2, text: "Day one in Vienna" },
			{
				type: "paragraph",
				text: "Book the train & a cheap bus at 5 < 6 * fast, code_here.",
			},
			{ type: "list", style: "bullet", items: ["Bold: item", "plain"] },
			{
				type: "list",
				style: "bullet",
				items: [{ text: "Pay the deposit", checked: true }],
			},
			{ type: "quote", text: "A quoted line" },
			{
				type: "table",
				columns: [
					{ key: "c0", label: "Item", kind: "text" },
					{ key: "c1", label: "Status", kind: "text" },
				],
				rows: [{ c0: "Hotel", c1: "booked" }],
			},
		]);
	});

	it("keeps a task item's continuation with it and its nested plain items as plain items — never a stray unchecked box", () => {
		const blocks = [
			makeBlock(
				"t1",
				"taskList",
				"- [x] Book the hotel\n  near the station\n  - [ ] Pay the deposit\n  - a plain note",
			),
		];
		const source = buildGeneratedDocumentSource({ title: "Trip", blocks });
		expect(source.blocks[0]).toEqual({
			type: "list",
			style: "bullet",
			items: [
				{ text: "Book the hotel near the station", checked: true },
				{ text: "Pay the deposit", checked: false },
				"a plain note",
			],
		});
		// A checklist with a plain item in it is still a valid source.
		expect(validateGeneratedDocumentSource(source).ok).toBe(true);
	});

	it("keeps a code block's last line when the fence was never closed", () => {
		const blocks = [
			makeBlock("c1", "code", "```js\nconst a = 1;\nconst b = 2;"),
		];
		const source = buildGeneratedDocumentSource({ title: "Code", blocks });
		expect(source.blocks[0]).toEqual({
			type: "code",
			language: "js",
			text: "const a = 1;\nconst b = 2;",
		});
	});
});
