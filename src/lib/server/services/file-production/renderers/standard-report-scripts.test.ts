import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateGeneratedDocumentSource } from "../source-schema";
import { renderStandardReportHtml } from "./standard-report-html";
import {
	cspSha256,
	STANDARD_REPORT_HANDLER_HASHES,
	STANDARD_REPORT_SCRIPT,
	STANDARD_REPORT_SCRIPT_HASHES,
} from "./standard-report-scripts";

const sha256 = (text: string) =>
	`'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

/** A report with everything the renderer can draw that carries script: sections, sources with favicons. */
function richReportHtml(): string {
	const validation = validateGeneratedDocumentSource({
		version: 1,
		template: "alfyai_standard_report",
		title: "Weekend report",
		blocks: [
			{ type: "heading", level: 2, text: "Getting there" },
			{
				type: "paragraph",
				text: "The train leaves at nine in the morning [1].",
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
	return renderStandardReportHtml(
		validation.source,
		new Map([["example.com", "data:image/png;base64,iVBORw0KGgo="]]),
	).content.toString("utf8");
}

// Security review I1: the report preview's policy lets only the app's own scripts
// run, by their hashes. These are those scripts, and every version a stored report
// may still carry.
describe("the standard report's own scripts", () => {
	it("hash as the policy names them", () => {
		expect(cspSha256("abc")).toBe(sha256("abc"));
	});

	it("is the script the renderer writes today, unchanged since 2026-06-26", () => {
		// When this fails, the script changed: its old hash goes into the earlier
		// versions (`EARLIER_SCRIPT_HASHES`), so reports made before still run theirs.
		expect(sha256(STANDARD_REPORT_SCRIPT)).toBe(
			"'sha256-UDLw0YBKIE3n0AJAHJ48t12fuoA77uneEBHoqBxnHb8='",
		);
		expect(STANDARD_REPORT_SCRIPT_HASHES[0]).toBe(
			sha256(STANDARD_REPORT_SCRIPT),
		);
	});

	it("lists every version a stored report may carry, taken from git history, each once", () => {
		expect(STANDARD_REPORT_SCRIPT_HASHES).toEqual([
			"'sha256-UDLw0YBKIE3n0AJAHJ48t12fuoA77uneEBHoqBxnHb8='",
			"'sha256-qTRY6gb/sCc8Am548y72GmJxxHkD9h0WShaT/13tGbI='",
			"'sha256-b+Xcvg56Kt550IH7taonhV8HMD4rYVYmWz9it0I3s3I='",
			"'sha256-TK5l8g1/dfEMpvFHS+PwnGBSwxEbqC3YsNwcORa0BMc='",
			"'sha256-JB+wFcGFP8LDI20UESR0Orjvc9gOa1GioWYlQ0p86OM='",
			"'sha256-QIBgiiDYQXRjZfbmthvuEWl9I9EtlZSqn9nTsrBWeJs='",
		]);
		expect(STANDARD_REPORT_HANDLER_HASHES).toEqual([
			"'sha256-zcjnji1+eR5Y3lpzzmyDmc0dI/4FHUQEo/y8nehUtjE='",
		]);
	});

	it("are all a report's scripts and handlers: nothing the renderer writes runs without its hash", () => {
		const html = richReportHtml();
		const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
		expect(scripts.length).toBeGreaterThan(0);
		for (const [, text] of scripts)
			expect(STANDARD_REPORT_SCRIPT_HASHES).toContain(sha256(text ?? ""));
		const handlers = [...html.matchAll(/\son[a-z]+="([^"]*)"/gi)];
		expect(handlers.length).toBeGreaterThan(0);
		for (const [, code] of handlers)
			expect(STANDARD_REPORT_HANDLER_HASHES).toContain(sha256(code ?? ""));
		expect(html).not.toMatch(/javascript:/i);
	});
});
