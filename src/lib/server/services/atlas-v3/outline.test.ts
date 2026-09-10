import { describe, expect, it } from "vitest";
import {
	addAtlasV3Claim,
	addAtlasV3Quote,
	addAtlasV3Source,
	createAtlasV3Bank,
	freezeAtlasV3Bank,
} from "./evidence-bank";
import {
	atlasV3OutlineGaps,
	bindAtlasV3Evidence,
	buildAtlasV3OutlinePrompt,
	deterministicAtlasV3Outline,
	parseAtlasV3Outline,
	parseAtlasV3Trial,
	reviseAtlasV3Outline,
	trialWriteAtlasV3Nodes,
} from "./outline";
import { fakeModel } from "./test-support";
import type { AtlasV3Ask, AtlasV3Memo } from "./types";

const ASK: AtlasV3Ask = {
	decision: "Whether EU solar growth stalled in 2025",
	implicitRequirements: ["EU-27"],
	perspectives: ["installers"],
	shape: "comparison",
	coreQuestion: "How much solar did the EU add in 2025 versus 2024?",
	title: "EU solar additions",
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
	const q1 = addAtlasV3Quote(state, {
		sourceId: iea?.id ?? "",
		text: "The EU added 65.1 GW of solar capacity in 2025, the first fall since 2016.",
		goal: "g",
	});
	const q2 = addAtlasV3Quote(state, {
		sourceId: bbc?.id ?? "",
		text: "Europe installed 65.1 GW of solar last year, according to industry data.",
		goal: "g",
	});
	const q3 = addAtlasV3Quote(state, {
		sourceId: iea?.id ?? "",
		text: "Rooftop installations fell 21% while utility-scale capacity grew.",
		goal: "g",
	});
	addAtlasV3Claim(state, {
		entity: "EU-27",
		metric: "solar additions",
		value: "65.1",
		unit: "GW",
		period: "2025",
		asOf: null,
		series: "grid-connected",
		evidenceIds: [q1?.id ?? "", q2?.id ?? ""],
	});
	addAtlasV3Claim(state, {
		entity: "EU-27",
		metric: "rooftop additions",
		value: "-21",
		unit: "%",
		period: "2025",
		asOf: null,
		series: "year on year",
		evidenceIds: [q3?.id ?? ""],
	});
	return freezeAtlasV3Bank(state);
}

const MEMO: AtlasV3Memo = {
	answerSoFar: "The EU added 65.1 GW in 2025.",
	claimIds: ["c1", "c2"],
	openQuestions: ["What did the EU add in 2024?"],
	deadEnds: [],
	budgetUsed: { searches: 3, pagesRead: 2, rounds: 1 },
};

describe("parseAtlasV3Outline", () => {
	it("reads nodes and drops claim ids the bank does not hold", () => {
		const parsed = parseAtlasV3Outline(
			JSON.stringify({
				nodes: [
					{
						id: "n1",
						title: "EU solar additions fell in 2025",
						claim: "The EU added less solar in 2025 than in 2024.",
						needs: ["2024 figure"],
						claimIds: ["c1", "c99"],
					},
				],
				cut: [{ id: "n7", reason: "no evidence" }],
			}),
			{ knownClaimIds: ["c1", "c2"], maxSections: 6 },
		);
		expect(parsed?.nodes[0].claimIds).toEqual(["c1"]);
		expect(parsed?.cut).toEqual([{ id: "n7", reason: "no evidence" }]);
	});

	it("returns null without nodes", () => {
		expect(
			parseAtlasV3Outline("{}", { knownClaimIds: [], maxSections: 6 }),
		).toBeNull();
		expect(
			parseAtlasV3Outline(JSON.stringify({ nodes: [] }), {
				knownClaimIds: [],
				maxSections: 6,
			}),
		).toBeNull();
	});

	it("caps the section count", () => {
		const parsed = parseAtlasV3Outline(
			JSON.stringify({
				nodes: Array.from({ length: 9 }, (_unused, index) => ({
					id: `n${index}`,
					title: `Section ${index}`,
					claim: "c",
				})),
			}),
			{ knownClaimIds: [], maxSections: 4 },
		);
		expect(parsed?.nodes).toHaveLength(4);
	});
});

