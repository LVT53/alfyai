// Lifecycle seeding through the whole pipeline (Phase D): a Continue or Revise
// child reuses its parent's evidence bank — rechecking what may have gone
// stale — a Fork re-researches, and an old (v1/v2) parent's report URLs are
// read afresh as seed pages. Everything runs through `runAtlasV3Pipeline` with
// fakes; the parent is handed in as an `AtlasV3ParentSeed`.

import { describe, expect, it } from "vitest";
import type { GeneratedDocumentSource } from "$lib/server/services/file-production/source-schema";
import { validateGeneratedDocumentSource } from "$lib/server/services/file-production/source-schema";
import { STORED_V1_SOURCE } from "$lib/server/services/file-production/testing/atlas-legacy-document-sources";
import type { AtlasPipelineJobContext } from "../atlas/types";
import type { AtlasV3ProfileConfig } from "./config";
import type { AtlasV3ModelCalls } from "./model-call";
import { runAtlasV3Pipeline } from "./pipeline";
import { extractAtlasV3ParentReport } from "./seed";
import {
	fakeLocalSources,
	fakeModel,
	fakeResearchWeb,
	readAnswer,
} from "./test-support";
import type {
	AtlasV3EvidenceBank,
	AtlasV3ParentSeed,
	AtlasV3ProgressDetails,
} from "./types";

const NOW = new Date("2026-09-24T00:00:00Z");

const URL_IEA = "https://iea.org/reports/solar-2025";
const URL_BBC = "https://bbc.com/news/eu-solar";
const URL_LAW = "https://eur-lex.europa.eu/eli/dir/2018/2001";
const URL_HEAT = "https://ehpa.org/market-report-2026";

const QUOTE_IEA =
	"The EU added 65.1 GW of solar capacity in 2025, industry data show.";
const QUOTE_BBC =
	"Europe installed 65.1 GW of solar last year, according to grid operators.";
const QUOTE_LAW =
	"The 2019 directive set a binding 32% renewables target for 2030.";
const QUOTE_HEAT =
	"Heat pump sales across the EU fell 21% during the year, the association said.";
const QUOTE_FRESH =
	"Grid operators connected most of the new capacity in the second half of the year.";
const PARENT_VERDICT =
	"PARENT VERDICT: the EU added 99 GW of solar in 2025, an all-time record.";

function parentBank(retrievedAt: string): AtlasV3EvidenceBank {
	const web = (
		id: string,
		url: string,
		publisher: string,
		tier: "primary" | "press",
	) => ({
		id,
		canonicalUrl: url,
		host: new URL(url).hostname,
		publisher,
		title: `${publisher} page`,
		date: null,
		tier,
		read: true,
		retrievedAt,
	});
	return {
		sources: [
			web("s1", URL_IEA, "iea", "primary"),
			web("s2", URL_BBC, "bbc", "press"),
			web("s3", URL_LAW, "eu", "primary"),
			web("s4", URL_HEAT, "ehpa", "press"),
		],
		quotes: [
			{ id: "e1", sourceId: "s1", text: QUOTE_IEA, goal: "g" },
			{ id: "e2", sourceId: "s2", text: QUOTE_BBC, goal: "g" },
			{ id: "e3", sourceId: "s3", text: QUOTE_LAW, goal: "g" },
			{ id: "e4", sourceId: "s4", text: QUOTE_HEAT, goal: "g" },
		],
		claims: [
			{
				id: "c1",
				entity: "EU-27",
				metric: "solar additions",
				value: "65.1",
				unit: "GW",
				period: "2025",
				asOf: null,
				series: null,
				evidenceIds: ["e1", "e2"],
				status: "verified",
			},
			{
				id: "c2",
				entity: "EU",
				metric: "renewables target",
				value: "32",
				unit: "%",
				period: "2019",
				asOf: "2019-06-01",
				series: null,
				evidenceIds: ["e3"],
				status: "single",
			},
			{
				id: "c3",
				entity: "EU",
				metric: "heat pump sales change",
				value: "-21",
				unit: "%",
				period: "2026",
				asOf: null,
				series: null,
				evidenceIds: ["e4"],
				status: "single",
			},
		],
		filteredCount: 0,
	};
}

