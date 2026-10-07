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

// --- explicit requests for a language ----------------------------------------
//
// One place decides whether the user explicitly asked for a language ("válaszolj
// angolul", "answer in Hungarian", "írj egy e-mailt angolul"), and for WHAT: the
// reply itself, or a piece of writing the reply holds (ruling 75).
//
//  - A request for the REPLY ("answer in English", "válaszolj angolul", "in
//    English please", "beszéljünk angolul") is the first check
//    `resolveResponseLanguage` makes, so it wins even when the message itself is
//    written in the other language (a Hungarian message ending "...válaszolj
//    angolul"): the whole turn changes language, chips and status line with it.
//  - A request for CONTENT ("Írj egy e-mailt angolul a kollégámnak", "Write an
//    email to my colleague in Hungarian") keeps the conversation in ITS language:
//    only the piece is written in the other one. The turn does not flip;
//    `detectContentLanguageRequest` says which language the piece is in, for the
//    places that write it themselves (an App's UI) and for the line that tells the
//    model the two differ.
//
// A language word is a request only when the person ASKS for something in it. A
// message that merely mentions the language keeps the conversation's: "Hogy
// mondják angolul, hogy alma?" is a Hungarian question about English and its
// answer is Hungarian, "How do you say 'apple' in Hungarian?" is answered in
// English. (The old rule took "angolul" / "in Hungarian" anywhere as a request:
// on the real model that gave an English reply to the first and a Hungarian
// "Az alma." to the second.)
//
// Per sentence, with accents folded (people type "valaszolj angolul"):
//  - a sentence that opens with a question word is a question ABOUT the language
//    (how, what, which; hogy, mit, melyik) and requests nothing;
//  - a REPLY directive (answer, speak, talk, continue, explain, summarize;
//    válaszolj, beszéljünk, folytasd, magyarázd, foglald össze) within seven words
//    of the language word (an instruction that opens the sentence reaches twenty)
//    asks for the reply; so does "please" / "kérlek" / "legyen" / "only" right
//    beside it, and a sentence that is little more than the language word ("In
//    English, please." / "Angolul.");
//  - a CONTENT directive (write, draft, compose, make, give me; írj, fogalmazz,
//    készíts, adj) asks for content: "Write an email in English", "Írj egy
//    e-mailt angolul". It asks for the reply only when there is nothing to write
//    ("Write in English, please", "Írj nekem angolul") or what is to be written is
//    the reply ("Write your answers in Hungarian"). A definite Hungarian form
//    ("Írd angolul") carries its object, so it is content too;
//  - translate / fordítsd asks for content; learn / tanulni, mean / jelent and
//    "can you speak" ask for nothing.
// The latest request of each kind in the message wins.

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

// What a language word was asked for: the reply, or a piece of writing in it.
type RequestKind = "reply" | "content";

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

// A directive in a form that asks for it: an imperative, a polite conditional or
// "may". "válaszolok" (I answer) and "beszélsz" (you speak) are not on the lists.
// A REPLY directive asks for the answer itself; a CONTENT directive asks for a
// piece of writing the reply will hold.
const HUNGARIAN_REPLY_DIRECTIVE_RE =
	/^(?:valaszol(?:j|jal|jad|jon|jatok|junk|hatsz|hatnal|hatnad|nal|nad)|beszel(?:j|jel|jen|junk|nel|hetunk|hetnenk|hetsz|hetnel)|beszelgess(?:unk|en)?|beszelget(?:nel|hetunk|hetnenk|hetsz|hetnel)|folyt(?:as(?:d|s|suk|sunk)|athatjuk|atnal)|magyaraz(?:d|z|zad|zon|hatnad)|foglal(?:d|j|nad|nal)|osszegez(?:d|z|nel)|mesel(?:j|d|nel)|kommunikal(?:j|junk))$/;
const HUNGARIAN_CONTENT_DIRECTIVE_RE =
	/^(?:ir(?:j|jal|jad|jon|d|nal|nad|hatsz|hatnal|hatnad|hatod)|fogalmaz(?:d|z|zad|zon|nal|nad)|keszit(?:s|sd|sen|enel|hetnel)|csinal(?:j|d|jon|nal|nad)|adj|add|adjon|adnal|adnad)$/;
