/**
 * Read aloud's own language detector: the one exception to "no second reader"
 * (`src/lib/server/services/chat-turn/AGENTS.md`, after I4). It names each
 * paragraph's language only to pick a read-aloud voice and the speech
 * service's text rules, and to name a language that has no voice. Nothing the
 * chat decides reads it.
 *
 * tinyld (MIT) names 62 languages. Its browser build is an ES module of about
 * 800 kB, so it is imported lazily and never sits in the chat's first paint
 * (`check:artifact-chunks --chat-forbid tinyld`).
 */

/** A paragraph with fewer letters than this is not detected on its own: tinyld misreads single words. */
export const SHORT_PARAGRAPH_LETTERS = 40;

/** The detector: an ISO 639-1 code, or "" when it cannot tell; `only` limits it to those languages. */
export type Detect = (text: string, only?: readonly string[]) => string;

/** The languages that have voices. */
const VOICED: readonly string[] = ["en", "hu"];

let detector: Promise<Detect> | null = null;

/** tinyld's `detect`: an ISO 639-1 code, or "" when it cannot tell. Loaded once; a failed load is tried again next time. */
export function loadDetector(): Promise<Detect> {
	detector ??= import("tinyld").then(
		({ detect }) =>
			(text: string, only?: readonly string[]) =>
				detect(text, only ? { only: [...only] } : undefined),
		(error: unknown) => {
			detector = null;
			throw error;
		},
	);
	return detector;
}

const LETTER = /\p{L}/gu;

function letterCount(text: string): number {
	return text.match(LETTER)?.length ?? 0;
}

/** Words of English that German, French and Hungarian do not write ("in", "an", "was" and "or" they do). */
const ENGLISH_WORDS = new Set([
	"the",
	"and",
	"of",
	"to",
	"with",
	"for",
	"that",
	"this",
	"are",
	"were",
	"from",
	"which",
	"what",
	"when",
	"how",
	"into",
	"than",
	"then",
	"you",
	"your",
	"have",
	"its",
	"not",
	"at",
	"if",
	"it",
]);

/** Words of Hungarian that other languages do not write ("de", "van", "nem" and "sem" they do). */
const HUNGARIAN_WORDS = new Set([
	"az",
	"és",
	"hogy",
	"egy",
	"ez",
	"azt",
	"ezt",
	"csak",
	"már",
	"még",
	"kell",
	"lehet",
	"vagy",
	"volt",
	"lesz",
	"mert",
	"pedig",
	"akkor",
	"nincs",
	"szerint",
	"nagyon",
	"amely",
	"ami",
	"amit",
	"amikor",
	"ahol",
	"hanem",
	"illetve",
	"valamint",
	"ezért",
	"így",
	"úgy",
	"olyan",
	"mivel",
	"tehát",
	"itt",
	"ott",
]);

/**
 * Function words of languages with no voice that English and Hungarian never write
 * (the fix verification's P1). Left out on purpose: "de", "a", "el", "le", "van", "est",
 * "por", "les" and "para", which Hungarian writes, and "los", "las", "pour", "par", "et",
 * "del", "du", "die", "mit", "aux", "jest", "todo" and "hay", which English writes.
 */
const FOREIGN_WORDS = new Set([
	// Spanish and Portuguese
	"que",
	"una",
	"uma",
	"muy",
	"pero",
	"como",
	"está",
	"están",
	"más",
	"también",
	"porque",
	"esto",
	"esta",
	"não",
	"você",
	// French
	"des",
	"une",
	"dans",
	"qui",
	"cette",
	"avec",
	"sont",
	"mais",
	"nous",
	"vous",
	"été",
	"très",
	"être",
	// Italian
	"della",
	"sono",
	"questo",
	"anche",
	"molto",
	"perché",
	// Dutch
	"het",
	"een",
	"niet",
	"zijn",
	"naar",
	"maar",
	"voor",
	"wordt",
	"ook",
	// Danish, Norwegian and Swedish
	"det",
	"og",
	"ikke",
	"jeg",
	"eller",
	"også",
	"och",
	"inte",
	"är",
	// German
	"und",
	"ist",
	"nicht",
	"der",
	"das",
	"ein",
	"eine",
	"auch",
	// Czech and Polish
	"je",
	"jsou",
	"není",
	"který",
	"nie",
	"się",
]);

