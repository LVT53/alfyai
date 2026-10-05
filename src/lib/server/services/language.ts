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

// A quoted word is usually what the message is ABOUT, not the language it is
// written in: "What does 'szia' mean in Hungarian?" is English however
// Hungarian the quoted word is, and "Mit jelent az, hogy 'serendipity'?" is
// Hungarian. The opening quote must start a word, so a contraction's
// apostrophe (don't, it's) never opens one. A message that is nothing BUT a
// quote is still read as it stands.
const QUOTED_SPAN_RE =
	/(?<![\p{L}\p{N}])(?:'[^'\n]{1,60}'|"[^"\n]{1,60}"|„[^”"\n]{1,60}[”"]|“[^”\n]{1,60}”|‘[^’\n]{1,60}’)(?![\p{L}\p{N}])/gu;

function stripQuotedSpans(text: string): string {
	const stripped = text.replace(QUOTED_SPAN_RE, " ");
	return /\p{L}/u.test(stripped) ? stripped : text;
}

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

// --- explicit requests for a reply language -----------------------------------
//
// One place decides whether the user explicitly asked for the reply in a given
// language ("válaszolj angolul", "answer in Hungarian"); it is the first check
// `resolveResponseLanguage` makes, so a request wins even when the message
// itself is written in the other language (a Hungarian message ending "...
// válaszolj angolul").
//
// A language word is a REQUEST only when the person asks for the answer in it.
// A message that merely mentions the language keeps the conversation's: "Hogy
// mondják angolul, hogy alma?" is a Hungarian question about English and its
// answer is Hungarian, "How do you say 'apple' in Hungarian?" is answered in
// English. (The old rule took "angolul" / "in Hungarian" anywhere as a request:
// on the real model that gave an English reply to the first and a Hungarian
// "Az alma." to the second.)
//
// Per sentence, with accents folded (people type "valaszolj angolul"):
//  - a sentence that opens with a question word is a question ABOUT the language
//    (how, what, which; hogy, mit, melyik) and requests nothing;
//  - otherwise the language word asks for the reply when a directive about the
//    reply (answer, write, speak, talk, explain, summarize; válaszolj, írd,
//    beszéljünk, magyarázd, foglald össze) stands within a few words of it, or
//    "please" / "kérlek" / "legyen" / "only" is right beside it, or the
//    sentence is little more than the language word ("In English, please." /
//    "Angolul.");
//  - translate / fordítsd, learn / tanulni, mean / jelent and "can you speak"
//    are none of those, so they never flip it.
// The latest request in the message wins.

const wordSet = (list: string) => new Set(list.split(" "));

function foldAccents(text: string): string {
	return text
		.toLowerCase()
		.normalize("NFD")
		.replace(/\p{M}+/gu, "");
}

type LanguageMarker = {
	at: number;
	// The index of the marker's last word.
	end: number;
	language: SupportedLanguage;
	// "adverb": angolul / magyarul / angol nyelven; "in": "in English"; "bare":
	// "English" with no preposition, which only a few shapes read as a request.
	kind: "adverb" | "in" | "bare";
};

const ENGLISH_NAMES: Record<string, SupportedLanguage> = {
	english: "en",
	hungarian: "hu",
};
// "in plain English", "in a formal Hungarian".
const LANGUAGE_MODIFIERS = wordSet(
	"the a an plain simple simplified clear proper formal informal casual basic good correct fluent natural native british american standard very some easy",
);

