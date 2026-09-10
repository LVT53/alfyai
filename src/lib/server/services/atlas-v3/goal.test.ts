import { describe, expect, it } from "vitest";
import { getAtlasV3ProfileConfig } from "./config";
import {
	addAtlasV3Claim,
	addAtlasV3Quote,
	addAtlasV3Source,
	createAtlasV3Bank,
	freezeAtlasV3Bank,
} from "./evidence-bank";
import { atlasV3GoalLimitations, runAtlasV3GoalTest } from "./goal";
import type { AtlasV3Memo, AtlasV3Outline } from "./types";

/** A bank whose c1 has two publishers and whose c2 has one. */
function bank() {
	const state = createAtlasV3Bank();
	const iea = addAtlasV3Source(state, {
		url: "https://iea.org/a",
		title: "IEA",
		publishedAt: null,
	});
	const bbc = addAtlasV3Source(state, {
		url: "https://bbc.com/a",
		title: "BBC",
		publishedAt: null,
	});
	const q1 = addAtlasV3Quote(state, {
		sourceId: iea?.id ?? "",
		text: "The EU added 65.1 GW of solar capacity in 2025, industry data show.",
		goal: "g",
	});
	const q2 = addAtlasV3Quote(state, {
		sourceId: bbc?.id ?? "",
		text: "Europe installed 65.1 GW of solar last year, according to the same data.",
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
		metric: "rooftop",
		value: "-21",
		unit: "%",
		period: "2025",
		asOf: null,
		series: "yoy",
		evidenceIds: [q3?.id ?? ""],
	});
	return freezeAtlasV3Bank(state);
}

const MEMO: AtlasV3Memo = {
	answerSoFar: "a",
	claimIds: ["c1", "c2"],
	openQuestions: ["What did the EU add in 2024?"],
	deadEnds: [],
	budgetUsed: { searches: 3, pagesRead: 2, rounds: 1 },
};

const READY: AtlasV3Outline = {
	nodes: [
		{
			id: "n1",
			title: "t",
			claim: "c",
			needs: [],
			evidenceIds: ["e1", "e2"],
			status: "ready",
		},
	],
	cut: [],
};

const config = getAtlasV3ProfileConfig("overview", {
	rounds: 2,
	minEvidencePerNode: 2,
});

