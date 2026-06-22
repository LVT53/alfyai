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
			"Revenue increased by 12%. (Basis: Supported — Accepted source states revenue increased by 12%.)",
		);
		expect(markdown).toContain(
			"(Basis: Unsupported — No accepted source supports the fallback claim.)",
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
});
