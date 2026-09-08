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
			"Revenue increased by 12%. *(Basis: Supported)*",
		);
		expect(markdown).toContain("*(Basis: Unsupported)*");
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
});
