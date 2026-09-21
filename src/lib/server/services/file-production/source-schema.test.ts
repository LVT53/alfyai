import { describe, expect, it } from "vitest";
import { renderStandardReportMarkdown } from "./renderers/standard-report-markdown";
import type { GeneratedDocumentSource } from "./source-schema";
import {
	generatedDocumentCitationPlainText,
	generatedDocumentCitationToken,
	parseGeneratedDocumentInlineText,
	validateGeneratedDocumentSource,
} from "./source-schema";

/**
 * The text a validated source turns into.
 *
 * `buildGeneratedDocumentProjection` used to answer this — a third renderer of
 * the same object, whose output nobody could download. Phase 6 D9 deleted it,
 * so the readable form of a source is the Markdown renderer's, and these cases
 * check the same block semantics through the renderer that now ships them.
 */
function markdownOf(source: GeneratedDocumentSource): string {
	return renderStandardReportMarkdown(source).content.toString("utf8");
}

describe("generated document source schema", () => {
	it("accepts semantic v1 blocks and renders deterministic markdown", () => {
		const result = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Quarterly report",
			subtitle: "Executive summary",
			date: "Generated on May 4, 2026",
			blocks: [
				{ type: "heading", level: 2, text: "Revenue" },
				{ type: "paragraph", text: "Revenue increased by 12%." },
				{
					type: "list",
					style: "bullet",
					items: ["EMEA grew fastest", "Churn improved"],
				},
				{
					type: "callout",
					tone: "note",
					title: "Readout",
					text: "Numbers are preliminary.",
				},
				{
					type: "confidenceMarker",
					code: "atlas_audit_marker",
					label: "Partially Supported",
					severity: "warning",
					message: "Revenue claim needs one more source.",
				},
			],
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.source).toMatchObject({
			version: 1,
			template: "alfyai_standard_report",
			title: "Quarterly report",
		});
		expect(markdownOf(result.source)).toBe(
			[
				"# Quarterly report",
				"",
				"Executive summary",
				"",
				"Generated on May 4, 2026",
				"",
				"## Revenue",
				"",
				"Revenue increased by 12%.",
				"",
				"- EMEA grew fastest",
				"- Churn improved",
				"",
				"> **Readout.** Numbers are preliminary.",
				"",
				"> **Partially Supported.** Revenue claim needs one more source.",
				"",
			].join("\n"),
		);
	});

	it("defaults omitted heading levels to section headings for model-friendly input", () => {
		const result = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Model report",
			blocks: [{ type: "heading", text: "Executive Summary" }],
		});

		expect(result).toMatchObject({ ok: true });
		if (!result.ok) return;

		expect(result.source.blocks[0]).toEqual({
			type: "heading",
			level: 2,
			text: "Executive Summary",
		});
	});

	it("accepts paragraph-level source chips for inline report citations", () => {
		const result = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Sourced report",
			blocks: [
				{
					type: "paragraph",
					text: "Surface code maturity is backed by accepted source evidence.",
					sources: [
						{
							title: "Vendor docs",
							url: "https://example.com/docs",
							reasoning: "Primary source for current platform claims.",
						},
						{
							title: "Uploaded strategy memo",
							provided: true,
							reasoning: "User-provided local evidence.",
						},
					],
				},
			],
		});

		expect(result).toMatchObject({ ok: true });
		if (!result.ok) return;

		expect(result.source.blocks[0]).toMatchObject({
			type: "paragraph",
			text: "Surface code maturity is backed by accepted source evidence.",
			sources: [
				{
					title: "Vendor docs",
					url: "https://example.com/docs",
					kind: "web",
					reasoning: "Primary source for current platform claims.",
				},
				{
					title: "Uploaded strategy memo",
					url: null,
					kind: "library",
					provided: true,
					reasoning: "User-provided local evidence.",
				},
			],
		});
		// Recorded, not endorsed: the Markdown renderer carries the paragraph but
		// not its attached sources, while the HTML, PDF and DOCX renderers all
		// do. The deleted projection listed them, so D9 makes this Markdown gap
		// visible to the model as well — it is a renderer bug to fix in
		// `standard-report-markdown.ts`, which also improves the downloadable
		// `.md`, and pinning it here is what makes that fix show up as a change.
		const markdown = markdownOf(result.source);
		expect(markdown).toContain(
			"Surface code maturity is backed by accepted source evidence.",
		);
		expect(markdown).not.toContain("Vendor docs");
	});

	it("accepts paragraph-level basis markers and marks them in the markdown", () => {
		const result = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Basis marker report",
			blocks: [
				{
					type: "paragraph",
					text: "Revenue increased by 12% while churn evidence remains thin.",
					basisMarkers: [
						{
							type: "basisMarker",
							id: "basis-supported",
							support: "supported",
							anchorText: "Revenue increased by 12%",
							occurrence: 0,
							rationale:
								"Accepted source states revenue increased by 12%.\nThis should compact.",
							auditCode: "atlas_revenue_supported",
						},
					],
				},
			],
		});

		expect(result).toMatchObject({ ok: true });
		if (!result.ok) return;

		expect(result.source.blocks[0]).toMatchObject({
			type: "paragraph",
			basisMarkers: [
				{
					type: "basisMarker",
					id: "basis-supported",
					support: "supported",
					anchorText: "Revenue increased by 12%",
					occurrence: 0,
					rationale:
						"Accepted source states revenue increased by 12%. This should compact.",
					auditCode: "atlas_revenue_supported",
				},
			],
		});
		// The rationale itself lives in the source object and is drawn by the
		// HTML and PDF renderers; Markdown carries the short label only, so the
		// claim is still marked as supported wherever the text is read.
		expect(markdownOf(result.source)).toContain(
			"Revenue increased by 12% while churn evidence remains thin. *(Basis: Supported)*",
		);
	});

	it("accepts standalone basis marker fallback blocks", () => {
		const result = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Standalone basis report",
			blocks: [
				{
					type: "basisMarker",
					id: "basis-partial",
					support: "partial",
					rationale: "Evidence is directional but not independently confirmed.",
				},
			],
		});

		expect(result).toMatchObject({ ok: true });
		if (!result.ok) return;

		expect(result.source.blocks[0]).toEqual({
			type: "basisMarker",
			id: "basis-partial",
			support: "partial",
			rationale: "Evidence is directional but not independently confirmed.",
		});
	});

	it("rejects basis markers with invalid support states", () => {
		const result = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Invalid basis report",
			blocks: [
				{
					type: "basisMarker",
					id: "basis-invalid",
					support: "verified",
					rationale: "Legacy confidence wording must not be accepted.",
				},
			],
		});

		expect(result).toMatchObject({
			ok: false,
			code: "unsupported_document_block",
		});
	});

	it("rejects basis markers with empty rationales", () => {
		const result = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Empty basis report",
			blocks: [
				{
					type: "paragraph",
					text: "A claim that needs a basis marker.",
					basisMarkers: [
						{
							type: "basisMarker",
							id: "basis-empty",
							support: "unsupported",
							anchorText: "A claim",
							rationale: "   ",
						},
					],
				},
			],
		});

		expect(result).toMatchObject({
			ok: false,
			code: "unsupported_document_block",
		});
	});

	it("rejects raw HTML blocks instead of preserving arbitrary markup", () => {
		const result = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Unsafe report",
			blocks: [{ type: "rawHtml", html: "<script>alert(1)</script>" }],
		});

		expect(result).toMatchObject({
			ok: false,
			code: "unsupported_document_block",
		});
	});

	it("requires chart title, caption, units, and alt text for accessible chart blocks", () => {
		const result = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Incomplete chart report",
			blocks: [
				{
					type: "chart",
					chartType: "line",
					xKey: "week",
					yKey: "users",
					data: [{ week: "2026-W01", users: 1200 }],
				},
			],
		});

		expect(result).toMatchObject({
			ok: false,
			code: "unsupported_chart_data",
		});
	});

	it("rejects otherwise-valid chart blocks with empty data arrays", () => {
		const result = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Empty chart report",
			blocks: [
				{
					type: "chart",
					chartType: "bar",
					title: "Empty dataset chart",
					caption: "Caption",
					altText: "Accessible summary.",
					units: "items",
					xKey: "label",
					yKey: "value",
					data: [],
				},
			],
		});

		expect(result).toMatchObject({
			ok: false,
			code: "unsupported_chart_data",
		});
	});

	it("accepts model-friendly table headers with array rows", () => {
		const result = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Our Chats - Conversation Retrospective",
			blocks: [
				{
					type: "table",
					title: "Key Conversation Topics",
					headers: ["#", "Topic", "Approximate Date", "Summary", "Type"],
					rows: [
						[
							"1",
							"Dog Food Research",
							"May 2, 2026",
							"Researched suitable food options for Professor.",
							"Task",
						],
						[
							"2",
							"Personal Profile Inquiry",
							"April 25, 2026",
							"Reviewed stored profile and memory.",
							"Meta",
						],
					],
				},
			],
		});

		expect(result).toMatchObject({ ok: true });
		if (!result.ok) return;

		const table = result.source.blocks[0];
		expect(table).toMatchObject({
			type: "table",
			columns: [
				{ key: "col_1", label: "#", kind: "text" },
				{ key: "topic", label: "Topic", kind: "text" },
				{ key: "approximate_date", label: "Approximate Date", kind: "text" },
				{ key: "summary", label: "Summary", kind: "text" },
				{ key: "type", label: "Type", kind: "text" },
			],
			rows: [
				{
					col_1: "1",
					topic: "Dog Food Research",
					approximate_date: "May 2, 2026",
					summary: "Researched suitable food options for Professor.",
					type: "Task",
				},
				{
					col_1: "2",
					topic: "Personal Profile Inquiry",
					approximate_date: "April 25, 2026",
					summary: "Reviewed stored profile and memory.",
					type: "Meta",
				},
			],
		});
	});

	it("accepts common model table aliases without exposing alternate internal schemas", () => {
		const tableVariants = [
			{
				type: "table",
				columns: ["Topic", "Score"],
				rows: [["Dog Food Research", 8]],
			},
			{
				type: "table",
				header: ["Topic", "Score"],
				rows: [{ Topic: "Profile Inquiry", Score: 6 }],
			},
			{
				type: "table",
				data: {
					headers: ["Topic", "Score"],
					rows: [["Education & Career", 7]],
				},
			},
			{
				type: "table",
				data: [
					["Topic", "Score"],
					["Family & Home", 7],
				],
			},
		];

		for (const tableBlock of tableVariants) {
			const result = validateGeneratedDocumentSource({
				version: 1,
				template: "alfyai_standard_report",
				title: "Table Alias Report",
				blocks: [tableBlock],
			});

			expect(result).toMatchObject({ ok: true });
			if (!result.ok) continue;
			expect(result.source.blocks[0]).toMatchObject({
				type: "table",
				columns: [
					{ key: "topic", label: "Topic", kind: "text" },
					{ key: "score", label: "Score", kind: "text" },
				],
			});
		}
	});

	it("matches object rows by explicit table column aliases", () => {
		const result = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Alias table report",
			blocks: [
				{
					type: "table",
					columns: [{ label: "Topic", key: "topic_name" }, { label: "Score" }],
					rows: [{ topic_name: "Profile Inquiry", Score: 6 }],
				},
			],
		});

		expect(result).toMatchObject({ ok: true });
		if (!result.ok) return;

		expect(result.source.blocks[0]).toMatchObject({
			type: "table",
			columns: [
				{ key: "topic_name", label: "Topic", kind: "text" },
				{ key: "score", label: "Score", kind: "text" },
			],
			rows: [{ topic_name: "Profile Inquiry", score: 6 }],
		});
	});

	it("accepts explicit object row aliases with null values", () => {
		const result = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Null alias table report",
			blocks: [
				{
					type: "table",
					columns: [{ label: "Score", key: "score" }],
					rows: [{ score: null }],
				},
			],
		});

		expect(result).toMatchObject({ ok: true });
		if (!result.ok) return;

		expect(result.source.blocks[0]).toMatchObject({
			type: "table",
			columns: [{ key: "score", label: "Score", kind: "text" }],
			rows: [{ score: null }],
		});
	});

	it("accepts Chart.js-style bar chart data and normalizes it for renderers", () => {
		const result = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Our Chats - Conversation Retrospective",
			blocks: [
				{
					type: "chart",
					chartType: "bar",
					title: "Conversation Depth by Topic",
					caption:
						"Estimated depth and detail of conversation per topic on a 1-10 scale.",
					altText:
						"Bar chart showing conversation depth across five chat topics: Dog Food Research 8, Profile Inquiry 6, Education and Career 7, Family and Home 7, Community Involvement 5.",
					data: {
						labels: [
							"Dog Food\nResearch",
							"Profile\nInquiry",
							"Education &\nCareer",
							"Family &\nHome",
							"Community\nInvolvement",
						],
						datasets: [{ label: "Detail Level (1-10)", data: [8, 6, 7, 7, 5] }],
					},
				},
			],
		});

		expect(result).toMatchObject({ ok: true });
		if (!result.ok) return;

		expect(result.source.blocks[0]).toMatchObject({
			type: "chart",
			chartType: "bar",
			xKey: "label",
			yKey: "value",
			units: "Detail Level (1-10)",
			data: [
				{ label: "Dog Food Research", value: 8 },
				{ label: "Profile Inquiry", value: 6 },
				{ label: "Education & Career", value: 7 },
				{ label: "Family & Home", value: 7 },
				{ label: "Community Involvement", value: 5 },
			],
		});
	});

	it("accepts the full v1 chart type set and rejects chart types outside it", () => {
		for (const chartType of [
			"bar",
			"stackedBar",
			"line",
			"area",
			"scatter",
		] as const) {
			const result = validateGeneratedDocumentSource({
				version: 1,
				template: "alfyai_standard_report",
				title: `${chartType} report`,
				blocks: [
					{
						type: "chart",
						chartType,
						title: `${chartType} chart`,
						caption: "Caption",
						altText: "Accessible summary.",
						units: "items",
						xKey: "label",
						yKey: "value",
						seriesKey: chartType === "stackedBar" ? "series" : undefined,
						data:
							chartType === "stackedBar"
								? [{ label: "A", series: "North", value: 10 }]
								: [{ label: "A", value: 10 }],
					},
				],
			});
			expect(result).toMatchObject({ ok: true });
		}

		for (const chartType of ["pie", "donut"] as const) {
			const result = validateGeneratedDocumentSource({
				version: 1,
				template: "alfyai_standard_report",
				title: `${chartType} report`,
				blocks: [
					{
						type: "chart",
						chartType,
						title: `${chartType} chart`,
						caption: "Caption",
						altText: "Accessible summary.",
						units: "share",
						labelKey: "label",
						valueKey: "value",
						data: [{ label: "A", value: 10 }],
					},
				],
			});
			expect(result).toMatchObject({ ok: true });
		}

		expect(
			validateGeneratedDocumentSource({
				version: 1,
				template: "alfyai_standard_report",
				title: "Radar report",
				blocks: [
					{
						type: "chart",
						chartType: "radar",
						title: "Radar",
						caption: "Caption",
						altText: "Accessible summary.",
						units: "items",
						xKey: "label",
						yKey: "value",
						data: [{ label: "A", value: 10 }],
					},
				],
			}),
		).toMatchObject({
			ok: false,
			code: "unsupported_chart_type",
		});
	});

	function paragraphSource(text: string): unknown {
		return {
			version: 1,
			template: "alfyai_standard_report",
			title: "Annotated report",
			blocks: [{ type: "paragraph", text }],
		};
	}

	it("accepts inline citation annotations in paragraph text", () => {
		const result = validateGeneratedDocumentSource(
			paragraphSource(
				"Ireland passed 8 GW [4][[cite:4:c]], wind is 5 GW [7][[cite:s]], storage lags[[cite:i]].",
			),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const paragraph = result.source.blocks[0];
		expect(paragraph).toMatchObject({
			type: "paragraph",
			text: "Ireland passed 8 GW [4][[cite:4:c]], wind is 5 GW [7][[cite:s]], storage lags[[cite:i]].",
		});
	});

	it("rejects paragraphs carrying a malformed citation annotation", () => {
		for (const text of [
			"Unknown level[[cite:4:x]].",
			"Zero is not a source number[[cite:0:c]].",
			"Missing level[[cite:4]].",
			"Nothing at all[[cite:]].",
			"Half written [[cite:c].",
		]) {
			expect(
				validateGeneratedDocumentSource(paragraphSource(text)),
			).toMatchObject({
				ok: false,
				code: "unsupported_document_block",
			});
		}
	});

	it("parses annotations into segments and projects them as plain glyphs", () => {
		const text = "Grid capacity is 1 GW [12][[cite:12:s]] today[[cite:i]].";
		expect(parseGeneratedDocumentInlineText(text)).toEqual([
			{ kind: "text", text: "Grid capacity is 1 GW [12]" },
			{ kind: "citation", sourceNumber: 12, level: "single" },
			{ kind: "text", text: " today" },
			{ kind: "citation", sourceNumber: null, level: "inferred" },
			{ kind: "text", text: "." },
		]);
		expect(generatedDocumentCitationPlainText(text)).toBe(
			"Grid capacity is 1 GW [12][12]ˢ todayⁱ.",
		);
		expect(
			generatedDocumentCitationToken({
				sourceNumber: 4,
				level: "corroborated",
			}),
		).toBe("[[cite:4:c]]");
		expect(
			generatedDocumentCitationToken({ sourceNumber: null, level: "inferred" }),
		).toBe("[[cite:i]]");
	});

	it("keeps annotation tokens out of the readable text", () => {
		const result = validateGeneratedDocumentSource(
			paragraphSource("Onshore wind is 5 GW[[cite:7:c]]."),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const markdown = markdownOf(result.source);
		expect(markdown).toContain("Onshore wind is 5 GW[7]ᶜ.");
		expect(markdown).not.toContain("[[cite");
	});
});
