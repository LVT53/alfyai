import { describe, expect, it } from "vitest";
import {
	addAtlasV3Claim,
	addAtlasV3Quote,
	addAtlasV3Source,
	createAtlasV3Bank,
	freezeAtlasV3Bank,
} from "./evidence-bank";
import { fakeModel } from "./test-support";
import type { AtlasV3Memo } from "./types";
import {
	buildAtlasV3MemoPrompt,
	deterministicAtlasV3Memo,
	mergeAtlasV3Memos,
	parseAtlasV3Memo,
	rewriteAtlasV3Memo,
} from "./workspace";

const BUDGET = { searches: 3, pagesRead: 2, rounds: 1 };

function bankWithClaims() {
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
		metric: "solar additions",
		value: "65.6",
		unit: "GW",
		period: "2024",
		asOf: null,
		series: "grid-connected",
		evidenceIds: [q1?.id ?? ""],
	});
	return state;
}

describe("parseAtlasV3Memo", () => {
	it("keeps only claim ids the bank actually holds", () => {
		const memo = parseAtlasV3Memo(
			JSON.stringify({
				answerSoFar: "The EU added 65.1 GW in 2025.",
				claimIds: ["c1", "c99", "c1", "c2"],
				openQuestions: ["What about 2024?"],
				deadEnds: [],
			}),
			{ knownClaimIds: ["c1", "c2"], budgetUsed: BUDGET },
		);
		expect(memo?.claimIds).toEqual(["c1", "c2"]);
		expect(memo?.budgetUsed).toEqual(BUDGET);
	});

	it("returns null without an answer", () => {
		expect(
			parseAtlasV3Memo(JSON.stringify({ claimIds: ["c1"] }), {
				knownClaimIds: ["c1"],
				budgetUsed: BUDGET,
			}),
		).toBeNull();
	});
});

describe("deterministicAtlasV3Memo", () => {
	it("joins the note summaries and ranks claims best-supported first", () => {
		const state = bankWithClaims();
		const memo = deterministicAtlasV3Memo({
			previous: null,
			notes: [
				{
					subQuestion: "2025",
					summary: "The EU added 65.1 GW in 2025.",
					quotes: [],
					claims: [],
					openQuestions: ["2024?"],
					deadEnds: [],
					searches: 1,
					pagesRead: 1,
					error: null,
				},
			],
			bank: freezeAtlasV3Bank(state),
			budgetUsed: BUDGET,
		});
		expect(memo.answerSoFar).toBe("The EU added 65.1 GW in 2025.");
		// c1 is verified (two publishers); c2 is single.
		expect(memo.claimIds[0]).toBe("c1");
		expect(memo.openQuestions).toEqual(["2024?"]);
	});

	it("never returns an empty answer", () => {
		const memo = deterministicAtlasV3Memo({
			previous: null,
			notes: [],
			bank: freezeAtlasV3Bank(createAtlasV3Bank()),
			budgetUsed: BUDGET,
		});
		expect(memo.answerSoFar.length).toBeGreaterThan(0);
	});

	it("carries a previous round's dead ends forward", () => {
		const previous: AtlasV3Memo = {
			answerSoFar: "old",
			claimIds: [],
			openQuestions: [],
			deadEnds: ["no member-state breakdown is published for 2025"],
			budgetUsed: BUDGET,
		};
		const memo = deterministicAtlasV3Memo({
			previous,
			notes: [],
			bank: freezeAtlasV3Bank(createAtlasV3Bank()),
			budgetUsed: BUDGET,
		});
		expect(memo.deadEnds).toEqual([
			"no member-state breakdown is published for 2025",
		]);
	});
});

