// The renderer and MinerU 4.1: `equation`, `chart` and `page_footnote`.
//
// `fixtures/mineru-v41/results/` is what MinerU 4.1.7 really answered
// (docs/plans/mineru-4-1/spike-report.md, section 7): 19 results, each with
// MinerU's own `markdown.md` beside its `structured_content.json`, and the
// Standard PDF's `result.zip`. The standard tier emits three block types the 4.0
// corpus never held, and 4.0.12 already does (checked live against production on
// 2026-11-09, client-spec section 3.1); before this the prompt text lost every
// chart (and its caption) and printed display math as bare LaTeX.
//
// The 4.0 corpus and the rest of the renderer are in `result.test.ts`.

import { describe, expect, it } from "vitest";
import {
	ATOMIC_BLOCK_TYPES,
	buildStructuredExtractionResult,
	isAtomicBlockType,
	isKnownBlockType,
	parseMineruResultZip,
	parseStructuredContent,
	renderMineruMarkdown,
	renderPromptMarkdown,
	type StructuredContent,
} from "./result";
import {
	loadV41,
	readV41,
	stripAnchorLines,
	V41_PAPER_ZIP,
	V41_SAMPLES,
} from "./result-corpus.test-helpers";

/** A one-page document from hand-written blocks (any key a block can carry). */
function contentOf(
	blocks: ReadonlyArray<Record<string, unknown>>,
	document: Record<string, unknown> = {},
): StructuredContent {
	return parseStructuredContent({
		pages: [{ page_idx: 0, blocks }],
		metadata: { document },
		extensions: {},
	});
}

/** The Standard PDF's display equation, as MinerU wrote it (`\tag` included). */
const PAPER_EQUATION = String.raw`T (n) = a + b n + c n ^ {2}, \quad \int_ {0} ^ {\infty} e ^ {- x ^ {2}} d x = \frac {\sqrt {\pi}}{2}\tag{1}`;

/** MinerU's own HTML around a `page_footnote` in its `markdown.md`. */
function mineruFootnote(text: string): string {
	return `<small><span class="docvortex-page-footnote" data-block-type="page_footnote" style="color:#6b7280">${text}</span></small>`;
}

describe("MinerU 4.1 results — the capture corpus", () => {
	it.each(
		V41_SAMPLES,
	)("$slug: renderMineruMarkdown reproduces markdown.md ($equivalence)", async (sample) => {
		const rendered = renderMineruMarkdown(await loadV41(sample.slug), {
			sourceFilename: sample.filename,
		});
		const mineruMarkdown = await readV41(sample.slug, "markdown.md");

		if (sample.equivalence === "identical") {
			expect(rendered).toBe(mineruMarkdown);
			return;
		}
		// Not byte-identical: prove the ONLY difference is anchor lines.
		expect(rendered).not.toBe(mineruMarkdown);
		expect(stripAnchorLines(mineruMarkdown)).toBe(rendered);
	});

	it.each(
		V41_SAMPLES,
	)("$slug: reports no unknown block types", async (sample) => {
		const result = buildStructuredExtractionResult({
			content: await loadV41(sample.slug),
			sourceFilename: sample.filename,
		});

		expect(result.stats.unknownTypes).toEqual({});
		expect(result.blocks.some((block) => block.unknownType)).toBe(false);
	});

	it.each(
		V41_SAMPLES,
	)("$slug: page offsets partition the markdown and every block quotes it", async (sample) => {
		const result = buildStructuredExtractionResult({
			content: await loadV41(sample.slug),
			sourceFilename: sample.filename,
		});

		expect(result.pages).toHaveLength(result.pageCount);
		expect(result.pages[0].start).toBe(0);
		expect(result.pages[result.pages.length - 1].end).toBe(
			result.markdown.length,
		);
		for (let index = 0; index + 1 < result.pages.length; index++) {
			expect(result.pages[index].end).toBe(result.pages[index + 1].start);
		}
		for (const block of result.blocks) {
			expect(result.markdown.slice(block.start, block.end)).toBe(block.text);
		}
	});

	it.each(
		V41_SAMPLES,
	)("$slug: keeps one figure per image or chart", async (sample) => {
		const rendered = renderPromptMarkdown(await loadV41(sample.slug), {
			sourceFilename: sample.filename,
		});

		expect(rendered.figures).toHaveLength(sample.figureCount);
		// The prompt text never carries a markdown image link, only handles.
		expect(rendered.markdown).not.toContain("![](");
	});

	it("never lets MinerU's HTML footnote wrapper reach the prompt text", async () => {
		for (const sample of V41_SAMPLES) {
			const rendered = renderPromptMarkdown(await loadV41(sample.slug), {
				sourceFilename: sample.filename,
			});
			expect(rendered.markdown, sample.slug).not.toContain("<small>");
			expect(rendered.markdown, sample.slug).not.toContain("docvortex");
		}
	});
});