// "Írd angolul", "Fogalmazd meg angolul": the definite form carries its object
// ("write IT in English"), so it is never a bare "write in English".
const HUNGARIAN_DEFINITE_DIRECTIVE_RE =
	/^(?:ird|irjad|irnad|irhatnad|irhatod|fogalmazd|fogalmazzad|fogalmaznad|keszitsd|csinald|add|adnad)$/;
// "Tudnál angolul válaszolni?" / "Angolul szeretnék beszélgetni": an infinitive
// that a polite modal asks for. "Tudsz angolul válaszolni?" asks for the reply
// too; "Tudsz angolul beszélni?" asks whether you speak it.
const HUNGARIAN_REPLY_INFINITIVE_RE =
	/^(?:valaszolni|beszelni|beszelgetni|folytatni|magyarazni|meselni|kommunikalni)$/;
const HUNGARIAN_ANSWER_INFINITIVE_RE =
	/^(?:valaszolni|folytatni|magyarazni|meselni)$/;
const HUNGARIAN_CONTENT_INFINITIVE_RE = /^(?:irni|fogalmazni)$/;
const HUNGARIAN_REQUEST_MODALS = wordSet(
	"tudnal tudnatok tudnank tudunk lehet lehetne szeretnek szeretnem szeretnenk kerlek kerem kernek kernem kellene erdemes szabad segitenel segitenetek segitesz segitsel",
);
const HUNGARIAN_POLITE_WORDS = wordSet(
	"kerlek kerem kernek kernem legy legyel legyen szives szivesen inkabb csak mostantol ezentul most",
);
const HUNGARIAN_WISH_WORDS = wordSet("legyen legyel lehet lehetne");
// Learning, ability, translation and meaning: the language is the subject.
const HUNGARIAN_SUBJECT_STEM_RE =
	/^(?:tanul|megtanul|tanit|gyakorol|tud(?:sz|ok|om|od|ja|nak)?$|beszel(?:sz|ek|nek)$|ert(?:em|ed|esz)?$|ismer|fordit|lefordit|atfordit|jelent)/;
const HUNGARIAN_TRANSLATE_RE = /^(?:fordit|lefordit|atfordit)/;

// Directives that mean it wherever they stand, and ones that are only an
// instruction at the head of a sentence or inside a request ("I give lessons in
// English" is not one).
const ENGLISH_REPLY_DIRECTIVES = wordSet(
	"reply respond answer speak talk chat converse communicate continue explain describe summarize summarise",
);
const ENGLISH_CONTENT_DIRECTIVES = wordSet(
	"write rewrite rephrase draft compose",
);
const ENGLISH_WEAK_REPLY_DIRECTIVES = wordSet("keep stick switch");
const ENGLISH_WEAK_CONTENT_DIRECTIVES = wordSet(
	"redo repeat type give make create build prepare generate produce",
);
// Verbs that take a bare language name ("Speak Hungarian to me", "Switch to
// Hungarian"); the others take "in".
const ENGLISH_SPEECH_VERBS = wordSet(
	"speak talk chat converse communicate continue switch go stick keep use",
);
const ENGLISH_SUBJECTS = wordSet("i we they he she it people students");
// "your reply", "a talk": after one of these an English directive word is a noun.
const ENGLISH_DETERMINERS = wordSet(
	"a an the your my his her our their this that its",
);
// Learning, translation and meaning in English: the language is the subject.
const ENGLISH_SUBJECT_STEM_RE =
	/^(?:learn|study|studying|teach|practi[sc]e|translat|pronounc|spell|grammar|meaning|means?$)/;
