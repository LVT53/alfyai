import { describe, expect, it } from "vitest";
import type { InterimThoughtStep } from "$lib/response-activity-types";
import {
	thoughtStepFaithfulnessFixtures,
	thoughtStepFixtures,
} from "./eval/thought-step-fixtures";
import {
	ENABLE_GATE_TRUTHFUL_RATE_THRESHOLD,
	evaluateEnableGate,
	evaluateFaithfulnessEnableGate,
	FAITHFULNESS_GATE_RATE_THRESHOLD,
	type FaithfulnessAuditSummary,
	type FaithfulnessJudgment,
	isAnchorResolved,
	isEntitySupported,
	isFabricatedActionClaim,
	scoreThoughtStep,
	summarizeFaithfulness,
	summarizeThoughtStepAudit,
	type ThoughtStepAuditResult,
} from "./thought-step-scoring";

describe("isAnchorResolved", () => {
	const thinkingText = "The user wants a summary of the article.";

	it("returns true (resolved) for a valid non-empty span", () => {
		expect(
			isAnchorResolved({ anchor: { start: 0, end: 8 } }, thinkingText),
		).toBe(true);
	});

	it("returns false when anchor is null", () => {
		expect(isAnchorResolved({ anchor: null }, thinkingText)).toBe(false);
	});

	it("returns false when end exceeds the text length", () => {
		expect(
			isAnchorResolved({ anchor: { start: 0, end: 9999 } }, thinkingText),
		).toBe(false);
	});

	it("returns false when start >= end", () => {
		expect(
			isAnchorResolved({ anchor: { start: 5, end: 5 } }, thinkingText),
		).toBe(false);
	});

	it("returns false when start is negative", () => {
		expect(
			isAnchorResolved({ anchor: { start: -1, end: 5 } }, thinkingText),
		).toBe(false);
	});
});

describe("isFabricatedActionClaim", () => {
	it("returns false when the step implies no external action", () => {
		expect(
			isFabricatedActionClaim(
				{ impliesExternalAction: false, source: "classified" },
				new Set(),
			),
		).toBe(false);
	});

	it("returns true when a classified step implies an external action", () => {
		expect(
			isFabricatedActionClaim(
				{ impliesExternalAction: true, source: "classified" },
				new Set(["call_1"]),
			),
		).toBe(true);
	});

	it("returns true when a deterministic step implies an external action", () => {
		expect(
			isFabricatedActionClaim(
				{ impliesExternalAction: true, source: "deterministic" },
				new Set(["call_1"]),
			),
		).toBe(true);
	});

	it("returns false when an event step's toolCallId matches a real tool call", () => {
		expect(
			isFabricatedActionClaim(
				{
					impliesExternalAction: true,
					source: "event",
					toolCallId: "call_1",
				},
				new Set(["call_1", "call_2"]),
			),
		).toBe(false);
	});

	it("returns true when an event step's toolCallId matches no real tool call", () => {
		expect(
			isFabricatedActionClaim(
				{
					impliesExternalAction: true,
					source: "event",
					toolCallId: "call_ghost",
				},
				new Set(["call_1"]),
			),
		).toBe(true);
	});

	it("returns true when an event step has no toolCallId at all", () => {
		expect(
			isFabricatedActionClaim(
				{ impliesExternalAction: true, source: "event" },
				new Set(["call_1"]),
			),
		).toBe(true);
	});
});

