import { z } from "zod";
import type { SupportedLanguage } from "../language";
import { parseJsonWithEnvelopeExtraction } from "../memory-judge/schema";
import type { JsonControlResponseSchema } from "../normal-chat-control-model";
import { checkFollowUpChip } from "./follow-up-chip";
import {
	callShortLocalControlModel,
	resolveShortTextLanguage,
} from "./short-local-text";

/**
 * Follow-up suggestions (owner idea, variant A) — after an assistant turn
 * finishes, ask the shared local control model ("model2") for the best NEXT
 * MESSAGES the user might send: what the reply did not cover, the decision it
 * leaves open, the concrete thing the assistant can do next. A chip is the
 * user's own next message: tapping it sends its text, as it stands, as the
 * user's message, so it is written as an instruction or the user's own
 * question, never as the assistant offering or asking the user something
 * (`follow-up-chip.ts` says what a chip is and rejects what is not one). The
 * model sees the last few turns of the conversation (so a suggestion cannot
 * simply restate what the user already asked), the current user message, and
 * the reply's head AND tail (so a long answer's conclusion — usually where
 * the next step lives — is never truncated away).
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
// A chip that names what it acts on ("Compare Dean Village and Calton Hill for
// Sunday morning") needs a couple more words than the old eight-word question;
// the chip wraps, so the character budget is what keeps it a chip.
export const FOLLOW_UP_SUGGESTIONS_MAX_WORDS = 10;
const FOLLOW_UP_SUGGESTIONS_MAX_CHARS = 80;

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
// Room for three 10-word messages inside the JSON envelope (Hungarian words
// cost about three tokens each), with headroom for a model that pretty-prints
// it.
const FOLLOW_UP_SUGGESTIONS_MAX_TOKENS = 180;

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

// The shape of a good chip, from other conversations than the one being asked
// about so that a chip never copies its example. Each is written in the language
// it teaches and has to pass `checkFollowUpChip` (a test holds it to that).
export const FOLLOW_UP_CHIP_EXAMPLES: Record<"en" | "hu", string[]> = {
	en: [
		"Compare the two phone plans in a table",
		"Turn the moving advice into a checklist",
		"Draft the email to the contractor",
		"Explain the second step in more detail",
		"Shorten the cover letter to one page",
		"Work out the monthly cost for three people",
		"Give an example of the retry logic in Python",
		"How do I set up the firewall?",
	],
	hu: [
		"Hasonlítsd össze a két telefontarifát táblázatban",
		"Készíts ellenőrzőlistát a költözéshez",
		"Írd meg az e-mailt a kivitelezőnek",
		"Magyarázd el részletesebben a második lépést",
		"Rövidítsd le a motivációs levelet egy oldalra",
		"Számold ki a havi költséget három főre",
		"Mutass példát az újrapróbálkozásra Pythonban",
		"Hogyan állítsam be a tűzfalat?",
	],
};

function buildFollowUpSuggestionsSystemPrompt(language: "en" | "hu"): string {
	const languageLabel = language === "hu" ? "Hungarian" : "English";
	const examples = FOLLOW_UP_CHIP_EXAMPLES[language].join("\n");
	return `You write the suggestion chips shown under an assistant's reply in a chat app. A chip is the NEXT MESSAGE THE USER WOULD SEND to the assistant: tapping it sends its text, exactly as written, as the user's own message. So every chip is the user speaking to the assistant, and it must make sense on its own. Respond with strict JSON only, matching exactly: {"followUps": [string, string, string]} — no preamble, no explanation, no markdown.

Rules:
- Write exactly ${FOLLOW_UP_SUGGESTIONS_REQUESTED_COUNT} candidate messages, in ${languageLabel}, best first.
- Each is an instruction to the assistant, or the user's own question about something named in the reply, in at most ${FOLLOW_UP_SUGGESTIONS_MAX_WORDS} words: one plain sentence, no quotes.
- Each asks for something concrete the assistant can do in its next message: turn the reply into a table, a checklist or a plan; compare options the reply names; draft the message or email the user needs; write an example, a shorter version or a more formal one; go one step deeper on one named point; work the advice out for the user's own situation, only if the conversation states it.
- Each names what it acts on (the dish, the plan, the code, the two options), in the reply's own words. Never just "this", "it" or "more".
- Never write what the assistant would say. No offers ("Would you like me to…", "Shall I…"), no questions to the user ("What is your budget?"), no statements about the user.
- Never answer a question the assistant asked the user, and never state a fact about the user that the conversation has not stated.
- Ask only for what the assistant can do in the chat itself, never for sending, booking, buying or calling.
- Never ask for something the reply already gives, and never repeat anything the user has already asked earlier in the conversation.
- If the reply ends by offering something, the first message accepts that offer.
- Make the ${FOLLOW_UP_SUGGESTIONS_REQUESTED_COUNT} genuinely different from one another.
- Avoid "you": write an instruction, or the user's own question with "I".
- Write natural, idiomatic ${languageLabel}, the way a person types to an assistant.

The shape of a good message, from other conversations (adapt to this reply, never copy):
${examples}
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
 * A candidate follow-up survives only when it is a chip: one short plain
 * sentence, in the turn's language when it is given, written as the user's own
 * next message to the assistant — not the assistant offering, a question put to
 * the user, a statement about the user or a generic push. Exported for direct
 * unit testing of the plausibility boundary, mirroring `isPlausibleShortText`'s
 * precedent; the rules themselves live in `follow-up-chip.ts`.
 */
