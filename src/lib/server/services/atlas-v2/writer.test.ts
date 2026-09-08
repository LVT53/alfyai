import { describe, expect, it } from "vitest";
import type { AtlasV2IndexedSource } from "./types";
import {
	ATLAS_V2_WRITER_SYSTEM,
	buildWriterEvidenceEntries,
	parseAtlasV2WrittenSection,
} from "./writer";

const OPTIONS = { sectionId: "s1", title: "Capacity", maxSourceNumber: 9 };

describe("ATLAS_V2_WRITER_SYSTEM", () => {
	it("forbids the citation marker in the sentence text and forbids basis prose", () => {
		expect(ATLAS_V2_WRITER_SYSTEM.en).toContain(
			"Do NOT put the citation marker",
		);
		expect(ATLAS_V2_WRITER_SYSTEM.en).toContain("'basis'");
		expect(ATLAS_V2_WRITER_SYSTEM.hu).toContain("basis");
	});
});

describe("parseAtlasV2WrittenSection", () => {
	it("reads paragraphs of sentences with their citations", () => {
		const section = parseAtlasV2WrittenSection(
			JSON.stringify({
				paragraphs: [
					{
						sentences: [
							{ text: "Capacity reached 8 GW.", citations: [3, 7] },
							{ text: "Growth slowed in Q2.", citations: [3] },
						],
					},
				],
			}),
			OPTIONS,
		);
		expect(section?.paragraphs[0].sentences).toEqual([
			{
				text: "Capacity reached 8 GW.",
				citations: [3, 7],
				inferred: false,
				calcId: null,
			},
			{
				text: "Growth slowed in Q2.",
				citations: [3],
				inferred: false,
				calcId: null,
			},
		]);
	});

	it("strips a citation marker the writer wrote into the text anyway", () => {
		const section = parseAtlasV2WrittenSection(
			JSON.stringify({
				paragraphs: [
					{
						sentences: [
							{ text: "Capacity reached 8 GW [3].", citations: [3] },
							{ text: "Rules tightened [source 4].", citations: [4] },
						],
					},
				],
			}),
			OPTIONS,
		);
		expect(section?.paragraphs[0].sentences[0].text).toBe(
			"Capacity reached 8 GW.",
		);
		expect(section?.paragraphs[0].sentences[1].text).toBe("Rules tightened.");
	});

	it("drops a citation number no source has", () => {
		const section = parseAtlasV2WrittenSection(
			JSON.stringify({
				paragraphs: [
					{ sentences: [{ text: "A claim.", citations: [3, 40, 0, -1] }] },
				],
			}),
			OPTIONS,
		);
		expect(section?.paragraphs[0].sentences[0].citations).toEqual([3]);
	});

	it("only honours `inferred` when the sentence cites nothing", () => {
		const section = parseAtlasV2WrittenSection(
			JSON.stringify({
				paragraphs: [
					{
						sentences: [
							{ text: "Hedged synthesis.", citations: [], inferred: true },
							{ text: "Sourced claim.", citations: [3], inferred: true },
						],
					},
				],
			}),
			OPTIONS,
		);
		expect(section?.paragraphs[0].sentences[0].inferred).toBe(true);
		expect(section?.paragraphs[0].sentences[1].inferred).toBe(false);
	});

	it("keeps a calcId only when the calculation exists", () => {
		const section = parseAtlasV2WrittenSection(
			JSON.stringify({
				paragraphs: [
					{
						sentences: [
							{ text: "That is 67%.", citations: [3], calcId: "c1" },
							{ text: "That is 12%.", citations: [3], calcId: "ghost" },
						],
					},
				],
				calculations: [{ id: "c1", expression: "8/12*100", inputs: [3] }],
			}),
			OPTIONS,
		);
		expect(section?.calculations).toEqual([
			{ id: "c1", expression: "8/12*100", inputs: [3] },
		]);
		expect(section?.paragraphs[0].sentences[0].calcId).toBe("c1");
		expect(section?.paragraphs[0].sentences[1].calcId).toBeNull();
	});

	it("accepts a bare array of strings as one paragraph", () => {
		const section = parseAtlasV2WrittenSection(
			JSON.stringify({ paragraphs: [["A claim.", "Another claim."]] }),
			OPTIONS,
		);
		expect(section?.paragraphs[0].sentences).toHaveLength(2);
		expect(section?.paragraphs[0].sentences[0].citations).toEqual([]);
	});

	it("returns null when nothing usable came back", () => {
		expect(parseAtlasV2WrittenSection("sorry, I cannot", OPTIONS)).toBeNull();
		expect(
			parseAtlasV2WrittenSection(JSON.stringify({ paragraphs: [] }), OPTIONS),
		).toBeNull();
	});
});

describe("buildWriterEvidenceEntries", () => {
	function source(n: number): AtlasV2IndexedSource {
		return {
			n,
			canonicalUrl: `https://s${n}.example/a`,
			host: `s${n}.example`,
			organisation: `s${n}.example`,
			title: `Report ${n}`,
			date: "2026-04-01",
			snippets: [`Snippet ${n}`],
			pageExcerpt: `Page text ${n}`,
			questionIds: ["q1"],
		};
	}

	it("caps the entry count and joins snippets with the page excerpt", () => {
		const entries = buildWriterEvidenceEntries(
			[source(1), source(2), source(3)],
			2,
		);
		expect(entries.map((entry) => entry.n)).toEqual([1, 2]);
		expect(entries[0].text).toContain("Snippet 1");
		expect(entries[0].text).toContain("Page text 1");
	});
});
