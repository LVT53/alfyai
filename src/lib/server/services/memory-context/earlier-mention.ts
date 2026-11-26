import { foldForSearch } from "$lib/shared/workspace-search-text";

/**
 * Whether a person's message mentions a Memory entry: the word half of the
 * gate an Earlier entry passes, besides its rank, to join a turn (spec:
 * Earlier things come back "only when mentioned"). A turn judges by the
 * reranker's score first (`earlier-rerank.ts`) and asks this rule as the second
 * voice for a lower score; with no score this rule decides alone. Hindsight's
 * recall gives no relevance score at the pin, and part 2 measured that rank
 * alone puts a temporary entry in a small bank's top three for 9 of 10
 * unrelated messages, so the mention is read from the words: the message mentions the entry when the words they
 * share weigh as much as one rare word of the person's bank. A word weighs
 * one unless many of the bank's entries hold it (`mentionBank`): one held by
 * more than two of them and more than a tenth weighs less, in proportion, so
 * the name of someone in half the entries makes no mention alone, and two
 * such words together can. Folding is Workspace Search's
 * (`foldForSearch`): case and accent marks drop, so "Pecsre" meets "Pécsre".
 * Words under three letters, bare numbers and stop words (English and
 * Hungarian: function words, small talk, requests, time words with the months
 * and the days of the week, the everyday words for work, play, projects,
 * plans and interest, and the entries' own "the user" and "a felhasználó") do
 * not count.
 * Inflected words match by their stem (see `sameWord`): "Budapesten" meets
 * "Budapest", "exams" meets "exam", "záróvizsgám" meets "záróvizsgája". It
 * reads no model and no score, and a message in one language rarely mentions
 * an entry written in the other except by a shared name; the
 * `memory_context` tool, which ranks by meaning, still returns Earlier entries
 * wherever they rank. `message` is the person's message as written (never the
 * chat's title, which only helps the search) or its words as `mentionWords`
 * read them, so that a recall reads a message once however many entries it
 * checks. Without a `bank`, every shared word weighs one.
 */
export function mentionsMemoryEntry(
	message: string | readonly string[],
	entryText: string,
	bank?: MentionBank,
): boolean {
	const entryWords = mentionWords(entryText);
	if (!entryWords.length) return false;
	const messageWords =
		typeof message === "string" ? mentionWords(message) : message;
	let weight = 0;
	for (const word of entryWords) {
		if (!messageWords.some((other) => sameWord(word, other))) continue;
		weight += bank ? bank.weight(word) : 1;
		if (weight >= 1 - WEIGHT_SLACK) return true;
	}
	return false;
}

/** How much a word of one bank's entries weighs in a mention, read once per recall. */
export interface MentionBank {
	weight(word: string): number;
}

/**
 * One bank's words, from the texts of its entries (every entry the person
 * sees, Earlier ones included): a word one or two entries hold, or at most a
 * tenth of them, weighs one; a word more of them hold weighs that many
 * divided by how many hold it. Words are found by their first four letters,
 * which any two words that are one word share.
 */
export function mentionBank(entryTexts: readonly string[]): MentionBank {
	const byKey = new Map<string, Map<string, Set<number>>>();
	for (const [entry, text] of entryTexts.entries())
		for (const word of mentionWords(text)) {
			const key = wordKey(word);
			let words = byKey.get(key);
			if (!words) {
				words = new Map();
				byKey.set(key, words);
			}
			let holders = words.get(word);
			if (!holders) {
				holders = new Set();
				words.set(word, holders);
			}
			holders.add(entry);
		}
	const rare = Math.max(RARE_ENTRIES, entryTexts.length * RARE_SHARE);
	const weights = new Map<string, number>();
	return {
		weight(word) {
			const known = weights.get(word);
			if (known !== undefined) return known;
			const holders = new Set<number>();
			for (const [other, entries] of byKey.get(wordKey(word)) ?? [])
				if (sameWord(word, other))
					for (const entry of entries) holders.add(entry);
			const weight = Math.min(1, rare / Math.max(1, holders.size));
			weights.set(word, weight);
			return weight;
		},
	};
}

/**
 * The significant words of a text, folded, in order, each once. A long text
 * is read at its start and its end only (`MENTION_HEAD_CHARS`,
 * `MENTION_TAIL_CHARS`): what a person says about their own life sits around
 * what they paste, and the gate runs on every turn's path. A recall reads its
 * message's words once and checks each Earlier entry against them.
 */
