import { describe, expect, it } from "vitest";

import {
	researchWebInputSchema,
	sanitizeResearchWebInput,
} from "./research-web";

describe("researchWebInputSchema", () => {
	it("accepts a bare query", () => {
		const parsed = researchWebInputSchema.parse({ query: "widget price" });
		expect(parsed).toEqual({ query: "widget price" });
	});

	it("accepts the optional objective and searchQueries fields", () => {
		const parsed = researchWebInputSchema.parse({
			query: "widget price",
			objective: "Find the current retail price of the widget",
			searchQueries: ["widget price 2026", "widget retail cost"],
		});
		expect(parsed.objective).toBe(
			"Find the current retail price of the widget",
		);
		expect(parsed.searchQueries).toEqual([
			"widget price 2026",
			"widget retail cost",
		]);
	});

	it("rejects more than five search queries", () => {
		const result = researchWebInputSchema.safeParse({
			query: "q",
			searchQueries: ["a", "b", "c", "d", "e", "f"],
		});
		expect(result.success).toBe(false);
	});

	it("still requires query", () => {
		const result = researchWebInputSchema.safeParse({
			objective: "no query here",
		});
		expect(result.success).toBe(false);
	});
});

describe("sanitizeResearchWebInput", () => {
	it("trims the query and omits absent optional fields", () => {
		expect(sanitizeResearchWebInput({ query: "  widget price  " })).toEqual({
			query: "widget price",
		});
	});

	it("trims objective and each search query", () => {
		expect(
			sanitizeResearchWebInput({
				query: " widget ",
				objective: "  find the price  ",
				searchQueries: ["  widget price 2026 ", " widget cost"],
			}),
		).toEqual({
			query: "widget",
			objective: "find the price",
			searchQueries: ["widget price 2026", "widget cost"],
		});
	});

	it("drops empty search queries and omits searchQueries when all are empty", () => {
		expect(
			sanitizeResearchWebInput({
				query: "widget",
				searchQueries: ["  ", "widget cost", "   "],
			}),
		).toEqual({
			query: "widget",
			searchQueries: ["widget cost"],
		});
		expect(
			sanitizeResearchWebInput({
				query: "widget",
				searchQueries: ["   ", ""],
			}),
		).toEqual({ query: "widget" });
	});

	it("omits objective when it trims to empty", () => {
		expect(
			sanitizeResearchWebInput({ query: "widget", objective: "   " }),
		).toEqual({ query: "widget" });
	});
});
