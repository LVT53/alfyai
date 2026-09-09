import { describe, expect, it } from "vitest";
import {
	buildAtlasV2PlanPrompt,
	coreQuestionFromQuery,
	deterministicAtlasV2Title,
	fallbackAtlasV2Plan,
	normalizeAtlasV2PlanTitle,
	parseAtlasV2Plan,
} from "./plan";

describe("buildAtlasV2PlanPrompt", () => {
	it("carries the request, the target counts and the parent seed", () => {
		const prompt = JSON.parse(
			buildAtlasV2PlanPrompt({
				query: "How much solar did the EU add in 2026?",
				profile: "overview",
				questionCount: 6,
				language: "en",
				currentDate: "2026-09-08",
				seedQuestions: ["What did the EU add in 2025?"],
				seedSections: ["Capacity"],
			}),
		);
		expect(prompt).toMatchObject({
			task: "plan_research",
			request: "How much solar did the EU add in 2026?",
			profile: "overview",
			targetQuestionCount: 6,
			parentQuestions: ["What did the EU add in 2025?"],
			parentSections: ["Capacity"],
		});
	});
});

describe("parseAtlasV2Plan", () => {
	const good = JSON.stringify({
		questions: [
			"What capacity was added in 2026?",
			"What did the regulator require?",
			"Which member states led?",
			"What does the grid queue look like?",
		],
		sections: [
			{ title: "Capacity", brief: "How much was added", questions: [1, 3] },
			{ title: "Rules", brief: "What the regulator requires", questions: [2] },
		],
	});

	it("mints its own question ids rather than trusting model ids", () => {
		const plan = parseAtlasV2Plan(good, { questionCount: 6 });
		expect(plan?.questions.map((question) => question.id)).toEqual([
			"q1",
			"q2",
			"q3",
			"q4",
		]);
		expect(plan?.sections[0].questionIds).toEqual(["q1", "q3"]);
	});

	it("attaches an orphaned question to the smallest section", () => {
		const plan = parseAtlasV2Plan(good, { questionCount: 6 });
		expect(plan?.sections[1].questionIds).toEqual(["q2", "q4"]);
	});

	it("makes the core question question 1, whatever the model returned", () => {
		const plan = parseAtlasV2Plan(good, {
			questionCount: 6,
			coreQuestion: "How much solar PV did the EU add in 2025?",
		});
		expect(plan?.questions[0].question).toBe(
			"How much solar PV did the EU add in 2025?",
		);
		expect(plan?.questions).toHaveLength(5);
	});

	it("does not repeat the core question the model already asked", () => {
		const plan = parseAtlasV2Plan(good, {
			questionCount: 6,
			coreQuestion: "What capacity was added in 2026?",
		});
		expect(
			plan?.questions.filter((question) =>
				question.question.startsWith("What capacity was added"),
			),
		).toHaveLength(1);
	});

	it("orders sections by how directly they answer the request", () => {
		const buried = JSON.stringify({
			questions: [
				"How much capacity was added in 2026?",
				"What is the historical background?",
				"Which member states led?",
				"What does the grid queue look like?",
			],
			sections: [
				{ title: "Background", brief: "History", questions: [2] },
				{ title: "Additions", brief: "How much", questions: [1] },
				{ title: "Leaders", brief: "Who led", questions: [3, 4] },
			],
		});
		const plan = parseAtlasV2Plan(buried, { questionCount: 6 });
		expect(plan?.sections.map((section) => section.title)).toEqual([
			"Additions",
			"Background",
			"Leaders",
		]);
	});

	it("reads the model's title and drops an unusable one", () => {
		const withTitle = parseAtlasV2Plan(
			JSON.stringify({
				...JSON.parse(good),
				title: "EU solar additions in 2026",
			}),
			{ questionCount: 6 },
		);
		expect(withTitle?.title).toBe("EU solar additions in 2026");
		expect(parseAtlasV2Plan(good, { questionCount: 6 })?.title).toBeNull();
	});

	it("respects a per-profile section cap", () => {
		const many = JSON.stringify({
			questions: [
				"One checkable question?",
				"Two checkable question?",
				"Three checkable question?",
				"Four checkable question?",
			],
			sections: Array.from({ length: 9 }, (_, position) => ({
				title: `Section ${position}`,
				brief: "Brief",
				questions: [(position % 4) + 1],
			})),
		});
		expect(
			parseAtlasV2Plan(many, { questionCount: 6, maxSections: 4 })?.sections,
		).toHaveLength(4);
	});

	it("reads a fenced JSON block", () => {
		const fence = "```";
		const plan = parseAtlasV2Plan(
			`Here is the plan:\n${fence}json\n${good}\n${fence}`,
			{ questionCount: 6 },
		);
		expect(plan?.questions).toHaveLength(4);
	});

	it("clamps to the requested question count", () => {
		const plan = parseAtlasV2Plan(
			JSON.stringify({
				questions: Array.from({ length: 30 }, (_, i) => `Question ${i + 1}?`),
				sections: [
					{ title: "A", brief: "A", questions: [1] },
					{ title: "B", brief: "B", questions: [2] },
				],
			}),
			{ questionCount: 6 },
		);
		expect(plan?.questions).toHaveLength(6);
	});

	it("returns null on unusable output", () => {
		expect(
			parseAtlasV2Plan("not json at all", { questionCount: 6 }),
		).toBeNull();
		expect(
			parseAtlasV2Plan(JSON.stringify({ questions: ["only one?"] }), {
				questionCount: 6,
			}),
		).toBeNull();
		expect(
			parseAtlasV2Plan(
				JSON.stringify({
					questions: ["a?", "b?", "c?", "d?"],
					sections: [{ title: "Only one", brief: "x", questions: [1] }],
				}),
				{ questionCount: 6 },
			),
		).toBeNull();
	});

	it("drops duplicate questions", () => {
		const plan = parseAtlasV2Plan(
			JSON.stringify({
				questions: ["a?", "a?", "b?", "c?", "d?"],
				sections: [
					{ title: "A", brief: "A", questions: [1, 2] },
					{ title: "B", brief: "B", questions: [3, 4] },
				],
			}),
			{ questionCount: 6 },
		);
		expect(plan?.questions.map((question) => question.question)).toEqual([
			"a?",
			"b?",
			"c?",
			"d?",
		]);
	});
});

