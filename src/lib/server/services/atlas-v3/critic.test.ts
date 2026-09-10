import { describe, expect, it } from "vitest";
import {
	applyAtlasV3Cuts,
	atlasV3CriticSatisfied,
	atlasV3CriticSystem,
	atlasV3EvidenceQueries,
	atlasV3RewriteNodeIds,
	buildAtlasV3CriticPrompt,
	dedupeAtlasV3Findings,
	findAtlasV3DeterministicFindings,
	parseAtlasV3Findings,
	runAtlasV3Critic,
} from "./critic";
import {
	addAtlasV3Quote,
	addAtlasV3Source,
	createAtlasV3Bank,
	freezeAtlasV3Bank,
} from "./evidence-bank";
import { fakeModel } from "./test-support";
import type {
	AtlasV3Ask,
	AtlasV3Finding,
	AtlasV3Sentence,
	AtlasV3WrittenSection,
} from "./types";

const ASK: AtlasV3Ask = {
	decision: "d",
	implicitRequirements: ["EU-27, not Europe"],
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
		publishedAt: null,
	});
	addAtlasV3Quote(state, {
		sourceId: iea?.id ?? "",
		text: "The EU added 65.1 GW of solar capacity in 2025, industry data show.",
		goal: "g",
	});
	return freezeAtlasV3Bank(state);
}

function sentence(
	text: string,
	evidenceIds: string[] = [],
	calcId: string | null = null,
): AtlasV3Sentence {
	return { text, evidenceIds, kind: "claim", calcId };
}

function section(
	nodeId: string,
	sentences: AtlasV3Sentence[],
): AtlasV3WrittenSection {
	return {
		nodeId,
		title: `Section ${nodeId}`,
		paragraphs: [sentences],
		table: null,
	};
}

const HEALTHY = [
	section("n1", [
		sentence("The EU added 65.1 GW of solar in 2025.", ["e1"]),
		sentence("Rooftop demand carried the whole of the decline.", ["e1"]),
		sentence("Utility-scale capacity grew over the same period.", ["e1"]),
	]),
];

describe("findAtlasV3DeterministicFindings", () => {
	const base = {
		ask: ASK,
		bank: bank(),
		language: "en" as const,
		verdict: [sentence("The EU added 65.1 GW in 2025.", ["e1"])],
		verdictAnswers: true,
	};

	it("finds nothing in a healthy report", () => {
		expect(
			findAtlasV3DeterministicFindings({ ...base, sections: HEALTHY }),
		).toEqual([]);
	});

	it("flags a verdict that does not answer", () => {
		const findings = findAtlasV3DeterministicFindings({
			...base,
			sections: HEALTHY,
			verdictAnswers: false,
		});
		expect(findings[0].code).toBe("no_verdict");
		expect(findings[0].instruction.kind).toBe("rewrite");
	});

	it("catches the same claim in two sections", () => {
		const findings = findAtlasV3DeterministicFindings({
			...base,
			sections: [
				...HEALTHY,
				section("n2", [
					sentence(
						"SolarPower Europe reports the EU added 65.1 GW of solar in 2025.",
						["e1"],
					),
					sentence("Grid queues lengthened in three member states.", ["e1"]),
					sentence("Curtailment rose over the same window.", ["e1"]),
				]),
			],
		});
		expect(findings.some((finding) => finding.code === "repeated_claim")).toBe(
			true,
		);
		expect(
			findings.find((finding) => finding.code === "repeated_claim")?.instruction
				.kind,
		).toBe("cut");
	});

	it("catches a hollow sentence and asks for it to be cut", () => {
		const findings = findAtlasV3DeterministicFindings({
			...base,
			sections: [
				section("n1", [
					sentence(
						"Repairability scores highlight a clear trade-off between modularity and compact design.",
					),
					sentence("The EU added 65.1 GW of solar in 2025.", ["e1"]),
					sentence("Rooftop demand carried the decline.", ["e1"]),
				]),
			],
		});
		const hollow = findings.find(
			(finding) => finding.code === "hollow_sentence",
		);
		expect(hollow?.instruction.kind).toBe("cut");
	});

	it("asks for evidence when a figure has none", () => {
		const findings = findAtlasV3DeterministicFindings({
			...base,
			sections: [
				section("n1", [
					sentence("The EU added 65.1 GW of solar in 2025."),
					sentence("Rooftop demand carried the decline.", ["e1"]),
					sentence("Utility-scale grew.", ["e1"]),
				]),
			],
		});
		const unsupported = findings.find(
			(finding) => finding.code === "unsupported_figure",
		);
		expect(unsupported?.instruction.kind).toBe("needs_evidence");
		expect(unsupported?.instruction.query).toContain("65.1");
	});

	it("leaves a computed figure alone", () => {
		const findings = findAtlasV3DeterministicFindings({
			...base,
			sections: [
				section("n1", [
					sentence("That is a 0.76% fall.", [], "k1"),
					sentence("Rooftop demand carried the decline.", ["e1"]),
					sentence("Utility-scale grew.", ["e1"]),
				]),
			],
		});
		expect(
			findings.some((finding) => finding.code === "unsupported_figure"),
		).toBe(false);
	});

	it("flags a thin section and asks for evidence", () => {
		const findings = findAtlasV3DeterministicFindings({
			...base,
			sections: [section("n1", [sentence("Only one.", ["e1"])])],
		});
		const thin = findings.find((finding) => finding.code === "thin_section");
		expect(thin?.instruction.kind).toBe("needs_evidence");
	});

	it("catches Hungarian officialese as a register finding", () => {
		const findings = findAtlasV3DeterministicFindings({
			...base,
			language: "hu",
			sections: [
				section("n1", [
					sentence("A béremelés végrehajtásra kerül jövőre.", ["e1"]),
					sentence("A minimálbér 290 800 forint lett.", ["e1"]),
					sentence("A garantált bérminimum ennél magasabb.", ["e1"]),
				]),
			],
		});
		expect(findings.some((finding) => finding.code === "register")).toBe(true);
	});
});