describe("MinerU 4.1 blocks — the vocabulary", () => {
	it("knows equation, its Draft alias, chart and page_footnote", () => {
		for (const type of [
			"equation",
			"equation_interline",
			"chart",
			"page_footnote",
		]) {
			expect(isKnownBlockType(type), type).toBe(true);
		}
	});

	it("keeps display math and charts whole, and a footnote is plain prose", () => {
		for (const type of ["equation", "equation_interline", "chart"]) {
			expect(isAtomicBlockType(type), type).toBe(true);
		}
		expect(ATOMIC_BLOCK_TYPES).toContain("equation");
		expect(isAtomicBlockType("page_footnote")).toBe(false);
	});
});

describe("MinerU 4.1 blocks — equation", () => {
	it("fences the display equation with $$ and keeps its \\tag", async () => {
		const rendered = renderPromptMarkdown(
			await loadV41("pdf-paper-default-tier"),
			{ sourceFilename: "document.pdf" },
		);

		expect(rendered.markdown).toContain(
			`The latency model that we fit is given by\n\n$$\n${PAPER_EQUATION}\n$$\n\nwhere is the number of pages`,
		);
		expect(rendered.blocks.find((b) => b.type === "equation")).toMatchObject({
			page: 1,
			unknownType: false,
			atomic: true,
			text: `$$\n${PAPER_EQUATION}\n$$`,
		});
		expect(rendered.markdown).toContain("\\tag{1}");
	});

	it("renders equation_interline exactly like equation", () => {
		const document = (type: string) =>
			contentOf([
				{ type: "text", content: "Before" },
				{ type, content: "E = mc^2" },
				{ type: "text", content: "After" },
			]);
		const expected = "Before\n\n$$\nE = mc^2\n$$\n\nAfter";

		for (const type of ["equation", "equation_interline"]) {
			expect(renderMineruMarkdown(document(type)), type).toBe(expected);
			expect(renderPromptMarkdown(document(type)).markdown, type).toBe(
				expected,
			);
			expect(
				buildStructuredExtractionResult({ content: document(type) }).stats
					.unknownTypes,
				type,
			).toEqual({});
		}
	});

	it("does not fence an equation its producer already fenced", () => {
		for (const content of ["$$E = mc^2$$", "  $$\nE = mc^2\n$$  "]) {
			const rendered = renderPromptMarkdown(
				contentOf([{ type: "equation", content }]),
			);
			expect(rendered.markdown).toBe("$$\nE = mc^2\n$$");
		}
	});

	it("keeps a picture-only equation as MinerU's image link and gives the prompt nothing to read", async () => {
		// The flash tier has no formula model: the display equation arrives with an
		// empty `content` and only a crop of the page in `image_source`.
		const content = await loadV41("pdf-paper-flash");
		const faithful = renderMineruMarkdown(content, {
			sourceFilename: "document.pdf",
		});
		const prompt = renderPromptMarkdown(content, {
			sourceFilename: "document.pdf",
		});

		expect(faithful).toContain(
			"is given by\n\n![](images/page_0_equation_6.jpg)\n\nwhere is the number of pages",
		);
		// There is no text to hand the model, and a crop of an equation is not a
		// figure anyone asks about: the only figure is the flash tier's image block.
		expect(prompt.markdown).not.toContain("page_0_equation_6");
		expect(prompt.figures.map((figure) => figure.path)).toEqual([
			"images/page_1_image_3.jpg",
		]);
	});

	it("skips an equation with neither LaTeX nor a picture", () => {
		const rendered = renderPromptMarkdown(
			contentOf([
				{ type: "text", content: "Before" },
				{ type: "equation", content: "  " },
			]),
		);

		expect(rendered.markdown).toBe("Before");
		expect(rendered.blocks.map((block) => block.type)).toEqual(["text"]);
	});
});

