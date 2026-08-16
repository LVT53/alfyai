import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { InterimThoughtStep, ThoughtStepAnchor } from "$lib/types";
import {
	isThoughtStepClassifierActivityClass,
	THOUGHT_STEP_CLASSIFIER_ACTIVITY_CLASSES,
	THOUGHT_STEP_CLASSIFIER_VERDICTS,
	type ThoughtStepClassifierActivityClass,
	type ThoughtStepClassifierVerdict,
} from "$lib/types";
import { recordControlModelUsage } from "../analytics";
import { parseJsonWithEnvelopeExtraction } from "../memory-judge/schema";
import type { JsonControlResponseSchema } from "../normal-chat-control-model";
import { createRequestAbortSignal } from "./shared-normal-chat-model-run-helpers";
import { resolveThoughtStepAnchorSpan } from "./thought-steps";
import { extractVerbatimTopic } from "./turn-acknowledgment";

/**
 * P3b (ADR-0056) — the reasoning-phase classifier + step rail.
 *
 * This is enrichment on P1's deterministic spine, never a separate mode: a
 * slow, rejected, or unavailable control model simply means `getSteps()`
 * returns fewer (or zero) `InterimThoughtStep`s, and the caller's normal
 * spine (context-preparing / reasoning-active / drafting-answer, all
 * model-free) is completely unaffected — this module has no dependency on,
 * and is never imported by, `$lib/utils/reasoning-spine.ts` or
 * `ThinkingBlock.svelte`.
 *
 * The control model CLASSIFIES a fragment of the reasoning trace; it never
 * summarizes and never authors user-facing prose. Every call returns strict
 * JSON via `sendJsonControlMessage`: a closed activity-class enum
 * (THOUGHT_STEP_CLASSIFIER_ACTIVITY_CLASSES, src/lib/types.ts — deliberately
 * containing zero action-implying classes, so "action classes only from
 * events" is structural, not a runtime check that could be bypassed), an
 * optional entity slot (kept only when it is a verbatim substring of the
 * reasoning chunk that produced it — the same discipline
 * turn-acknowledgment.ts's `extractVerbatimTopic` already established for
 * P2, reused verbatim here), and a new-step/continuation verdict.
 *
 * Every emitted step's anchor is validated against the session's own running
 * reasoning-text buffer via `resolveThoughtStepAnchorSpan` — the exact same
 * function P3a's read model and honesty-audit harness use — BEFORE the step
 * is ever added to `getSteps()`'s result. A step whose anchor does not
 * resolve is silently dropped, never emitted; there is no code path that
 * pushes an unanchored step.
 */

// ── Sampling: discourse-marker regex as a TRIGGER ONLY ─────────────────────
//
// This regex decides WHEN to fire a classify call. It must NEVER be used to
// construct, select, or otherwise influence any user-facing text — that is
// exactly the failure mode G1 (docs/adr/0055) removed from this codebase.
// DeepSeek (the default remote chat model) reasons in English regardless of
// the conversation's UI language, so matching English words here is safe
// as a private, server-only sampling heuristic; the only things that ever
// cross the wire are the closed `activityClass` id (resolved to localized
// copy on the client from src/lib/i18n/chat.ts) and a verbatim-substring
// entity. Neither is derived from this regex.
const THOUGHT_STEP_SAMPLING_TRIGGER_REGEX =
	/\b(first|next|now|then|so|therefore|however|let'?s|let me|i need to|i should|i'll|wait|actually|alternatively|to summarize|in summary|in conclusion|finally|on the other hand|looking at|considering|given that)\b/i;

// Fallback trigger for reasoning that never happens to use one of the
// markers above: once enough text has piled up since the last sample, fire
// anyway rather than staying silent for the rest of the turn. This is still
// a SAMPLING decision (when to call the model), not a text source.
const THOUGHT_STEP_SAMPLING_FALLBACK_CHAR_CAP = 1200;

// "Rate-limited to roughly one new step per 5-7s" (architecture-deepening-
// slices.md § P3b): a hard floor on how often a classify call can fire per
// turn. Combined with the marker trigger above, natural reasoning produces a
// real step cadence in roughly this range; the floor alone prevents bursts
// when markers are dense.
export const THOUGHT_STEP_MIN_SAMPLE_INTERVAL_MS = 5000;

