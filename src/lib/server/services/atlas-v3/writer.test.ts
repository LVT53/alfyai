import { describe, expect, it } from "vitest";
import { atlasV3SectionBudget, getAtlasV3ProfileConfig } from "./config";
import {
	addAtlasV3Quote,
	addAtlasV3Source,
	createAtlasV3Bank,
	freezeAtlasV3Bank,
} from "./evidence-bank";
import { fakeModel } from "./test-support";
import type {
	AtlasV3AnswerTable,
	AtlasV3Ask,
	AtlasV3Outline,
	AtlasV3Sentence,
	AtlasV3WrittenSection,
} from "./types";
import {
	ATLAS_V3_ABSTENTION_SENTENCE,
	atlasV3VerdictAnswersInWindow,
	atlasV3WriterSystem,
	buildAtlasV3SectionPrompt,
	buildAtlasV3VerdictPrompt,
	cleanSentenceText,
	countAtlasV3Sentences,
	deterministicAtlasV3Verdict,
	dropAtlasV3DanglingAnaphora,
	parseAtlasV3PlainTextSection,
	parseAtlasV3Section,
	parseAtlasV3Verdict,
	salvageAtlasV3Section,
	writeAtlasV3Report,
	writeAtlasV3Verdict,
} from "./writer";

const ASK: AtlasV3Ask = {
	decision: "d",
	implicitRequirements: [],
	perspectives: [],
	shape: "comparison",
	coreQuestion: "EU solar 2025 versus 2024",
	title: "t",
	subQuestions: [],
};

function bank() {
	const state = createAtlasV3Bank();
	const iea = addAtlasV3Source(state, {
		url: "https://iea.org/a",
		title: "IEA",
		publishedAt: "2025-12-01",
	});
	const bbc = addAtlasV3Source(state, {
		url: "https://bbc.com/a",
		title: "BBC",
		publishedAt: "2025-12-02",
	});
	addAtlasV3Quote(state, {
		sourceId: iea?.id ?? "",
		text: "The EU added 65.1 GW of solar capacity in 2025, the first fall since 2016.",
		goal: "g",
	});
	addAtlasV3Quote(state, {
		sourceId: bbc?.id ?? "",
		text: "Europe installed 65.1 GW of solar last year, according to industry data.",
		goal: "g",
	});
	addAtlasV3Quote(state, {
		sourceId: iea?.id ?? "",
		text: "Rooftop installations fell 21% while utility-scale capacity grew.",
		goal: "g",
	});
	return freezeAtlasV3Bank(state);
}

const OUTLINE: AtlasV3Outline = {
	nodes: [
		{
			id: "n1",
			title: "EU solar additions fell in 2025",
			claim: "The EU added less solar in 2025 than in 2024.",
			needs: [],
			evidenceIds: ["e1", "e2"],
			status: "ready",
		},
		{
			id: "n2",
			title: "Rooftop demand drove the fall",
			claim: "Rooftop demand drove the fall.",
			needs: [],
			evidenceIds: ["e3"],
			status: "ready",
		},
	],
	cut: [],
};

const TABLE: AtlasV3AnswerTable = {
	kind: "comparison",
	title: "EU solar additions",
	columns: [
		{ key: "year", label: "Year" },
		{ key: "additions", label: "Additions" },
	],
	rows: [
		{
			year: { text: "2025", evidenceIds: [] },
			additions: { text: "65.1 GW", evidenceIds: ["e1"] },
		},
	],
	derived: [
		{
			id: "k1",
			label: "Change",
			expression: "(65.1-65.6)/65.6*100",
			inputs: ["e1"],
			value: "-0.76",
		},
	],
};

const budget = atlasV3SectionBudget({
	config: getAtlasV3ProfileConfig("overview"),
	sectionCount: 2,
});

function sectionAnswer(text: string, evidenceIds: string[], extra = {}) {
	return JSON.stringify({
		paragraphs: [
			{ sentences: [{ text, evidenceIds, kind: "claim", calcId: null }] },
		],
		...extra,
	});
}