describe("MinerU 4.1 blocks — chart", () => {
	it("becomes a captioned figure handle in the prompt text, like an image", async () => {
		const rendered = renderPromptMarkdown(
			await loadV41("pdf-paper-default-tier"),
			{ sourceFilename: "document.pdf" },
		);

		expect(rendered.figures).toEqual([
			{
				index: 1,
				path: "images/page_1_chart_3.jpg",
				caption: "Figure 1. Relative throughput by tier.",
				page: 2,
				bbox: [0.268, 0.273, 0.764, 0.504],
			},
		]);
		expect(rendered.markdown).toContain(
			"[Figure 1: Figure 1. Relative throughput by tier.]",
		);
		// The caption is inside the handle and is never emitted a second time.
		expect(
			rendered.markdown.match(/Relative throughput by tier/g),
		).toHaveLength(1);
		expect(rendered.blocks.find((b) => b.type === "chart")).toMatchObject({
			page: 2,
			unknownType: false,
			atomic: true,
			figure: { path: "images/page_1_chart_3.jpg" },
		});
	});

	it("is MinerU's image link and caption in the faithful rendering", async () => {
		const faithful = renderMineruMarkdown(
			await loadV41("pdf-paper-default-tier"),
			{ sourceFilename: "document.pdf" },
		);

		expect(faithful).toContain(
			"![](images/page_1_chart_3.jpg)\n\nFigure 1. Relative throughput by tier.",
		);
	});

	it("numbers images and charts in one sequence", () => {
		const rendered = renderPromptMarkdown(
			contentOf([
				{
					type: "image",
					content: "",
					image_source: "images/a.jpg",
					captions: [{ content: "First" }],
				},
				{
					type: "chart",
					content: "",
					image_source: "images/b.jpg",
					captions: [{ content: "Second" }],
				},
				{ type: "chart", content: "", image_source: "images/c.jpg" },
			]),
		);

		expect(
			rendered.figures.map((figure) => [figure.index, figure.path]),
		).toEqual([
			[1, "images/a.jpg"],
			[2, "images/b.jpg"],
			[3, "images/c.jpg"],
		]);
		expect(rendered.markdown).toBe(
			"[Figure 1: First]\n\n[Figure 2: Second]\n\n[Figure 3]",
		);
	});

	it("keeps the caption of a chart whose picture cannot become a bundle file", () => {
		const rendered = renderPromptMarkdown(
			contentOf([
				{
					type: "chart",
					content: "",
					image_source: "data:image/jpeg;base64,AAAA",
					captions: [{ content: "Inlined chart" }],
				},
			]),
		);

		expect(rendered.figures).toEqual([]);
		expect(rendered.markdown).toBe("Inlined chart");
	});

	it.each([
		"image",
		"chart",
	])("keeps every caption of a %s once: the first in its handle, the rest after it", (type) => {
		// A figure's captions are separate boxes on the page (a sub-caption per
		// panel, a second line that the layout model cut apart), and each is a
		// caption of its own in `captions[]`. The handle names the figure by the
		// first; the others are not dropped.
		const block = {
			type,
			content: "",
			image_source: "images/f.jpg",
			captions: [
				{ content: "Figure 3. Throughput by tier" },
				{ content: "(b) Cold start, 12 pages" },
			],
			footnotes: [{ content: "Source: the spike corpus" }],
		};
		const rendered = renderPromptMarkdown(contentOf([block]));

		expect(rendered.markdown).toBe(
			"[Figure 1: Figure 3. Throughput by tier]\n\n(b) Cold start, 12 pages\n\nSource: the spike corpus",
		);
		expect(rendered.figures).toMatchObject([
			{ index: 1, caption: "Figure 3. Throughput by tier" },
		]);
		for (const text of [
			"Figure 3. Throughput by tier",
			"(b) Cold start, 12 pages",
			"Source: the spike corpus",
		]) {
			expect(rendered.markdown.split(text).length - 1, text).toBe(1);
		}
		// MinerU's own rendering has always kept them all, in this order.
		expect(renderMineruMarkdown(contentOf([block]))).toBe(
			"![](images/f.jpg)\n\nFigure 3. Throughput by tier\n\n(b) Cold start, 12 pages\n\nSource: the spike corpus",
		);
	});

	it("keeps every caption of a figure that has no handle", () => {
		const rendered = renderPromptMarkdown(
			contentOf([
				{
					type: "chart",
					content: "",
					image_source: "data:image/jpeg;base64,AAAA",
					captions: [{ content: "First" }, { content: "Second" }],
				},
			]),
		);

		expect(rendered.markdown).toBe("First\n\nSecond");
	});

	it("keeps text a chart carries beside its picture", () => {
		const table = "| x | y |\n| --- | --- |\n| 1 | 2 |";
		const block = {
			type: "chart",
			content: table,
			image_source: "images/c.jpg",
			captions: [{ content: "Chart caption" }],
			footnotes: [{ content: "Source: tests" }],
		};

		expect(renderPromptMarkdown(contentOf([block])).markdown).toBe(
			`[Figure 1: Chart caption]\n\n${table}\n\nSource: tests`,
		);
		expect(renderMineruMarkdown(contentOf([block]))).toBe(
			`![](images/c.jpg)\n\nChart caption\n\n${table}\n\nSource: tests`,
		);
	});

	it("skips a chart with no picture, no caption and no text", () => {
		const rendered = renderPromptMarkdown(
			contentOf([
				{ type: "text", content: "Before" },
				{ type: "chart", content: "" },
			]),
		);

		expect(rendered.markdown).toBe("Before");
		expect(rendered.figures).toEqual([]);
	});
});

