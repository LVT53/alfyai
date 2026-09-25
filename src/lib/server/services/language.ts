export type SupportedLanguage = "en" | "hu";

/**
 * A per-message language read: "en"/"hu" when the evidence is clear enough
 * to commit to, "unknown" when it is not (very short input, a bare name, a
 * URL, code, or genuinely mixed evidence). `classifyLanguageSignal` is
 * honest about the "unknown" case instead of guessing — callers that need a
 * single committed answer with no fallback context use `detectLanguage`
 * (unknown collapses to "en", the same safe default this module has always
 * used for empty input). Callers that have conversation context to fall
 * back on — the actual reply language, decided once per turn — use
 * `resolveResponseLanguage` instead.
 */
export type LanguageSignal = SupportedLanguage | "unknown";

const DEFAULT_SHORT_INPUT_THRESHOLD = 10;

// Direct port of the old short-input fallback words.
const HUNGARIAN_SHORT_WORDS = new Set([
	"igen",
	"nem",
	"köszönöm",
	"köszi",
	"szia",
	"helló",
	"kérem",
	"jó",
	"rossz",
	"miért",
	"hogyan",
	"hol",
	"mi",
	"ki",
	"na",
	"hát",
	"nos",
	"oké",
	"persze",
	"talán",
	"nincs",
	"van",
	"volt",
	"lesz",
	"kell",
	"tudok",
	"hé",
	// 2026-09-25 language review: more common, unambiguous short Hungarian
	// replies and greetings, none of which double as an everyday English word
	// (AGENTS.md language.ts ownership — grown here, not copied elsewhere).
	"mehet",
	"rendben",
	"köszike",
	"szuper",
	"pontosan",
	"értem",
	"tovább",
	"folytasd",
	"kész",
	"megvan",
	"sziasztok",
	"hali",
	// The object-case forms used in the "jó reggelt" / "jó éjt" greetings
	// ("jó" alone is already listed above); needed so the short-input branch's
	// every-token check (not just the longer general scorer) recognizes the
	// whole greeting.
	"reggelt",
	"éjt",
	"naná",
	"hogyne",
]);

// Extra lexical markers to approximate the old lingua-backed behavior for
// longer mixed prompts like "Irj egy angol emailt".
const HUNGARIAN_FUNCTION_WORDS = new Set([
	"a",
	"az",
	"egy",
	"és",
	"hogy",
	"de",
	"vagy",
	"ha",
	"akkor",
	"mert",
	"ami",
	"aki",
	"ezt",
	"azt",
	"itt",
	"ott",
	"nekem",
	"neki",
	"vel",
	"nélkül",
	"kell",
	"legyen",
	"lehet",
	"írj",
	"irj",
	"mondd",
	"mondj",
	"válaszolj",
	"valaszolj",
	"fordítsd",
	"forditsd",
	"fordíts",
	"fordits",
	"magyarázd",
	"magyarazd",
	"kérlek",
	"kerlek",
	"emailt",
	"levelet",
	"angol",
	"magyar",
	"magyarul",
	"angolul",
]);

const ENGLISH_FUNCTION_WORDS = new Set([
	"the",
	"and",
	"or",
	"if",
	"then",
	"please",
	"write",
	"answer",
	"translate",
	"explain",
	"email",
	"message",
	"about",
	"for",
	"with",
	"without",
	"this",
	"that",
	"hello",
	"thanks",
	"thank",
	"you",
	"tell",
	"me",
]);

// ő/ű never occur in English, French, German, Spanish, Portuguese, or
// Italian orthography — unlike á/é/í/ó/ö/ú/ü, which are common in loanwords
// and personal/place names across many languages ("café", "résumé",
// "naïve", "Zürich", "Beyoncé", "Győr"). Seeing ő/ű in a *lowercase* token
// is strong, near-unambiguous evidence of Hungarian text. The rest of the
// accented range is kept as weak, corroborating evidence only — this is the
// direct fix for the reported bug, where ANY accented letter anywhere
// (including inside a quoted name or loanword) used to flip the whole
// message to Hungarian.
const HUNGARIAN_EXCLUSIVE_LETTERS = /[őűŐŰ]/;
const HUNGARIAN_COMMON_ACCENTED_LETTERS = /[áéíóöúü]/i;

// Mirrors normal-chat-context.ts's own pasted-URL pattern (kept local and
// duplicated rather than imported, so this module stays dependency-free and
// safe to unit test in isolation — both are simple, stable "an http(s) link
// starts here" matchers, not a shared parsing contract worth coupling).
const PASTED_URL_RE = /https?:\/\/[^\s<>\]"']+/gi;

const HUNGARIAN_SUFFIXES = [
	"nak",
	"nek",
	"ban",
	"ben",
	"val",
	"vel",
	"ból",
	"ből",
	"rol",
	"ról",
	"ről",
	"tól",
	"től",
	"hoz",
	"hez",
	"höz",
	"ért",
	"ként",
	"ul",
	"ül",
];