// ── Concurrency ceiling (verified on the box, architecture-deepening-
// slices.md §0) ─────────────────────────────────────────────────────────
//
// The control model shares a local vLLM at --max-num-seqs 4 with the memory
// judge, consolidation, the context summarizer, P2's own instant
// acknowledgment (capped at 2), and the chat model for one of six users.
// Unlike P2 — which fires once, near the very start of a turn, when an
// instant response matters most — this classifier samples repeatedly across
// a turn's ENTIRE reasoning phase, so its aggregate call volume is much
// higher. Kept to exactly 1 concurrent call, system-wide, deliberately more
// conservative than P2's 2: a cap miss returns `null` immediately (no
// network attempt at all, never queues), degrading this turn's rail to
// whatever was already sampled — never delaying or failing the turn.
export const MAX_CONCURRENT_THOUGHT_STEP_CLASSIFIER_CALLS = 1;

let inFlightThoughtStepClassifierCalls = 0;

/** Never on any critical path (this call is always fire-and-forget), but
 * still bounded so a slow/hung control model can't accumulate in-flight
 * calls against the concurrency cap above. */
export const THOUGHT_STEP_CLASSIFIER_TIMEOUT_MS = 2500;

const THOUGHT_STEP_CLASSIFIER_MAX_TOKENS = 150;

function buildThoughtStepClassifierSystemPrompt(
	currentActivityClass: ThoughtStepClassifierActivityClass | null,
): string {
	const currentDescription = currentActivityClass
		? `The step currently in progress is classified as "${currentActivityClass}".`
		: "No step has been classified yet for this turn — this is the first fragment.";
	return `You are classifying a short fragment of an AI assistant's PRIVATE internal reasoning trace (never the final answer shown to a user) into one of a small set of activity categories. Respond with strict JSON only, matching exactly: {"verdict": "new_step" | "continuation", "activityClass": one of "understanding-request" | "recalling-context" | "weighing-options" | "working-through-logic" | "checking-details" | "drafting-approach" (REQUIRED when verdict is "new_step"; omit when verdict is "continuation"), "entity": a short phrase copied verbatim from the fragment, or omit the field}.

${currentDescription}

verdict meanings:
- "continuation": the fragment is still doing the SAME kind of work as the step in progress.
- "new_step": the fragment has moved on to a genuinely different kind of work.

activityClass meanings (only used when verdict is "new_step"):
- understanding-request: parsing or restating what is being asked
- recalling-context: connecting to earlier conversation, memory, or background facts
- weighing-options: comparing alternatives or trade-offs
- working-through-logic: step-by-step reasoning, calculation, or working out a mechanism
- checking-details: verifying, double-checking, or catching a mistake
- drafting-approach: planning how to structure or phrase the eventual answer

entity rules (critical — this is checked mechanically, not just requested):
- Copy it EXACTLY, character for character, from the fragment below. Never translate, paraphrase, summarize, or invent it.
- Keep it short: 2-8 words naming a specific subject the fragment is about.
- Omit the "entity" field entirely if no short exact phrase names a clear subject.
- This is the assistant's own private reasoning, not an event log. Never describe an external action (searching, fetching, reading a connected account) as something that happened — you are naming a category of internal thought only, never an action.
- Respond in this exact JSON shape no matter what language the fragment is written in.`;
}

const THOUGHT_STEP_CLASSIFIER_JSON_SCHEMA: JsonControlResponseSchema = {
	name: "thought_step_classification",
	strict: true,
	schema: {
		type: "object",
		additionalProperties: false,
		required: ["verdict"],
		properties: {
			verdict: {
				type: "string",
				enum: [...THOUGHT_STEP_CLASSIFIER_VERDICTS],
			},
			activityClass: {
				type: "string",
				enum: [...THOUGHT_STEP_CLASSIFIER_ACTIVITY_CLASSES],
			},
			entity: { type: "string" },
		},
	},
};

const thoughtStepClassifierResponseSchema = z.object({
	verdict: z.enum(THOUGHT_STEP_CLASSIFIER_VERDICTS),
	activityClass: z.enum(THOUGHT_STEP_CLASSIFIER_ACTIVITY_CLASSES).optional(),
	entity: z.string().optional(),
});

function parseThoughtStepClassifierResponse(rawText: string): {
	verdict: ThoughtStepClassifierVerdict;
	activityClass?: ThoughtStepClassifierActivityClass;
	entity?: string;
} | null {
	const data = parseJsonWithEnvelopeExtraction(rawText, "verdict");
	if (!data) return null;
	const result = thoughtStepClassifierResponseSchema.safeParse(data);
	if (!result.success) return null;
	// Belt-and-suspenders, mirroring turn-acknowledgment.ts: the schema's
	// z.enum already restricts these, but route them through the same shared
	// guards the rest of the app uses so there is exactly one definition of
	// "valid class"/"valid verdict".
	if (
		result.data.activityClass !== undefined &&
		!isThoughtStepClassifierActivityClass(result.data.activityClass)
	) {
		return null;
	}
	return result.data;
}

