import type { ModelId } from "$lib/model-types";
import type { ThinkingMode } from "$lib/reasoning-depth-types";
import { detectLanguage } from "../language";
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
 *  - a pure, easily-tested cleanup/language core (`isReasoningLeak`,
 *    `isPlausibleShortText`, `resolveShortTextLanguage`, `isHungarianText`),
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

// Thinking/chain-of-thought preambles that indicate the model leaked its
// reasoning into the visible output (it did not respect `enable_thinking:
// false`). These never describe a valid short answer. Kept byte-identical to
// the former `title-generator` THINKING_LEAK_RE so title behavior is preserved.
const REASONING_LEAK_RE =
	/^(Here's (a thinking|my) process|Let me (think about|work through|break (this|it) down)|I('ll| will) (approach|break (this|it) down)|First,? let me (think|analyze|break down)|Okay,? let me (think|analyze|work through)|Let's think about|I need to (think|determine)|The user (is asking|asks|asked)|This (looks like|seems like|is a)|Hmm,? let me|Alright,? let me)/i;

/**
 * Detect whether raw text looks like leaked reasoning rather than a genuine
 * short answer/title.
 */
export function isReasoningLeak(text: string): boolean {
	return REASONING_LEAK_RE.test(text.trim());
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

const EXPLICIT_ENGLISH_HINT_RE =
	/\b(in english|english title|respond in english|answer in english)\b|angolul/i;
const EXPLICIT_HUNGARIAN_HINT_RE =
	/\b(in hungarian|hungarian title|respond in hungarian|answer in hungarian)\b|magyarul/i;

/**
 * Resolve the target language for a short local-model surface: an explicit
 * preference wins, then an inline hint in the user's message ("in English",
 * "magyarul"), then automatic detection. Kept byte-identical to the former
 * `title-generator.resolveTitleLanguage`.
 */
export function resolveShortTextLanguage(
	userMessage: string,
	preference?: "auto" | "en" | "hu",
): "en" | "hu" {
	if (preference === "en") return "en";
	if (preference === "hu") return "hu";
	if (EXPLICIT_ENGLISH_HINT_RE.test(userMessage)) return "en";
	if (EXPLICIT_HUNGARIAN_HINT_RE.test(userMessage)) return "hu";
	return detectLanguage(userMessage);
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
	temperature?: number;
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

/**
 * Unwrap the single string carried by a JSON object the control transport
 * returned for a schemaless "plain text" call. Leaves genuinely-plain text (and
 * anything that does not parse as a JSON object holding a string) untouched, so
 * it is safe to run on every short-text result. A ```json … ``` fence, if
 * present, is peeled first.
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
		const firstString = Object.values(record).find(
			(value) => typeof value === "string" && value.trim(),
		);
		return typeof firstString === "string" ? firstString : raw;
	} catch {
		return raw;
	}
}

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
	temperature?: number;
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
	let text = unwrapJsonControlText(raw ?? "");
	if (cleanup.normalize) text = cleanup.normalize(text);
	text = text.trim();
	if (!text) return null;

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
