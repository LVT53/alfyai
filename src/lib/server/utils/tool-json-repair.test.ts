import { describe, expect, it } from "vitest";

import { repairMalformedToolCallJson } from "./tool-json-repair";

describe("repairMalformedToolCallJson", () => {
	it("returns null for valid JSON input", () => {
		expect(
			repairMalformedToolCallJson('{"tool":"research_web","query":"x"}'),
		).toBeNull();
	});

	it("repairs missing closing brace", () => {
		expect(
			repairMalformedToolCallJson('{"tool":"research_web","query":"x"'),
		).toBe('{"tool":"research_web","query":"x"}');
	});

	it("repairs trailing punctuation after a JSON object", () => {
		expect(repairMalformedToolCallJson('{"tool":"research_web"}...')).toBe(
			'{"tool":"research_web"}',
		);
		expect(repairMalformedToolCallJson('{"tool":"research_web"} ,')).toBe(
			'{"tool":"research_web"}',
		);
	});

	it("returns null when JSON cannot be repaired", () => {
		expect(repairMalformedToolCallJson('{"tool":}')).toBeNull();
	});

	it("ignores UTF-8 BOM during repair", () => {
		expect(repairMalformedToolCallJson('\uFEFF{"tool":"done"}')).toBe(
			'{"tool":"done"}',
		);
	});
});