export type ThoughtStepClassifierResult =
	| { verdict: "continuation" }
	| {
			verdict: "new_step";
			activityClass: ThoughtStepClassifierActivityClass;
			entity?: string;
	  };

export type ThoughtStepClassifyFn = (params: {
	chunkText: string;
	currentActivityClass: ThoughtStepClassifierActivityClass | null;
}) => Promise<ThoughtStepClassifierResult | null>;

/**
 * The real control-model call. Best-effort end to end, exactly like
 * `resolveTurnAcknowledgment`: never throws, never queues behind a full
 * control-model instance, returns `null` on cap miss, timeout, malformed
 * output, an invalid verdict/class, or any other failure. Callers treat
 * `null` exactly like "nothing classified this fragment" and keep sampling
 * on the next eligible delta.
 */
export async function classifyThoughtStepChunk(params: {
	userId: string;
	conversationId: string;
	chunkText: string;
	currentActivityClass: ThoughtStepClassifierActivityClass | null;
	signal?: AbortSignal;
}): Promise<ThoughtStepClassifierResult | null> {
	if (
		inFlightThoughtStepClassifierCalls >=
		MAX_CONCURRENT_THOUGHT_STEP_CLASSIFIER_CALLS
	) {
		return null;
	}

	inFlightThoughtStepClassifierCalls += 1;
	try {
		const { sendJsonControlMessage } = await import(
			"../normal-chat-control-model"
		);
		const signal = createRequestAbortSignal(
			THOUGHT_STEP_CLASSIFIER_TIMEOUT_MS,
			params.signal,
		);
		const result = await sendJsonControlMessage(params.chunkText, "model2", {
			systemPrompt: buildThoughtStepClassifierSystemPrompt(
				params.currentActivityClass,
			),
			thinkingMode: "off",
			temperature: 0,
			maxTokens: THOUGHT_STEP_CLASSIFIER_MAX_TOKENS,
			jsonSchema: THOUGHT_STEP_CLASSIFIER_JSON_SCHEMA,
			signal,
		});

		// ADR-0047 — classifier spend tracked through the same generic path
		// P2's acknowledgment uses. Best-effort inside recordControlModelUsage
		// itself; awaited here only so tests can assert on it deterministically.
		await recordControlModelUsage({
			userId: params.userId,
			conversationId: params.conversationId,
			feature: "thought_step_classifier",
			modelId: result.modelId,
			modelDisplayName: result.modelDisplayName,
			promptTokens: result.usage?.promptTokens,
			completionTokens: result.usage?.completionTokens,
			totalTokens: result.usage?.totalTokens,
			cachedInputTokens: result.usage?.cachedInputTokens,
			cacheHitTokens: result.usage?.cacheHitTokens,
			cacheMissTokens: result.usage?.cacheMissTokens,
		});

		const parsed = parseThoughtStepClassifierResponse(result.text);
		if (!parsed) return null;
		if (parsed.verdict === "continuation") {
			return { verdict: "continuation" };
		}
		if (!parsed.activityClass) return null;
		// The verbatim-substring rule, applied to the REASONING CHUNK (never
		// the model's own copy of it) — the exact same function and discipline
		// P2 uses against the user's message.
		const entity = extractVerbatimTopic(parsed.entity, params.chunkText);
		return entity
			? { verdict: "new_step", activityClass: parsed.activityClass, entity }
			: { verdict: "new_step", activityClass: parsed.activityClass };
	} catch {
		return null;
	} finally {
		inFlightThoughtStepClassifierCalls -= 1;
	}
}

export type ThoughtStepClassifierSession = {
	/** Call for every reasoning-delta chunk, in arrival order, with exactly
	 * the text that will be appended to the turn's persisted `thinking`
	 * (i.e. from the same `onThinking` callback `createServerChunkRuntime`
	 * already invokes). Never blocks; any classify call it triggers is fired
	 * and forgotten. */
	onReasoningDelta(text: string): void;
	/** Hard stop: call on the first answer `text-delta`. After this, no new
	 * classify call is ever fired, and any call already in flight has its
	 * result discarded when it resolves — classification never touches the
	 * step rail once the visible answer has begun. */
	stop(): void;
	/** The append-only, anchored, honesty-checked step rail accumulated so
	 * far this turn. Safe to call at any time, including before `stop()`. */
	getSteps(): InterimThoughtStep[];
};

/**
 * Creates a fresh per-turn classifier session. `classify` defaults to the
 * real control-model call above; tests inject a fake to exercise the
 * session's sampling/rate-limiting/anchoring/append-only logic without any
 * network or model dependency.
 */