const ENGLISH_POLITE_WORDS = wordSet("please pls plz kindly");
const BARE_FILLERS = wordSet(
	"please pls plz only just in the language instead rather better then now and but so ok okay yes no nope sorry oh yeah thanks thank you kerlek kerem kernek legy legyel legyen szives szivesen inkabb csak mostantol ezentul most es de akkor igen nem ne na hat ja nos is",
);
// What a content directive may stand beside and still be a request for the reply:
// "Write in English", "Please write to me in Hungarian from now on", "Írj nekem
// angolul, kérlek". Anything else in the sentence (an e-mail, "this", "a poem")
// is the thing to be written.
const REPLY_SHAPE_WORDS = wordSet(
	"can could would will i we us let's lets i'd id like want need prefer to me my your for from on always going forward a an the all every each any of nekem nekunk mindig minden osszes mind az a egy tudsz tudnal tudnatok tudnank tudunk lehet lehetne szeretnek szeretnem szeretnenk kellene erdemes szabad ezutan segitenel segitenetek segitesz segitsel",
);
// ...and the reply itself is what to write: "Write your answers in Hungarian".
const REPLY_OBJECT_WORDS = wordSet(
	"reply replies answer answers response responses valasz valaszt valaszod valaszodat valaszaid valaszaidat valaszokat",
);
// "I want it in Hungarian" (the reply, as before) versus "I want a cover letter in
// Hungarian" (a letter).
const OBJECT_PRONOUNS = wordSet(
	"it this that these those them everything something anything all",
);

// What may follow "in English" when it names the language the writing is in ("in
// Hungarian to my landlord", "in Hungarian saying I am sick", "in Hungarian
// please"); a noun after it makes the language an adjective ("in Hungarian
// cities", "in English literature"), which is the topic of the writing, not its
// language.
const LANGUAGE_CONTINUERS = wordSet(
	"to for from with about on at by of into and or but so that this these those please pls plz kindly thanks only too also instead just now again then as if when where which who saying says said stating telling asking explaining showing listing describing announcing thanking apologizing apologising confirming inviting requesting reminding wishing congratulating because since while after before until during the a an my our your his her their its it them him me us we you i is are was were be do does did have has had can could would will should shall may might must",
);

// How many words an instruction that opens the sentence reaches.
const HEAD_DIRECTIVE_REACH = 20;

