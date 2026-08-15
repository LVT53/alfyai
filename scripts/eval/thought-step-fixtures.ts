// Synthetic corpus for the P3a honesty audit harness
// (scripts/audit-thought-step-honesty.ts) and its pure scoring functions
// (scripts/thought-step-scoring.ts). Mirrors the
// scripts/eval/tool-guidance-fixtures.ts convention for the sibling G0
// corpus: hand-crafted, self-contained fixtures with a known-correct
// `expected` verdict.
//
// This corpus exists because P3a ships BEFORE P3b's classifier — there is
// no real classifier output to sample yet (see the header comment on
// audit-thought-step-honesty.ts). These fixtures are how the P3a scorer is
// proven correct without any real classifier output: each one is a
// hand-crafted (Interim Thought Step, thinking-text chunk) pair with a
// verdict a human can check by inspection, covering every defect ADR-0056
// requires the harness to catch — a step claiming an external action it
// didn't actually take, a step with no real anchor, and a step whose
// anchor doesn't resolve to a real span of the turn's reasoning — plus the
// truthful case those checks must NOT flag.

import type { InterimThoughtStep, ThoughtStepAnchor } from "$lib/types";
import type { ThoughtStepAuditResult } from "../thought-step-scoring";

/** Computes an anchor from a literal substring of `thinkingText`, instead of
 * hand-counted character offsets, so a fixture's intent stays legible and a
 * typo in the substring fails loudly (at module load, not silently) rather
 * than producing a subtly wrong anchor. */
function anchorFor(thinkingText: string, substring: string): ThoughtStepAnchor {
	const start = thinkingText.indexOf(substring);
	if (start === -1) {
		throw new Error(
			`thought-step-fixtures: anchorFor could not find substring ${JSON.stringify(substring)} in thinkingText`,
		);
	}
	return { start, end: start + substring.length };
}

export type ThoughtStepFixtureCategory =
	// The step's claim is fully supported by the reasoning chunk its anchor
	// points at — the harness must NOT flag any of the three defects.
	| "truthful"
	// A classified (reasoning-text-derived) step asserting an external
	// action ("Searched the web") — per ADR-0056 this is ALWAYS a
	// fabrication regardless of anchor validity, because action-implying
	// classes may originate only from real tool events.
	| "fabricated_action_classified"
	// An event-sourced step asserting an external action, but its
	// `toolCallId` does not match any tool call actually persisted for the
	// turn — claims to be event-backed but isn't.
	| "fabricated_action_event_no_match"
	// `anchor: null` — the step never named an anchor at all.
	| "unanchored"
	// The step HAS an anchor object, but it does not resolve to a real span
	// of the persisted `thinking` text (out of bounds, or start >= end).
	| "anchor_out_of_range"
	// The step names an optional entity that is not a verbatim substring of
	// its (validly resolving) anchor span.
	| "unsupported_entity";

export type ThoughtStepFixture = {
	id: string;
	category: ThoughtStepFixtureCategory;
	description: string;
	thinkingText: string;
	/** Tool-call ids actually persisted for this synthetic turn. */
	realToolCallIds: string[];
	step: InterimThoughtStep;
	expected: ThoughtStepAuditResult;
};

const TRUTHFUL_CLASSIFIED_THINKING =
	"Let me think through this. The user is asking how photosynthesis works, " +
	"so I should walk through chlorophyll absorbing light and converting CO2 " +
	"and water into glucose and oxygen.";

const TRUTHFUL_EVENT_THINKING =
	"I don't know the current price offhand, so I should look this up before " +
	"answering with a number I can't verify.";

const TRUTHFUL_DETERMINISTIC_THINKING =
	"Standard depth was resolved for this turn; no elevated grounding need was detected.";

const FABRICATED_CLASSIFIED_THINKING =
	"The user wants a definition of recursion, which I already know well " +
	"from training and can explain directly without looking anything up.";

const FABRICATED_EVENT_NO_MATCH_THINKING =
	"I'll check the web for the current exchange rate before answering.";

const UNANCHORED_THINKING =
	"Considering a few different ways to phrase the explanation before settling on one.";

const OUT_OF_RANGE_THINKING = "Short reasoning chunk, nothing more to it.";

const UNSUPPORTED_ENTITY_THINKING =
	"Reviewing what's already known about the topic before drafting a reply.";