describe("parseAtlasV3Section", () => {
	const options = {
		nodeId: "n1",
		title: "t",
		knownEvidenceIds: ["e1", "e2"],
		knownCalcIds: ["k1"],
		maxSentences: 6,
		maxParagraphs: 3,
	};

	it("reads sentences and keeps only evidence ids the bank holds", () => {
		const parsed = parseAtlasV3Section(
			sectionAnswer("The EU added 65.1 GW in 2025.", ["e1", "e99", "e2"]),
			options,
		);
		expect(parsed?.section.paragraphs[0][0].evidenceIds).toEqual(["e1", "e2"]);
	});

	it("strips a bracketed number and a URL the writer should never have typed", () => {
		const parsed = parseAtlasV3Section(
			sectionAnswer("The EU added 65.1 GW [2] see https://iea.org/a .", ["e1"]),
			options,
		);
		expect(parsed?.section.paragraphs[0][0].text).toBe(
			"The EU added 65.1 GW see.",
		);
	});

	it("keeps a calcId only when the answer table declared it", () => {
		const withCalc = JSON.stringify({
			paragraphs: [
				{
					sentences: [
						{
							text: "It fell 0.76%.",
							evidenceIds: [],
							kind: "synthesis",
							calcId: "k1",
						},
						{
							text: "It rose 5%.",
							evidenceIds: [],
							kind: "synthesis",
							calcId: "k9",
						},
					],
				},
			],
		});
		const parsed = parseAtlasV3Section(withCalc, options);
		expect(parsed?.section.paragraphs[0][0].calcId).toBe("k1");
		expect(parsed?.section.paragraphs[0][1].calcId).toBeNull();
	});

	it("infers synthesis from several ids when the model gave no kind", () => {
		const parsed = parseAtlasV3Section(
			JSON.stringify({
				paragraphs: [
					{
						sentences: [
							{
								text: "Two trackers agree on 65.1 GW.",
								evidenceIds: ["e1", "e2"],
							},
						],
					},
				],
			}),
			options,
		);
		expect(parsed?.section.paragraphs[0][0].kind).toBe("synthesis");
	});

	it("honours the sentence and paragraph budget", () => {
		const many = JSON.stringify({
			paragraphs: Array.from({ length: 5 }, () => ({
				sentences: Array.from({ length: 4 }, (_u, index) => ({
					text: `Sentence ${index} with 65.1 GW.`,
					evidenceIds: ["e1"],
				})),
			})),
		});
		const parsed = parseAtlasV3Section(many, options);
		expect(countAtlasV3Sentences(parsed?.section ?? null)).toBe(6);
		expect(parsed?.section.paragraphs.length).toBeLessThanOrEqual(3);
	});

	it("reads the answer-table claim", () => {
		const parsed = parseAtlasV3Section(
			sectionAnswer("x 65.1 GW", ["e1"], { showAnswerTable: true }),
			options,
		);
		expect(parsed?.showAnswerTable).toBe(true);
	});

	it("returns null when nothing parses", () => {
		expect(parseAtlasV3Section("sorry", options)).toBeNull();
		expect(
			parseAtlasV3Section(JSON.stringify({ paragraphs: [] }), options),
		).toBeNull();
	});
});

describe("salvageAtlasV3Section", () => {
	it("repairs a body the output cap cut in half", () => {
		const truncated =
			'{"paragraphs":[{"sentences":[{"text":"The EU added 65.1 GW in 2025.","evidenceIds":["e1"]},{"text":"Rooftop fel';
		const parsed = salvageAtlasV3Section(truncated, {
			nodeId: "n1",
			title: "t",
			knownEvidenceIds: ["e1"],
			maxSentences: 6,
			maxParagraphs: 3,
		});
		expect(countAtlasV3Sentences(parsed?.section ?? null)).toBe(1);
	});
});