function parentSeed(input: {
	action: AtlasV3ParentSeed["action"];
	retrievedAt?: string;
	citedSourceIds?: string[];
	localDisplayArtifactIds?: string[];
}): AtlasV3ParentSeed {
	return {
		parentJobId: "parent-1",
		action: input.action,
		parentPipelineVersion: 3,
		parentCompletedAt: "2026-09-20T12:00:00.000Z",
		report: {
			title: "EU solar additions, 2025",
			headings: ["Additions held at 65.1 GW"],
			verdict: PARENT_VERDICT,
			webSources: [
				{ url: URL_IEA, title: "IEA" },
				{ url: URL_BBC, title: "BBC" },
			],
		},
		v3: {
			ask: {
				decision: "d",
				coreQuestion: "How much solar did the EU add in 2025?",
				title: "EU solar additions, 2025",
				shape: "explanation",
				implicitRequirements: [],
				perspectives: [],
				subQuestions: ["EU solar additions 2025"],
			},
			bank: parentBank(input.retrievedAt ?? "2026-09-20T12:00:00.000Z"),
			memo: {
				answerSoFar: "The parent's own answer, which a child must not inherit.",
				claimIds: ["c1", "c3", "c99"],
				openQuestions: ["What about Germany?"],
				deadEnds: [],
				budgetUsed: { searches: 4, pagesRead: 4, rounds: 1 },
			},
			asked: ["EU solar additions 2025"],
			outline: {
				nodes: [
					{
						id: "n1",
						title: "Additions held at 65.1 GW",
						claim: "The EU added 65.1 GW in 2025.",
						needs: [],
						evidenceIds: ["e1", "e2"],
						status: "ready",
					},
				],
				cut: [],
			},
			citedSourceIds: input.citedSourceIds ?? ["s1", "s2"],
		},
		localDisplayArtifactIds: input.localDisplayArtifactIds ?? [],
	};
}

function job(
	action: AtlasPipelineJobContext["action"],
): AtlasPipelineJobContext {
	return {
		id: "child-1",
		userId: "user-1",
		conversationId: "conv-1",
		assistantMessageId: "msg-child",
		action,
		parentAtlasJobId: "parent-1",
		profile: "overview",
		title: "Child",
		query: "Now look at heat pumps too",
		lifecycle: {
			family: { familyId: "fam-1" },
			seed: null,
		} as unknown as AtlasPipelineJobContext["lifecycle"],
		kickoffUserMessageId: "user-msg-child",
	};
}

interface Checkpoint {
	roundNumber: number;
	stage: string;
	checkpoint: unknown;
}