export const thoughtStepFixtures: ThoughtStepFixture[] = [
	// ── truthful ─────────────────────────────────────────────────────────
	{
		id: "truthful-classified-reasoning-active",
		category: "truthful",
		description:
			"Classified step describing ordinary reasoning, anchored to the exact chunk that produced it, no entity claimed, no action implied.",
		thinkingText: TRUTHFUL_CLASSIFIED_THINKING,
		realToolCallIds: [],
		step: {
			id: "step-1",
			source: "classified",
			activityClass: "reasoning_active",
			impliesExternalAction: false,
			anchor: anchorFor(
				TRUTHFUL_CLASSIFIED_THINKING,
				"Let me think through this. The user is asking how photosynthesis works,",
			),
		},
		expected: {
			unanchored: false,
			fabricatedAction: false,
			unsupportedEntity: false,
			truthful: true,
		},
	},
	{
		id: "truthful-classified-with-supported-entity",
		category: "truthful",
		description:
			"Classified step naming an entity that IS a verbatim (case-insensitive) substring of its anchor span.",
		thinkingText: TRUTHFUL_CLASSIFIED_THINKING,
		realToolCallIds: [],
		step: {
			id: "step-2",
			source: "classified",
			activityClass: "reasoning_active",
			impliesExternalAction: false,
			entity: "Photosynthesis",
			anchor: anchorFor(
				TRUTHFUL_CLASSIFIED_THINKING,
				"asking how photosynthesis works",
			),
		},
		expected: {
			unanchored: false,
			fabricatedAction: false,
			unsupportedEntity: false,
			truthful: true,
		},
	},
	{
		id: "truthful-event-tool-call-matches",
		category: "truthful",
		description:
			"Event-sourced step claiming an external action, whose toolCallId matches a tool call actually persisted for this turn.",
		thinkingText: TRUTHFUL_EVENT_THINKING,
		realToolCallIds: ["call_research_web_1"],
		step: {
			id: "step-3",
			source: "event",
			activityClass: "tool_call:research_web",
			impliesExternalAction: true,
			toolCallId: "call_research_web_1",
			anchor: anchorFor(
				TRUTHFUL_EVENT_THINKING,
				"I should look this up before answering",
			),
		},
		expected: {
			unanchored: false,
			fabricatedAction: false,
			unsupportedEntity: false,
			truthful: true,
		},
	},
	{
		id: "truthful-deterministic-spine-step",
		category: "truthful",
		description:
			"Deterministic spine step (no external action implied), anchored to the whole reasoning chunk it summarizes.",
		thinkingText: TRUTHFUL_DETERMINISTIC_THINKING,
		realToolCallIds: [],
		step: {
			id: "step-4",
			source: "deterministic",
			activityClass: "depth_resolved",
			impliesExternalAction: false,
			anchor: anchorFor(
				TRUTHFUL_DETERMINISTIC_THINKING,
				"Standard depth was resolved for this turn",
			),
		},
		expected: {
			unanchored: false,
			fabricatedAction: false,
			unsupportedEntity: false,
			truthful: true,
		},
	},

	// ── fabricated_action_classified ────────────────────────────────────
	{
		id: "fabricated-action-classified-web-search",
		category: "fabricated_action_classified",
		description:
			"Classified (reasoning-text-derived) step claiming 'Searched the web' — always a fabrication per ADR-0056, regardless of anchor validity.",
		thinkingText: FABRICATED_CLASSIFIED_THINKING,
		realToolCallIds: [],
		step: {
			id: "step-5",
			source: "classified",
			activityClass: "tool_call:research_web",
			label: "Searched the web",
			impliesExternalAction: true,
			anchor: anchorFor(
				FABRICATED_CLASSIFIED_THINKING,
				"can explain directly without looking anything up",
			),
		},
		expected: {
			unanchored: false,
			fabricatedAction: true,
			unsupportedEntity: false,
			truthful: false,
		},
	},
	{
		id: "fabricated-action-deterministic-claims-fetch",
		category: "fabricated_action_classified",
		description:
			"Deterministic-sourced step claiming an external action — deterministic steps never carry a real tool event, so this is also a fabrication.",
		thinkingText: FABRICATED_CLASSIFIED_THINKING,
		realToolCallIds: [],
		step: {
			id: "step-6",
			source: "deterministic",
			activityClass: "tool_call:fetch_url",
			impliesExternalAction: true,
			anchor: anchorFor(FABRICATED_CLASSIFIED_THINKING, "recursion"),
		},
		expected: {
			unanchored: false,
			fabricatedAction: true,
			unsupportedEntity: false,
			truthful: false,
		},
	},

	// ── fabricated_action_event_no_match ────────────────────────────────
	{
		id: "fabricated-action-event-wrong-tool-call-id",
		category: "fabricated_action_event_no_match",
		description:
			"Event-sourced step claiming an action, but its toolCallId does not match any tool call actually persisted for the turn.",
		thinkingText: FABRICATED_EVENT_NO_MATCH_THINKING,
		realToolCallIds: ["call_unrelated_9"],
		step: {
			id: "step-7",
			source: "event",
			activityClass: "tool_call:research_web",
			impliesExternalAction: true,
			toolCallId: "call_exchange_rate_1",
			anchor: anchorFor(
				FABRICATED_EVENT_NO_MATCH_THINKING,
				"I'll check the web for the current exchange rate",
			),
		},
		expected: {
			unanchored: false,
			fabricatedAction: true,
			unsupportedEntity: false,
			truthful: false,
		},
	},
	{
		id: "fabricated-action-event-missing-tool-call-id",
		category: "fabricated_action_event_no_match",
		description:
			"Event-sourced step claiming an action with NO toolCallId at all — cannot be checked against a real tool event, so it fabricates.",
		thinkingText: FABRICATED_EVENT_NO_MATCH_THINKING,
		realToolCallIds: ["call_exchange_rate_1"],
		step: {
			id: "step-8",
			source: "event",
			activityClass: "tool_call:research_web",
			impliesExternalAction: true,
			anchor: anchorFor(
				FABRICATED_EVENT_NO_MATCH_THINKING,
				"I'll check the web for the current exchange rate",
			),
		},
		expected: {
			unanchored: false,
			fabricatedAction: true,
			unsupportedEntity: false,
			truthful: false,
		},
	},

	// ── unanchored ───────────────────────────────────────────────────────
	{
		id: "unanchored-no-anchor-object",
		category: "unanchored",
		description:
			"Step with anchor: null — never named a reasoning span at all.",
		thinkingText: UNANCHORED_THINKING,
		realToolCallIds: [],
		step: {
			id: "step-9",
			source: "classified",
			activityClass: "reasoning_active",
			impliesExternalAction: false,
			anchor: null,
		},
		expected: {
			unanchored: true,
			fabricatedAction: false,
			unsupportedEntity: false,
			truthful: false,
		},
	},

	// ── anchor_out_of_range ─────────────────────────────────────────────
	{
		id: "anchor-out-of-range-end-past-text-length",
		category: "anchor_out_of_range",
		description:
			"Anchor.end is past the end of the actual persisted thinking text.",
		thinkingText: OUT_OF_RANGE_THINKING,
		realToolCallIds: [],
		step: {
			id: "step-10",
			source: "classified",
			activityClass: "reasoning_active",
			impliesExternalAction: false,
			anchor: { start: 0, end: OUT_OF_RANGE_THINKING.length + 500 },
		},
		expected: {
			unanchored: true,
			fabricatedAction: false,
			unsupportedEntity: false,
			truthful: false,
		},
	},
	{
		id: "anchor-out-of-range-start-after-end",
		category: "anchor_out_of_range",
		description: "Anchor.start >= anchor.end — a zero or negative-length span.",
		thinkingText: OUT_OF_RANGE_THINKING,
		realToolCallIds: [],
		step: {
			id: "step-11",
			source: "classified",
			activityClass: "reasoning_active",
			impliesExternalAction: false,
			anchor: { start: 10, end: 10 },
		},
		expected: {
			unanchored: true,
			fabricatedAction: false,
			unsupportedEntity: false,
			truthful: false,
		},
	},
	{
		id: "anchor-out-of-range-negative-start",
		category: "anchor_out_of_range",
		description: "Anchor.start is negative.",
		thinkingText: OUT_OF_RANGE_THINKING,
		realToolCallIds: [],
		step: {
			id: "step-12",
			source: "classified",
			activityClass: "reasoning_active",
			impliesExternalAction: false,
			anchor: { start: -5, end: 10 },
		},
		expected: {
			unanchored: true,
			fabricatedAction: false,
			unsupportedEntity: false,
			truthful: false,
		},
	},

	// ── unsupported_entity ──────────────────────────────────────────────
	{
		id: "unsupported-entity-not-in-anchor-span",
		category: "unsupported_entity",
		description:
			"Step names an entity that does not appear anywhere in its (validly resolving) anchor span.",
		thinkingText: UNSUPPORTED_ENTITY_THINKING,
		realToolCallIds: [],
		step: {
			id: "step-13",
			source: "classified",
			activityClass: "reasoning_active",
			impliesExternalAction: false,
			entity: "Kubernetes",
			anchor: anchorFor(
				UNSUPPORTED_ENTITY_THINKING,
				"Reviewing what's already known about the topic",
			),
		},
		expected: {
			unanchored: false,
			fabricatedAction: false,
			unsupportedEntity: true,
			truthful: false,
		},
	},
];

export type ThoughtStepFixtureCorpusStats = {
	total: number;
	byCategory: Record<string, number>;
};

/**
 * Pure descriptive-statistics summary of the corpus. Used by
 * thought-step-fixtures.test.ts to guard the corpus-shape constraint (every
 * required category present at least once) as a regression test rather than
 * a one-time hand count.
 */
export function summarizeThoughtStepFixtureCorpus(
	fixtures: ThoughtStepFixture[],
): ThoughtStepFixtureCorpusStats {
	const byCategory: Record<string, number> = {};
	for (const fixture of fixtures) {
		byCategory[fixture.category] = (byCategory[fixture.category] ?? 0) + 1;
	}
	return { total: fixtures.length, byCategory };
}
