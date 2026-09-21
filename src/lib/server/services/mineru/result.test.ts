// Fixture-driven proof that the block model loses nothing.
//
// Every assertion here reads a real `fixtures/mineru-v1/<input>/result.zip`
// produced by a MinerU 4.0.4 Local Parse Server, not a hand-written sample.
// The equivalence table (§4.3) is the load-bearing one: it is the whole
// justification for building the prompt text from blocks instead of using
// MinerU's own `markdown.md`.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
	ATOMIC_BLOCK_TYPES,
	buildStructuredExtractionResult,
	DEFAULT_MINERU_ZIP_LIMITS,
	isAtomicBlockType,
	MINERU_PARSER_VERSION,
	MINERU_ZIP_STRUCTURED_CONTENT,
	MineruResultError,
	openMineruResultZip,
	parseMineruResultZip,
	parseStructuredContent,
	renderMineruMarkdown,
	renderPromptMarkdown,
	type StructuredContent,
} from "./result";

const FIXTURE_ROOT = join(process.cwd(), "fixtures", "mineru-v1");

interface FixtureCase {
	id: string;
	/** The uploaded filename, which is the only trustworthy format signal. */
	filename: string;
	/** `renderMineruMarkdown` vs the zip's own `markdown.md`. */
	equivalence: "identical" | "anchors-only";
	effectiveTier: string;
	parseMode: string;
	pageCount: number;
	pageCountKind: string;
	figureCount: number;
}

/**
 * The §4.3 equivalence table, extended with `jpg` (the spec's table lists nine
 * rows and omits it; it behaves exactly like `png`).
 */
const FIXTURES: readonly FixtureCase[] = [
	{
		id: "pdf",
		filename: "sample.pdf",
		equivalence: "identical",
		effectiveTier: "basic",
		parseMode: "txt",
		pageCount: 3,
		pageCountKind: "physical",
		figureCount: 1,
	},
	{
		id: "flash-pdf",
		filename: "sample.pdf",
		equivalence: "identical",
		effectiveTier: "flash",
		parseMode: "txt",
		pageCount: 3,
		pageCountKind: "physical",
		figureCount: 1,
	},
	{
		id: "docx",
		filename: "sample.docx",
		equivalence: "identical",
		effectiveTier: "flash",
		parseMode: "txt",
		pageCount: 1,
		pageCountKind: "declared",
		figureCount: 1,
	},
	{
		id: "xlsx",
		filename: "sample.xlsx",
		equivalence: "identical",
		effectiveTier: "flash",
		parseMode: "txt",
		pageCount: 2,
		pageCountKind: "sheet",
		figureCount: 0,
	},
	{
		id: "pptx",
		filename: "sample.pptx",
		equivalence: "identical",
		effectiveTier: "flash",
		parseMode: "txt",
		pageCount: 2,
		pageCountKind: "slide",
		figureCount: 1,
	},
	{
		id: "csv",
		filename: "sample.csv",
		equivalence: "identical",
		effectiveTier: "flash",
		parseMode: "txt",
		pageCount: 1,
		pageCountKind: "logical",
		figureCount: 0,
	},
	{
		id: "png",
		filename: "sample.png",
		equivalence: "identical",
		effectiveTier: "basic",
		parseMode: "ocr",
		// PNG/JPEG carry no `page_count` at all — this is `pages.length`.
		pageCount: 1,
		pageCountKind: "unknown",
		figureCount: 0,
	},
	{
		id: "jpg",
		filename: "sample.jpg",
		equivalence: "identical",
		effectiveTier: "basic",
		parseMode: "ocr",
		pageCount: 1,
		pageCountKind: "unknown",
		figureCount: 0,
	},
	{
		id: "html",
		filename: "sample.html",
		equivalence: "anchors-only",
		effectiveTier: "flash",
		parseMode: "txt",
		pageCount: 1,
		pageCountKind: "logical",
		figureCount: 0,
	},
	{
		id: "epub",
		filename: "sample.epub",
		equivalence: "anchors-only",
		effectiveTier: "flash",
		parseMode: "txt",
		pageCount: 1,
		pageCountKind: "spine",
		figureCount: 0,
	},
];

const ANCHOR_LINE = /^<a id="[^"]*"><\/a>$/;

