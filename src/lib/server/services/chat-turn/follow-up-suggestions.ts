import { z } from "zod";
import { parseJsonWithEnvelopeExtraction } from "../memory-judge/schema";
import type { JsonControlResponseSchema } from "../normal-chat-control-model";
import {
	callShortLocalControlModel,
	resolveShortTextLanguage,
} from "./short-local-text";

/**
 * Follow-up suggestions (owner idea, variant A) — after an assistant turn
 * finishes, ask the shared local control model ("model2") for two short
 * follow-up questions the user might want to ask next, based on their
 * message and the start of the assistant's reply.
 *
 * Same discipline as the rail-summary / thought-step-classifier control
 * calls this module sits beside: fire only from the stream's synchronous
 * completion path (never a background tail — the suggestions ride the
 * terminal `data-stream-metadata` frame live, so they must be known before
 * that frame is sent), capped + timed via `callShortLocalControlModel`, and
 * best-effort end to end — any failure, timeout, or implausible output
 * degrades to `null` and the turn finishes exactly as it would without this
 * feature. Never throws, never blocks longer than the timeout.
 *
 * Atlas mode needs no explicit check here: Atlas turns never reach the
 * normal chat stream-completion path this module is called from (see
 * `/api/chat/stream`, which rejects `atlasMode` requests outright) — the
 * exclusion is structural, not a runtime flag.
 */

export const FOLLOW_UP_SUGGESTIONS_FEATURE = "follow_up_suggestions";

// Same budget class as the thought-step classifier / rail summary (6s):
// real headroom under a busy self-hosted endpoint, while staying bounded —
// this call sits on the turn's own terminal frame, so it must not hang.
export const FOLLOW_UP_SUGGESTIONS_TIMEOUT_MS = 6000;

// Kept small, mirroring the rail summary's budget — this fires once per
// completed turn, well after generation, not repeatedly during it.
export const FOLLOW_UP_SUGGESTIONS_MAX_CONCURRENT = 2;

export const FOLLOW_UP_SUGGESTIONS_COUNT = 2;
export const FOLLOW_UP_SUGGESTIONS_MAX_WORDS = 6;

// Only the opening of the reply matters for suggesting what to ask next.
const FOLLOW_UP_SUGGESTIONS_SOURCE_CHAR_BUDGET = 1500;
const FOLLOW_UP_SUGGESTIONS_USER_MESSAGE_CHAR_BUDGET = 500;
const FOLLOW_UP_SUGGESTIONS_MAX_TOKENS = 80;

// A reply this short (a one-liner, an acknowledgment) rarely has an obvious
// follow-up worth surfacing — skip the control-model call entirely.
export const FOLLOW_UP_SUGGESTIONS_MIN_CONTENT_LENGTH = 20;

// A short reply that is itself a question reads as the assistant asking the
// USER something (a clarification), not an answer to build follow-ups on.
const CLARIFICATION_MAX_LENGTH = 300;

/**
 * Heuristic, deterministic gate for "the assistant's reply is itself a
 * clarification question" — no control-model call, no persisted flag to
 * read; just the reply's own shape. A short reply ending in "?" reads as the
 * assistant asking the user something rather than answering, so it has no
 * obvious "what to ask next" — suggesting follow-ups on it would be noise.
 */
export function looksLikeClarificationQuestion(response: string): boolean {
	const trimmed = response.trim();
	if (!trimmed) return false;
	return trimmed.length <= CLARIFICATION_MAX_LENGTH && trimmed.endsWith("?");
}

function buildFollowUpSuggestionsSystemPrompt(language: "en" | "hu"): string {
	const languageLabel = language === "hu" ? "Hungarian" : "English";
	return `You suggest short follow-up questions a user might want to ask next, given their message and an assistant's reply to it. Respond with strict JSON only, matching exactly: {"followUps": [string, string]} — no preamble, no explanation, no markdown.

Rules:
- Write exactly ${FOLLOW_UP_SUGGESTIONS_COUNT} follow-up questions, in ${languageLabel}.
- Each must be at most ${FOLLOW_UP_SUGGESTIONS_MAX_WORDS} words.
- Each must end with a question mark and contain no other punctuation.
- Each must be a genuinely different, natural next question the user might ask, grounded in the assistant's reply below — never a repeat or rephrasing of the user's original message.
- Never invent a fact or claim that is not supported by the reply.
- Output the JSON object only.`;
}

