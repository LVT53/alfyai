export type SupportedLanguage = "en" | "hu";

// ──────────────────────────────────────────────────────────────────────────
// Reading the language of model-written text (owner decision, 2026-10-13)
//
// No code decides what language a reply is written in before it exists: the
// model reads the person's message and chooses (normal-chat-context.ts's
// REPLY_LANGUAGE_RULE). What the app writes AFTER the reply (the follow-up
// chips, the rail headline, a generated title) is in the language of the
// conversation for the person, which the model names too, in one small call
// (chat-turn/conversation-language.ts). These readers are what is left of
// reading a language in code, for model-written text only: the fallback when
// that call does not answer (`afterReplyLanguage`), the record of what a reply's
// own words say (`readReplyLanguage`), and the check that drops a title or a
// headline written in the other language than asked for (`readShortTextLanguage`).
// Model text is clean (no typos, accents in place), so a short list of
// closed-class words per language is enough; the readers never guess on thin
// evidence.
// ──────────────────────────────────────────────────────────────────────────

/** What the reader names: a language it is sure of, or "unknown". */
export type ReplyLanguage = SupportedLanguage | "unknown";

/** Fewest witnesses the leading language needs before the reader answers. */
const MIN_WITNESSES = 4;
/** The leading language needs this many times the other's witnesses. */
const LEAD_FACTOR = 3;

/**
 * English closed-class words (articles, pronouns, prepositions, conjunctions,
 * auxiliaries, a few adverbs). They are the witnesses for English. The list
 * leaves out every word that is also an everyday Hungarian word, because such a
 * word proves nothing: "a" and "az" (the Hungarian articles; also "AZ" and the
 * `az` CLI), "is" and "be" (Hungarian "also" and "in"), "de" ("but"), "ha"
 * ("if"; also English "Ha!"), "van" and "volt" (Hungarian "is" and "was";
 * English "a van", "12 volt"), "mi" and "ki" ("what", "who"), "el" and "le"
 * (verb prefixes), "meg" ("and", "still"; also the name Meg), "to" is kept (the
 * Hungarian "tó", a lake, is rare in a reply) but "at" is not (the unaccented
 * Hungarian "át"), "most" is not (Hungarian "now"), and "no" and "hi" are not
 * (Hungarian speech uses them). "I" and "an" are in: neither is a Hungarian
 * word, and "I need ..." is the commonest way to begin.
 */
const ENGLISH_WORDS: ReadonlySet<string> = new Set(
	`the this that these those some any each every either neither another other
	such much many more few several both all
	i an you he she it we they me him her us them my your his its our their mine
	yours hers ours theirs myself yourself himself herself itself ourselves
	themselves who whom whose which what whatever whichever there here
	of to in on by for with from about into over after before between through
	during without within under above below against among around near off out
	up down than then until while since because although though unless whether
	if or and but nor so yet as like
	am are was were been being have has had having do does did done doing will
	would shall should can could may might must ought
	not yes very just also only even still already always never often sometimes
	usually really quite rather too again ever once now how when where why
	however therefore instead otherwise anyway maybe perhaps please thanks thank
	sorry sure great`
		.split(/\s+/)
		.filter(Boolean),
);

/**
 * Hungarian closed-class words, with their accents, and the same homograph
 * rule: nothing here is also an everyday English word. Left out on purpose:
 * "a", "az", "is", "be", "de", "ha", "van", "volt", "mi", "ki", "el", "le",
 * "meg" (see ENGLISH_WORDS), "most" and "mint" (English "most", "mint"), "fog"
 * (English "fog"), "mit" (English "MIT", the university and the licence), "ide"
 * (English "IDE"), "hat" (English "hat"), "ti" (English "Ti", the TI-84), "ma"
 * and "ok", and the ones English text uses as an acronym or a name: "sem" (SEM),
 * "ott" (OTT), "stb" (STB), "mire" and "kik" (the app). "íme" ("here is", how a
 * reply introduces what was asked for) is in.
 */
const HUNGARIAN_WORDS: ReadonlySet<string> = new Set(
	`és hogy nem egy ez ezt ezek ezen ezzel ebben erre ennek azt azok azon azzal
	abban arra annak akkor amikor amíg ahol ahogy ami amit amely amelyek aki
	akik akit mivel mert vagy pedig viszont azonban illetve valamint tehát
	ezért így úgy csak igen nincs nincsenek vannak vagyok vagyunk vagytok
	lehet lehetne kell kellene tud tudok tudsz tudunk fogok lesz lenne
	legyen volna lett már majd talán esetleg minden mindig soha néha néhány
	több kevés sok nagyon elég túl ilyen olyan milyen melyik hogyan miért
	mikor hol hová honnan merre miben oda itt innen onnan
	után előtt között alatt felett fölött mellett mögött szerint miatt helyett
	nélkül által számára részére iránt felé felől óta múlva közben kívül belül
	nekem neked neki nekünk nektek nekik velem veled vele velünk tőlem tőled
	tőle hozzám hozzád hozzá rólam rólad róla rám rád én ő ők ön önök magam
	magad magát egyik másik mindegyik valamelyik valami valaki semmi senki
	bármi bárki bármely szinte körülbelül például azaz vagyis kérem kérlek
	köszönöm szívesen természetesen persze íme szia üdv először másodszor
	végül később korábban ezután azután eddig addig tegnap holnap hanem
	ugyanis továbbá egyébként ráadásul ezenkívül vajon ugye érdemes`
		.split(/\s+/)
		.filter(Boolean),
);

