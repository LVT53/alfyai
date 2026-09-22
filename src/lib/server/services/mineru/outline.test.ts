// The §4.5 outline table, asserted per format against the real fixtures.
//
// `level` means something different in every backend: faithful for HTML/EPUB,
// shifted by +1 and wrapped in `**…**` for DOCX, and flat at 2 for PDF and
// images because the layout model does not infer depth at all. The outline
// producer is the only place that knows this, and the format it branches on
// comes from the UPLOADED FILENAME — never from `metadata.file_suffix`, which
// reports `"pdf"` for a PNG.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
	buildMineruOutline,
	buildStructuredExtractionResult,
	MINERU_ZIP_STRUCTURED_CONTENT,
	type MineruOutlineEntry,
	parseStructuredContent,
	renderPromptMarkdown,
	type StructuredContent,
} from "./result";

const FIXTURE_ROOT = join(process.cwd(), "fixtures", "mineru-v1");

async function loadContent(id: string): Promise<StructuredContent> {
	const zip = await JSZip.loadAsync(
		await readFile(join(FIXTURE_ROOT, id, "result.zip")),
	);
	const file = zip.file(MINERU_ZIP_STRUCTURED_CONTENT);
	if (!file) throw new Error(`fixture ${id} has no structured content`);
	return parseStructuredContent(await file.async("string"));
}

async function outlineFor(
	id: string,
	sourceFilename: string,
): Promise<{ outline: readonly MineruOutlineEntry[]; markdown: string }> {
	const result = buildStructuredExtractionResult({
		content: await loadContent(id),
		sourceFilename,
	});
	return { outline: result.outline, markdown: result.markdown };
}

function shape(
	outline: readonly MineruOutlineEntry[],
): Array<[number, string, number | undefined]> {
	return outline.map((entry) => [entry.level, entry.title, entry.page]);
}

describe("MinerU outline — per-format heading levels", () => {
	it("html: keeps the level verbatim (doc_title 1, paragraph_title 2 and 3)", async () => {
		const { outline } = await outlineFor("html", "sample.html");

		expect(shape(outline)).toEqual([
			[1, "ALFA Quarterly Overview", 1],
			[2, "BRAVO Methodology", 1],
			[2, "CHARLIE Results", 1],
			[3, "DELTA Limitations", 1],
		]);
	});

	it("epub: keeps the level verbatim", async () => {
		const { outline } = await outlineFor("epub", "sample.epub");

		expect(shape(outline)).toEqual([
			[1, "ALFA Quarterly Overview", 1],
			[2, "BRAVO Methodology", 1],
			[2, "CHARLIE Results", 1],
		]);
	});

	it("docx: shifts the level by −1 and strips the wrapping bold", async () => {
		const { outline, markdown } = await outlineFor("docx", "sample.docx");

		// MinerU reports Heading1 as level 2 and wraps the title in `**…**`.
		expect(shape(outline)).toEqual([
			[1, "ALFA Quarterly Overview", 1],
			[2, "BRAVO Methodology", 1],
			[2, "CHARLIE Results", 1],
			[3, "DELTA Limitations", 1],
		]);
		// The production (prompt) renderer strips the same wrapping bold from
		// the rendered heading text as it does from the outline title — only
		// the FAITHFUL renderer (asserted separately in result.test.ts) stays
		// byte-identical to MinerU's own `markdown.md`, which keeps the `**`.
		expect(markdown).toContain("## ALFA Quarterly Overview");
		expect(markdown).not.toContain("**");
	});

	it("docx: leaves the level alone when no filename is supplied", async () => {
		const result = buildStructuredExtractionResult({
			content: await loadContent("docx"),
		});

		expect(result.outline[0].level).toBe(2);
		// The bold strip is unconditional: a title that is entirely bold is
		// noise in an outline in any format.
		expect(result.outline[0].title).toBe("ALFA Quarterly Overview");
	});

	it("xlsx: sheet names arrive as level 2, one per page", async () => {
		const { outline } = await outlineFor("xlsx", "sample.xlsx");

		expect(shape(outline)).toEqual([
			[2, "KILO Summary", 1],
			[2, "LIMA Detail", 2],
		]);
	});

	it("pptx: slide titles arrive as level 2, one per slide", async () => {
		const { outline } = await outlineFor("pptx", "sample.pptx");

		expect(shape(outline)).toEqual([
			[2, "ALFA Quarterly Overview", 1],
			[2, "CHARLIE Results", 2],
		]);
	});

	it("pdf at basic is flat, while the same PDF at flash gains a doc_title", async () => {
		const basic = await outlineFor("pdf", "sample.pdf");
		const flash = await outlineFor("flash-pdf", "sample.pdf");

		// Every heading is level 2: the basic layout model infers no depth.
		expect(basic.outline.map((entry) => entry.level)).toEqual([2, 2, 2, 2]);
		// Tier changes structure, not just quality — so the UI must never
		// depend on outline depth.
		expect(flash.outline[0].level).toBe(1);
		expect(flash.outline[0].title).toBe("ALFA Quarterly Overview");
	});

	it("png: OCR headings are flat and the format is not taken from file_suffix", async () => {
		const content = await loadContent("png");
		expect(content.metadata.file_suffix).toBe("pdf");

		const { outline } = await outlineFor("png", "sample.png");
		expect(shape(outline)).toEqual([
			[2, "ALFA Quarterly Overview", 1],
			[2, "CHARLIE Results", 1],
		]);
	});

	it("csv: has no title blocks at all and falls through to the heuristics", async () => {
		const content = await loadContent("csv");
		const blocks = content.pages.flatMap((page) => page.blocks);
		expect(blocks.every((block) => block.type === "table")).toBe(true);

		const { outline } = await outlineFor("csv", "sample.csv");
		// `extractDocumentOutline` finds nothing in a bare GFM table, which is
		// the honest answer — better than inventing a heading from a cell.
		expect(outline).toEqual([]);
	});
});