function findLanguageMarkers(words: string[]): LanguageMarker[] {
	const markers: LanguageMarker[] = [];
	for (let at = 0; at < words.length; at++) {
		const word = words[at];
		if (word === "angolul" || word === "magyarul") {
			const language = word === "angolul" ? "en" : "hu";
			markers.push({ at, end: at, kind: "adverb", language });
		} else if (
			(word === "angol" || word === "magyar") &&
			(words[at + 1] === "nyelven" || words[at + 1] === "nyelvu")
		) {
			const language = word === "angol" ? "en" : "hu";
			markers.push({ at, end: at + 1, kind: "adverb", language });
		} else if (word === "in") {
			let nameAt = at + 1;
			while (nameAt < at + 4 && LANGUAGE_MODIFIERS.has(words[nameAt] ?? "")) {
				nameAt++;
			}
			const language = ENGLISH_NAMES[words[nameAt] ?? ""];
			if (language) {
				const end = words[nameAt + 1] === "language" ? nameAt + 1 : nameAt;
				markers.push({ at, end, kind: "in", language });
			}
		} else if (ENGLISH_NAMES[word]) {
			const afterIn = words.slice(Math.max(0, at - 4), at).includes("in");
			if (!afterIn) {
				markers.push({
					at,
					end: at,
					kind: "bare",
					language: ENGLISH_NAMES[word],
				});
			}
		}
	}
	return markers;
}

// Words that may open a sentence without changing what it is ("and what does
// it mean...", "szia, hogy mondják...").
const LEADING_FILLERS = wordSet(
	"and so but also ok okay hey hi hello well actually es de akkor szia helo bocsi na hat nos ja",
);
// A question ABOUT something, not an instruction to Alfy.
const QUESTION_STARTERS = wordSet(
	"how what which where when why who whom whose is are was were does did do isn't aren't doesn't don't hogy hogyan mit mi mik melyik milyen hol hova honnan mikor miert mennyi mennyire ki kit kinek mibol mire mivel miben",
);
// "...mondd meg, hogy van angolul az, hogy kutya": a Hungarian how-is-it-said
// question buried in a longer sentence.
const HUNGARIAN_HOW_SAID_RE =
	/\bhogy(?:an)? (?:\p{L}+ )?(?:mondjak|mondjuk|mondod|mondom|mondanak|hivjak|hivjuk|hivod|forditjak|forditod|forditom|van|lesz|hangzik|szol|kell|irod|irom|irjuk)\b|\bmit jelent|\bjelentese\b/u;

// A directive about the reply, in a form that asks for it: an imperative, a
// polite conditional or "may". "válaszolok" (I answer) and "beszélsz" (you
// speak) are not on the list.
const HUNGARIAN_DIRECTIVE_RE =
	/^(?:valaszol(?:j|jal|jad|jon|jatok|junk|hatsz|hatnal|hatnad|nal|nad)|ir(?:j|jal|jad|jon|d|nal|nad|hatsz|hatnal|hatnad|hatod)|beszel(?:j|jel|jen|junk|nel|hetunk|hetnenk|hetsz|hetnel)|beszelgess(?:unk|en)?|beszelget(?:nel|hetunk|hetnenk|hetsz|hetnel)|folyt(?:as(?:d|s|suk|sunk)|athatjuk|atnal)|magyaraz(?:d|z|zad|zon|hatnad)|fogalmaz(?:d|z|zad|zon|nal|nad)|foglal(?:d|j|nad|nal)|osszegez(?:d|z|nel)|mesel(?:j|d|nel)|kommunikal(?:j|junk))$/;
// "Tudnál angolul válaszolni?" / "Angolul szeretnék beszélgetni": an infinitive
// that a polite modal asks for. "Tudsz angolul válaszolni?" asks for the reply
// too; "Tudsz angolul beszélni?" asks whether you speak it.
const HUNGARIAN_INFINITIVE_RE =
	/^(?:valaszolni|irni|beszelni|beszelgetni|folytatni|magyarazni|fogalmazni|meselni|kommunikalni)$/;
const HUNGARIAN_ANSWER_INFINITIVE_RE =
	/^(?:valaszolni|irni|folytatni|magyarazni|fogalmazni|meselni)$/;
const HUNGARIAN_REQUEST_MODALS = wordSet(
	"tudnal tudnatok tudnank tudunk lehet lehetne szeretnek szeretnem szeretnenk kerlek kerem kernek kernem kellene erdemes szabad",
);
const HUNGARIAN_POLITE_WORDS = wordSet(
	"kerlek kerem kernek kernem legy legyel legyen szives szivesen inkabb csak mostantol ezentul most",
);
const HUNGARIAN_WISH_WORDS = wordSet("legyen legyel lehet lehetne");
// Learning, ability, translation and meaning: the language is the subject.
const HUNGARIAN_SUBJECT_STEM_RE =
	/^(?:tanul|megtanul|tanit|gyakorol|tud(?:sz|ok|om|od|ja|nak)?$|beszel(?:sz|ek|nek)$|ert(?:em|ed|esz)?$|ismer|fordit|lefordit|atfordit|jelent)/;

