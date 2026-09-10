import { describe, expect, it } from "vitest";
import { createAtlasV3Bank } from "./evidence-bank";
import {
	buildAtlasV3NotePrompt,
	buildAtlasV3SearchPlanPrompt,
	deterministicAtlasV3Queries,
	parseAtlasV3Note,
	parseAtlasV3SearchPlan,
	type RunAtlasV3ResearcherInput,
	runAtlasV3Researcher,
} from "./researcher";
import { fakeModel, fakeResearchWeb, readAnswer } from "./test-support";

const IEA = "https://iea.org/reports/solar-2025";
const FORUM = "https://reddit.com/r/solar/comments/x";
const BBC = "https://bbc.com/news/eu-solar";

function baseInput(
	overrides: Pick<RunAtlasV3ResearcherInput, "researchWeb" | "runModel"> &
		Partial<RunAtlasV3ResearcherInput>,
): RunAtlasV3ResearcherInput {
	return {
		subQuestion: "How much solar did the EU add in 2025?",
		coreQuestion: "How much solar did the EU add in 2025 versus 2024?",
		language: "en" as const,
		currentDate: "2026-09-10",
		state: createAtlasV3Bank(),
		searchesPerStep: 3,
		pagesToRead: 2,
		budget: { searchesLeft: 12, pageReadsLeft: 8, roundsLeft: 1 },
		...overrides,
	};
}

describe("parseAtlasV3SearchPlan", () => {
	it("reads, trims and dedupes queries up to the limit", () => {
		expect(
			parseAtlasV3SearchPlan(
				JSON.stringify({
					queries: ["EU solar 2025", "eu solar 2025", " a ", "b", "c"],
				}),
				3,
			),
		).toEqual(["EU solar 2025", "a", "b"]);
	});

	it("returns null when there is nothing usable", () => {
		expect(parseAtlasV3SearchPlan("nope", 3)).toBeNull();
		expect(
			parseAtlasV3SearchPlan(JSON.stringify({ queries: [] }), 3),
		).toBeNull();
	});
});

describe("deterministicAtlasV3Queries", () => {
	it("strips the interrogative and names the preferred sources", () => {
		expect(
			deterministicAtlasV3Queries({
				subQuestion: "How much solar did the EU add in 2025?",
				preferredSources: ["KSH"],
				limit: 3,
			}),
		).toEqual([
			"much solar did the EU add in 2025",
			"much solar did the EU add in 2025 KSH",
		]);
	});
});

describe("buildAtlasV3SearchPlanPrompt", () => {
	it("makes the budget visible to the model", () => {
		const parsed = JSON.parse(
			buildAtlasV3SearchPlanPrompt({
				subQuestion: "q",
				coreQuestion: "core",
				language: "en",
				currentDate: "2026-09-10",
				queryCount: 4,
				budget: { searchesLeft: 12, pageReadsLeft: 8, roundsLeft: 2 },
				deadEnds: ["no member-state breakdown is published"],
			}),
		);
		expect(parsed.budget).toEqual({
			searchesLeft: 12,
			pageReadsLeft: 8,
			roundsLeft: 2,
		});
		expect(parsed.queryCount).toBe(4);
		expect(parsed.deadEnds).toHaveLength(1);
	});
});

describe("parseAtlasV3Note", () => {
	it("reads a note and caps its lists", () => {
		const note = parseAtlasV3Note(
			JSON.stringify({
				summary: "The EU added 65.1 GW in 2025 (SolarPower Europe).",
				openQuestions: ["a", "b", "c", "d"],
				deadEnds: ["x", "y", "z"],
			}),
		);
		expect(note?.openQuestions).toHaveLength(3);
		expect(note?.deadEnds).toHaveLength(2);
	});

	it("returns null without a summary", () => {
		expect(
			parseAtlasV3Note(JSON.stringify({ openQuestions: ["a"] })),
		).toBeNull();
	});
});

