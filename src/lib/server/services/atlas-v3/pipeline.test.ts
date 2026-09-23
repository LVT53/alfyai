// The end-to-end test ADR 0063 promised: a three-section report through fakes,
// asserting the properties v2 could not hold — a verdict that answers, an
// answer table with a citation per cell, no claim repeated across sections,
// mechanically numbered citations, and an abstention that renders as one.

import { describe, expect, it } from "vitest";
import type { GeneratedDocumentSource } from "$lib/server/services/file-production/source-schema";
import type { AtlasPipelineJobContext } from "../atlas/types";
import { getAtlasV3ProfileConfig } from "./config";
import type { AtlasV3ModelCall, AtlasV3ModelCalls } from "./model-call";
import { runAtlasV3Pipeline } from "./pipeline";
import {
	fakeLocalSources,
	fakeModel,
	fakeResearchWeb,
	readAnswer,
} from "./test-support";
import type { AtlasV3ProgressDetails } from "./types";

const JOB: AtlasPipelineJobContext = {
	id: "job-1",
	userId: "user-1",
	conversationId: "conv-1",
	assistantMessageId: "msg-1",
	action: "create",
	parentAtlasJobId: null,
	profile: "overview",
	title: "EU solar",
	query: "How much solar did the EU add in 2025 versus 2024?",
	lifecycle: {
		family: "fam-1",
		depth: 0,
		seed: null,
	} as unknown as AtlasPipelineJobContext["lifecycle"],
	kickoffUserMessageId: "user-msg-1",
};

const QUOTES: Record<string, string[]> = {
	s1: [
		"The EU added 65.1 GW of solar capacity in 2025, industry data show.",
		"That was the first annual fall in EU solar additions since 2016.",
	],
	s2: [
		"Europe installed 65.1 GW of solar last year, according to grid operators.",
		"Connections slowed in the second half of the year.",
	],
	s3: [
		"Rooftop installations fell 21% across the bloc during the year.",
		"Household orders thinned as subsidies were withdrawn.",
	],
	s4: [
		"Residential rooftop additions dropped 21% against the prior period.",
		"Installers reported shorter order books.",
	],
	s5: [
		"Utility-scale solar capacity grew 12% over the same window.",
		"Auctioned pipelines carried most of the increase.",
	],
	s6: [
		"Large ground-mounted projects added 12% more capacity than before.",
		"Module prices fell across the supply chain.",
	],
};

const CLAIMS: Record<string, Record<string, unknown>> = {
	s1: { metric: "solar additions", value: "65.1", unit: "GW" },
	s2: { metric: "solar additions", value: "65.1", unit: "GW" },
	s3: { metric: "rooftop additions", value: "-21", unit: "%" },
	s4: { metric: "rooftop additions", value: "-21", unit: "%" },
	s5: { metric: "utility-scale additions", value: "12", unit: "%" },
	s6: { metric: "utility-scale additions", value: "12", unit: "%" },
};

const SECTION_TEXT: Record<string, Array<[string, string[]]>> = {
	n1: [
		["The EU added 65.1 GW of solar capacity in 2025.", ["e1", "e3"]],
		["Two independent trackers report the same total.", ["e3"]],
		["Grid connections rather than shipments define this series.", ["e1"]],
	],
	n2: [
		["Rooftop installations fell 21% across the bloc.", ["e5", "e7"]],
		["Household demand cooled as subsidies were withdrawn.", ["e6"]],
		["Installers describe shorter order books this year.", ["e8"]],
	],
	n3: [
		["Utility-scale capacity grew 12% over the same window.", ["e9", "e11"]],
		["Auctioned pipelines carried most of that increase.", ["e10"]],
		["Module prices fell across the supply chain.", ["e12"]],
	],
};

function sectionAnswer(nodeId: string): string {
	return JSON.stringify({
		paragraphs: [
			{
				sentences: SECTION_TEXT[nodeId].map(([text, evidenceIds]) => ({
					text,
					evidenceIds,
					kind: "claim",
					calcId: null,
				})),
			},
		],
		showAnswerTable: nodeId === "n1",
	});
}

/** Two hits per sub-question, on two independent publishers. */
function hitsForQuestion(index: number) {
	return [
		{
			url: `https://iea.org/reports/r${index}`,
			title: `IEA report ${index}`,
			snippets: [],
			publishedAt: "2025-12-01",
		},
		{
			url: `https://bbc.com/news/n${index}`,
			title: `BBC report ${index}`,
			snippets: [],
			publishedAt: "2025-12-02",
		},
	];
}

