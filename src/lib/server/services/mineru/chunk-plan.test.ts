// The structure-aware chunk planner.
//
// `planStructuredChunks` is pure: it turns rendered blocks into planned
// chunks and nothing else. `chunk-sync.ts` (P4-C) is what writes rows, keeps
// the small-file bypass and enforces the row ceiling — none of that is tested
// here, and none of it belongs here.
//
// The invariant the whole design exists for: a GFM table is never split. A
// half table in one chunk and half in the next is worse than no chunk at all,
// because retrieval will return a fragment the model reads as complete.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
	buildStructuredExtractionResult,
	type ChunkPlanEntry,
	MINERU_ZIP_STRUCTURED_CONTENT,
	parseStructuredContent,
	planStructuredChunks,
	type RenderedBlock,
	renderPromptMarkdown,
	type StructuredContent,
} from "./result";

/** The values `chunk-sync.ts` uses today. */
const CHAR_TARGET = 1400;
const CHAR_OVERLAP = 220;

const FIXTURE_ROOT = join(process.cwd(), "fixtures", "mineru-v1");
const FIXTURE_IDS = [
	"pdf",
	"flash-pdf",
	"docx",
	"xlsx",
	"pptx",
	"csv",
	"html",
	"epub",
	"png",
	"jpg",
] as const;

async function loadContent(id: string): Promise<StructuredContent> {
	const zip = await JSZip.loadAsync(
		await readFile(join(FIXTURE_ROOT, id, "result.zip")),
	);
	const file = zip.file(MINERU_ZIP_STRUCTURED_CONTENT);
	if (!file) throw new Error(`fixture ${id} has no structured content`);
	return parseStructuredContent(await file.async("string"));
}

function blocksFrom(content: StructuredContent): readonly RenderedBlock[] {
	return renderPromptMarkdown(content).blocks;
}

function synthetic(
	pages: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>,
): readonly RenderedBlock[] {
	return blocksFrom(
		parseStructuredContent({
			pages: pages.map((blocks, index) => ({ page_idx: index, blocks })),
			metadata: { document: {} },
			extensions: {},
		}),
	);
}

const TABLE = [
	"| Region | Widgets | Sprockets |",
	"| --- | --- | --- |",
	"| Northland | 120 | 45 |",
	"| Southmoor | 98 | 63 |",
	"| Eastvale | 142 | 31 |",
].join("\n");

function paragraph(marker: string, length = 400): string {
	return `${marker} ${"lorem ipsum dolor sit amet ".repeat(
		Math.ceil(length / 27),
	)}`
		.slice(0, length)
		.trim();
}

describe("planStructuredChunks — fixture coverage", () => {
	it.each(
		FIXTURE_IDS,
	)("%s: plans chunks that reassemble into the rendered text", async (id) => {
		const content = await loadContent(id);
		const result = buildStructuredExtractionResult({ content });
		const plan = planStructuredChunks({
			blocks: result.blocks,
			charTarget: CHAR_TARGET,
			charOverlap: CHAR_OVERLAP,
		});

		expect(plan.length).toBeGreaterThan(0);
		expect(plan.map((chunk) => chunk.chunkIndex)).toEqual(
			plan.map((_, index) => index),
		);
		for (const chunk of plan) {
			expect(chunk.text.trim()).toBe(chunk.text);
			expect(chunk.pageStart).toBeGreaterThanOrEqual(1);
			expect(chunk.pageEnd).toBeGreaterThanOrEqual(chunk.pageStart);
			expect(chunk.pageEnd).toBeLessThanOrEqual(
				Math.max(result.pageCount, result.pages.length),
			);
		}
		// Every block's text survives somewhere in the plan.
		for (const block of result.blocks) {
			expect(plan.some((chunk) => chunk.text.includes(block.text))).toBe(true);
		}
	});

	it.each(FIXTURE_IDS)("%s: never splits a table block", async (id) => {
		const content = await loadContent(id);
		const result = buildStructuredExtractionResult({ content });
		const tables = result.blocks.filter((block) => block.type === "table");

		for (const target of [80, 200, 1400]) {
			const plan = planStructuredChunks({
				blocks: result.blocks,
				charTarget: target,
				charOverlap: CHAR_OVERLAP,
			});
			for (const table of tables) {
				const holders = plan.filter((chunk) => chunk.text.includes(table.text));
				expect(
					holders.length,
					`${id}: table lost at charTarget=${target}`,
				).toBeGreaterThanOrEqual(1);
			}
		}
	});
});