function zipPath(id: string): string {
	return join(FIXTURE_ROOT, id, "result.zip");
}

async function readZipped(id: string, entry: string): Promise<string> {
	const zip = await JSZip.loadAsync(await readFile(zipPath(id)));
	const file = zip.file(entry);
	if (!file) throw new Error(`fixture ${id} has no ${entry}`);
	return file.async("string");
}

async function loadContent(id: string): Promise<StructuredContent> {
	return parseStructuredContent(
		await readZipped(id, MINERU_ZIP_STRUCTURED_CONTENT),
	);
}

/**
 * The anchor lines MinerU injects for HTML/EPUB, removed. An anchor sits on
 * its own line immediately above the heading it labels, so dropping the line
 * also drops the newline it introduced.
 */
function stripAnchorLines(markdown: string): string {
	return markdown
		.split("\n")
		.filter((line) => !ANCHOR_LINE.test(line))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n");
}

describe("MinerU structured result — the §4.3 equivalence table", () => {
	it.each(
		FIXTURES,
	)("$id: renderMineruMarkdown reproduces markdown.md ($equivalence)", async (fixture) => {
		const content = await loadContent(fixture.id);
		const mineruMarkdown = await readZipped(fixture.id, "markdown.md");
		const rendered = renderMineruMarkdown(content, {
			sourceFilename: fixture.filename,
		});

		if (fixture.equivalence === "identical") {
			expect(rendered).toBe(mineruMarkdown);
			return;
		}

		// Not byte-identical: prove the ONLY difference is anchor lines.
		expect(rendered).not.toBe(mineruMarkdown);
		expect(stripAnchorLines(mineruMarkdown)).toBe(rendered);

		const extraLines = mineruMarkdown
			.split("\n")
			.filter((line) => !rendered.split("\n").includes(line));
		expect(extraLines.length).toBeGreaterThan(0);
		for (const line of extraLines) {
			expect(line).toMatch(ANCHOR_LINE);
		}
	});
});