describe("isEntitySupported", () => {
	const thinkingText = "Checking the current price of the Tesla Model 3 sedan.";

	it("returns true (trivially) when no entity is claimed", () => {
		expect(
			isEntitySupported({ anchor: { start: 0, end: 8 } }, thinkingText),
		).toBe(true);
	});

	it("returns true when the entity is a verbatim substring of the anchor span", () => {
		expect(
			isEntitySupported(
				{
					entity: "Tesla Model 3",
					anchor: { start: 0, end: thinkingText.length },
				},
				thinkingText,
			),
		).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(
			isEntitySupported(
				{
					entity: "tesla model 3",
					anchor: { start: 0, end: thinkingText.length },
				},
				thinkingText,
			),
		).toBe(true);
	});

	it("returns false when the entity does not appear in the anchor span", () => {
		expect(
			isEntitySupported(
				{
					entity: "Kubernetes",
					anchor: { start: 0, end: thinkingText.length },
				},
				thinkingText,
			),
		).toBe(false);
	});

	it("returns false when the entity is present in the full text but outside the anchor span", () => {
		const shortSpanEnd = thinkingText.indexOf("price") + "price".length;
		expect(
			isEntitySupported(
				{ entity: "Tesla Model 3", anchor: { start: 0, end: shortSpanEnd } },
				thinkingText,
			),
		).toBe(false);
	});

	it("returns false when the entity is claimed but the anchor does not resolve", () => {
		expect(
			isEntitySupported({ entity: "Tesla", anchor: null }, thinkingText),
		).toBe(false);
	});
});