describe("parseAtlasV3Findings", () => {
	it("reads findings and keeps only known node ids", () => {
		const findings = parseAtlasV3Findings(
			JSON.stringify({
				findings: [
					{
						code: "averaged_conflict",
						nodeId: "n1",
						quote: "Sources disagree on the figure.",
						detail: "no series named",
						instruction: { kind: "rewrite" },
					},
					{ code: "nonsense", nodeId: "n1" },
					{ code: "register", nodeId: "n9", instruction: { kind: "cut" } },
				],
			}),
			{ knownNodeIds: ["n1"] },
		);
		expect(findings).toHaveLength(2);
		expect(findings[1].nodeId).toBeNull();
	});

	it("degrades needs_evidence with no query to a rewrite", () => {
		const findings = parseAtlasV3Findings(
			JSON.stringify({
				findings: [
					{ code: "register", instruction: { kind: "needs_evidence" } },
				],
			}),
			{ knownNodeIds: [] },
		);
		expect(findings[0].instruction.kind).toBe("rewrite");
	});

	it("returns nothing for unparsable text", () => {
		expect(parseAtlasV3Findings("no", { knownNodeIds: [] })).toEqual([]);
	});
});

describe("runAtlasV3Critic", () => {
	const base = {
		ask: ASK,
		sections: HEALTHY,
		verdict: [sentence("The EU added 65.1 GW in 2025.", ["e1"])],
		answerTable: null,
		bank: bank(),
		language: "en" as const,
		currentDate: "2026-09-10",
		round: 1,
		alreadyFound: [],
		verdictAnswers: true,
	};

	it("merges the deterministic and model findings", async () => {
		const model = fakeModel({
			"v3:critic": JSON.stringify({
				findings: [
					{
						code: "averaged_conflict",
						nodeId: "n1",
						quote: "Sources disagree.",
						instruction: { kind: "rewrite" },
					},
				],
			}),
		});
		const findings = await runAtlasV3Critic({ ...base, runModel: model.call });
		expect(findings).toHaveLength(1);
		expect(findings[0].code).toBe("averaged_conflict");
	});

	it("keeps the deterministic findings when the critic model fails", async () => {
		const findings = await runAtlasV3Critic({
			...base,
			verdictAnswers: false,
			runModel: async () => {
				throw new Error("down");
			},
		});
		expect(findings.map((finding) => finding.code)).toEqual(["no_verdict"]);
	});

	it("tells the model what the deterministic pass already found", async () => {
		const model = fakeModel({ "v3:critic": JSON.stringify({ findings: [] }) });
		await runAtlasV3Critic({
			...base,
			verdictAnswers: false,
			runModel: model.call,
		});
		const prompt = JSON.parse(
			model.prompts.find((entry) => entry.stage.startsWith("v3:critic"))
				?.prompt ?? "{}",
		);
		expect(prompt.alreadyReported[0].code).toBe("no_verdict");
	});
});