export function createThoughtStepClassifierSession(params: {
	userId: string;
	conversationId: string;
	signal?: AbortSignal;
	/** Master off-switch — e.g. when the control model is known to be
	 * unconfigured. Defaults to enabled; even when enabled, every individual
	 * sample degrades silently on its own via `classify` returning `null`. */
	enabled?: boolean;
	classify?: ThoughtStepClassifyFn;
	/** Fired once per NEW step (never for a continuation, which extends the
	 * existing step in place instead). */
	onStep?: (step: InterimThoughtStep) => void;
	now?: () => number;
}): ThoughtStepClassifierSession {
	const enabled = params.enabled ?? true;
	const nowFn = params.now ?? Date.now;
	const classifyFn: ThoughtStepClassifyFn =
		params.classify ??
		((args) =>
			classifyThoughtStepChunk({
				userId: params.userId,
				conversationId: params.conversationId,
				chunkText: args.chunkText,
				currentActivityClass: args.currentActivityClass,
				signal: params.signal,
			}));

	let thinkingSoFar = "";
	let pendingSinceLastSample = "";
	let lastSampleAt = Number.NEGATIVE_INFINITY;
	let sampleInFlight = false;
	let stopped = false;
	const steps: InterimThoughtStep[] = [];
	let currentStep: InterimThoughtStep | null = null;
	// Tracked separately from currentStep.activityClass: InterimThoughtStep's
	// field is deliberately the broad `string` (P3a's contract — the shape
	// must stay classifier-agnostic), so this keeps the closed-enum type
	// available for the next classify call without a cast.
	let currentActivityClass: ThoughtStepClassifierActivityClass | null = null;

	function applyResult(
		result: ThoughtStepClassifierResult,
		window: { sampleStart: number; sampleEnd: number },
	) {
		if (stopped) return;
		if (result.verdict === "continuation") {
			// Can't extend a step that doesn't exist yet — drop defensively
			// rather than fabricate one with no class.
			if (!currentStep?.anchor) return;
			currentStep.anchor = {
				start: currentStep.anchor.start,
				end: Math.max(currentStep.anchor.end, window.sampleEnd),
			};
			return;
		}

		const anchor: ThoughtStepAnchor = {
			start: window.sampleStart,
			end: window.sampleEnd,
		};
		// Structural honesty gate (ADR-0056 "What makes a step true"): a step
		// that cannot name a real anchor into the reasoning that produced it
		// is not emitted. Validated with the SAME function P3a's read model
		// and honesty-audit harness use, against this session's own running
		// text — never a step pushed first and checked later.
		if (resolveThoughtStepAnchorSpan(anchor, thinkingSoFar) === null) return;

		const step: InterimThoughtStep = {
			id: randomUUID(),
			source: "classified",
			activityClass: result.activityClass,
			// Structural, not a runtime check: THOUGHT_STEP_CLASSIFIER_ACTIVITY_CLASSES
			// contains zero action-implying classes, so a classified step can
			// never legitimately claim one. Always false here by construction.
			impliesExternalAction: false,
			anchor,
			entity: result.entity,
			createdAt: nowFn(),
		};
		steps.push(step);
		currentStep = step;
		currentActivityClass = result.activityClass;
		params.onStep?.(step);
	}

	return {
		onReasoningDelta(text: string) {
			if (!text) return;
			thinkingSoFar += text;
			if (stopped || !enabled) return;
			pendingSinceLastSample += text;
			if (sampleInFlight) return;
			if (nowFn() - lastSampleAt < THOUGHT_STEP_MIN_SAMPLE_INTERVAL_MS) return;
			const buffered = pendingSinceLastSample;
			if (!buffered.trim()) return;
			const triggered =
				THOUGHT_STEP_SAMPLING_TRIGGER_REGEX.test(buffered) ||
				buffered.length >= THOUGHT_STEP_SAMPLING_FALLBACK_CHAR_CAP;
			if (!triggered) return;

			// Snapshot the sample window and reset the pending buffer BEFORE
			// the async call resolves, so reasoning that arrives while this
			// call is in flight starts a fresh window instead of being lost
			// or double-counted.
			const sampleText = buffered;
			const sampleEnd = thinkingSoFar.length;
			const sampleStart = sampleEnd - sampleText.length;
			pendingSinceLastSample = "";
			lastSampleAt = nowFn();
			sampleInFlight = true;

			void classifyFn({
				chunkText: sampleText,
				currentActivityClass,
			})
				.catch((): ThoughtStepClassifierResult | null => null)
				.then((result) => {
					sampleInFlight = false;
					if (stopped || !result) return;
					applyResult(result, { sampleStart, sampleEnd });
				});
		},
		stop() {
			stopped = true;
		},
		getSteps() {
			return [...steps];
		},
	};
}