describe("coreQuestionFromQuery", () => {
	it("keeps an interrogative request as a question", () => {
		expect(
			coreQuestionFromQuery("How much solar did the EU add in 2025", "en"),
		).toBe("How much solar did the EU add in 2025?");
		expect(coreQuestionFromQuery("Mennyi volt a minimálbér", "hu")).toBe(
			"Mennyi volt a minimálbér?",
		);
	});

	it("leaves an imperative request alone", () => {
		expect(
			coreQuestionFromQuery("Give a timeline of the Chernobyl disaster", "en"),
		).toBe("Give a timeline of the Chernobyl disaster");
	});

	it("does not double a question mark", () => {
		expect(coreQuestionFromQuery("What changed in 2026?", "en")).toBe(
			"What changed in 2026?",
		);
	});
});

describe("normalizeAtlasV2PlanTitle", () => {
	it("strips markdown, quotes and terminal punctuation", () => {
		expect(normalizeAtlasV2PlanTitle('## "EU solar additions"')).toBe(
			"EU solar additions",
		);
		expect(normalizeAtlasV2PlanTitle("EU solar additions?")).toBe(
			"EU solar additions",
		);
	});

	it("rejects a placeholder or an unusably short title", () => {
		expect(normalizeAtlasV2PlanTitle("Report")).toBeNull();
		expect(normalizeAtlasV2PlanTitle("Ok")).toBeNull();
		expect(normalizeAtlasV2PlanTitle(42)).toBeNull();
	});

	it("truncates an over-long title at a word boundary", () => {
		const title = normalizeAtlasV2PlanTitle(
			"How much solar photovoltaic generating capacity did the European Union install during the year",
		);
		expect(title?.length).toBeLessThanOrEqual(70);
		expect(title?.endsWith("…")).toBe(false);
		expect(title).not.toMatch(/\s(the|and|during)$/);
	});
});

describe("deterministicAtlasV2Title", () => {
	it("returns a short request unchanged, without its question mark", () => {
		expect(
			deterministicAtlasV2Title("How does the Dutch 30% ruling work?"),
		).toBe("How does the Dutch 30% ruling work");
	});

	it("cuts a long request at its clause boundary, with no ellipsis", () => {
		expect(
			deterministicAtlasV2Title(
				"How much solar PV capacity did the European Union add in 2025, and how does that compare with 2024?",
			),
		).toBe("How much solar PV capacity did the European Union add in 2025");
	});

	it("never ends on a dangling function word", () => {
		const title = deterministicAtlasV2Title(
			"What are the current context window sizes and prices of the leading frontier language models?",
		);
		expect(title.length).toBeLessThanOrEqual(70);
		expect(title).toBe("What are the current context window sizes and prices");
	});

	it("adds no ellipsis and no trailing punctuation", () => {
		const title = deterministicAtlasV2Title(
			"Compare the Framework Laptop 13 and the Dell XPS 13 for repairability and upgradeability, with current prices.",
		);
		expect(title).toBe(
			"Compare the Framework Laptop 13 and the Dell XPS 13 for repairability",
		);
	});

	it("still cuts at a word boundary when there is no clause boundary", () => {
		const title = deterministicAtlasV2Title(
			"What is known about the population trend of the Kerry slug Geomalacus maculosus in Ireland since 2015",
		);
		expect(title.length).toBeLessThanOrEqual(70);
		expect(title.endsWith(" ")).toBe(false);
		expect(/\s$/.test(title)).toBe(false);
	});
});

describe("fallbackAtlasV2Plan", () => {
	it("produces a usable plan from the request alone", () => {
		const plan = fallbackAtlasV2Plan({
			query: "EU solar additions in 2026",
			questionCount: 6,
			language: "en",
		});
		expect(plan.questions).toHaveLength(6);
		expect(plan.sections.length).toBeGreaterThanOrEqual(2);
		const covered = new Set(
			plan.sections.flatMap((section) => section.questionIds),
		);
		expect(covered.size).toBe(plan.questions.length);
	});

	it("writes the fallback questions in Hungarian for a Hungarian request", () => {
		const plan = fallbackAtlasV2Plan({
			query: "Mennyi napelemet telepítettek 2026-ban?",
			questionCount: 6,
			language: "hu",
		});
		// The request itself leads, then the Hungarian standing angles.
		expect(plan.questions[0].question).toBe(
			"Mennyi napelemet telepítettek 2026-ban?",
		);
		expect(plan.questions[1].question).toContain("Mi a jelenlegi helyzet");
	});

	it("gives the fallback plan a title that does not end mid-clause", () => {
		const plan = fallbackAtlasV2Plan({
			query:
				"How much solar PV capacity did the European Union add in 2025, and how does that compare with 2024?",
			questionCount: 6,
			language: "en",
		});
		expect(plan.title).toBe(
			"How much solar PV capacity did the European Union add in 2025",
		);
	});
});
