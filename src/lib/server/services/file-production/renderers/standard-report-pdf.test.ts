import { readFileSync } from "node:fs";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
	type GeneratedDocumentSource,
	validateGeneratedDocumentSource,
} from "../source-schema";
import { renderStandardReportPdf } from "./standard-report-pdf";

const ONE_BY_ONE_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

async function extractPdfText(content: Buffer): Promise<string> {
	const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
	const task = pdfjs.getDocument({
		data: new Uint8Array(content),
		useSystemFonts: false,
	});
	const document = await task.promise;
	const text: string[] = [];

	for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
		const page = await document.getPage(pageNumber);
		const textContent = await page.getTextContent();
		for (const item of textContent.items) {
			if ("str" in item && item.str) {
				text.push(item.str);
			}
		}
		page.cleanup();
	}
	await document.destroy();
	return text.join(" ");
}

function readFixtureSource(filename: string): GeneratedDocumentSource {
	const fixture = JSON.parse(
		readFileSync(
			path.resolve(
				"fixtures/file-production/standard-report/positive",
				filename,
			),
			"utf8",
		),
	) as { documentSource: unknown };
	const validation = validateGeneratedDocumentSource(fixture.documentSource);
	if (!validation.ok) {
		throw new Error(`${filename} did not validate: ${validation.code}`);
	}
	return validation.source;
}