function buildFakes(options: {
	seed: AtlasV3ParentSeed | null;
	freshPages?: Record<string, string | null>;
	pages?: Record<string, string>;
	/** Search hits for every question. None: round one finds nothing new. */
	hits?: Array<{ url: string; title: string }>;
	local?: Parameters<typeof fakeLocalSources>[0];
	profileOverrides?: Partial<AtlasV3ProfileConfig>;
	loadCheckpoints?: Checkpoint[];
}) {
	const web = fakeResearchWeb({
		hits: (options.hits ?? []).map((hit) => ({
			...hit,
			snippets: [],
			publishedAt: "2026-09-01",
		})),
		pages: options.pages ?? {},
		freshPages: options.freshPages,
	});
	const local = fakeLocalSources(options.local ?? {});
	const researcher = fakeModel({
		"v3:searchplan": JSON.stringify({ queries: ["q"] }),
		"v3:note": JSON.stringify({ summary: "Found it." }),
		"v3:read:local:": readAnswer({
			quotes: ["Our household ran a 9 kW heat pump through the 2025 winter."],
		}),
		"v3:read:s": readAnswer({
			quotes: [QUOTE_FRESH],
			claims: [
				{
					entity: "EU grid",
					metric: "timing of new connections",
					value: "second half",
					quoteIndexes: [0],
				},
			],
		}),
	});
	const control = fakeModel({
		"v3:memo": JSON.stringify({
			answerSoFar: "The EU added 65.1 GW in 2025.",
			claimIds: ["c1", "c2", "c3", "c4", "c5"],
		}),
		"v3:outline": JSON.stringify({
			nodes: [
				{
					id: "n1",
					title: "What the evidence says",
					claim: "The EU added solar in 2025.",
					// Whatever the bank holds: the seeded claims, and the one a fresh
					// read files after them.
					claimIds: ["c1", "c2", "c3", "c4", "c5"],
				},
			],
		}),
	});
	// Writes back every quote it was handed, one sentence each, citing it.
	const echo = (prompt: string) =>
		[...prompt.matchAll(/\{"id":"(e\d+)","text":"([^"]+)"/g)].map((match) => ({
			text: match[2],
			evidenceIds: [match[1]],
			kind: "claim",
			calcId: null,
		}));
	const writer = fakeModel({
		"v3:write:": (prompt: string) =>
			JSON.stringify({
				paragraphs: [{ sentences: echo(prompt) }],
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
			decision: "Whether EU heat pumps and solar moved together",
			coreQuestion: "How did EU solar and heat pumps change in 2025?",
			title: "EU solar and heat pumps, 2025",
			shape: "explanation",
			implicitRequirements: [],
			perspectives: [],
			subQuestions: ["EU heat pump sales 2025"],
		}),
	});
	const checkpoints: Checkpoint[] = [];
	const heartbeats: AtlasV3ProgressDetails[] = [];
	let rendered: GeneratedDocumentSource | null = null;
	const dependencies = {
		researchWeb: web,
		localSources: local,
		models: {
			ask: ask.call,
			researcher: researcher.call,
			outline: control.call,
			writer: writer.call,
			critic: fakeModel({}).call,
		} as AtlasV3ModelCalls,
		heartbeat: async ({ progressDetails }: { progressDetails?: unknown }) => {
			heartbeats.push(progressDetails as AtlasV3ProgressDetails);
		},
		writeCheckpoint: async (input: Checkpoint) => {
			checkpoints.push({
				roundNumber: input.roundNumber,
				stage: input.stage,
				checkpoint: JSON.parse(JSON.stringify(input.checkpoint)),
			});
		},
		...(options.loadCheckpoints
			? { loadCheckpoints: async () => options.loadCheckpoints ?? [] }
			: {}),
		loadParentSeed: async () => options.seed,
		renderOutputs: async (source: GeneratedDocumentSource) => {
			rendered = source;
			return {
				fileProductionJobId: "fp-child",
				htmlChatGeneratedFileId: "html",
				pdfChatGeneratedFileId: "pdf",
				markdownChatGeneratedFileId: "md",
			};
		},
		researcherConcurrency: 1,
		criticRounds: 0,
		profileOverrides: {
			rounds: 1,
			minSections: 1,
			minEvidencePerNode: 1,
			...options.profileOverrides,
		},
	};
	return {
		dependencies,
		web,
		local,
		models: { ask, researcher, control, writer },
		checkpoints,
		heartbeats,
		document: () => rendered as GeneratedDocumentSource | null,
	};
}

async function run(
	action: AtlasPipelineJobContext["action"],
	options: Parameters<typeof buildFakes>[0],
) {
	const fakes = buildFakes(options);
	const result = await runAtlasV3Pipeline({
		job: job(action),
		now: NOW,
		dependencies: fakes.dependencies as unknown as Parameters<
			typeof runAtlasV3Pipeline
		>[0]["dependencies"],
	});
	const prose = JSON.stringify(fakes.document()?.blocks ?? []);
	return { ...fakes, result, prose };
}

/** The memo prompt round one sent, parsed. */
function roundOneMemo(fakes: Awaited<ReturnType<typeof run>>) {
	const entry = fakes.models.control.prompts.find(
		(prompt) => prompt.stage === "v3:memo:1",
	);
	return JSON.parse(entry?.prompt ?? "{}");
}