describe("parseAtlasV3PlainTextSection", () => {
	const options = {
		nodeId: "n1",
		title: "t",
		knownEvidenceIds: ["e1", "e3"],
		maxSentences: 6,
		maxParagraphs: 2,
	};

	it("reads one sentence per line with its trailing ids", () => {
		const section = parseAtlasV3PlainTextSection(
			[
				"The EU added 65.1 GW of solar in 2025. {e1}",
				"- Rooftop installations fell 21%. {e3,e9}",
				"```",
			].join("\n"),
			options,
		);
		expect(section?.paragraphs.flat()).toHaveLength(2);
		expect(section?.paragraphs.flat()[1].evidenceIds).toEqual(["e3"]);
	});

	it("drops the fragment a truncated answer left behind", () => {
		const section = parseAtlasV3PlainTextSection(
			["Full sentence. {e1}", "Half a sen"].join("\n"),
			{ ...options, truncated: true },
		);
		expect(section?.paragraphs.flat()).toHaveLength(1);
	});

	it("returns null with nothing usable", () => {
		expect(parseAtlasV3PlainTextSection("```\n{\n}", options)).toBeNull();
	});
});

describe("cleanSentenceText", () => {
	it("removes citation markers, URLs and evidence braces", () => {
		expect(
			cleanSentenceText("The EU added 65.1 GW [2][7] {e1} https://x.example ."),
		).toBe("The EU added 65.1 GW.");
	});

	it("returns empty for a non-string", () => {
		expect(cleanSentenceText(42)).toBe("");
	});
});

describe("writeAtlasV3Report", () => {
	function base(model: ReturnType<typeof fakeModel>) {
		return {
			ask: ASK,
			outline: OUTLINE,
			answerTable: TABLE,
			bank: bank(),
			language: "en" as const,
			currentDate: "2026-09-10",
			budget,
			maxEvidencePerSection: 12,
			runModel: model.call,
		};
	}

	it("writes every section and shows each only its own evidence", async () => {
		const model = fakeModel({
			"v3:write": sectionAnswer("The EU added 65.1 GW in 2025.", ["e1"]),
		});
		const result = await writeAtlasV3Report(base(model));
		expect(result.sections.map((section) => section.nodeId)).toEqual([
			"n1",
			"n2",
		]);
		const first = JSON.parse(
			model.prompts.find((entry) => entry.stage === "v3:write:n1")?.prompt ??
				"{}",
		);
		const second = JSON.parse(
			model.prompts.find((entry) => entry.stage === "v3:write:n2")?.prompt ??
				"{}",
		);
		expect(first.evidence.map((entry: { id: string }) => entry.id)).toEqual([
			"e1",
			"e2",
		]);
		expect(second.evidence.map((entry: { id: string }) => entry.id)).toEqual([
			"e3",
		]);
	});

	it("shows a section what the previous sections already said", async () => {
		const model = fakeModel({
			"v3:write": sectionAnswer("The EU added 65.1 GW in 2025.", ["e1"]),
		});
		await writeAtlasV3Report(base(model));
		const second = JSON.parse(
			model.prompts.find((entry) => entry.stage === "v3:write:n2")?.prompt ??
				"{}",
		);
		expect(second.alreadyWritten).toHaveLength(1);
		expect(second.alreadyWritten[0].sentences[0]).toContain("65.1 GW");
	});

	it("attaches the answer table to the section that claims it", async () => {
		const model = fakeModel({
			"v3:write:n1": sectionAnswer("a 65.1 GW", ["e1"]),
			"v3:write:n2": sectionAnswer("b 21%", ["e3"], { showAnswerTable: true }),
		});
		const result = await writeAtlasV3Report(base(model));
		expect(result.sections[0].table).toBeNull();
		expect(result.sections[1].table?.title).toBe("EU solar additions");
	});

	it("gives the table to the first section when nobody claims it", async () => {
		const model = fakeModel({
			"v3:write": sectionAnswer("a 65.1 GW", ["e1"]),
		});
		const result = await writeAtlasV3Report(base(model));
		expect(result.sections[0].table?.title).toBe("EU solar additions");
		expect(result.sections[1].table).toBeNull();
	});

	it("salvages a runaway rather than losing the section", async () => {
		const model = fakeModel(
			{
				"v3:write":
					'{"paragraphs":[{"sentences":[{"text":"One 65.1 GW.","evidenceIds":["e1"]},{"text":"Two 21%.","evidenceIds":["e1"]},{"text":"Thr',
			},
			{ finishReason: "length" },
		);
		const result = await writeAtlasV3Report(base(model));
		expect(result.runaways.length).toBeGreaterThan(0);
		expect(result.runaways.salvaged).toBeGreaterThan(0);
		expect(result.sections).toHaveLength(2);
	});

	it("falls back to plain text when both JSON attempts fail", async () => {
		const model = fakeModel({
			"v3:write:n1": "not json",
			"v3:write:plain:n1": "The EU added 65.1 GW in 2025. {e1}",
			"v3:write:n2": sectionAnswer("b 21%", ["e3"]),
		});
		const result = await writeAtlasV3Report(base(model));
		expect(result.runaways.fallback).toBe(1);
		expect(result.sections[0].paragraphs.flat()[0].text).toContain("65.1 GW");
	});

	it("records a node it could not write, with why", async () => {
		const model = fakeModel({
			"v3:write:n1": "no",
			"v3:write:plain:n1": "```",
			"v3:write:n2": sectionAnswer("b 21%", ["e3"]),
		});
		const result = await writeAtlasV3Report(base(model));
		expect(result.dropped[0].nodeId).toBe("n1");
		expect(result.sections).toHaveLength(1);
	});

	it("never writes a cut node and reports a node with no evidence", async () => {
		const model = fakeModel({
			"v3:write": sectionAnswer("a 65.1 GW", ["e1"]),
		});
		const result = await writeAtlasV3Report({
			...base(model),
			outline: {
				nodes: [
					{ ...OUTLINE.nodes[0], status: "cut" },
					{ ...OUTLINE.nodes[1], evidenceIds: [] },
				],
				cut: [],
			},
		});
		expect(result.sections).toEqual([]);
		expect(result.dropped).toEqual([{ nodeId: "n2", reason: "no_evidence" }]);
	});
});