export function isPlausibleFollowUpSuggestion(
	text: string,
	language?: "en" | "hu",
): boolean {
	return checkFollowUpChip(text, {
		language,
		maxWords: FOLLOW_UP_SUGGESTIONS_MAX_WORDS,
		maxChars: FOLLOW_UP_SUGGESTIONS_MAX_CHARS,
	}).ok;
}

function parseFollowUpSuggestions(
	rawText: string,
	language: "en" | "hu",
): string[] | null {
	const data = parseJsonWithEnvelopeExtraction(rawText, "followUps");
	if (!data) return null;
	const result = followUpSuggestionsResponseSchema.safeParse(data);
	if (!result.success || !result.data.followUps) return null;

	const seen = new Set<string>();
	const cleaned: string[] = [];
	for (const candidate of result.data.followUps) {
		const chip = checkFollowUpChip(candidate, {
			language,
			maxWords: FOLLOW_UP_SUGGESTIONS_MAX_WORDS,
			maxChars: FOLLOW_UP_SUGGESTIONS_MAX_CHARS,
		});
		if (!chip.ok) continue;
		// The client keys chips by text; a repeated suggestion must never
		// reach the persisted array.
		const key = chip.text.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		cleaned.push(chip.text);
		if (cleaned.length === FOLLOW_UP_SUGGESTIONS_COUNT) break;
	}

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
	/**
	 * The turn's reply language, decided once per turn (latest message, the
	 * recent user messages, then the UI language). The chips are in the language
	 * the reply is in: read off the latest message alone, a Hungarian message the
	 * detector has too little evidence on reads as English.
	 */
	responseLanguage?: SupportedLanguage;
	signal?: AbortSignal;
}): Promise<string[] | null> {
	const response = params.assistantResponse.trim();
	if (response.length < FOLLOW_UP_SUGGESTIONS_MIN_CONTENT_LENGTH) return null;
	if (looksLikeClarificationQuestion(response)) return null;

	const language =
		params.responseLanguage ?? resolveShortTextLanguage(params.userMessage);
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
		// The suggestions are read by a person: the family sampling profile
		// (sampling.ts); a family without one keeps its 0.4.
		profilelessTemperature: 0.4,
		maxTokens: FOLLOW_UP_SUGGESTIONS_MAX_TOKENS,
		jsonSchema: FOLLOW_UP_SUGGESTIONS_JSON_SCHEMA,
		timeoutMs: FOLLOW_UP_SUGGESTIONS_TIMEOUT_MS,
		maxConcurrent: FOLLOW_UP_SUGGESTIONS_MAX_CONCURRENT,
		signal: params.signal,
	});
	if (!result) return null;

	try {
		return parseFollowUpSuggestions(result.text, language);
	} catch (error) {
		console.error("[FOLLOW_UP_SUGGESTIONS] Failed to parse response", error);
		return null;
	}
}