describe("MinerU structured result — the parsed model", () => {
	it.each(FIXTURES)("$id: derives the documented metadata", async (fixture) => {
		const parsed = await parseMineruResultZip({
			zipPathAbsolute: zipPath(fixture.id),
			jobTier: "basic",
			serverParserVersion: "4.0.4",
			sourceFilename: fixture.filename,
		});
		const result = parsed.result;

		expect(result.parserVersion).toBe(MINERU_PARSER_VERSION);
		expect(result.producerVersion).toBe("4.0.4");
		expect(result.serverParserVersion).toBe("4.0.4");
		// The REAL per-file tier, not the job's.
		expect(result.effectiveTier).toBe(fixture.effectiveTier);
		expect(result.jobTier).toBe("basic");
		expect(result.parseMode).toBe(fixture.parseMode);
		expect(result.pageCount).toBe(fixture.pageCount);
		expect(result.pageCountKind).toBe(fixture.pageCountKind);
		expect(result.figures).toHaveLength(fixture.figureCount);
		expect(result.markdown.length).toBeGreaterThan(0);
		expect(parsed.mineruMarkdown).not.toBeNull();
		expect(parsed.structuredContentJson).toContain('"pages"');
	});

	it.each(
		FIXTURES,
	)("$id: page offsets partition the markdown exactly", async (fixture) => {
		const content = await loadContent(fixture.id);
		const result = buildStructuredExtractionResult({
			content,
			sourceFilename: fixture.filename,
		});

		expect(result.pages).toHaveLength(result.pageCount);
		expect(result.pages[0].start).toBe(0);
		expect(result.pages[result.pages.length - 1].end).toBe(
			result.markdown.length,
		);
		for (let index = 0; index + 1 < result.pages.length; index++) {
			expect(result.pages[index].end).toBe(result.pages[index + 1].start);
			expect(result.pages[index].page).toBe(index + 1);
		}
	});

	it.each(
		FIXTURES,
	)("$id: every block's offsets quote the markdown verbatim", async (fixture) => {
		const content = await loadContent(fixture.id);
		const result = buildStructuredExtractionResult({
			content,
			sourceFilename: fixture.filename,
		});

		for (const block of result.blocks) {
			expect(result.markdown.slice(block.start, block.end)).toBe(block.text);
			const page = result.pages[block.page - 1];
			expect(block.start).toBeGreaterThanOrEqual(page.start);
			expect(block.end).toBeLessThanOrEqual(page.end);
		}
	});

	it.each(
		FIXTURES,
	)("$id: reports no unknown block types and drops the running heads", async (fixture) => {
		const content = await loadContent(fixture.id);
		const result = buildStructuredExtractionResult({
			content,
			sourceFilename: fixture.filename,
		});

		expect(result.stats.unknownTypes).toEqual({});
		expect(result.blocks.some((block) => block.unknownType)).toBe(false);
		for (const block of result.blocks) {
			expect(["header", "footer", "page_number"]).not.toContain(block.type);
		}
	});

	it("drops the PDF running heads from the prompt text", async () => {
		const content = await loadContent("pdf");
		const result = buildStructuredExtractionResult({
			content,
			sourceFilename: "sample.pdf",
		});

		// One header, one footer and one page number per page, all filtered.
		expect(result.stats.droppedRunningHeads).toBe(9);
		expect(result.markdown).not.toContain("INDIA Confidential");
		expect(result.markdown).not.toContain("JULIET Document Footer");
		expect(result.markdown).not.toContain("Page 1");
		expect(result.markdown).toContain("ALFA Quarterly Overview");
	});

	it("keeps bbox for PDF and records its absence for Office input", async () => {
		const pdf = buildStructuredExtractionResult({
			content: await loadContent("pdf"),
			sourceFilename: "sample.pdf",
		});
		const docx = buildStructuredExtractionResult({
			content: await loadContent("docx"),
			sourceFilename: "sample.docx",
		});

		expect(pdf.stats.bboxPresent).toBe(true);
		// The `bbox` KEY is absent for Office/HTML/EPUB/CSV — never null.
		expect(docx.stats.bboxPresent).toBe(false);
	});

	it("records anchors for HTML and EPUB only", async () => {
		const html = buildStructuredExtractionResult({
			content: await loadContent("html"),
			sourceFilename: "sample.html",
		});
		const pdf = buildStructuredExtractionResult({
			content: await loadContent("pdf"),
			sourceFilename: "sample.pdf",
		});

		expect(html.stats.anchorsPresent).toBe(true);
		expect(pdf.stats.anchorsPresent).toBe(false);
		// …and neither renderer ever emits one.
		expect(html.markdown).not.toContain("<a id=");
	});

	it("never derives the format from metadata.file_suffix", async () => {
		const content = await loadContent("png");
		// The PNG is wrapped in a PDF internally, so MinerU reports "pdf" here.
		expect(content.metadata.file_suffix).toBe("pdf");

		const result = buildStructuredExtractionResult({
			content,
			sourceFilename: "sample.png",
		});
		// A PDF would have `page_count_kind: "physical"`; the PNG has no
		// `metadata.document` at all, so the fallback must win.
		expect(result.pageCountKind).toBe("unknown");
		expect(result.pageCount).toBe(1);
	});

	it("uses page_count when present and pages.length when it is not", async () => {
		const pdf = await loadContent("pdf");
		expect(pdf.metadata.document.page_count).toBe(3);
		expect(buildStructuredExtractionResult({ content: pdf }).pageCount).toBe(3);

		const png = await loadContent("png");
		expect(png.metadata.document.page_count).toBeUndefined();
		expect(png.pages).toHaveLength(1);
		expect(buildStructuredExtractionResult({ content: png }).pageCount).toBe(1);
	});
});

