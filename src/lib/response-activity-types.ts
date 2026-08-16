// ADR-0056 (Interim Thought Steps are durable turn state) — the shared
// contract for live "what is the model doing right now" turn progress:
// ResponseActivityEntry kinds/status, the closed instant-acknowledgment
// intent enum, the closed thought-step classifier activity/verdict enums,
// and the durable Thought Step + Thought Step Anchor shape. Client- and
// server-shared (the classifier and emission code live server-side under
// chat-turn/; MessageBubble.svelte and ThinkingBlock.svelte consume the
// guards client-side) — relocated out of the former src/lib/types.ts
// god-module (architecture-deepening T1); this file carries no behavior
// change, only a new home.

export type ResponseActivityKind =
	| "depth"
	| "deliberation"
	| "context"
	| "tool"
	| "source"
	| "drafting"
	| "fallback"
	| "file"
	// P2 (ADR-0056) — instant turn acknowledgment. A one-shot, best-effort
	// entry carrying a closed intent class (in `detail`) and an optional
	// verbatim-substring topic (in `label`) lifted from the user's own
	// message. Never implies an external action (ADR-0056's classifier
	// constraint) — it only names what the turn is about.
	| "acknowledgment"
	// P3b (ADR-0056) — a classified Interim Thought Step. One entry per
	// NEW classified step (never for a continuation verdict, which extends
	// the existing step's anchor instead of emitting again). `detail`
	// carries the closed `ThoughtStepClassifierActivityClass`; this kind can
	// NEVER assert an external action — see THOUGHT_STEP_CLASSIFIER_ACTIVITY_CLASSES
	// below, whose members are all internal/cognitive by construction.
	| "thought_step";
export type ResponseActivityStatus = "running" | "done" | "error";
export type ResponseActivitySourceType = "web" | "document" | "memory" | "tool";
const NORMAL_CHAT_CONTEXT_PREPARATION_ACTIVITY_CLASSES = [
	"planning",
	"context-retrieval",
	"attachment-processing",
	"prompt-assembly",
	"context-compression",
	"web-grounding",
	"budgeting",
] as const;
export type NormalChatContextPreparationActivityClass =
	(typeof NORMAL_CHAT_CONTEXT_PREPARATION_ACTIVITY_CLASSES)[number];

export function isNormalChatContextPreparationActivityClass(
	value: unknown,
): value is NormalChatContextPreparationActivityClass {
	return (
		typeof value === "string" &&
		NORMAL_CHAT_CONTEXT_PREPARATION_ACTIVITY_CLASSES.includes(
			value as NormalChatContextPreparationActivityClass,
		)
	);
}

// P2 (ADR-0056) — the instant-acknowledgment closed intent enum. Shared
// between the server (chat-turn/turn-acknowledgment.ts, which asks the
// control model to pick exactly one of these and validates the answer
// against this same array) and the client (MessageBubble.svelte, which maps
// each class onto a localized template). One source of truth so the two
// sides cannot drift.
export const TURN_ACKNOWLEDGMENT_INTENT_CLASSES = [
	"research",
	"code",
	"write",
	"analyze",
	"plan",
	"chat",
] as const;
export type TurnAcknowledgmentIntentClass =
	(typeof TURN_ACKNOWLEDGMENT_INTENT_CLASSES)[number];

export function isTurnAcknowledgmentIntentClass(
	value: unknown,
): value is TurnAcknowledgmentIntentClass {
	return (
		typeof value === "string" &&
		TURN_ACKNOWLEDGMENT_INTENT_CLASSES.includes(
			value as TurnAcknowledgmentIntentClass,
		)
	);
}

// P3b (ADR-0056) — the reasoning-phase classifier's closed activity-class
// enum. This is the structural half of "action classes come only from real
// tool events, never from reasoning-text classification": every member here
// names an internal/cognitive activity, and NONE of them name or imply an
// external action (searching, fetching, reading a connected account). The
// classifier (src/lib/server/services/chat-turn/thought-step-classifier.ts)
// can therefore never emit an `impliesExternalAction: true` step — there is
// no class in this array it could pick that would mean one — rather than
// relying on a runtime check that a bug could bypass. Shared between the
// server (the classifier, which asks the control model to pick one of these)
// and the client (the eventual step-rail UI, which maps each to a localized
// label — see src/lib/i18n/chat.ts's `chat.responseActivity.thoughtStep.*`
// keys), exactly mirroring TURN_ACKNOWLEDGMENT_INTENT_CLASSES above.
export const THOUGHT_STEP_CLASSIFIER_ACTIVITY_CLASSES = [
	"understanding-request",
	"recalling-context",
	"weighing-options",
	"working-through-logic",
	"checking-details",
	"drafting-approach",
] as const;
export type ThoughtStepClassifierActivityClass =
	(typeof THOUGHT_STEP_CLASSIFIER_ACTIVITY_CLASSES)[number];

export function isThoughtStepClassifierActivityClass(
	value: unknown,
): value is ThoughtStepClassifierActivityClass {
	return (
		typeof value === "string" &&
		THOUGHT_STEP_CLASSIFIER_ACTIVITY_CLASSES.includes(
			value as ThoughtStepClassifierActivityClass,
		)
	);
}

