// Tier B2 (chat-experience-elevation §5) — the shared activity /
// deliberation / thought-step PRESENTATION layer, extracted out of the two
// god-components (ThinkingBlock.svelte + MessageBubble.svelte) that both
// classified and labelled the SAME wire concepts (deliberation-pass status,
// classified thought-step entries, tool-progress activity — the
// `ResponseActivityEntry` / deliberation family) with their own independent,
// drift-prone copies.
//
// This is the ONE home for those pure decisions:
//   - the "is this a deliberation-pass status / deliberation activity /
//     thought-step / tool-progress" predicates,
//   - the `passKind` -> leading-icon-type mapping,
//   - the `deliberation-pass-N` id -> pass-index parsing (and the
//     explicit-`passIndex`-preferred resolution),
//   - the classified thought-step class -> leading-icon-type mapping,
//   - the "Deliberating: N/M · label" progress-label assembly.
//
// It mirrors the existing `reasoning-spine.ts` / `deliberation-progress.ts` /
// `tool-evidence-presentation.ts` extractions: pure functions returning plain
// data (icon-TYPE strings the component switches on, plain numbers/booleans),
// unit-tested directly rather than only reachable through the huge component
// tests.
//
// Boundary rule (per the B2 brief, matching B1): nothing Svelte-reactive and
// nothing that imports the `$t` store lives here. The one i18n-coupled builder
// (`formatDeliberationProgressLabel`) takes the translator as a plain
// `Translate` parameter — each component threads its own `$t` in — so the
// branching/assembly logic stays here and directly testable with a fake
// translator, while the component keeps only a one-line binding shell.
//
// Server-type imports are `import type` only (erased at compile time), so this
// stays a client-safe module even though `ThinkingSegment` originates under
// `$lib/server` — the same pattern `tool-evidence-presentation.ts` relies on.
import type { I18nKey } from "$lib/i18n";
import type {
	ResponseActivityEntry,
	ThoughtStepClassifierActivityClass,
} from "$lib/response-activity-types";
import type { ThinkingSegment } from "$lib/server/services/messages-types";

/**
 * The translator shape the component's `$t` store already satisfies. Threaded
 * in as a parameter so the i18n-coupled label builder stays pure and
 * unit-testable without pulling the Svelte i18n store into this module (same
 * `Translate` contract as `tool-evidence-presentation.ts`).
 */
export type Translate = (
	key: I18nKey,
	params?: Record<string, string | number>,
) => string;

/** A deliberation-pass status thinking segment (the `status` variant). */
export type DeliberationStatusThinkingSegment = Extract<
	ThinkingSegment,
	{ type: "status" }
>;

/** A live "deliberation" response-activity entry. */
export type DeliberationActivityEntry = ResponseActivityEntry & {
	kind: "deliberation";
};

/**
 * The closed set of leading icons a deliberation pass can show. The component
 * switches on this plain string tag to render the matching Lucide glyph — the
 * same idiom the file already used for its inline copy.
 */
export type DeliberationIconType =
	| "search"
	| "clipboard-check"
	| "shield-alert"
	| "languages"
	| "layers"
	| "bot";

/** The closed set of leading icons a classified thought step can show. */
export type ThoughtStepIconType =
	| "help-circle"
	| "history"
	| "scale"
	| "workflow"
	| "list-checks"
	| "pen-line";

// ---------------------------------------------------------------------------
// Predicates — "is this one of the deliberation / thought-step / tool-progress
// wire concepts?", over the common fields both adapters key off.
// ---------------------------------------------------------------------------

/**
 * A deliberation-pass status segment: a `status` thinking segment whose id is
 * a `deliberation-pass-*` and which carries a non-empty label. Both components
 * gated on exactly this (ThinkingBlock's `isDeliberationStatusSegment`,
 * MessageBubble's `isDeliberationThinkingStatus`).
 */
export function isDeliberationStatusSegment(
	segment: ThinkingSegment,
): segment is DeliberationStatusThinkingSegment {
	return (
		segment.type === "status" &&
		segment.id.startsWith("deliberation-pass-") &&
		Boolean(segment.label?.trim())
	);
}

/**
 * A live "deliberation" response-activity entry carrying a non-empty label
 * (MessageBubble's `isDeliberationActivityEntry`).
 */
export function isDeliberationActivityEntry(
	entry: ResponseActivityEntry | undefined,
): entry is DeliberationActivityEntry {
	return entry?.kind === "deliberation" && Boolean(entry.label?.trim());
}

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
// Pass-index parsing.
// ---------------------------------------------------------------------------

const DELIBERATION_PASS_ID_PATTERN = /deliberation-pass-(\d+)/i;

