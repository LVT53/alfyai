// What the renderer's tests share about the MinerU 4.1.7 result corpus.
//
// `fixtures/mineru-v41/results/<slug>/` holds what MinerU 4.1.7 really answered
// for each input the spike sent (docs/plans/mineru-4-1/spike-report.md, section
// 7): its `structured_content.json` and its own `markdown.md`, and for the
// Standard PDF the `result.zip` as well. The renderer, the bundle, the outline
// and the chunk planner tests all read it, so the list of captures, the paths
// and the loaders are written here once.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseStructuredContent, type StructuredContent } from "./result";

const V41_ROOT = join(process.cwd(), "fixtures", "mineru-v41", "results");

function v41Path(slug: string, name: string): string {
	return join(V41_ROOT, slug, name);
}

/** One file of a capture, as text. */
export async function readV41(slug: string, name: string): Promise<string> {
	return readFile(v41Path(slug, name), "utf8");
}

/** A capture's `structured_content.json`, parsed. */
export async function loadV41(slug: string): Promise<StructuredContent> {
	return parseStructuredContent(await readV41(slug, "structured_content.json"));
}

/**
 * The Standard PDF's `result.zip`: a chart, a display equation and a table, each
 * with its own crop in `images/`.
 */
export const V41_PAPER_ZIP = v41Path("pdf-paper-default-tier", "result.zip");

interface V41Sample {
	slug: string;
	/** What the app sends MinerU (`document.<ext>`), the only format signal. */
	filename: string;
	/** `renderMineruMarkdown` vs the capture's own `markdown.md`. */
	equivalence: "identical" | "anchors-only";
	/** `image` and `chart` blocks that resolve to a bundle path. */
	figureCount: number;
}

function v41(
	slug: string,
	filename: string,
	figureCount: number,
	equivalence: V41Sample["equivalence"] = "identical",
): V41Sample {
	return { slug, filename, equivalence, figureCount };
}

/**
 * Every capture in the corpus. Several answers are byte-identical to another's
 * (the mixed batch repeats the PDF, DOCX and CSV captures, the explicit Standard
 * tier and the default+docx request repeat the default PDF, and the two page
 * ranges repeat each other): each was a request of its own, so each stays.
 */
export const V41_SAMPLES: readonly V41Sample[] = [
	v41("csv-default", "document.csv", 0),
	v41("docx-default", "document.docx", 1),
	v41("fmt-default-plus-docx", "document.pdf", 1),
	// HTML anchors stay unrendered, as documented.
	v41("html-default", "document.html", 0, "anchors-only"),
	v41("mixed-batch-pdf-docx-csv-0", "document.pdf", 1),
	v41("mixed-batch-pdf-docx-csv-1", "document.docx", 1),
	v41("mixed-batch-pdf-docx-csv-2", "document.csv", 0),
	v41("pdf-hu-accented-name", "document.pdf", 0),
	v41("pdf-paper-basic", "document.pdf", 1),
	v41("pdf-paper-default-tier", "document.pdf", 1),
	v41("pdf-paper-flash", "document.pdf", 1),
	v41("pdf-paper-ocr-forced", "document.pdf", 1),
	v41("pdf-paper-page-range-2", "document.pdf", 1),
	v41("pdf-paper-page-range-r1", "document.pdf", 1),
	v41("pdf-paper-standard", "document.pdf", 1),
	v41("pptx-default", "document.pptx", 0),
	v41("scan-pdf-default-tier", "document.pdf", 0),
	v41("scan-png-default-tier", "document.png", 0),
	v41("xlsx-default", "document.xlsx", 0),
];

/** The anchor lines MinerU injects into HTML and EPUB results. */
export const ANCHOR_LINE = /^<a id="[^"]*"><\/a>$/;

/**
 * The anchor lines MinerU injects for HTML/EPUB, removed. An anchor sits on
 * its own line immediately above the heading it labels, so dropping the line
 * also drops the newline it introduced.
 */
export function stripAnchorLines(markdown: string): string {
	return markdown
		.split("\n")
		.filter((line) => !ANCHOR_LINE.test(line))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n");
}
