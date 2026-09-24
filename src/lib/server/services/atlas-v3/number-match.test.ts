import { describe, expect, it } from "vitest";
import {
	competingFigures,
	extractFigures,
	figureAppearsInText,
	findUnsupportedFigures,
	isCheckableFigure,
	parseWrittenNumber,
} from "./number-match";

describe("parseWrittenNumber", () => {
	it("reads both thousands-separator conventions as the same magnitude", () => {
		expect(parseWrittenNumber("8,000")).toBe(8000);
		expect(parseWrittenNumber("8.000")).toBe(8000);
		expect(parseWrittenNumber("8 000")).toBe(8000);
		expect(parseWrittenNumber("1,234,567")).toBe(1234567);
	});

	it("reads both decimal-separator conventions as the same magnitude", () => {
		expect(parseWrittenNumber("3.5")).toBe(3.5);
		expect(parseWrittenNumber("3,5")).toBe(3.5);
	});

	it("resolves a mixed-separator number by its rightmost separator", () => {
		expect(parseWrittenNumber("1.234,56")).toBeCloseTo(1234.56);
		expect(parseWrittenNumber("1,234.56")).toBeCloseTo(1234.56);
	});
});

describe("extractFigures", () => {
	it("carries the unit and scale word into the parsed magnitude", () => {
		const figures = extractFigures("Capacity reached 8 GW and cost $2.5 bn.");
		const capacity = figures.find((figure) => figure.unit === "gw");
		expect(capacity?.value).toBe(8);
		const cost = figures.find((figure) => figure.unit === "usd");
		expect(cost?.value).toBe(2.5e9);
	});

	it("ignores citation markers and confidence keys", () => {
		const figures = extractFigures("Output rose 4% [12]ᶜ last year.");
		expect(figures.map((figure) => figure.text)).toEqual(
			expect.arrayContaining(["4%"]),
		);
		expect(figures.some((figure) => figure.raw === "12")).toBe(false);
	});

	it("treats a bare four-digit year as a date", () => {
		const figures = extractFigures("The 2019 baseline was revised.");
		expect(figures).toEqual([
			expect.objectContaining({ raw: "2019", isDate: true }),
		]);
	});

	it("treats an ISO date as one date figure", () => {
		const figures = extractFigures("Published on 2026-03-14 by the agency.");
		expect(figures.filter((figure) => figure.isDate)).toHaveLength(1);
		expect(figures[0].raw).toBe("2026-03-14");
	});

	it("does not read a scale word out of a longer word", () => {
		const figures = extractFigures("8 minutes of downtime.");
		expect(figures[0]?.value).toBe(8);
	});
});

describe("figureAppearsInText", () => {
	const figureOf = (sentence: string) => extractFigures(sentence)[0];

	it("matches a unit-ladder equivalent", () => {
		const figure = figureOf("Capacity is 8 GW.");
		expect(figureAppearsInText(figure, "added 8,000 MW of capacity")).toBe(
			true,
		);
		expect(figureAppearsInText(figure, "added 8000 MW of capacity")).toBe(true);
		expect(figureAppearsInText(figure, "added 8 gigawatts")).toBe(true);
		expect(figureAppearsInText(figure, "added 8GW")).toBe(true);
	});

	it("matches a decimal-comma source", () => {
		const figure = figureOf("Growth was 3.5%.");
		expect(figureAppearsInText(figure, "a növekedés 3,5% volt")).toBe(true);
		expect(figureAppearsInText(figure, "growth of 3.5 per cent")).toBe(true);
	});

	it("matches a scale-word rendering of a large number", () => {
		const figure = figureOf("Revenue was 2,500,000,000 EUR.");
		expect(figureAppearsInText(figure, "revenue of 2.5 bn eur")).toBe(true);
		expect(figureAppearsInText(figure, "revenue of 2.5 billion euros")).toBe(
			true,
		);
	});

	it("does not match a different figure that merely contains the digits", () => {
		const figure = figureOf("Capacity is 8 GW.");
		expect(figureAppearsInText(figure, "added 18 GW of capacity")).toBe(false);
		const decimal = figureOf("Growth was 3.5%.");
		expect(figureAppearsInText(decimal, "growth of 13.55%")).toBe(false);
	});

	it("matches across a non-breaking-space thousands separator", () => {
		const figure = figureOf("The fleet is 12,400 units.");
		expect(figureAppearsInText(figure, "12 400 units in service")).toBe(true);
	});
});

