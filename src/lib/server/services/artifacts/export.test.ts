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
