import { describe, expect, it } from "vitest";

import {
	type FetchUrlInput,
	fetchUrlInputSchema,
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