describe("runAtlasV3Researcher", () => {
	it("plans, searches, reads the top tier and files evidence", async () => {
		const model = fakeModel({
			"v3:searchplan": JSON.stringify({ queries: ["EU solar additions 2025"] }),
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
						series: "grid-connected additions",
						quoteIndexes: [0],
					},
				],
			}),
			"v3:note": JSON.stringify({
				summary: "SolarPower Europe puts 2025 EU additions at 65.1 GW.",
				openQuestions: ["What did the EU add in 2024?"],
			}),
		});
		const web = fakeResearchWeb({
			hits: [
				{ url: FORUM, title: "Anyone know?", snippets: [], publishedAt: null },
				{
					url: IEA,
					title: "Renewables 2025",
					snippets: [],
					publishedAt: "2025-12-01",
				},
			],
			pages: { [IEA]: "The EU added 65.1 GW in 2025." },
		});
		const input = baseInput({ researchWeb: web, runModel: model.call });
		const note = await runAtlasV3Researcher(input);

		// The forum is never read: tiering spends the budget on the primary source.
		expect(web.readCalls).toEqual([IEA]);
		expect(note.quotes).toHaveLength(1);
		expect(note.claims[0].value).toBe("65.1");
		expect(note.summary).toContain("65.1");
		expect(note.openQuestions).toEqual(["What did the EU add in 2024?"]);
		expect(note.pagesRead).toBe(1);
		expect(note.searches).toBe(1);
		expect(input.state.sources).toHaveLength(1);
	});

	it("falls back to deterministic queries when the plan will not parse", async () => {
		const model = fakeModel({ "v3:searchplan": "I am not JSON" });
		const web = fakeResearchWeb({ hits: [] });
		await runAtlasV3Researcher(
			baseInput({
				researchWeb: web,
				runModel: model.call,
				preferredSources: ["IEA"],
			}),
		);
		expect(web.searchCalls[0].queries[0]).toContain("solar");
		expect(web.searchCalls[0].queries.at(-1)).toContain("IEA");
	});

	it("returns the search error rather than throwing", async () => {
		const note = await runAtlasV3Researcher(
			baseInput({
				researchWeb: fakeResearchWeb({ hits: [], failSearch: true }),
				runModel: fakeModel({}).call,
			}),
		);
		expect(note.error).toBe("parallel is down");
		expect(note.quotes).toEqual([]);
	});

	it("files nothing from a page that reports itself useless", async () => {
		const model = fakeModel({
			"v3:searchplan": JSON.stringify({ queries: ["x"] }),
			"v3:read": readAnswer({ quotes: [], useless: true }),
		});
		const web = fakeResearchWeb({
			hits: [
				{ url: IEA, title: "Marketplace", snippets: [], publishedAt: null },
			],
			pages: { [IEA]: "Home | Products | Cart | Sign in" },
		});
		const input = baseInput({ researchWeb: web, runModel: model.call });
		const note = await runAtlasV3Researcher(input);
		expect(note.quotes).toEqual([]);
		expect(input.state.quotes).toEqual([]);
		// The page WAS read; the read call is what noticed it was a menu.
		expect(note.pagesRead).toBe(1);
	});

	it("leaves the question open when nothing could be read", async () => {
		const model = fakeModel({
			"v3:searchplan": JSON.stringify({ queries: ["x"] }),
		});
		const web = fakeResearchWeb({
			hits: [{ url: IEA, title: "A", snippets: [], publishedAt: null }],
			pages: {},
		});
		const note = await runAtlasV3Researcher(
			baseInput({ researchWeb: web, runModel: model.call }),
		);
		expect(note.openQuestions).toEqual([
			"How much solar did the EU add in 2025?",
		]);
		expect(note.summary).toBe("");
	});

	it("keeps the evidence when the note call fails to parse", async () => {
		const model = fakeModel({
			"v3:searchplan": JSON.stringify({ queries: ["x"] }),
			"v3:read": readAnswer({
				quotes: [
					"The European Union added 65.1 GW of new solar capacity in 2025.",
				],
			}),
			"v3:note": "the model rambled",
		});
		const web = fakeResearchWeb({
			hits: [{ url: BBC, title: "EU solar", snippets: [], publishedAt: null }],
			pages: { [BBC]: "text" },
		});
		const note = await runAtlasV3Researcher(
			baseInput({ researchWeb: web, runModel: model.call }),
		);
		expect(note.quotes).toHaveLength(1);
		expect(note.summary).toBe("");
	});

	it("never puts page text into the note prompt", async () => {
		const secret = "SECRET-PAGE-BODY-THAT-MUST-NOT-TRAVEL";
		const model = fakeModel({
			"v3:searchplan": JSON.stringify({ queries: ["x"] }),
			"v3:read": readAnswer({
				quotes: [
					"The European Union added 65.1 GW of new solar capacity in 2025.",
				],
			}),
			"v3:note": JSON.stringify({ summary: "ok" }),
		});
		const web = fakeResearchWeb({
			hits: [{ url: IEA, title: "A", snippets: [], publishedAt: null }],
			pages: { [IEA]: `${secret} The EU added 65.1 GW in 2025.` },
		});
		await runAtlasV3Researcher(
			baseInput({ researchWeb: web, runModel: model.call }),
		);
		const notePrompt = model.prompts.find((entry) => entry.stage === "v3:note");
		expect(notePrompt?.prompt).not.toContain(secret);
		const readPrompt = model.prompts.find((entry) =>
			entry.stage.startsWith("v3:read"),
		);
		expect(readPrompt?.prompt).toContain(secret);
	});
});

describe("buildAtlasV3NotePrompt", () => {
	it("carries the quotes and the spend, not the pages", () => {
		const parsed = JSON.parse(
			buildAtlasV3NotePrompt({
				subQuestion: "q",
				coreQuestion: "core",
				language: "en",
				currentDate: "2026-09-10",
				quotes: [
					{
						id: "e1",
						text: "t",
						publisher: "iea",
						tier: "primary",
						date: null,
					},
				],
				claims: [],
				searchesSpent: 3,
				pagesRead: 2,
			}),
		);
		expect(parsed.spent).toEqual({ searches: 3, pagesRead: 2 });
		expect(parsed.quotes[0].id).toBe("e1");
	});
});