describe("MinerU 4.1 blocks — page_footnote", () => {
	it("is a plain paragraph in the prompt text of a PDF page", async () => {
		const rendered = renderPromptMarkdown(
			await loadV41("pdf-paper-default-tier"),
			{ sourceFilename: "document.pdf" },
		);

		expect(rendered.markdown).toContain(
			"in Table 1 on the next page.\n\n1 The norm constraint is the usual unit-ball regularisation; it is stated here only as an example footnote.\n\nTable 1. Parsing latency by tier (milliseconds).",
		);
		expect(rendered.markdown).not.toContain("Speaker notes");
		expect(
			rendered.blocks.find((b) => b.type === "page_footnote"),
		).toMatchObject({ page: 1, unknownType: false, atomic: false });
	});

	it("labels speaker notes once on a slide deck, even though MinerU already did", async () => {
		// The capture's own text starts with `Speaker notes: `; adding the label
		// again would read "Speaker notes: Speaker notes: remember...".
		const rendered = renderPromptMarkdown(await loadV41("pptx-default"));

		expect(rendered.markdown).toBe(
			[
				"# Tiered Parsing",
				"Spike deck: árvíztűrő tükörfúrógép",
				"## Key points",
				"- Flash is fastest\n- Basic adds OCR\n- Standard adds the VLM\n- Advanced spends more compute",
				"Speaker notes: remember to mention the Hungarian test page.",
				"## Latency table",
				"| Tier | Pages | ms |\n| --- | --- | --- |\n| flash | 12 | 810 |\n| basic | 12 | 1126 |",
			].join("\n\n"),
		);
	});

	describe("on slide pages", () => {
		const slides = (blocks: ReadonlyArray<Record<string, unknown>>) =>
			contentOf(blocks, { page_count: 1, page_count_kind: "slide" });

		it("adds the label to notes that arrive without it", () => {
			const rendered = renderPromptMarkdown(
				slides([
					{ type: "text", content: "Title" },
					{
						type: "page_footnote",
						content: "Mention the pangram.\n\nThen demo.",
					},
				]),
			);

			expect(rendered.markdown).toBe(
				"Title\n\nSpeaker notes: Mention the pangram.\n\nThen demo.",
			);
		});

		it.each([
			"speaker notes: Remember",
			"SPEAKER NOTES:Remember",
			"  Speaker  notes :   Remember  ",
			"Remember",
		])("writes one canonical label for %j", (content) => {
			const rendered = renderPromptMarkdown(
				slides([{ type: "page_footnote", content }]),
			);

			expect(rendered.markdown).toBe("Speaker notes: Remember");
		});

		it("drops a note that is only its label", () => {
			const rendered = renderPromptMarkdown(
				slides([
					{ type: "text", content: "Title" },
					{ type: "page_footnote", content: "Speaker notes:  " },
				]),
			);

			expect(rendered.markdown).toBe("Title");
		});

		it("recognises a slide deck by its file when MinerU reports no kind", () => {
			// Legacy `.ppt` carries no `page_count_kind`; the file's registry category
			// answers, as it does for the page-count unit.
			const content = contentOf(
				[{ type: "page_footnote", content: "Remember" }],
				{ page_count: 1 },
			);

			expect(
				renderPromptMarkdown(content, { sourceFilename: "legacy.ppt" })
					.markdown,
			).toBe("Speaker notes: Remember");
			expect(
				renderPromptMarkdown(content, { sourceFilename: "legacy.doc" })
					.markdown,
			).toBe("Remember");
		});

		it("leaves the faithful rendering with MinerU's own wrapper and no label", () => {
			const faithful = renderMineruMarkdown(
				slides([
					{ type: "text", content: "Title" },
					{ type: "page_footnote", content: "Remember" },
				]),
			);

			expect(faithful).toBe(`Title\n\n${mineruFootnote("Remember")}`);
		});
	});

	it("leaves a footnote that merely starts with those words alone on other documents", () => {
		const content = contentOf(
			[{ type: "page_footnote", content: "Speaker notes: see appendix B" }],
			{ page_count: 1, page_count_kind: "physical" },
		);

		expect(renderPromptMarkdown(content).markdown).toBe(
			"Speaker notes: see appendix B",
		);
		expect(renderMineruMarkdown(content)).toBe(
			mineruFootnote("Speaker notes: see appendix B"),
		);
	});

	it("skips a blank footnote in both renderings", () => {
		const content = contentOf([
			{ type: "text", content: "Body" },
			{ type: "page_footnote", content: "   " },
		]);

		expect(renderPromptMarkdown(content).markdown).toBe("Body");
		expect(renderMineruMarkdown(content)).toBe("Body");
	});
});

describe("MinerU 4.1 result zip", () => {
	it("parses the Standard PDF's zip into a chart figure, fenced math and no unknown types", async () => {
		const parsed = await parseMineruResultZip({
			zipPathAbsolute: V41_PAPER_ZIP,
			jobTier: "standard",
			serverParserVersion: "4.1.7",
			sourceFilename: "document.pdf",
		});
		const result = parsed.result;

		expect(result.producerVersion).toBe("4.1.7");
		expect(result.effectiveTier).toBe("standard");
		expect(result.pageCount).toBe(2);
		expect(result.stats.unknownTypes).toEqual({});
		expect(result.figures.map((figure) => figure.path)).toEqual([
			"images/page_1_chart_3.jpg",
		]);
		expect(result.markdown).toContain(`$$\n${PAPER_EQUATION}\n$$`);
		expect(result.markdown).toContain(
			"[Figure 1: Figure 1. Relative throughput by tier.]",
		);
		// The zip's own markdown.md is the oracle for the faithful rendering.
		expect(
			renderMineruMarkdown(
				parseStructuredContent(parsed.structuredContentJson),
				{
					sourceFilename: "document.pdf",
				},
			),
		).toBe(parsed.mineruMarkdown);
	});
});