/**
 * Parses the pass index out of a `deliberation-pass-N` id. Returns the
 * positive integer N, or `null` when the id carries no positive integer
 * (malformed, missing, or a non-positive value). This is the shared regex both
 * components used verbatim.
 */
export function parseDeliberationPassIndex(id: string): number | null {
	const match = DELIBERATION_PASS_ID_PATTERN.exec(id);
	const parsed = match ? Number.parseInt(match[1], 10) : Number.NaN;
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Resolves the current pass index for a deliberation status, preferring an
 * explicit `passIndex` field (any integer — including 0 / negative, matching
 * the pre-extraction behaviour, which trusted an explicit field over the id)
 * and falling back to parsing the id. Returns `null` when neither yields an
 * index. This is exactly MessageBubble's `deliberationPassIndex`.
 */
export function resolveDeliberationPassIndex(
	status: { passIndex?: number; id: string } | undefined,
): number | null {
	if (!status) return null;
	if (
		typeof status.passIndex === "number" &&
		Number.isInteger(status.passIndex)
	) {
		return status.passIndex;
	}
	return parseDeliberationPassIndex(status.id);
}

// ---------------------------------------------------------------------------
// Icon-type mapping.
// ---------------------------------------------------------------------------

/**
 * Maps a deliberation pass kind (the closed `DeliberationPassKind` catalogue)
 * to its leading icon type. Returns `null` for an unknown / absent pass kind,
 * so each caller supplies its own fallback:
 *   - MessageBubble: a bare `"search"` default (`?? "search"`).
 *   - ThinkingBlock: a pass-index-derived fallback
 *     (`?? deliberationIconTypeForPassIndex(...)`).
 * This is the genuinely shared core — the mapping was byte-identical in both
 * components and is the highest drift risk of the whole seam.
 */
export function deliberationIconTypeForPassKind(
	passKind: string | undefined,
): DeliberationIconType | null {
	if (
		passKind === "context_source_gap_review" ||
		passKind === "evidence_gap_review" ||
		passKind === "source_reconciliation"
	) {
		return "search";
	}
	if (
		passKind === "missed_user_need_check" ||
		passKind === "answer_plan_critique" ||
		passKind === "final_format_style_check"
	) {
		return "clipboard-check";
	}
	if (
		passKind === "contradiction_risk_check" ||
		passKind === "adversarial_edge_case_check"
	) {
		return "shield-alert";
	}
	if (passKind === "hungarian_parity_check") return "languages";
	if (passKind === "workspace_synthesis") return "layers";
	if (passKind === "viable_alternatives_preservation") return "bot";
	return null;
}

/**
 * ThinkingBlock's pass-index fallback icon, used ONLY when the pass kind is
 * unknown: pass 1 -> search, pass 2 -> clipboard-check, otherwise shield-alert.
 * Component-specific (MessageBubble has no such fallback — it defaults flat to
 * "search"), but kept here as a pure, directly-testable sibling of the
 * pass-kind mapping.
 */
export function deliberationIconTypeForPassIndex(
	passIndex: number,
): DeliberationIconType {
	if (passIndex === 1) return "search";
	if (passIndex === 2) return "clipboard-check";
	return "shield-alert";
}

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

// ---------------------------------------------------------------------------
// Label assembly.
// ---------------------------------------------------------------------------

/**
 * Builds the "Deliberating: N/M · label" progress label, or the bare label
 * when there is no determinate pass count. `currentPass` is the ALREADY
 * RESOLVED pass index (`null` when there is no determinate current pass): the
 * progress form appears only when it is non-null AND `passTotal` is a positive
 * integer, otherwise the bare (trimmed) label is returned. An empty label
 * yields `""`.
 *
 * The "what counts as a determinate current pass" rule is the per-component
 * adapter, threaded in via `currentPass` (the two components genuinely differ
 * here, so it is a parameter, not a collapse):
 *   - MessageBubble showed the progress form only for a TRUTHY pass number, so
 *     it passes `resolveDeliberationPassIndex(status) || null` (mapping the one
 *     falsy integer, 0, to `null`).
 *   - ThinkingBlock always had a current (its id fallback defaulted to 1) and
 *     showed progress whenever the total was valid, so it passes
 *     `resolveDeliberationPassIndex(segment) ?? 1` (never `null`).
 */
export function formatDeliberationProgressLabel(
	label: string,
	currentPass: number | null,
	passTotal: number | undefined,
	translate: Translate,
): string {
	const trimmed = label.trim();
	if (!trimmed) return "";
	if (
		currentPass !== null &&
		typeof passTotal === "number" &&
		Number.isInteger(passTotal) &&
		passTotal > 0
	) {
		return translate("chat.deliberatingProgress", {
			current: currentPass,
			total: passTotal,
			label: trimmed,
		});
	}
	return trimmed;
}