describe("scoreThoughtStep — synthetic fixtures", () => {
	// This is the P3a acceptance proof: every hand-crafted fixture (clearly
	// truthful, clearly fabricated-action, unanchored, anchor-out-of-range,
	// unsupported entity) must score exactly as a human reading it would
	// expect, with NO model call and NO real classifier output involved.
	for (const fixture of thoughtStepFixtures) {
		it(`[${fixture.category}] ${fixture.id}: ${fixture.description}`, () => {
			const result = scoreThoughtStep(fixture.step, {
				thinkingText: fixture.thinkingText,
				realToolCallIds: new Set(fixture.realToolCallIds),
			});
			expect(result).toEqual(fixture.expected);
		});
	}

	it("covers every required defect category at least once", () => {
		const categories = new Set(thoughtStepFixtures.map((f) => f.category));
		for (const required of [
			"truthful",
			"fabricated_action_classified",
			"fabricated_action_event_no_match",
			"unanchored",
			"anchor_out_of_range",
			"unsupported_entity",
		]) {
			expect(categories.has(required as never), required).toBe(true);
		}
	});

	it("has no duplicate fixture ids", () => {
		const ids = thoughtStepFixtures.map((f) => f.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("summarizeThoughtStepAudit", () => {
	function result(
		overrides: Partial<ThoughtStepAuditResult>,
	): ThoughtStepAuditResult {
		return {
			unanchored: false,
			fabricatedAction: false,
			unsupportedEntity: false,
			truthful: true,
			...overrides,
		};
	}

	it("returns zeroed stats and a null rate for an empty batch", () => {
		expect(summarizeThoughtStepAudit([])).toEqual({
			total: 0,
			truthfulCount: 0,
			truthfulRate: null,
			fabricatedActionCount: 0,
			unanchoredCount: 0,
			unsupportedEntityCount: 0,
		});
	});

	it("counts truthful, fabricated, unanchored, and unsupported-entity independently", () => {
		const results: ThoughtStepAuditResult[] = [
			result({}),
			result({ truthful: false, fabricatedAction: true }),
			result({ truthful: false, unanchored: true }),
			result({ truthful: false, unsupportedEntity: true }),
			result({}),
		];
		expect(summarizeThoughtStepAudit(results)).toEqual({
			total: 5,
			truthfulCount: 2,
			truthfulRate: 0.4,
			fabricatedActionCount: 1,
			unanchoredCount: 1,
			unsupportedEntityCount: 1,
		});
	});

	it("counts a step that is both unanchored AND a fabricated action claim in both buckets", () => {
		const results: ThoughtStepAuditResult[] = [
			result({ truthful: false, unanchored: true, fabricatedAction: true }),
		];
		const summary = summarizeThoughtStepAudit(results);
		expect(summary.unanchoredCount).toBe(1);
		expect(summary.fabricatedActionCount).toBe(1);
		expect(summary.truthfulCount).toBe(0);
	});
});

describe("evaluateEnableGate", () => {
	it("returns not_applicable when nothing was sampled", () => {
		expect(
			evaluateEnableGate({
				total: 0,
				truthfulCount: 0,
				truthfulRate: null,
				fabricatedActionCount: 0,
				unanchoredCount: 0,
				unsupportedEntityCount: 0,
			}),
		).toBe("not_applicable");
	});

	it("passes when truthful rate is strictly above the threshold and there are zero fabricated action claims", () => {
		expect(
			evaluateEnableGate({
				total: 100,
				truthfulCount: 96,
				truthfulRate: 0.96,
				fabricatedActionCount: 0,
				unanchoredCount: 4,
				unsupportedEntityCount: 0,
			}),
		).toBe("pass");
	});

	it(`fails when the truthful rate is exactly at the ${ENABLE_GATE_TRUTHFUL_RATE_THRESHOLD} threshold (strictly greater than is required)`, () => {
		expect(
			evaluateEnableGate({
				total: 100,
				truthfulCount: 95,
				truthfulRate: 0.95,
				fabricatedActionCount: 0,
				unanchoredCount: 5,
				unsupportedEntityCount: 0,
			}),
		).toBe("fail");
	});

	it("fails when there is even one fabricated action claim, regardless of truthful rate", () => {
		expect(
			evaluateEnableGate({
				total: 1000,
				truthfulCount: 999,
				truthfulRate: 0.999,
				fabricatedActionCount: 1,
				unanchoredCount: 0,
				unsupportedEntityCount: 0,
			}),
		).toBe("fail");
	});

	it("fails when the truthful rate is below the threshold even with zero fabricated action claims", () => {
		expect(
			evaluateEnableGate({
				total: 100,
				truthfulCount: 80,
				truthfulRate: 0.8,
				fabricatedActionCount: 0,
				unanchoredCount: 20,
				unsupportedEntityCount: 0,
			}),
		).toBe("fail");
	});
});

// ── Faithfulness audit (ADR-0056 Amendment 2026-08-16) ──────────────────

function faithfulJudgment(): FaithfulnessJudgment {
	return { status: "judged", verdict: { faithful: true, reason: "matches" } };
}

function unfaithfulJudgment(
	category: "contradiction" | "fabrication" | "unmoored",
): FaithfulnessJudgment {
	return {
		status: "judged",
		verdict: { faithful: false, category, reason: `flagged as ${category}` },
	};
}

function unjudgedJudgment(reason = "judge timed out"): FaithfulnessJudgment {
	return { status: "unjudged", reason };
}

describe("summarizeFaithfulness", () => {
	it("returns zeroed stats and null rates for an empty batch", () => {
		expect(summarizeFaithfulness([])).toEqual({
			summaryBearingCount: 0,
			judgedCount: 0,
			unjudgedCount: 0,
			faithfulCount: 0,
			faithfulRate: null,
			unjudgedRate: null,
			contradictionCount: 0,
			fabricationCount: 0,
			unmooredCount: 0,
		});
	});

	it("counts faithful, contradiction, fabrication, and unmoored independently", () => {
		const judgments: FaithfulnessJudgment[] = [
			faithfulJudgment(),
			faithfulJudgment(),
			unfaithfulJudgment("contradiction"),
			unfaithfulJudgment("fabrication"),
			unfaithfulJudgment("unmoored"),
		];
		expect(summarizeFaithfulness(judgments)).toEqual({
			summaryBearingCount: 5,
			judgedCount: 5,
			unjudgedCount: 0,
			faithfulCount: 2,
			faithfulRate: 0.4,
			unjudgedRate: 0,
			contradictionCount: 1,
			fabricationCount: 1,
			unmooredCount: 1,
		});
	});

	it("excludes unjudged steps from the faithfulRate denominator entirely (never counted faithful, never diluting it either)", () => {
		const judgments: FaithfulnessJudgment[] = [
			faithfulJudgment(),
			faithfulJudgment(),
			faithfulJudgment(),
			unjudgedJudgment(),
		];
		const summary = summarizeFaithfulness(judgments);
		expect(summary.summaryBearingCount).toBe(4);
		expect(summary.judgedCount).toBe(3);
		expect(summary.unjudgedCount).toBe(1);
		expect(summary.faithfulCount).toBe(3);
		// 3/3 judged, NOT 3/4 — an unjudged step is excluded, not counted against.
		expect(summary.faithfulRate).toBe(1);
		expect(summary.unjudgedRate).toBe(0.25);
	});

	it("returns a null faithfulRate (never 0) when every summary-bearing step is unjudged", () => {
		const summary = summarizeFaithfulness([
			unjudgedJudgment(),
			unjudgedJudgment(),
		]);
		expect(summary.summaryBearingCount).toBe(2);
		expect(summary.judgedCount).toBe(0);
		expect(summary.unjudgedCount).toBe(2);
		expect(summary.faithfulRate).toBeNull();
		expect(summary.unjudgedRate).toBe(1);
	});

	it("proves the actual faithfulness fixture corpus aggregates as expected (integration over real fixture data)", () => {
		const judgments: FaithfulnessJudgment[] =
			thoughtStepFaithfulnessFixtures.map((fixture) => ({
				status: "judged",
				verdict: fixture.expected,
			}));
		const summary = summarizeFaithfulness(judgments);
		expect(summary.summaryBearingCount).toBe(
			thoughtStepFaithfulnessFixtures.length,
		);
		expect(summary.unjudgedCount).toBe(0);
		expect(summary.contradictionCount).toBeGreaterThan(0);
		expect(summary.fabricationCount).toBeGreaterThan(0);
		expect(summary.unmooredCount).toBeGreaterThan(0);
		expect(summary.faithfulCount).toBeGreaterThan(0);
	});
});

function baseMechanical() {
	return { unanchoredCount: 0, fabricatedActionCount: 0 };
}

function baseFaithfulness(
	overrides: Partial<FaithfulnessAuditSummary> = {},
): FaithfulnessAuditSummary {
	return {
		summaryBearingCount: 0,
		judgedCount: 0,
		unjudgedCount: 0,
		faithfulCount: 0,
		faithfulRate: null,
		unjudgedRate: null,
		contradictionCount: 0,
		fabricationCount: 0,
		unmooredCount: 0,
		...overrides,
	};
}

describe("evaluateFaithfulnessEnableGate", () => {
	it("returns not_applicable when there are zero summary-bearing steps, regardless of mechanical stats", () => {
		expect(
			evaluateFaithfulnessEnableGate({
				mechanical: { unanchoredCount: 3, fabricatedActionCount: 2 },
				faithfulness: baseFaithfulness(),
			}),
		).toBe("not_applicable");
	});

	it("fails closed on insufficient judge coverage even when every judged step is faithful", () => {
		// 3 judged (all faithful) + 97 unjudged = 100 summary-bearing steps.
		// faithfulRate is 3/3 = 1.0 (> 0.95), but only 3% were actually judged —
		// a spurious pass on a tiny unrepresentative sample. The coverage guard
		// must fail this closed.
		const faithfulness = summarizeFaithfulness([
			faithfulJudgment(),
			faithfulJudgment(),
			faithfulJudgment(),
			...Array.from({ length: 97 }, () => unjudgedJudgment()),
		]);
		expect(faithfulness.faithfulRate).toBe(1);
		expect(faithfulness.summaryBearingCount).toBe(100);
		expect(
			evaluateFaithfulnessEnableGate({
				mechanical: { unanchoredCount: 0, fabricatedActionCount: 0 },
				faithfulness,
			}),
		).toBe("fail");
	});

	it("passes when judge coverage is adequate and every judged step is faithful", () => {
		// 19 judged faithful + 1 unjudged = 20 steps -> 95% judged coverage (>= 90%).
		const faithfulness = summarizeFaithfulness([
			...Array.from({ length: 19 }, () => faithfulJudgment()),
			unjudgedJudgment(),
		]);
		expect(
			evaluateFaithfulnessEnableGate({
				mechanical: { unanchoredCount: 0, fabricatedActionCount: 0 },
				faithfulness,
			}),
		).toBe("pass");
	});

	it("passes when faithful rate is strictly above threshold, zero contradictions/fabrications, and mechanical checks pass", () => {
		expect(
			evaluateFaithfulnessEnableGate({
				mechanical: baseMechanical(),
				faithfulness: baseFaithfulness({
					summaryBearingCount: 100,
					judgedCount: 100,
					faithfulCount: 96,
					faithfulRate: 0.96,
				}),
			}),
		).toBe("pass");
	});

	it(`fails when the faithful rate is exactly at the ${FAITHFULNESS_GATE_RATE_THRESHOLD} threshold (strictly greater than is required)`, () => {
		expect(
			evaluateFaithfulnessEnableGate({
				mechanical: baseMechanical(),
				faithfulness: baseFaithfulness({
					summaryBearingCount: 100,
					judgedCount: 100,
					faithfulCount: 95,
					faithfulRate: 0.95,
				}),
			}),
		).toBe("fail");
	});

	it("fails when there is even one contradiction, even at a 99% faithful rate", () => {
		expect(
			evaluateFaithfulnessEnableGate({
				mechanical: baseMechanical(),
				faithfulness: baseFaithfulness({
					summaryBearingCount: 100,
					judgedCount: 100,
					faithfulCount: 99,
					faithfulRate: 0.99,
					contradictionCount: 1,
				}),
			}),
		).toBe("fail");
	});

	it("fails when there is even one fabrication, even at a 99% faithful rate", () => {
		expect(
			evaluateFaithfulnessEnableGate({
				mechanical: baseMechanical(),
				faithfulness: baseFaithfulness({
					summaryBearingCount: 100,
					judgedCount: 100,
					faithfulCount: 99,
					faithfulRate: 0.99,
					fabricationCount: 1,
				}),
			}),
		).toBe("fail");
	});

	it("fails when the faithful rate is below threshold even with zero contradictions/fabrications", () => {
		expect(
			evaluateFaithfulnessEnableGate({
				mechanical: baseMechanical(),
				faithfulness: baseFaithfulness({
					summaryBearingCount: 100,
					judgedCount: 100,
					faithfulCount: 80,
					faithfulRate: 0.8,
				}),
			}),
		).toBe("fail");
	});

	it("fails when mechanical unanchoredCount > 0 despite a perfect faithfulness summary", () => {
		expect(
			evaluateFaithfulnessEnableGate({
				mechanical: { unanchoredCount: 1, fabricatedActionCount: 0 },
				faithfulness: baseFaithfulness({
					summaryBearingCount: 50,
					judgedCount: 50,
					faithfulCount: 50,
					faithfulRate: 1,
				}),
			}),
		).toBe("fail");
	});

	it("fails when mechanical fabricatedActionCount > 0 despite a perfect faithfulness summary", () => {
		expect(
			evaluateFaithfulnessEnableGate({
				mechanical: { unanchoredCount: 0, fabricatedActionCount: 1 },
				faithfulness: baseFaithfulness({
					summaryBearingCount: 50,
					judgedCount: 50,
					faithfulCount: 50,
					faithfulRate: 1,
				}),
			}),
		).toBe("fail");
	});

	it("fails closed when every summary-bearing step is unjudged (null faithfulRate never satisfies > threshold)", () => {
		expect(
			evaluateFaithfulnessEnableGate({
				mechanical: baseMechanical(),
				faithfulness: baseFaithfulness({
					summaryBearingCount: 10,
					unjudgedCount: 10,
					judgedCount: 0,
					faithfulRate: null,
				}),
			}),
		).toBe("fail");
	});
});

// Type-level smoke check: InterimThoughtStep is assignable to the narrow
// `Pick<...>` parameter types the scoring functions accept, so a future
// field addition to InterimThoughtStep can't silently break these functions'
// call sites without a compile error surfacing here first.
const _typeCheck: InterimThoughtStep = {
	id: "t",
	source: "classified",
	activityClass: "reasoning_active",
	impliesExternalAction: false,
	anchor: null,
};
void _typeCheck;
