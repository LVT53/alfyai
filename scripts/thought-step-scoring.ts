// Pure scoring functions for the P3a honesty audit harness
// (scripts/audit-thought-step-honesty.ts). Mirrors the
// scripts/tool-guidance-scoring.ts convention for the sibling G0 harness:
// everything in this module is a pure function with no I/O — no DB access,
// no file access, no model call. The harness composes these with a real DB
// read (scripts/audit-thought-step-honesty.ts's `sampleLiveTurns`, NOT
// unit-tested here; only a live/synthetic harness run exercises it).
//
// ADR-0056 ("What makes a step true") fixes the defects an emitted Interim
// Thought Step must never have. This module turns each into an independent,
// pure check:
//
//   - unanchored: the step has no anchor, or its anchor does not resolve to
//     a real `[start, end)` span of the turn's persisted `messages.thinking`
//     (see `resolveThoughtStepAnchorSpan` in
//     src/lib/server/services/chat-turn/thought-steps.ts, reused here
//     read-only).
//   - fabricatedAction: the step asserts an external action
//     (`impliesExternalAction`) that did not come from a real tool event —
//     either the step's `source` isn't "event" at all (a classified/
//     deterministic step is NEVER allowed to claim an action, per ADR-0056),
//     or it claims to be event-sourced but its `toolCallId` doesn't match
//     any tool call actually persisted for the turn.
//   - unsupportedEntity: the step names an optional entity that is not a
//     verbatim (case-insensitive) substring of its anchor's resolved text —
//     the same "verbatim substring" honesty discipline P2's turn
//     acknowledgment already established (see ADR-0056's Implementation
//     status section) applied to the reasoning span instead of the user's
//     message.
//
// `truthful` is the negation of all three — a step is truthful exactly when
// none of the above defects apply to it.

import type { InterimThoughtStep } from "$lib/response-activity-types";
import { resolveThoughtStepAnchorSpan } from "$lib/server/services/chat-turn/thought-steps";

export type ThoughtStepAuditResult = {
	unanchored: boolean;
	fabricatedAction: boolean;
	unsupportedEntity: boolean;
	truthful: boolean;
};

export type ThoughtStepScoringInput = {
	thinkingText: string;
	/** Tool-call ids actually persisted for this turn (see
	 * `extractRealToolCallIds`) — the ground truth an event-sourced step's
	 * `toolCallId` must resolve against. */
	realToolCallIds: ReadonlySet<string>;
};

/** Does the step's anchor resolve to a real, non-empty span of the turn's
 * persisted `thinking` text? */
export function isAnchorResolved(
	step: Pick<InterimThoughtStep, "anchor">,
	thinkingText: string,
): boolean {
	return resolveThoughtStepAnchorSpan(step.anchor, thinkingText) !== null;
}

/**
 * Does this step fabricate an external action? Per ADR-0056, a step whose
 * class implies an external action (`impliesExternalAction`) may originate
 * ONLY from a real tool event: `source === "event"` AND a `toolCallId` that
 * matches a tool call genuinely persisted for this turn. Any other
 * combination — a classified or deterministic step claiming an action, or
 * an "event" step with no matching real tool call — counts as fabrication.
 * A step that does not claim an external action at all can never fabricate
 * one, regardless of source.
 */
export function isFabricatedActionClaim(
	step: Pick<
		InterimThoughtStep,
		"impliesExternalAction" | "source" | "toolCallId"
	>,
	realToolCallIds: ReadonlySet<string>,
): boolean {
	if (!step.impliesExternalAction) return false;
	if (step.source !== "event") return true;
	if (!step.toolCallId) return true;
	return !realToolCallIds.has(step.toolCallId);
}

/**
 * Is the step's optional entity a verbatim (case-insensitive) substring of
 * its anchor's resolved reasoning text? A step with no entity trivially
 * passes (there is nothing to falsify). A step WITH an entity but an
 * unresolved anchor cannot be verified and counts as unsupported — an
 * unanchored step's entity claim is exactly as ungrounded as the step
 * itself.
 */
export function isEntitySupported(
	step: Pick<InterimThoughtStep, "entity" | "anchor">,
	thinkingText: string,
): boolean {
	if (!step.entity) return true;
	const span = resolveThoughtStepAnchorSpan(step.anchor, thinkingText);
	if (span === null) return false;
	return span.toLowerCase().includes(step.entity.toLowerCase());
}

/**
 * Composes the three defect checks into one audit result for a single step.
 * This is the harness's core per-step check: "every emitted step against
 * the chunk that produced it."
 */
export function scoreThoughtStep(
	step: InterimThoughtStep,
	input: ThoughtStepScoringInput,
): ThoughtStepAuditResult {
	const unanchored = !isAnchorResolved(step, input.thinkingText);
	const fabricatedAction = isFabricatedActionClaim(step, input.realToolCallIds);
	const unsupportedEntity = !isEntitySupported(step, input.thinkingText);
	return {
		unanchored,
		fabricatedAction,
		unsupportedEntity,
		truthful: !unanchored && !fabricatedAction && !unsupportedEntity,
	};
}

export type ThoughtStepAuditSummary = {
	total: number;
	truthfulCount: number;
	/** `null` (never `0`) when `total` is `0`, mirroring
	 * `summarizeHitRate`'s convention: a report must never conflate "0% "
	 * with "nothing to audit". */
	truthfulRate: number | null;
	fabricatedActionCount: number;
	unanchoredCount: number;
	unsupportedEntityCount: number;
};

/** Aggregates per-step audit results into the report's headline counts. */
export function summarizeThoughtStepAudit(
	results: ThoughtStepAuditResult[],
): ThoughtStepAuditSummary {
	const total = results.length;
	const truthfulCount = results.filter((r) => r.truthful).length;
	return {
		total,
		truthfulCount,
		truthfulRate: total > 0 ? truthfulCount / total : null,
		fabricatedActionCount: results.filter((r) => r.fabricatedAction).length,
		unanchoredCount: results.filter((r) => r.unanchored).length,
		unsupportedEntityCount: results.filter((r) => r.unsupportedEntity).length,
	};
}

/** The P3 enable gate stated in architecture-deepening-slices.md § P3a and
 * ADR-0056's "Implementation status": >95% truthful AND zero fabricated
 * action claims. Exported as a named constant so the harness's printed gate
 * statement and this module's threshold can never drift apart. */
export const ENABLE_GATE_TRUTHFUL_RATE_THRESHOLD = 0.95;

export type EnableGateVerdict = "pass" | "fail" | "not_applicable";

/**
 * Evaluates the P3 enable gate against an audit summary. Returns
 * `"not_applicable"` (never a vacuous "pass") when `total === 0` — a rail
 * with nothing sampled has not been proven honest, it has been proven
 * absent, and the gate must not confuse the two.
 */
export function evaluateEnableGate(
	summary: ThoughtStepAuditSummary,
): EnableGateVerdict {
	if (summary.total === 0) return "not_applicable";
	const truthfulOk =
		summary.truthfulRate !== null &&
		summary.truthfulRate > ENABLE_GATE_TRUTHFUL_RATE_THRESHOLD;
	const noFabrication = summary.fabricatedActionCount === 0;
	return truthfulOk && noFabrication ? "pass" : "fail";
}