describe("rewriteAtlasV3Memo", () => {
	const state = bankWithClaims();
	const bank = freezeAtlasV3Bank(state);
	const base = {
		coreQuestion: "How much solar did the EU add in 2025?",
		decision: "d",
		language: "en" as const,
		currentDate: "2026-09-10",
		round: 1,
		roundsLeft: 1,
		previous: null,
		notes: [],
		claims: bank.claims.map((claim) => ({
			id: claim.id,
			entity: claim.entity,
			metric: claim.metric,
			value: claim.value,
			unit: claim.unit,
			period: claim.period,
			asOf: claim.asOf,
			series: claim.series,
			status: claim.status,
			publishers: [],
		})),
		bank,
		budgetUsed: BUDGET,
	};

	it("uses the model's memo when it parses", async () => {
		const model = fakeModel({
			"v3:memo": JSON.stringify({
				answerSoFar: "65.1 GW in 2025, 0.7% below 2024.",
				claimIds: ["c1"],
			}),
		});
		const memo = await rewriteAtlasV3Memo({ ...base, runModel: model.call });
		expect(memo.answerSoFar).toBe("65.1 GW in 2025, 0.7% below 2024.");
		expect(memo.claimIds).toEqual(["c1"]);
	});

	it("falls back to the deterministic memo when the answer will not parse", async () => {
		const model = fakeModel({ "v3:memo": "sorry" });
		const memo = await rewriteAtlasV3Memo({ ...base, runModel: model.call });
		expect(memo.claimIds.length).toBeGreaterThan(0);
		expect(memo.answerSoFar.length).toBeGreaterThan(0);
	});

	it("backfills claim ids when the model named none", async () => {
		const model = fakeModel({
			"v3:memo": JSON.stringify({ answerSoFar: "an answer with no evidence" }),
		});
		const memo = await rewriteAtlasV3Memo({ ...base, runModel: model.call });
		expect(memo.answerSoFar).toBe("an answer with no evidence");
		expect(memo.claimIds.length).toBeGreaterThan(0);
	});

	it("survives a model that throws", async () => {
		const memo = await rewriteAtlasV3Memo({
			...base,
			runModel: async () => {
				throw new Error("provider down");
			},
		});
		expect(memo.answerSoFar.length).toBeGreaterThan(0);
	});
});

describe("buildAtlasV3MemoPrompt", () => {
	it("shows the previous memo so the model rewrites rather than appends", () => {
		const previous: AtlasV3Memo = {
			answerSoFar: "old answer",
			claimIds: ["c1"],
			openQuestions: ["still open"],
			deadEnds: [],
			budgetUsed: BUDGET,
		};
		const parsed = JSON.parse(
			buildAtlasV3MemoPrompt({
				coreQuestion: "core",
				decision: "d",
				language: "en",
				currentDate: "2026-09-10",
				round: 2,
				roundsLeft: 1,
				previous,
				notes: [],
				claims: [],
			}),
		);
		expect(parsed.previousMemo.answerSoFar).toBe("old answer");
		expect(parsed.task).toBe("rewrite_memo");
	});
});

describe("mergeAtlasV3Memos", () => {
	const memo = (overrides: Partial<AtlasV3Memo>): AtlasV3Memo => ({
		answerSoFar: "a",
		claimIds: [],
		openQuestions: [],
		deadEnds: [],
		budgetUsed: { searches: 1, pagesRead: 1, rounds: 1 },
		...overrides,
	});

	it("returns the single memo unchanged", () => {
		const only = memo({ answerSoFar: "only" });
		expect(mergeAtlasV3Memos([only])).toBe(only);
	});

	it("unions the claims and sums the budget", () => {
		const merged = mergeAtlasV3Memos([
			memo({ claimIds: ["c1", "c2"] }),
			memo({ claimIds: ["c2", "c3"] }),
		]);
		expect(merged.claimIds).toEqual(["c1", "c2", "c3"]);
		expect(merged.budgetUsed.searches).toBe(2);
		expect(merged.budgetUsed.rounds).toBe(1);
	});

	it("keeps a dead end only when EVERY pass hit it", () => {
		const merged = mergeAtlasV3Memos([
			memo({ deadEnds: ["no series", "paywalled"] }),
			memo({ deadEnds: ["no series"] }),
		]);
		expect(merged.deadEnds).toEqual(["no series"]);
	});

	it("handles no memos at all", () => {
		expect(mergeAtlasV3Memos([]).claimIds).toEqual([]);
	});
});
