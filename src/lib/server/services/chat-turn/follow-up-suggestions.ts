import { z } from "zod";
import { parseJsonWithEnvelopeExtraction } from "../memory-judge/schema";
import type { JsonControlResponseSchema } from "../normal-chat-control-model";
import {
	callShortLocalControlModel,
	resolveShortTextLanguage,
} from "./short-local-text";

/**
 * Follow-up suggestions (owner idea, variant A) — after an assistant turn
 * finishes, ask the shared local control model ("model2") for the best
 * NEXT-STEP questions the user might want to ask: what the reply did not
 * cover, the decision it leaves open, the concrete action it sets up. The
 * model sees the last few turns of the conversation (so a suggestion cannot
 * simply restate what the user already asked), the current user message,
 * and the reply's head AND tail (so a long answer's conclusion — usually
 * where the next step lives — is never truncated away).
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

// How many suggestions reach the client (and the persisted metadata) — the
// chip row's own cap, unchanged.
export const FOLLOW_UP_SUGGESTIONS_COUNT = 2;
// How many candidates the control model is asked for. One spare costs a
// handful of tokens and lets the plausibility filter + dedupe drop a weak or
// malformed line without leaving the turn with a single chip; the first two
// survivors (the model is asked to order them best first) win.
export const FOLLOW_UP_SUGGESTIONS_REQUESTED_COUNT = 3;
export const FOLLOW_UP_SUGGESTIONS_MAX_WORDS = 8;

// The reply's opening carries the substance, but its END carries the
// conclusion, the caveat and the "want me to…" hook a good next step hangs
// off — so a long reply is sent head + tail rather than merely truncated.
const FOLLOW_UP_SUGGESTIONS_REPLY_HEAD_CHAR_BUDGET = 1200;
const FOLLOW_UP_SUGGESTIONS_REPLY_TAIL_CHAR_BUDGET = 600;
const FOLLOW_UP_SUGGESTIONS_USER_MESSAGE_CHAR_BUDGET = 500;
// Prior turns are here to say what the user ALREADY asked (so a suggestion
// can avoid restating it) — a short excerpt of each is enough.
const FOLLOW_UP_SUGGESTIONS_HISTORY_CHAR_BUDGET = 300;
// Up to three prior turns (user + assistant each). The caller reads exactly
// this many rows; this module trims whatever it is handed to the same bound.
export const FOLLOW_UP_SUGGESTIONS_HISTORY_MESSAGE_LIMIT = 6;
// Room for three 8-word questions inside the JSON envelope, with headroom
// for a model that pretty-prints it.
const FOLLOW_UP_SUGGESTIONS_MAX_TOKENS = 120;

// A reply this short (a one-liner, a bare number, an acknowledgment) rarely
// has a follow-up worth surfacing — on staging "17 × 23 = 391" produced
// "What is 17 multiplied by 24?" — so skip the control-model call entirely.
export const FOLLOW_UP_SUGGESTIONS_MIN_CONTENT_LENGTH = 160;

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

export type FollowUpHistoryMessage = {
	role: "user" | "assistant";
	content: string;
};

function buildFollowUpSuggestionsSystemPrompt(language: "en" | "hu"): string {
	const languageLabel = language === "hu" ? "Hungarian" : "English";
	// The example is written in the target language so the rule reads as an
	// instruction in the language the chips themselves must be written in.
	const actionExample =
		language === "hu" ? "Megírod az e-mailt?" : "Draft the email?";
	return `You suggest what a user might usefully ask NEXT, after reading an assistant's reply. Respond with strict JSON only, matching exactly: {"followUps": [string, string, string]} — no preamble, no explanation, no markdown.

Rules:
- Write exactly ${FOLLOW_UP_SUGGESTIONS_REQUESTED_COUNT} candidate questions, in ${languageLabel}.
- Each must be at most ${FOLLOW_UP_SUGGESTIONS_MAX_WORDS} words.
- Each must end with a question mark and contain no other punctuation.
- Each must move the conversation forward: something the reply did not cover, a decision the user now faces, or a concrete next action ("${actionExample}").
- Never ask something the reply already answers. No comprehension checks, no asking the assistant to repeat or summarise what it just said.
- Never restate or rephrase anything the user has already asked earlier in the conversation.
- Make the ${FOLLOW_UP_SUGGESTIONS_REQUESTED_COUNT} genuinely different from one another, and order them best first.
- Never invent a fact or claim that is not supported by the reply.
- Write each one the way the user would type it: natural, idiomatic ${languageLabel}, addressed to the assistant.
- Output the JSON object only.`;
}

function trimForPrompt(text: string, budget: number): string {
	return text.replace(/\s+/g, " ").trim().slice(0, budget);
}

/**
 * The prior turns, oldest → newest, capped at
 * `FOLLOW_UP_SUGGESTIONS_HISTORY_MESSAGE_LIMIT` messages and
 * `FOLLOW_UP_SUGGESTIONS_HISTORY_CHAR_BUDGET` characters each. Empty rows
 * drop out; an empty result renders no section at all rather than a bare
 * heading. Exported for direct unit testing of the prompt shape.
 */
