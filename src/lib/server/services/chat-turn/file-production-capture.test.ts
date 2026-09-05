import { describe, expect, it } from "vitest";

import { looksLikeFileProductionLeak } from "./file-production-capture";

describe("looksLikeFileProductionLeak", () => {
	it("hides document JSON and tool-call fragments", () => {
		expect(
			looksLikeFileProductionLeak(
				'{"requestTitle":"Brief","documentSource":{"blocks":[{"type":"heading"}]}}',
			),
		).toBe(true);
		expect(looksLikeFileProductionLeak('```json\n{"blocks": []}\n```')).toBe(
			true,
		);
		expect(
			looksLikeFileProductionLeak('"sourceMode": "document_source",'),
		).toBe(true);
		expect(
			looksLikeFileProductionLeak('[{"type":"paragraph","text":"x"}]'),
		).toBe(true);
		expect(looksLikeFileProductionLeak("   ")).toBe(true);
	});

	it("hides repair narration about the document JSON", () => {
		expect(
			looksLikeFileProductionLeak(
				"Let me fix the documentSource JSON and retry the call.",
			),
		).toBe(true);
		expect(
			looksLikeFileProductionLeak("I'll correct the schema formatting now."),
		).toBe(true);
	});

	it("keeps ordinary answer text visible, including headings and charts", () => {
		expect(
			looksLikeFileProductionLeak(
				[
					"## 30g pouch prices in Limerick",
					"```",
					"Riverstone       ████████████████████░░░░░░░  €24.25",
					"Amber Leaf       ███████████████████████░░░░  €27.10",
					"```",
					"The whole brand range fits inside €3.",
				].join("\n"),
			),
		).toBe(false);
		expect(
			looksLikeFileProductionLeak(
				"Building both now — charts inline here, and a PDF version of the same dataset.",
			),
		).toBe(false);
		expect(
			looksLikeFileProductionLeak(
				'The PDF (`ireland-tobacco-travel-brief.pdf`) mirrors all of this: price tables and the "no allowance limit" note.',
			),
		).toBe(false);
	});
});
