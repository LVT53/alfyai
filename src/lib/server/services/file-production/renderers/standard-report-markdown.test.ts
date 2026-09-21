import { describe, expect, it } from "vitest";
import { validateGeneratedDocumentSource } from "../source-schema";
import { renderStandardReportMarkdown } from "./standard-report-markdown";

describe("AlfyAI Standard Report Markdown renderer", () => {
	it("renders basis markers as inline parenthetical text", () => {
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Markdown basis report",
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

		const markdown = renderStandardReportMarkdown(
			validation.source,
		).content.toString("utf8");

		expect(markdown).toContain(
			"Revenue increased by 12%. *(Basis: Supported — Accepted source " +
				"states revenue increased by 12%.)*",
		);
		expect(markdown).toContain(
			"*(Basis: Unsupported — No accepted source supports the fallback " +
				"claim.)*",
		);
		expect(markdown).not.toContain("confidence");
	});

	it("renders image blocks with the source URL and keeps caption as caption text", () => {
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Markdown image report",
			blocks: [
				{
					type: "image",
					source: { kind: "https", url: "https://example.com/image.png" },
					altText: "Markdown image fallback",
					caption: "Image caption",
					sourceAttribution: {
						title: "Example image source",
						url: "https://example.com/image-source",
					},
				},
			],
		});
		expect(validation.ok).toBe(true);
		if (!validation.ok) return;

		const markdown = renderStandardReportMarkdown(
			validation.source,
		).content.toString("utf8");

		expect(markdown).toContain(
			"![Markdown image fallback](https://example.com/image.png)",
		);
		expect(markdown).toContain("Image caption");
		expect(markdown).toContain(
			"Source: [Example image source](https://example.com/image-source)",
		);
		expect(markdown).not.toContain("![Markdown image fallback](Image caption)");
	});

	it("keeps citation annotations plain with level glyphs and a legend line", () => {
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Markdown annotated report",
			blocks: [
				{
					type: "paragraph",
					text: "Ireland passed 8 GW[[cite:4:c]], wind is just over 5 GW[[cite:7:s]], storage lags[[cite:i]].",
				},
				{
					type: "sourceChips",
					title: "Sources",
					sources: [{ title: "Gov source", url: "https://gov.ie/renewables" }],
				},
				{ type: "paragraph", text: "Closing note." },
			],
		});
		expect(validation.ok).toBe(true);
		if (!validation.ok) return;

		const markdown = renderStandardReportMarkdown(
			validation.source,
		).content.toString("utf8");

		expect(markdown).not.toContain("[[cite");
		expect(markdown).toContain(
			"Ireland passed 8 GW[4]ᶜ, wind is just over 5 GW[7]ˢ, storage lagsⁱ.",
		);
		expect(markdown).toContain(
			"ᶜ corroborated by independent sources · ˢ single source · ⁱ inferred, no direct source",
		);
		// The legend follows the source list rather than trailing the document.
		expect(markdown.indexOf("ᶜ corroborated")).toBeGreaterThan(
			markdown.indexOf("[Gov source]"),
		);
		expect(markdown.indexOf("ᶜ corroborated")).toBeLessThan(
			markdown.indexOf("Closing note."),
		);
	});

	it("omits the legend when no paragraph carries an annotation", () => {
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Markdown plain report",
			blocks: [{ type: "paragraph", text: "Ireland passed 8 GW [4]." }],
		});
		expect(validation.ok).toBe(true);
		if (!validation.ok) return;

		const markdown = renderStandardReportMarkdown(
			validation.source,
		).content.toString("utf8");

		expect(markdown).toContain("Ireland passed 8 GW [4].");
		expect(markdown).not.toContain("corroborated by independent sources");
	});

	it("renders a table's caption under its title", () => {
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Markdown table report",
			blocks: [
				{
					type: "table",
					title: "Regional revenue",
					caption: "Figures in thousands, unaudited.",
					columns: [
						{ key: "region", label: "Region", kind: "text" },
						{ key: "revenue", label: "Revenue", kind: "currency" },
					],
					rows: [{ region: "EMEA", revenue: 420 }],
				},
			],
		});
		expect(validation.ok).toBe(true);
		if (!validation.ok) return;

		const markdown = renderStandardReportMarkdown(
			validation.source,
		).content.toString("utf8");

		expect(markdown).toContain(
			[
				"### Regional revenue",
				"*Figures in thousands, unaudited.*",
				"| Region | Revenue |",
			].join("\n"),
		);
	});

	it("names the chart type and data-point count", () => {
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Markdown chart report",
			blocks: [
				{
					type: "chart",
					chartType: "stackedBar",
					title: "Weekly active users",
					caption: "Users by cohort.",
					altText: "Weekly active users, three cohorts.",
					units: "users",
					xKey: "week",
					yKey: "value",
					seriesKey: "cohort",
					data: [
						{ week: "2026-W01", cohort: "new", value: 120 },
						{ week: "2026-W01", cohort: "returning", value: 340 },
						{ week: "2026-W02", cohort: "new", value: 150 },
					],
				},
			],
		});
		expect(validation.ok).toBe(true);
		if (!validation.ok) return;

		const markdown = renderStandardReportMarkdown(
			validation.source,
		).content.toString("utf8");

		expect(markdown).toContain(
			"### Weekly active users\n\n" +
				"Weekly active users, three cohorts.\n\n" +
				"*(stacked bar chart, 3 data points)*",
		);
	});

	it("renders exactly one data point without pluralizing", () => {
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Markdown single-point chart report",
			blocks: [
				{
					type: "chart",
					chartType: "bar",
					title: "Single bar",
					caption: "One value.",
					altText: "A single value.",
					units: "items",
					xKey: "label",
					yKey: "value",
					data: [{ label: "Total", value: 1 }],
				},
			],
		});
		expect(validation.ok).toBe(true);
		if (!validation.ok) return;

		const markdown = renderStandardReportMarkdown(
			validation.source,
		).content.toString("utf8");

		expect(markdown).toContain("*(bar chart, 1 data point)*");
	});

	it("renders the cover eyebrow above the title", () => {
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Markdown cover report",
			cover: { enabled: true, eyebrow: "AlfyAI Standard Report" },
			blocks: [{ type: "paragraph", text: "Body text." }],
		});
		expect(validation.ok).toBe(true);
		if (!validation.ok) return;

		const markdown = renderStandardReportMarkdown(
			validation.source,
		).content.toString("utf8");

		expect(
			markdown.startsWith(
				"*AlfyAI Standard Report*\n\n# Markdown cover report",
			),
		).toBe(true);
	});

	it("omits the eyebrow line when no cover is requested", () => {
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Markdown no-cover report",
			blocks: [{ type: "paragraph", text: "Body text." }],
		});
		expect(validation.ok).toBe(true);
		if (!validation.ok) return;

		const markdown = renderStandardReportMarkdown(
			validation.source,
		).content.toString("utf8");

		expect(markdown.startsWith("# Markdown no-cover report")).toBe(true);
	});
});
