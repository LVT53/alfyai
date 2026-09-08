import { describe, expect, it } from "vitest";
import {
	competingFigures,
	extractFigures,
	figureAppearsInText,
	findUnsupportedFigures,
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