describe("runAtlasV3GoalTest", () => {
	it("passes when the core is corroborated and no node is thin", () => {
		const verdict = runAtlasV3GoalTest({
			memo: MEMO,
			outline: READY,
			bank: bank(),
			config,
			roundsRun: 1,
		});
		expect(verdict.passed).toBe(true);
		expect(verdict.abstain).toBe(false);
		expect(verdict.gaps).toEqual([]);
	});

	it("fails and names the gap when a node is thin", () => {
		const verdict = runAtlasV3GoalTest({
			memo: MEMO,
			outline: {
				nodes: [
					...READY.nodes,
					{
						id: "n2",
						title: "t",
						claim: "Rooftop demand drove the fall",
						needs: ["rooftop share by member state"],
						evidenceIds: ["e3"],
						status: "thin",
					},
				],
				cut: [],
			},
			bank: bank(),
			config,
			roundsRun: 1,
		});
		expect(verdict.passed).toBe(false);
		expect(verdict.thinNodeIds).toEqual(["n2"]);
		expect(verdict.gaps).toContain("rooftop share by member state");
		expect(verdict.exhausted).toBe(false);
	});

	it("asks for a second publisher for the SAME series, not the metric alone", () => {
		const verdict = runAtlasV3GoalTest({
			memo: { ...MEMO, claimIds: ["c2"] },
			outline: READY,
			bank: bank(),
			config,
			roundsRun: 1,
		});
		expect(verdict.coreCorroborated).toBe(false);
		expect(verdict.gaps[0]).toContain("yoy");
		expect(verdict.gaps[0]).toContain("independent source");
	});

	it("reports exhaustion without abstaining when there is something to publish", () => {
		const verdict = runAtlasV3GoalTest({
			memo: { ...MEMO, claimIds: ["c2"] },
			outline: READY,
			bank: bank(),
			config,
			roundsRun: 2,
		});
		expect(verdict.exhausted).toBe(true);
		expect(verdict.abstain).toBe(false);
		expect(verdict.reason).toContain("budget is spent");
	});

	it("abstains when the budget is spent and nothing was found", () => {
		const verdict = runAtlasV3GoalTest({
			memo: { ...MEMO, claimIds: [] },
			outline: {
				nodes: [
					{
						id: "n1",
						title: "t",
						claim: "c",
						needs: ["anything at all"],
						evidenceIds: [],
						status: "planned",
					},
				],
				cut: [],
			},
			bank: bank(),
			config,
			roundsRun: 2,
		});
		expect(verdict.abstain).toBe(true);
		expect(verdict.reason).toContain("no publisher of a corroborating tier");
	});

	it("abstains when the core figure rests only on aggregators", () => {
		const state = createAtlasV3Bank();
		const msn = addAtlasV3Source(state, {
			url: "https://msn.com/a",
			title: "MSN",
			publishedAt: null,
		});
		const quote = addAtlasV3Quote(state, {
			sourceId: msn?.id ?? "",
			text: "The EU added 65.1 GW of solar capacity in 2025, one outlet reported.",
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
		const aggregatorBank = freezeAtlasV3Bank(state);
		const verdict = runAtlasV3GoalTest({
			memo: { ...MEMO, claimIds: ["c1"] },
			outline: {
				nodes: [
					{
						id: "n1",
						title: "t",
						claim: "c",
						needs: [],
						evidenceIds: ["e1", "e1"],
						status: "ready",
					},
				],
				cut: [],
			},
			bank: aggregatorBank,
			config,
			roundsRun: 2,
		});
		expect(verdict.abstain).toBe(true);
	});

	it("ignores a cut node when judging coverage", () => {
		const verdict = runAtlasV3GoalTest({
			memo: MEMO,
			outline: {
				nodes: [
					...READY.nodes,
					{
						id: "n2",
						title: "t",
						claim: "c",
						needs: [],
						evidenceIds: [],
						status: "cut",
					},
				],
				cut: [],
			},
			bank: bank(),
			config,
			roundsRun: 1,
		});
		expect(verdict.passed).toBe(true);
	});

	it("respects a raised independence requirement", () => {
		const verdict = runAtlasV3GoalTest({
			memo: MEMO,
			outline: READY,
			bank: bank(),
			config,
			roundsRun: 1,
			independentPublishers: 3,
		});
		expect(verdict.coreCorroborated).toBe(false);
	});
});

describe("atlasV3GoalLimitations", () => {
	it("says what could not be established and why, never a cut count", () => {
		const verdict = runAtlasV3GoalTest({
			memo: {
				...MEMO,
				claimIds: ["c2"],
				deadEnds: ["no member-state breakdown"],
			},
			outline: {
				nodes: [
					{
						id: "n2",
						title: "Rooftop share",
						claim: "Rooftop demand drove the fall",
						needs: ["rooftop share by member state"],
						evidenceIds: [],
						status: "planned",
					},
				],
				cut: [{ id: "n3", title: "Warranty", reason: "no evidence was found" }],
			},
			bank: bank(),
			config,
			roundsRun: 2,
		});
		const limitations = atlasV3GoalLimitations({
			verdict,
			outline: {
				nodes: [
					{
						id: "n2",
						title: "Rooftop share",
						claim: "Rooftop demand drove the fall",
						needs: ["rooftop share by member state"],
						evidenceIds: [],
						status: "planned",
					},
				],
				cut: [{ id: "n3", title: "Warranty", reason: "no evidence was found" }],
			},
			memo: { ...MEMO, deadEnds: ["no member-state breakdown"] },
		});
		const rendered = limitations.map(
			(entry) => `${entry.subject}: ${entry.reason}`,
		);
		expect(rendered.some((line) => line.includes("central figure"))).toBe(true);
		expect(
			rendered.some((line) => line.includes("rooftop share by member state")),
		).toBe(true);
		expect(rendered.some((line) => line.includes("Warranty"))).toBe(true);
		expect(
			rendered.every((line) => !line.includes("sentences were removed")),
		).toBe(true);
	});

	it("names the core claim instead of `the central figure`", () => {
		const outline: AtlasV3Outline = { nodes: [], cut: [] };
		const verdict = runAtlasV3GoalTest({
			memo: { ...MEMO, claimIds: ["c2"] },
			outline,
			bank: bank(),
			config,
			roundsRun: 2,
		});
		const limitations = atlasV3GoalLimitations({
			verdict,
			outline,
			memo: { ...MEMO, claimIds: ["c2"] },
			bank: bank(),
		});
		expect(limitations[0].subject).toBe("EU-27: rooftop -21 %");
	});

	it("falls back to `the central figure` with no bank", () => {
		const outline: AtlasV3Outline = { nodes: [], cut: [] };
		const verdict = runAtlasV3GoalTest({
			memo: { ...MEMO, claimIds: ["c2"] },
			outline,
			bank: bank(),
			config,
			roundsRun: 2,
		});
		expect(
			atlasV3GoalLimitations({
				verdict,
				outline,
				memo: { ...MEMO, claimIds: ["c2"] },
			})[0].subject,
		).toBe("the central figure");
	});

	it("uses the node TITLE when its claim is label-shaped", () => {
		const outline: AtlasV3Outline = {
			nodes: [
				{
					id: "n2",
					title: "Providers must publish a training-data summary",
					claim: "providers — compliance deadline for pre-2025 models",
					needs: [],
					evidenceIds: [],
					status: "planned",
				},
			],
			cut: [],
		};
		const verdict = runAtlasV3GoalTest({
			memo: MEMO,
			outline,
			bank: bank(),
			config,
			roundsRun: 2,
		});
		const limitations = atlasV3GoalLimitations({
			verdict,
			outline,
			memo: MEMO,
			bank: bank(),
		});
		expect(
			limitations.some(
				(entry) =>
					entry.subject === "Providers must publish a training-data summary",
			),
		).toBe(true);
		expect(limitations.every((entry) => !entry.subject.includes(" — "))).toBe(
			true,
		);
	});
});
