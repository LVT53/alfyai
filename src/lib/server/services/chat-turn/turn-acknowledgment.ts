import { z } from "zod";
import {
	isTurnAcknowledgmentIntentClass,
	TURN_ACKNOWLEDGMENT_INTENT_CLASSES,
	type TurnAcknowledgmentIntentClass,
} from "$lib/response-activity-types";
import { recordControlModelUsage } from "../analytics";
import { parseJsonWithEnvelopeExtraction } from "../memory-judge/schema";
import type { JsonControlResponseSchema } from "../normal-chat-control-model";
import { createRequestAbortSignal } from "./shared-normal-chat-model-run-helpers";

/**
 * P2 (ADR-0056) — instant turn acknowledgment.
 *
 * One content-relevant line within ~1s of send, so an unexplained wait
 * becomes an explained one. This is pure enrichment on top of P1's
 * deterministic spine: it is fired in parallel with the turn (never
 * awaited on the critical path), bounded by a hard timeout, capped to a
 * small number of concurrent calls, and degrades silently to nothing on
 * any failure — the spine (context-preparing / drafting-answer) keeps
 * showing exactly as it does today.
 *
 * The control model CLASSIFIES; it never authors user-facing prose. It
 * returns a closed intent class plus, optionally, a short phrase copied
 * verbatim from the user's own message. The verbatim rule is enforced
 * here, server-side, by re-slicing the exact substring out of the
 * original message — never trusting the model's own copy of it — and the
 * class is validated against the same closed enum the client uses to pick
 * a localized template (src/lib/types.ts). The model never decides what
 * text the user sees, only which of six known classes applies and which
 * span of their own message names the subject.
 */

/** Hard timeout for the control call. Never on the critical path — the turn's
 * first token must never wait for this. */
export const TURN_ACKNOWLEDGMENT_TIMEOUT_MS = 800;

/** A tiny JSON payload ({"intentClass":"...","topic":"..."}); no reasoning
 * (thinkingMode "off"), so this is generous headroom, not a real budget. */
const TURN_ACKNOWLEDGMENT_MAX_TOKENS = 150;

// Verified on the box (architecture-deepening-slices.md §0): the control
// model shares a local vLLM at --max-num-seqs 4 with the memory judge,
// consolidation, and context summarizer, and is the chat model for one of
// six users. This call must be best-effort with a hard concurrency cap and
// must never queue behind a full instance — so a cap miss returns `null`
// immediately, with no network attempt at all, rather than waiting for a
// slot. Kept small (well under the instance's total capacity) so this
// enrichment can never itself become the contention it exists to avoid.
export const MAX_CONCURRENT_TURN_ACKNOWLEDGMENT_CALLS = 2;

let inFlightTurnAcknowledgmentCalls = 0;

const TURN_ACKNOWLEDGMENT_SYSTEM_PROMPT = `Classify the user's message and, if possible, extract its topic. Respond with strict JSON only, matching exactly: {"intentClass": one of "research" | "code" | "write" | "analyze" | "plan" | "chat", "topic": a short phrase, or omit the field}.

intentClass meanings:
- research: looking up facts, current information, prices, availability, or comparisons
- code: programming, debugging, or technical implementation
- write: drafting, composing, or creative writing
- analyze: reviewing, explaining, comparing, or reasoning about something
- plan: planning, organizing, or scheduling
- chat: greetings, small talk, or anything that does not clearly fit the above

topic rules (critical — this is checked mechanically, not just requested):
- Copy the topic phrase EXACTLY, character for character, from the user's message. Never translate, paraphrase, summarize, or invent it.
- Keep it short: 2-8 words naming the specific subject, not a full sentence.
- Omit the "topic" field entirely if no short exact phrase names a clear subject.
- Respond in this exact JSON shape no matter what language the user's message is written in.`;

const TURN_ACKNOWLEDGMENT_JSON_SCHEMA: JsonControlResponseSchema = {
	name: "turn_acknowledgment",
	strict: true,
	schema: {
		type: "object",
		additionalProperties: false,
		required: ["intentClass"],
		properties: {
			intentClass: {
				type: "string",
				enum: [...TURN_ACKNOWLEDGMENT_INTENT_CLASSES],
			},
			topic: { type: "string" },
		},
	},
};

const turnAcknowledgmentResponseSchema = z.object({
	intentClass: z.enum(TURN_ACKNOWLEDGMENT_INTENT_CLASSES),
	topic: z.string().optional(),
});

