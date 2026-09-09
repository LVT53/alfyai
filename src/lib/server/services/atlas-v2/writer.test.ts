import { describe, expect, it } from "vitest";
import type { AtlasV2IndexedSource } from "./types";
import {
	ATLAS_V2_PLAIN_TEXT_WRITER_SYSTEM,
	ATLAS_V2_WRITER_SYSTEM,
	buildAtlasV2SectionPrompt,
	buildWriterEvidenceEntries,
	countAtlasV2SectionSentences,
	parseAtlasV2PlainTextSection,
	parseAtlasV2WrittenSection,
	salvageAtlasV2WrittenSection,
	salvageTruncatedWriterJson,
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

	it("asks for a word target and never for an empty section", () => {
		for (const system of [
			ATLAS_V2_WRITER_SYSTEM.en,
			ATLAS_V2_WRITER_SYSTEM.hu,
		]) {
			expect(system).toContain("targetWords");
			expect(system).toContain("minSentences");
			expect(system).toContain("`paragraphs`");
		}
	});

	// The polish pass told the writer that a fact another section already
	// carried would be DELETED, and handed it a gist of every other section.
	// Sections then answered with nothing at all, and an empty body is a lost
	// section. Neither the instruction nor the gist list comes back.
	it("never tells the writer its material is deleted as a repeat", () => {
		for (const system of [
			ATLAS_V2_WRITER_SYSTEM.en,
			ATLAS_V2_WRITER_SYSTEM.hu,
		]) {
			expect(system).not.toContain("sectionsAlreadyWritten");
		}
	});
});

