import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	computeMetrics,
	coreAnswerPresent,
	describeWordBudget,
	executiveSummarySection,
	junkSourceNotes,
	numberAppearsIn,
	numbersIn,
	repeatedFactCount,
	reportBody,
	sectionsCell,
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
		coreAnswerRegex?: string;
		coreAnswerKeywords?: string[];
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

	it("states what answering the core question looks like, as a valid regex", () => {
		for (const query of QUERIES.queries) {
			expect(query.coreAnswerRegex).toBeTruthy();
			expect(() => new RegExp(query.coreAnswerRegex ?? "", "i")).not.toThrow();
		}
	});
});

describe("numbersIn", () => {
	it("skips citation markers, confidence keys and the year", () => {
		expect(numbersIn("Capacity reached 8,000 MW in 2026. [3]ᶜ")).toEqual([
			"8,000",
		]);
	});

	it("skips a spelled date rather than reading numbers out of it", () => {
		expect(numbersIn("The laptop shipped on January 21, 2026.")).toEqual([]);
		expect(numbersIn("Published on 2026-03-14 by the agency.")).toEqual([]);
	});

	it("skips model and version tokens", () => {
		expect(numbersIn("The Dell XPS 13 9343 runs GPT-5.6.")).toEqual([]);
	});

	it("skips an ordinal", () => {
		expect(numbersIn("France took 3rd place.")).toEqual([]);
	});

	it("still reads a real quantity in the same sentence", () => {
		expect(
			numbersIn("In 2024 the union added 62.8 GW, up from 3rd place."),
		).toEqual(["62.8"]);
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

	it("checks each figure against its OWN sentence's sources", () => {
		// Two sentences in one paragraph, each ending in a citation group. The
		// second sentence's figure is in source 1's text, not source 2's, so
		// pooling the whole paragraph would wrongly call it matched.
		const metrics = computeMetrics({
			markdown: [
				"## Capacity",
				"",
				"The union added 8,000 MW of solar capacity. [1]ˢ Permits take 8,000 MW of review. [2]ˢ",
			].join("\n"),
			evidence,
		});
		expect(metrics.numbersChecked).toBe(2);
		expect(metrics.numbersMatched).toBe(1);
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

	it("names the closest figure the cited source states", () => {
		const metrics = computeMetrics({
			markdown: [
				"## Capacity",
				"",
				"The union added 8,412 MW of solar capacity. [1]ˢ",
			].join("\n"),
			evidence,
		});
		expect(metrics.unmatchedNumberNotes[0]).toContain("closest in the cited");
	});

	it("counts the sections and the Limitations disagreement lines", () => {
		const metrics = computeMetrics({
			markdown: [
				"# EU solar capacity",
				"",
				"## Executive summary",
				"",
				"The union added 8 GW. [1]ᶜ",
				"",
				"## Capacity added",
				"",
				"Body text. [1]ˢ",
				"",
				"## Rules and queues",
				"",
				"More body text. [2]ˢ",
				"",
				"## Limitations",
				"",
				'- Sources disagree on "additions": [1] says the figure is 8 GW, [2] says it is 6 GW.',
				'- Sources disagree on "capacity": [1] says the figure is 9 GW, [2] says it is 7 GW.',
				"- One sentence was removed because no cited source supported it.",
				"",
				"## Sources",
				"",
				"- [Solar market update](https://iea.org/a)",
			].join("\n"),
			evidence,
		});
		expect(metrics.sectionCount).toBe(2);
		expect(metrics.contradictionLineCount).toBe(2);
	});
});

describe("describeWordBudget", () => {
	it("names the range it is measuring against, inside the band", () => {
		expect(describeWordBudget(900, "overview")).toEqual({
			label: "in range (700-1100)",
			ok: true,
		});
	});

	it("reports how far over or under the band a report landed, with the band", () => {
		expect(describeWordBudget(33_212, "in-depth")).toEqual({
			label: "over by 30412 (1800-2800)",
			ok: false,
		});
		expect(describeWordBudget(430, "overview")).toEqual({
			label: "under by 270 (700-1100)",
			ok: false,
		});
	});

	it("names the band even when the report is empty of words", () => {
		expect(describeWordBudget(0, "overview").label).toContain("(700-1100)");
	});

	it("uses each profile's own band", () => {
		expect(describeWordBudget(4000, "exhaustive").ok).toBe(true);
		expect(describeWordBudget(4000, "in-depth").ok).toBe(false);
	});
});

describe("repeatedFactCount", () => {
	it("counts a sentence restating an earlier sentence's figure set", () => {
		const body = [
			"The union installed 65.1 GW of solar in 2025, down from 65.6 GW in 2024. [1]ᶜ",
			"SolarPower Europe reports 65.1 GW for 2025 and 65.6 GW for 2024. [2]ˢ",
		].join(" ");
		expect(repeatedFactCount(body)).toBe(1);
	});

	it("does not count a sentence carrying a different figure set", () => {
		const body = [
			"The union installed 65.1 GW of solar in 2025. [1]ᶜ",
			"Germany added 18.8 GW of that total. [2]ˢ",
		].join(" ");
		expect(repeatedFactCount(body)).toBe(0);
	});

	it("ignores sentences with no figures at all", () => {
		const body =
			"A member-state ranking would require more evidence. ⁱ The picture is mixed. ⁱ";
		expect(repeatedFactCount(body)).toBe(0);
	});

	it("is reported per query in the metrics", () => {
		const metrics = computeMetrics({
			markdown: [
				"# Solar",
				"",
				"## Additions",
				"",
				"The union installed 65.1 GW in 2025 against 65.6 GW in 2024. [1]ᶜ",
				"",
				"## Cross-check",
				"",
				"The outlook reports 65.1 GW for 2025 and 65.6 GW for 2024. [1]ᶜ",
			].join("\n"),
			evidence: undefined,
		});
		expect(metrics.repeatedFactCount).toBe(1);
	});
});

describe("executiveSummarySection", () => {
	it("returns just the summary, not the rest of the report", () => {
		const summary = executiveSummarySection(
			[
				"# Title",
				"",
				"## Executive summary",
				"",
				"The union added 65.1 GW in 2025. [1]ᶜ",
				"",
				"## Capacity added",
				"",
				"Germany led the member states. [2]ˢ",
			].join("\n"),
		);
		expect(summary).toContain("65.1 GW");
		expect(summary).not.toContain("Germany");
	});

	it("is empty when the report has no summary", () => {
		expect(executiveSummarySection("# Title\n\nJust prose.")).toBe("");
	});
});

describe("coreAnswerPresent", () => {
	const query = {
		id: "energy-statistics",
		kind: "energy statistics",
		profile: "overview" as const,
		language: "en",
		query: "How much solar PV did the EU add in 2025?",
		expectations: [],
		coreAnswerRegex: "\\d{2,3}(?:[.,]\\d+)?\\s?(?:GW|gigawatt)",
		coreAnswerKeywords: ["2025", "2024"],
	};

	it("is true when the summary carries the answer", () => {
		expect(
			coreAnswerPresent({
				markdown: [
					"## Executive summary",
					"",
					"The EU added 65.1 GW in 2025, down from 70 GW in 2024. [1]ᶜ",
				].join("\n"),
				query,
			}),
		).toBe(true);
	});

	it("is false when the summary answers a different question", () => {
		expect(
			coreAnswerPresent({
				markdown: [
					"## Executive summary",
					"",
					"The evidence points to Germany as the leading member state. [1]ⁱ",
					"",
					"## Year-on-year comparison",
					"",
					"France overtook Italy. [2]ˢ",
				].join("\n"),
				query,
			}),
		).toBe(false);
	});

	it("accepts an answer buried in the body rather than the summary", () => {
		expect(
			coreAnswerPresent({
				markdown: [
					"## Executive summary",
					"",
					"This report reviews the union's solar build-out. [1]ⁱ",
					"",
					"## Capacity added",
					"",
					"The EU added 65.1 GW in 2025, against 70 GW in 2024. [1]ᶜ",
				].join("\n"),
				query,
			}),
		).toBe(true);
	});

	it("is null when the query states no expected answer", () => {
		expect(
			coreAnswerPresent({
				markdown: "## Executive summary\n\nAnything at all.",
				query: { ...query, coreAnswerRegex: undefined, coreAnswerKeywords: [] },
			}),
		).toBeNull();
	});

	it("is null rather than false when the expectation is a bad regex", () => {
		expect(
			coreAnswerPresent({
				markdown: "## Executive summary\n\nAnything at all.",
				query: {
					...query,
					coreAnswerRegex: "([unclosed",
					coreAnswerKeywords: [],
				},
			}),
		).toBeNull();
	});
});

describe("sectionsCell", () => {
	const base = computeMetrics({ markdown: null, evidence: undefined });

	it("shows sections written against sections planned", () => {
		expect(sectionsCell({ ...base, sectionCount: 5, sectionsPlanned: 5 })).toBe(
			"5 / 5",
		);
	});

	// The collapse the third evaluation shipped: a six-section plan reported as
	// a one-section report, and nothing in the table said the five were LOST.
	it("marks a report that lost sections the plan asked for", () => {
		expect(sectionsCell({ ...base, sectionCount: 1, sectionsPlanned: 6 })).toBe(
			"**1 / 6**",
		);
	});

	it("falls back to the heading count when the job reported no plan", () => {
		expect(
			sectionsCell({ ...base, sectionCount: 4, sectionsPlanned: null }),
		).toBe("4");
	});
});
