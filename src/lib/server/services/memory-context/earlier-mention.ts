import { foldForSearch } from "$lib/shared/workspace-search-text";

/**
 * Whether a person's message mentions a Memory entry: the gate an Earlier
 * entry passes, besides its rank, to join a turn (spec: Earlier things come
 * back "only when mentioned"). Hindsight's recall gives no relevance score at
 * the pin, and part 2 measured that rank alone puts a temporary entry in a
 * small bank's top three for 9 of 10 unrelated messages, so the mention is
 * read from the words: the message mentions the entry when they share a
 * significant word. Folding is Workspace Search's (`foldForSearch`): case and
 * accent marks drop, so "Pecsre" meets "Pécsre". Words under three letters,
 * bare numbers and stop words (English and Hungarian, among them the entries'
 * own "the user" and "a felhasználó") do not count. Inflected words match by
 * their stem: "Budapesten" meets "Budapest", and "záróvizsgám" meets
 * "záróvizsgája" (see `sameWord`). It reads no model and no score, and a
 * message in one language rarely mentions an entry written in the other
 * except by a shared name; the `memory_context` tool, which ranks by meaning,
 * still returns Earlier entries wherever they rank. `message` is the message
 * itself or its words as `mentionWords` read them, so that a recall reads a
 * message once however many entries it checks.
 */
export function mentionsMemoryEntry(
	message: string | readonly string[],
	entryText: string,
): boolean {
	const entryWords = mentionWords(entryText);
	if (!entryWords.length) return false;
	const messageWords =
		typeof message === "string" ? mentionWords(message) : message;
	return messageWords.some((word) =>
		entryWords.some((other) => sameWord(word, other)),
	);
}

/**
 * The significant words of a text, folded, in order, each once. A long text
 * is read at its start and its end only (`MENTION_HEAD_CHARS`,
 * `MENTION_TAIL_CHARS`): what a person says about their own life sits around
 * what they paste, and the gate runs on every turn's path. A recall reads its
 * message's words once and checks each Earlier entry against them.
 */
export function mentionWords(text: string): string[] {
	const read =
		text.length > MENTION_HEAD_CHARS + MENTION_TAIL_CHARS
			? `${text.slice(0, MENTION_HEAD_CHARS)} ${text.slice(-MENTION_TAIL_CHARS)}`
			: text;
	const words = new Set<string>();
	for (const word of foldForSearch(read.normalize("NFC")).split(NON_WORD)) {
		if (
			Array.from(word).length < MIN_WORD_LETTERS ||
			!LETTER.test(word) ||
			STOP_WORDS.has(word) ||
			STOP_STEMS.some((stem) => word.startsWith(stem))
		)
			continue;
		words.add(word);
	}
	return [...words];
}

/** How much of a long text's start and end the gate reads. */
const MENTION_HEAD_CHARS = 4_000;
const MENTION_TAIL_CHARS = 2_000;
const MIN_WORD_LETTERS = 3;
/** Two words share at least this many letters from the start to be one word inflected. */
const MIN_STEM_LETTERS = 5;
/** And neither goes on past the shared letters by more than this, unless one is the other's start. */
const MAX_ENDING_LETTERS = 3;
const NON_WORD = /[^\p{L}\p{N}]+/u;
const LETTER = /\p{L}/u;

/**
 * Equal, or one word inflected (one is the other's start, at least five
 * letters long: "budapest" and "budapesten"), or both inflected from one stem
 * of at least five letters, each with a short ending ("zarovizsgam" and
 * "zarovizsgaja"). Words that only begin alike ("interest" and "interview")
 * go on too long past their shared letters to match.
 */
function sameWord(a: string, b: string): boolean {
	if (a === b) return true;
	const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
	if (shorter.length >= MIN_STEM_LETTERS && longer.startsWith(shorter))
		return true;
	let shared = 0;
	while (shared < shorter.length && shorter[shared] === longer[shared])
		shared++;
	return (
		shared >= MIN_STEM_LETTERS &&
		longer.length - shared <= MAX_ENDING_LETTERS &&
		shorter.length - shared <= MAX_ENDING_LETTERS
	);
}

/** Words that never make a mention, as written; folded below. */
const STOP_WORD_LIST = [
	// English: function words, small talk, requests to the assistant, time and number words.
	"the and for are but not nor you your yours yourself all any can could had has have having",
	"her hers him his how its was were one our ours out she they them their theirs this that",
	"these those then than there here with without what when where which while who whom whose",
	"why will would should shall may might must about above after again against also because",
	"been before being below between both did does doing done down during each few from further",
	"into onto upon within just more most much many now off once only other over own same some",
	"such too under until very yes okay sure please thanks thank hello hey help helps helped",
	"want wants wanted need needs needed know knows think tell told make made get got gets",
	"getting give gave take took like likes liked let lets see say said says use used way well",
	"really maybe still even ever every something anything nothing everything someone anyone",
	"thing things lot lots little good great nice new old last next first second third",
	"don didn doesn isn aren wasn weren won wouldn couldn shouldn haven hasn hadn can cannot",
	"able going come came goes went put keep kept try tried look looks find found feel felt",
	"write explain translate summarise summarize list show create describe compare convert",
	"calculate check fix draft suggest recommend answer question questions idea ideas",
	"user users today tomorrow yesterday tonight week weeks weekend month months year years",
	"day days time times morning evening night afternoon noon soon ago back per via yet",
	"two three four five six seven eight nine ten eleven twelve twenty hundred thousand half",
	"couple several",
	// Hungarian: function words, small talk, requests, time and number words.
	"és hogy nem egy meg van volt lesz lett mint már még csak mert vagy kell kellett kellene kéne",
	"lehet ezt azt ami amit aki akit amely akkor most itt ott nagyon minden semmi valami valaki",
	"mit hol mikor miért hogyan igen köszönöm köszi kérlek kérem szia helló szeretnék szeretném",
	"tudnál tudnád tudod segíts segítesz segítenél segített segítség ezek azok ennek annak neki",
	"nekem neked nekünk nektek nekik engem téged minket nála nálam velem veled vele rám róla tőle",
	"tőlem magam magad maga saját sok sokat kicsit kis nagy jól rossz szép szépen régi első",
	"utolsó következő múlt múlva óta alatt után előtt között felé mellett nélkül szerint miatt",
	"helyett által iránt keresztül holnap tegnap hét héten hétvége hétvégén hónap hónapban",
	"évben nap napja napig idő időben reggel este délután délelőtt éjjel éjszaka délig dél",
	"mindig soha néha megint újra ismét végre végül talán persze biztos tényleg sem pedig",
	"viszont tehát ugyanis illetve hanem mind milyen melyik mennyi hány honnan hová hova ilyen",
	"olyan így úgy akár kérdés volna lenne legyen vagyok vagyunk vannak voltam voltál voltunk",
	"voltak leszek lesznek írj írd adj mondd mondj magyarázd fordítsd foglald összefoglalnád",
	"elmagyaráznád akarok akarom kettő két három négy hat nyolc kilenc tíz húsz száz ezer",
	"második harmadik fél pár néhány",
];
const STOP_WORDS = new Set(
	STOP_WORD_LIST.join(" ")
		.split(" ")
		.map((word) => foldForSearch(word)),
);
/** Every inflection of these stems, too: how Hindsight's entries name the person. */
const STOP_STEMS = ["felhasznal"];
