export type SupportedLanguage = "en" | "hu";

// ──────────────────────────────────────────────────────────────────────────
// Reading the language of a reply (owner decision, 2026-10-13)
//
// No code decides what language a reply is written in before it exists: the
// model reads the person's message and chooses (normal-chat-context.ts's
// REPLY_LANGUAGE_RULE). What the app writes AFTER the reply (the follow-up
// chips, the rail headline, a generated title) follows the reply that was
// written, and for that it reads the reply: one deterministic reader, for
// model-written text only. Model text is clean (no typos, accents in place), so
// a short list of closed-class words per language is enough; the reader never
// guesses on thin evidence.
// ──────────────────────────────────────────────────────────────────────────

/** What the reader names: a language it is sure of, or "unknown". */
export type ReplyLanguage = SupportedLanguage | "unknown";

/** Fewest witnesses the leading language needs before the reader answers. */
const DEFAULT_MIN_WITNESSES = 4;
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
 * (Hungarian speech uses them).
 */
const ENGLISH_WORDS: ReadonlySet<string> = new Set(
	`the this that these those some any each every either neither another other
	such much many more few several both all
	you he she it we they me him her us them my your his its our their mine
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
 * (English "IDE"), "hat" (English "hat"), "ti" (English "Ti"), "ma" and "ok".
 * "íme" ("here is", how a reply introduces what was asked for) is in.
 */
const HUNGARIAN_WORDS: ReadonlySet<string> = new Set(
	`és hogy nem egy ez ezt ezek ezen ezzel ebben erre ennek azt azok azon azzal
	abban arra annak akkor amikor amíg ahol ahogy ami amit amely amelyek aki
	akik akit mivel mert vagy pedig viszont azonban illetve valamint tehát
	ezért így úgy csak sem igen nincs nincsenek vannak vagyok vagyunk vagytok
	lehet lehetne kell kellene tud tudok tudsz tudunk fogok lesz lenne
	legyen volna lett már majd talán esetleg minden mindig soha néha néhány
	több kevés sok nagyon elég túl ilyen olyan milyen melyik hogyan miért
	mikor hol hová honnan merre kik miben mire oda itt ott innen onnan
	után előtt között alatt felett fölött mellett mögött szerint miatt helyett
	nélkül által számára részére iránt felé felől óta múlva közben kívül belül
	nekem neked neki nekünk nektek nekik velem veled vele velünk tőlem tőled
	tőle hozzám hozzád hozzá rólam rólad róla rám rád én ő ők ön önök magam
	magad magát egyik másik mindegyik valamelyik valami valaki semmi senki
	bármi bárki bármely szinte körülbelül például azaz vagyis stb kérem kérlek
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
 * "ő" -> "o", "én" -> "en", "ők" -> "ok", "ön" -> "on", "át" -> "at".
 */
const FOLD_COLLISIONS: ReadonlySet<string> = new Set(["en", "ok", "on", "at"]);

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
 * text; the person's own typing is not what it is for.
 *
 * Names, places and loanwords decide nothing ("Győr", "Magyar", "café"): only
 * function words count, and the ones both languages use are not on the lists.
 * `minWitnesses` lowers the bar for a text that is short by nature (a board
 * note, a title): the same lists and the same three-to-one lead, with fewer
 * words to go on, so it names the other language only when it is plain.
 */
export function readReplyLanguage(
	text: string,
	options: { minWitnesses?: number } = {},
): ReplyLanguage {
	return decide(
		countWitnesses(stripNonProse(text)),
		options.minWitnesses ?? DEFAULT_MIN_WITNESSES,
	);
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
	const reply = decide(counts, DEFAULT_MIN_WITNESSES);
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
