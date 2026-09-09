import { describe, expect, it } from "vitest";
import type { AtlasV2IndexedSource } from "./types";
import {
	ATLAS_V2_SECTION_LEAD_SYSTEM,
	ATLAS_V2_WRITER_SYSTEM,
	buildAtlasV2SectionLeadPrompt,
	buildAtlasV2SectionPrompt,
	buildWriterEvidenceEntries,
	parseAtlasV2SectionLead,
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

	it("asks for a word target and forbids restating another section's fact", () => {
		for (const system of [
			ATLAS_V2_WRITER_SYSTEM.en,
			ATLAS_V2_WRITER_SYSTEM.hu,
		]) {
			expect(system).toContain("targetWords");
			expect(system).toContain("minSentences");
			expect(system).toContain("sectionsAlreadyWritten");
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

	it("carries the word target, the sentence bounds and the other sections' gists", () => {
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
				sectionsAlreadyWritten: [
					{ title: "Rules", gist: "Rules state a 30% ceiling." },
				],
			}),
		);
		expect(prompt.targetWords).toBe(250);
		expect(prompt.minSentences).toBe(10);
		expect(prompt.maxSentences).toBe(14);
		expect(prompt.sectionsAlreadyWritten[0].gist).toContain("30%");
		// The section never sees itself in either list.
		expect(
			prompt.otherSections.map((entry: { title: string }) => entry.title),
		).toEqual(["Rules"]);
	});

	it("omits the gist list entirely when no section has been written yet", () => {
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

describe("the section lead pass", () => {
	it("asks for one plain sentence naming the section's figures", () => {
		for (const system of [
			ATLAS_V2_SECTION_LEAD_SYSTEM.en,
			ATLAS_V2_SECTION_LEAD_SYSTEM.hu,
		]) {
			expect(system.toLowerCase()).toMatch(/one sentence|egyetlen/);
		}
	});

	it("sends a smaller slice of each source than a body call does", () => {
		const prompt = JSON.parse(
			buildAtlasV2SectionLeadPrompt({
				query: "How much was added?",
				language: "en",
				section: {
					id: "s1",
					title: "Capacity",
					brief: "How much",
					questionIds: ["q1"],
				},
				evidence: [
					{
						n: 1,
						title: "Report",
						host: "iea.org",
						date: null,
						text: "x".repeat(3000),
					},
				],
			}),
		);
		expect(prompt.evidence[0].text.length).toBe(700);
	});

	it("reads a bare sentence, a JSON string and a JSON object", () => {
		expect(parseAtlasV2SectionLead("The union added 65.1 GW in 2025.")).toBe(
			"The union added 65.1 GW in 2025.",
		);
		expect(parseAtlasV2SectionLead('"The union added 65.1 GW."')).toBe(
			"The union added 65.1 GW.",
		);
		expect(
			parseAtlasV2SectionLead(
				JSON.stringify({ gist: "Prices start at €999." }),
			),
		).toBe("Prices start at €999.");
	});

	it("returns null when the call came back empty", () => {
		expect(parseAtlasV2SectionLead("   ")).toBeNull();
	});

	it("returns null rather than a gist made of the model's own JSON", () => {
		expect(
			parseAtlasV2SectionLead(
				JSON.stringify({ paragraphs: [{ sentences: [{ text: "x" }] }] }),
			),
		).toBeNull();
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