function isLanguageWord(word: string): boolean {
	return (
		ENGLISH_NAMES[word] !== undefined ||
		word === "angolul" ||
		word === "magyarul" ||
		word === "angol" ||
		word === "magyar" ||
		word === "nyelven" ||
		word === "nyelvu"
	);
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

// What the whole sentence says, read once however many language words it holds.
type SentenceContext = {
	first: string | undefined;
	// The index of the sentence's first word that is not a filler.
	firstAt: number;
	// Which colon-separated stretch each word is in: what follows "Írj angolul:"
	// is the thing to answer or write about, not part of the instruction.
	segmentOf: number[];
	requestFrame: boolean;
	asking: boolean;
	// The index of "want / need / prefer / would like", or -1.
	wantAt: number;
	translating: boolean;
	subjectIsTheLanguage: boolean;
	requestModal: boolean;
	abilityModal: boolean;
	// Running counts over the words, so "is everything else a filler" costs the
	// same for every language word however long the sentence is: [i] holds how
	// many of the first i words are NOT of the kind.
	notFillerBefore: number[];
	notShapeBefore: number[];
	notWantFillerBefore: number[];
	replyObjectBefore: number[];
	// The first and last word of each colon-separated stretch.
	segmentStart: number[];
	segmentEnd: number[];
	// The first content directive of the sentence (-1: none), read once on demand.
	firstContentAt?: number;
};

const isFillerWord = (word: string) =>
	BARE_FILLERS.has(word) || isLanguageWord(word);
// What may stand beside a content directive in a request for the reply.
const isShapeWord = (word: string) =>
	isFillerWord(word) ||
	REPLY_SHAPE_WORDS.has(word) ||
	REPLY_OBJECT_WORDS.has(word);
// What may stand between "I want" and the language in a request for the reply.
const isWantFiller = (word: string) =>
	BARE_FILLERS.has(word) ||
	REPLY_SHAPE_WORDS.has(word) ||
	REPLY_OBJECT_WORDS.has(word) ||
	OBJECT_PRONOUNS.has(word);

function countBefore(
	words: string[],
	test: (word: string) => boolean,
): number[] {
	const sums = [0];
	for (const word of words) {
		sums.push(sums[sums.length - 1] + (test(word) ? 1 : 0));
	}
	return sums;
}

// How many of words[from..toExclusive) are counted in `sums`.
function countBetween(sums: number[], from: number, toExclusive: number) {
	return from < toExclusive ? sums[toExclusive] - sums[from] : 0;
}

function readSentence(words: string[], segmentOf: number[]): SentenceContext {
	const firstAt = words.findIndex((word) => !LEADING_FILLERS.has(word));
	return {
		first: words[firstAt],
		firstAt,
		segmentOf,
		requestFrame: hasRequestFrame(words),
		// "Let's...", "Can we...", "please...".
		asking: words.some(
			(word) =>
				/^(?:we|us|let's|lets)$/.test(word) || ENGLISH_POLITE_WORDS.has(word),
		),
		// "I want / I'd like / I prefer" it in the language.
		wantAt: words.findIndex(
			(word, at) =>
				(/^(?:want|need|prefer)$/.test(word) &&
					/^(?:i|we)$/.test(words[at - 1] ?? "")) ||
				(word === "like" && /^(?:would|i'd|id)$/.test(words[at - 1] ?? "")),
		),
		translating: words.some(
			(word) =>
				word.startsWith("translat") || HUNGARIAN_TRANSLATE_RE.test(word),
		),
		subjectIsTheLanguage: words.some(
			(word) =>
				HUNGARIAN_SUBJECT_STEM_RE.test(word) ||
				ENGLISH_SUBJECT_STEM_RE.test(word),
		),
		requestModal: words.some((word) => HUNGARIAN_REQUEST_MODALS.has(word)),
		abilityModal: words.includes("tudsz"),
		notFillerBefore: countBefore(words, (word) => !isFillerWord(word)),
		notShapeBefore: countBefore(words, (word) => !isShapeWord(word)),
		notWantFillerBefore: countBefore(words, (word) => !isWantFiller(word)),
		replyObjectBefore: countBefore(words, (word) =>
			REPLY_OBJECT_WORDS.has(word),
		),
		...segmentBounds(segmentOf),
	};
}

function segmentBounds(segmentOf: number[]) {
	const segmentStart: number[] = [];
	const segmentEnd: number[] = [];
	segmentOf.forEach((segment, at) => {
		segmentStart[segment] ??= at;
		segmentEnd[segment] = at;
	});
	return { segmentStart, segmentEnd };
}

type Directive = { kind: RequestKind; at: number };

// The directive that governs a language word: within seven words either side
// (a reply directive wins over a content one), else one that opens the sentence
// (however far the language word is: "Write a short thank-you email to our
// hosts in English"), else a content directive anywhere before it, so that
// "please" at the end of a long request for a letter cannot turn it into a
// request for the reply. Never when the language is the subject.
function directiveKindAt(
	words: string[],
	at: number,
	sentence: SentenceContext,
): RequestKind | null {
	const word = words[at];
	const previous = words[at - 1];
	const requestFrame = sentence.requestFrame;
	// "learning to write in Hungarian", "I write in English at work".
	const notSubject =
		(previous !== "to" && !ENGLISH_SUBJECTS.has(previous ?? "")) ||
		requestFrame;
	const weak = word === sentence.first || requestFrame;
	const english =
		ENGLISH_REPLY_DIRECTIVES.has(word) ||
		ENGLISH_CONTENT_DIRECTIVES.has(word) ||
		ENGLISH_WEAK_REPLY_DIRECTIVES.has(word) ||
		ENGLISH_WEAK_CONTENT_DIRECTIVES.has(word);
	if (english) {
		// "Write your reply in Hungarian": "reply" there is the thing to write.
		if (ENGLISH_DETERMINERS.has(previous ?? "") || !notSubject) return null;
		if (ENGLISH_REPLY_DIRECTIVES.has(word)) return "reply";
		if (ENGLISH_CONTENT_DIRECTIVES.has(word)) return "content";
		if (!weak) return null;
		return ENGLISH_WEAK_REPLY_DIRECTIVES.has(word) ? "reply" : "content";
	}
	if (HUNGARIAN_REPLY_DIRECTIVE_RE.test(word)) return "reply";
	if (HUNGARIAN_CONTENT_DIRECTIVE_RE.test(word)) return "content";
	if (HUNGARIAN_REPLY_INFINITIVE_RE.test(word)) {
		return sentence.requestModal ||
			(sentence.abilityModal && HUNGARIAN_ANSWER_INFINITIVE_RE.test(word))
			? "reply"
			: null;
	}
	if (HUNGARIAN_CONTENT_INFINITIVE_RE.test(word)) {
		return sentence.requestModal || sentence.abilityModal ? "content" : null;
	}
	return null;
}

// "to learn Hungarian", "amivel angolul tanulhatok": the language is what is
// being learned, practised or translated, within four words of it. (A "tudok"
// ten words away, in "nem tudok bejönni", says nothing about it.)
function languageIsTheSubjectNear(
	words: string[],
	marker: LanguageMarker,
): boolean {
	const to = Math.min(words.length - 1, marker.end + 4);
	for (let at = Math.max(0, marker.at - 4); at <= to; at++) {
		if (
			HUNGARIAN_SUBJECT_STEM_RE.test(words[at]) ||
			ENGLISH_SUBJECT_STEM_RE.test(words[at])
		) {
			return true;
		}
	}
	return false;
}

function findDirective(
	words: string[],
	marker: LanguageMarker,
	sentence: SentenceContext,
): Directive | null {
	const directiveAt = (at: number) => directiveKindAt(words, at, sentence);
	// "Legyen angolul a válasz" asks for the reply, "az e-mail legyen angolul" for
	// the e-mail: the wish word governs a Hungarian adverb right beside it, and what
	// the wish is about decides which.
	const wishAt = (at: number): RequestKind | null => {
		if (
			marker.kind !== "adverb" ||
			sentence.subjectIsTheLanguage ||
			!HUNGARIAN_WISH_WORDS.has(words[at])
		) {
			return null;
		}
		const distance = at < marker.at ? marker.at - at : at - marker.end;
		if (distance > 3) return null;
		return isReplyShape(words, { kind: "content", at }, marker, sentence)
			? "reply"
			: "content";
	};

	const from = Math.max(0, marker.at - 7);
	const to = Math.min(words.length - 1, marker.end + 7);
	let governing: Directive | null = null;
	let best = Number.POSITIVE_INFINITY;
	for (let at = from; at <= to; at++) {
		if (at >= marker.at && at <= marker.end) continue;
		const kind = directiveAt(at) ?? wishAt(at);
		if (kind === null) continue;
		// "an app to learn Hungarian": a lesson in the language, not a piece in it
		// (a translation is both).
		if (
			kind === "content" &&
			!sentence.translating &&
			languageIsTheSubjectNear(words, marker)
		) {
			continue;
		}
		const before = at < marker.at;
		const distance = before ? marker.at - at : at - marker.end;
		// "in English" belongs to the verb phrase before it ("Answer in English and
		// write the email in Hungarian"); a Hungarian adverb sits on either side of
		// its verb, so the nearest one governs it.
		const rank =
			marker.kind === "in" && !before ? distance + words.length : distance;
		if (rank < best) {
			best = rank;
			governing = { kind, at };
		}
	}
	if (governing) return governing;
	if (sentence.subjectIsTheLanguage) return null;

	const headAt = sentence.firstAt;
	if (
		headAt >= 0 &&
		headAt < from &&
		marker.at - headAt <= HEAD_DIRECTIVE_REACH
	) {
		const kind = directiveAt(headAt);
		if (kind) return { kind, at: headAt };
	}
	// Read once per sentence, so a long sentence with many language words stays linear.
	sentence.firstContentAt ??= words.findIndex(
		(_, at) => directiveAt(at) === "content",
	);
	if (sentence.firstContentAt >= 0 && sentence.firstContentAt < from) {
		return { kind: "content", at: sentence.firstContentAt };
	}
	return null;
}

// "Write in English, please" / "Írj nekem angolul" / "Write your answers in
// Hungarian": a content directive with nothing to write but the reply itself.
function isReplyShape(
	words: string[],
	directive: Directive,
	marker: LanguageMarker,
	sentence: SentenceContext,
): boolean {
	const segment = sentence.segmentOf[marker.at];
	const start = sentence.segmentStart[segment];
	const end = sentence.segmentEnd[segment];
	// Everything else in this stretch of the sentence is a filler; the directive's
	// and the language's own words are not "something else".
	let others = countBetween(sentence.notShapeBefore, start, end + 1);
	const own = [directive.at];
	for (let at = marker.at; at <= marker.end; at++) own.push(at);
	for (const at of own) {
		if (at >= start && at <= end && !isShapeWord(words[at])) others--;
	}
	if (others > 0) return false;
	const replyObject =
		countBetween(sentence.replyObjectBefore, start, end + 1) > 0;
	// "Írd angolul" has its object in the verb: only a reply noun makes it the reply.
	return (
		replyObject || !HUNGARIAN_DEFINITE_DIRECTIVE_RE.test(words[directive.at])
	);
}

// "in Hungarian" names the language of a piece of writing unless a noun follows it.
function namesTheLanguageOfTheWriting(
	words: string[],
	marker: LanguageMarker,
	sentence: SentenceContext,
): boolean {
	if (marker.kind !== "in") return true;
	const next = words[marker.end + 1];
	return (
		next === undefined ||
		sentence.segmentOf[marker.end + 1] !== sentence.segmentOf[marker.end] ||
		LANGUAGE_CONTINUERS.has(next)
	);
}

function classifyMarker(
	words: string[],
	marker: LanguageMarker,
	sentence: SentenceContext,
): RequestKind | null {
	const nextToMarker = (set: Set<string>, reach: number) =>
		words
			.slice(Math.max(0, marker.at - reach), marker.end + reach + 1)
			.some((word) => set.has(word));

	// A sentence that is little more than the language word: "In English,
	// please." / "Angolul." / "Nem, angolul!".
	const onlyTheLanguage =
		countBetween(sentence.notFillerBefore, 0, marker.at) +
			countBetween(sentence.notFillerBefore, marker.end + 1, words.length) ===
		0;
	if (onlyTheLanguage) return "reply";

	if (marker.kind === "bare") {
		// "Speak Hungarian to me", "Switch to Hungarian", "Let's speak Hungarian",
		// "Can we switch to Hungarian?" — but "Can you speak Hungarian?" asks
		// whether you can, and "I want to learn Hungarian" is not a request.
		const before = words.slice(Math.max(0, marker.at - 4), marker.at);
		const speech = before.some((word) => ENGLISH_SPEECH_VERBS.has(word));
		const first = sentence.first;
		if (
			speech &&
			(sentence.asking ||
				(first !== undefined && ENGLISH_SPEECH_VERBS.has(first)))
		) {
			return "reply";
		}
		// "Hungarian please", "English only".
		if (
			/^(?:please|only)$/.test(words[marker.at + 1] ?? "") ||
			/^(?:please|only)$/.test(words[marker.at - 1] ?? "")
		) {
			return "reply";
		}
		// "an English title", "Translate this into Hungarian", "Rewrite it to
		// Hungarian": writing in it. A bare name before a noun ("a Hungarian recipe
		// app", "a Hungarian poem") may as well be the topic, so it is not read.
		if (words[marker.at + 1] === "title" || sentence.translating) {
			return "content";
		}
		return /^(?:to|into)$/.test(words[marker.at - 1] ?? "") &&
			findDirective(words, marker, sentence)?.kind === "content"
			? "content"
			: null;
	}

	const directive = findDirective(words, marker, sentence);
	if (directive?.kind === "reply") return "reply";
	if (directive?.kind === "content") {
		if (isReplyShape(words, directive, marker, sentence)) return "reply";
		return namesTheLanguageOfTheWriting(words, marker, sentence)
			? "content"
			: null;
	}
	if (sentence.translating) {
		return namesTheLanguageOfTheWriting(words, marker, sentence)
			? "content"
			: null;
	}
	// "Show me the answer in Hungarian", "a válaszod angolul": the language is
	// the reply's.
	if (REPLY_OBJECT_WORDS.has(words[marker.at - 1] ?? "")) return "reply";

	if (marker.kind === "adverb") {
		// "Kérlek angolul", "Angolul, légy szíves", "Csak angolul".
		if (
			!sentence.subjectIsTheLanguage &&
			nextToMarker(HUNGARIAN_POLITE_WORDS, 2)
		) {
			return "reply";
		}
	}

	if (marker.kind === "in") {
		// "I want it in Hungarian" asks for the reply; "I need a cover letter in
		// Hungarian" asks for a letter.
		if (sentence.wantAt >= 0) {
			return countBetween(
				sentence.notWantFillerBefore,
				sentence.wantAt + 1,
				marker.at,
			) > 0
				? "content"
				: "reply";
		}
		// "In English please", "only in Hungarian".
		if (nextToMarker(ENGLISH_POLITE_WORDS, 1)) return "reply";
		if (words[marker.at - 1] === "only" || words[marker.end + 1] === "only") {
			return "reply";
		}
	}
	return null;
}

type LanguageRequests = {
	reply: SupportedLanguage | null;
	content: SupportedLanguage | null;
};

function requestsInSentence(sentence: string): LanguageRequests {
	const found: LanguageRequests = { reply: null, content: null };
	const tokens = [...sentence.matchAll(/[\p{L}\p{N}']+/gu)];
	const words = tokens.map((token) => token[0]);
	const markers = findLanguageMarkers(words);
	if (markers.length === 0) return found;
	const first = words.find((word) => !LEADING_FILLERS.has(word));
	if (first !== undefined && QUESTION_STARTERS.has(first)) return found;
	if (HUNGARIAN_HOW_SAID_RE.test(words.join(" "))) return found;

	// Which colon-separated stretch each word is in, counted as the words go by.
	let segment = 0;
	let scanned = 0;
	const segmentOf = tokens.map((token) => {
		for (; scanned < token.index; scanned++) {
			if (sentence[scanned] === ":") segment++;
		}
		scanned = token.index + token[0].length;
		return segment;
	});
	const context = readSentence(words, segmentOf);
	for (const marker of markers) {
		const kind = classifyMarker(words, marker, context);
		if (kind) found[kind] = marker.language;
	}
	return found;
}

function readLanguageRequests(text: string): LanguageRequests {
	const found: LanguageRequests = { reply: null, content: null };
	for (const sentence of foldAccents(text).split(/[.!?;\n]+/)) {
		const requests = requestsInSentence(sentence);
		if (requests.reply) found.reply = requests.reply;
		if (requests.content) found.content = requests.content;
	}
	return found;
}

/**
 * Whether `text` explicitly asks for the REPLY in a given language, regardless
 * of what language `text` itself is written in. `null` when no such request is
 * present: a message that only mentions a language ("Hogy mondják angolul, hogy
 * alma?", "How do you say 'apple' in Hungarian?") is not one, and neither is a
 * request for a piece of writing in it ("Írj egy e-mailt angolul a
 * kollégámnak": see `detectContentLanguageRequest`). When a message asks for
 * the reply in both, the latest request wins.
 */
export function detectExplicitLanguageRequest(
	text: string,
): SupportedLanguage | null {
	return readLanguageRequests(text).reply;
}

/**
 * The language a message asks a PIECE OF WRITING to be in ("Írj egy e-mailt
 * angolul a kollégámnak", "Write an email to my colleague in Hungarian", "Make a
 * quiz app in Hungarian", "Translate this into Hungarian"), or `null`. It never
 * changes the language of the turn (ruling 75); it is for what writes the piece
 * itself (an App's labels) and for telling the model the content differs from
 * the reply.
 */
export function detectContentLanguageRequest(
	text: string,
): SupportedLanguage | null {
	return readLanguageRequests(text).content;
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
 *  1. An explicit request for the REPLY in the latest message ("answer in
 *     Hungarian", "válaszolj angolul") always wins, regardless of what
 *     language the message itself is written in. A request for a piece of
 *     writing in a language ("write an email to my colleague in Hungarian",
 *     "írj egy e-mailt angolul") is not one: the conversation keeps its own
 *     language and only the piece is written in the other (ruling 75, see
 *     `detectContentLanguageRequest`).
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
