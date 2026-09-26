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
		// Recorded AND shown: the Markdown renderer trails a paragraph's attached
		// sources as a compact parenthetical, same as the HTML, PDF and DOCX
		// renderers all already did — the deleted projection listed them too, so
		// this closes the one gap D9 left in `standard-report-markdown.ts`.
		const markdown = markdownOf(result.source);
		expect(markdown).toContain(
			"Surface code maturity is backed by accepted source evidence. " +
				"*(Sources: [Vendor docs](https://example.com/docs), " +
				"Uploaded strategy memo)*",
		);
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
		// The rationale now renders in Markdown too, same as the HTML and PDF
		// renderers, so the claim is both marked and explained wherever the text
		// is read.
		expect(markdownOf(result.source)).toContain(
			"Revenue increased by 12% while churn evidence remains thin. " +
				"*(Basis: Supported — Accepted source states revenue increased by " +
				"12%. This should compact.)*",
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

// The model resends a corrected document only as well as the refusal tells it
// what was wrong. "Contains an unsupported block" named neither the block nor
// the field, so it rewrote the whole document and often broke another block.
describe("generated document source refusals name the failing block", () => {
	function refusal(blocks: unknown[]) {
		const result = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Report",
			blocks,
		});
		if (result.ok) throw new Error("expected a refusal");
		return result;
	}

	it("names index, type and field for a heading with an unsupported level", () => {
		const result = refusal([
			{ type: "paragraph", text: "Fine." },
			{ type: "heading", level: 7, text: "Too deep" },
		]);
		expect(result.code).toBe("unsupported_document_block");
		expect(result.message).toMatch(/^Block 2 \(heading\): /);
		expect(result.message).toContain('"level"');
	});

	it("names an unknown block type and the supported ones", () => {
		const result = refusal([{ type: "rawHtml", html: "<b>x</b>" }]);
		expect(result.code).toBe("unsupported_document_block");
		expect(result.message).toMatch(/^Block 1 \(rawHtml\): /);
		expect(result.message).toContain("paragraph");
		expect(result.message).toContain("table");
	});

	it("names a block with no type at all", () => {
		const result = refusal([{ text: "no type" }]);
		expect(result.message).toMatch(/^Block 1: /);
		expect(result.message).toContain('"type"');
	});

	it("names the missing text of a paragraph and the items of a list", () => {
		expect(refusal([{ type: "paragraph", text: "" }]).message).toMatch(
			/^Block 1 \(paragraph\): .*"text"/,
		);
		expect(refusal([{ type: "list", items: [] }]).message).toMatch(
			/^Block 1 \(list\): .*"items"/,
		);
	});

	it("names the table and what is wrong with its rows", () => {
		const result = refusal([
			{ type: "paragraph", text: "Intro." },
			{
				type: "table",
				columns: [{ key: "a", label: "A" }],
				rows: [["1", "2", "3"]],
			},
		]);
		expect(result.code).toBe("unsupported_table_structure");
		expect(result.message).toMatch(/^Block 2 \(table\): /);
		expect(result.message).toContain('"rows"');
	});

	it("prefixes chart refusals with the block too", () => {
		const result = refusal([{ type: "chart", chartType: "bar", data: [] }]);
		expect(result.code).toBe("unsupported_chart_data");
		expect(result.message).toMatch(/^Block 1 \(chart\): /);
	});
});

// Only stackedBar draws more than one series. A bar or line chart handed
// several used to render the first and silently drop the rest.
describe("generated document charts with several series", () => {
	const chart = (fields: Record<string, unknown>) =>
		validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Report",
			blocks: [
				{
					type: "chart",
					title: "Revenue",
					caption: "Revenue by region.",
					altText: "Revenue by region.",
					units: "EUR",
					...fields,
				},
			],
		});

	it("refuses a Chart.js bar chart with two datasets instead of keeping only the first", () => {
		const result = chart({
			chartType: "bar",
			data: {
				labels: ["North", "South"],
				datasets: [
					{ label: "Q2", data: [10, 20] },
					{ label: "Q3", data: [12, 18] },
				],
			},
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("unsupported_chart_data");
		expect(result.message).toMatch(/^Block 1 \(chart\): /);
		expect(result.message).toContain("Q2, Q3");
		expect(result.message).toContain('"stackedBar"');
	});

	it("refuses a line chart whose seriesKey names more than one series", () => {
		const result = chart({
			chartType: "line",
			xKey: "quarter",
			yKey: "value",
			seriesKey: "region",
			data: [
				{ quarter: "Q2", region: "North", value: 10 },
				{ quarter: "Q2", region: "South", value: 20 },
			],
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toContain("North, South");
	});

	it("keeps every Chart.js dataset of a stacked bar chart", () => {
		const result = chart({
			chartType: "stackedBar",
			data: {
				labels: ["North", "South"],
				datasets: [
					{ label: "Q2", data: [10, 20] },
					{ label: "Q3", data: [12, 18] },
				],
			},
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const block = result.source.blocks[0];
		expect(block).toMatchObject({ seriesKey: "series" });
		expect(block.type === "chart" && block.data).toHaveLength(4);
	});
});

// Ruling 36: an exported checklist shows ticks, not "[x]" prose — a list
// item can optionally carry `checked`, on top of the plain string form, so
// this is an additive shape and the envelope stays version 1.
describe("checklist list items (ruling 36)", () => {
	function normalizedItems(items: unknown[]) {
		const result = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Checklist report",
			blocks: [{ type: "list", style: "bullet", items }],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.message);
		const block = result.source.blocks[0];
		if (block.type !== "list") throw new Error("expected a list block");
		return block.items;
	}

	it("keeps a plain string item exactly as a string", () => {
		expect(normalizedItems(["Book the hotel"])).toEqual(["Book the hotel"]);
	});

	it("normalizes { text, checked } into a checklist item", () => {
		expect(
			normalizedItems([{ text: "Book the hotel", checked: true }]),
		).toEqual([{ text: "Book the hotel", checked: true }]);
	});

	it("normalizes checked: true and checked: false distinctly", () => {
		expect(
			normalizedItems([
				{ text: "Booked", checked: true },
				{ text: "Not yet", checked: false },
			]),
		).toEqual([
			{ text: "Booked", checked: true },
			{ text: "Not yet", checked: false },
		]);
	});

	it("collapses { text } with no checked field down to a bare string", () => {
		expect(normalizedItems([{ text: "Just an object-shaped item" }])).toEqual([
			"Just an object-shaped item",
		]);
	});

	it("drops an object item with a non-boolean checked, keeping only its text", () => {
		expect(normalizedItems([{ text: "Weird input", checked: "yes" }])).toEqual([
			"Weird input",
		]);
	});
});