describe("findUnsupportedFigures", () => {
	it("reports the figure the source does not state, with the citation", () => {
		const mismatches = findUnsupportedFigures({
			sentence: "Solar reached 8 GW in 2026.",
			sourceText: "Solar reached 6,000 MW in 2026.",
			sourceNumber: 4,
		});
		expect(mismatches).toHaveLength(1);
		expect(mismatches[0].detail).toContain("8 GW");
		expect(mismatches[0].detail).toContain("[4]");
	});

	it("passes a sentence whose every figure the source states", () => {
		expect(
			findUnsupportedFigures({
				sentence: "Solar reached 8 GW in 2026.",
				sourceText: "In 2026 solar reached 8,000 MW.",
				sourceNumber: 4,
			}),
		).toEqual([]);
	});
});

describe("competingFigures", () => {
	it("finds a same-unit figure that disagrees beyond tolerance", () => {
		const figure = extractFigures("Capacity is 8 GW.")[0];
		const competing = competingFigures(figure, "capacity stands at 6.2 GW");
		expect(competing.map((entry) => entry.value)).toEqual([6.2]);
	});

	it("ignores a figure within tolerance", () => {
		const figure = extractFigures("Capacity is 8 GW.")[0];
		expect(competingFigures(figure, "capacity of 8.1 GW", 0.05)).toEqual([]);
	});

	it("ignores figures in an unrelated unit", () => {
		const figure = extractFigures("Capacity is 8 GW.")[0];
		expect(competingFigures(figure, "revenue was 40 million euros")).toEqual(
			[],
		);
	});
});

describe("figure kinds", () => {
	const kinds = (sentence: string) =>
		extractFigures(sentence).map((figure) => `${figure.kind}:${figure.text}`);

	it("classifies a bare year as a year, not a quantity", () => {
		expect(kinds("Additions fell in 2025.")).toEqual(["year:2025"]);
		expect(
			extractFigures("Additions fell in 2025.").every(isCheckableFigure),
		).toBe(false);
	});

	it("reads a spelled date as one date rather than the numbers in it", () => {
		expect(kinds("Shipping started on January 21, 2026.")).toEqual([
			"date:January 21, 2026",
		]);
	});

	it("reads a model or version token as a version, not a quantity", () => {
		expect(kinds("The Dell XPS 13 9343 runs GPT-5.6.")).toEqual([
			"version:GPT-5.6",
			"version:13 9343",
		]);
	});

	it("reads an English ordinal as an ordinal", () => {
		expect(kinds("France took 3rd place.")).toEqual(["ordinal:3rd"]);
	});

	it("still reads a quantity written against its unit", () => {
		expect(kinds("The EU added 65.1 GW.")).toEqual(["number:65.1 GW"]);
	});

	it("does not mistake a currency prefix for a version token", () => {
		// "EUR2" is letters against digits, but the prefix is a unit, so the run
		// stays a quantity rather than being written off as a model name.
		expect(kinds("The cost was EUR2,500 per unit.")).toEqual(["number:2,500"]);
	});

	it("keeps a quantity that follows a year in the same sentence", () => {
		expect(kinds("In 2024 the EU added 62.8 GW.")).toEqual([
			"year:2024",
			"number:62.8 GW",
		]);
	});
});

describe("figureAppearsInText (separator and spacing variants)", () => {
	it("treats 65.1 GW, 65,1 GW and 65.1GW as the same figure", () => {
		const figure = extractFigures("The EU added 65.1 GW.")[0];
		expect(figureAppearsInText(figure, "az EU 65,1 GW-ot telepitett")).toBe(
			true,
		);
		expect(figureAppearsInText(figure, "the EU added 65.1GW")).toBe(true);
		expect(figureAppearsInText(figure, "the EU added 65 100 MW")).toBe(true);
	});
});

describe("findUnsupportedFigures (closest figure)", () => {
	it("names the closest figure the source does state", () => {
		const mismatches = findUnsupportedFigures({
			sentence: "The EU added 65.1 GW.",
			sourceText:
				"The EU added 62.8 GW in that year, against 406 GW installed.",
			sourceNumber: 7,
		});
		expect(mismatches).toHaveLength(1);
		expect(mismatches[0].detail).toContain("62.8 GW");
		expect(mismatches[0].detail).toContain("[7]");
	});

	it("does not report a year, a date, a version or an ordinal as unsupported", () => {
		expect(
			findUnsupportedFigures({
				sentence:
					"The Dell XPS 13 9343 shipped on January 21, 2026 and took 3rd place in 2025.",
				sourceText: "A laptop review with no numbers in it at all.",
				sourceNumber: 3,
			}),
		).toEqual([]);
	});
});