describe("dedupeAtlasV3Findings", () => {
	it("keeps one finding per code and quote", () => {
		const finding: AtlasV3Finding = {
			code: "register",
			nodeId: "n1",
			quote: "A sentence.",
			detail: "d",
			instruction: { kind: "rewrite" },
		};
		expect(dedupeAtlasV3Findings([finding, { ...finding }])).toHaveLength(1);
	});
});

describe("applyAtlasV3Cuts", () => {
	it("removes exactly the sentences a cut names", () => {
		const result = applyAtlasV3Cuts({
			sections: [
				section("n1", [
					sentence("Keep this one.", ["e1"]),
					sentence("Cut this one.", ["e1"]),
				]),
			],
			findings: [
				{
					code: "hollow_sentence",
					nodeId: "n1",
					quote: "Cut this one.",
					detail: "d",
					instruction: { kind: "cut" },
				},
			],
		});
		expect(result.cutCount).toBe(1);
		expect(result.sections[0].paragraphs.flat()).toHaveLength(1);
	});

	it("passes the sections through when nothing is cut", () => {
		const sections = [section("n1", [sentence("a", ["e1"])])];
		expect(applyAtlasV3Cuts({ sections, findings: [] }).sections).toBe(
			sections,
		);
	});

	it("drops a paragraph it emptied", () => {
		const result = applyAtlasV3Cuts({
			sections: [section("n1", [sentence("Only one.")])],
			findings: [
				{
					code: "hollow_sentence",
					nodeId: "n1",
					quote: "Only one.",
					detail: "d",
					instruction: { kind: "cut" },
				},
			],
		});
		expect(result.sections[0].paragraphs).toEqual([]);
	});
});

describe("atlasV3EvidenceQueries / atlasV3RewriteNodeIds", () => {
	const findings: AtlasV3Finding[] = [
		{
			code: "unsupported_figure",
			nodeId: "n1",
			quote: null,
			detail: "d",
			instruction: { kind: "needs_evidence", query: "65.1 GW EU solar" },
		},
		{
			code: "thin_section",
			nodeId: "n2",
			quote: null,
			detail: "d",
			instruction: { kind: "needs_evidence", query: "65.1 GW EU solar" },
		},
		{
			code: "register",
			nodeId: "n2",
			quote: "x",
			detail: "d",
			instruction: { kind: "rewrite" },
		},
	];

	it("deduplicates the queries", () => {
		expect(atlasV3EvidenceQueries(findings)).toEqual(["65.1 GW EU solar"]);
	});

	it("names the nodes to rewrite once each", () => {
		expect(atlasV3RewriteNodeIds(findings)).toEqual(["n2"]);
	});
});

describe("atlasV3CriticSatisfied", () => {
	it("is satisfied only with no findings", () => {
		expect(atlasV3CriticSatisfied([])).toBe(true);
	});
});

describe("atlasV3CriticSystem / buildAtlasV3CriticPrompt", () => {
	it("appends the Hungarian checks and carries the requirements", () => {
		expect(atlasV3CriticSystem({ language: "hu" })).toContain("Magyar Közlöny");
		const prompt = JSON.parse(
			buildAtlasV3CriticPrompt({
				ask: ASK,
				sections: HEALTHY,
				verdict: [],
				answerTable: null,
				language: "en",
				currentDate: "2026-09-10",
				round: 1,
				alreadyFound: [],
			}),
		);
		expect(prompt.implicitRequirements).toEqual(["EU-27, not Europe"]);
		expect(prompt.hasAnswerTable).toBe(false);
	});
});