describe("MinerU structured result — figures", () => {
	it("turns the PDF image into a captioned figure handle", async () => {
		const content = await loadContent("pdf");
		const rendered = renderPromptMarkdown(content, {
			sourceFilename: "sample.pdf",
		});

		expect(rendered.figures).toEqual([
			{
				index: 1,
				path: "images/page_2_image_body_3.jpg",
				caption: "Figure 1. HOTEL Figure caption text.",
				page: 3,
				bbox: [0.31, 0.194, 0.689, 0.356],
			},
		]);
		expect(rendered.markdown).toContain(
			"[Figure 1: Figure 1. HOTEL Figure caption text.]",
		);
		// The production renderer never emits a markdown image link.
		expect(rendered.markdown).not.toContain("![](");
	});

	it("emits a bare handle for an uncaptioned figure", async () => {
		const rendered = renderPromptMarkdown(await loadContent("docx"), {
			sourceFilename: "sample.docx",
		});

		expect(rendered.figures).toHaveLength(1);
		expect(rendered.figures[0].caption).toBeNull();
		expect(rendered.figures[0].bbox).toBeNull();
		expect(rendered.markdown).toContain("[Figure 1]");
	});

	it("ignores a data: URI image source, which cannot become a bundle file", () => {
		const content = parseStructuredContent({
			pages: [
				{
					page_idx: 0,
					blocks: [
						{
							type: "image",
							content: "",
							image_source: "data:image/jpeg;base64,AAAA",
							captions: [{ content: "Inlined figure" }],
						},
					],
				},
			],
			metadata: { document: {} },
			extensions: {},
		});
		const rendered = renderPromptMarkdown(content);

		expect(rendered.figures).toEqual([]);
		expect(rendered.markdown).toBe("Inlined figure");
	});
});

describe("MinerU structured result — unknown block types", () => {
	function withInjectedBlock(
		block: Record<string, unknown>,
	): StructuredContent {
		return parseStructuredContent({
			pages: [
				{
					page_idx: 0,
					blocks: [
						{ type: "paragraph_title", level: 2, content: "Heading" },
						block,
						{ type: "text", content: "After" },
					],
				},
			],
			metadata: { document: { page_count: 1, page_count_kind: "physical" } },
			extensions: { mineru: { tier: "standard", parse_mode: "txt" } },
		});
	}

	it("renders a Draft-named atomic type and still flags it for the GPU box", () => {
		const result = buildStructuredExtractionResult({
			content: withInjectedBlock({
				type: "equation_interline",
				content: "$$E = mc^2$$",
				unknown_future_key: { nested: true },
			}),
		});

		expect(result.markdown).toContain("$$E = mc^2$$");
		// `equation_interline` is listed in ATOMIC_BLOCK_TYPES but was never
		// OBSERVED, so it is atomic AND counted: the §8 checklist wants to hear
		// about the first `standard`-tier equation, not to have it pass silently.
		expect(result.blocks[1].atomic).toBe(true);
		expect(result.blocks[1].unknownType).toBe(true);
		expect(result.stats.unknownTypes).toEqual({ equation_interline: 1 });
		// An unrecognised sibling key survives `.passthrough()` instead of
		// failing the parse.
		expect(result.markdown).not.toContain("unknown_future_key");
	});

	it("treats a never-seen type as atomic and records it for the GPU box", () => {
		const result = buildStructuredExtractionResult({
			content: withInjectedBlock({
				type: "hologram",
				content: "Some future payload",
			}),
		});

		expect(result.markdown).toContain("Some future payload");
		expect(result.stats.unknownTypes).toEqual({ hologram: 1 });
		expect(result.blocks[1].unknownType).toBe(true);
		expect(result.blocks[1].atomic).toBe(true);
	});

	it("skips a block with neither text nor an image", () => {
		const result = buildStructuredExtractionResult({
			content: withInjectedBlock({ type: "chart", content: "   " }),
		});

		expect(result.blocks.map((block) => block.type)).toEqual([
			"paragraph_title",
			"text",
		]);
		expect(result.markdown).toBe("## Heading\n\nAfter");
	});

	it("keeps every ATOMIC_BLOCK_TYPES member atomic", () => {
		for (const type of ATOMIC_BLOCK_TYPES) {
			expect(isAtomicBlockType(type)).toBe(true);
		}
		expect(isAtomicBlockType("anything-else")).toBe(true);
		expect(isAtomicBlockType("text")).toBe(false);
		expect(isAtomicBlockType("paragraph_title")).toBe(false);
	});
});

