// Tier B2 (chat-experience-elevation §5) — the shared activity / thought-step
// PRESENTATION layer, extracted out of the two god-components
// (ThinkingBlock.svelte + MessageBubble.svelte) that both classified and
// labelled the SAME wire concepts (classified thought-step entries,
// tool-progress activity — the `ResponseActivityEntry` family) with their
// own independent, drift-prone copies.
//
// This is the ONE home for those pure decisions:
//   - the "is this a thought-step / tool-progress" predicates,
//   - the classified thought-step class -> leading-icon-type mapping.
//
// It mirrors the existing `reasoning-spine.ts` /
// `tool-evidence-presentation.ts` extractions: pure functions returning plain
// data (icon-TYPE strings the component switches on, plain numbers/booleans),
// unit-tested directly rather than only reachable through the huge component
// tests.
//
// Boundary rule (per the B2 brief, matching B1): nothing Svelte-reactive and
// nothing that imports the `$t` store lives here.
import type {
	ResponseActivityEntry,
	ThoughtStepClassifierActivityClass,
} from "$lib/response-activity-types";

/** The closed set of leading icons a classified thought step can show. */
export type ThoughtStepIconType =
	| "help-circle"
	| "history"
	| "scale"
	| "workflow"
	| "list-checks"
	| "pen-line";

// ---------------------------------------------------------------------------
// Predicates — "is this one of the thought-step / tool-progress wire
// concepts?", over the common fields both adapters key off.
// ---------------------------------------------------------------------------

/**
 * A live classified-thought-step response-activity entry carrying a non-empty
 * `detail` (the closed activity class). MessageBubble locates the raw wire
 * entry with this; ThinkingBlock owns the honesty-gated class -> label lookup.
 */
export function isThoughtStepActivityEntry(
	entry: ResponseActivityEntry,
): entry is ResponseActivityEntry & { detail: string } {
	return entry.kind === "thought_step" && Boolean(entry.detail?.trim());
}

/**
 * A transient tool-progress response-activity entry (`tool-progress:*` id with
 * a non-empty label) — MessageBubble's `isToolProgressActivity`.
 */
export function isToolProgressActivity(
	entry: ResponseActivityEntry,
): entry is ResponseActivityEntry & { label: string } {
	return entry.id.startsWith("tool-progress:") && Boolean(entry.label?.trim());
}

// ---------------------------------------------------------------------------
// Icon-type mapping.
// ---------------------------------------------------------------------------

/**
 * Maps a classified thought-step activity class to its leading icon type
 * (ThinkingBlock's `getThoughtStepClassIconType`). Exhaustive over the closed
 * `ThoughtStepClassifierActivityClass` enum.
 */
export function thoughtStepIconTypeForClass(
	activityClass: ThoughtStepClassifierActivityClass,
): ThoughtStepIconType {
	if (activityClass === "understanding-request") return "help-circle";
	if (activityClass === "recalling-context") return "history";
	if (activityClass === "weighing-options") return "scale";
	if (activityClass === "working-through-logic") return "workflow";
	if (activityClass === "checking-details") return "list-checks";
	return "pen-line"; // "drafting-approach"
}
