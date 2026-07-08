import { describe, expect, it } from "vitest";
import { buildJudgeSystemPrompt, buildJudgeUserMessage } from "./prompt";

describe("judge prompts", () => {
	it("system prompt encodes all five gates and category enum", () => {
		const p = buildJudgeSystemPrompt();
		for (const needle of [
			"stable",
			"three months", // gate 1
			"pasted",
			"quoted",
			"translat",
			"hypothetical",
			"role-play", // gate 2
			"future conversation", // gate 3
			"stated",
			"inferred",
			"hedge", // gate 4
			"nothing new",
			"update", // gate 5
			"first person",
			"one sentence",
			"about_you",
			"preferences",
			"goals_ongoing_work",
			"constraints_boundaries",
		])
			expect(p.toLowerCase()).toContain(needle.toLowerCase());
	});
	it("user message includes segment, summary, existing facts and project marker", () => {
		const m = buildJudgeUserMessage({
			segment: [
				{ role: "user", content: "hello" },
				{ role: "assistant", content: "hi" },
			],
			conversationSummary: "A summary.",
			existingFacts: [
				{ id: "f1", statement: "I like tea.", category: "preferences" },
			],
			projectId: "p1",
		});
		expect(m).toContain("hello");
		expect(m).toContain("A summary.");
		expect(m).toContain("f1");
		expect(m).toContain("I like tea.");
		expect(m).toContain("project");
	});
});
