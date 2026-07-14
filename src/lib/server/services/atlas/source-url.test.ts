import { describe, expect, it } from "vitest";
import { canonicalSourceUrlKey } from "./source-url";

describe("canonicalSourceUrlKey", () => {
	it("strips the URL hash/fragment", () => {
		expect(canonicalSourceUrlKey("https://example.com/page#section")).toBe(
			"https://example.com/page",
		);
	});

	it("sorts query parameters into a stable order", () => {
		expect(canonicalSourceUrlKey("https://example.com/p?b=2&a=1")).toBe(
			canonicalSourceUrlKey("https://example.com/p?a=1&b=2"),
		);
		expect(canonicalSourceUrlKey("https://example.com/p?b=2&a=1")).toBe(
			"https://example.com/p?a=1&b=2",
		);
	});

	it("strips trailing slashes", () => {
		expect(canonicalSourceUrlKey("https://example.com/page///")).toBe(
			"https://example.com/page",
		);
	});

	it("lowercases the whole key", () => {
		expect(canonicalSourceUrlKey("HTTPS://Example.COM/Path")).toBe(
			"https://example.com/path",
		);
	});

	it("treats hash-only and trailing-slash variants as the same source", () => {
		const a = canonicalSourceUrlKey("https://example.com/article/");
		const b = canonicalSourceUrlKey("https://example.com/article#top");
		expect(a).toBe(b);
	});

	it("falls back to trimmed normalization for malformed URLs", () => {
		expect(canonicalSourceUrlKey("  Not A URL/#frag  ")).toBe("not a url");
		expect(canonicalSourceUrlKey("relative/path/#x")).toBe("relative/path");
	});
});
