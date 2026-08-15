import { describe, expect, it } from "vitest";
import {
	summarizeThoughtStepFixtureCorpus,
	thoughtStepFixtures,
} from "./thought-step-fixtures";

// Regression guard for the P3a corpus-shape constraint: every required
// defect category (see scripts/thought-step-scoring.test.ts, which asserts
// the actual scoring behavior per fixture) must be represented at least
// once. Re-derives the counts from the actual fixture data every run
// instead of trusting a one-time manual tally.

describe("thoughtStepFixtures corpus shape", () => {
	const stats = summarizeThoughtStepFixtureCorpus(thoughtStepFixtures);

	it("covers every required category at least once", () => {
		const requiredCategories = [
			"truthful",
			"fabricated_action_classified",
			"fabricated_action_event_no_match",
			"unanchored",
			"anchor_out_of_range",
			"unsupported_entity",
		];
		for (const category of requiredCategories) {
			expect(stats.byCategory[category] ?? 0, category).toBeGreaterThan(0);
		}
	});

	it("has no duplicate fixture ids", () => {
		const ids = thoughtStepFixtures.map((f) => f.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("has at least one truthful fixture with an entity claim, to prove supported-entity is exercised", () => {
		const withEntity = thoughtStepFixtures.filter(
			(f) => f.category === "truthful" && typeof f.step.entity === "string",
		);
		expect(withEntity.length).toBeGreaterThan(0);
	});

	it("category counts sum to the total", () => {
		const sum = Object.values(stats.byCategory).reduce((a, b) => a + b, 0);
		expect(sum).toBe(stats.total);
	});
});

describe("summarizeThoughtStepFixtureCorpus", () => {
	it("returns zeroed stats for an empty fixture list", () => {
		expect(summarizeThoughtStepFixtureCorpus([])).toEqual({
			total: 0,
			byCategory: {},
		});
	});
});