export type TurnAcknowledgment = {
	intentClass: TurnAcknowledgmentIntentClass;
	topic?: string;
};

export type ResolveTurnAcknowledgmentParams = {
	userId: string;
	conversationId: string;
	message: string;
	/** Ties the control call to the turn's lifetime (e.g. client disconnect); combined with the hard timeout above, not a substitute for it. */
	signal?: AbortSignal;
};

/**
 * The honesty rule: `candidate` survives only when it is a case-insensitive
 * verbatim substring of `message`. On a match, the substring is re-sliced
 * from the ORIGINAL message (not the model's own copy of it) so the result
 * is guaranteed byte-for-byte identical to what the user actually typed,
 * regardless of any casing/whitespace drift the model introduced.
 */
export function extractVerbatimTopic(
	candidate: string | undefined,
	message: string,
): string | undefined {
	const trimmed = candidate?.trim();
	if (!trimmed) return undefined;
	const index = message.toLowerCase().indexOf(trimmed.toLowerCase());
	if (index === -1) return undefined;
	return message.slice(index, index + trimmed.length);
}

function parseTurnAcknowledgmentResponse(
	rawText: string,
): { intentClass: TurnAcknowledgmentIntentClass; topic?: string } | null {
	const data = parseJsonWithEnvelopeExtraction(rawText, "intentClass");
	if (!data) return null;
	const result = turnAcknowledgmentResponseSchema.safeParse(data);
	if (!result.success) return null;
	// Belt-and-suspenders: the schema's z.enum already restricts this, but
	// route it through the same shared guard the client uses so there is
	// exactly one definition of "valid class" across server and client.
	if (!isTurnAcknowledgmentIntentClass(result.data.intentClass)) return null;
	return result.data;
}

/**
 * Resolve an instant acknowledgment for a turn's opening message. Best-effort
 * end to end: never throws, never queues behind a full control-model
 * instance, and returns `null` on cap miss, timeout, malformed output, an
 * invalid class, or any other failure — callers treat `null` exactly like
 * "no acknowledgment fired" and fall back to the existing spine in silence.
 */
export async function resolveTurnAcknowledgment(
	params: ResolveTurnAcknowledgmentParams,
): Promise<TurnAcknowledgment | null> {
	const message = params.message.trim();
	if (!message) return null;
	if (
		inFlightTurnAcknowledgmentCalls >= MAX_CONCURRENT_TURN_ACKNOWLEDGMENT_CALLS
	) {
		return null;
	}

	inFlightTurnAcknowledgmentCalls += 1;
	try {
		const { sendJsonControlMessage } = await import(
			"../normal-chat-control-model"
		);
		const signal = createRequestAbortSignal(
			TURN_ACKNOWLEDGMENT_TIMEOUT_MS,
			params.signal,
		);
		const result = await sendJsonControlMessage(message, "model2", {
			systemPrompt: TURN_ACKNOWLEDGMENT_SYSTEM_PROMPT,
			thinkingMode: "off",
			temperature: 0,
			maxTokens: TURN_ACKNOWLEDGMENT_MAX_TOKENS,
			jsonSchema: TURN_ACKNOWLEDGMENT_JSON_SCHEMA,
			signal,
		});

		// ADR-0047 — track this control call's spend like every other model
		// call. Best-effort inside recordControlModelUsage itself; awaited here
		// only so tests can assert on it deterministically, never so a slow
		// cost write could delay anything downstream (the acknowledgment has
		// already been computed by this point).
		await recordControlModelUsage({
			userId: params.userId,
			conversationId: params.conversationId,
			feature: "turn_acknowledgment",
			modelId: result.modelId,
			modelDisplayName: result.modelDisplayName,
			promptTokens: result.usage?.promptTokens,
			completionTokens: result.usage?.completionTokens,
			totalTokens: result.usage?.totalTokens,
			cachedInputTokens: result.usage?.cachedInputTokens,
			cacheHitTokens: result.usage?.cacheHitTokens,
			cacheMissTokens: result.usage?.cacheMissTokens,
		});

		const parsed = parseTurnAcknowledgmentResponse(result.text);
		if (!parsed) return null;

		const topic = extractVerbatimTopic(parsed.topic, message);
		return topic
			? { intentClass: parsed.intentClass, topic }
			: { intentClass: parsed.intentClass };
	} catch {
		return null;
	} finally {
		inFlightTurnAcknowledgmentCalls -= 1;
	}
}
