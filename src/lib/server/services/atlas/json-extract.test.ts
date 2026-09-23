import { describe, expect, it } from "vitest";
import { parseJsonFromText, salvageTruncatedJson } from "./json-extract";

// Ported from atlas-v2/writer.test.ts's "salvageTruncatedWriterJson" cases
// (the function was copied here as `salvageTruncatedJson`). The v2 tests
// checked the repaired JSON through v2's own section parser
// (`parseAtlasV2WrittenSection`); this module has no such parser, so these
// cases read the repaired text back with plain `JSON.parse` instead.
describe("salvageTruncatedJson", () => {
	interface WriterSentence {
		text: string;
		citations?: number[];
		inferred?: boolean;
	}
	interface WriterBody {
		paragraphs: Array<{ sentences: WriterSentence[] }>;
		calculations?: Array<{ id: string; expression: string; inputs: number[] }>;
	}

	function sentenceTexts(body: WriterBody): string[] {
		return body.paragraphs.flatMap((paragraph) =>
			paragraph.sentences.map((sentence) => sentence.text),
		);
	}

	// The shape the local model produced when it ran to its output cap: valid
	// JSON up to the cut, rubble after. Cut at every point, so the repair is not
	// shown to work only where the cap happened to land once.
	const FULL = JSON.stringify({
		paragraphs: [
			{
				sentences: [
					{ text: "Capacity reached 8 GW.", citations: [1], inferred: false },
					{ text: "Additions doubled in 2025.", citations: [2, 3] },
					{ text: "The queue is 40 GW.", citations: [2] },
				],
			},
			{ sentences: [{ text: "Grid costs rose.", citations: [3] }] },
		],
		calculations: [{ id: "c1", expression: "8/12*100", inputs: [1] }],
	});

	it("returns a complete body unchanged", () => {
		expect(salvageTruncatedJson(FULL)).toBe(FULL);
	});

	it("closes the object at the last clean cut, wherever the cut fell", () => {
		const salvagedCounts = new Set<number>();
		for (let cut = 1; cut < FULL.length; cut += 1) {
			const repaired = salvageTruncatedJson(FULL.slice(0, cut));
			if (!repaired) continue;
			expect(() => JSON.parse(repaired)).not.toThrow();
			const body = JSON.parse(repaired) as WriterBody;
			salvagedCounts.add(sentenceTexts(body).length);
		}
		// 1, 2, 3 and all 4 sentences, as the cut moves right through the body.
		expect([...salvagedCounts].sort()).toEqual([1, 2, 3, 4]);
	});

	it("never publishes the half sentence the cut left behind", () => {
		const cut = FULL.indexOf("The queue is 40") + 8;
		const repaired = salvageTruncatedJson(FULL.slice(0, cut));
		expect(repaired).not.toBeNull();
		const body = JSON.parse(repaired as string) as WriterBody;
		expect(sentenceTexts(body)).toEqual([
			"Capacity reached 8 GW.",
			"Additions doubled in 2025.",
		]);
	});

	it("gives back nothing when the cut fell before the first sentence closed", () => {
		expect(
			salvageTruncatedJson('{"paragraphs":[{"sentences":[{"text":"Cap'),
		).toBeNull();
		expect(salvageTruncatedJson("Thinking about the section...")).toBeNull();
	});

	it("survives a brace or bracket inside a sentence's own text", () => {
		const withBraces = JSON.stringify({
			paragraphs: [
				{
					sentences: [
						{ text: 'The rule is "{ a } [b]" in the annex.', citations: [1] },
						{ text: "A second sentence.", citations: [2] },
					],
				},
			],
		});
		const repaired = salvageTruncatedJson(
			withBraces.slice(0, withBraces.length - 12),
		);
		expect(repaired).not.toBeNull();
		expect(() => JSON.parse(repaired as string)).not.toThrow();
		const body = JSON.parse(repaired as string) as WriterBody;
		expect(body.paragraphs[0].sentences[0].text).toBe(
			'The rule is "{ a } [b]" in the annex.',
		);
	});
});

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