describe("planStructuredChunks — atomic blocks", () => {
	it("keeps a table whole even when it alone exceeds the target", () => {
		const blocks = synthetic([
			[
				{ type: "text", content: paragraph("A") },
				{ type: "table", content: TABLE },
				{ type: "text", content: paragraph("B") },
			],
		]);
		const plan = planStructuredChunks({
			blocks,
			charTarget: 40,
			charOverlap: CHAR_OVERLAP,
		});

		const holders = plan.filter((chunk) => chunk.text.includes(TABLE));
		expect(holders).toHaveLength(1);
		// Its own chunk, however large it is.
		expect(holders[0].text).toBe(TABLE);
	});

	it("treats an unknown type as atomic", () => {
		const payload = paragraph("HOLOGRAM", 900);
		const blocks = synthetic([
			[
				{ type: "text", content: paragraph("A", 900) },
				{ type: "hologram", content: payload },
				{ type: "text", content: paragraph("B", 900) },
			],
		]);
		expect(blocks[1].atomic).toBe(true);
		expect(blocks[1].unknownType).toBe(true);

		const plan = planStructuredChunks({
			blocks,
			charTarget: 1000,
			charOverlap: CHAR_OVERLAP,
		});
		const holders = plan.filter((chunk) => chunk.text.includes(payload));
		expect(holders).toHaveLength(1);
		expect(holders[0].text).toBe(payload);
	});

	it("omits the overlap on both sides of an atomic block", () => {
		const first = paragraph("FIRST", 900);
		const second = paragraph("SECOND", 900);
		const blocks = synthetic([
			[
				{ type: "text", content: first },
				{ type: "table", content: TABLE },
				{ type: "text", content: second },
			],
		]);
		const plan = planStructuredChunks({
			blocks,
			charTarget: 950,
			charOverlap: CHAR_OVERLAP,
		});

		expect(plan.map((chunk) => chunk.text)).toEqual([first, TABLE, second]);
		// Nothing from the table leaked into the neighbours, in either
		// direction, and the prose was not duplicated across the boundary.
		expect(plan[2].text).not.toContain("Northland");
		expect(plan[2].text.startsWith("SECOND")).toBe(true);
	});

	it("never reaches back THROUGH a short block into the atomic one before it", () => {
		// The atomicity guard only ever looked at the two blocks either side of
		// the boundary, while the overlap tail was taken from the whole CLOSED
		// CHUNK. So a short block after a table — a caption, a one-line
		// paragraph — was shorter than the 220-character overlap, and the tail
		// reached back across the separator into the table: the next chunk
		// opened with header-less table rows, which is precisely the fragment
		// "retrieval will return … the model reads as complete" that this whole
		// design exists to prevent. The page range lied about it too, because
		// `overlapSource` claimed the short block's page for text from the
		// table's page.
		const caption = "Short caption line after the table.";
		const prose = paragraph("PROSE", 900);
		const blocks = synthetic([
			[{ type: "table", content: TABLE }],
			[{ type: "text", content: caption }],
			[{ type: "text", content: prose }],
		]);

		const plan = planStructuredChunks({
			blocks,
			charTarget: 400,
			charOverlap: CHAR_OVERLAP,
		});

		const tableRows = TABLE.split("\n");
		for (const chunk of plan) {
			// A chunk either holds the whole table or none of its rows.
			const holdsWhole = chunk.text.includes(TABLE);
			if (holdsWhole) continue;
			for (const row of tableRows) {
				expect(chunk.text).not.toContain(row);
			}
		}

		// And no chunk claims a page range that excludes text it actually holds.
		const withTable = plan.find((chunk) => chunk.text.includes(TABLE));
		expect(withTable?.pageStart).toBe(1);
	});

	it("applies the overlap between two plain prose chunks", () => {
		const blocks = synthetic([
			[
				{ type: "text", content: paragraph("A", 600) },
				{ type: "text", content: paragraph("B", 600) },
				{ type: "text", content: paragraph("C", 600) },
			],
		]);
		const plan = planStructuredChunks({
			blocks,
			charTarget: 1300,
			charOverlap: CHAR_OVERLAP,
		});

		expect(plan.length).toBeGreaterThan(1);
		// The second chunk opens with a tail of the first.
		const tail = plan[0].text.slice(-CHAR_OVERLAP).trim();
		expect(tail.length).toBeGreaterThan(0);
		expect(plan[1].text.startsWith(tail)).toBe(true);
	});

	it("drops the overlap entirely when charOverlap is 0", () => {
		const blocks = synthetic([
			[
				{ type: "text", content: paragraph("A", 600) },
				{ type: "text", content: paragraph("B", 600) },
				{ type: "text", content: paragraph("C", 600) },
			],
		]);
		const plan = planStructuredChunks({
			blocks,
			charTarget: 1300,
			charOverlap: 0,
		});

		expect(plan[1].text.startsWith("C ")).toBe(true);
	});
});