// P3b (ADR-0056) — the classifier's per-chunk verdict: does this reasoning
// fragment continue the step already in progress, or start a genuinely new
// one? A "continuation" verdict extends the current step's anchor; it never
// creates a new InterimThoughtStep entry (ADR-0056: "Steps are append-only.
// An emitted step may be extended by a continuation verdict, but never
// reordered, rewritten, or retracted.").
export const THOUGHT_STEP_CLASSIFIER_VERDICTS = [
	"new_step",
	"continuation",
] as const;
export type ThoughtStepClassifierVerdict =
	(typeof THOUGHT_STEP_CLASSIFIER_VERDICTS)[number];

export interface ResponseActivityEntry {
	id: string;
	kind: ResponseActivityKind;
	status: ResponseActivityStatus;
	label?: string;
	detail?: string;
	callId?: string;
	toolName?: string;
	sourceType?: ResponseActivitySourceType;
	contextPreparationClass?: NormalChatContextPreparationActivityClass;
	title?: string;
	url?: string;
	count?: number;
	passIndex?: number;
	passTotal?: number;
	passKind?: string;
	occurredAt?: number;
}

// ADR-0056 (Interim Thought Steps are durable turn state) / programme slice
// P3a — the durable Thought Step + Thought Step Anchor contract. This fixes
// the SHAPE a persisted step and its anchor must have so the P3a honesty
// audit harness (scripts/audit-thought-step-honesty.ts) can check every
// emitted step against the reasoning span its anchor points at. It does
// NOT define P3b's classifier (the closed activity-class enum, the
// control-model call, or step emission) — `activityClass` is a plain
// string here on purpose; that enum and everything that emits a step is
// P3b's job. Once P3b emits steps, they are persisted as an additive
// `thoughtSteps` key inside a message's existing `metadataJson` blob
// (src/lib/server/db/schema.ts `messages.metadataJson`, a free-form JSON
// text column already) — no schema migration is needed, the same way
// `depthMetadata` / `webCitationAudit` / etc. already ride that column
// (see `PersistedMessageMetadata` in
// src/lib/server/services/messages.ts). The read model that parses this
// shape back out lives in
// src/lib/server/services/chat-turn/thought-steps.ts.
export type ThoughtStepSource = "deterministic" | "event" | "classified";

/**
 * The **Thought Step Anchor** (ADR-0056): a half-open `[start, end)`
 * character span into the SAME turn's persisted `messages.thinking` text.
 * `start`/`end` are plain string offsets (`thinking.slice(start, end)`),
 * never token or provider-specific byte offsets, so resolving an anchor
 * needs no provider-aware decoding. Per ADR-0056 ("What makes a step
 * true"): a step that cannot name a real anchor into the reasoning that
 * produced it must not be emitted.
 */
export interface ThoughtStepAnchor {
	start: number;
	end: number;
}

function isThoughtStepAnchor(value: unknown): value is ThoughtStepAnchor {
	return (
		!!value &&
		typeof value === "object" &&
		typeof (value as ThoughtStepAnchor).start === "number" &&
		typeof (value as ThoughtStepAnchor).end === "number"
	);
}

/**
 * A durable **Interim Thought Step** (ADR-0056; CONTEXT.md) — one entry in
 * the append-only step rail for a completed Normal Chat Turn.
 */
export interface InterimThoughtStep {
	id: string;
	source: ThoughtStepSource;
	// Free-form activity-class identifier (e.g. "reasoning_active",
	// "tool_call:research_web", "context_prepared"). Deliberately NOT a
	// fixed union here — P3b owns the closed enum; this contract only
	// fixes what a step + anchor must look like to be auditable.
	activityClass: string;
	// True when this step's class asserts something happened outside the
	// model (searching the web, fetching a page, reading a connected
	// account). Per ADR-0056, such a step may originate ONLY from
	// `source: "event"` — the P3a honesty harness's fabricated-action-claim
	// check reads this flag together with `source` and `toolCallId`.
	impliesExternalAction: boolean;
	anchor: ThoughtStepAnchor | null;
	// Optional entity string. Per ADR-0056 ("An optional entity string is
	// dropped unless it appears verbatim in the anchored span"), it is only
	// ever trustworthy when it is a substring of the anchor's resolved
	// text — the harness checks exactly that.
	entity?: string;
	// Present when `source === "event"`: the real tool call this step
	// reports on. The harness cross-checks it against the turn's actually
	// persisted tool call ids (the existing `messages.toolCalls` column).
	toolCallId?: string;
	label?: string;
	createdAt?: number;
}

function isInterimThoughtStep(value: unknown): value is InterimThoughtStep {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<InterimThoughtStep>;
	return (
		typeof candidate.id === "string" &&
		(candidate.source === "deterministic" ||
			candidate.source === "event" ||
			candidate.source === "classified") &&
		typeof candidate.activityClass === "string" &&
		typeof candidate.impliesExternalAction === "boolean" &&
		(candidate.anchor === null ||
			candidate.anchor === undefined ||
			isThoughtStepAnchor(candidate.anchor))
	);
}

export function isInterimThoughtStepArray(
	value: unknown,
): value is InterimThoughtStep[] {
	return Array.isArray(value) && value.every(isInterimThoughtStep);
}
