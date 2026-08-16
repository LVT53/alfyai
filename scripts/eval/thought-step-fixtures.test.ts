import { describe, expect, it } from "vitest";
import {
	summarizeThoughtStepFaithfulnessFixtureCorpus,
	summarizeThoughtStepFixtureCorpus,
	thoughtStepFaithfulnessFixtures,
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

// Regression guard for the faithfulness corpus (ADR-0056 Amendment
// 2026-08-16) — the semantic sibling of the mechanical corpus-shape guard
// above. Re-derives counts from the actual fixture data every run.
describe("thoughtStepFaithfulnessFixtures corpus shape", () => {
	const stats = summarizeThoughtStepFaithfulnessFixtureCorpus(
		thoughtStepFaithfulnessFixtures,
	);

	it("covers every required faithfulness category at least once", () => {
		const requiredCategories = [
			"faithful",
			"fabrication",
			"contradiction",
			"unmoored",
		];
		for (const category of requiredCategories) {
			expect(stats.byCategory[category] ?? 0, category).toBeGreaterThan(0);
		}
	});

	it("has no duplicate fixture ids", () => {
		const ids = thoughtStepFaithfulnessFixtures.map((f) => f.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("category counts sum to the total", () => {
		const sum = Object.values(stats.byCategory).reduce((a, b) => a + b, 0);
		expect(sum).toBe(stats.total);
	});

	it("every fixture's step carries a non-empty summary", () => {
		for (const fixture of thoughtStepFaithfulnessFixtures) {
			expect(fixture.step.summary, fixture.id).toBeTruthy();
		}
	});

	it("every non-faithful fixture's expected verdict carries a category", () => {
		for (const fixture of thoughtStepFaithfulnessFixtures) {
			if (fixture.category === "faithful") {
				expect(fixture.expected.faithful, fixture.id).toBe(true);
			} else {
				expect(fixture.expected.faithful, fixture.id).toBe(false);
				expect(fixture.expected.category, fixture.id).toBe(fixture.category);
			}
		}
	});
});

describe("summarizeThoughtStepFaithfulnessFixtureCorpus", () => {
	it("returns zeroed stats for an empty fixture list", () => {
		expect(summarizeThoughtStepFaithfulnessFixtureCorpus([])).toEqual({
			total: 0,
			byCategory: {},
		});
	});
});