const FOLLOW_UP_SUGGESTIONS_JSON_SCHEMA: JsonControlResponseSchema = {
	name: "follow_up_suggestions",
	strict: true,
	schema: {
		type: "object",
		additionalProperties: false,
		required: ["followUps"],
		properties: {
			followUps: {
				type: "array",
				items: { type: "string" },
			},
		},
	},
};

const followUpSuggestionsResponseSchema = z.object({
	followUps: z.array(z.string()).optional(),
});

/**
 * A candidate follow-up survives only when it is a short, single-question
 * line: non-empty, at most `FOLLOW_UP_SUGGESTIONS_MAX_WORDS` words, ending in
 * "?" with no other punctuation. Exported for direct unit testing of the
 * plausibility boundary, mirroring `isPlausibleShortText`'s precedent.
 */
export function isPlausibleFollowUpSuggestion(text: string): boolean {
	const trimmed = text.replace(/\s+/g, " ").trim();
	if (!trimmed) return false;
	if (!trimmed.endsWith("?")) return false;
	const withoutQuestionMark = trimmed.slice(0, -1);
	if (!withoutQuestionMark.trim()) return false;
	// No punctuation beyond the single trailing "?".
	if (/[.!,:;?]/.test(withoutQuestionMark)) return false;
	const wordCount = withoutQuestionMark.split(" ").filter(Boolean).length;
	return wordCount > 0 && wordCount <= FOLLOW_UP_SUGGESTIONS_MAX_WORDS;
}

function parseFollowUpSuggestions(rawText: string): string[] | null {
	const data = parseJsonWithEnvelopeExtraction(rawText, "followUps");
	if (!data) return null;
	const result = followUpSuggestionsResponseSchema.safeParse(data);
	if (!result.success || !result.data.followUps) return null;

	const seen = new Set<string>();
	const cleaned = result.data.followUps
		.map((question) => question.replace(/\s+/g, " ").trim())
		.filter(isPlausibleFollowUpSuggestion)
		.filter((question) => {
			// The client keys chips by text; a repeated suggestion must never
			// reach the persisted array.
			const key = question.toLowerCase();
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.slice(0, FOLLOW_UP_SUGGESTIONS_COUNT);

	return cleaned.length > 0 ? cleaned : null;
}

/**
 * Best-effort: ask the control model for follow-up suggestions for one
 * completed turn. Returns `null` (never throws) when the reply is too short
 * to bother with, looks like a clarification question, or the control-model
 * call fails/times out/returns implausible output — the caller's own gate
 * (tools still running, the turn was stopped) lives at the call site in
 * `stream-completion.ts`, alongside the other terminal-frame decisions.
 */
export async function generateFollowUpSuggestions(params: {
	userId: string;
	conversationId: string;
	userMessage: string;
	assistantResponse: string;
	signal?: AbortSignal;
}): Promise<string[] | null> {
	const response = params.assistantResponse.trim();
	if (response.length < FOLLOW_UP_SUGGESTIONS_MIN_CONTENT_LENGTH) return null;
	if (looksLikeClarificationQuestion(response)) return null;

	const language = resolveShortTextLanguage(params.userMessage);
	const prompt = `User message:\n${params.userMessage
		.trim()
		.slice(
			0,
			FOLLOW_UP_SUGGESTIONS_USER_MESSAGE_CHAR_BUDGET,
		)}\n\nAssistant reply:\n${response.slice(
		0,
		FOLLOW_UP_SUGGESTIONS_SOURCE_CHAR_BUDGET,
	)}`;

	const result = await callShortLocalControlModel({
		message: prompt,
		modelId: "model2",
		feature: FOLLOW_UP_SUGGESTIONS_FEATURE,
		userId: params.userId,
		conversationId: params.conversationId,
		systemPrompt: buildFollowUpSuggestionsSystemPrompt(language),
		thinkingMode: "off",
		temperature: 0.4,
		maxTokens: FOLLOW_UP_SUGGESTIONS_MAX_TOKENS,
		jsonSchema: FOLLOW_UP_SUGGESTIONS_JSON_SCHEMA,
		timeoutMs: FOLLOW_UP_SUGGESTIONS_TIMEOUT_MS,
		maxConcurrent: FOLLOW_UP_SUGGESTIONS_MAX_CONCURRENT,
		signal: params.signal,
	});
	if (!result) return null;

	try {
		return parseFollowUpSuggestions(result.text);
	} catch (error) {
		console.error("[FOLLOW_UP_SUGGESTIONS] Failed to parse response", error);
		return null;
	}
}
