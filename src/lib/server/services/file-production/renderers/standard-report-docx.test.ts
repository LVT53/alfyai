import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { validateGeneratedDocumentSource } from "../source-schema";
import { renderStandardReportDocx } from "./standard-report-docx";

describe("AlfyAI Standard Report DOCX renderer", () => {
	it("renders the same source model into a valid DOCX package", async () => {
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "DOCX report",
			blocks: [
				{ type: "heading", level: 2, text: "Summary" },
				{ type: "paragraph", text: "Revenue increased by 12%." },
				{ type: "list", style: "bullet", items: ["Portable document text"] },
				{
					type: "callout",
					tone: "info",
					title: "Download check",
					text: "DOCX callout remains readable.",
				},
				{ type: "code", language: "json", text: '{"status":"ok"}' },
				{ type: "quote", text: "DOCX quote text", citation: "QA" },
				{
					type: "table",
					title: "Small table",
					columns: [{ key: "region", label: "Region", kind: "text" }],
					rows: [{ region: "Central Europe" }],
				},
				{
					type: "chart",
					chartType: "bar",
					title: "DOCX chart fallback",
					caption: "Chart caption",
					altText: "Chart fallback text.",
					units: "checks",
					xKey: "label",
					yKey: "value",
					data: [{ label: "A", value: 1 }],
				},
				{
					type: "image",
					source: { kind: "https", url: "https://example.com/image.png" },
					altText: "DOCX image fallback",
					caption: "Image caption",
				},
				{
					type: "paragraph",
					text: "Revenue increased by 12%.",
					basisMarkers: [
						{
							type: "basisMarker",
							id: "basis-partial",
							support: "partial",
							anchorText: "Revenue increased by 12%",
							rationale: "Evidence is directional but incomplete.",
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

		const rendered = await renderStandardReportDocx(validation.source);
		const zip = await JSZip.loadAsync(rendered.content);
		const documentXml = await zip.file("word/document.xml")?.async("string");

		expect(rendered.filename).toBe("docx-report.docx");
		expect(rendered.mimeType).toBe(
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		);
		expect(rendered.content.subarray(0, 2).toString("ascii")).toBe("PK");
		expect(documentXml).toContain("DOCX report");
		expect(documentXml).toContain("Revenue increased by 12%.");
		expect(documentXml).toContain("Portable document text");
		expect(documentXml).toContain("DOCX callout remains readable.");
		expect(documentXml).toContain("{&quot;status&quot;:&quot;ok&quot;}");
		expect(documentXml).toContain("DOCX quote text");
		expect(documentXml).toContain("Central Europe");
		expect(documentXml).toContain("DOCX chart fallback");
		expect(documentXml).toContain("Chart fallback text.");
		expect(documentXml).toContain("DOCX image fallback");
		expect(documentXml).toContain("Basis: Partially supported claim - ");
		expect(documentXml).toContain("Evidence is directional but incomplete.");
		expect(documentXml).toContain("Basis: Unsupported claim - ");
		expect(documentXml).toContain(
			"No accepted source supports the fallback claim.",
		);
	});
});