describe("MinerU outline — offsets and previews", () => {
	it("points `offset` at the heading's own `#`", async () => {
		const result = buildStructuredExtractionResult({
			content: await loadContent("pdf"),
			sourceFilename: "sample.pdf",
		});

		for (const entry of result.outline) {
			expect(result.markdown.slice(entry.offset, entry.offset + 3)).toBe("## ");
			expect(result.markdown.slice(entry.offset)).toContain(entry.title);
		}
	});

	it("previews the body that follows the heading", async () => {
		const result = buildStructuredExtractionResult({
			content: await loadContent("pdf"),
			sourceFilename: "sample.pdf",
		});

		expect(result.outline[0].preview).toMatch(/^Lorem ipsum dolor sit amet/);
		expect(result.outline[0].preview.length).toBeLessThanOrEqual(300);
	});

	it("carries the 1-based page of a multi-page document", async () => {
		const result = buildStructuredExtractionResult({
			content: await loadContent("pdf"),
			sourceFilename: "sample.pdf",
		});

		expect(result.outline.map((entry) => entry.page)).toEqual([1, 1, 2, 3]);
	});

	it("caps the block-derived outline at 200 entries", () => {
		const blocks = [];
		for (let index = 0; index < 250; index++) {
			blocks.push({
				type: "paragraph_title",
				level: 2,
				content: `Heading ${index}`,
			});
		}
		const content = parseStructuredContent({
			pages: [{ page_idx: 0, blocks }],
			metadata: { document: {} },
			extensions: {},
		});
		const rendered = renderPromptMarkdown(content);

		expect(
			buildMineruOutline({
				markdown: rendered.markdown,
				blocks: rendered.blocks,
				pages: rendered.pages,
			}),
		).toHaveLength(200);
	});

	it("falls back to the heuristics and still attaches a page", () => {
		// No title blocks, but plain-Markdown headings in the body text — the
		// case §4.5 fallback rule 2 exists for.
		const content = parseStructuredContent({
			pages: [
				{
					page_idx: 0,
					blocks: [{ type: "text", content: "# One\n\nBody one" }],
				},
				{
					page_idx: 1,
					blocks: [{ type: "text", content: "# Two\n\nBody two" }],
				},
			],
			metadata: { document: { page_count: 2, page_count_kind: "physical" } },
			extensions: {},
		});
		const result = buildStructuredExtractionResult({ content });

		expect(result.outline.map((entry) => [entry.title, entry.page])).toEqual([
			["One", 1],
			["Two", 2],
		]);
	});
});