describe("atlasV3WriterSystem", () => {
	it("appends the Hungarian register rules by default", () => {
		expect(atlasV3WriterSystem({ language: "hu" })).toContain("KSH");
	});

	it("omits them when the standard is off", () => {
		expect(
			atlasV3WriterSystem({ language: "hu", hungarianStandardEnabled: false }),
		).not.toContain("KSH");
	});
});

describe("buildAtlasV3SectionPrompt", () => {
	it("carries the budget and the answer table's computed values", () => {
		const parsed = JSON.parse(
			buildAtlasV3SectionPrompt({
				ask: ASK,
				node: OUTLINE.nodes[0],
				outline: OUTLINE,
				answerTable: TABLE,
				previousSections: [],
				evidence: [],
				language: "en",
				currentDate: "2026-09-10",
				budget,
				answerTableAvailable: true,
			}),
		);
		expect(parsed.budget.targetWords).toBe(budget.targetWords);
		expect(parsed.answerTable.derived[0].value).toBe("-0.76");
		expect(parsed.answerTable.available).toBe(true);
	});
});

describe("parseAtlasV3Verdict / writeAtlasV3Verdict", () => {
	const verdictInput = {
		ask: ASK,
		memo: {
			answerSoFar: "a",
			claimIds: [],
			openQuestions: [],
			deadEnds: [],
			budgetUsed: { searches: 1, pagesRead: 1, rounds: 1 },
		},
		answerTable: TABLE,
		sections: [],
		evidence: [],
		language: "en" as const,
		currentDate: "2026-09-10",
		abstain: false,
		limitations: [],
		bank: bank(),
	};

	it("reads a verdict and keeps only known ids", () => {
		const verdict = parseAtlasV3Verdict(
			JSON.stringify({
				sentences: [
					{ text: "The EU added 65.1 GW in 2025.", evidenceIds: ["e1", "e99"] },
				],
			}),
			{ knownEvidenceIds: ["e1"] },
		);
		expect(verdict?.[0].evidenceIds).toEqual(["e1"]);
	});

	it("accepts a paragraphs shape too", () => {
		const verdict = parseAtlasV3Verdict(
			JSON.stringify({
				paragraphs: [
					{
						sentences: [{ text: "The EU added 65.1 GW.", evidenceIds: ["e1"] }],
					},
				],
			}),
			{ knownEvidenceIds: ["e1"] },
		);
		expect(verdict).toHaveLength(1);
	});

	it("returns null rather than an empty verdict", async () => {
		const model = fakeModel({
			"v3:verdict": JSON.stringify({ sentences: [] }),
		});
		expect(
			await writeAtlasV3Verdict({ ...verdictInput, runModel: model.call }),
		).toBeNull();
	});

	it("salvages a verdict cut off at the cap", async () => {
		const model = fakeModel(
			{
				"v3:verdict":
					'{"sentences":[{"text":"The EU added 65.1 GW in 2025.","evidenceIds":["e1"]},{"text":"Roof',
			},
			{ finishReason: "length" },
		);
		const verdict = await writeAtlasV3Verdict({
			...verdictInput,
			runModel: model.call,
		});
		expect(verdict).toHaveLength(1);
	});

	it("returns null when the model throws", async () => {
		expect(
			await writeAtlasV3Verdict({
				...verdictInput,
				runModel: async () => {
					throw new Error("down");
				},
			}),
		).toBeNull();
	});

	it("retries once, with the shape restated, when the reply is not JSON", async () => {
		const model = fakeModel({
			"v3:verdict:retry": JSON.stringify({
				sentences: [
					{ text: "The EU added 65.1 GW in 2025.", evidenceIds: ["e1"] },
				],
			}),
			"v3:verdict": "Here is the verdict: the EU added 65.1 GW.",
		});
		const verdict = await writeAtlasV3Verdict({
			...verdictInput,
			runModel: model.call,
		});
		expect(verdict).toHaveLength(1);
		expect(model.stages).toEqual(["v3:verdict", "v3:verdict:retry"]);
		const retry = model.prompts.find(
			(entry) => entry.stage === "v3:verdict:retry",
		);
		expect(retry?.system).toContain("was not valid JSON");
	});

	it("carries doNotState into the prompt", () => {
		const prompt = buildAtlasV3VerdictPrompt({
			...verdictInput,
			doNotState: ["Providers face fines of up to 3%."],
		});
		expect(JSON.parse(prompt).doNotState).toEqual([
			"Providers face fines of up to 3%.",
		]);
	});
});