/** Strips the accents off a word: "érdemes" -> "erdemes". */
function foldAccents(word: string): string {
	return word.normalize("NFD").replace(/\p{M}+/gu, "");
}

/**
 * Folded forms that are English words, or too short to mean anything, so an
 * unaccented Hungarian word never counts as a witness when it spells one:
 * "ő" -> "o", "én" -> "en", "ők" -> "ok", "ön" -> "on", "át" -> "at", and the
 * longer ones English text uses as a word, an acronym or a first name: "rám" ->
 * "ram" (RAM), "már" -> "mar" (Mar 2024), "rád" -> "rad", "óta" -> "ota" (OTA
 * updates), "íme" -> "ime" (IME), "néha" -> "neha", "kérem" -> "kerem", "róla"
 * -> "rola".
 */
const FOLD_COLLISIONS: ReadonlySet<string> = new Set([
	"en",
	"ok",
	"on",
	"at",
	"ram",
	"mar",
	"rad",
	"ota",
	"ime",
	"neha",
	"kerem",
	"rola",
]);

/**
 * Hungarian typed without accents ("kerlek", "koszonom", "elott") is still
 * Hungarian: the accented words fold to a second set, minus the collisions above.
 */
const HUNGARIAN_UNACCENTED_WORDS: ReadonlySet<string> = new Set(
	[...HUNGARIAN_WORDS]
		.filter((word) => foldAccents(word) !== word)
		.map(foldAccents)
		.filter(
			(folded) =>
				folded.length > 2 &&
				!ENGLISH_WORDS.has(folded) &&
				!FOLD_COLLISIONS.has(folded) &&
				!HUNGARIAN_WORDS.has(folded),
		),
);

