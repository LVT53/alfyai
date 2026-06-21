import { expect, test } from "@playwright/test";
import { renderStandardReportHtml } from "../../src/lib/server/services/file-production/renderers/standard-report-html";
import { validateGeneratedDocumentSource } from "../../src/lib/server/services/file-production/source-schema";

const GENERATED_TITLE = "Generated Enterprise RAG Strategy";

function renderAtlasReportPreviewHtml(): string {
	const validation = validateGeneratedDocumentSource({
		version: 1,
		template: "alfyai_standard_report",
		title: GENERATED_TITLE,
		blocks: [
			{ type: "heading", level: 2, text: GENERATED_TITLE },
			{ type: "heading", level: 2, text: "Executive Summary" },
			{
				type: "paragraph",
				text: "Revenue increased by 12% while adoption evidence remains directional [1].",
				sources: [
					{
						title: "Vendor docs",
						url: "https://example.com/vendor-docs",
						reasoning: "Accepted evidence for the current adoption claim.",
					},
				],
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
			{ type: "heading", level: 2, text: "Limitations" },
			{
				type: "paragraph",
				text: "Adoption evidence is directional because only one accepted source discusses it.",
			},
			{ type: "heading", level: 2, text: "Sources" },
			{
				type: "sourceChips",
				title: "Web Sources",
				sources: [
					{
						title: "Vendor docs",
						url: "https://example.com/vendor-docs",
						reasoning: "Accepted evidence for the current adoption claim.",
					},
					{
						title: "Benchmark report",
						url: "https://example.com/benchmark",
						reasoning: "Accepted evidence for market comparison context.",
					},
				],
			},
		],
	});
	if (!validation.ok) {
		throw new Error(validation.message);
	}
	return renderStandardReportHtml(validation.source).content.toString("utf8");
}

test.describe("Atlas report preview contract", () => {
	test("renders generated title, deterministic sources, and accessible Basis Markers", async ({
		page,
	}) => {
		await page.setContent(renderAtlasReportPreviewHtml(), {
			waitUntil: "domcontentloaded",
		});

		await expect(
			page.getByRole("heading", { level: 1, name: GENERATED_TITLE }),
		).toBeVisible();
		await expect(
			page.getByRole("heading", { name: GENERATED_TITLE }),
		).toHaveCount(1);
		await expect(
			page.getByRole("heading", { name: "Executive Summary" }),
		).toBeVisible();

		await expect(page.getByRole("heading", { name: "Sources" })).toHaveCount(1);
		const sources = page.getByRole("list").filter({ hasText: "Vendor docs" });
		await expect(sources).toContainText("Benchmark report");
		await expect(
			sources.getByRole("link", { name: "Vendor docs", exact: true }),
		).toHaveAttribute("href", "https://example.com/vendor-docs");

		const visibleReportText = await page.locator("body").innerText();
		expect(visibleReportText).not.toMatch(/Honesty Markers/i);
		expect(visibleReportText).not.toMatch(/confidence marker/i);
		expect(visibleReportText).not.toMatch(
			/deep research|research loop|agent loop/i,
		);

		const marker = page.getByRole("button", {
			name: "Supported claim: Accepted source states revenue increased by 12%.",
		});
		const tooltip = marker.getByRole("tooltip");

		await marker.hover();
		await expect(tooltip).toBeVisible();
		await expect(tooltip).toContainText("Supported claim");
		await expect(tooltip).toContainText(
			"Accepted source states revenue increased by 12%.",
		);

		await marker.focus();
		await expect(tooltip).toBeVisible();

		await marker.click();
		await expect(tooltip).toBeVisible();
	});
});