describe("deterministicAtlasV3Verdict", () => {
	const section = (
		nodeId: string,
		sentences: AtlasV3Sentence[],
	): AtlasV3WrittenSection => ({
		nodeId,
		title: nodeId,
		paragraphs: [sentences],
		table: null,
	});
	const claim = (
		text: string,
		evidenceIds: string[] = [],
	): AtlasV3Sentence => ({
		text,
		evidenceIds,
		kind: "claim",
		calcId: null,
	});

	it("takes the first cited figure of each section, in section order", () => {
		const verdict = deterministicAtlasV3Verdict({
			sections: [
				section("n1", [
					claim("This section looks at additions."),
					claim("The EU added 65.1 GW in 2025.", ["e1"]),
					claim("Two trackers agree.", ["e2"]),
				]),
				section("n2", [claim("Rooftop fell 21%.", ["e5"])]),
			],
			language: "en",
			abstain: false,
		});
		expect(verdict.map((sentence) => sentence.text)).toEqual([
			"The EU added 65.1 GW in 2025.",
			"Rooftop fell 21%.",
		]);
	});

	it("skips a figure no evidence id backs and caps at four sentences", () => {
		const verdict = deterministicAtlasV3Verdict({
			sections: [
				section("n0", [claim("It grew by 4% last year.")]),
				...["n1", "n2", "n3", "n4", "n5"].map((nodeId, index) =>
					section(nodeId, [claim(`Figure ${index} is 1${index}.`, ["e1"])]),
				),
			],
			language: "en",
			abstain: false,
		});
		expect(verdict).toHaveLength(4);
		expect(verdict[0].text).toBe("Figure 0 is 10.");
	});

	it("opens with an abstention sentence when the goal test abstained", () => {
		const verdict = deterministicAtlasV3Verdict({
			sections: [section("n1", [claim("Rooftop fell 21%.", ["e5"])])],
			language: "hu",
			abstain: true,
		});
		expect(verdict[0].text).toBe(ATLAS_V3_ABSTENTION_SENTENCE.hu);
		expect(verdict).toHaveLength(2);
	});

	it("returns nothing when no sentence carries a cited figure", () => {
		expect(
			deterministicAtlasV3Verdict({
				sections: [section("n1", [claim("Prices moved.")])],
				language: "en",
				abstain: false,
			}),
		).toEqual([]);
	});
});

