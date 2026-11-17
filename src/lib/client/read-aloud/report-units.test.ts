import { describe, expect, it } from "vitest";
import { renderStandardReportHtml } from "$lib/server/services/file-production/renderers/standard-report-html";
import { validateGeneratedDocumentSource } from "$lib/server/services/file-production/source-schema";
import {
	pointInBlocks,
	positionInBlocks,
	REPORT_UNIT_RULES,
	reportBlocks,
	reportRoot,
} from "./report-units";

/** A standard report as Atlas makes one: headings, a paragraph with a basis marker and a source chip, a table, a list and the final Sources. */
function reportHtml(): string {
	const validation = validateGeneratedDocumentSource({
		version: 1,
		template: "alfyai_standard_report",
		title: "Weekend report",
		blocks: [
			{ type: "heading", level: 2, text: "Getting there" },
			{
				type: "paragraph",
				text: "The train leaves at nine in the morning from the main station [1].",
				sources: [
					{
						title: "Rail timetable",
						url: "https://example.com/timetable",
						reasoning: "The timetable lists the morning train.",
					},
				],
				basisMarkers: [
					{
						type: "basisMarker",
						id: "basis-1",
						support: "supported",
						anchorText: "The train leaves at nine",
						rationale: "The timetable lists the nine o'clock train.",
					},
				],
			},
			{
				type: "table",
				title: "Fares",
				columns: [
					{ key: "item", label: "Item", kind: "text" },
					{ key: "cost", label: "Cost", kind: "number" },
				],
				rows: [{ item: "TABLECELL", cost: 12 }],
			},
			{ type: "heading", level: 2, text: "What to pack" },
			{
				type: "list",
				ordered: false,
				items: [
					{ text: "Warm coats for the cold nights." },
					{ text: "Long scarves and woollen socks." },
				],
			},
			{ type: "heading", level: 2, text: "Sources" },
			{
				type: "sourceChips",
				title: "Web Sources",
				sources: [
					{
						title: "Rail timetable",
						url: "https://example.com/timetable",
						reasoning: "The timetable lists the morning train.",
					},
				],
			},
		],
	});
	if (!validation.ok) throw new Error(validation.message);
	return renderStandardReportHtml(validation.source).content.toString("utf8");
}

/** The page's copy: inert, parsed from the HTML, nothing run. */
function inertCopy(html: string): Document {
	return new DOMParser().parseFromString(html, "text/html");
}

/** The frame's copy: the same HTML, then what the report's own scripts change after it loads. */
function liveCopy(html: string): Document {
	const live = document.implementation.createHTMLDocument("report");
	live.documentElement.innerHTML = new DOMParser().parseFromString(
		html,
		"text/html",
	).documentElement.innerHTML;
	live.querySelector(".report-nav a")?.classList.add("active");
	live.getElementById("report-sidebar")?.classList.add("open");
	for (const tooltip of live.querySelectorAll<HTMLElement>(
		".source-tooltip, .basis-tooltip",
	)) {
		tooltip.classList.add("tooltip-below");
		tooltip.style.setProperty("--tooltip-left", "120px");
	}
	for (const favicon of live.querySelectorAll<HTMLElement>(
		"[data-favicon-fallback]",
	))
		favicon.hidden = !favicon.hidden;
	return live;
}

const texts = (blocks: Text[][]) =>
	blocks.map((nodes) => nodes.map((node) => node.data).join(""));

describe("reportBlocks", () => {
	it("gives the page's inert copy and the frame's live copy the same blocks, text for text", () => {
		const html = reportHtml();
		const page = reportBlocks(reportRoot(inertCopy(html)), REPORT_UNIT_RULES);
		const frame = reportBlocks(reportRoot(liveCopy(html)), REPORT_UNIT_RULES);
		expect(page.length).toBeGreaterThan(4);
		expect(texts(frame)).toEqual(texts(page));
	});

	it("reads the report's own text in order, with its headings", () => {
		const blocks = texts(
			reportBlocks(reportRoot(inertCopy(reportHtml())), REPORT_UNIT_RULES),
		);
		const joined = blocks.join(" | ");
		expect(joined).toContain("Weekend report");
		expect(joined).toContain("Getting there");
		expect(joined).toContain("The train leaves at nine in the morning");
		expect(joined).toContain("Warm coats for the cold nights.");
		expect(joined.indexOf("Getting there")).toBeLessThan(
			joined.indexOf("Warm coats"),
		);
	});

	it("keeps the report's chrome out: its source chips, tooltips, scripts, styles and Sources", () => {
		const joined = texts(
			reportBlocks(reportRoot(inertCopy(reportHtml())), REPORT_UNIT_RULES),
		).join(" | ");
		for (const chrome of [
			"The timetable lists the nine o'clock train.",
			"The timetable lists the morning train.",
			"example.com",
			"Rail timetable",
			"Web Sources",
			"addEventListener",
			"--report-text",
		])
			expect(joined, chrome).not.toContain(chrome);
	});

	it("is the report's content alone: the section menu is outside it", () => {
		const copy = inertCopy(reportHtml());
		expect(reportRoot(copy).id).toBe("report-content");
		expect(
			texts(reportBlocks(reportRoot(copy), REPORT_UNIT_RULES)).join(" "),
		).not.toContain("Sections");
	});

	it("follows markup, never style: a part hidden after load is still a unit on both sides", () => {
		const html = reportHtml();
		const live = liveCopy(html);
		const paragraph = live.querySelector<HTMLElement>("#report-content p");
		if (paragraph) {
			paragraph.hidden = true;
			paragraph.style.display = "none";
		}
		expect(texts(reportBlocks(reportRoot(live), REPORT_UNIT_RULES))).toEqual(
			texts(reportBlocks(reportRoot(inertCopy(html)), REPORT_UNIT_RULES)),
		);
	});
});

describe("positions", () => {
	it("a text node and offset is a block and an offset, and back", () => {
		const blocks = reportBlocks(
			reportRoot(inertCopy(reportHtml())),
			REPORT_UNIT_RULES,
		);
		blocks.forEach((nodes, block) => {
			let start = 0;
			for (const node of nodes) {
				for (const offset of [0, Math.floor(node.data.length / 2)]) {
					const position = positionInBlocks(blocks, node, offset);
					expect(position).toEqual({ block, offset: start + offset });
					expect(pointInBlocks(blocks, block, start + offset)).toEqual({
						node,
						offset,
					});
				}
				start += node.data.length;
			}
		});
	});

	it("knows nothing outside the blocks, and nothing past a block's end", () => {
		const copy = inertCopy(reportHtml());
		const blocks = reportBlocks(reportRoot(copy), REPORT_UNIT_RULES);
		const style = copy.querySelector("style")?.firstChild as Text;
		expect(positionInBlocks(blocks, style, 0)).toBeNull();
		const last = blocks.length - 1;
		const length = (blocks[last] ?? []).reduce(
			(sum, node) => sum + node.data.length,
			0,
		);
		expect(pointInBlocks(blocks, last, length)).not.toBeNull();
		expect(pointInBlocks(blocks, last, length + 1)).toBeNull();
		expect(pointInBlocks(blocks, blocks.length, 0)).toBeNull();
		expect(pointInBlocks(blocks, -1, 0)).toBeNull();
	});
});
