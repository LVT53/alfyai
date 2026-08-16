import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
	InterimThoughtStep,
	ThoughtStepAnchor,
} from "$lib/response-activity-types";
import {
	isThoughtStepClassifierActivityClass,
	THOUGHT_STEP_CLASSIFIER_ACTIVITY_CLASSES,
	THOUGHT_STEP_CLASSIFIER_VERDICTS,
	type ThoughtStepClassifierActivityClass,
	type ThoughtStepClassifierVerdict,
} from "$lib/response-activity-types";
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
 * Amendment (2026-08-16) to ADR-0056 — "constrained, entity-grounded
 * summarization supersedes class-only wording". The control model still
 * CLASSIFIES a fragment of the reasoning trace into the closed activity-class
 * enum (now a SECONDARY signal — icon/tag/grouping), but on a `new_step`
 * verdict it ALSO composes a short, present-tense `summary` paraphrase of
 * that fragment — the step's new visible headline. Every call returns strict
 * JSON via `sendJsonControlMessage`: the closed activity-class enum
 * (THOUGHT_STEP_CLASSIFIER_ACTIVITY_CLASSES — deliberately containing zero
 * action-implying classes, so "action classes only from events" is
 * structural, not a runtime check that could be bypassed), an optional
 * entity slot (kept only when it is a verbatim substring of the reasoning
 * chunk that produced it — the same discipline turn-acknowledgment.ts's
 * `extractVerbatimTopic` already established for P2, reused verbatim here),
 * the new summary, and a new-step/continuation verdict.
 *
 * The summary is NOT trusted as-is. `hasVerbatimContentWordTether` (below)
 * is the runtime leash the ADR amendment chose: a summary survives only when
 * it contains at least one verbatim (case-insensitive), non-stop-word
 * content word copied from the reasoning chunk it describes. A summary that
 * fails this check is dropped (never persisted, never emitted) — the step
 * itself is still classified and emitted with its class + entity exactly as
 * before, so the floor never drops below the pre-amendment class-only
 * behavior. This mechanical tether is necessary, not sufficient: it cannot
 * prove the summary is faithful to the span, only that it is not wholly
 * unmoored from it. The full semantic faithfulness check is the next
 * slice's offline audit (ADR-0056 amendment, "The honesty contract becomes
 * semantic").
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
	return `You are classifying a short fragment of an AI assistant's PRIVATE internal reasoning trace (never the final answer shown to a user) into one of a small set of activity categories, and writing a short summary of it. Respond with strict JSON only, matching exactly: {"verdict": "new_step" | "continuation", "activityClass": one of "understanding-request" | "recalling-context" | "weighing-options" | "working-through-logic" | "checking-details" | "drafting-approach" (REQUIRED when verdict is "new_step"; omit when verdict is "continuation"), "summary": a short present-tense paraphrase of the fragment (REQUIRED when verdict is "new_step"; omit when verdict is "continuation"), "entity": a short phrase copied verbatim from the fragment, or omit the field}.

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

summary rules (only used when verdict is "new_step"; checked mechanically, not just requested):
- Write a short, present-tense paraphrase of what THIS fragment is doing — 10 words or fewer.
- It MUST include at least one word or short phrase copied VERBATIM (character-for-character) from the fragment below. You may paraphrase everything else, but the subject must stay traceable to the fragment's own words.
- Describe ONLY what the reasoning is doing with content that is actually present in the fragment. Never introduce an entity, fact, claim, or conclusion that is not in the fragment — no outside knowledge, no guessing ahead to the answer.
- Never state or imply that an external action happened (searching, fetching, browsing, reading a connected account, calling a tool) — this is private reasoning, not an event log; only describe internal thought.
- Write it in the same language as the fragment.

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
			summary: { type: "string" },
			entity: { type: "string" },
		},
	},
};

const thoughtStepClassifierResponseSchema = z.object({
	verdict: z.enum(THOUGHT_STEP_CLASSIFIER_VERDICTS),
	activityClass: z.enum(THOUGHT_STEP_CLASSIFIER_ACTIVITY_CLASSES).optional(),
	summary: z.string().optional(),
	entity: z.string().optional(),
});

function parseThoughtStepClassifierResponse(rawText: string): {
	verdict: ThoughtStepClassifierVerdict;
	activityClass?: ThoughtStepClassifierActivityClass;
	summary?: string;
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

// ── Runtime entity-grounding guard (amendment 2026-08-16 to ADR-0056) ──────
//
// The leash the owner chose in place of a per-step faithfulness judge on the
// reasoning path: a mechanical, cheap, runtime-checkable substitute that
// catches a summary with NO grounding at all in the text it claims to
// describe, without the latency/cost of a real judge call. It is necessary,
// not sufficient — it cannot catch a summary that reuses a real word but
// still asserts something false; that is the next slice's offline
// faithfulness audit's job.
//
// Small, deliberately conservative English function-word list. The reasoning
// stream is English regardless of UI language (see the sampling-trigger
// regex comment above), so this needs no localization. A word must be BOTH
// absent from this list AND at least 3 characters to count as a "content
// word" — short words ("a", "is", "to") and pure function words are never
// treated as a tether on their own, per the ADR amendment's explicit
// "the/is/a do not count" example.
const THOUGHT_STEP_SUMMARY_STOP_WORDS = new Set([
	"a",
	"an",
	"the",
	"and",
	"or",
	"but",
	"if",
	"then",
	"so",
	"because",
	"as",
	"of",
	"in",
	"on",
	"at",
	"for",
	"with",
	"by",
	"to",
	"from",
	"into",
	"onto",
	"over",
	"under",
	"about",
	"above",
	"below",
	"between",
	"through",
	"during",
	"before",
	"after",
	"again",
	"further",
	"once",
	"here",
	"there",
	"when",
	"where",
	"why",
	"how",
	"all",
	"any",
	"both",
	"each",
	"few",
	"more",
	"most",
	"other",
	"some",
	"such",
	"no",
	"nor",
	"not",
	"only",
	"own",
	"same",
	"than",
	"too",
	"very",
	"can",
	"will",
	"just",
	"should",
	"now",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"have",
	"has",
	"had",
	"having",
	"do",
	"does",
	"did",
	"doing",
	"this",
	"that",
	"these",
	"those",
	"and",
	"but",
	"you",
	"your",
	"yours",
	"i",
	"me",
	"my",
	"mine",
	"he",
	"she",
	"it",
	"we",
	"they",
	"him",
	"her",
	"us",
	"them",
	"his",
	"its",
	"our",
	"their",
	"what",
	"which",
	"who",
	"whom",
	"am",
	"also",
	"still",
	"already",
	"currently",
	"let",
	"lets",
	"let's",
	"against",
	"up",
	"down",
	"off",
	"out",
	"near",
	"toward",
	"towards",
	"upon",
	"within",
	"without",
	"per",
	"via",
	"amid",
	"among",
	"across",
	"around",
	"along",
]);

/** Tokenizes into word-ish substrings (Unicode letters/digits, plus internal
 * apostrophes/hyphens), lowercased content-word filtering only —
 * punctuation and whitespace are never tokens.
 *
 * FIX 4 (hardening pass, post-amendment) — Unicode-aware (`\p{L}`/`\p{N}`
 * with the `u` flag), not `[A-Za-z0-9]`. The ASCII-only class split an
 * accented word at the accent boundary (e.g. Hungarian "irány" ->
 * "ir" + "ny"), and both fragments then fell under the 3-character floor
 * and were silently dropped — a truthful, correctly-tethered Hungarian
 * summary would lose its only shared content word and be wrongly rejected,
 * downgraded all the way to the plain class label. `\p{L}`/`\p{N}` cover
 * accented Latin letters (and any other script) as ordinary word
 * characters, so this tokenizer no longer shreds non-ASCII words. */
function extractContentWords(text: string): string[] {
	const tokens = text.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];
	return tokens.filter((token) => {
		const lower = token.toLowerCase();
		return lower.length >= 3 && !THOUGHT_STEP_SUMMARY_STOP_WORDS.has(lower);
	});
}

/**
 * The mechanical check itself: does `summary` contain at least one
 * substantive (non-stop-word, 3+ character) token that also appears,
 * case-insensitively, as a WHOLE WORD in `anchoredText` (the same reasoning
 * chunk the summary is supposed to describe)? Exported for direct unit
 * testing of the stop-word/content-word boundary.
 *
 * FIX 1 (hardening pass, post-amendment) — this used to check
 * `anchoredText.toLowerCase().includes(word)`, a raw SUBSTRING check against
 * the anchored text's own characters rather than its tokenized words. Short
 * content-words are dense substrings of longer, wholly unrelated words
 * ("cat" nests inside "location", "art" nests inside "start"), so a
 * fabricated summary word that merely happens to nest inside a real word
 * passed the tether — defeating the leash the ADR amendment relies on. The
 * fix tokenizes `anchoredText` with the SAME `extractContentWords`
 * tokenizer used on the summary, and requires an exact (case-insensitive)
 * TOKEN match — membership in the anchored span's own word set — never a
 * raw substring test.
 */
export function hasVerbatimContentWordTether(
	summary: string,
	anchoredText: string,
): boolean {
	const anchoredWords = new Set(
		extractContentWords(anchoredText).map((word) => word.toLowerCase()),
	);
	return extractContentWords(summary).some((word) =>
		anchoredWords.has(word.toLowerCase()),
	);
}

// ── Runtime external-action guard (FIX 3, hardening pass) ──────────────────
//
// Only the classifier PROMPT told the model "never imply an external
// action" — nothing enforced it. A summary like "Searching flight prices
// for Paris" can pass `hasVerbatimContentWordTether` cleanly (every word in
// it may be a genuine copy from the chunk: "flight", "prices", "Paris" all
// really appear there) while still ASSERTING that a real external action
// happened. `impliesExternalAction` stays hardcoded `false` for every
// classified step (see the closed activity-class enum's own guarantee
// below), so a summary like this would reach the user live as a
// grounded-looking headline that falsely implies a real search occurred —
// exactly the failure mode ADR-0056 ("Classes that imply an external
// action... may originate ONLY from event-derived steps") exists to
// prevent, just smuggled through the summary TEXT instead of the class.
//
// This is a cheap, mechanical, defense-in-depth RUNTIME LEASH — a denylist
// of external-action verb stems, in both EN and HU (the two languages this
// product's reasoning stream and UI can appear in) — not a substitute for
// the offline faithfulness judge, which is the semantic backstop
// (scripts/audit-thought-step-honesty.ts). It can only catch an EXPLICIT
// action-verb assertion; it cannot catch every way a summary could imply
// unstated real-world activity without naming a denylisted verb. Like the
// verbatim tether, failing this check drops only the SUMMARY, never the
// step: the step still emits with its class + entity, so the floor never
// drops below pre-summary behavior.
//
// EN stems use plain ASCII `\b` word boundaries (fine — no accented
// characters involved). "look up"/"looking up"/"looked up" is denylisted
// but bare "look(ing) at" is deliberately NOT — internal reasoning
// routinely says things like "looking at the tradeoffs", which names no
// external action at all.
const EXTERNAL_ACTION_DENYLIST_EN_REGEX =
	/\b(search(?:ing|es|ed)?|look(?:ing|ed)?\s+up|fetch(?:ing|es|ed)?|brows(?:e|es|ed|ing)|retriev(?:e|es|ed|ing)|quer(?:y|ies|ying|ied)|download(?:ing|s|ed)?|googl(?:e|es|ed|ing)|read(?:ing)?\s+the|check(?:ing)?\s+online)\b/i;

// HU stems: keres (search), megkeres (look up/contact), letölt (download),
// böngész (browse), lekér (query/fetch). Hungarian is agglutinative, so
// each stem is followed by an open-ended run of further letters to catch
// its common inflections (keresés, keresem, letölti, böngészve, lekérdez,
// ...) rather than hardcoding every inflected form. `keres` alone would
// also match inside the common, wholly unrelated word "keresztül"
// ("through") / "kereszt" ("cross") — both start with the literal letters
// k-e-r-e-s — so `keres` is guarded with `(?!zt)` to exclude exactly that
// collision without narrowing any genuine search-related inflection (none
// of which continue with "zt"). Boundaries use `\p{L}\p{N}` lookaround
// (not `\b`, which is ASCII-only and unreliable around accented letters)
// so a stem is only matched at a genuine word start.
const EXTERNAL_ACTION_DENYLIST_HU_REGEX =
	/(?<![\p{L}\p{N}])(megkeres|keres(?!zt)|letölt|böngész|lekér)[\p{L}]*/iu;

/**
 * Does `summary`'s TEXT assert or imply that an external action happened
 * (searching, fetching, browsing, downloading, querying, reading a
 * connected account, ...)? Exported for direct unit testing of the
 * denylist's EN/HU boundary behavior, independent of the classifier
 * plumbing.
 */
export function assertsExternalAction(summary: string): boolean {
	return (
		EXTERNAL_ACTION_DENYLIST_EN_REGEX.test(summary) ||
		EXTERNAL_ACTION_DENYLIST_HU_REGEX.test(summary)
	);
}

/**
 * Applies both runtime guards: `candidate` survives only when non-empty,
 * tethered to `anchoredText` per `hasVerbatimContentWordTether`, AND does
 * NOT assert an external action per `assertsExternalAction`. Otherwise
 * `undefined` — dropping the summary, never the step itself (the caller
 * still emits the step with its class + entity, exactly as it did before
 * this amendment).
 */
function extractGroundedSummary(
	candidate: string | undefined,
	anchoredText: string,
): string | undefined {
	const trimmed = candidate?.trim();
	if (!trimmed) return undefined;
	if (assertsExternalAction(trimmed)) return undefined;
	return hasVerbatimContentWordTether(trimmed, anchoredText)
		? trimmed
		: undefined;
}

export type ThoughtStepClassifierResult =
	| { verdict: "continuation" }
	| {
			verdict: "new_step";
			activityClass: ThoughtStepClassifierActivityClass;
			entity?: string;
			summary?: string;
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
		// Amendment (2026-08-16) to ADR-0056 — the runtime entity-grounding
		// guard. A summary with no verbatim content-word tether to the chunk
		// it describes is dropped (undefined), NOT the step itself: the step
		// below is still returned with its class + entity regardless, so a
		// failed tether can only ever remove the headline, never the step.
		const summary = extractGroundedSummary(parsed.summary, params.chunkText);
		return {
			verdict: "new_step",
			activityClass: parsed.activityClass,
			...(entity ? { entity } : {}),
			...(summary ? { summary } : {}),
		};
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
			// Amendment (2026-08-16) to ADR-0056 — already tether-checked by
			// `classifyThoughtStepChunk` (or the injected `classify` in tests)
			// before it ever reaches here; the session trusts whatever
			// `ThoughtStepClassifierResult` it receives, exactly as it already
			// does for `entity` above.
			summary: result.summary,
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
