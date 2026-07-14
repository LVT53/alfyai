import { describe, expect, it } from "vitest";

import {
	type FetchUrlInput,
	fetchUrlInputSchema,
	resolveFetchContentCharCap,
	sanitizeFetchUrlInput,
} from "./fetch-url";

describe("fetchUrlInputSchema", () => {
	it("accepts a single url", () => {
		const result = fetchUrlInputSchema.safeParse({
			urls: ["https://a.com"],
		});
		expect(result.success).toBe(true);
	});

	it("accepts five urls with an objective", () => {
		const result = fetchUrlInputSchema.safeParse({
			urls: [
				"https://a.com",
				"https://b.com",
				"https://c.com",
				"https://d.com",
				"https://e.com",
			],
			objective: "x",
		});
		expect(result.success).toBe(true);
	});

	it("rejects an empty array", () => {
		const result = fetchUrlInputSchema.safeParse({ urls: [] });
		expect(result.success).toBe(false);
	});

	it("rejects more than five urls", () => {
		const result = fetchUrlInputSchema.safeParse({
			urls: [
				"https://a.com",
				"https://b.com",
				"https://c.com",
				"https://d.com",
				"https://e.com",
				"https://f.com",
			],
		});
		expect(result.success).toBe(false);
	});

	it("rejects non-url strings", () => {
		const result = fetchUrlInputSchema.safeParse({
			urls: ["not a url"],
		});
		expect(result.success).toBe(false);
	});
});

describe("sanitizeFetchUrlInput", () => {
	it("trims each url and drops empties", () => {
		const input: FetchUrlInput = {
			urls: ["  https://a.com  ", "   ", "https://b.com"],
		};
		expect(sanitizeFetchUrlInput(input)).toEqual({
			urls: ["https://a.com", "https://b.com"],
		});
	});

	it("dedupes duplicate urls case-insensitively", () => {
		const input: FetchUrlInput = {
			urls: ["https://a.com", "HTTPS://A.COM", "https://b.com"],
		};
		expect(sanitizeFetchUrlInput(input)).toEqual({
			urls: ["https://a.com", "https://b.com"],
		});
	});

	it("keeps case-distinct paths as separate resources (dedupes only origin case)", () => {
		const input: FetchUrlInput = {
			urls: [
				"https://example.com/Page",
				"https://example.com/page",
				// Same origin+path but host cased differently -> a duplicate of the first.
				"https://EXAMPLE.com/Page",
			],
		};
		expect(sanitizeFetchUrlInput(input)).toEqual({
			urls: ["https://example.com/Page", "https://example.com/page"],
		});
	});

	it("clamps more than five urls to five", () => {
		const input: FetchUrlInput = {
			urls: [
				"https://a.com",
				"https://b.com",
				"https://c.com",
				"https://d.com",
				"https://e.com",
				"https://f.com",
			],
		};
		expect(sanitizeFetchUrlInput(input).urls).toHaveLength(5);
	});

	it("keeps objective when present and non-empty", () => {
		const input: FetchUrlInput = {
			urls: ["https://a.com"],
			objective: "  find the price  ",
		};
		expect(sanitizeFetchUrlInput(input)).toEqual({
			urls: ["https://a.com"],
			objective: "find the price",
		});
	});

	it("drops objective when empty after trim", () => {
		const input: FetchUrlInput = {
			urls: ["https://a.com"],
			objective: "   ",
		};
		const result = sanitizeFetchUrlInput(input);
		expect(result).toEqual({ urls: ["https://a.com"] });
		expect("objective" in result).toBe(false);
	});

	it("drops objective when absent", () => {
		const input: FetchUrlInput = { urls: ["https://a.com"] };
		const result = sanitizeFetchUrlInput(input);
		expect("objective" in result).toBe(false);
	});
});

describe("resolveFetchContentCharCap", () => {
	it("clamps a small context window up to the floor", () => {
		// 4k tokens -> 4000 * 4 * 0.4 = 6400 chars, below the 20k floor.
		expect(resolveFetchContentCharCap(4_000)).toBe(20_000);
	});

	it("clamps a huge context window down to the ceiling", () => {
		// 1M tokens -> 1.6M chars, above the 200k ceiling.
		expect(resolveFetchContentCharCap(1_000_000)).toBe(200_000);
	});

	it("scales linearly for a mid-range context window", () => {
		// 64k tokens -> 64000 * 4 * 0.4 = 102400 chars, between the bounds.
		expect(resolveFetchContentCharCap(64_000)).toBe(102_400);
	});

	it("falls back to a safe default when the capacity is unknown", () => {
		expect(resolveFetchContentCharCap(undefined)).toBe(60_000);
		expect(resolveFetchContentCharCap(null)).toBe(60_000);
		expect(resolveFetchContentCharCap(0)).toBe(60_000);
	});
});