// Directives that mean it wherever they stand, and ones that are only an
// instruction at the head of a sentence or inside a request ("I give lessons in
// English" is not one).
const ENGLISH_DIRECTIVES = wordSet(
	"reply respond answer write speak talk chat converse communicate continue explain describe summarize summarise rephrase rewrite",
);
const ENGLISH_WEAK_DIRECTIVES = wordSet(
	"redo repeat type give keep stick switch",
);
// Verbs that take a bare language name ("Speak Hungarian to me", "Switch to
// Hungarian"); the others take "in".
const ENGLISH_SPEECH_VERBS = wordSet(
	"speak talk chat converse communicate continue switch go stick keep use",
);
const ENGLISH_SUBJECTS = wordSet("i we they he she it people students");
const ENGLISH_POLITE_WORDS = wordSet("please pls plz kindly");
const BARE_FILLERS = wordSet(
	"please pls plz only just in the language instead rather better then now and but so ok okay yes no nope sorry oh yeah thanks thank you kerlek kerem kernek legy legyel legyen szives szivesen inkabb csak mostantol ezentul most es de akkor igen nem ne na hat ja nos is",
);

function isHungarianDirective(word: string): boolean {
	return HUNGARIAN_DIRECTIVE_RE.test(word);
}

// "Can you...", "please...", "I'd like...", "let's...": the sentence is itself
// a request, so "I'd like you to answer in Hungarian" counts where "learning to
// write in Hungarian" does not.
function hasRequestFrame(words: string[]): boolean {
	return words.some((word, at) => {
		if (ENGLISH_POLITE_WORDS.has(word) || word === "let's" || word === "lets") {
			return true;
		}
		if (/^(?:can|could|would|will)$/.test(word) && words[at + 1] === "you") {
			return true;
		}
		if (/^(?:want|need|prefer)$/.test(word)) {
			return words[at - 1] === "i" || words[at - 1] === "we";
		}
		return word === "like" && /^(?:would|i'd|id)$/.test(words[at - 1] ?? "");
	});
}

function isRequestAround(words: string[], marker: LanguageMarker): boolean {
	const requestFrame = hasRequestFrame(words);
	const nextToMarker = (set: Set<string>, reach: number) =>
		words
			.slice(Math.max(0, marker.at - reach), marker.end + reach + 1)
			.some((word) => set.has(word));

	// A sentence that is little more than the language word: "In English,
	// please." / "Angolul." / "Nem, angolul!".
	const onlyTheLanguage = words.every(
		(word, at) =>
			(at >= marker.at && at <= marker.end) ||
			BARE_FILLERS.has(word) ||
			ENGLISH_NAMES[word] !== undefined ||
			word === "angolul" ||
			word === "magyarul",
	);
	if (onlyTheLanguage) return true;

	if (marker.kind === "bare") {
		// "Speak Hungarian to me", "Switch to Hungarian", "Let's speak Hungarian",
		// "Can we switch to Hungarian?" — but "Can you speak Hungarian?" asks
		// whether you can, and "I want to learn Hungarian" is not a request.
		const before = words.slice(Math.max(0, marker.at - 4), marker.at);
		const speech = before.some((word) => ENGLISH_SPEECH_VERBS.has(word));
		const asking = words.some(
			(word) =>
				/^(?:we|us|let's|lets)$/.test(word) || ENGLISH_POLITE_WORDS.has(word),
		);
		const first = words.find((word) => !LEADING_FILLERS.has(word));
		if (
			speech &&
			(asking || (first !== undefined && ENGLISH_SPEECH_VERBS.has(first)))
		) {
			return true;
		}
		// "Hungarian please", "English only".
		return (
			/^(?:please|only|title)$/.test(words[marker.at + 1] ?? "") ||
			/^(?:please|only)$/.test(words[marker.at - 1] ?? "")
		);
	}

	// A directive about the reply within a few words either side.
	const first = words.find((word) => !LEADING_FILLERS.has(word));
	const from = Math.max(0, marker.at - 7);
	const to = Math.min(words.length - 1, marker.end + 7);
	for (let at = from; at <= to; at++) {
		if (at >= marker.at && at <= marker.end) continue;
		const word = words[at];
		const previous = words[at - 1];
		if (
			(ENGLISH_DIRECTIVES.has(word) ||
				(ENGLISH_WEAK_DIRECTIVES.has(word) &&
					(word === first || requestFrame))) &&
			// "learning to write in Hungarian", "I write in English at work".
			((previous !== "to" && !ENGLISH_SUBJECTS.has(previous ?? "")) ||
				requestFrame)
		) {
			return true;
		}
		if (isHungarianDirective(word)) return true;
		if (HUNGARIAN_INFINITIVE_RE.test(word)) {
			const modalAsks = words.some(
				(other) =>
					HUNGARIAN_REQUEST_MODALS.has(other) ||
					(other === "tudsz" && HUNGARIAN_ANSWER_INFINITIVE_RE.test(word)),
			);
			if (modalAsks) return true;
		}
	}

	if (marker.kind === "adverb") {
		// "Legyen angolul a válasz", "Lehet angolul?".
		if (nextToMarker(HUNGARIAN_WISH_WORDS, 3)) return true;
		// "Kérlek angolul", "Angolul, légy szíves", "Csak angolul".
		const subjectIsTheLanguage = words.some((word) =>
			HUNGARIAN_SUBJECT_STEM_RE.test(word),
		);
		if (!subjectIsTheLanguage && nextToMarker(HUNGARIAN_POLITE_WORDS, 2)) {
			return true;
		}
	}

	if (marker.kind === "in") {
		// "I want / I'd like / I prefer" it in the language.
		const wants = words.some(
			(word, at) =>
				(/^(?:want|need|prefer)$/.test(word) &&
					/^(?:i|we)$/.test(words[at - 1] ?? "")) ||
				(word === "like" && /^(?:would|i'd|id)$/.test(words[at - 1] ?? "")),
		);
		if (wants) return true;
		// "In English please", "only in Hungarian" — but not "translate it in
		// Hungarian please".
		if (!words.some((word) => word.startsWith("translat"))) {
			if (nextToMarker(ENGLISH_POLITE_WORDS, 1)) return true;
			if (words[marker.at - 1] === "only" || words[marker.end + 1] === "only") {
				return true;
			}
		}
	}
	return false;
}

function requestInSentence(sentence: string): SupportedLanguage | null {
	const words = sentence.match(/[\p{L}\p{N}']+/gu) ?? [];
	const markers = findLanguageMarkers(words);
	if (markers.length === 0) return null;
	const first = words.find((word) => !LEADING_FILLERS.has(word));
	if (first !== undefined && QUESTION_STARTERS.has(first)) return null;
	if (HUNGARIAN_HOW_SAID_RE.test(words.join(" "))) return null;

	let found: SupportedLanguage | null = null;
	for (const marker of markers) {
		if (isRequestAround(words, marker)) found = marker.language;
	}
	return found;
}

/**
 * Whether `text` explicitly asks for the reply in a given language,
 * regardless of what language `text` itself is written in. `null` when no
 * such request is present: a message that only mentions a language ("Hogy
 * mondják angolul, hogy alma?", "How do you say 'apple' in Hungarian?") is not
 * one. When a message asks for both, the latest request wins.
 */
export function detectExplicitLanguageRequest(
	text: string,
): SupportedLanguage | null {
	let result: SupportedLanguage | null = null;
	for (const sentence of foldAccents(text).split(/[.!?;\n]+/)) {
		const found = requestInSentence(sentence);
		if (found) result = found;
	}
	return result;
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
	const rawTokens = stripQuotedSpans(withoutUrls).match(/[\p{L}]+/gu) ?? [];
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