// Promoted from the former per-surface copies in chat-turn/short-local-text.ts
// and (before it) title-generator.ts — one place decides whether the user
// explicitly asked for a response in a given language ("write this in
// Hungarian", "válaszolj angolul"). Kept byte-identical to the proven
// patterns so title/turn-acknowledgment/rail-summary behavior does not
// change; now also the first check `resolveResponseLanguage` makes, so an
// explicit request wins even when the message itself is written in the
// other language (e.g. a Hungarian message ending "...válaszolj angolul").
const EXPLICIT_ENGLISH_REQUEST_RE =
	/\b(in english|english title|respond in english|answer in english)\b|angolul/i;
const EXPLICIT_HUNGARIAN_REQUEST_RE =
	/\b(in hungarian|hungarian title|respond in hungarian|answer in hungarian)\b|magyarul/i;

/**
 * Whether `text` explicitly asks for a response in a given language,
 * regardless of what language `text` itself is written in. `null` when no
 * such request is present.
 */
export function detectExplicitLanguageRequest(
	text: string,
): SupportedLanguage | null {
	if (EXPLICIT_ENGLISH_REQUEST_RE.test(text)) return "en";
	if (EXPLICIT_HUNGARIAN_REQUEST_RE.test(text)) return "hu";
	return null;
}

function normalizeWord(word: string): string {
	return word
		.toLowerCase()
		.trim()
		.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
}

type TokenEvidence = {
	strongHungarian: number;
	weakHungarian: number;
	english: number;
};

/**
 * Scores every letter-run token in the message. Single-character tokens
 * ("a", "b", "s") are skipped entirely: they are too ambiguous in either
 * language to count as evidence (the English article "a", a code parameter
 * name, or a bare initial all collide with genuine one-letter Hungarian
 * words). Evidence is tiered:
 *  - STRONG Hungarian: a closed-class function/short word, or an
 *    ő/ű-exclusive letter in a token that is not Capitalized (a
 *    Capitalized token is more likely a proper noun quoted from/about
 *    Hungary inside an otherwise foreign sentence, e.g. "We visited Győr").
 *  - WEAK Hungarian: the common accented letters, or matched morphology
 *    (HUNGARIAN_SUFFIXES) — real signal, but not enough on its own to
 *    conclude Hungarian without at least one strong signal too (this is
 *    what stops "café", "urban", or a pasted address from deciding the
 *    language).
 *  - English: a closed-class function word, plus a small base credit for
 *    every recognizable letter-token — English is this detector's
 *    zero-evidence default, so it does not need to prove itself the way
 *    Hungarian does.
 */
function scoreTokens(rawTokens: string[]): TokenEvidence {
	let strongHungarian = 0;
	let weakHungarian = 0;
	let english = 0;

	for (const raw of rawTokens) {
		const token = normalizeWord(raw);
		if (!token || token.length < 2) continue;

		const isCapitalized = /^\p{Lu}/u.test(raw);

		if (
			HUNGARIAN_SHORT_WORDS.has(token) ||
			HUNGARIAN_FUNCTION_WORDS.has(token)
		) {
			strongHungarian += 3;
		}
		if (!isCapitalized && HUNGARIAN_EXCLUSIVE_LETTERS.test(token)) {
			strongHungarian += 3;
		}
		if (!isCapitalized && HUNGARIAN_COMMON_ACCENTED_LETTERS.test(token)) {
			weakHungarian += 1;
		}
		if (
			HUNGARIAN_SUFFIXES.some(
				(suffix) => token.length > suffix.length + 2 && token.endsWith(suffix),
			)
		) {
			weakHungarian += 1;
		}

		if (ENGLISH_FUNCTION_WORDS.has(token)) {
			english += 2;
		}
		english += 0.25;
	}

	return { strongHungarian, weakHungarian, english };
}

// "hu" requires strong evidence AND a comfortable lead over the English
// score. "en" (once Hungarian evidence exists at all) requires a comfortable
// lead the other way. Anything in between is genuinely contested — that is
// "unknown", not a coin flip.
const HUNGARIAN_DECISION_MARGIN = 1.5;
const ENGLISH_DOMINANCE_MARGIN = 1.5;

/**
 * Classify the language of a single message, honestly reporting "unknown"
 * rather than guessing when the evidence is too thin or too mixed. See
 * `resolveResponseLanguage` for the policy that turns this into an actual
 * reply-language decision across a conversation.
 */