export function mentionWords(text: string): string[] {
	const words = new Set<string>();
	for (const word of foldForSearch(
		clipMentionText(text).normalize("NFC"),
	).split(NON_WORD)) {
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

/**
 * A long text as the gate reads it: its first 4,000 and last 2,000
 * characters, a space between. A text of 6,000 characters or fewer is read
 * whole. The word rule and the reranker check (`earlier-rerank.ts`) both read
 * a message through this, so they judge the same words.
 */
export function clipMentionText(text: string): string {
	return text.length > MENTION_HEAD_CHARS + MENTION_TAIL_CHARS
		? `${text.slice(0, MENTION_HEAD_CHARS)} ${text.slice(-MENTION_TAIL_CHARS)}`
		: text;
}
const MIN_WORD_LETTERS = 3;
/** A word this many entries hold is still rare, however small the bank... */
const RARE_ENTRIES = 2;
/** ...and so is one this share of the bank's entries holds. */
const RARE_SHARE = 0.1;
/** Weights are fractions: two halves make one. */
const WEIGHT_SLACK = 1e-9;
const NON_WORD = /[^\p{L}\p{N}]+/u;
const LETTER = /\p{L}/u;

/** Two words that are one word share their first four letters (or are equal). */
function wordKey(word: string): string {
	return word.slice(0, 4);
}

/**
 * Equal, or one word inflected: the two share a stem of at least four
 * letters from the start, and neither goes on past it by more than two
 * letters ("exam" and "exams", "kertbe" and "kertet"), or by more than three
 * from a stem of five or more ("budapest" and "budapesten", "gipszet" and
 * "gipszben", "zarovizsgam" and "zarovizsgaja"). Words that only begin alike
 * go on too long past their shared letters to match: "exam" and "example",
 * "interest" and "interview", "kerul" and "keruletbe".
 */
function sameWord(a: string, b: string): boolean {
	if (a === b) return true;
	const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
	let shared = 0;
	while (shared < shorter.length && shorter[shared] === longer[shared])
		shared++;
	// The longer word's ending is the longer of the two.
	const ending = longer.length - shared;
	return (shared >= 5 && ending <= 3) || (shared >= 4 && ending <= 2);
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
	"couple several bit weekday weekdays weeknight weeknights weekly daily monthly yearly",
	"hour hours minute minutes",
	"jan feb mar apr jun jul aug sep sept oct nov dec mon tue tues wed thu thur thurs fri sat sun",
	// English: the everyday words for work, play, projects, plans and interest.
	"work works working worked play plays playing played project projects",
	"plan plans planning planned",
	"interesting interested interestingly",
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
	"második harmadik fél pár néhány heti hétig hetente napi naponta havi havonta évente",
	"óra órát órán órás órája perc percet percig",
	// Hungarian: the everyday words for work, play, projects, plans and interest.
	"játszik játszom játszol játszunk játszanak játszani játszott játszottam játszottunk",
	"dolgozik dolgozom dolgozol dolgozunk dolgoztok dolgoznak dolgozni dolgoznom dolgoznod",
	"dolgoznia dolgoznunk dolgoznotok dolgozniuk dolgozott dolgoztam dolgoztál dolgoztunk",
	"dolgoztatok dolgoztak dolgozna dolgoznék dolgoznál dolgoznánk dolgoznának dolgozz",
	"terv tervem terved terve tervünk tervetek tervük tervet tervek terveim terveid tervei",
	"tervez tervezek tervezel tervezünk terveztek terveznek tervezem tervezed tervezi tervezzük",
	"tervezitek tervezik tervezni terveznem tervezett terveztem tervezted tervezte terveztük",
	"tervezték érdekes érdekel érdekelne érdekelt érdekli érdekelnek",
];
const STOP_WORDS = new Set(
	STOP_WORD_LIST.join(" ")
		.split(" ")
		.map((word) => foldForSearch(word)),
);
/**
 * Every inflection of these stems, too: how Hindsight's entries name the
 * person; the months and the days of the week in both languages (folded:
 * "márciusban", "Fridays", "pénteken"); work and projects in Hungarian
 * ("munkámhoz", "projektemet").
 */
const STOP_STEMS = [
	"felhasznal",
	...[
		"januar februar march april june july august september october november december",
		"monday tuesday wednesday thursday friday saturday sunday",
		"marcius aprilis majus junius julius augusztus szeptember oktober",
		"hetfo kedd szerda csutortok pentek szombat vasarnap hetkoznap",
		"munka projekt",
	]
		.join(" ")
		.split(" "),
];