describe("buildAtlasV2SectionPrompt", () => {
	const section = {
		id: "s2",
		title: "Prices",
		brief: "What it costs",
		questionIds: ["q1"],
	};

	it("carries the word target and the sentence bounds", () => {
		const prompt = JSON.parse(
			buildAtlasV2SectionPrompt({
				query: "What does it cost?",
				profile: "overview",
				language: "en",
				currentDate: "2026-09-09",
				section,
				questions: [{ id: "q1", question: "What does it cost?" }],
				outline: [
					{ title: "Prices", brief: "What it costs" },
					{ title: "Rules", brief: "What governs it" },
				],
				evidence: [],
				targetWords: 250,
				minSentences: 10,
				maxSentences: 14,
			}),
		);
		expect(prompt.targetWords).toBe(250);
		expect(prompt.minSentences).toBe(10);
		expect(prompt.maxSentences).toBe(14);
		// The section never sees itself in the outline it is told to leave alone.
		expect(
			prompt.otherSections.map((entry: { title: string }) => entry.title),
		).toEqual(["Rules"]);
	});

	it("carries no gist of what other sections already said", () => {
		const prompt = JSON.parse(
			buildAtlasV2SectionPrompt({
				query: "What does it cost?",
				profile: "overview",
				language: "en",
				currentDate: "2026-09-09",
				section,
				questions: [],
				outline: [],
				evidence: [],
			}),
		);
		expect(prompt.sectionsAlreadyWritten).toBeUndefined();
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

describe("parseAtlasV2WrittenSection — length budget", () => {
	const long = JSON.stringify({
		paragraphs: Array.from({ length: 5 }, (_, paragraph) => ({
			sentences: Array.from({ length: 5 }, (_, position) => ({
				text: `Paragraph ${paragraph} sentence ${position} states something.`,
				citations: [1],
			})),
		})),
	});

	it("drops the sentences past the section's sentence budget", () => {
		const section = parseAtlasV2WrittenSection(long, {
			sectionId: "s1",
			title: "S",
			maxSourceNumber: 2,
			maxSentences: 6,
		});
		const sentences = section?.paragraphs.flatMap(
			(paragraph) => paragraph.sentences,
		);
		expect(sentences).toHaveLength(6);
	});

	it("drops the paragraphs past the paragraph budget", () => {
		const section = parseAtlasV2WrittenSection(long, {
			sectionId: "s1",
			title: "S",
			maxSourceNumber: 2,
			maxParagraphs: 2,
		});
		expect(section?.paragraphs).toHaveLength(2);
	});

	it("keeps everything when the section is inside its budget", () => {
		const section = parseAtlasV2WrittenSection(long, {
			sectionId: "s1",
			title: "S",
			maxSourceNumber: 2,
			maxSentences: 40,
		});
		expect(
			section?.paragraphs.flatMap((paragraph) => paragraph.sentences),
		).toHaveLength(25);
	});
});

describe("salvageTruncatedWriterJson", () => {
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
		expect(salvageTruncatedWriterJson(FULL)).toBe(FULL);
	});

	it("closes the object at the last clean cut, wherever the cut fell", () => {
		const salvagedCounts = new Set<number>();
		for (let cut = 1; cut < FULL.length; cut += 1) {
			const repaired = salvageTruncatedWriterJson(FULL.slice(0, cut));
			if (!repaired) continue;
			expect(() => JSON.parse(repaired)).not.toThrow();
			const section = parseAtlasV2WrittenSection(repaired, OPTIONS);
			if (section) salvagedCounts.add(countAtlasV2SectionSentences(section));
		}
		// 1, 2, 3 and all 4 sentences, as the cut moves right through the body.
		expect([...salvagedCounts].sort()).toEqual([1, 2, 3, 4]);
	});

	it("never publishes the half sentence the cut left behind", () => {
		const cut = FULL.indexOf("The queue is 40") + 8;
		const section = salvageAtlasV2WrittenSection(FULL.slice(0, cut), OPTIONS);
		expect(
			section?.paragraphs.flatMap((paragraph) =>
				paragraph.sentences.map((sentence) => sentence.text),
			),
		).toEqual(["Capacity reached 8 GW.", "Additions doubled in 2025."]);
	});

	it("gives back nothing when the cut fell before the first sentence closed", () => {
		expect(
			salvageTruncatedWriterJson('{"paragraphs":[{"sentences":[{"text":"Cap'),
		).toBeNull();
		expect(
			salvageTruncatedWriterJson("Thinking about the section..."),
		).toBeNull();
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
		const repaired = salvageTruncatedWriterJson(
			withBraces.slice(0, withBraces.length - 12),
		);
		expect(repaired).not.toBeNull();
		expect(() => JSON.parse(repaired as string)).not.toThrow();
		expect(
			parseAtlasV2WrittenSection(repaired as string, OPTIONS)?.paragraphs[0]
				.sentences[0].text,
		).toBe('The rule is "{ a } [b]" in the annex.');
	});
});

describe("parseAtlasV2PlainTextSection", () => {
	it("reads one sentence per line with its trailing citations", () => {
		const section = parseAtlasV2PlainTextSection(
			[
				"Capacity reached 8 GW in 2025. [1]",
				"Additions doubled year on year. [2][3]",
				"The picture is mixed across member states.",
			].join("\n"),
			OPTIONS,
		);
		expect(section?.paragraphs[0].sentences).toEqual([
			{
				text: "Capacity reached 8 GW in 2025.",
				citations: [1],
				inferred: false,
				calcId: null,
			},
			{
				text: "Additions doubled year on year.",
				citations: [2, 3],
				inferred: false,
				calcId: null,
			},
			{
				text: "The picture is mixed across member states.",
				citations: [],
				inferred: true,
				calcId: null,
			},
		]);
	});

	it("drops the last line when the answer was cut at the output cap", () => {
		// This is what makes the fallback the floor under `unparsable_body`: a
		// truncated plain-text answer is still a section, minus one line.
		const section = parseAtlasV2PlainTextSection(
			"Capacity reached 8 GW. [1]\nAdditions doubled in 20",
			{ ...OPTIONS, truncated: true },
		);
		expect(countAtlasV2SectionSentences(section)).toBe(1);
	});

	it("strips list markers and skips fences and stray braces", () => {
		const section = parseAtlasV2PlainTextSection(
			[
				"```",
				"- Capacity reached 8 GW. [1]",
				"}",
				"1. Grid costs rose. [2]",
			].join("\n"),
			OPTIONS,
		);
		expect(
			section?.paragraphs.flatMap((paragraph) =>
				paragraph.sentences.map((sentence) => sentence.text),
			),
		).toEqual(["Capacity reached 8 GW.", "Grid costs rose."]);
	});

	it("caps citations at two and drops numbers past the source list", () => {
		const section = parseAtlasV2PlainTextSection(
			"Capacity reached 8 GW. [1][2][3][40]",
			OPTIONS,
		);
		expect(section?.paragraphs[0].sentences[0].citations).toEqual([1, 2]);
	});

	it("returns null when there is no line to read", () => {
		expect(parseAtlasV2PlainTextSection("   \n\n", OPTIONS)).toBeNull();
	});

	it("asks for one sentence per line and trailing brackets in both languages", () => {
		for (const system of [
			ATLAS_V2_PLAIN_TEXT_WRITER_SYSTEM.en,
			ATLAS_V2_PLAIN_TEXT_WRITER_SYSTEM.hu,
		]) {
			expect(system).toContain("[3]");
		}
		expect(ATLAS_V2_PLAIN_TEXT_WRITER_SYSTEM.en).toContain(
			"ONE sentence per line",
		);
	});
});