export function classifyLanguageSignal(
	text: string,
	options?: { shortInputThreshold?: number },
): LanguageSignal {
	const trimmed = text.trim();
	if (!trimmed) return "en";

	const shortInputThreshold =
		options?.shortInputThreshold ?? DEFAULT_SHORT_INPUT_THRESHOLD;
	const normalized = trimmed.toLowerCase();

	// Exact port of the old short-input branch, except the "not in the list"
	// case is now "unknown" rather than a silent "en" guess: a bare "ok",
	// name, or short code token is genuinely ambiguous on its own, and the
	// resolver's conversation/UI-language fallback is the honest way to
	// answer it. `detectLanguage` below still collapses this to "en" for
	// every caller that has no such fallback, so today's standalone
	// behavior is unchanged.
	if (shortInputThreshold > 0 && trimmed.length < shortInputThreshold) {
		const shortNormalized = normalized.replace(/[?!.,]+$/g, "");
		if (HUNGARIAN_SHORT_WORDS.has(shortNormalized)) return "hu";

		// The check above only matches the WHOLE trimmed string as one key, so
		// a single word like "szia" matches but a short reply combining two
		// known short words ("nem jó", "igen persze") does not, even though
		// it is just as unambiguous. Require EVERY letter-token to be a known
		// short word (not just one) so a short phrase that only partially
		// overlaps the list — one Hungarian word plus an English word, a
		// name, or a number — still honestly reports "unknown" rather than
		// guessing.
		const shortTokens = shortNormalized.match(/[\p{L}]+/gu) ?? [];
		if (
			shortTokens.length > 1 &&
			shortTokens.every((token) => HUNGARIAN_SHORT_WORDS.has(token))
		) {
			return "hu";
		}

		return "unknown";
	}

	// Strip pasted URLs before tokenizing: a link's path/slug segments are
	// not prose in either language, and scoring them (e.g. an English
	// function word or a Hungarian-looking suffix inside a URL slug) would
	// launder unrelated evidence into the decision. A message that turns
	// out to be nothing but a URL falls through to the empty-token
	// "unknown" below, which is correct — a bare pasted link carries no
	// language signal of its own.
	const withoutUrls = trimmed.replace(PASTED_URL_RE, " ");
	const rawTokens = withoutUrls.match(/[\p{L}]+/gu) ?? [];
	if (rawTokens.length === 0) return "unknown";

	const { strongHungarian, weakHungarian, english } = scoreTokens(rawTokens);
	const hungarian = strongHungarian + weakHungarian;

	if (strongHungarian > 0 && hungarian >= english + HUNGARIAN_DECISION_MARGIN) {
		return "hu";
	}
	if (hungarian === 0) {
		return english > 0 ? "en" : "unknown";
	}
	if (english >= hungarian + ENGLISH_DOMINANCE_MARGIN) {
		return "en";
	}
	return "unknown";
}

/**
 * Detect the language of a single message with no conversation context.
 * "unknown" (see `classifyLanguageSignal`) collapses to "en" — the same
 * default this module has always used for empty/ambiguous input. Prefer
 * `resolveResponseLanguage` for anything that decides what language to
 * reply in; this remains for standalone, single-message callers (the Atlas
 * research pipeline's query language, an isolated error message) that have
 * no conversation to fall back on.
 */
export function detectLanguage(
	text: string,
	options?: { shortInputThreshold?: number },
): SupportedLanguage {
	const signal = classifyLanguageSignal(text, options);
	return signal === "hu" ? "hu" : "en";
}

/**
 * The one place a chat turn's reply language is decided. Policy:
 *  1. An explicit request in the latest message ("write this in Hungarian",
 *     "válaszolj angolul") always wins, regardless of what language the
 *     message itself is written in.
 *  2. Otherwise, if the latest message's language is clear, use it.
 *  3. Otherwise (the latest message is ambiguous — very short, code, a URL,
 *     a bare name, mixed evidence), fall back to the conversation's
 *     established language: the most recent *prior user message* (never
 *     assistant text, memory facts, project files, or retrieved content)
 *     whose own language is clear.
 *  4. Otherwise, fall back to the user's UI language.
 *  5. Otherwise, default to English.
 *
 * `priorUserMessages` must be the user's own messages only, most-recent
 * first — retrieved/context text must never reach this function, per the
 * "context never decides the reply language" rule.
 */
export function resolveResponseLanguage(params: {
	latestMessage: string;
	priorUserMessages?: string[];
	uiLanguage?: SupportedLanguage;
}): SupportedLanguage {
	const explicitRequest = detectExplicitLanguageRequest(params.latestMessage);
	if (explicitRequest) return explicitRequest;

	const latestSignal = classifyLanguageSignal(params.latestMessage);
	if (latestSignal !== "unknown") return latestSignal;

	for (const priorMessage of params.priorUserMessages ?? []) {
		const signal = classifyLanguageSignal(priorMessage);
		if (signal !== "unknown") return signal;
	}

	if (params.uiLanguage) return params.uiLanguage;
	return "en";
}
