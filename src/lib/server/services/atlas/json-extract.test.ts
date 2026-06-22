import { describe, expect, it } from "vitest";
import { parseJsonFromText } from "./json-extract";

describe("parseJsonFromText", () => {
	// ── Existing valid JSON ──────────────────────────────────────

	it("parses a simple valid JSON object", () => {
		const result = parseJsonFromText('{"key": "value"}');
		expect(result).toEqual({ key: "value" });
	});

	it("parses a valid JSON array", () => {
		const result = parseJsonFromText("[1, 2, 3]");
		expect(result).toEqual([1, 2, 3]);
	});

	it("parses nested valid JSON", () => {
		const result = parseJsonFromText('{"a": {"b": [1, 2]}}');
		expect(result).toEqual({ a: { b: [1, 2] } });
	});

	it("parses valid JSON with null, boolean, and number values", () => {
		const result = parseJsonFromText(
			JSON.stringify({ str: "hello", num: 42, flag: true, n: null }),
		);
		expect(result).toEqual({ str: "hello", num: 42, flag: true, n: null });
	});

	// ── Trailing commas ──────────────────────────────────────────

	it("handles trailing comma in object", () => {
		const result = parseJsonFromText('{"key": "value",}');
		expect(result).toEqual({ key: "value" });
	});

	it("handles trailing comma in array", () => {
		const result = parseJsonFromText('{"items": [1, 2, 3,]}');
		expect(result).toEqual({ items: [1, 2, 3] });
	});

	it("handles trailing comma in nested object", () => {
		const result = parseJsonFromText('{"outer": {"inner": "val",},}');
		expect(result).toEqual({ outer: { inner: "val" } });
	});

	it("handles multiple trailing commas in mixed structure", () => {
		const result = parseJsonFromText('{"a": [1, 2,], "b": {"c": "d",},}');
		expect(result).toEqual({ a: [1, 2], b: { c: "d" } });
	});

	// ── Preamble text ────────────────────────────────────────────

	it("extracts JSON from text with leading preamble", () => {
		const result = parseJsonFromText('Here is the data:\n{"claimBasis": []}');
		expect(result).toEqual({ claimBasis: [] });
	});

	it("extracts JSON from text with trailing text after JSON", () => {
		const result = parseJsonFromText(
			'{"key": "value"}\nSome trailing explanation.',
		);
		expect(result).toEqual({ key: "value" });
	});

	it("extracts JSON from text with preamble and trailing text", () => {
		const result = parseJsonFromText(
			'Here is the result:\n{"key": "value"}\nEnd of output.',
		);
		expect(result).toEqual({ key: "value" });
	});

	// ── Fenced JSON ──────────────────────────────────────────────

	it("extracts JSON from fenced code block with leading text", () => {
		const result = parseJsonFromText(
			'Based on evidence:\n```json\n{"claimBasis": [{"supportLevel": "supported"}]}\n```',
		);
		expect(result).toEqual({ claimBasis: [{ supportLevel: "supported" }] });
	});

	it("extracts JSON from fenced code block without language tag", () => {
		const result = parseJsonFromText('Result:\n```\n{"key": "value"}\n```');
		expect(result).toEqual({ key: "value" });
	});

	it("prefers fenced JSON over preamble text that contains braces", () => {
		const result = parseJsonFromText(
			'Some {text} with braces\n```json\n{"key": "value"}\n```',
		);
		expect(result).toEqual({ key: "value" });
	});

	// ── Single-quoted keys and values ────────────────────────────

	it("handles single-quoted keys", () => {
		const result = parseJsonFromText("{'key': 'value'}");
		expect(result).toEqual({ key: "value" });
	});

	it("handles mixed single and double quotes", () => {
		const result = parseJsonFromText("{\"key\": 'value'}");
		expect(result).toEqual({ key: "value" });
	});

	it("handles single-quoted nested JSON", () => {
		const result = parseJsonFromText("{'outer': {'inner': [1, 2, 3]}}");
		expect(result).toEqual({ outer: { inner: [1, 2, 3] } });
	});

	// ── Combined edge cases ──────────────────────────────────────

	it("handles trailing comma AND single quotes together", () => {
		const result = parseJsonFromText("{'key': 'value',}");
		expect(result).toEqual({ key: "value" });
	});

	it("handles preamble, trailing comma, and single quotes", () => {
		const result = parseJsonFromText("Output:\n{'items': [1, 2, 3,],}");
		expect(result).toEqual({ items: [1, 2, 3] });
	});

	// ── Largest balanced candidate heuristic ─────────────────────

	it("prefers larger balanced JSON candidate over smaller invalid one", () => {
		// The preamble contains {a} which is a balanced but useless pair.
		// The real JSON is much larger.
		const result = parseJsonFromText(
			'Some {small} text and then the real {"big": {"nested": "json", "array": [1, 2, 3]}}',
		);
		expect(result).toEqual({
			big: { nested: "json", array: [1, 2, 3] },
		});
	});

	it("selects the largest valid JSON when multiple candidates exist", () => {
		const text = `
Here is the summary: {"summary": "brief"}
And here is the full data: {"full": {"details": "very long content", "items": [1, 2, 3, 4, 5]}}
`;
		const result = parseJsonFromText(text);
		// Should prefer the larger/fuller JSON over the brief one
		expect(result).toEqual({
			full: { details: "very long content", items: [1, 2, 3, 4, 5] },
		});
	});

	// ── Error cases ──────────────────────────────────────────────

	it("returns null for empty string", () => {
		expect(parseJsonFromText("")).toBeNull();
	});

	it("returns null for whitespace-only string", () => {
		expect(parseJsonFromText("   \n  ")).toBeNull();
	});

	it("returns null for plain text without JSON", () => {
		expect(parseJsonFromText("this is not json at all")).toBeNull();
	});

	it("returns null for malformed JSON that cannot be recovered", () => {
		const result = parseJsonFromText('{"key": "unclosed string}');
		expect(result).toBeNull();
	});
});
