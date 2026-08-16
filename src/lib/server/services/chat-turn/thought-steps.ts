// ADR-0056 (Interim Thought Steps are durable turn state) / programme slice
// P3a — the durable Thought Step read model.
//
// This module is deliberately dormant: nothing in the app writes a
// `thoughtSteps` key yet (that is P3b's classifier + step-emission work),
// and nothing here calls the DB. It exists solely to give the P3a honesty
// audit harness (scripts/audit-thought-step-honesty.ts) — and, later, P3b's
// emission code and the step-rail UI — one shared, tested way to parse the
// durable shape back out of what's already persisted:
//
//   - `parseThoughtSteps` reads the additive `thoughtSteps` key that will
//     live inside a message's existing `metadataJson` blob (see
//     `PersistedMessageMetadata` in ../messages.ts) — no schema migration,
//     the same way `depthMetadata` / `webCitationAudit` / etc. already ride
//     that column.
//   - `extractRealToolCallIds` reads the turn's ALREADY-persisted tool call
//     ids from the existing `messages.toolCalls` column (which stores
//     `ThinkingSegment[]`, not raw tool calls, despite the column's name —
//     see `readThinkingSegmentsFromRow` in ../messages.ts for the sibling
//     reader). This is the "real tool event" a Thought Step Anchor claiming
//     an external action must be checked against, per ADR-0056: action-
//     implying steps may originate only from real tool events.
//   - `resolveThoughtStepAnchorSpan` resolves a Thought Step Anchor's
//     `[start, end)` character span against the turn's persisted
//     `messages.thinking` text — the same resolution the eventual step-rail
//     UI will use to scroll/highlight the raw Thinking Trace.
//
// Every function here is pure: given the same inputs (plain strings — no DB
// row, no schema import), it returns the same output. Malformed/absent JSON
// degrades to an empty result rather than throwing, mirroring the existing
// `parseMetadata` / `readThinkingSegmentsFromRow` convention in
// ../messages.ts.

import type {
	InterimThoughtStep,
	ThoughtStepAnchor,
} from "$lib/response-activity-types";
import { isInterimThoughtStepArray } from "$lib/response-activity-types";
import type { ThinkingSegment } from "$lib/server/services/messages-types";

/**
 * Parses the `thoughtSteps` array out of a message's persisted
 * `metadataJson` blob. Returns `[]` when the column is empty, the JSON is
 * malformed, or the `thoughtSteps` key is absent or not a valid
 * `InterimThoughtStep[]` — there is no partial/best-effort result, since a
 * malformed steps array is exactly the kind of thing the P3a harness must
 * be able to flag rather than silently repair.
 */
export function parseThoughtSteps(
	metadataJson: string | null | undefined,
): InterimThoughtStep[] {
	if (!metadataJson) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(metadataJson);
	} catch {
		return [];
	}
	if (!parsed || typeof parsed !== "object") return [];
	const candidate = (parsed as { thoughtSteps?: unknown }).thoughtSteps;
	return isInterimThoughtStepArray(candidate) ? candidate : [];
}

/**
 * Extracts the set of real, persisted tool-call ids for a turn from the
 * existing `messages.toolCalls` column (a `ThinkingSegment[]` JSON blob).
 * This is the ground truth an event-sourced Thought Step's `toolCallId`
 * must resolve against to count as a real tool event, not a fabricated one.
 */
export function extractRealToolCallIds(
	toolCallsColumnJson: string | null | undefined,
): Set<string> {
	const ids = new Set<string>();
	if (!toolCallsColumnJson) return ids;
	let parsed: unknown;
	try {
		parsed = JSON.parse(toolCallsColumnJson);
	} catch {
		return ids;
	}
	if (!Array.isArray(parsed)) return ids;
	for (const entry of parsed as ThinkingSegment[]) {
		if (
			entry &&
			typeof entry === "object" &&
			(entry as { type?: unknown }).type === "tool_call"
		) {
			const callId = (entry as Extract<ThinkingSegment, { type: "tool_call" }>)
				.callId;
			if (typeof callId === "string" && callId.length > 0) {
				ids.add(callId);
			}
		}
	}
	return ids;
}

/**
 * Resolves a Thought Step Anchor's `[start, end)` span against the turn's
 * persisted `thinking` text. Returns `null` — never throws, never clamps —
 * when the anchor is absent or does not resolve to a real, non-empty span:
 * non-integer bounds, `start < 0`, `end <= start`, or `end` past the end of
 * the actual persisted text. A `null` result is exactly what the P3a
 * harness counts as an "unanchored" defect; silently clamping an
 * out-of-range anchor would hide the very thing this module exists to
 * surface.
 */
export function resolveThoughtStepAnchorSpan(
	anchor: ThoughtStepAnchor | null | undefined,
	thinkingText: string,
): string | null {
	if (!anchor) return null;
	const { start, end } = anchor;
	if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
	if (start < 0 || end <= start || end > thinkingText.length) return null;
	return thinkingText.slice(start, end);
}