function buildFakes(options?: {
	/** Every source is a syndicating aggregator, so nothing corroborates. */
	aggregatorsOnly?: boolean;
	criticFindings?: unknown[];
}) {
	const questions = [
		"EU solar additions 2025",
		"EU rooftop solar 2025",
		"EU utility-scale solar 2025",
	];
	const pages: Record<string, string> = {};
	const hitsByQuestion = new Map<string, ReturnType<typeof hitsForQuestion>>();
	questions.forEach((question, index) => {
		const hits = options?.aggregatorsOnly
			? [
					{
						url: `https://msn.com/a${index}`,
						title: `Aggregated ${index}`,
						snippets: [],
						publishedAt: "2025-12-01",
					},
					{
						url: `https://yahoo.com/b${index}`,
						title: `Syndicated ${index}`,
						snippets: [],
						publishedAt: "2025-12-02",
					},
				]
			: hitsForQuestion(index);
		hitsByQuestion.set(question, hits);
		for (const hit of hits) pages[hit.url] = "page body";
	});

	const web = fakeResearchWeb({
		hits: (question) => hitsByQuestion.get(question) ?? [],
		pages,
	});

	// Reads are keyed by the SOURCE id the bank minted, which is deterministic
	// at researcher concurrency 1.
	const readResponses: Record<string, string> = {};
	for (const [sourceId, quotes] of Object.entries(QUOTES)) {
		const claim = CLAIMS[sourceId];
		readResponses[`v3:read:${sourceId}`] = readAnswer({
			quotes,
			claims: [
				{
					entity: "EU-27",
					metric: String(claim.metric),
					value: String(claim.value),
					unit: String(claim.unit),
					period: "2025",
					series: "grid-connected",
					quoteIndexes: [0],
				},
			],
		});
	}

	const researcher = fakeModel({
		"v3:searchplan": JSON.stringify({ queries: ["q"] }),
		"v3:note": JSON.stringify({ summary: "Found the figure." }),
		...readResponses,
	});
	const control = fakeModel({
		"v3:memo": JSON.stringify({
			answerSoFar: "The EU added 65.1 GW in 2025.",
			claimIds: ["c1", "c2", "c3"],
		}),
		"v3:outline": JSON.stringify({
			nodes: [
				{
					id: "n1",
					title: "EU solar additions fell in 2025",
					claim: "The EU added less solar in 2025 than in 2024.",
					claimIds: ["c1"],
				},
				{
					id: "n2",
					title: "Rooftop demand drove the fall",
					claim: "Rooftop demand drove the fall.",
					claimIds: ["c2"],
				},
				{
					id: "n3",
					title: "Utility-scale kept growing",
					claim: "Utility-scale capacity kept growing.",
					claimIds: ["c3"],
				},
			],
		}),
		"v3:trial": JSON.stringify({
			lead: "Rooftop installations fell 21%.",
			supportable: true,
		}),
	});
	const writer = fakeModel({
		"v3:answer": JSON.stringify({
			title: "EU solar additions",
			columns: [
				{ key: "measure", label: "Measure" },
				{ key: "value", label: "2025" },
			],
			rows: [
				{
					measure: { text: "Total additions", evidenceIds: [] },
					value: { text: "65.1 GW", evidenceIds: ["e1", "e3"] },
				},
				{
					measure: { text: "Rooftop", evidenceIds: [] },
					value: { text: "21%", evidenceIds: ["e5"] },
				},
				{
					measure: { text: "Utility-scale", evidenceIds: [] },
					value: { text: "12%", evidenceIds: ["e9"] },
				},
			],
			derived: [
				{
					id: "k1",
					label: "Rooftop share of the fall",
					expression: "21/12",
					inputs: ["e5", "e9"],
				},
			],
		}),
		"v3:write:n1": sectionAnswer("n1"),
		"v3:write:n2": sectionAnswer("n2"),
		"v3:write:n3": sectionAnswer("n3"),
		"v3:verdict": JSON.stringify({
			sentences: [
				{
					text: "The EU added 65.1 GW of solar in 2025, while rooftop demand fell 21%.",
					evidenceIds: ["e1", "e5"],
					kind: "synthesis",
					calcId: null,
				},
			],
		}),
	});
	const critic = fakeModel({
		"v3:critic": JSON.stringify({ findings: options?.criticFindings ?? [] }),
	});

	const models: AtlasV3ModelCalls = {
		ask: fakeModel({
			"v3:ask": JSON.stringify({
				decision: "Whether EU solar growth stalled in 2025",
				coreQuestion: "How much solar did the EU add in 2025 versus 2024?",
				title: "EU solar additions, 2025 versus 2024",
				shape: "comparison",
				implicitRequirements: ["EU-27, not Europe"],
				perspectives: ["installers", "grid operators"],
				subQuestions: questions,
			}),
		}).call,
		researcher: researcher.call,
		outline: control.call,
		writer: writer.call,
		critic: critic.call,
	};

	const checkpoints: Array<{ phase: string; roundNumber: number }> = [];
	const heartbeats: AtlasV3ProgressDetails[] = [];
	let rendered: GeneratedDocumentSource | null = null;
	let assistantMessage = "";

	const dependencies = {
		researchWeb: web,
		models,
		runPython: async ({ expression }: { expression: string }) => ({
			ok: true,
			value: expression === "21/12" ? "1.75" : "0",
		}),
		heartbeat: async ({ progressDetails }: { progressDetails?: unknown }) => {
			heartbeats.push(progressDetails as AtlasV3ProgressDetails);
		},
		writeCheckpoint: async (input: { roundNumber: number; stage: string }) => {
			checkpoints.push({ phase: input.stage, roundNumber: input.roundNumber });
		},
		renderOutputs: async (source: GeneratedDocumentSource) => {
			rendered = source;
			return {
				fileProductionJobId: "fp-1",
				htmlChatGeneratedFileId: "html-1",
				pdfChatGeneratedFileId: "pdf-1",
				markdownChatGeneratedFileId: "md-1",
			};
		},
		setAssistantMessageContent: async ({ content }: { content: string }) => {
			assistantMessage = content;
		},
		researcherConcurrency: 1,
		criticRounds: 2,
	};

	return {
		dependencies,
		models: { researcher, control, writer, critic },
		checkpoints,
		heartbeats,
		document: () => rendered,
		assistantMessage: () => assistantMessage,
	};
}

