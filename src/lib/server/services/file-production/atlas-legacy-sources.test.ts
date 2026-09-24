import { describe, expect, it } from "vitest";
import { renderStandardReportHtml } from "./renderers/standard-report-html";
import { renderStandardReportMarkdown } from "./renderers/standard-report-markdown";
import { renderStandardReportPdf } from "./renderers/standard-report-pdf";
import { renderGeneratedDocumentSourceText } from "./source-persistence";
import { validateGeneratedDocumentSource } from "./source-schema";
import {
	STORED_V1_SOURCE,
	STORED_V2_SOURCE,
} from "./testing/atlas-legacy-document-sources";

describe("stored Atlas v1/v2 document sources after the v3-only consolidation", () => {
	it("validates a stored v1 source and keeps its paragraph basis markers", () => {
		const validation = validateGeneratedDocumentSource(
			structuredClone(STORED_V1_SOURCE),
		);
		expect(validation.ok).toBe(true);
		if (!validation.ok) return;
		const paragraphs = validation.source.blocks.filter(
			(block) => block.type === "paragraph",
		);
		expect(
			paragraphs.flatMap((paragraph) =>
				(paragraph.basisMarkers ?? []).map((marker) => marker.id),
			),
		).toEqual(["basis-unanchored", "basis-partial"]);
		expect(
			validation.source.blocks.filter((block) => block.type === "sourceChips"),
		).toHaveLength(2);
	});

	it("renders a stored v1 source to HTML, Markdown and PDF", async () => {
		const validation = validateGeneratedDocumentSource(
			structuredClone(STORED_V1_SOURCE),
		);
		if (!validation.ok) throw new Error("stored v1 source no longer validates");

		const html = renderStandardReportHtml(validation.source).content.toString(
			"utf8",
		);
		expect(html).toContain("Enterprise Search Atlas");
		expect(html).toContain("Hybrid retrieval improves recall");
		expect(html).toContain("Uploaded strategy memo");
		expect(html).not.toContain("[[cite:");

		const markdown = renderStandardReportMarkdown(
			validation.source,
		).content.toString("utf8");
		expect(markdown).toContain("The market has unresolved adoption signals.");
		expect(markdown).toContain("Basis: Unsupported");
		expect(markdown).not.toContain("[[cite:");

		const pdf = await renderStandardReportPdf(validation.source);
		expect(pdf.content.subarray(0, 5).toString("ascii")).toBe("%PDF-");
	});

	it("re-renders a stored v1 source as text for read_generated_file", () => {
		const text = renderGeneratedDocumentSourceText(
			structuredClone(STORED_V1_SOURCE),
		);
		expect(text).not.toBeNull();
		expect(text).toContain("Hybrid retrieval improves recall");
		expect(text).toContain("Uploaded strategy memo");
	});

	it("validates, renders and re-renders a stored v2 source", async () => {
		const validation = validateGeneratedDocumentSource(
			structuredClone(STORED_V2_SOURCE),
		);
		expect(validation.ok).toBe(true);
		if (!validation.ok) return;

		const html = renderStandardReportHtml(validation.source).content.toString(
			"utf8",
		);
		expect(html).toContain("Capacity reached 8 GW.");
		expect(html).not.toContain("[[cite:");

		const markdown = renderStandardReportMarkdown(
			validation.source,
		).content.toString("utf8");
		expect(markdown).toContain("Capacity reached 8 GW.");
		expect(markdown).not.toContain("[[cite:");

		const pdf = await renderStandardReportPdf(validation.source);
		expect(pdf.content.subarray(0, 5).toString("ascii")).toBe("%PDF-");

		const text = renderGeneratedDocumentSourceText(
			structuredClone(STORED_V2_SOURCE),
		);
		expect(text).toContain("Grid limits are the likely cause.");
	});
});
