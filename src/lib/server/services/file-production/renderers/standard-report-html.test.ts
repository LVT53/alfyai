import { describe, expect, it } from "vitest";
import { validateGeneratedDocumentSource } from "../source-schema";
import { renderStandardReportHtml } from "./standard-report-html";

describe("AlfyAI Standard Report HTML renderer", () => {
	it("renders source-owned HTML and escapes model text", () => {
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "HTML report",
			blocks: [
				{ type: "heading", level: 2, text: "Summary" },
				{ type: "paragraph", text: '<script>alert("not markup")</script>' },
				{
					type: "list",
					style: "numbered",
					items: ["Escaped text remains visible"],
				},
				{
					type: "callout",
					tone: "tip",
					title: "Download check",
					text: "HTML callout remains readable.",
				},
				{
					type: "code",
					language: "html",
					text: "<section>safe text</section>",
				},
				{ type: "quote", text: "HTML quote text", citation: "QA" },
				{
					type: "table",
					title: "HTML table",
					columns: [{ key: "format", label: "Format", kind: "text" }],
					rows: [{ format: "Downloaded HTML" }],
				},
				{
					type: "chart",
					chartType: "line",
					title: "Weekly active users",
					caption: "Caption",
					altText: "Accessible chart summary.",
					units: "users",
					xKey: "week",
					yKey: "users",
					data: [{ week: "2026-W01", users: 1200 }],
				},
				{
					type: "image",
					source: { kind: "https", url: "https://example.com/image.png" },
					altText: "HTML image fallback",
					caption: "Image caption",
					sourceAttribution: {
						title: "Example image source",
						url: "https://example.com/image-source",
					},
				},
				{
					type: "sourceChips",
					title: "Web Sources",
					sources: [
						{
							title: "Vendor docs",
							url: "https://example.com/docs",
							reasoning: "Compact reasoning belongs in the tooltip.",
						},
					],
				},
			],
		});
		expect(validation.ok).toBe(true);
		if (!validation.ok) return;

		const rendered = renderStandardReportHtml(validation.source);

		expect(rendered.filename).toBe("html-report.html");
		expect(rendered.mimeType).toBe("text/html");
		expect(rendered.content.toString("utf8")).toContain("<!doctype html>");
		expect(rendered.content.toString("utf8")).toContain(
			"&lt;script&gt;alert(&quot;not markup&quot;)&lt;/script&gt;",
		);
		expect(rendered.content.toString("utf8")).not.toContain("<script>alert");
		expect(rendered.content.toString("utf8")).toContain(
			"Escaped text remains visible",
		);
		expect(rendered.content.toString("utf8")).toContain(
			"HTML callout remains readable.",
		);
		expect(rendered.content.toString("utf8")).toContain(
			"&lt;section&gt;safe text&lt;/section&gt;",
		);
		expect(rendered.content.toString("utf8")).toContain("HTML quote text");
		expect(rendered.content.toString("utf8")).toContain("Downloaded HTML");
		expect(rendered.content.toString("utf8")).toContain(
			'data-chart-type="line"',
		);
		expect(rendered.content.toString("utf8")).toContain("HTML image fallback");
		expect(rendered.content.toString("utf8")).toContain("Example image source");
		expect(rendered.content.toString("utf8")).toContain(
			'<nav class="report-sidebar"',
		);
		expect(rendered.content.toString("utf8")).toContain(
			'<article class="report-content"',
		);
		expect(rendered.content.toString("utf8")).toContain("Libre Baskerville");
		expect(rendered.content.toString("utf8")).toContain("Nimbus Sans L");
		expect(rendered.content.toString("utf8")).toContain("report-section");
		expect(rendered.content.toString("utf8")).toContain("report-nav");
		expect(rendered.content.toString("utf8")).toContain(
			'data-source-chip-list="Web Sources"',
		);
		expect(rendered.content.toString("utf8")).toContain(
			"Compact reasoning belongs in the tooltip.",
		);
		expect(rendered.content.toString("utf8")).toContain(
			"@media (prefers-color-scheme: dark)",
		);
		expect(rendered.content.toString("utf8")).toContain(
			"--report-text:#1B1815",
		);
		expect(rendered.content.toString("utf8")).toContain('fill="#1B1815"');
	});
});