describe("AlfyAI Standard Report PDF renderer", () => {
	it("renders core fixture documents as styled A4 PDFs with stable metadata", async () => {
		for (const filename of [
			"hungarian-report.json",
			"long-report.json",
			"short-report.json",
			"technical-note.json",
		]) {
			const source = readFixtureSource(filename);
			const rendered = await renderStandardReportPdf(source);

			expect(rendered.filename.endsWith(".pdf")).toBe(true);
			expect(rendered.mimeType).toBe("application/pdf");
			expect(rendered.content.subarray(0, 4).toString("ascii")).toBe("%PDF");
			expect(rendered.diagnostics).toMatchObject({
				template: "alfyai_standard_report",
				pageFormat: "A4",
				bodyFontPt: 10.5,
				paragraphColor: "#3E3933",
				brandLogo: {
					source: "ui-vector-transparent-logo",
					headerHeightPt: 10,
					coverPlacement: "none",
					documentTitlePlacement: "none",
					headerPlacement: "logo-and-text",
				},
				marginMm: { top: 18, right: 16, bottom: 18, left: 16 },
				colors: {
					text: "#1B1815",
					secondaryText: "#6F6860",
					accent: "#B65F3D",
					pageBackground: "#FAF8F4",
				},
			});

			const pdfDoc = await PDFDocument.load(new Uint8Array(rendered.content));
			expect(pdfDoc.getTitle()).toBe(source.title);
			expect(pdfDoc.getAuthor()).toBe("AlfyAI");
			expect(pdfDoc.getCreator()).toBe("AlfyAI file production");
			expect(pdfDoc.getPageCount()).toBeGreaterThanOrEqual(1);
			const firstPage = pdfDoc.getPage(0);
			expect(firstPage.getWidth()).toBeCloseTo(595.28, 1);
			expect(firstPage.getHeight()).toBeCloseTo(841.89, 1);
		}
	});

	it("embeds portable bundled TrueType fonts instead of UI WOFF2 fonts", async () => {
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Unicode typography report",
			subtitle: "Árvíztűrő tükörfúrógép",
			cover: { enabled: true, eyebrow: "Typography", dateLabel: "May 2026" },
			blocks: [
				{
					type: "paragraph",
					text: "The PDF renderer must carry the same Unicode-capable font family as the app UI.",
				},
			],
		});
		expect(validation.ok).toBe(true);
		if (!validation.ok) return;

		const rendered = await renderStandardReportPdf(validation.source);
		const pdfBody = rendered.content.toString("latin1");

		expect(rendered.diagnostics.fonts).toEqual({
			body: "Liberation Sans",
			bodyBold: "Liberation Sans Bold",
			title: "Liberation Sans",
			titleBold: "Liberation Sans Bold",
			code: "Liberation Sans",
			source: "pdfjs-dist bundled TrueType fonts",
		});
		expect(pdfBody).not.toContain("wOF2");
		expect(pdfBody).not.toContain("DejaVu");
	});

	it("keeps text from every supported document-source block extractable in downloaded PDFs", async () => {
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Downloaded PDF integrity report",
			subtitle: "Árvíztűrő tükörfúrógép",
			blocks: [
				{ type: "heading", level: 2, text: "Executive summary" },
				{
					type: "paragraph",
					text: "All generated text should remain readable outside the app viewer.",
				},
				{
					type: "list",
					style: "bullet",
					items: ["Portable fonts", "Visible chart labels"],
				},
				{
					type: "callout",
					tone: "info",
					title: "Renderer check",
					text: "Callout text remains visible.",
				},
				{
					type: "table",
					title: "Evidence table",
					columns: [{ key: "area", label: "Area", kind: "text" }],
					rows: [{ area: "Downloaded file" }],
				},
				{
					type: "quote",
					text: "Downloaded output is the artifact of record.",
					citation: "QA",
				},
				{
					type: "chart",
					chartType: "bar",
					title: "Format coverage",
					caption: "A chart with visible labels.",
					altText: "Bar chart showing format coverage.",
					units: "checks",
					xKey: "format",
					yKey: "checks",
					data: [{ format: "PDF", checks: 3 }],
				},
			],
		});
		expect(validation.ok).toBe(true);
		if (!validation.ok) return;

		const rendered = await renderStandardReportPdf(validation.source);
		const text = await extractPdfText(rendered.content);

		expect(text).toContain("Downloaded PDF integrity report");
		expect(text).toContain("Árvíztűrő tükörfúrógép");
		expect(text).toContain("Executive summary");
		expect(text).toContain(
			"All generated text should remain readable outside the app viewer.",
		);
		expect(text).toContain("Portable fonts");
		expect(text).toContain("Renderer check");
		expect(text).toContain("Evidence table");
		expect(text).toContain("Downloaded file");
		expect(text).toContain("Downloaded output is the artifact of record.");
		expect(text).toContain("Format coverage");
		expect(text).toContain("PDF");
	});

	it("renders basis markers as compact extractable PDF notes", async () => {
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "PDF basis report",
			blocks: [
				{
					type: "paragraph",
					text: "Revenue increased by 12%.",
					basisMarkers: [
						{
							type: "basisMarker",
							id: "basis-supported",
							support: "supported",
							anchorText: "Revenue increased by 12%",
							rationale: "Accepted source states revenue increased by 12%.",
						},
					],
				},
				{
					type: "basisMarker",
					id: "basis-unsupported",
					support: "unsupported",
					rationale: "No accepted source supports the fallback claim.",
				},
			],
		});
		expect(validation.ok).toBe(true);
		if (!validation.ok) return;

		const rendered = await renderStandardReportPdf(validation.source);
		const text = await extractPdfText(rendered.content);

		expect(text).toContain(
			"Basis: Supported claim - Accepted source states revenue increased by 12%.",
		);
		expect(text).toContain(
			"Basis: Unsupported claim - No accepted source supports the fallback claim.",
		);
	});

	it("uses the transparent UI logo mark and normalizes generated dates for the first-page header", async () => {
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Branded date report",
			date: "Generated on May 4, 2026",
			blocks: [
				{
					type: "paragraph",
					text: "The document date should be rendered as a compact header value.",
				},
			],
		});
		expect(validation.ok).toBe(true);
		if (!validation.ok) return;

		const rendered = await renderStandardReportPdf(validation.source);

		expect(rendered.diagnostics.brandLogo).toEqual({
			source: "ui-vector-transparent-logo",
			headerHeightPt: 10,
			coverPlacement: "none",
			documentTitlePlacement: "none",
			headerPlacement: "logo-and-text",
		});
		expect(rendered.diagnostics.firstPageDateLabel).toBe("May 4th");
		expect(rendered.content.toString("latin1")).not.toContain("favicon-32x32");
	});

	it("adds a compact generation date when document source omits one", async () => {
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Undated report",
			blocks: [
				{
					type: "paragraph",
					text: "The renderer should still stamp the generation date in the header.",
				},
			],
		});
		expect(validation.ok).toBe(true);
		if (!validation.ok) return;

		const rendered = await renderStandardReportPdf(validation.source, {
			now: new Date("2026-05-04T12:00:00.000Z"),
		});

		expect(rendered.diagnostics.firstPageDateLabel).toBe("May 4th");
	});

	it("uses a quieter paragraph treatment so body copy does not compete with report structure", async () => {
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Paragraph tone report",
			blocks: [
				{
					type: "paragraph",
					text: "Body copy should be readable without becoming the loudest visual element on the page.",
				},
			],
		});
		expect(validation.ok).toBe(true);
		if (!validation.ok) return;

		const rendered = await renderStandardReportPdf(validation.source);

		expect(rendered.diagnostics.bodyFontPt).toBe(10.5);
		expect(rendered.diagnostics.paragraphColor).toBe("#3E3933");
		expect(rendered.diagnostics.lineHeight).toBe(1.38);
	});

	it("supports dividers and optional cover pages without accepting raw drawing commands", async () => {
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Covered report",
			subtitle: "Safe source only",
			cover: { enabled: true, eyebrow: "Internal", dateLabel: "May 2026" },
			blocks: [
				{ type: "heading", level: 2, text: "Summary" },
				{ type: "paragraph", text: '<script>alert("not markup")</script>' },
				{ type: "divider" },
				{
					type: "quote",
					text: "All content is drawn as text.",
					citation: "Renderer contract",
				},
			],
		});

		expect(validation.ok).toBe(true);
		if (!validation.ok) return;

		const rendered = await renderStandardReportPdf(validation.source);
		const pdfDoc = await PDFDocument.load(new Uint8Array(rendered.content));
		expect(pdfDoc.getPageCount()).toBeGreaterThanOrEqual(2);
		expect(rendered.diagnostics.coverPage).toBe(true);
		expect(rendered.diagnostics.blockTypes).toEqual([
			"heading",
			"paragraph",
			"divider",
			"quote",
		]);
	});

	it("renders long table blocks with repeated headers and safe pagination", async () => {
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Long table report",
			blocks: [
				{
					type: "table",
					title: "Fulfillment details",
					caption: "Long Hungarian labels should wrap without clipping.",
					columns: [
						{ key: "date", label: "Date", kind: "date" },
						{ key: "region", label: "Region", kind: "text" },
						{ key: "orders", label: "Orders", kind: "number" },
						{ key: "change", label: "Change", kind: "percent" },
						{ key: "notes", label: "Notes", kind: "text" },
					],
					rows: Array.from({ length: 42 }, (_, index) => ({
						date: `2026-05-${String((index % 28) + 1).padStart(2, "0")}`,
						region: index % 2 === 0 ? "Central Europe" : "Magyar piac",
						orders: 1200 + index * 37,
						change: 0.05 + index / 1000,
						notes:
							"Long-cell wrapping check with hosszútávúfolyamatfolytonosság and dense operational text.",
					})),
				},
			],
		});
		expect(validation.ok).toBe(true);
		if (!validation.ok) return;

		const rendered = await renderStandardReportPdf(validation.source);
		const pdfDoc = await PDFDocument.load(new Uint8Array(rendered.content));

		expect(pdfDoc.getPageCount()).toBeGreaterThan(1);
		expect(rendered.diagnostics.tables).toEqual([
			expect.objectContaining({
				title: "Fulfillment details",
				columnCount: 5,
				rowCount: 42,
				clipped: false,
				repeatedHeaderCount: expect.any(Number),
			}),
		]);
		expect(rendered.diagnostics.tables[0].repeatedHeaderCount).toBeGreaterThan(
			0,
		);
	});

	it("rejects tables that are too wide for the v1 portrait template", async () => {
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Wide table report",
			blocks: [
				{
					type: "table",
					title: "Too many columns",
					columns: Array.from({ length: 9 }, (_, index) => ({
						key: `c${index}`,
						label: `Column ${index + 1}`,
						kind: "text",
					})),
					rows: [{ c0: "value" }],
				},
			],
		});
		expect(validation.ok).toBe(true);
		if (!validation.ok) return;

		await expect(
			renderStandardReportPdf(validation.source),
		).rejects.toMatchObject({
			code: "table_limit_exceeded",
		});
	});

	it("renders image figures with captions and records noncritical placeholders", async () => {
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Image figure report",
			blocks: [
				{
					type: "image",
					source: {
						kind: "data",
						mimeType: "image/png",
						data: `data:image/png;base64,${ONE_BY_ONE_PNG_BASE64}`,
					},
					altText: "One pixel diagram.",
					caption: "A compact test figure.",
					critical: true,
				},
				{
					type: "image",
					source: { kind: "generated_file", fileId: "missing-file" },
					altText: "Missing noncritical figure.",
					caption: "Renderer should show a placeholder.",
					critical: false,
				},
			],
		});
		expect(validation.ok).toBe(true);
		if (!validation.ok) return;

		const rendered = await renderStandardReportPdf(validation.source, {
			imageLoader: async (source) => {
				if (source.kind === "data") {
					return {
						ok: true,
						image: {
							bytes: Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"),
							mimeType: "image/png",
							sourceDescription: "data image",
						},
					};
				}
				return {
					ok: false,
					code: "image_limit_exceeded",
					message: "Generated image file could not be resolved.",
				};
			},
		});
		const pdfDoc = await PDFDocument.load(new Uint8Array(rendered.content));

		expect(pdfDoc.getPageCount()).toBeGreaterThanOrEqual(1);
		expect(rendered.diagnostics.images).toEqual([
			expect.objectContaining({
				caption: "A compact test figure.",
				placeholder: false,
			}),
			expect.objectContaining({
				caption: "Renderer should show a placeholder.",
				placeholder: true,
				warningCode: "image_limit_exceeded",
			}),
		]);
	});

	it("fails critical image blocks when image loading fails", async () => {
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Critical image report",
			blocks: [
				{
					type: "image",
					source: { kind: "generated_file", fileId: "missing-file" },
					altText: "Required image.",
					critical: true,
				},
			],
		});
		expect(validation.ok).toBe(true);
		if (!validation.ok) return;

		await expect(
			renderStandardReportPdf(validation.source, {
				imageLoader: async () => ({
					ok: false,
					code: "image_limit_exceeded",
					message: "Generated image file could not be resolved.",
				}),
			}),
		).rejects.toMatchObject({ code: "image_limit_exceeded" });
	});

	it("renders the first chart SVG path into PDF diagnostics", async () => {
		const source = readFixtureSource("chart-heavy-report.json");
		const rendered = await renderStandardReportPdf(source);
		const pdfDoc = await PDFDocument.load(new Uint8Array(rendered.content));

		expect(pdfDoc.getPageCount()).toBeGreaterThanOrEqual(1);
		expect(rendered.diagnostics.charts).toContainEqual(
			expect.objectContaining({
				title: "Weekly active users",
				chartType: "line",
				dataPointCount: 3,
				edgeInsetPt: expect.any(Number),
				clipped: false,
				svg: expect.stringContaining("<polyline"),
			}),
		);
	});

	it("keeps bar chart marks inside the plot area with a right-edge guard", async () => {
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Guarded chart report",
			blocks: [
				{
					type: "chart",
					chartType: "bar",
					title: "Edge-safe bars",
					caption: "Bars should remain inside the plot edge.",
					altText: "A bar chart with end labels.",
					units: "items",
					xKey: "label",
					yKey: "value",
					data: [
						{ label: "A", value: 10 },
						{ label: "B", value: 18 },
						{ label: "C", value: 13 },
						{ label: "D", value: 21 },
					],
				},
			],
		});
		expect(validation.ok).toBe(true);
		if (!validation.ok) return;

		const rendered = await renderStandardReportPdf(validation.source);

		expect(rendered.diagnostics.charts).toEqual([
			expect.objectContaining({
				title: "Edge-safe bars",
				chartType: "bar",
				edgeInsetPt: expect.any(Number),
				clipped: false,
			}),
		]);
		expect(rendered.diagnostics.charts[0].edgeInsetPt).toBeGreaterThan(8);
	});

	it("wraps chart captions and records visible axis and category labels", async () => {
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Chart label report",
			blocks: [
				{
					type: "chart",
					chartType: "bar",
					title: "Conversation category depth",
					caption:
						"This chart illustrates the relative depth of information shared across the main conversation categories, measured by distinct facts and specific recurring signals.",
					altText: "A bar chart showing category depth.",
					units: "distinct facts",
					xKey: "category",
					yKey: "facts",
					data: [
						{ category: "Work preferences", facts: 12 },
						{ category: "Personal context", facts: 7 },
						{ category: "Project goals", facts: 10 },
					],
				},
			],
		});
		expect(validation.ok).toBe(true);
		if (!validation.ok) return;

		const rendered = await renderStandardReportPdf(validation.source);

		expect(rendered.diagnostics.charts[0]).toMatchObject({
			title: "Conversation category depth",
			captionLineCount: expect.any(Number),
			axisLabels: {
				x: "Category",
				y: "Distinct facts",
			},
			categoryLabels: ["Work preferences", "Personal context", "Project goals"],
			clipped: false,
		});
		expect(rendered.diagnostics.charts[0].captionLineCount).toBeGreaterThan(1);
	});

	it("renders every v1 chart type into PDF diagnostics", async () => {
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "All charts report",
			blocks: [
				{
					type: "chart",
					chartType: "bar",
					title: "Bar chart",
					caption: "Caption",
					altText: "Bar alt.",
					units: "items",
					xKey: "label",
					yKey: "value",
					data: [{ label: "A", value: 10 }],
				},
				{
					type: "chart",
					chartType: "stackedBar",
					title: "Stacked bar chart",
					caption: "Caption",
					altText: "Stacked alt.",
					units: "items",
					xKey: "label",
					yKey: "value",
					seriesKey: "series",
					data: [
						{ label: "A", series: "North", value: 10 },
						{ label: "A", series: "South", value: 6 },
					],
				},
				{
					type: "chart",
					chartType: "scatter",
					title: "Scatter chart",
					caption: "Caption",
					altText: "Scatter alt.",
					units: "items",
					xKey: "x",
					yKey: "y",
					data: [{ x: 1, y: 10 }],
				},
				{
					type: "chart",
					chartType: "pie",
					title: "Pie chart",
					caption: "Caption",
					altText: "Pie alt.",
					units: "share",
					labelKey: "label",
					valueKey: "value",
					data: [{ label: "A", value: 10 }],
				},
				{
					type: "chart",
					chartType: "donut",
					title: "Donut chart",
					caption: "Caption",
					altText: "Donut alt.",
					units: "share",
					labelKey: "label",
					valueKey: "value",
					data: [{ label: "A", value: 10 }],
				},
			],
		});
		expect(validation.ok).toBe(true);
		if (!validation.ok) return;

		const rendered = await renderStandardReportPdf(validation.source);

		expect(rendered.diagnostics.charts.map((chart) => chart.chartType)).toEqual(
			["bar", "stackedBar", "scatter", "pie", "donut"],
		);
	});
});
