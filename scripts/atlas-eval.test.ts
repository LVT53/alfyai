import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	computeMetrics,
	junkSourceNotes,
	numberAppearsIn,
	numbersIn,
	reportBody,
} from "./atlas-eval";

const QUERIES = JSON.parse(
	readFileSync(
		resolve(process.cwd(), "scripts/atlas-eval-queries.json"),
		"utf8",
	),
) as {
	queries: Array<{
		id: string;
		kind: string;
		profile: string;
		language: string;
		query: string;
		expectations: string[];
	}>;
};

describe("atlas-eval-queries.json", () => {
	it("covers the ten required query kinds", () => {
		expect(QUERIES.queries).toHaveLength(10);
		expect(QUERIES.queries.map((query) => query.kind)).toEqual([
			"energy statistics",
			"product comparison",
			"policy question",
			"medical guideline summary",
			"Hungarian-language query",
			"local Irish topic",
			"Dutch topic",
			"historical timeline",
			"fast-moving tech topic",
			"niche topic with thin evidence",
		]);
	});

	it("gives every query a valid profile and hand-checkable expectations", () => {
		for (const query of QUERIES.queries) {
			expect(["overview", "in-depth", "exhaustive"]).toContain(query.profile);
			expect(query.expectations.length).toBeGreaterThanOrEqual(3);
			expect(new Set(QUERIES.queries.map((entry) => entry.id)).size).toBe(10);
		}
	});
});

describe("numbersIn", () => {
	it("skips citation markers and confidence keys", () => {
		expect(numbersIn("Capacity reached 8,000 MW in 2026. [3]ᶜ")).toEqual([
			"8,000",
			"2026",
		]);
	});
});

describe("numberAppearsIn", () => {
	it("matches across the SI ladder, separators and scale words", () => {
		expect(numberAppearsIn("8", "capacity of 8,000 MW")).toBe(true);
		expect(numberAppearsIn("8,000", "capacity of 8000 MW")).toBe(true);
		expect(numberAppearsIn("3.5", "növekedés 3,5 százalék")).toBe(true);
		expect(numberAppearsIn("2500000000", "revenue of 2.5 billion")).toBe(true);
	});

	it("does not match an unrelated figure", () => {
		expect(numberAppearsIn("8,412", "capacity of 6,000 MW")).toBe(false);
	});
});

describe("reportBody", () => {
	it("drops the Sources section and the confidence legend", () => {
		const body = reportBody(
			[
				"# Title",
				"",
				"Capacity reached 8 GW. [1]ᶜ",
				"",
				"Confidence key: ᶜ corroborated · ˢ single · ⁱ inferred.",
				"",
				"## Sources",
				"",
				"- [Report](https://iea.org/a) - Cited in this report",
			].join("\n"),
		);
		expect(body).toContain("Capacity reached 8 GW.");
		expect(body).not.toContain("Confidence key");
		expect(body).not.toContain("iea.org");
	});
});

describe("junkSourceNotes", () => {
	it("flags redirect stubs, social profiles and mirror duplicates", () => {
		const notes = junkSourceNotes([
			{
				n: 1,
				title: "301 Moved Permanently",
				host: "old.example",
				date: null,
				cited: false,
				snippet: "",
			},
			{
				n: 2,
				title: "Solar Europe | LinkedIn",
				host: "www.linkedin.com",
				date: null,
				cited: true,
				snippet: "",
			},
			{
				n: 3,
				title: "EU solar hits a record",
				host: "example.com",
				date: null,
				cited: true,
				snippet: "",
			},
			{
				n: 4,
				title: "EU solar hits a record",
				host: "cdn.example.com",
				date: null,
				cited: true,
				snippet: "",
			},
			{
				n: 5,
				title: "Solar market update",
				host: "iea.org",
				date: null,
				cited: true,
				snippet: "",
			},
		]);
		expect(notes).toHaveLength(3);
		expect(notes[0]).toContain("redirect or error stub");
		expect(notes[1]).toContain("social profile");
		expect(notes[2]).toContain("duplicate of [3]");
	});
});

describe("computeMetrics", () => {
	const markdown = [
		"# EU solar capacity",
		"",
		"## Executive summary",
		"",
		"The union added 8 GW of solar capacity. [1]ᶜ Permits take eighteen months. [2]ˢ",
		"",
		"Confidence key: ᶜ corroborated · ˢ single · ⁱ inferred.",
		"",
		"## Sources",
		"",
		"- [Solar market update](https://iea.org/a)",
	].join("\n");
	const evidence = {
		corroborated: 3,
		single: 1,
		inferred: 1,
		cut: 2,
		filteredCount: 7,
		sources: [
			{
				n: 1,
				title: "Solar market update",
				host: "iea.org",
				date: "2026-06-01",
				cited: true,
				snippet: "The union added 8,000 MW of new solar capacity.",
			},
			{
				n: 2,
				title: "Permitting review",
				host: "irena.org",
				date: "2026-05-20",
				cited: true,
				snippet: "Grid connection permits take eighteen months on average.",
			},
			{
				n: 3,
				title: "301 Moved Permanently",
				host: "old.example",
				date: null,
				cited: false,
				snippet: "",
			},
		],
	};

	it("measures citation density, resolution, number match and corroboration", () => {
		const metrics = computeMetrics({ markdown, evidence });
		expect(metrics.citationCount).toBe(2);
		expect(metrics.citationResolutionRate).toBe(1);
		// "8" is a single digit and skipped; the sentence carries no other number.
		expect(metrics.numbersChecked).toBe(0);
		expect(metrics.corroborationRate).toBeCloseTo(3 / 5);
		expect(metrics.cutCount).toBe(2);
		expect(metrics.filteredCount).toBe(7);
		expect(metrics.sourceCount).toBe(3);
		expect(metrics.citedSourceCount).toBe(2);
		expect(metrics.junkSourceCount).toBe(1);
		expect(metrics.citationDensity).toBeGreaterThan(0);
	});

	it("reports an unmatched figure with the sentence that carried it", () => {
		const metrics = computeMetrics({
			markdown: [
				"## Capacity",
				"",
				"The union added 8,412 MW of solar capacity. [1]ˢ",
			].join("\n"),
			evidence,
		});
		expect(metrics.numbersChecked).toBe(1);
		expect(metrics.numbersMatched).toBe(0);
		expect(metrics.numberMatchRate).toBe(0);
		expect(metrics.unmatchedNumberNotes[0]).toContain("8,412");
	});

	it("returns honest nulls when there is no report", () => {
		const metrics = computeMetrics({ markdown: null, evidence: undefined });
		expect(metrics).toMatchObject({
			wordCount: 0,
			citationCount: 0,
			citationResolutionRate: null,
			numberMatchRate: null,
			corroborationRate: null,
		});
	});

	it("reports zeros rather than nulls for a v1 report with no [n] markers", () => {
		const metrics = computeMetrics({
			markdown: [
				"## Capacity",
				"",
				"The union added solar capacity at pace. *(Basis: Partial)*",
			].join("\n"),
			evidence: undefined,
		});
		expect(metrics.citationCount).toBe(0);
		expect(metrics.citationDensity).toBe(0);
		expect(metrics.citationResolutionRate).toBeNull();
		expect(metrics.sourceCount).toBe(0);
	});
});
