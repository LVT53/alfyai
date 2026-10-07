import type { ModelId } from "$lib/model-types";
import type { ThinkingMode } from "$lib/reasoning-depth-types";
import { resolveResponseLanguage, type SupportedLanguage } from "../language";
import type {
	JsonControlMessageResult,
	JsonControlResponseSchema,
} from "../normal-chat-control-model";

/**
 * Shared "local-model short-text generation" seam.
 *
 * Title generation, turn acknowledgment, and (later, Tier A1) the jump-rail
 * summary all ask a small local control model for a short piece of text and
 * then apply the same discipline to the result: strip leaked reasoning, check
 * plausibility, and (for language-sensitive surfaces) resolve/verify HU vs EN.
 * That discipline used to live only inside `title-generator.ts`; the
 * control-model call + cost/timeout/concurrency plumbing used to live only
 * inside `turn-acknowledgment.ts`. This module owns both, once, so new callers
 * are thin.
 *
 * Two layers:
 *  - a pure, easily-tested cleanup/language core (`stripLeakedThinking`,
 *    `isReasoningLeak`, `isPlausibleShortText`, `resolveShortTextLanguage`,
 *    `isHungarianText`),
 *  - a control-model call primitive (`callShortLocalControlModel`) that owns
 *    the concurrency cap, the hard-timeout signal, and the ADR-0047 cost
 *    accounting in ONE place, plus a plain-text convenience
 *    (`generateShortLocalText`) that pipes the primitive's raw output through
 *    the cleanup core.
 *
 * Honesty (ADR-0056): any failed/timed-out/cap-missed call returns `null`, and
 * cleanup that rejects the text also returns `null`. Callers keep their own
 * deterministic fallback (e.g. the title path falls back to a truncated user
 * message). This module never fabricates.
 */

// --- a stray think block -----------------------------------------------------
//
// A request that says `enable_thinking: false` reaches the chat template in the
// form vLLM reads (`chat_template_kwargs`), and the rendered prompt then ends
// with an empty `<think>\n\n</think>\n\n` (checked on the real server through
// /tokenize). The model nevertheless opened another block as its first token for
// about one title in five, and the cause was the request: the chat template
// renders every earlier assistant turn with an empty block too, and the title
// carried four few-shot examples as assistant turns (now text; see
// title-generator.ts). The status line, rail summary, follow-ups and
// acknowledgment have no earlier assistant turn and never did it (0 of 1,900
// requests). Whatever a model still opens is dealt with here. The server drops
// the closing `</think>` from the text it returns but keeps the opener, so the
// app sees the model's answer behind an unbalanced marker:
//
//   - `<think>\n\n\n\nTitle`              an empty block, the answer is intact
//                                          (86% of the leaks on the real model);
//   - `<think>\nThe user wants me to...`    real reasoning that was cut off, or
//                                          closed with the closer dropped: any
//                                          answer after it is not separable.
//
// This is the one place that tells them apart, for every short free-text answer
// a person reads.

const THINK_OPEN_RE = /<think>/i;
const CLOSED_THINK_BLOCK_RE = /<think>[\s\S]*?<\/think>/gi;

export type LeakedThinkingCleanup =
	| { kind: "text"; text: string }
	| { kind: "unclosed" };

/**
 * Drop whatever think markers the model put in a short answer. Closed blocks
 * go; an empty block whose closer the server dropped (the opener, then a blank
 * line, then the answer) goes and the answer stays; an opener that has
 * reasoning after it, or text before it, is `unclosed`: nothing in it can be
 * trusted as the answer, so the caller retries or falls back by rule.
 */
