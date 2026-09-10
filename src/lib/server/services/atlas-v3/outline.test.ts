import { describe, expect, it } from "vitest";
import {
	addAtlasV3Claim,
	addAtlasV3Quote,
	addAtlasV3Source,
	createAtlasV3Bank,
	freezeAtlasV3Bank,
} from "./evidence-bank";
import { isLabelShapedTitle } from "./language-standard";
import {
	atlasV3FirstClause,
	atlasV3OutlineGaps,
	atlasV3OutlineSystem,
	bindAtlasV3Evidence,
	buildAtlasV3OutlinePrompt,
	clampAtlasV3Title,
	deterministicAtlasV3Outline,
	parseAtlasV3Outline,
	parseAtlasV3Trial,
	reviseAtlasV3Outline,
	supplementAtlasV3Outline,
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

/** Two different claims that rest on the SAME quote. */
function sharedQuoteBank() {
	const state = createAtlasV3Bank();
	const iea = addAtlasV3Source(state, {
		url: "https://iea.org/a",
		title: "IEA",
		publishedAt: "2025-12-01",
	});
	const quote = addAtlasV3Quote(state, {
		sourceId: iea?.id ?? "",
		text: "The EU added 65.1 GW of solar in 2025, as rooftop installations fell 21%.",
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
		evidenceIds: [quote?.id ?? ""],
	});
	addAtlasV3Claim(state, {
		entity: "EU-27",
		metric: "rooftop additions",
		value: "-21",
		unit: "%",
		period: "2025",
		asOf: null,
		series: "year on year",
		evidenceIds: [quote?.id ?? ""],
	});
	return freezeAtlasV3Bank(state);
}

/** Four claims on four quotes: c1..c4, each with evidence of its own. */
function fourClaimBank() {
	const state = createAtlasV3Bank();
	const source = addAtlasV3Source(state, {
		url: "https://iea.org/a",
		title: "IEA",
		publishedAt: "2025-12-01",
	});
	const metrics = [
		"list price",
		"repairability score",
		"panel brightness",
		"battery capacity",
	];
	metrics.forEach((metric, index) => {
		const quote = addAtlasV3Quote(state, {
			sourceId: source?.id ?? "",
			text: `The ${metric} of the reviewed laptop is ${index + 1} in the published table.`,
			goal: "g",
		});
		addAtlasV3Claim(state, {
			entity: "Framework 13",
			metric,
			value: `${index + 1}`,
			unit: null,
			period: null,
			asOf: null,
			series: null,
			evidenceIds: [quote?.id ?? ""],
		});
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

	it("merges two sections that rest on the same claims", () => {
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
		expect(outline.cut[0].reason).toBe("merged into First");
	});

	it("gives the merged node the union of both claim sets", () => {
		const outline = bindAtlasV3Evidence({
			nodes: [
				{ id: "n1", title: "First", claim: "c", needs: [], claimIds: ["c1"] },
				{
					id: "n2",
					title: "Second",
					claim: "c",
					needs: ["a gap"],
					claimIds: ["c1", "c2"],
				},
			],
			bank: bank(),
			minEvidencePerNode: 1,
		});
		expect(outline.nodes).toHaveLength(1);
		expect(outline.nodes[0].evidenceIds).toEqual(["e1", "e2", "e3"]);
		expect(outline.nodes[0].needs).toEqual(["a gap"]);
	});

	it("keeps two sections that legitimately share half their claims", () => {
		const outline = bindAtlasV3Evidence({
			nodes: [
				{
					id: "n1",
					title: "Price favours the Dell",
					claim: "The Dell XPS 13 costs less than the Framework 13.",
					needs: [],
					claimIds: ["c1", "c2"],
				},
				{
					id: "n2",
					title: "Repairability favours the Framework",
					claim: "The Framework 13 scores 10 out of 10 on repairability.",
					needs: [],
					claimIds: ["c1", "c3"],
				},
			],
			bank: fourClaimBank(),
			minEvidencePerNode: 1,
		});
		expect(outline.nodes.map((node) => node.id)).toEqual(["n1", "n2"]);
	});

	it("keeps a lead node resting on one shared claim", () => {
		const outline = bindAtlasV3Evidence({
			nodes: [
				{
					id: "n1",
					title: "The verdict: buy the Framework",
					claim:
						"The Framework 13 is the better buy for a repair-minded owner.",
					needs: [],
					claimIds: ["c1"],
				},
				{
					id: "n2",
					title: "Screen quality favours the Dell",
					claim: "The Dell XPS 13 ships a brighter OLED panel.",
					needs: [],
					claimIds: ["c1", "c2", "c3"],
				},
			],
			bank: fourClaimBank(),
			minEvidencePerNode: 1,
		});
		expect(outline.nodes.map((node) => node.id)).toEqual(["n1", "n2"]);
	});

	it("keeps a 2024 section apart from its 2025 twin", () => {
		const outline = bindAtlasV3Evidence({
			nodes: [
				{
					id: "n1",
					title: "2025 additions fell",
					claim: "Solar additions across the EU fell in 2025.",
					needs: [],
					claimIds: ["c1"],
				},
				{
					id: "n2",
					title: "2024 additions rose",
					claim: "Solar additions across the EU rose in 2024.",
					needs: [],
					claimIds: ["c2"],
				},
			],
			bank: bank(),
			minEvidencePerNode: 1,
		});
		expect(outline.nodes.map((node) => node.id)).toEqual(["n1", "n2"]);
	});

	it("still merges one section written twice under two names", () => {
		const outline = bindAtlasV3Evidence({
			nodes: [
				{
					id: "n1",
					title: "Obligations for providers of GPAI models — entry into force",
					claim:
						"Obligations for providers of general-purpose AI models enter into force.",
					needs: [],
					claimIds: ["c1"],
				},
				{
					id: "n2",
					title: "Providers of general-purpose AI models — entry into force",
					claim:
						"Obligations for providers of general-purpose AI models enter into force.",
					needs: [],
					claimIds: ["c2"],
				},
			],
			bank: bank(),
			minEvidencePerNode: 1,
		});
		expect(outline.nodes.map((node) => node.id)).toEqual(["n1"]);
		expect(outline.cut[0].reason).toContain("merged into");
	});

	it("keeps two DIFFERENT arguments that rest on one quote set", () => {
		// One quote states both figures. Under the old exclusivity rule the second
		// section was cut and the report lost a third of its depth; the two
		// sections argue different things, so both survive and both cite it.
		const outline = bindAtlasV3Evidence({
			nodes: [
				{
					id: "n1",
					title: "Additions fell",
					claim: "The bloc added less than the year before.",
					needs: [],
					claimIds: ["c1"],
				},
				{
					id: "n2",
					title: "Rooftop demand cooled",
					claim: "Household orders thinned as subsidies ended.",
					needs: [],
					claimIds: ["c2"],
				},
			],
			bank: sharedQuoteBank(),
			minEvidencePerNode: 1,
		});
		expect(outline.nodes.map((node) => node.id)).toEqual(["n1", "n2"]);
		expect(outline.nodes[0].evidenceIds).toEqual(["e1"]);
		expect(outline.nodes[1].evidenceIds).toEqual(["e1"]);
		expect(outline.cut).toEqual([]);
	});

	it("cuts a section that repeats an earlier one's argument and quotes", () => {
		const outline = bindAtlasV3Evidence({
			nodes: [
				{
					id: "n1",
					title: "Rooftop additions fell 21%",
					claim: "Rooftop solar additions fell 21% across the bloc.",
					needs: [],
					claimIds: ["c2"],
				},
				{
					id: "n2",
					title: "Rooftop solar additions fell",
					claim: "Rooftop additions across the bloc fell 21%.",
					needs: [],
					claimIds: ["c2"],
				},
			],
			bank: sharedQuoteBank(),
			minEvidencePerNode: 1,
			mergeDuplicates: false,
		});
		expect(outline.nodes.map((node) => node.id)).toEqual(["n1"]);
		expect(outline.cut[0].reason).toContain("already makes this argument");
	});

	it("gives a node EVERY quote of its claims, shared or not", () => {
		const outline = bindAtlasV3Evidence({
			nodes: [
				{
					id: "n1",
					title: "First",
					claim: "aa bb",
					needs: [],
					claimIds: ["c1"],
				},
				{
					id: "n2",
					title: "Second",
					claim: "cc dd",
					needs: [],
					claimIds: ["c1", "c2"],
				},
			],
			bank: bank(),
			minEvidencePerNode: 2,
			mergeDuplicates: false,
		});
		expect(outline.nodes[0].evidenceIds).toEqual(["e1", "e2"]);
		expect(outline.nodes[1].evidenceIds).toEqual(["e1", "e2", "e3"]);
		// Status comes from the FULL set, not from what was left over.
		expect(outline.nodes.map((node) => node.status)).toEqual([
			"ready",
			"ready",
		]);
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

	/**
	 * The writer is handed only `maxEvidencePerSection` of a node's quotes, and
	 * a node now carries every quote of every claim it named. Truncating in the
	 * order the model happened to list its claim ids would hand the writer the
	 * single-source quotes and drop the corroborated ones.
	 */
	it("leads with the best-supported claim's quotes, not the model's order", () => {
		const outline = bindAtlasV3Evidence({
			nodes: [
				{
					id: "n1",
					title: "First",
					claim: "aa bb",
					needs: [],
					// The one-quote claim first; the two-publisher claim second.
					claimIds: ["c2", "c1"],
				},
			],
			bank: bank(),
			minEvidencePerNode: 1,
		});
		expect(outline.nodes[0].evidenceIds).toEqual(["e1", "e2", "e3"]);
	});
});

describe("supplementAtlasV3Outline", () => {
	/** One metric read twice: 65.1 GW for 2025 bound, 60.4 GW for 2024 not. */
	function twinMetricBank() {
		const state = createAtlasV3Bank();
		const iea = addAtlasV3Source(state, {
			url: "https://iea.org/a",
			title: "IEA",
			publishedAt: "2025-12-01",
		});
		const quote = (text: string) =>
			addAtlasV3Quote(state, { sourceId: iea?.id ?? "", text, goal: "g" })
				?.id ?? "";
		const first = quote("The EU added 65.1 GW of solar capacity in 2025.");
		const second = quote("The bloc added 60.4 GW of solar capacity in 2024.");
		const base = {
			entity: "EU-27",
			metric: "solar additions",
			unit: "GW",
			asOf: null,
			series: null,
		};
		addAtlasV3Claim(state, {
			...base,
			value: "65.1",
			period: "2025",
			evidenceIds: [first],
		});
		addAtlasV3Claim(state, {
			...base,
			value: "60.4",
			period: "2024",
			evidenceIds: [second],
		});
		return freezeAtlasV3Bank(state);
	}

	/**
	 * A group is eligible precisely because it holds a quote no node bound, so
	 * its ids are never a subset of a bound node's and the same-argument test
	 * never fires on it. Without the metric rule the floor was met with "EU-27:
	 * solar additions 60.4 GW" appended under "EU-27: solar additions 65.1 GW".
	 */
	it("does not append a second reading of a measurement a section argues", () => {
		const bank = twinMetricBank();
		const outline = bindAtlasV3Evidence({
			nodes: [
				{
					id: "n1",
					title: "EU-27: solar additions 65.1 GW",
					claim: "EU-27: solar additions 65.1 GW",
					needs: [],
					claimIds: ["c1"],
				},
			],
			bank,
			minEvidencePerNode: 1,
		});
		const supplemented = supplementAtlasV3Outline({
			outline,
			bank,
			minSections: 3,
			maxSections: 6,
			minEvidencePerNode: 1,
		});
		expect(supplemented.nodes).toHaveLength(1);
		expect(supplemented.supplemented).toBeUndefined();
	});

	it("never appends past maxSections", () => {
		const outline = bindAtlasV3Evidence({
			nodes: [{ id: "n1", title: "t", claim: "c", needs: [], claimIds: [] }],
			bank: bank(),
			minEvidencePerNode: 1,
		});
		const supplemented = supplementAtlasV3Outline({
			outline,
			bank: bank(),
			minSections: 5,
			maxSections: 2,
			minEvidencePerNode: 1,
		});
		expect(supplemented.nodes).toHaveLength(2);
		expect(supplemented.supplemented).toBe(1);
		// A supplemented node needs nothing and cannot take a model node's id.
		expect(supplemented.nodes[1].needs).toEqual([]);
		expect(supplemented.nodes[1].id).toBe("n2");
	});
});

describe("clampAtlasV3Title / atlasV3FirstClause", () => {
	it("cuts at a word boundary, never mid-word", () => {
		const long =
			"Utility-scale solar additions grew twelve percent across the bloc during 2025, marking an increase";
		const clamped = clampAtlasV3Title(long);
		expect(clamped.length).toBeLessThanOrEqual(90);
		expect(long.startsWith(clamped)).toBe(true);
		// The character the cut stopped at is a boundary, not the middle of a word.
		expect(long.slice(clamped.length, clamped.length + 1)).toBe(" ");
		expect(clamped.endsWith("incr")).toBe(false);
	});

	it("strips trailing punctuation the cut left behind", () => {
		expect(clampAtlasV3Title("The rate rose, ")).toBe("The rate rose");
	});

	it("takes the first clause of a claim", () => {
		expect(
			atlasV3FirstClause(
				"Rooftop demand cooled, and utility-scale capacity grew 12%.",
			),
		).toBe("Rooftop demand cooled");
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

	it("titles a node with the finding, not with `entity — metric`", () => {
		const outline = deterministicAtlasV3Outline({
			ask: ASK,
			memo: MEMO,
			bank: bank(),
			minSections: 2,
			maxSections: 6,
			minEvidencePerNode: 1,
		});
		expect(outline.nodes[0].title).toBe("EU-27: solar additions 65.1 GW");
		expect(outline.nodes.every((node) => !isLabelShapedTitle(node.title))).toBe(
			true,
		);
	});

	/**
	 * The deterministic outline is one node per distinct `entity — metric`
	 * already, so the duplicate merge must not run over it: two dates of one
	 * regulation share "EU AI Act", "date" and the value, and the fuzzy word
	 * rule read that as one section written twice.
	 */
	it("keeps two metrics of one entity as two sections", () => {
		const state = createAtlasV3Bank();
		const lex = addAtlasV3Source(state, {
			url: "https://eur-lex.europa.eu/ai-act",
			title: "AI Act",
			publishedAt: "2024-07-12",
		});
		const commission = addAtlasV3Source(state, {
			url: "https://digital-strategy.ec.europa.eu/ai-act",
			title: "AI Act timeline",
			publishedAt: "2025-02-01",
		});
		const first = addAtlasV3Quote(state, {
			sourceId: lex?.id ?? "",
			text: "Obligations for providers of general-purpose AI models apply from 2 August 2025.",
			goal: "g",
		});
		const second = addAtlasV3Quote(state, {
			sourceId: commission?.id ?? "",
			text: "The Commission's enforcement powers apply from 2 August 2025.",
			goal: "g",
		});
		addAtlasV3Claim(state, {
			entity: "EU AI Act",
			metric: "obligations start date",
			value: "2 August 2025",
			unit: null,
			period: null,
			asOf: null,
			series: null,
			evidenceIds: [first?.id ?? ""],
		});
		addAtlasV3Claim(state, {
			entity: "EU AI Act",
			metric: "enforcement start date",
			value: "2 August 2025",
			unit: null,
			period: null,
			asOf: null,
			series: null,
			evidenceIds: [second?.id ?? ""],
		});
		const outline = deterministicAtlasV3Outline({
			ask: ASK,
			memo: { ...MEMO, claimIds: ["c1", "c2"] },
			bank: freezeAtlasV3Bank(state),
			minSections: 2,
			maxSections: 6,
			minEvidencePerNode: 1,
		});
		expect(outline.nodes).toHaveLength(2);
		expect(outline.cut).toEqual([]);
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

	it("keeps the label rather than shipping an empty heading", async () => {
		const model = fakeModel({
			"v3:outline": JSON.stringify({
				nodes: [
					{
						id: "n1",
						title: "2025-ös referenciaadat",
						// A claim whose first clause is empty; the repair has nothing.
						claim: ", rooftop demand fell while utility-scale grew.",
						claimIds: ["c2"],
					},
				],
			}),
		});
		const outline = await reviseAtlasV3Outline({
			...base,
			runModel: model.call,
		});
		expect(outline.nodes[0].title).toBe("2025-ös referenciaadat");
	});

	it("falls back to the deterministic outline when nothing parses", async () => {
		const model = fakeModel({ "v3:outline": "no." });
		const outline = await reviseAtlasV3Outline({
			...base,
			runModel: model.call,
		});
		expect(outline.nodes.length).toBeGreaterThan(0);
	});

	it("merges one section written twice and supplements the floor", async () => {
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
		// The two nodes name one claim set, so they are one section; the floor of
		// two is then met from the claim no node bound.
		expect(outline.cut.some((entry) => entry.id === "n2")).toBe(true);
		expect(outline.nodes).toHaveLength(2);
		expect(outline.nodes[0].id).toBe("n1");
		expect(outline.supplemented).toBe(1);
		expect(outline.nodes[1].evidenceIds).toEqual(["e3"]);
	});

	it("supplements up to minSections from the claims no node bound", async () => {
		const model = fakeModel({
			"v3:outline": JSON.stringify({
				nodes: [
					{
						id: "n1",
						title: "EU solar additions fell in 2025",
						claim: "The EU added less solar in 2025 than in 2024.",
						claimIds: ["c1"],
					},
				],
			}),
		});
		const outline = await reviseAtlasV3Outline({
			...base,
			minSections: 2,
			runModel: model.call,
		});
		expect(outline.nodes).toHaveLength(2);
		expect(outline.supplemented).toBe(1);
		// Titled as the deterministic outline titles its own nodes.
		expect(outline.nodes[1].title).toBe("EU-27: rooftop additions -21 %");
	});

	it("supplements nothing when every claim is already bound", async () => {
		const model = fakeModel({
			"v3:outline": JSON.stringify({
				nodes: [
					{
						id: "n1",
						title: "EU solar additions fell in 2025",
						claim: "The EU added less solar in 2025 than in 2024.",
						claimIds: ["c1", "c2"],
					},
				],
			}),
		});
		const outline = await reviseAtlasV3Outline({
			...base,
			minSections: 4,
			runModel: model.call,
		});
		expect(outline.nodes).toHaveLength(1);
		expect(outline.supplemented).toBeUndefined();
	});

	it("states the section range and the claim count in its system prompt", () => {
		expect(
			atlasV3OutlineSystem({
				language: "en",
				minSections: 5,
				maxSections: 8,
				claimCount: 74,
			}),
		).toContain("Plan between 5 and 8 sections; the evidence holds 74 claims.");
		expect(
			atlasV3OutlineSystem({
				language: "hu",
				minSections: 4,
				maxSections: 6,
				claimCount: 12,
			}),
		).toContain("Tervezz 4 és 6 közötti számú szakaszt");
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
