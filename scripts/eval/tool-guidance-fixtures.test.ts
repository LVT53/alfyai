import { describe, expect, it } from "vitest";
import {
	summarizeToolGuidanceCorpus,
	toolGuidanceFixtures,
} from "./tool-guidance-fixtures";

// Regression guard for the G0 corpus-shape constraints (see the task spec
// and the docstring at the top of tool-guidance-fixtures.ts): >=60 turns,
// >=40% Hungarian (>=24), >=15 follow-up turns. Hand-counting a 60+ item
// array is error-prone, so this test re-derives the counts from the actual
// fixture data every run instead of trusting a one-time manual tally.

describe("toolGuidanceFixtures corpus shape", () => {
	const stats = summarizeToolGuidanceCorpus(toolGuidanceFixtures);

	it("has at least 60 total turns", () => {
		expect(stats.total).toBeGreaterThanOrEqual(60);
	});

	it("is at least 40% Hungarian, and at least 24 Hungarian turns", () => {
		expect(stats.huPercent).toBeGreaterThanOrEqual(0.4);
		expect(stats.huCount).toBeGreaterThanOrEqual(24);
	});

	it("has at least 15 follow-up (non-first) turns", () => {
		expect(stats.followUpCount).toBeGreaterThanOrEqual(15);
	});

	it("covers every expectedTool value at least once", () => {
		const expectedTools = [
			"research_web",
			"fetch_url",
			"image_search",
			"produce_file",
			"memory_context",
			"none",
		];
		for (const tool of expectedTools) {
			expect(stats.byExpectedTool[tool] ?? 0).toBeGreaterThan(0);
		}
	});

	it("has en + hu counts that add up to the total", () => {
		expect(stats.enCount + stats.huCount).toBe(stats.total);
	});

	it("has no duplicate fixture ids", () => {
		const ids = toolGuidanceFixtures.map((f) => f.id);
		const uniqueIds = new Set(ids);
		expect(uniqueIds.size).toBe(ids.length);
	});

	it("ends every fixture's messages array on a user turn", () => {
		for (const fixture of toolGuidanceFixtures) {
			const lastMessage = fixture.messages[fixture.messages.length - 1];
			expect(lastMessage?.role, `fixture ${fixture.id}`).toBe("user");
		}
	});

	it("marks isFollowUp true iff the fixture has prior-turn messages", () => {
		for (const fixture of toolGuidanceFixtures) {
			expect(fixture.isFollowUp, `fixture ${fixture.id}`).toBe(
				fixture.messages.length > 1,
			);
		}
	});

	it("keeps length_cliff_short fixtures at <=8 words in the evaluated turn", () => {
		const shortFixtures = toolGuidanceFixtures.filter(
			(f) => f.category === "length_cliff_short",
		);
		expect(shortFixtures.length).toBeGreaterThan(0);
		for (const fixture of shortFixtures) {
			const lastMessage = fixture.messages[fixture.messages.length - 1];
			const wordCount = lastMessage.content
				.trim()
				.split(/\s+/)
				.filter(Boolean).length;
			expect(wordCount, `fixture ${fixture.id}`).toBeLessThanOrEqual(8);
		}
	});

	it("keeps length_cliff_long fixtures at >=35 words in the evaluated turn", () => {
		const longFixtures = toolGuidanceFixtures.filter(
			(f) => f.category === "length_cliff_long",
		);
		expect(longFixtures.length).toBeGreaterThan(0);
		for (const fixture of longFixtures) {
			const lastMessage = fixture.messages[fixture.messages.length - 1];
			const wordCount = lastMessage.content
				.trim()
				.split(/\s+/)
				.filter(Boolean).length;
			expect(wordCount, `fixture ${fixture.id}`).toBeGreaterThanOrEqual(35);
		}
	});
});

describe("summarizeToolGuidanceCorpus", () => {
	it("returns zeroed stats for an empty fixture list", () => {
		expect(summarizeToolGuidanceCorpus([])).toEqual({
			total: 0,
			huCount: 0,
			huPercent: 0,
			enCount: 0,
			followUpCount: 0,
			byCategory: {},
			byExpectedTool: {},
		});
	});
});