export function stripLeakedThinking(raw: string): LeakedThinkingCleanup {
	if (!THINK_OPEN_RE.test(raw)) return { kind: "text", text: raw };

	let text = raw.replace(CLOSED_THINK_BLOCK_RE, "");
	for (;;) {
		const open = text.search(THINK_OPEN_RE);
		if (open === -1) return { kind: "text", text: text.trim() };
		if (text.slice(0, open).trim()) return { kind: "unclosed" };

		const afterOpener = text.slice(open + "<think>".length);
		const gap = afterOpener.match(/^\s*/)?.[0] ?? "";
		const rest = afterOpener.slice(gap.length);
		if (!rest) return { kind: "text", text: "" };
		// The template's own empty block is `<think>\n\n</think>\n\n`, so what
		// is left of it once the closer is gone is a blank line (or two) before
		// the answer. Reasoning starts on the very next line.
		if (!/\n[^\S\n]*\n/.test(gap)) return { kind: "unclosed" };
		text = rest;
	}
}

// One extra attempt when the answer comes back as an unclosed reasoning block.
// A model that opens one does not do it every time (the title request did it for
// 19% of requests, and cleanly the other 81%), so a second ask all but removes
// the fallback, and a third would only spend the model's time.
export const THINKING_RETRY_MAX_ATTEMPTS = 2;

/**
 * Ask for a short free-text answer and return it with any think block
 * stripped, asking once more when the first answer is an unclosed block. `null`
 * after the last attempt: the caller's own deterministic fallback applies. A
 * failed request is the caller's to handle; it is not retried here.
 */
export async function askWithThinkingRetry(
	ask: () => Promise<string>,
): Promise<string | null> {
	for (let attempt = 1; attempt <= THINKING_RETRY_MAX_ATTEMPTS; attempt++) {
		const cleaned = stripLeakedThinking(await ask());
		if (cleaned.kind === "text") return cleaned.text;
	}
	return null;
}

// Thinking/chain-of-thought preambles that indicate the model leaked its
// reasoning into the visible output (it did not respect `enable_thinking:
// false`, or it filled a free JSON object with its thoughts). These never
// describe a valid short answer. The English half was kept byte-identical to
// the former `title-generator` THINKING_LEAK_RE; the additions are the shapes
// the real model produced (reasoning inside a rail-summary object: "The user
// wants a short Hungarian headline...", "The assistant provides a simple weekly
// diet plan...", "The response is in Hungarian, and it discusses..."). The
// assistant/reply/response openers need their verb, so a title that merely
// starts with those words ("The Response Time Problem") stays.
const REASONING_LEAK_RE =
	/^(Here's (a thinking|my) process|Let me (think about|work through|break (this|it) down)|I('ll| will) (approach|break (this|it) down)|First,? let me (think|analyze|break down)|Okay,? let me (think|analyze|work through)|Let's think about|I need to (think|determine)|The user (is asking|asks|asked|wants|provided)|The (assistant|reply|response) (is|provides|explains|summari[sz]es|discusses|introduces|explicitly)\b|This (looks like|seems like|is a)|Hmm,? let me|Alright,? let me)/i;

// The Hungarian side. On a Hungarian conversation the model reasons in
// Hungarian: 35 of the 40 reasoning texts collected from it open with the same
// subject ("A felhasználó magyarul kérdez: ...", "A felhasználó egy heti
// étrendet kért, és az asszisztens ...", "A felhasználó kérésére a rendszer
// ..."); the other five open in English ("We need answer in Hungarian."), which
// no short surface has shown yet, so it is not matched. `felhasználói`
// (user-facing) and `felhasználás` (use) are other words and do not match.
const REASONING_LEAK_HU_RE = /^a\s+felhasználó(?!i)\p{L}*/iu;

/**
 * Detect whether raw text looks like leaked reasoning rather than a genuine
 * short answer/title, in English or Hungarian.
 */
export function isReasoningLeak(text: string): boolean {
	const trimmed = text.trim();
	return REASONING_LEAK_RE.test(trimmed) || REASONING_LEAK_HU_RE.test(trimmed);
}

