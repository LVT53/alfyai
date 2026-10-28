// The request half of the explicit-picture filter: a small, explicit list of
// words that ask for an explicit picture, in English and Hungarian, matched
// against what the model writes for the picture model (make_image's `prompt`
// and `title`) before anything is submitted. The model's own judgement is the
// first line (make_image's description tells it to decline); this list only
// catches the plain cases it let through, and the picture check after
// rendering catches the rest.
//
// Kept small on purpose: anatomy words, "breast", "lingerie" and the like are
// left to the picture check, so an anatomy diagram or a swimsuit catalogue is
// never refused for a word. A term counts only as a whole word, and a few
// innocent uses ("nude-coloured", "the naked eye", "no nudity") are let through.
//
// Never sent to a model: the words are only read here.

type Term = {
	/** Lower-case; matched as a whole word (letters or digits do not continue it). */
	word: string;
	/** Matched as a word start too ("masturbat" catches "masturbating"). */
	prefix?: boolean;
	/** Innocent when one of these follows it (after a space or a hyphen). */
	innocentBefore?: readonly string[];
};

const NUDE_THINGS = [
	"colour",
	"coloured",
	"color",
	"colored",
	"tone",
	"tones",
	"toned",
	"shade",
	"shades",
	"palette",
	"beige",
	"pink",
	"lipstick",
	"lip",
	"lips",
	"heels",
	"heel",
	"pumps",
	"shoes",
	"sandals",
	"nail",
	"nails",
	"makeup",
	"make-up",
	"stockings",
	"tights",
	"fabric",
	"leather",
	"sofa",
	"wall",
	"walls",
	"paint",
];

const NAKED_THINGS = [
	"eye",
	"eyes",
	"mole",
	"flame",
	"flames",
	"truth",
	"bulb",
	"bulbs",
	"wire",
	"wires",
	"blade",
	"branch",
	"branches",
	"tree",
	"trees",
	"lunch",
	"ambition",
];

const TERMS: readonly Term[] = [
	// English
	{ word: "nude", innocentBefore: NUDE_THINGS },
	{ word: "nudes" },
	{ word: "nudity" },
	{ word: "naked", innocentBefore: NAKED_THINGS },
	{ word: "topless" },
	{ word: "bottomless" },
	{ word: "unclothed" },
	{ word: "undressed" },
	{ word: "without clothes" },
	{ word: "without any clothes" },
	{ word: "no clothes" },
	{ word: "porn", prefix: true },
	{ word: "nsfw" },
	{ word: "hentai" },
	{ word: "xxx" },
	{ word: "erotic", prefix: true },
	{ word: "sexually explicit" },
	{ word: "explicit sex" },
	{ word: "sex scene" },
	{ word: "sex act" },
	{ word: "having sex" },
	{ word: "sexual intercourse" },
	{ word: "masturbat", prefix: true },
	{ word: "orgasm", prefix: true },
	{ word: "genitals" },
	{ word: "genitalia" },
	{ word: "blowjob" },
	{ word: "handjob" },
	{ word: "onlyfans" },
	// Hungarian (also without accents, the way people type on a phone)
	{ word: "meztelen", prefix: true },
	{ word: "pucér", prefix: true },
	{ word: "pucer", prefix: true },
	{ word: "ruhátlan", prefix: true },
	{ word: "ruhatlan", prefix: true },
	{ word: "ruha nélkül" },
	{ word: "ruha nelkul" },
	{ word: "akt" },
	{ word: "aktfotó", prefix: true },
	{ word: "aktfoto", prefix: true },
	{ word: "aktkép", prefix: true },
	{ word: "aktkep", prefix: true },
	{ word: "pornó", prefix: true },
	{ word: "erotikus" },
	{ word: "szex" },
	{ word: "szexjelenet", prefix: true },
	{ word: "szexuális aktus" },
	{ word: "szexualis aktus" },
	{ word: "közösül", prefix: true },
	{ word: "kozosul", prefix: true },
	{ word: "maszturb", prefix: true },
	{ word: "nemi szerv", prefix: true },
];

/** A negation just before a term ("no nudity", "not nude", "non-nude"). */
const NEGATIONS = new Set(["no", "not", "non", "without", "never", "nem", "nincs", "semmi"]);

const LETTER = /[\p{L}\p{N}]/u;

function isWordChar(char: string | undefined): boolean {
	return char !== undefined && LETTER.test(char);
}

/** The word that follows `end` after one space or hyphen, lower-case. */
function nextWord(text: string, end: number): string {
	const rest = text.slice(end).match(/^[\s-]+([\p{L}\p{N}-]+)/u);
	return rest?.[1] ?? "";
}

/** The word right before `start`, lower-case. */
function previousWord(text: string, start: number): string {
	const before = text.slice(0, start).match(/([\p{L}\p{N}]+)[\s-]+$/u);
	return before?.[1] ?? "";
}

function matchesAt(text: string, term: Term, at: number): boolean {
	const end = at + term.word.length;
	if (isWordChar(text[at - 1])) return false;
	if (!term.prefix && isWordChar(text[end])) return false;
	if (NEGATIONS.has(previousWord(text, at))) return false;
	if (term.innocentBefore?.includes(nextWord(text, end))) return false;
	return true;
}

/**
 * The first term of the list in `text` that asks for an explicit picture, or
 * null. Case and Unicode form do not matter.
 */
export function findExplicitRequestTerm(text: string): string | null {
	const lower = text.normalize("NFC").toLowerCase();
	for (const term of TERMS) {
		let at = lower.indexOf(term.word);
		while (at !== -1) {
			if (matchesAt(lower, term, at)) return term.word;
			at = lower.indexOf(term.word, at + 1);
		}
	}
	return null;
}
