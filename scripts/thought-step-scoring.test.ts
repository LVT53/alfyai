import { describe, expect, it } from "vitest";
import type { InterimThoughtStep } from "$lib/response-activity-types";
import { thoughtStepFixtures } from "./eval/thought-step-fixtures";
import {
	ENABLE_GATE_TRUTHFUL_RATE_THRESHOLD,
	evaluateEnableGate,
	isAnchorResolved,
	isEntitySupported,
	isFabricatedActionClaim,
	scoreThoughtStep,
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