describe("dropAtlasV3DanglingAnaphora", () => {
	const kept = (text: string) => ({ text });

	it("drops a survivor whose predecessor was cut and which refers back", () => {
		const written = [
			{ text: "Providers face six core duties under Article 53." },
			{ text: "These core duties include technical documentation." },
		];
		expect(
			dropAtlasV3DanglingAnaphora({
				written,
				kept: [
					kept("These core duties include technical documentation."),
					kept("The Act applies from 2 August 2026."),
				],
				language: "en",
			}).map((sentence) => sentence.text),
		).toEqual(["The Act applies from 2 August 2026."]);
	});

	it("keeps a survivor whose predecessor survived", () => {
		const written = [
			{ text: "Providers face six core duties under Article 53." },
			{ text: "These core duties include technical documentation." },
		];
		expect(
			dropAtlasV3DanglingAnaphora({
				written,
				kept: written.map((sentence) => kept(sentence.text)),
				language: "en",
			}),
		).toHaveLength(2);
	});

	it("never returns an empty verdict", () => {
		const written = [
			{ text: "The rate rose." },
			{ text: "Ez a rendelet 2026-ban lép hatályba." },
		];
		expect(
			dropAtlasV3DanglingAnaphora({
				written,
				kept: [kept("Ez a rendelet 2026-ban lép hatályba.")],
				language: "hu",
			}),
		).toHaveLength(1);
	});
});

describe("atlasV3VerdictAnswersInWindow", () => {
	const sentence = (
		text: string,
		evidenceIds: string[] = [],
		calcId: string | null = null,
	): AtlasV3Sentence => ({ text, evidenceIds, kind: "synthesis", calcId });

	it("passes when the first sentence carries a cited figure", () => {
		expect(
			atlasV3VerdictAnswersInWindow({
				verdict: [sentence("The EU added 65.1 GW in 2025.", ["e1"])],
			}),
		).toBe(true);
	});

	it("passes on a computed figure with no evidence id", () => {
		expect(
			atlasV3VerdictAnswersInWindow({
				verdict: [sentence("That is a 0.76% fall.", [], "k1")],
			}),
		).toBe(true);
	});

	it("fails on v2's opening: a topic sentence with no figure", () => {
		expect(
			atlasV3VerdictAnswersInWindow({
				verdict: [
					sentence(
						"Warranty structures fundamentally shape the self-repair landscape for these premium ultrabooks.",
					),
				],
			}),
		).toBe(false);
	});

	it("fails when the answer arrives after the window", () => {
		const filler = sentence("word ".repeat(80).trim());
		expect(
			atlasV3VerdictAnswersInWindow({
				verdict: [filler, sentence("It was 65.1 GW.", ["e1"])],
				windowWords: 60,
			}),
		).toBe(false);
	});
});