export function renderFollowUpHistory(
	history: FollowUpHistoryMessage[],
): string {
	return history
		.slice(-FOLLOW_UP_SUGGESTIONS_HISTORY_MESSAGE_LIMIT)
		.map((message) => ({
			role: message.role,
			content: trimForPrompt(
				message.content ?? "",
				FOLLOW_UP_SUGGESTIONS_HISTORY_CHAR_BUDGET,
			),
		}))
		.filter((message) => message.content.length > 0)
		.map(
			(message) =>
				`${message.role === "user" ? "User" : "Assistant"}: ${message.content}`,
		)
		.join("\n");
}

/**
 * A reply that fits the combined budget is sent whole. A longer one is sent
 * as its opening AND its closing, separated by an explicit elision marker,
 * so the model never has to guess a next step from a cut-off middle.
 */
export function renderFollowUpReply(response: string): string {
	if (
		response.length <=
		FOLLOW_UP_SUGGESTIONS_REPLY_HEAD_CHAR_BUDGET +
			FOLLOW_UP_SUGGESTIONS_REPLY_TAIL_CHAR_BUDGET
	) {
		return response;
	}
	const head = response.slice(0, FOLLOW_UP_SUGGESTIONS_REPLY_HEAD_CHAR_BUDGET);
	const tail = response.slice(-FOLLOW_UP_SUGGESTIONS_REPLY_TAIL_CHAR_BUDGET);
	return `${head}\n[…]\n${tail}`;
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
 * `stream-completion.ts`, alongside the other terminal-frame decisions —
 * which is also where `recentHistory` (the turns already persisted before
 * this one) is read; passing it is optional and a missing/empty history just
 * drops that section from the prompt.
 */
export async function generateFollowUpSuggestions(params: {
	userId: string;
	conversationId: string;
	userMessage: string;
	assistantResponse: string;
	recentHistory?: FollowUpHistoryMessage[];
	signal?: AbortSignal;
}): Promise<string[] | null> {
	const response = params.assistantResponse.trim();
	if (response.length < FOLLOW_UP_SUGGESTIONS_MIN_CONTENT_LENGTH) return null;
	if (looksLikeClarificationQuestion(response)) return null;

	const language = resolveShortTextLanguage(params.userMessage);
	const history = renderFollowUpHistory(params.recentHistory ?? []);
	const prompt = [
		...(history ? [`Earlier in this conversation:\n${history}`] : []),
		`Latest user message:\n${params.userMessage
			.trim()
			.slice(0, FOLLOW_UP_SUGGESTIONS_USER_MESSAGE_CHAR_BUDGET)}`,
		`Assistant reply:\n${renderFollowUpReply(response)}`,
	].join("\n\n");

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