describe("MinerU structured result — failure modes", () => {
	it("rejects a zip with no structured_content.json", async () => {
		const zip = new JSZip();
		zip.file("markdown.md", "# nothing to see here");
		const data = await zip.generateAsync({ type: "uint8array" });
		const opened = await openMineruResultZip({ data });

		expect(opened.has(MINERU_ZIP_STRUCTURED_CONTENT)).toBe(false);
		await expect(
			parseMineruResultZip({ zipPathAbsolute: "/dev/null" }),
		).rejects.toThrow();
	});

	it("rejects invalid JSON with a typed protocol error", () => {
		try {
			parseStructuredContent("{ not json");
			throw new Error("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(MineruResultError);
			const typed = error as MineruResultError;
			expect(typed.code).toBe("structured_content_invalid");
			expect(typed.taxonomy).toBe("protocol");
			expect(typed.retryable).toBe(true);
		}
	});

	it("rejects a shape that is not MinerU 4's", () => {
		try {
			// The upstream Draft schema: `items`, not `blocks`.
			parseStructuredContent({ pages: [{ page_idx: "zero", items: [] }] });
			throw new Error("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(MineruResultError);
			expect((error as MineruResultError).code).toBe(
				"structured_content_invalid",
			);
			expect((error as MineruResultError).details.zodIssues).toBeDefined();
		}
	});

	it("refuses a document whose every block was dropped", async () => {
		const zip = new JSZip();
		zip.file(
			MINERU_ZIP_STRUCTURED_CONTENT,
			JSON.stringify({
				pages: [
					{
						page_idx: 0,
						blocks: [
							{ type: "header", content: "Running head" },
							{ type: "page_number", content: "Page 1" },
						],
					},
				],
				metadata: { document: {} },
				extensions: {},
			}),
		);
		const path = join(
			process.cwd(),
			"data",
			`mineru-empty-${process.pid}-${Math.random().toString(36).slice(2)}.zip`,
		);
		const { mkdir, rm, writeFile } = await import("node:fs/promises");
		await mkdir(join(process.cwd(), "data"), { recursive: true });
		await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
		try {
			await expect(
				parseMineruResultZip({ zipPathAbsolute: path }),
			).rejects.toMatchObject({
				code: "empty_result",
				taxonomy: "empty_result",
				retryable: false,
			});
		} finally {
			await rm(path, { force: true });
		}
	});

	it("keeps the default limits above the largest recorded fixture", async () => {
		const opened = await openMineruResultZip({
			zipPathAbsolute: zipPath("pdf"),
		});
		const total = [...opened.entries.values()].reduce(
			(sum, bytes) => sum + bytes,
			0,
		);
		expect(total).toBeLessThan(DEFAULT_MINERU_ZIP_LIMITS.maxTotalBytes);
		expect(opened.imageNames).toEqual([
			"images/page_1_table_body_3.jpg",
			"images/page_2_image_body_3.jpg",
		]);
	});
});

// ── hostile zips ───────────────────────────────────────────────────────────
//
// `result.zip` arrives over HTTP from a service the app does not control, and
// it is the one input in this whole slice that is attacker-shaped. JSZip is
// only a parser: it will happily hand back an entry called
// `../../../../etc/passwd`, and it collapses two entries of the same name into
// one so a duplicate-name attack is invisible unless the central directory is
// read directly. Every case below is a REAL zip, built byte by byte by
// `buildRawZip`, not a mock — a guard that only ever sees well-formed input is
// not a guard.

interface RawZipEntry {
	name: string;
	data: string;
	/** Raw unix mode. `0o120777` marks a symbolic link. */
	unixPermissions?: number;
	/** Overrides the size written into the headers, to model a lying zip. */
	declaredUncompressedSize?: number;
}

/**
 * A minimal STORED (method 0) zip writer.
 *
 * Exists because JSZip cannot produce the shapes that need testing: it
 * normalises away duplicate names and offers no way to lie about an entry's
 * uncompressed size.
 */
function buildRawZip(
	entries: readonly RawZipEntry[],
	options?: { declaredTotalEntries?: number },
): Uint8Array {
	const encoder = new TextEncoder();
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let offset = 0;

	for (const entry of entries) {
		const nameBytes = encoder.encode(entry.name);
		const dataBytes = encoder.encode(entry.data);
		const declared = entry.declaredUncompressedSize ?? dataBytes.byteLength;

		const local = new Uint8Array(
			30 + nameBytes.byteLength + dataBytes.byteLength,
		);
		const localView = new DataView(local.buffer);
		localView.setUint32(0, 0x04034b50, true);
		localView.setUint16(4, 20, true); // version needed
		localView.setUint16(8, 0, true); // method: stored
		localView.setUint32(18, dataBytes.byteLength, true); // compressed size
		localView.setUint32(22, declared, true); // uncompressed size
		localView.setUint16(26, nameBytes.byteLength, true);
		local.set(nameBytes, 30);
		local.set(dataBytes, 30 + nameBytes.byteLength);
		locals.push(local);

		const central = new Uint8Array(46 + nameBytes.byteLength);
		const centralView = new DataView(central.buffer);
		centralView.setUint32(0, 0x02014b50, true);
		// "Version made by": platform 3 (UNIX) is what makes JSZip read the
		// external attributes as a unix mode.
		centralView.setUint16(4, (3 << 8) | 20, true);
		centralView.setUint16(6, 20, true);
		centralView.setUint16(10, 0, true); // method: stored
		centralView.setUint32(20, dataBytes.byteLength, true);
		centralView.setUint32(24, declared, true);
		centralView.setUint16(28, nameBytes.byteLength, true);
		centralView.setUint32(38, (entry.unixPermissions ?? 0o644) << 16, true);
		centralView.setUint32(42, offset, true);
		central.set(nameBytes, 46);
		centrals.push(central);

		offset += local.byteLength;
	}

	const centralSize = centrals.reduce((sum, part) => sum + part.byteLength, 0);
	const eocd = new Uint8Array(22);
	const eocdView = new DataView(eocd.buffer);
	eocdView.setUint32(0, 0x06054b50, true);
	const total = options?.declaredTotalEntries ?? entries.length;
	eocdView.setUint16(8, total, true);
	eocdView.setUint16(10, total, true);
	eocdView.setUint32(12, centralSize, true);
	eocdView.setUint32(16, offset, true);

	const size = offset + centralSize + eocd.byteLength;
	const out = new Uint8Array(size);
	let cursor = 0;
	for (const part of [...locals, ...centrals, eocd]) {
		out.set(part, cursor);
		cursor += part.byteLength;
	}
	return out;
}

async function expectZipRejection(
	data: Uint8Array,
	code: string,
	limits?: Parameters<typeof openMineruResultZip>[0]["limits"],
): Promise<MineruResultError> {
	let thrown: unknown;
	try {
		await openMineruResultZip(limits ? { data, limits } : { data });
	} catch (error) {
		thrown = error;
	}
	expect(thrown, `expected ${code}`).toBeInstanceOf(MineruResultError);
	const typed = thrown as MineruResultError;
	expect(typed.code).toBe(code);
	return typed;
}

describe("MinerU result zip — hostile input", () => {
	const good = { name: MINERU_ZIP_STRUCTURED_CONTENT, data: "{}" };

	it("refuses a parent-traversal entry", async () => {
		const error = await expectZipRejection(
			buildRawZip([good, { name: "../../../../etc/passwd", data: "root" }]),
			"zip_entry_rejected",
		);
		expect(error.details.reason).toBe("parent-traversal");
	});

	it("refuses a traversal hidden inside images/", async () => {
		const error = await expectZipRejection(
			buildRawZip([good, { name: "images/../../escape.jpg", data: "x" }]),
			"zip_entry_rejected",
		);
		expect(error.details.reason).toBe("parent-traversal");
	});

	it("refuses an absolute path", async () => {
		const error = await expectZipRejection(
			buildRawZip([good, { name: "/etc/shadow", data: "x" }]),
			"zip_entry_rejected",
		);
		expect(error.details.reason).toBe("absolute-path");
	});

	it("refuses a Windows drive path and a backslash separator", async () => {
		expect(
			(
				await expectZipRejection(
					buildRawZip([good, { name: "C:\\windows\\system32", data: "x" }]),
					"zip_entry_rejected",
				)
			).details.reason,
		).toBe("absolute-path");
		expect(
			(
				await expectZipRejection(
					buildRawZip([good, { name: "images\\evil.jpg", data: "x" }]),
					"zip_entry_rejected",
				)
			).details.reason,
		).toBe("backslash");
	});

	it("refuses a symlink entry", async () => {
		const error = await expectZipRejection(
			buildRawZip([
				good,
				{
					name: "images/link.jpg",
					data: "/etc/passwd",
					unixPermissions: 0o120777,
				},
			]),
			"zip_entry_rejected",
		);
		expect(error.details.reason).toBe("symlink");
	});

	it("refuses an image name that is not a plain filename", async () => {
		const error = await expectZipRejection(
			buildRawZip([good, { name: "images/nested/deep.jpg", data: "x" }]),
			"zip_entry_rejected",
		);
		expect(error.details.reason).toBe("unsafe-image-name");
	});

	it("refuses duplicate names, which JSZip silently collapses", async () => {
		const raw = buildRawZip([
			good,
			{ name: "images/a.jpg", data: "first" },
			{ name: "images/a.jpg", data: "second" },
		]);
		// Sanity: the parser really does hide the duplicate.
		const loaded = await JSZip.loadAsync(raw);
		expect(Object.keys(loaded.files)).toHaveLength(2);

		const error = await expectZipRejection(raw, "zip_entry_rejected");
		expect(String(error.details.reason)).toContain("duplicate-names");
	});

	it("refuses more entries than the cap allows", async () => {
		const entries = [good];
		for (let index = 0; index < 8; index++) {
			entries.push({ name: `images/img-${index}.jpg`, data: "x" });
		}
		await expectZipRejection(buildRawZip(entries), "zip_too_large", {
			maxEntries: 4,
		});
	});

	it("refuses a declared-size bomb before inflating a single byte", async () => {
		const raw = buildRawZip([
			good,
			{
				name: "images/bomb.jpg",
				data: "tiny",
				// Just under 2^32, the largest a non-zip64 header can express.
				declaredUncompressedSize: 4_000_000_000,
			},
		]);
		const error = await expectZipRejection(raw, "zip_too_large", {
			maxEntryBytes: 1024,
		});
		expect(error.details.entry).toBe("images/bomb.jpg");
	});

	it("refuses a real deflate bomb on the summed uncompressed size", async () => {
		const zip = new JSZip();
		zip.file(MINERU_ZIP_STRUCTURED_CONTENT, "{}");
		// 400 kB of zeros compresses to a few hundred bytes. The ratio, not the
		// absolute size, is what makes this the same shape as a 10 GB bomb.
		for (let index = 0; index < 4; index++) {
			zip.file(`images/zeros-${index}.jpg`, "0".repeat(100_000));
		}
		const data = await zip.generateAsync({
			type: "uint8array",
			compression: "DEFLATE",
		});
		expect(data.byteLength).toBeLessThan(20_000);

		await expectZipRejection(data, "zip_too_large", {
			maxTotalBytes: 150_000,
		});
	});

	it("refuses a zip file larger than the compressed cap", async () => {
		await expectZipRejection(buildRawZip([good]), "zip_too_large", {
			maxCompressedBytes: 8,
		});
	});

	it("refuses bytes that are not a zip at all", async () => {
		await expectZipRejection(
			new TextEncoder().encode("this is not a zip file"),
			"zip_unreadable",
		);
	});

	it("drops a safe but unrecognised entry instead of failing the parse", async () => {
		// A future MinerU artifact must not break every extraction. It is
		// dropped: never listed, never readable, never written to a bundle.
		const opened = await openMineruResultZip({
			data: buildRawZip([
				good,
				{ name: "content_list_v2.json", data: "[]" },
				{ name: "images/keep.jpg", data: "bytes" },
			]),
		});

		expect(opened.has(MINERU_ZIP_STRUCTURED_CONTENT)).toBe(true);
		expect(opened.has("content_list_v2.json")).toBe(false);
		expect(await opened.readText("content_list_v2.json")).toBeNull();
		expect(opened.imageNames).toEqual(["images/keep.jpg"]);
	});

	it("reads the accepted entries of a hand-built zip", async () => {
		const opened = await openMineruResultZip({
			data: buildRawZip([
				{ name: MINERU_ZIP_STRUCTURED_CONTENT, data: '{"pages":[]}' },
				{ name: "markdown.md", data: "# hi" },
				{ name: "images/a.jpg", data: "AAA" },
			]),
		});

		expect(await opened.readText(MINERU_ZIP_STRUCTURED_CONTENT)).toBe(
			'{"pages":[]}',
		);
		expect(await opened.readText("markdown.md")).toBe("# hi");
		const image = await opened.readBytes("images/a.jpg");
		expect(image).not.toBeNull();
		expect(Buffer.from(image as Uint8Array).toString("utf8")).toBe("AAA");
	});
});

// ── page attribution ───────────────────────────────────────────────────────
//
// A block's page used to be its array index + 1, full stop, and the parsed
// `page_idx` was read by the schema and then thrown away. That is right only
// for a `pages` array that is dense, ordered and complete — which every
// recorded fixture happens to be, and which nothing in the format guarantees.

describe("MinerU structured result — page attribution", () => {
	function content(
		pages: ReadonlyArray<Record<string, unknown>>,
	): StructuredContent {
		return parseStructuredContent({
			pages,
			metadata: { document: {} },
			extensions: {},
		});
	}

	it.each([
		"pdf",
		"docx",
		"pptx",
		"xlsx",
		"csv",
		"html",
		"epub",
		"png",
	])("%s: uses page_idx, and the recorded fixtures agree with array position", async (id) => {
		const result = buildStructuredExtractionResult({
			content: await loadContent(id),
		});
		// Every fixture is dense and ordered, so the two rules coincide —
		// which is exactly why nobody noticed the array index was the only
		// one implemented.
		expect(result.stats.pageNumberSource).toBe("page_idx");
	});

	it("cites a sparse pages array from page_idx, not from position", () => {
		const result = buildStructuredExtractionResult({
			content: content([
				{ page_idx: 0, blocks: [{ type: "text", content: "FIRST" }] },
				{ page_idx: 4, blocks: [{ type: "text", content: "FIFTH" }] },
				{ page_idx: 9, blocks: [{ type: "text", content: "TENTH" }] },
			]),
		});

		expect(result.stats.pageNumberSource).toBe("page_idx");
		expect(result.blocks.map((block) => block.page)).toEqual([1, 5, 10]);
		// The offsets table has to be able to answer about page 10.
		expect(result.pages.length).toBeGreaterThanOrEqual(10);
		expect(result.pageCount).toBeGreaterThanOrEqual(10);
	});

	it("cites a reordered pages array from page_idx", () => {
		const result = buildStructuredExtractionResult({
			content: content([
				{ page_idx: 2, blocks: [{ type: "text", content: "THIRD" }] },
				{ page_idx: 0, blocks: [{ type: "text", content: "FIRST" }] },
				{ page_idx: 1, blocks: [{ type: "text", content: "SECOND" }] },
			]),
		});

		expect(result.blocks.map((block) => block.page)).toEqual([3, 1, 2]);
	});

	it("falls back to array position when a page_idx repeats", () => {
		// A half-trusted index is worse than a consistent one: a citation that
		// is right for four pages and wrong for the fifth cannot be checked.
		const result = buildStructuredExtractionResult({
			content: content([
				{ page_idx: 0, blocks: [{ type: "text", content: "A" }] },
				{ page_idx: 0, blocks: [{ type: "text", content: "B" }] },
				{ page_idx: 7, blocks: [{ type: "text", content: "C" }] },
			]),
		});

		expect(result.stats.pageNumberSource).toBe("array_index");
		expect(result.blocks.map((block) => block.page)).toEqual([1, 2, 3]);
	});

	it("falls back to array position for a negative page_idx", () => {
		const result = buildStructuredExtractionResult({
			content: content([
				{ page_idx: -1, blocks: [{ type: "text", content: "A" }] },
				{ page_idx: 1, blocks: [{ type: "text", content: "B" }] },
			]),
		});

		expect(result.stats.pageNumberSource).toBe("array_index");
		expect(result.blocks.map((block) => block.page)).toEqual([1, 2]);
	});

	it("clamps an absurd page_idx rather than sizing an array from it", () => {
		const result = buildStructuredExtractionResult({
			content: content([
				{ page_idx: 0, blocks: [{ type: "text", content: "A" }] },
				{ page_idx: 900_000_000, blocks: [{ type: "text", content: "B" }] },
			]),
		});

		expect(result.blocks[1].page).toBeLessThanOrEqual(50_000);
		expect(result.pages.length).toBeLessThanOrEqual(50_000);
	});
});
