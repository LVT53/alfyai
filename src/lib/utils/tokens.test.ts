import { describe, expect, it } from "vitest";
import { estimateTokenCount } from "./tokens";

describe("estimateTokenCount", () => {
	it("returns 0 for empty or whitespace-only strings", () => {
		expect(estimateTokenCount("")).toBe(0);
		expect(estimateTokenCount("   ")).toBe(0);
		expect(estimateTokenCount("\n\t ")).toBe(0);
	});

	it("counts ASCII alphanumeric text at ~4 chars per token", () => {
		// 'hello' = 5 chars, ceil(5/4) = 2 tokens
		expect(estimateTokenCount("hello")).toBe(2);
		// 'hello world' splits into 'hello', 'world' (spaces skipped) → 2 + 2 = 4 tokens
		expect(estimateTokenCount("hello world")).toBe(4);
		// 20 chars → ceil(20/4) = 5 tokens
		expect(estimateTokenCount("abcdefghijklmnopqrst")).toBe(5);
	});

	it("counts short ASCII segments with minimum of 1 token", () => {
		// 1 char → max(1, ceil(1/4)) = 1
		expect(estimateTokenCount("a")).toBe(1);
		// 2 chars → max(1, ceil(2/4)) = 1
		expect(estimateTokenCount("hi")).toBe(1);
		// 3 chars → max(1, ceil(3/4)) = 1
		expect(estimateTokenCount("hey")).toBe(1);
		// 4 chars → ceil(4/4) = 1
		expect(estimateTokenCount("test")).toBe(1);
	});

	it("counts CJK and non-Latin scripts at ~2 chars per token", () => {
		// CJK: 4 chars → ceil(4/2) = 2 tokens (\p{L} recognises all Unicode letters)
		expect(estimateTokenCount("你好世界")).toBe(2);
		// Cyrillic: 6 chars → 3 tokens (letter/number class, ceil(6/2))
		expect(estimateTokenCount("привет")).toBe(3);
		// Arabic: 5 chars → 3 tokens (letter/number class, ceil(5/2))
		expect(estimateTokenCount("مرحبا")).toBe(3);
	});

	it("counts symbols and punctuation as 1 char per token", () => {
		// 12 punctuation characters → 12 tokens
		expect(estimateTokenCount(".,;:!?()[]{}")).toBe(12);
		// 5 hyphens → 5 tokens (punctuation, 1 char per token)
		expect(estimateTokenCount("-----")).toBe(5);
	});

	it("handles mixed content correctly", () => {
		// 'hello' (5 → 2) + '测试' (2 CJK chars → 1) = 3
		const mixed = "hello 测试";
		expect(estimateTokenCount(mixed)).toBe(3);
	});

	it("strips leading/trailing whitespace before counting", () => {
		// '  hello  ' → 'hello' = 2 tokens
		expect(estimateTokenCount("  hello  ")).toBe(2);
		expect(estimateTokenCount("\n\thello\n\t")).toBe(2);
	});
});