/** "don't", "it's", "we're", "I'll": English spelling; Hungarian has none of it. */
const ENGLISH_CONTRACTION = /^\p{L}+['’](?:t|s|re|ll|ve|d|m)$/u;

const WORD = /\p{L}+(?:['’]\p{L}+)*/gu;

/**
 * The reader looks at this many characters of a text and no more: a language
 * needs a few dozen words, and a reply can be a blob.
 */
const MAX_READ_CHARS = 100_000;

/**
 * What the reader does not count: code (fenced or inline), addresses, and
 * quoted lines. A reply that quotes someone, or shows a command, is not written
 * in the language of the quote or the command.
 *
 * This runs on the server's one thread over text a model wrote, sometimes from
 * a page a stranger wrote, so no pattern here may backtrack over a long run of
 * non-space characters: `\S+@\S+\.\S+` took 1.4 s on 40 000 letters in a row
 * and `\]\([^)\s]*\)` 1.9 s on 20 000 "](". The address and link patterns cap
 * the run they look at, the text is cut to MAX_READ_CHARS first, and
 * language.test.ts holds the cost on hostile input.
 */
function stripNonProse(text: string): string {
	return text
		.slice(0, MAX_READ_CHARS)
		.normalize("NFC")
		.replace(/(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(\n[ \t]*\2[^\n]*|$)/g, "$1")
		.replace(/(^|\n)[ \t]*(```|~~~)[\s\S]*$/g, "$1")
		.replace(/``[^`]*``|`[^`\n]*`/g, " ")
		.replace(/\]\([^)\s]{0,512}\)/g, "]")
		.replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ")
		.replace(/[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63})+/g, " ")
		.split("\n")
		.filter((line) => !/^\s*>/.test(line))
		.join("\n");
}

type WitnessCounts = { en: number; hu: number };

function countWitnesses(prose: string): WitnessCounts {
	const counts: WitnessCounts = { en: 0, hu: 0 };
	for (const match of prose.toLowerCase().matchAll(WORD)) {
		const word = match[0];
		if (word.includes("'") || word.includes("’")) {
			if (ENGLISH_CONTRACTION.test(word)) counts.en += 1;
			continue;
		}
		if (ENGLISH_WORDS.has(word)) counts.en += 1;
		else if (HUNGARIAN_WORDS.has(word)) counts.hu += 1;
		else if (HUNGARIAN_UNACCENTED_WORDS.has(word)) counts.hu += 1;
	}
	return counts;
}

function decide(counts: WitnessCounts, minWitnesses: number): ReplyLanguage {
	if (counts.en >= minWitnesses && counts.en >= LEAD_FACTOR * counts.hu)
		return "en";
	if (counts.hu >= minWitnesses && counts.hu >= LEAD_FACTOR * counts.en)
		return "hu";
	return "unknown";
}

/**
 * The language a text is written in, read from its words: "en" or "hu" when at
 * least four closed-class words of one language lead the other's three to one,
 * else "unknown" (a short text, code, a list of names, a mix). For model-written
 * text of some length (a reply); the person's own typing is not what it is for,
 * and a title or a headline is `readShortTextLanguage`'s.
 *
 * Names, places and loanwords decide nothing ("Győr", "Magyar", "café"): only
 * function words count, and the ones both languages use are not on the lists.
 */
export function readReplyLanguage(text: string): ReplyLanguage {
	return decide(countWitnesses(stripNonProse(text)), MIN_WITNESSES);
}

/**
 * The accents Hungarian has and English text does not, apart from the words it
 * borrows. A lowercase letter of it in a word is spelling evidence.
 */
const HUNGARIAN_ACCENT = /[áéíóöőúüű]/gu;

/**
 * Words English text borrows with Hungarian-looking accents (a dish, a school,
 * a city, a name): their spelling says nothing about Hungarian.
 */
const BORROWED_ACCENTED_WORDS: ReadonlySet<string> = new Set(
	`résumé résumés protégé protégée soufflé pokémon beyoncé naïveté schrödinger
	düsseldorf göteborg münchen reykjavík göttingen`
		.split(/\s+/)
		.filter(Boolean),
);

/**
 * A word spelt the way Hungarian words are and no English word is: two accented
 * letters, or one in a word of seven letters or more ("Albérletkeresés",
 * "kiválasztása", "Késés"), unless English borrows it. A short name or place
 * with one accent ("Győr", "Bartók", "Zürich", "Pécs") is not.
 */
function isHungarianSpelled(word: string): boolean {
	const bare = word.replace(/['’]s$/u, "");
	if (BORROWED_ACCENTED_WORDS.has(bare)) return false;
	const accents = bare.match(HUNGARIAN_ACCENT)?.length ?? 0;
	return accents >= 2 || (accents === 1 && [...bare].length >= 7);
}

/**
 * The language of a title, a headline or a status line: a line of content words,
 * where a reply's four closed-class words never come. Hungarian is named from two
 * witnesses, a closed-class word or a word spelt the Hungarian way (above), with
 * the usual three-to-one lead; English from one closed-class word and nothing
 * Hungarian in the line, or from two with the lead. A single Hungarian-spelt word
 * (a city, a surname) or a line of English content words says nothing: "unknown".
 *
 * It is the check that drops a line written in the other language than the one
 * asked for, and it errs toward keeping a line: the homographs ("van", "volt",
 * "mit") are on neither list, so "Van Gogh Biography" and "Chevy Volt Review"
 * pass, and so do "Zürich weekend" and "Béla Bartók biography".
 */
export function readShortTextLanguage(text: string): ReplyLanguage {
	const prose = stripNonProse(text);
	const counts = countWitnesses(prose);
	let spelled = 0;
	for (const match of prose.toLowerCase().matchAll(WORD)) {
		if (isHungarianSpelled(match[0])) spelled += 1;
	}
	const hu = counts.hu + spelled;
	const en = counts.en;
	if (hu >= 2 && hu >= LEAD_FACTOR * en) return "hu";
	if (en >= 1 && hu === 0) return "en";
	if (en >= 2 && en >= LEAD_FACTOR * hu) return "en";
	return "unknown";
}

/**
 * The deterministic fallback for the language of what the app writes after a
 * reply (chips, rail headline, title), for a turn whose model call did not name
 * it (chat-turn/conversation-language.ts asks the model first, because a reader
 * of the reply cannot tell a requested piece, a pasted text and an explicit
 * request for another language from the person's own). In this order:
 *
 *  1. The person's message (P), when the reader can name it and either the reply
 *     says nothing (R is "unknown": code, a table, a bare piece of writing too
 *     short to name) or it differs from R and the reply still holds at least two
 *     of P's closed-class words (a requested piece in the other language: the
 *     whole reply may read as the piece's language, but the assistant's own words
 *     around it are in the person's).
 *  2. Else the reply's own words (R).
 *  3. Else the language stored on the conversation's previous reply.
 *  4. Else the account's UI language, and English if there is none.
 *
 * A user's message is mostly too short for the reader to name (it needs four
 * closed-class words), so step 1 fires mainly for messages with a full sentence
 * in them; a short request for a piece in another language, answered by the piece
 * alone, reads as the piece's language here. That is the reason the model is asked.
 */
export function afterReplyLanguage(params: {
	reply: string;
	latestUserMessage?: string;
	previous?: SupportedLanguage | null;
	uiLanguage?: SupportedLanguage | null;
}): SupportedLanguage {
	const counts = countWitnesses(stripNonProse(params.reply));
	const reply = decide(counts, MIN_WITNESSES);
	const message = params.latestUserMessage
		? readReplyLanguage(params.latestUserMessage.slice(0, 2_000))
		: "unknown";

	if (
		message !== "unknown" &&
		(reply === "unknown" || (message !== reply && counts[message] >= 2))
	) {
		return message;
	}
	if (reply !== "unknown") return reply;
	return params.previous ?? params.uiLanguage ?? "en";
}