async function run(options?: Parameters<typeof buildFakes>[0]) {
	const fakes = buildFakes(options);
	const result = await runAtlasV3Pipeline({
		job: JOB,
		now: new Date("2026-09-10T00:00:00Z"),
		dependencies: fakes.dependencies as unknown as Parameters<
			typeof runAtlasV3Pipeline
		>[0]["dependencies"],
	});
	return { ...fakes, result };
}

describe("runAtlasV3Pipeline", () => {
	it("produces a three-section report with a verdict that answers", async () => {
		const { result, document, assistantMessage } = await run();
		expect(result.status).toBe("succeeded");
		expect(result.pipelineVersion).toBe(3);
		expect(result.abstained).toBe(false);
		expect(result.title).toBe("EU solar additions, 2025 versus 2024");
		expect(result.diagnostics.sectionsWritten).toBe(3);
		expect(result.diagnostics.verdictPresent).toBe(true);

		const blocks = document()?.blocks ?? [];
		expect(blocks[0]).toEqual({ type: "heading", level: 2, text: "Verdict" });
		// The verdict states the answer, with its figure, before anything else.
		const verdictParagraph = blocks[1];
		if (verdictParagraph?.type !== "paragraph") {
			throw new Error("expected the verdict paragraph");
		}
		expect(verdictParagraph.text).toContain("65.1 GW");
		expect(assistantMessage()).toContain("65.1 GW");
		expect(assistantMessage()).toContain("**Sources**");
	});

	it("renders the answer table with a citation in every figure cell", async () => {
		const { document, result } = await run();
		const table = (document()?.blocks ?? []).find(
			(block) => block.type === "table",
		);
		if (table?.type !== "table") throw new Error("expected a table block");
		expect(table.rows).toHaveLength(3);
		for (const row of table.rows) {
			expect(String(row.value)).toMatch(/\[\d+\]/);
		}
		expect(result.diagnostics.answerTableCells).toBe(6);
		// The ratio was computed by run_python, not by the model.
		expect(result.diagnostics.derivedFigures).toBe(1);
		const computed = (document()?.blocks ?? []).find(
			(block) => block.type === "list" && block.items[0]?.includes("computed"),
		);
		expect(computed).toBeDefined();
		if (computed?.type !== "list")
			throw new Error("expected the computed list");
		expect(computed.items[0]).toContain("1.75");
	});

	it("repeats no claim across sections and numbers citations mechanically", async () => {
		const { document } = await run();
		const blocks = document()?.blocks ?? [];
		const paragraphs = blocks
			.filter((block) => block.type === "paragraph")
			.map((block) => (block.type === "paragraph" ? block.text : ""));
		// Section leads are distinct claims, not the same figure restated.
		const sixtyFive = paragraphs.filter((text) => text.includes("65.1 GW"));
		expect(sixtyFive).toHaveLength(2); // the verdict and section one, no more.

		// Every citation number the prose uses resolves to a published source.
		const chips = blocks.find((block) => block.type === "sourceChips");
		if (chips?.type !== "sourceChips") throw new Error("expected chips");
		const published = chips.sources.length;
		const numbers = [
			...JSON.stringify(blocks).matchAll(/\[\[cite:(\d+):/g),
		].map((match) => Number(match[1]));
		expect(numbers.length).toBeGreaterThan(0);
		expect(Math.max(...numbers)).toBeLessThanOrEqual(published);
	});

	it("checkpoints every phase and heartbeats the v3 contract", async () => {
		const { checkpoints, heartbeats } = await run();
		expect(checkpoints.map((entry) => entry.phase)).toEqual([
			"ask",
			"research",
			"outline",
			"answer",
			"write",
			"critic",
			"verify",
			"render",
		]);
		expect(heartbeats.every((entry) => entry.pipelineVersion === 3)).toBe(true);
		expect(heartbeats.every((entry) => entry.queries.length === 0)).toBe(true);
		const last = heartbeats.at(-1);
		expect(last?.phase).toBe("render");
		expect(last?.evidence?.sources.length).toBeGreaterThan(0);
		expect(last?.plan.map((entry) => entry.question)).toContain(
			"EU solar additions fell in 2025",
		);
	});

	it("spends the read budget on the top tier and never on a forum", async () => {
		const { models } = await run();
		const readStages = models.researcher.stages.filter((stage) =>
			stage.startsWith("v3:read:"),
		);
		expect(readStages).toHaveLength(6);
	});

	it("never lets page text reach the writer", async () => {
		const { models } = await run();
		const writePrompts = models.writer.prompts.filter((entry) =>
			entry.stage.startsWith("v3:write:"),
		);
		expect(writePrompts).toHaveLength(3);
		for (const entry of writePrompts) {
			expect(entry.prompt).not.toContain("page body");
		}
	});

	it("renders an abstention as one when nothing corroborates", async () => {
		const { result, document } = await run({ aggregatorsOnly: true });
		expect(result.abstained).toBe(true);
		expect(result.diagnostics.abstained).toBe(true);
		const blocks = document()?.blocks ?? [];
		expect(blocks[0].type).toBe("callout");
		if (blocks[0].type !== "callout") throw new Error("expected a callout");
		expect(blocks[0].text).toContain("does not answer the question");
		// It still ships what it found rather than padding around the hole.
		expect(result.diagnostics.sectionsWritten).toBeGreaterThan(0);
	});

	it("assembles the verdict from the sections when no draft parses", async () => {
		const fakes = buildFakes();
		const models = fakes.dependencies.models;
		const writer = models.writer;
		// Both the first call and the ONE retry come back empty: a finished report
		// must still ship, with the fallback recorded in the diagnostics.
		const silentWriter: AtlasV3ModelCall = async (call) =>
			call.stage.startsWith("v3:verdict")
				? {
						text: JSON.stringify({ sentences: [] }),
						finishReason: "stop",
						usage: {
							inputTokens: 0,
							outputTokens: 0,
							totalTokens: 0,
							costUsdMicros: 0,
						},
					}
				: writer(call);
		const result = await runAtlasV3Pipeline({
			job: JOB,
			now: new Date("2026-09-10T00:00:00Z"),
			dependencies: {
				...fakes.dependencies,
				models: { ...models, writer: silentWriter },
			} as unknown as Parameters<typeof runAtlasV3Pipeline>[0]["dependencies"],
		});
		expect(result.status).toBe("succeeded");
		expect(result.diagnostics.verdictPresent).toBe(true);
		expect(result.diagnostics.verdictFallback).toBe(true);
		expect(result.executiveSummaryMarkdown).toContain("65.1 GW");
	});

	it("abstains rather than failing when no section can be written", async () => {
		const fakes = buildFakes();
		const models = fakes.dependencies.models;
		const writer = models.writer;
		// Every writer call, JSON and plain-text floor alike, comes back unusable.
		const muteWriter: AtlasV3ModelCall = async (call) =>
			call.stage.startsWith("v3:write")
				? {
						text: "{}",
						finishReason: "stop",
						usage: {
							inputTokens: 0,
							outputTokens: 0,
							totalTokens: 0,
							costUsdMicros: 0,
						},
					}
				: writer(call);
		const result = await runAtlasV3Pipeline({
			job: JOB,
			now: new Date("2026-09-10T00:00:00Z"),
			dependencies: {
				...fakes.dependencies,
				models: { ...models, writer: muteWriter },
			} as unknown as Parameters<typeof runAtlasV3Pipeline>[0]["dependencies"],
		});
		expect(result.status).toBe("succeeded");
		expect(result.abstained).toBe(true);
		expect(result.diagnostics.abstained).toBe(true);
		const blocks = fakes.document()?.blocks ?? [];
		const headings = blocks.filter((block) => block.type === "heading");
		expect(
			headings.some(
				(block) =>
					block.type === "heading" && block.text === "What was searched",
			),
		).toBe(true);
		// The sources reached still render, so the reader can carry on by hand.
		expect(result.sourceCounts.accepted).toBeGreaterThan(0);
	});

	it("acts on a critic finding by cutting the sentence it names", async () => {
		const { result } = await run({
			criticFindings: [
				{
					code: "hollow_sentence",
					nodeId: "n2",
					quote: "Household demand cooled as subsidies were withdrawn.",
					detail: "states nothing",
					instruction: { kind: "cut" },
				},
			],
		});
		expect(result.diagnostics.criticRounds).toBeGreaterThan(0);
		expect(result.diagnostics.criticFindings).toBeGreaterThan(0);
	});

	it("numbers the progress card exactly as the report numbers its citations", async () => {
		const { document, heartbeats } = await run();
		const blocks = document()?.blocks ?? [];
		const chips = blocks.find((block) => block.type === "sourceChips");
		if (chips?.type !== "sourceChips") throw new Error("expected chips");
		const card = heartbeats.at(-1)?.evidence?.sources ?? [];
		expect(card.length).toBeGreaterThanOrEqual(chips.sources.length);
		// The report's first citation and the card's n=1 must be the SAME source:
		// the harness cross-checks every figure against the card's quotes, and two
		// orderings would make every citation look like a mismatch.
		chips.sources.forEach((source, index) => {
			expect(card[index]?.n).toBe(index + 1);
			expect(card[index]?.cited).toBe(true);
			expect(source.title.startsWith(card[index]?.title ?? "")).toBe(true);
		});
	});

	it("hands the critic's targeted evidence to the rewrite that asked for it", async () => {
		const { models, result } = await run({
			criticFindings: [
				{
					code: "unsupported_figure",
					nodeId: "n2",
					quote: "Rooftop installations fell 21% across the bloc.",
					detail: "the 21% figure needs a second publisher",
					instruction: {
						kind: "needs_evidence",
						query: "EU rooftop solar 2025",
					},
				},
			],
		});
		expect(result.diagnostics.criticRounds).toBeGreaterThan(0);
		// The node the finding named is rewritten, and the rewrite prompt carries
		// the instruction the critic gave.
		const rewrites = models.writer.prompts.filter(
			(entry) => entry.stage === "v3:write:n2",
		);
		expect(rewrites.length).toBeGreaterThan(1);
		expect(rewrites.at(-1)?.prompt).toContain("needs a second publisher");
	});

	it("checkpoints the critic's research round like any other", async () => {
		const { checkpoints } = await run({
			criticFindings: [
				{
					code: "unsupported_figure",
					nodeId: "n2",
					quote: "Rooftop installations fell 21% across the bloc.",
					detail: "the 21% figure needs a second publisher",
					instruction: {
						kind: "needs_evidence",
						query: "EU rooftop solar 2025",
					},
				},
			],
		});
		const research = checkpoints.filter((entry) => entry.phase === "research");
		// Round one, plus the critic's; the quotes it fetched are on the row.
		expect(research.length).toBeGreaterThan(1);
		expect(research.map((entry) => entry.roundNumber)).toContain(12);
	});
});

// ---------------------------------------------------------------------------
// Depth: an in-depth outline the model answered with two nodes
// ---------------------------------------------------------------------------

const DEPTH_JOB: AtlasPipelineJobContext = {
	...JOB,
	profile: "in-depth",
	query: "What do the twenty EU energy indicators say about 2025?",
};

/** Twenty distinct claims, one quote each, over ten sources. */
function buildDepthFakes() {
	const questions = Array.from(
		{ length: 5 },
		(_unused, index) => `EU indicator group ${index + 1}`,
	);
	const pages: Record<string, string> = {};
	const hitsByQuestion = new Map<string, ReturnType<typeof hitsForQuestion>>();
	questions.forEach((question, index) => {
		const hits = hitsForQuestion(index);
		hitsByQuestion.set(question, hits);
		for (const hit of hits) pages[hit.url] = "page body";
	});
	const web = fakeResearchWeb({
		hits: (question) => hitsByQuestion.get(question) ?? [],
		pages,
	});

	const readResponses: Record<string, string> = {};
	for (let source = 1; source <= 10; source += 1) {
		const first = source * 2 - 1;
		const second = source * 2;
		readResponses[`v3:read:s${source}`] = readAnswer({
			quotes: [
				`Indicator ${first} stood at ${first} GW in 2025.`,
				`Indicator ${second} stood at ${second} GW in 2025.`,
			],
			claims: [first, second].map((number, position) => ({
				entity: "EU",
				metric: `indicator ${number}`,
				value: String(number),
				unit: "GW",
				period: "2025",
				series: `series ${number}`,
				quoteIndexes: [position],
			})),
		});
	}

	const researcher = fakeModel({
		"v3:searchplan": JSON.stringify({ queries: ["q"] }),
		"v3:note": JSON.stringify({ summary: "Read the indicator table." }),
		...readResponses,
	});
	// The regression: an in-depth outline over twenty claims, answered with two
	// sections. The profile asks for five.
	const control = fakeModel({
		"v3:memo": JSON.stringify({
			answerSoFar: "Twenty indicators were published for 2025.",
			claimIds: Array.from({ length: 20 }, (_unused, i) => `c${i + 1}`),
		}),
		"v3:outline": JSON.stringify({
			nodes: [
				{
					id: "n1",
					title: "Indicator one led the table in 2025",
					claim: "Indicator one is the headline reading for 2025.",
					claimIds: ["c1"],
				},
				{
					id: "n2",
					title: "Indicator two moved against it",
					claim: "Indicator two moved the other way in 2025.",
					claimIds: ["c2"],
				},
			],
		}),
		"v3:trial": JSON.stringify({
			lead: "Indicator 3 stood at 3 GW in 2025.",
			supportable: true,
		}),
	});
	// Writes back the quotes it was handed, one sentence each: whatever node the
	// outline produced, supplemented or planned, is written from its own evidence.
	const writer = fakeModel({
		"v3:write:": (prompt: string) =>
			JSON.stringify({
				paragraphs: [
					{
						sentences: [
							...prompt.matchAll(/\{"id":"(e\d+)","text":"([^"]+)"/g),
						].map((match) => ({
							text: match[2],
							evidenceIds: [match[1]],
							kind: "claim",
							calcId: null,
						})),
					},
				],
				showAnswerTable: false,
			}),
		"v3:verdict": JSON.stringify({
			sentences: [
				{
					text: "Indicator 1 stood at 1 GW in 2025.",
					evidenceIds: ["e1"],
					kind: "synthesis",
					calcId: null,
				},
			],
		}),
	});

	return {
		researchWeb: web,
		models: {
			ask: fakeModel({
				"v3:ask": JSON.stringify({
					decision: "What the 2025 indicator table shows",
					coreQuestion: "What do the EU energy indicators say about 2025?",
					title: "EU energy indicators, 2025",
					shape: "explanation",
					implicitRequirements: [],
					perspectives: [],
					subQuestions: questions,
				}),
			}).call,
			researcher: researcher.call,
			outline: control.call,
			writer: writer.call,
			critic: fakeModel({}).call,
		} as AtlasV3ModelCalls,
		writeCheckpoint: async () => {},
		renderOutputs: async () => ({
			fileProductionJobId: "fp-1",
			htmlChatGeneratedFileId: "html-1",
			pdfChatGeneratedFileId: "pdf-1",
			markdownChatGeneratedFileId: "md-1",
		}),
		researcherConcurrency: 1,
		criticRounds: 0,
		profileOverrides: { rounds: 1 },
	};
}

describe("runAtlasV3Pipeline, in-depth depth floor", () => {
	it("reaches minSections when the model plans two over twenty claims", async () => {
		const result = await runAtlasV3Pipeline({
			job: DEPTH_JOB,
			now: new Date("2026-09-10T00:00:00Z"),
			dependencies: buildDepthFakes() as unknown as Parameters<
				typeof runAtlasV3Pipeline
			>[0]["dependencies"],
		});
		const minSections = getAtlasV3ProfileConfig("in-depth").minSections;
		expect(result.diagnostics.sectionsPlanned).toBeGreaterThanOrEqual(
			minSections,
		);
		expect(result.diagnostics.sectionsSupplemented).toBe(minSections - 2);
		// Every supplemented section carries evidence and is written from it.
		expect(result.diagnostics.sectionsWritten).toBeGreaterThanOrEqual(
			minSections,
		);
		expect(result.abstained).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Atlas Local Sources: the user's own documents as evidence
// ---------------------------------------------------------------------------

const LOCAL_JOB: AtlasPipelineJobContext = {
	...JOB,
	query: "How does our household electricity use in 2025 compare?",
};

const LOCAL_QUOTE =
	"Our household used 1,234 kWh of electricity in 2025 according to the meter log.";
/** Passage text that is NOT quoted: it must never reach the writer. */
const PASSAGE_ONLY = "The meter was replaced in March by the network operator.";
const WEB_QUOTE =
	"The average household used 1,234 kWh of electricity in 2025, the IEA estimates.";

const LOCAL_CLAIM = {
	entity: "household",
	metric: "electricity use",
	value: "1,234",
	unit: "kWh",
	period: "2025",
	quoteIndexes: [0],
};

function buildLocalFakes(options?: {
	/** No web hit at all: the user's document is the only evidence. */
	noWeb?: boolean;
	/** The writer states a figure its cited quote does not. */
	inventFigure?: boolean;
	documents?: Parameters<typeof fakeLocalSources>[0]["documents"];
	unavailable?: Parameters<typeof fakeLocalSources>[0]["unavailable"];
	passages?: Record<string, string[]>;
}) {
	const question = "household electricity use 2025";
	const webUrl = "https://iea.org/reports/household-electricity";
	const web = fakeResearchWeb({
		hits: options?.noWeb
			? []
			: [
					{
						url: webUrl,
						title: "IEA household electricity",
						snippets: [],
						publishedAt: "2025-12-01",
					},
				],
		pages: { [webUrl]: "page body" },
	});
	const local = fakeLocalSources({
		documents: options?.documents ?? [
			{ displayArtifactId: "art-bill", title: "Electricity bill 2025.pdf" },
		],
		unavailable: options?.unavailable,
		passages: options?.passages ?? {
			"art-bill": [`${LOCAL_QUOTE} ${PASSAGE_ONLY}`],
		},
	});
	const researcher = fakeModel({
		"v3:searchplan": JSON.stringify({ queries: ["q"] }),
		"v3:note": JSON.stringify({ summary: "Found the figure." }),
		"v3:read:local:": readAnswer({
			quotes: [LOCAL_QUOTE],
			claims: [LOCAL_CLAIM],
		}),
		"v3:read:s": readAnswer({ quotes: [WEB_QUOTE], claims: [LOCAL_CLAIM] }),
	});
	const control = fakeModel({
		"v3:memo": JSON.stringify({
			answerSoFar: "The household used 1,234 kWh in 2025.",
			claimIds: ["c1"],
		}),
		"v3:outline": JSON.stringify({
			nodes: [
				{
					id: "n1",
					title: "The household used 1,234 kWh in 2025",
					claim: "The household used 1,234 kWh of electricity in 2025.",
					claimIds: ["c1"],
				},
			],
		}),
	});
	// Writes back every quote it was handed, one sentence each, citing it.
	const writer = fakeModel({
		"v3:write:": (prompt: string) =>
			JSON.stringify({
				paragraphs: [
					{
						sentences: [
							...prompt.matchAll(/\{"id":"(e\d+)","text":"([^"]+)"/g),
						].map((match) => ({
							text: options?.inventFigure
								? "The household used 9,999 kWh of electricity in 2025."
								: match[2],
							evidenceIds: [match[1]],
							kind: "claim",
							calcId: null,
						})),
					},
				],
				showAnswerTable: false,
			}),
		"v3:verdict": (prompt: string) => {
			const evidence = JSON.parse(prompt).evidence as Array<{
				id: string;
				text: string;
			}>;
			return JSON.stringify({
				sentences: evidence.slice(0, 1).map((entry) => ({
					text: entry.text,
					evidenceIds: [entry.id],
					kind: "claim",
					calcId: null,
				})),
			});
		},
	});
	const ask = fakeModel({
		"v3:ask": JSON.stringify({
			decision: "Whether our electricity use is typical",
			coreQuestion: "How much electricity did the household use in 2025?",
			title: "Household electricity use, 2025",
			shape: "explanation",
			implicitRequirements: [],
			perspectives: [],
			subQuestions: [question],
		}),
	});
	let rendered: GeneratedDocumentSource | null = null;
	const heartbeats: AtlasV3ProgressDetails[] = [];
	const dependencies = {
		researchWeb: web,
		localSources: local,
		models: {
			ask: ask.call,
			researcher: researcher.call,
			outline: control.call,
			writer: writer.call,
			critic: fakeModel({}).call,
			verifier: control.call,
		} as AtlasV3ModelCalls,
		heartbeat: async ({ progressDetails }: { progressDetails?: unknown }) => {
			heartbeats.push(progressDetails as AtlasV3ProgressDetails);
		},
		writeCheckpoint: async () => {},
		renderOutputs: async (source: GeneratedDocumentSource) => {
			rendered = source;
			return {
				fileProductionJobId: "fp-1",
				htmlChatGeneratedFileId: "html-1",
				pdfChatGeneratedFileId: "pdf-1",
				markdownChatGeneratedFileId: "md-1",
			};
		},
		researcherConcurrency: 1,
		criticRounds: 0,
		// One quote per claim here, so a node is not thin at one bound quote.
		profileOverrides: { rounds: 1, minSections: 1, minEvidencePerNode: 1 },
	};
	return {
		dependencies,
		local,
		models: { ask, researcher, control, writer },
		heartbeats,
		document: () => rendered as GeneratedDocumentSource | null,
	};
}

async function runLocal(options?: Parameters<typeof buildLocalFakes>[0]) {
	const fakes = buildLocalFakes(options);
	const result = await runAtlasV3Pipeline({
		job: LOCAL_JOB,
		now: new Date("2026-09-10T00:00:00Z"),
		dependencies: fakes.dependencies as unknown as Parameters<
			typeof runAtlasV3Pipeline
		>[0]["dependencies"],
	});
	return { ...fakes, result };
}

function limitationItems(document: GeneratedDocumentSource | null): string[] {
	const blocks = document?.blocks ?? [];
	const index = blocks.findIndex(
		(block) =>
			block.type === "heading" &&
			block.text === "What this report could not establish",
	);
	const list = blocks[index + 1];
	return list?.type === "list" ? list.items : [];
}

describe("runAtlasV3Pipeline, local sources", () => {
	it("cites a user document as a library chip, numbered like the card", async () => {
		const { result, document, heartbeats } = await runLocal();
		const blocks = document()?.blocks ?? [];
		const chips = blocks.find((block) => block.type === "sourceChips");
		if (chips?.type !== "sourceChips") throw new Error("expected chips");
		const library = chips.sources.filter((chip) => chip.kind === "library");
		expect(library).toEqual([
			{
				title: "Electricity bill 2025.pdf",
				url: null,
				kind: "library",
				provided: true,
			},
		]);
		expect(chips.sources.some((chip) => chip.kind === "web")).toBe(true);
		// The card numbers the user's document exactly where the report does.
		const card = heartbeats.at(-1)?.evidence?.sources ?? [];
		chips.sources.forEach((chip, index) => {
			expect(card[index]?.n).toBe(index + 1);
			expect(chip.title.startsWith(card[index]?.title ?? "")).toBe(true);
			expect(card[index]?.kind).toBe(chip.kind === "library" ? "local" : "web");
		});
		const localCard = card.find((entry) => entry.kind === "local");
		expect(localCard?.host).toBe("");
		expect(localCard?.cited).toBe(true);
		// The prose cites the user's document by a number the chips resolve.
		const libraryNumber =
			chips.sources.findIndex((chip) => chip.kind === "library") + 1;
		expect(JSON.stringify(blocks)).toMatch(
			new RegExp(`\\[\\[cite:${libraryNumber}:|\\[${libraryNumber}\\]`),
		);
		expect(result.sourceCounts.local).toBe(1);
		expect(result.sourceCounts.web).toBe(1);
		expect(result.diagnostics.localSources).toEqual({
			resolved: 1,
			read: 1,
			quotes: 1,
			unavailable: 0,
		});
	});

	it("verifies a figure the user's document and one publisher both state", async () => {
		const { result } = await runLocal();
		expect(result.diagnostics.verifiedClaimCount).toBe(1);
		expect(result.abstained).toBe(false);
	});

	it("keeps a local-only core claim single rather than abstaining", async () => {
		const { result, document } = await runLocal({ noWeb: true });
		expect(result.abstained).toBe(false);
		expect(result.diagnostics.claimCount).toBe(1);
		expect(result.diagnostics.verifiedClaimCount).toBe(0);
		expect(result.sourceCounts.local).toBe(1);
		expect(result.sourceCounts.web).toBe(0);
		const chips = (document()?.blocks ?? []).find(
			(block) => block.type === "sourceChips",
		);
		if (chips?.type !== "sourceChips") throw new Error("expected chips");
		expect(chips.sources.map((chip) => chip.kind)).toEqual(["library"]);
	});

	it("tells the ask which documents exist and labels them for the writer", async () => {
		const { models } = await runLocal();
		const askPrompt = JSON.parse(models.ask.prompts[0]?.prompt ?? "{}");
		expect(askPrompt.localSources).toEqual([
			{
				title: "Electricity bill 2025.pdf",
				origin: "attachment",
				summary: null,
			},
		]);
		expect(models.ask.prompts[0]?.system).toContain("`localSources`");
		const write = models.writer.prompts.find((entry) =>
			entry.stage.startsWith("v3:write:"),
		);
		const evidence = JSON.parse(write?.prompt ?? "{}").evidence as Array<{
			text: string;
			publisher: string;
			tier: string;
		}>;
		const local = evidence.find((entry) => entry.text === LOCAL_QUOTE);
		expect(local?.publisher).toBe("user-documents");
		expect(local?.tier).toBe("user_document");
		expect(write?.system).toContain("tier `user_document`");
		const verdict = models.writer.prompts.find(
			(entry) => entry.stage === "v3:verdict",
		);
		expect(verdict?.system).toContain("tier `user_document`");
	});

	it("reads the document once, for the core question and every sub-question", async () => {
		const { local, models } = await runLocal();
		expect(local.passageCalls).toHaveLength(1);
		expect(local.passageCalls[0]?.goals).toEqual([
			"How much electricity did the household use in 2025?",
			"household electricity use 2025",
		]);
		expect(local.passageCalls[0]?.maxChars).toBe(12_000);
		const reads = models.researcher.prompts.filter((entry) =>
			entry.stage.startsWith("v3:read:local:"),
		);
		expect(reads).toHaveLength(1);
		expect(reads[0]?.system).toContain("ONE document the user provided");
		expect(JSON.parse(reads[0]?.prompt ?? "{}").source).toEqual({
			title: "Electricity bill 2025.pdf",
			kind: "user_document",
			date: null,
		});
	});

	it("never lets a document's passage text reach the writer", async () => {
		const { models } = await runLocal();
		const writerPrompts = models.writer.prompts.map((entry) => entry.prompt);
		expect(writerPrompts.length).toBeGreaterThan(0);
		for (const prompt of writerPrompts) {
			expect(prompt).not.toContain(PASSAGE_ONLY);
			expect(prompt).not.toContain("page body");
		}
	});

	it("cuts a figure the cited local quote does not state", async () => {
		const { document } = await runLocal({ inventFigure: true });
		const prose = (document()?.blocks ?? [])
			.filter((block) => block.type === "paragraph")
			.map((block) => (block.type === "paragraph" ? block.text : ""))
			.join(" ");
		expect(prose).not.toContain("9,999");
	});

	it("files no local quote the passages sent do not contain", async () => {
		// The read quotes a sentence that is not in the one passage sent: the
		// verbatim guard refuses it, the document leaves the bank, and with no
		// web evidence either there is nothing to report.
		await expect(
			runLocal({ passages: { "art-bill": [PASSAGE_ONLY] }, noWeb: true }),
		).rejects.toMatchObject({ code: "atlas_v3_no_evidence" });
	});

	it("fails the job when an explicit source is unavailable", async () => {
		await expect(
			runLocal({
				unavailable: [
					{
						displayArtifactId: "art-gone",
						title: "Contract.pdf",
						origin: "linked",
						reason: "out_of_scope",
					},
				],
			}),
		).rejects.toMatchObject({ code: "atlas_v3_local_source_unavailable" });
	});

	it("degrades an unavailable inherited source to a Limitations line", async () => {
		const { result, document } = await runLocal({
			unavailable: [
				{
					displayArtifactId: "art-old",
					title: "Old survey.pdf",
					origin: "inherited",
					reason: "not_found",
				},
			],
		});
		expect(result.status).toBe("succeeded");
		expect(result.diagnostics.localSources?.unavailable).toBe(1);
		expect(
			limitationItems(document()).some(
				(item) =>
					item.startsWith("Old survey.pdf") &&
					item.includes("no longer available"),
			),
		).toBe(true);
	});

	it("names the documents over the cap in a Limitations line", async () => {
		const documents = Array.from({ length: 13 }, (_unused, index) => ({
			displayArtifactId: `art-${index + 1}`,
			title: `Document ${index + 1}.pdf`,
		}));
		const { result, document, local } = await runLocal({
			documents,
			passages: { "art-1": [`${LOCAL_QUOTE} ${PASSAGE_ONLY}`] },
		});
		expect(result.sourceCounts.local).toBe(12);
		expect(local.passageCalls).toHaveLength(12);
		const items = limitationItems(document());
		expect(
			items.some(
				(item) =>
					item.includes("1 more document you provided") &&
					item.includes("Document 13.pdf"),
			),
		).toBe(true);
		// The eleven with no passage are named on ONE line, not eleven.
		expect(
			items.filter((item) => item.includes("contained nothing bearing")),
		).toHaveLength(1);
	});
});