describe("bindAtlasV3Evidence", () => {
	it("binds a node's quotes and marks it ready", () => {
		const outline = bindAtlasV3Evidence({
			nodes: [
				{ id: "n1", title: "t", claim: "c", needs: [], claimIds: ["c1"] },
			],
			bank: bank(),
			minEvidencePerNode: 2,
		});
		expect(outline.nodes[0].evidenceIds).toEqual(["e1", "e2"]);
		expect(outline.nodes[0].status).toBe("ready");
	});

	it("marks a node thin below the minimum", () => {
		const outline = bindAtlasV3Evidence({
			nodes: [
				{ id: "n1", title: "t", claim: "c", needs: [], claimIds: ["c2"] },
			],
			bank: bank(),
			minEvidencePerNode: 2,
		});
		expect(outline.nodes[0].status).toBe("thin");
	});

	it("refuses to let two sections rest on the same evidence set", () => {
		const outline = bindAtlasV3Evidence({
			nodes: [
				{ id: "n1", title: "First", claim: "c", needs: [], claimIds: ["c1"] },
				{ id: "n2", title: "Second", claim: "c", needs: [], claimIds: ["c1"] },
			],
			bank: bank(),
			minEvidencePerNode: 1,
		});
		expect(outline.nodes.map((node) => node.id)).toEqual(["n1"]);
		expect(outline.cut[0].id).toBe("n2");
		expect(outline.cut[0].reason).toContain("already belongs");
	});

	it("keeps the part of an overlapping set that is still free", () => {
		const outline = bindAtlasV3Evidence({
			nodes: [
				{ id: "n1", title: "First", claim: "c", needs: [], claimIds: ["c1"] },
				{
					id: "n2",
					title: "Second",
					claim: "c",
					needs: [],
					claimIds: ["c1", "c2"],
				},
			],
			bank: bank(),
			minEvidencePerNode: 1,
		});
		expect(outline.nodes[1].evidenceIds).toEqual(["e3"]);
	});

	it("leaves a node with no claims planned rather than cut", () => {
		const outline = bindAtlasV3Evidence({
			nodes: [{ id: "n1", title: "t", claim: "c", needs: ["x"], claimIds: [] }],
			bank: bank(),
			minEvidencePerNode: 1,
		});
		expect(outline.nodes[0].status).toBe("planned");
		expect(outline.cut).toEqual([]);
	});
});

describe("deterministicAtlasV3Outline", () => {
	it("makes one node per distinct metric", () => {
		const outline = deterministicAtlasV3Outline({
			ask: ASK,
			memo: MEMO,
			bank: bank(),
			minSections: 2,
			maxSections: 6,
			minEvidencePerNode: 1,
		});
		expect(outline.nodes).toHaveLength(2);
		expect(outline.nodes[0].title).toContain("solar additions");
	});

	it("falls back to the core question when there are no claims", () => {
		const outline = deterministicAtlasV3Outline({
			ask: ASK,
			memo: { ...MEMO, claimIds: [] },
			bank: bank(),
			minSections: 2,
			maxSections: 6,
			minEvidencePerNode: 1,
		});
		expect(outline.nodes).toHaveLength(1);
		expect(outline.nodes[0].title).toBe(ASK.coreQuestion);
	});
});

describe("reviseAtlasV3Outline", () => {
	const base = {
		ask: ASK,
		memo: MEMO,
		bank: bank(),
		language: "en" as const,
		currentDate: "2026-09-10",
		round: 1,
		minSections: 2,
		maxSections: 6,
		minEvidencePerNode: 1,
		previous: null,
	};

	it("uses the model's outline", async () => {
		const model = fakeModel({
			"v3:outline": JSON.stringify({
				nodes: [
					{
						id: "n1",
						title: "EU solar additions fell 0.7% in 2025",
						claim: "The EU added less solar in 2025 than in 2024.",
						claimIds: ["c1"],
					},
				],
			}),
		});
		const outline = await reviseAtlasV3Outline({
			...base,
			runModel: model.call,
		});
		expect(outline.nodes[0].title).toBe("EU solar additions fell 0.7% in 2025");
		expect(outline.nodes[0].evidenceIds).toEqual(["e1", "e2"]);
	});

	it("repairs a label-shaped title from the node's claim", async () => {
		const model = fakeModel({
			"v3:outline": JSON.stringify({
				nodes: [
					{
						id: "n1",
						title: "2025-ös referenciaadat",
						claim: "Rooftop demand fell while utility-scale grew.",
						claimIds: ["c2"],
					},
				],
			}),
		});
		const outline = await reviseAtlasV3Outline({
			...base,
			runModel: model.call,
		});
		expect(outline.nodes[0].title).toBe(
			"Rooftop demand fell while utility-scale grew.",
		);
	});

	it("falls back to the deterministic outline when nothing parses", async () => {
		const model = fakeModel({ "v3:outline": "no." });
		const outline = await reviseAtlasV3Outline({
			...base,
			runModel: model.call,
		});
		expect(outline.nodes.length).toBeGreaterThan(0);
	});

	it("falls back when the model's outline binds to nothing", async () => {
		const model = fakeModel({
			"v3:outline": JSON.stringify({
				nodes: [
					{ id: "n1", title: "A", claim: "a", claimIds: ["c1"] },
					{ id: "n2", title: "B", claim: "b", claimIds: ["c1"] },
				],
			}),
		});
		const outline = await reviseAtlasV3Outline({
			...base,
			runModel: model.call,
		});
		// n2 loses the overlap and is cut; n1 survives, so this is NOT a fallback.
		expect(outline.nodes.map((node) => node.id)).toEqual(["n1"]);
		expect(outline.cut.some((entry) => entry.id === "n2")).toBe(true);
	});

	it("survives a model that throws", async () => {
		const outline = await reviseAtlasV3Outline({
			...base,
			runModel: async () => {
				throw new Error("down");
			},
		});
		expect(outline.nodes.length).toBeGreaterThan(0);
	});

	it("falls back when EVERY node bound zero quotes", async () => {
		// The staging failure: the model named claim ids the bank never held, so
		// each node bound nothing, the writer wrote nothing and the job died.
		const model = fakeModel({
			"v3:outline": JSON.stringify({
				nodes: [
					{ id: "n1", title: "Population trend", claim: "a", claimIds: [] },
					{ id: "n2", title: "Survey coverage", claim: "b", claimIds: [] },
				],
			}),
		});
		const outline = await reviseAtlasV3Outline({
			...base,
			runModel: model.call,
		});
		expect(outline.nodes.some((node) => node.evidenceIds.length > 0)).toBe(
			true,
		);
	});
});

