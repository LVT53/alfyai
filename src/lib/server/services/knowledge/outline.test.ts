import { describe, expect, it } from "vitest";
import {
	estimateDocumentTokenCount,
	extractDocumentOutline,
	MAX_OUTLINE_ENTRIES,
	readStoredOutline,
	readStoredPageCount,
	readStoredTokenEstimate,
} from "./outline";

describe("extractDocumentOutline", () => {
	it("returns an empty outline for empty or missing text", () => {
		expect(extractDocumentOutline(null)).toEqual([]);
		expect(extractDocumentOutline(undefined)).toEqual([]);
		expect(extractDocumentOutline("   \n  ")).toEqual([]);
	});

	it("extracts markdown ATX headings with their level and a preview", () => {
		const text = [
			"# Contract",
			"",
			"This agreement is entered into by the parties below.",
			"",
			"## Break clause",
			"",
			"Either party may terminate this agreement with 30 days notice.",
		].join("\n");

		const outline = extractDocumentOutline(text);

		expect(outline).toHaveLength(2);
		expect(outline[0]).toMatchObject({ level: 1, title: "Contract" });
		expect(outline[0].preview).toContain("This agreement is entered into");
		expect(outline[1]).toMatchObject({ level: 2, title: "Break clause" });
		expect(outline[1].preview).toContain(
			"Either party may terminate this agreement",
		);
	});

	it("extracts numbered headings like '2.3 Break clause' and derives level from depth", () => {
		const text = [
			"1 Definitions",
			"Terms used in this agreement are defined below.",
			"",
			"2.3 Break clause",
			"Either party may terminate this agreement with 30 days notice.",
		].join("\n");

		const outline = extractDocumentOutline(text);

		expect(outline).toHaveLength(2);
		expect(outline[0]).toMatchObject({ level: 1, title: "1 Definitions" });
		expect(outline[1]).toMatchObject({ level: 2, title: "2.3 Break clause" });
		expect(outline[1].preview).toContain("Either party may terminate");
	});

	it("caps the preview at ~300 characters after the heading", () => {
		const body = "x".repeat(500);
		const text = `# Heading\n${body}`;

		const outline = extractDocumentOutline(text);

		expect(outline[0].preview.length).toBeLessThanOrEqual(300);
	});

	it("falls back to short Title-Case lines followed by a paragraph when there are no structured headings", () => {
		const text = [
			"Executive Summary",
			"This report covers the quarterly results in detail.",
			"",
			"just some lowercase text that is not a heading",
			"more lowercase body text follows here as well",
		].join("\n");

		const outline = extractDocumentOutline(text);

		expect(outline.some((entry) => entry.title === "Executive Summary")).toBe(
			true,
		);
	});

	it("caps stored outline entries at MAX_OUTLINE_ENTRIES", () => {
		const headings = Array.from(
			{ length: MAX_OUTLINE_ENTRIES + 50 },
			(_, index) => `# Heading ${index}\nbody text ${index}`,
		).join("\n");

		const outline = extractDocumentOutline(headings);

		expect(outline).toHaveLength(MAX_OUTLINE_ENTRIES);
	});
});

describe("estimateDocumentTokenCount", () => {
	it("delegates to the shared token estimator", () => {
		expect(estimateDocumentTokenCount(null)).toBe(0);
		expect(estimateDocumentTokenCount("")).toBe(0);
		expect(estimateDocumentTokenCount("hello world")).toBeGreaterThan(0);
	});
});

describe("readStoredOutline / readStoredTokenEstimate / readStoredPageCount", () => {
	it("round-trips a valid outline written to metadata JSON", () => {
		const stored = [
			{ level: 1, title: "Contract", offset: 0, preview: "This agreement" },
			{ level: 2, title: "Break clause", offset: 42, preview: "Either party" },
		];

		expect(readStoredOutline(stored)).toEqual(stored);
	});

	it("drops malformed outline entries defensively", () => {
		const stored = [
			{ level: 1, title: "Valid", offset: 0, preview: "" },
			{ level: "not-a-number", title: "Bad level", offset: 5 },
			{ title: "Missing offset" },
			null,
			"not an object",
		];

		expect(readStoredOutline(stored)).toEqual([
			{ level: 1, title: "Valid", offset: 0, preview: "" },
		]);
	});

	it("returns an empty array for non-array values", () => {
		expect(readStoredOutline(undefined)).toEqual([]);
		expect(readStoredOutline("not an array")).toEqual([]);
	});

	it("reads a positive token estimate and rejects invalid values", () => {
		expect(readStoredTokenEstimate(118_234)).toBe(118_234);
		expect(readStoredTokenEstimate(0)).toBe(0);
		expect(readStoredTokenEstimate(-5)).toBeUndefined();
		expect(readStoredTokenEstimate("118000")).toBeUndefined();
		expect(readStoredTokenEstimate(undefined)).toBeUndefined();
	});

	it("reads a positive page count and rejects zero/invalid values", () => {
		expect(readStoredPageCount(38)).toBe(38);
		expect(readStoredPageCount(0)).toBeUndefined();
		expect(readStoredPageCount(-1)).toBeUndefined();
		expect(readStoredPageCount(undefined)).toBeUndefined();
	});
});
