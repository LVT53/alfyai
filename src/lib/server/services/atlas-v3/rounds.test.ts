import { describe, expect, it } from "vitest";
import { createAtlasV3Bank } from "./evidence-bank";
import { nextAtlasV3SubQuestions, runAtlasV3Round } from "./rounds";
import { fakeModel, fakeResearchWeb, readAnswer } from "./test-support";
import type { AtlasV3Memo } from "./types";

const IEA = "https://iea.org/reports/solar-2025";
const BBC = "https://bbc.com/news/eu-solar";

describe("runAtlasV3Round", () => {
	function round(
		overrides: Partial<Parameters<typeof runAtlasV3Round>[0]> = {},
	) {
		const model = fakeModel({
			"v3:searchplan": JSON.stringify({ queries: ["eu solar 2025"] }),
			"v3:read": readAnswer({
				quotes: [
					"The European Union added 65.1 GW of new solar capacity in 2025, industry data show.",
				],
				claims: [
					{
						entity: "EU-27",
						metric: "solar additions",
						value: "65.1",
						unit: "GW",
						period: "2025",
						series: "grid-connected",
						quoteIndexes: [0],
					},
				],
			}),
			"v3:note": JSON.stringify({ summary: "65.1 GW in 2025." }),
			"v3:memo": JSON.stringify({
				answerSoFar: "The EU added 65.1 GW in 2025.",
				claimIds: ["c1"],
				openQuestions: ["What did the EU add in 2024?"],
			}),
		});
		return {
			model,
			input: {
				round: 1,
				roundsTotal: 2,
				subQuestions: ["EU solar additions 2025", "EU solar additions 2024"],
				coreQuestion: "EU solar 2025 vs 2024",
				decision: "d",
				language: "en" as const,
				currentDate: "2026-09-10",
				state: createAtlasV3Bank(),
				researchWeb: fakeResearchWeb({
					hits: [
						{ url: IEA, title: "IEA", snippets: [], publishedAt: "2025-12-01" },
						{ url: BBC, title: "BBC", snippets: [], publishedAt: "2025-12-02" },
					],
					pages: { [IEA]: "text", [BBC]: "text" },
				}),
				runResearcherModel: model.call,
				runMemoModel: model.call,
				searchesPerStep: 3,
				pagesPerQuestion: 1,
				concurrency: 2,
				previousMemo: null,
				...overrides,
			},
		};
	}

	it("fans out, files evidence and rewrites the memo", async () => {
		const { input } = round();
		const result = await runAtlasV3Round(input);
		expect(result.notes).toHaveLength(2);
		expect(result.memo.answerSoFar).toBe("The EU added 65.1 GW in 2025.");
		expect(result.budgetUsed.rounds).toBe(1);
		expect(result.budgetUsed.searches).toBe(2);
		expect(result.budgetUsed.pagesRead).toBe(2);
		expect(input.state.quotes.length).toBeGreaterThan(0);
	});

	it("adds a round's spend to the previous memo's", async () => {
		const previousMemo: AtlasV3Memo = {
			answerSoFar: "old",
			claimIds: [],
			openQuestions: [],
			deadEnds: [],
			budgetUsed: { searches: 10, pagesRead: 5, rounds: 1 },
		};
		const { input } = round({ round: 2, previousMemo });
		const result = await runAtlasV3Round(input);
		expect(result.budgetUsed.searches).toBe(12);
		expect(result.budgetUsed.pagesRead).toBe(7);
		expect(result.budgetUsed.rounds).toBe(2);
	});

	it("shows the budget shrinking as rounds are spent", async () => {
		const { model, input } = round({ round: 2, roundsTotal: 2 });
		await runAtlasV3Round(input);
		const plan = model.prompts.find((entry) => entry.stage === "v3:searchplan");
		expect(JSON.parse(plan?.prompt ?? "{}").budget.roundsLeft).toBe(0);
	});

	it("keeps the round when one researcher throws", async () => {
		let calls = 0;
		const { model, input } = round();
		const result = await runAtlasV3Round({
			...input,
			runResearcherModel: async (call) => {
				calls += 1;
				if (call.stage === "v3:searchplan" && calls === 1) {
					throw new Error("boom");
				}
				return model.call(call);
			},
		});
		// The failed plan falls back to deterministic queries, so BOTH questions
		// still produce a note.
		expect(result.notes).toHaveLength(2);
	});

	it("reports a dropped question as still open", async () => {
		const { input } = round({
			researchWeb: fakeResearchWeb({ hits: [], failSearch: true }),
		});
		const result = await runAtlasV3Round(input);
		expect(result.notes.every((note) => note.error !== null)).toBe(true);
	});

	it("hands the previous memo's dead ends to the researchers", async () => {
		const previousMemo: AtlasV3Memo = {
			answerSoFar: "old",
			claimIds: [],
			openQuestions: [],
			deadEnds: ["no member-state breakdown is published"],
			budgetUsed: { searches: 0, pagesRead: 0, rounds: 1 },
		};
		const { model, input } = round({ round: 2, previousMemo });
		await runAtlasV3Round(input);
		const plan = model.prompts.find((entry) => entry.stage === "v3:searchplan");
		expect(JSON.parse(plan?.prompt ?? "{}").deadEnds).toEqual([
			"no member-state breakdown is published",
		]);
	});
});

describe("nextAtlasV3SubQuestions", () => {
	const memo: AtlasV3Memo = {
		answerSoFar: "a",
		claimIds: [],
		openQuestions: [
			"What did the EU add in 2024?",
			"Which member states fell?",
		],
		deadEnds: ["Which member states fell?"],
		budgetUsed: { searches: 0, pagesRead: 0, rounds: 1 },
	};

	it("puts the goal test's gaps first", () => {
		expect(
			nextAtlasV3SubQuestions({
				gaps: ["IEA EU-only solar series 2025"],
				memo,
				asked: [],
				limit: 3,
			}),
		).toEqual([
			"IEA EU-only solar series 2025",
			"What did the EU add in 2024?",
		]);
	});

	it("never re-asks a question or a dead end", () => {
		expect(
			nextAtlasV3SubQuestions({
				gaps: [],
				memo,
				asked: ["What did the EU add in 2024?"],
				limit: 3,
			}),
		).toEqual([]);
	});

	it("respects the limit", () => {
		expect(
			nextAtlasV3SubQuestions({
				gaps: ["a", "b", "c", "d"],
				memo: null,
				asked: [],
				limit: 2,
			}),
		).toEqual(["a", "b"]);
	});
});