describe("parseAtlasV3Trial", () => {
	it("accepts a lead that carries a figure", () => {
		expect(
			parseAtlasV3Trial(
				JSON.stringify({
					lead: "Rooftop installations fell 21% in 2025.",
					supportable: true,
				}),
				"n1",
			)?.supportable,
		).toBe(true);
	});

	it("rejects a hollow lead even when the model says it is supportable", () => {
		expect(
			parseAtlasV3Trial(
				JSON.stringify({
					lead: "Warranty structures fundamentally shape the repair landscape.",
					supportable: true,
				}),
				"n1",
			)?.supportable,
		).toBe(false);
	});

	it("returns null with no lead", () => {
		expect(
			parseAtlasV3Trial(JSON.stringify({ supportable: true }), "n1"),
		).toBeNull();
	});
});

describe("trialWriteAtlasV3Nodes", () => {
	const outline = {
		nodes: [
			{
				id: "n1",
				title: "ready",
				claim: "c",
				needs: [],
				evidenceIds: ["e1", "e2"],
				status: "ready" as const,
			},
			{
				id: "n2",
				title: "thin",
				claim: "c",
				needs: [],
				evidenceIds: ["e3"],
				status: "thin" as const,
			},
		],
		cut: [],
	};

	it("promotes a thin node whose lead holds", async () => {
		const model = fakeModel({
			"v3:trial": JSON.stringify({
				lead: "Rooftop installations fell 21% in 2025.",
				supportable: true,
			}),
		});
		const revised = await trialWriteAtlasV3Nodes({
			outline,
			bank: bank(),
			language: "en",
			runModel: model.call,
		});
		expect(revised.nodes.map((node) => node.status)).toEqual([
			"ready",
			"ready",
		]);
		expect(revised.cut).toEqual([]);
	});

	it("cuts a thin node whose lead does not hold, with a reason", async () => {
		const model = fakeModel({
			"v3:trial": JSON.stringify({ lead: "Sources vary.", supportable: false }),
		});
		const revised = await trialWriteAtlasV3Nodes({
			outline,
			bank: bank(),
			language: "en",
			runModel: model.call,
		});
		expect(revised.nodes.map((node) => node.id)).toEqual(["n1"]);
		expect(revised.cut[0].reason).toContain("could not support");
	});

	it("never trial-writes a ready node", async () => {
		const model = fakeModel({
			"v3:trial": JSON.stringify({ lead: "x 1", supportable: true }),
		});
		await trialWriteAtlasV3Nodes({
			outline: { nodes: [outline.nodes[0]], cut: [] },
			bank: bank(),
			language: "en",
			runModel: model.call,
		});
		expect(model.stages).toEqual([]);
	});
});

describe("atlasV3OutlineGaps", () => {
	it("names what a node still needs", () => {
		expect(
			atlasV3OutlineGaps({
				nodes: [
					{
						id: "n1",
						title: "t",
						claim: "c",
						needs: ["2024 figure"],
						evidenceIds: [],
						status: "thin",
					},
					{
						id: "n2",
						title: "t",
						claim: "done",
						needs: [],
						evidenceIds: ["e1"],
						status: "ready",
					},
				],
				cut: [],
			}),
		).toEqual(["2024 figure"]);
	});
});

describe("buildAtlasV3OutlinePrompt", () => {
	it("shows the previous outline so the model revises rather than restarts", () => {
		const parsed = JSON.parse(
			buildAtlasV3OutlinePrompt({
				ask: ASK,
				memo: MEMO,
				bank: bank(),
				language: "en",
				currentDate: "2026-09-10",
				round: 2,
				minSections: 2,
				maxSections: 6,
				previous: {
					nodes: [
						{
							id: "n1",
							title: "old",
							claim: "c",
							needs: [],
							evidenceIds: [],
							status: "planned",
						},
					],
					cut: [],
				},
			}),
		);
		expect(parsed.previousOutline).toHaveLength(1);
		expect(parsed.claims).toHaveLength(2);
		expect(parsed.shape).toBe("comparison");
	});
});