/** Letters only Hungarian writes. */
const HUNGARIAN_LETTERS = /[őű]/giu;
/** Acute vowels: Hungarian writes about one in ten letters so; English and German almost never. */
const ACUTE_VOWELS = /[áéíóú]/giu;
/** Letters of the other languages that write acute vowels too (Spanish, Portuguese, Czech, French…). */
const OTHER_LETTERS = /[ñãõçàèêëîïôûěščřžýůäßåøæ]/iu;

/** How much a paragraph reads as English and as Hungarian, counting only what one of the two alone writes. */
function evidence(text: string): { en: number; hu: number } {
	let en = 0;
	let hu = 0;
	for (const word of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
		if (ENGLISH_WORDS.has(word)) en++;
		else if (HUNGARIAN_WORDS.has(word)) hu++;
	}
	hu += text.match(HUNGARIAN_LETTERS)?.length ?? 0;
	if (!OTHER_LETTERS.test(text))
		hu += Math.floor((text.match(ACUTE_VOWELS)?.length ?? 0) / 2);
	return { en, hu };
}

/**
 * English or Hungarian by what only one of them writes; tinyld settles a tie between
 * the two, and names a paragraph on its own only when it shows neither, as a German
 * or French one does. tinyld alone misnames short technical paragraphs, sure of itself:
 * "The Python script reads the CSV file and prints the total." is Hungarian to it.
 */
function nameParagraph(
	text: string,
	detect: Detect,
	only?: readonly string[],
): string {
	// A function word of a language with no voice hands the paragraph to tinyld whole:
	// French and Spanish write acute vowels too, and Dutch and Danish write "of" and "for".
	const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
	if (words.some((word) => FOREIGN_WORDS.has(word))) return detect(text);
	const { en, hu } = evidence(text);
	if (en > hu) return "en";
	if (hu > en) return "hu";
	if (en > 0 || only) return detect(text, VOICED);
	return detect(text);
}

/**
 * One language code per paragraph, in order:
 * - a paragraph of at least {@link SHORT_PARAGRAPH_LETTERS} letters is English or Hungarian by what only one of them writes, else the code the detector names;
 * - any other paragraph takes the previous paragraph's code, and short paragraphs that open the reply take the first named code after them;
 * - when no paragraph is named, every paragraph gets the whole reply's language, English or Hungarian only ("" when neither).
 */
export function assignLanguages(
	paragraphs: readonly string[],
	detect: Detect,
): string[] {
	const named = paragraphs.map((text) =>
		letterCount(text) >= SHORT_PARAGRAPH_LETTERS
			? nameParagraph(text, detect)
			: "",
	);
	const firstNamed = named.find((code) => code !== "");
	if (firstNamed === undefined) {
		if (paragraphs.length === 0) return [];
		// Too little text to tell 62 languages apart ("Rendben." reads as French): a short
		// reply is only asked whether it is English or Hungarian. A language with no voice
		// is named only by a paragraph long enough to say so.
		const whole = nameParagraph(paragraphs.join("\n"), detect, VOICED);
		return paragraphs.map(() => whole);
	}
	let previous = firstNamed;
	return named.map((code) => {
		if (code !== "") previous = code;
		return previous;
	});
}

/** The languages that have voices. */
export function isVoiced(code: string): code is "en" | "hu" {
	return code === "en" || code === "hu";
}

/** The language's name in the UI language, first letter upper-cased ("German", "Német"), or null when it has none. */
export function languageDisplayName(
	code: string,
	ui: "en" | "hu",
): string | null {
	if (code === "") return null;
	let name: string | undefined;
	try {
		name = new Intl.DisplayNames([ui], {
			type: "language",
			fallback: "none",
		}).of(code);
	} catch {
		return null;
	}
	if (!name) return null;
	return name.charAt(0).toLocaleUpperCase(ui) + name.slice(1);
}