describe("planStructuredChunks — headings", () => {
	function endsOnBareHeading(chunk: ChunkPlanEntry): boolean {
		const lines = chunk.text.trimEnd().split("\n");
		return /^#{1,6}\s/.test(lines[lines.length - 1]);
	}

	it("never ends a chunk on a bare heading", () => {
		const blocks = synthetic([
			[
				{ type: "text", content: paragraph("A", 900) },
				{ type: "paragraph_title", level: 2, content: "BRAVO Methodology" },
				{ type: "text", content: paragraph("B", 900) },
				{ type: "paragraph_title", level: 2, content: "CHARLIE Results" },
				{ type: "text", content: paragraph("C", 900) },
			],
		]);
		const plan = planStructuredChunks({
			blocks,
			charTarget: 1000,
			charOverlap: CHAR_OVERLAP,
		});

		expect(plan.length).toBeGreaterThan(1);
		for (const chunk of plan) {
			expect(endsOnBareHeading(chunk), chunk.text.slice(-60)).toBe(false);
		}
		// The heading travelled forward to the block it introduces.
		expect(plan[1].text.startsWith("## BRAVO Methodology")).toBe(true);
	});

	it("keeps a heading with the atomic block it introduces", () => {
		const blocks = synthetic([
			[
				{ type: "text", content: paragraph("A", 900) },
				{ type: "paragraph_title", level: 2, content: "CHARLIE Results" },
				{ type: "table", content: TABLE },
			],
		]);
		const plan = planStructuredChunks({
			blocks,
			charTarget: 950,
			charOverlap: CHAR_OVERLAP,
		});

		const tableChunk = plan.find((chunk) => chunk.text.includes(TABLE));
		expect(tableChunk?.text).toBe(`## CHARLIE Results\n\n${TABLE}`);
	});

	it("accepts a bounded overflow rather than emitting a lone heading", () => {
		const blocks = synthetic([
			[
				{ type: "paragraph_title", level: 2, content: "SOLO" },
				{ type: "text", content: paragraph("BIG", 900) },
			],
		]);
		const plan = planStructuredChunks({
			blocks,
			charTarget: 50,
			charOverlap: CHAR_OVERLAP,
		});

		expect(plan).toHaveLength(1);
		expect(plan[0].text.startsWith("## SOLO")).toBe(true);
	});
});

describe("planStructuredChunks — page ranges", () => {
	it("spans a page boundary correctly", () => {
		const blocks = synthetic([
			[{ type: "text", content: paragraph("P1", 300) }],
			[{ type: "text", content: paragraph("P2", 300) }],
			[{ type: "text", content: paragraph("P3", 300) }],
		]);
		const plan = planStructuredChunks({
			blocks,
			charTarget: 2000,
			charOverlap: CHAR_OVERLAP,
		});

		expect(plan).toHaveLength(1);
		expect(plan[0].pageStart).toBe(1);
		expect(plan[0].pageEnd).toBe(3);
	});

	it("gives each chunk the pages of its own blocks", () => {
		const blocks = synthetic([
			[{ type: "text", content: paragraph("P1", 900) }],
			[{ type: "text", content: paragraph("P2", 900) }],
			[{ type: "text", content: paragraph("P3", 900) }],
		]);
		const plan = planStructuredChunks({
			blocks,
			charTarget: 1000,
			charOverlap: 0,
		});

		expect(plan.map((chunk) => [chunk.pageStart, chunk.pageEnd])).toEqual([
			[1, 1],
			[2, 2],
			[3, 3],
		]);
	});

	it("counts the overlap's source block in the page range", () => {
		const blocks = synthetic([
			[{ type: "text", content: paragraph("P1", 900) }],
			[{ type: "text", content: paragraph("P2", 900) }],
		]);
		const plan = planStructuredChunks({
			blocks,
			charTarget: 1000,
			charOverlap: CHAR_OVERLAP,
		});

		expect(plan).toHaveLength(2);
		// The second chunk carries a tail of page 1, so it starts on page 1.
		expect(plan[1].pageStart).toBe(1);
		expect(plan[1].pageEnd).toBe(2);
	});

	it("returns an empty plan for no blocks", () => {
		expect(
			planStructuredChunks({
				blocks: [],
				charTarget: CHAR_TARGET,
				charOverlap: CHAR_OVERLAP,
			}),
		).toEqual([]);
	});
});
