import { describe, expect, it } from "vitest";
import {
	buildAtlasV2PlanPrompt,
	fallbackAtlasV2Plan,
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

	it("reads a fenced JSON block", () => {
		const plan = parseAtlasV2Plan(
			"Here is the plan:\n```json\n" + good + "\n```",
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
		expect(plan.questions[0].question).toContain("Mi a jelenlegi helyzet");
	});
});