describe("runAtlasV3Pipeline, lifecycle seeding", () => {
	it("Continue cites a fresh parent's quotes without reading a single page", async () => {
		const fakes = await run("continue", {
			seed: parentSeed({ action: "continue" }),
		});
		expect(fakes.web.readCalls).toEqual([]);
		expect(fakes.prose).toContain(QUOTE_IEA);
		expect(fakes.prose).toContain(QUOTE_HEAT);
		expect(fakes.result.diagnostics.seed).toEqual({
			action: "continue",
			parentPipelineVersion: 3,
			sourcesSeeded: 4,
			quotesSeeded: 4,
			trusted: 4,
			rechecked: 0,
			confirmed: 0,
			changed: 0,
			dropped: 0,
			seedPagesRead: 0,
		});
		// The seeded bank is research round 0, so a retry never rechecks again.
		const seedRow = fakes.checkpoints.find((entry) => entry.roundNumber === 10);
		expect(seedRow?.stage).toBe("research");
		expect(
			(seedRow?.checkpoint as { data: { round: number } }).data.round,
		).toBe(0);
	});

	it("Continue rewrites the parent's memo, filtered to surviving claims, and sees its outline", async () => {
		const fakes = await run("continue", {
			seed: parentSeed({ action: "continue" }),
		});
		const memo = roundOneMemo(fakes);
		expect(memo.previousMemo).toEqual({
			answerSoFar: "",
			claimIds: ["c1", "c3"],
			openQuestions: ["What about Germany?"],
			deadEnds: [],
		});
		const outlinePrompt = fakes.models.control.prompts.find((entry) =>
			entry.stage.startsWith("v3:outline:"),
		);
		expect(outlinePrompt?.prompt).toContain("Additions held at 65.1 GW");
	});

	it("tells the ask about the parent and the instruction, and never treats its verdict as evidence", async () => {
		const fakes = await run("continue", {
			seed: parentSeed({ action: "continue" }),
		});
		const askPrompt = JSON.parse(fakes.models.ask.prompts[0]?.prompt ?? "{}");
		expect(askPrompt.instruction).toBe("Now look at heat pumps too");
		expect(askPrompt.parent).toEqual({
			action: "continue",
			title: "EU solar additions, 2025",
			coreQuestion: "How much solar did the EU add in 2025?",
			verdict: PARENT_VERDICT,
			headings: ["Additions held at 65.1 GW"],
			date: "2026-09-20",
		});
		// The verdict is orientation only: no writer, memo or outline prompt
		// carries it, and the report does not state it.
		for (const entry of [
			...fakes.models.writer.prompts,
			...fakes.models.control.prompts,
			...fakes.models.researcher.prompts,
		]) {
			expect(entry.prompt).not.toContain("PARENT VERDICT");
		}
		expect(fakes.prose).not.toContain("PARENT VERDICT");
		expect(fakes.prose).not.toContain("99 GW");
	});

	it("rechecks an aged time-sensitive source live: confirmed, changed, unreachable", async () => {
		const fakes = await run("continue", {
			seed: parentSeed({
				action: "continue",
				retrievedAt: "2026-08-01T00:00:00Z",
			}),
			freshPages: {
				[URL_IEA]: `# Solar\n\n${QUOTE_IEA} More below.`,
				[URL_BBC]:
					"Europe installed 70.2 GW of solar last year, according to grid operators.",
				[URL_HEAT]: null,
			},
		});
		// The 2019 statute is not time-sensitive and is never re-read.
		expect([...fakes.web.freshReadCalls].sort()).toEqual(
			[URL_BBC, URL_HEAT, URL_IEA].sort(),
		);
		expect(fakes.web.readCalls).not.toContain(URL_LAW);
		expect(fakes.result.diagnostics.seed).toMatchObject({
			trusted: 1,
			rechecked: 3,
			confirmed: 1,
			changed: 1,
			dropped: 1,
		});
		// Confirmed: still cited. Changed: the old quote is gone, the fresh read
		// filed a new one. Unreachable: dropped, and researched again in round one.
		expect(fakes.prose).toContain(QUOTE_IEA);
		expect(fakes.prose).not.toContain(QUOTE_BBC);
		expect(fakes.prose).not.toContain(QUOTE_HEAT);
		expect(fakes.prose).toContain(QUOTE_FRESH);
		const readStage = fakes.models.researcher.prompts.find(
			(entry) =>
				entry.stage.startsWith("v3:read:s") && entry.prompt.includes("70.2 GW"),
		);
		expect(JSON.parse(readStage?.prompt ?? "{}").goal).toBe(
			"How did EU solar and heat pumps change in 2025?",
		);
		expect(fakes.web.searchCalls.map((call) => call.question)).toContain(
			"EU heat pump sales change 2026",
		);
		// The heartbeat said what it was doing.
		expect(
			fakes.heartbeats.some(
				(entry) =>
					entry.phase === "research" &&
					entry.next === "Re-checking 3 sources from the previous report",
			),
		).toBe(true);
	});

	it("Revise rechecks every time-sensitive source whatever its age, and seeds no memo", async () => {
		const fakes = await run("revise", {
			seed: parentSeed({ action: "revise" }),
			freshPages: {
				[URL_IEA]: QUOTE_IEA,
				[URL_BBC]: QUOTE_BBC,
				[URL_HEAT]: QUOTE_HEAT,
			},
		});
		expect(fakes.web.freshReadCalls).toHaveLength(3);
		expect(fakes.result.diagnostics.seed).toMatchObject({
			action: "revise",
			trusted: 1,
			rechecked: 3,
			confirmed: 3,
			dropped: 0,
		});
		expect(roundOneMemo(fakes).previousMemo).toBeNull();
		// The outline still sees the parent's structure (ADR 0036 branch 19).
		const outlinePrompt = fakes.models.control.prompts.find((entry) =>
			entry.stage.startsWith("v3:outline:"),
		);
		expect(outlinePrompt?.prompt).toContain("Additions held at 65.1 GW");
		const askPrompt = JSON.parse(fakes.models.ask.prompts[0]?.prompt ?? "{}");
		expect(askPrompt.parent.action).toBe("revise");
		expect(askPrompt.instruction).toBe("Now look at heat pumps too");
	});

	it("drops time-sensitive sources past the recheck budget, and never cites them", async () => {
		const fakes = await run("continue", {
			seed: parentSeed({
				action: "continue",
				retrievedAt: "2026-08-01T00:00:00Z",
				citedSourceIds: ["s2"],
			}),
			freshPages: { [URL_BBC]: QUOTE_BBC },
			// One question × one page: a budget of one live re-read.
			profileOverrides: { pagesPerQuestion: 1, subQuestionsPerRound: 1 },
		});
		expect(fakes.web.freshReadCalls).toEqual([URL_BBC]);
		expect(fakes.result.diagnostics.seed).toMatchObject({
			rechecked: 1,
			confirmed: 1,
			dropped: 2,
		});
		expect(fakes.prose).toContain(QUOTE_BBC);
		expect(fakes.prose).not.toContain(QUOTE_IEA);
		expect(fakes.prose).not.toContain(QUOTE_HEAT);
	});

	it("Fork re-researches: no parent bank, a searched web, and the inherited documents re-read", async () => {
		const fakes = await run("fork", {
			seed: {
				...parentSeed({
					action: "fork",
					localDisplayArtifactIds: ["art-meter"],
				}),
				// Even when the loader hands one over, a Fork uses no bank.
			},
			hits: [{ url: URL_IEA, title: "IEA" }],
			pages: { [URL_IEA]: "page body" },
			local: {
				documents: [
					{
						displayArtifactId: "art-meter",
						title: "Meter log.pdf",
						origin: "inherited",
					},
				],
				passages: {
					"art-meter": [
						"Our household ran a 9 kW heat pump through the 2025 winter.",
					],
				},
			},
		});
		expect(fakes.local.resolveCalls[0]?.inheritedDisplayArtifactIds).toEqual([
			"art-meter",
		]);
		expect(fakes.local.passageCalls).toHaveLength(1);
		expect(fakes.web.searchCalls.length).toBeGreaterThan(0);
		expect(fakes.web.freshReadCalls).toEqual([]);
		expect(fakes.prose).not.toContain(QUOTE_BBC);
		expect(fakes.prose).not.toContain(QUOTE_HEAT);
		expect(fakes.result.diagnostics.seed).toMatchObject({
			action: "fork",
			sourcesSeeded: 0,
			quotesSeeded: 0,
		});
		const askPrompt = JSON.parse(fakes.models.ask.prompts[0]?.prompt ?? "{}");
		expect(askPrompt.parent).toEqual({
			action: "fork",
			title: "EU solar additions, 2025",
			verdict: PARENT_VERDICT,
			headings: [],
		});
		expect(roundOneMemo(fakes).previousMemo).toBeNull();
	});

	it("reads a v1 parent's report URLs as seed pages and hands its headings to the ask", async () => {
		const validation = validateGeneratedDocumentSource(
			structuredClone(STORED_V1_SOURCE),
		);
		if (!validation.ok) throw new Error("the stored v1 fixture must validate");
		const report = extractAtlasV3ParentReport(validation.source);
		const fakes = await run("continue", {
			seed: {
				parentJobId: "parent-v1",
				action: "continue",
				parentPipelineVersion: 1,
				parentCompletedAt: "2026-06-19T00:00:00.000Z",
				report,
				v3: null,
				localDisplayArtifactIds: [],
			},
			pages: {
				"https://example.com/docs": "vendor docs body",
				"https://example.com/audit": "audit body",
			},
		});
		expect(fakes.web.readCalls).toEqual([
			"https://example.com/docs",
			"https://example.com/audit",
		]);
		// Seed pages are read now, not rechecked: they were never trusted.
		expect(fakes.web.freshReadCalls).toEqual([]);
		expect(fakes.result.diagnostics.seed).toMatchObject({
			parentPipelineVersion: 1,
			seedPagesRead: 2,
			sourcesSeeded: 0,
		});
		const askPrompt = JSON.parse(fakes.models.ask.prompts[0]?.prompt ?? "{}");
		expect(askPrompt.parent.headings).toEqual(["Risks"]);
		expect(askPrompt.parent.title).toBe("Enterprise Search Atlas");
		expect(fakes.prose).toContain(QUOTE_FRESH);
	});

	it("does not recheck again on a retry that already has its round-0 checkpoint", async () => {
		const seed = parentSeed({
			action: "continue",
			retrievedAt: "2026-08-01T00:00:00Z",
		});
		const freshPages = {
			[URL_IEA]: QUOTE_IEA,
			[URL_BBC]: QUOTE_BBC,
			[URL_HEAT]: null,
		};
		const first = await run("continue", { seed, freshPages });
		expect(first.web.freshReadCalls).toHaveLength(3);
		const resumable = first.checkpoints.filter(
			(entry) => entry.roundNumber === 1 || entry.roundNumber === 10,
		);
		expect(resumable).toHaveLength(2);
		const retry = await run("continue", {
			seed,
			freshPages,
			loadCheckpoints: resumable,
		});
		expect(retry.web.freshReadCalls).toEqual([]);
		expect(retry.result.diagnostics.seed).toEqual(
			first.result.diagnostics.seed,
		);
		// The unreachable source's hint still reaches round one.
		expect(retry.web.searchCalls.map((call) => call.question)).toContain(
			"EU heat pump sales change 2026",
		);
	});

	it("snapshots the capped bank on the verify checkpoint and the cited sources on the render one", async () => {
		const fakes = await run("continue", {
			seed: parentSeed({ action: "continue" }),
		});
		const verify = fakes.checkpoints.find((entry) => entry.roundNumber === 24);
		const render = fakes.checkpoints.find((entry) => entry.roundNumber === 25);
		const bank = (verify?.checkpoint as { data: { bank: AtlasV3EvidenceBank } })
			.data.bank;
		expect(bank.quotes.map((quote) => quote.text)).toContain(QUOTE_IEA);
		expect(
			bank.sources.every((source) => source.seededFrom === "parent-1"),
		).toBe(true);
		const cited = (render?.checkpoint as { data: { citedSourceIds: string[] } })
			.data.citedSourceIds;
		expect(cited.length).toBeGreaterThan(0);
		expect(
			cited.every((id) => bank.sources.some((source) => source.id === id)),
		).toBe(true);
	});

	it("runs a child unseeded when the parent cannot seed it", async () => {
		const fakes = await run("continue", {
			seed: null,
			hits: [{ url: URL_IEA, title: "IEA" }],
			pages: { [URL_IEA]: "page body" },
		});
		expect(fakes.result.diagnostics.seed).toBeUndefined();
		expect(fakes.checkpoints.some((entry) => entry.roundNumber === 10)).toBe(
			false,
		);
		const askPrompt = JSON.parse(fakes.models.ask.prompts[0]?.prompt ?? "{}");
		expect(askPrompt.parent).toBeUndefined();
		expect(askPrompt.instruction).toBe("Now look at heat pumps too");
	});
});