// A status line is the conclusion of a stretch of reasoning, and a line that
// only says what was asked is not one. English: the labels the model echoes from
// its own prompt scaffolding. Hungarian (agglutinative, so stems; collected from
// 1,170 status lines the real model produced for Hungarian conversations, 72 of
// which only said what was asked: "Tojás, rizs és zöldség alapú vacsoraötletek
// kérése", "Kezdő futóedzéstervet kért négy hétre", "A git pre-commit hook
// beállítását kérdezi", "... kell tisztázni magyarul"):
//   felhasználó  the person (not felhasználói "user-facing", not felhasználás "use")
//   kér, kért, kérés ...  asking for / the request (not kérdés, "a question")
//   kérdezi, kérdezte ...  asking
//   magyarul  the prompt's own "write it in Hungarian" echoed back
const REQUEST_RESTATEMENT_EN_RE =
	/^(?:latest\s+user\s+request|the\s+user(?:'s)?\s+(?:request|message|prompt)\b|the\s+user\s+(?:wants|is\s+asking|asks|asked|requested|requests)\b|user\s+(?:request|message)\b|the\s+(?:request|prompt)\s+is\b|(?:the\s+)?task\s*[:\-–—])/i;
const REQUEST_RESTATEMENT_HU_RE =
	/(?<![\p{L}\p{N}])(?:felhasználó(?!i)|kér(?:t|te|tek|ték|ik|i|ek|nek|és\p{L}*)?(?![\p{L}\p{N}])|kérdez(?:i|ik|te|ték|ett)(?![\p{L}\p{N}])|magyarul(?![\p{L}\p{N}]))/iu;

/**
 * Does a status line restate the user's request (or the prompt's own
 * scaffolding) instead of stating what the reasoning found or chose? Narrow on
 * purpose, like the other status-line guards: a miss shows a restatement, a
 * false hit only drops the headline to the phase label.
 */
export function isRequestRestatement(text: string): boolean {
	const trimmed = text.trim();
	return (
		REQUEST_RESTATEMENT_EN_RE.test(trimmed) ||
		REQUEST_RESTATEMENT_HU_RE.test(trimmed)
	);
}

export type PlausibleShortTextOptions = {
	/** Max character length after whitespace collapse. Default 100. */
	maxChars?: number;
	/** Max word count after whitespace collapse. Default 12. */
	maxWords?: number;
	/** Reject text that looks like leaked reasoning. Default true. */
	rejectReasoningLeak?: boolean;
};

/**
 * Whether `text` is a plausible short line: non-empty, within the char/word
 * bounds, and (by default) not leaked reasoning. Defaults match the former
 * `title-generator.isPlausibleTitle` (100 chars / 12 words) so title behavior
 * is preserved.
 */
export function isPlausibleShortText(
	text: string,
	options: PlausibleShortTextOptions = {},
): boolean {
	const maxChars = options.maxChars ?? 100;
	const maxWords = options.maxWords ?? 12;
	const rejectReasoningLeak = options.rejectReasoningLeak ?? true;

	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return false;
	if (normalized.length > maxChars) return false;
	if (normalized.split(" ").filter(Boolean).length > maxWords) return false;
	if (rejectReasoningLeak && isReasoningLeak(normalized)) return false;
	return true;
}

/**
 * Resolve the target language for a short local-model surface: an explicit
 * preference wins outright ("en"/"hu"); otherwise (including an "auto"
 * preference) this delegates the whole cascade to language.ts's shared
 * `resolveResponseLanguage` — an explicit request for the reply language in
 * the user's message ("answer in English", "válaszolj magyarul"; a message that
 * only mentions a language is not one, and neither is a request for a piece of
 * writing in it, "írj egy e-mailt angolul"), then the message's own detected
 * language, then
 * (2026-09-25 language review) the caller's `uiLanguage` when the message is
 * genuinely ambiguous, then English. No second fallback policy lives here:
 * this used to fall straight to `detectLanguage` on an ambiguous message,
 * which collapses to English even for a Hungarian-UI user whose message
 * just happened to be too short/ambiguous to read on its own.
 */
export function resolveShortTextLanguage(
	userMessage: string,
	preference?: "auto" | "en" | "hu",
	uiLanguage?: SupportedLanguage,
): "en" | "hu" {
	if (preference === "en") return "en";
	if (preference === "hu") return "hu";
	return resolveResponseLanguage({ latestMessage: userMessage, uiLanguage });
}

const HUNGARIAN_CHARS = /[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/;
const STRONG_HUNGARIAN_WORDS =
	/\b(és|hogy|nem|van|meg|ez|egy|kell|azt|volt)\b/i;

/**
 * Coarse "is this text Hungarian" check used for language parity (does the
 * generated line match the resolved language). Kept byte-identical to the
 * former `title-generator.isTitleHungarian`.
 */
export function isHungarianText(text: string): boolean {
	if (HUNGARIAN_CHARS.test(text)) return true;
	const matches = text.match(STRONG_HUNGARIAN_WORDS);
	return (matches?.length ?? 0) >= 2;
}

// --- control-model call primitive -------------------------------------------

// Per-feature in-flight counters for the concurrency cap. Each feature (e.g.
// "turn_acknowledgment", "rail_summary") keeps its own budget so one surface
// can never starve another, and a cap miss returns `null` immediately with no
// network attempt at all — matching the discipline established for the turn
// acknowledgment (see MAX_CONCURRENT_TURN_ACKNOWLEDGMENT_CALLS).
const inFlightByFeature = new Map<string, number>();

export type ShortLocalControlCallParams = {
	message: string;
	/** Control model to use. Defaults to "model2" (the shared local control model). */
	modelId?: ModelId;
	/** Cost-attribution tag, folded into the usage row's synthetic messageId. */
	feature: string;
	userId: string;
	conversationId: string;
	systemPrompt: string;
	/** Defaults to "off" — short local calls never want visible reasoning. */
	thinkingMode?: ThinkingMode;
	/**
	 * The temperature of a deterministic machine-read answer (a JSON
	 * classification). Omit it for anything a person reads: that takes the
	 * family sampling profile (normal-chat-model/sampling.ts).
	 */
	temperature?: number;
	/** What a family with no sampling profile sends for an answer a person reads. */
	profilelessTemperature?: number;
	maxTokens?: number;
	jsonSchema?: JsonControlResponseSchema;
	/** Hard timeout combined with `signal`. When omitted, only `signal` bounds the call. */
	timeoutMs?: number;
	/** When set, at most this many calls for `feature` may be in flight; else `null`. */
	maxConcurrent?: number;
	signal?: AbortSignal;
};

/**
 * Best-effort short control-model call. Owns the concurrency cap, the hard
 * timeout signal, and the ADR-0047 cost accounting in one place. Returns the
 * raw control-model result, or `null` on a cap miss, timeout, or any failure —
 * never throws. Callers apply their own parsing/cleanup to `result.text`.
 */
export async function callShortLocalControlModel(
	params: ShortLocalControlCallParams,
): Promise<JsonControlMessageResult | null> {
	const feature = params.feature;
	const cap = params.maxConcurrent;
	if (cap !== undefined) {
		const current = inFlightByFeature.get(feature) ?? 0;
		if (current >= cap) return null;
		inFlightByFeature.set(feature, current + 1);
	}

	try {
		const { sendJsonControlMessage } = await import(
			"../normal-chat-control-model"
		);
		const { createRequestAbortSignal } = await import(
			"./shared-normal-chat-model-run-helpers"
		);
		const signal =
			params.timeoutMs !== undefined
				? createRequestAbortSignal(params.timeoutMs, params.signal)
				: params.signal;

		const result = await sendJsonControlMessage(
			params.message,
			params.modelId ?? "model2",
			{
				systemPrompt: params.systemPrompt,
				thinkingMode: params.thinkingMode ?? "off",
				temperature: params.temperature,
				profilelessTemperature: params.profilelessTemperature,
				maxTokens: params.maxTokens,
				jsonSchema: params.jsonSchema,
				signal,
			},
		);

		// ADR-0047 — record this control call's spend through the shared cost
		// path, exactly once, right after the call and before any parsing, so a
		// downstream parse failure never loses the (already incurred) usage.
		// Awaited so tests can assert deterministically; the useful output is
		// already in hand by this point.
		const { recordControlModelUsage } = await import("../analytics");
		await recordControlModelUsage({
			userId: params.userId,
			conversationId: params.conversationId,
			feature: params.feature,
			modelId: result.modelId,
			modelDisplayName: result.modelDisplayName,
			promptTokens: result.usage?.promptTokens,
			completionTokens: result.usage?.completionTokens,
			totalTokens: result.usage?.totalTokens,
			cachedInputTokens: result.usage?.cachedInputTokens,
			cacheHitTokens: result.usage?.cacheHitTokens,
			cacheMissTokens: result.usage?.cacheMissTokens,
		});

		return result;
	} catch {
		return null;
	} finally {
		if (cap !== undefined) {
			const current = inFlightByFeature.get(feature) ?? 1;
			inFlightByFeature.set(feature, Math.max(0, current - 1));
		}
	}
}

// The shared control transport (`sendJsonControlMessage`) forces JSON output
// even when no schema is supplied (`buildOutput` returns `Output.json`), so a
// "plain text" request comes back wrapped as a JSON object like
// `{"headline":"…"}` — the model invents a key from the prompt wording. These
// are the keys such answers wrap under, tried in order before falling back to
// the object's first non-empty string value.
const JSON_TEXT_WRAPPER_KEYS = [
	"headline",
	"title",
	"text",
	"summary",
	"answer",
	"value",
	"label",
	"response",
];

// A model handed a free JSON object sometimes puts its own thinking in it, under
// keys like these (all seen on the real model: "thought", "thoughts",
// "reasoning", "analysis", "hypothesis"). Their values are never the answer.
const JSON_REASONING_KEY_RE =
	/^(?:thoughts?|reasoning|analysis|hypothesis|thinking|rationale|reason|explanation|notes?)$/i;
// "headline_hu": a wrapper key with a language suffix.
const JSON_SUFFIXED_WRAPPER_KEY_RE = new RegExp(
	`^(?:${JSON_TEXT_WRAPPER_KEYS.join("|")})_[a-z]+$`,
	"i",
);

/**
 * Unwrap the single string carried by a JSON object the control transport
 * returned for a schemaless "plain text" call. Leaves genuinely-plain text (and
 * anything that does not parse as a JSON object holding a string) untouched, so
 * it is safe to run on every short-text result. A ```json … ``` fence, if
 * present, is peeled first. The answer is the value under a known wrapper key
 * (or the same key with a language suffix), else the first string value that is
 * not under a key the model uses for its own reasoning.
 */
export function unwrapJsonControlText(raw: string): string {
	let text = raw.trim();
	const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	if (fenced) text = fenced[1].trim();
	if (!text.startsWith("{") || !text.endsWith("}")) return raw;
	try {
		const parsed = JSON.parse(text) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return raw;
		}
		const record = parsed as Record<string, unknown>;
		for (const key of JSON_TEXT_WRAPPER_KEYS) {
			const value = record[key];
			if (typeof value === "string" && value.trim()) return value;
		}
		const entries = Object.entries(record);
		const suffixed = entries.find(
			([key, value]) =>
				JSON_SUFFIXED_WRAPPER_KEY_RE.test(key) &&
				typeof value === "string" &&
				value.trim(),
		);
		if (suffixed) return suffixed[1] as string;
		const firstString = entries.find(
			([key, value]) =>
				!JSON_REASONING_KEY_RE.test(key) &&
				typeof value === "string" &&
				value.trim(),
		);
		return firstString ? (firstString[1] as string) : raw;
	} catch {
		return raw;
	}
}

// A string that opens like a JSON object or array: `{"` or `[{`, `["`, `[[`.
const JSON_BLOB_START_RE = /^(?:\{\s*"|\[\s*["{[])/;

// --- plain-text convenience -------------------------------------------------

export type ShortTextCleanup = {
	/** Reject leaked reasoning. Default true. */
	rejectReasoningLeak?: boolean;
	/** Plausibility char bound. Default 100. */
	maxChars?: number;
	/** Plausibility word bound. Default 12. */
	maxWords?: number;
	/** Normalize the raw model text before the plausibility/language checks. */
	normalize?: (raw: string) => string;
	/** Require the cleaned text to be in this language, else reject (`null`). */
	expectLanguage?: "en" | "hu";
};

export type GenerateShortLocalTextParams = {
	prompt: string;
	feature: string;
	userId: string;
	conversationId: string;
	systemPrompt?: string;
	modelId?: ModelId;
	maxTokens?: number;
	/** A deterministic machine-read answer's own temperature; omit for text a person reads (the family sampling profile). */
	temperature?: number;
	/**
	 * The JSON object the answer is asked to come in. Without one the transport
	 * only asks for "a JSON object" and the model picks its own shape; the cleanup
	 * unwraps the string either way.
	 */
	jsonSchema?: JsonControlResponseSchema;
	thinkingMode?: ThinkingMode;
	timeoutMs?: number;
	maxConcurrent?: number;
	signal?: AbortSignal;
	/** Convenience for `cleanup.expectLanguage` — the expected output language. */
	language?: "en" | "hu";
	cleanup?: ShortTextCleanup;
};

/**
 * Ask the local control model for a short line of plain text and return the
 * cleaned result, or `null`. Built on `callShortLocalControlModel` (cost +
 * timeout + cap) and the pure cleanup core. This is the seam Tier A1's
 * jump-rail summary will call.
 */
export async function generateShortLocalText(
	params: GenerateShortLocalTextParams,
): Promise<string | null> {
	const prompt = params.prompt.trim();
	if (!prompt) return null;

	const result = await callShortLocalControlModel({
		message: prompt,
		modelId: params.modelId ?? "model2",
		feature: params.feature,
		userId: params.userId,
		conversationId: params.conversationId,
		systemPrompt: params.systemPrompt ?? "",
		thinkingMode: params.thinkingMode ?? "off",
		temperature: params.temperature,
		maxTokens: params.maxTokens,
		jsonSchema: params.jsonSchema,
		timeoutMs: params.timeoutMs,
		maxConcurrent: params.maxConcurrent,
		signal: params.signal,
	});
	if (!result) return null;

	return cleanShortLocalText(result.text, params);
}

function cleanShortLocalText(
	raw: string,
	params: GenerateShortLocalTextParams,
): string | null {
	const cleanup = params.cleanup ?? {};
	// The transport forces JSON output, so a schemaless short-text call comes back
	// as `{"headline":"…"}` — unwrap to the underlying string before any cleanup,
	// or the rail/title/ack surfaces would show literal JSON.
	const stripped = stripLeakedThinking(raw ?? "");
	if (stripped.kind === "unclosed") return null;
	let text = unwrapJsonControlText(stripped.text);
	if (cleanup.normalize) text = cleanup.normalize(text);
	text = text.trim();
	if (!text) return null;
	// An object the model cut off, or one with nothing to unwrap, stays raw JSON;
	// short enough, it would pass the length bounds and be shown as the headline.
	if (JSON_BLOB_START_RE.test(text)) return null;

	if (
		!isPlausibleShortText(text, {
			maxChars: cleanup.maxChars,
			maxWords: cleanup.maxWords,
			rejectReasoningLeak: cleanup.rejectReasoningLeak,
		})
	) {
		return null;
	}

	const expectLanguage = cleanup.expectLanguage ?? params.language;
	if (expectLanguage && isHungarianText(text) !== (expectLanguage === "hu")) {
		return null;
	}

	return text;
}
