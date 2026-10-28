// The request half of the explicit-picture filter: a small list of phrasings
// that plainly ask for an explicit picture, in English and Hungarian, matched
// against what the model writes for the picture model (make_image's `prompt`
// and `title`) before anything is submitted. The model's own judgement is the
// first line (make_image's description tells it to decline); the picture check
// after rendering catches what neither stops.
//
// Precision over recall (Task 18 review): a false positive tells the model not
// to make an ordinary picture at all. So:
// - the text is split into whole words at every character that is not a letter
//   or a digit (Unicode-aware; a hyphen splits too), compared without case or
//   accents, and a term matches whole words only, never a prefix: a Hungarian
//   compound ("meztelencsiga", a slug) or a place ("Pornichet") is its own word;
// - only unambiguous words stand alone; a word with ordinary uses ("nude" the
//   colour, "naked" the eye, the mole-rat, the chef, the wall) counts only
//   right before a person or a picture ("a naked woman", "nude photos");
// - anatomy words, "undressed", "xxx", "akt", "without clothes" and the like
//   are left to the model's judgement and the picture check.
//
// Never sent to a model: the words are only read here.

/** Lower case, NFC, accents removed: "Pucér" and "pucer" are one word. */
function fold(text: string): string {
	return text
		.normalize("NFD")
		.replace(/\p{M}+/gu, "")
		.normalize("NFC")
		.toLowerCase();
}

function words(text: string): string[] {
	return fold(text)
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);
}

/** Words that ask for an explicit picture on their own, in every use. */
const ALONE = new Set(
	[
		"nudity",
		"nudes",
		"porn",
		"porno",
		"pornos",
		"pornographic",
		"pornography",
		"nsfw",
		"hentai",
		"topless",
		"erotic",
		"erotica",
		"masturbate",
		"masturbates",
		"masturbating",
		"masturbation",
		"orgasm",
		"orgasms",
		"blowjob",
		"handjob",
		"onlyfans",
		"pornó",
		"pornográf",
		"pornográfia",
		"pornografikus",
		"erotikus",
		"meztelenül",
		"pucéran",
		"aktfotó",
		"aktfotók",
		"aktfotót",
		"aktkép",
		"aktképek",
		"aktképet",
		"szexjelenet",
		"szexjelenetet",
		"közösülés",
		"közösülnek",
		"közösülő",
		"maszturbál",
		"maszturbálás",
		"maszturbáló",
	].map(fold),
);

/** Phrases that ask for one, as whole words in a row. */
const PHRASES: readonly string[][] = [
	"sexually explicit",
	"explicit sex",
	"sex scene",
	"sex act",
	"having sex",
	"sexual intercourse",
	"szexuális aktus",
].map(words);

/** Words with ordinary uses that ask for one only right before a person or a picture. */
const BEFORE_A_PERSON = new Set(
	["nude", "naked", "meztelen", "pucér", "ruhátlan"].map(fold),
);

const PEOPLE_AND_PICTURES = new Set(
	[
		// English: people
		"woman",
		"women",
		"man",
		"men",
		"girl",
		"girls",
		"guy",
		"guys",
		"lady",
		"ladies",
		"body",
		"bodies",
		"person",
		"people",
		"couple",
		"couples",
		"model",
		"models",
		// English: pictures
		"photo",
		"photos",
		"picture",
		"pictures",
		"image",
		"images",
		"selfie",
		"selfies",
		"pic",
		"pics",
		"photoshoot",
		// Hungarian: people
		"nő",
		"nők",
		"nőt",
		"nőről",
		"férfi",
		"férfiak",
		"férfit",
		"lány",
		"lányok",
		"lányt",
		"hölgy",
		"test",
		"testek",
		"ember",
		"emberek",
		"embert",
		"pár",
		"párt",
		"modell",
		"modellek",
		"modellt",
		// Hungarian: pictures
		"kép",
		"képek",
		"képet",
		"fotó",
		"fotók",
		"fotót",
		"szelfi",
	].map(fold),
);

/** A negation right before a term ("no nudity", "not nude", "non-nude"). */
const NEGATIONS = new Set(
	["no", "not", "non", "without", "never", "nem", "nincs", "semmi"].map(fold),
);

function negated(list: string[], at: number): boolean {
	const before = list[at - 1];
	return before !== undefined && NEGATIONS.has(before);
}

/**
 * The first phrasing in `text` that plainly asks for an explicit picture, as
 * the folded words found ("nude woman", "hentai"), or null.
 */
export function findExplicitRequestTerm(text: string): string | null {
	const list = words(text);
	for (let at = 0; at < list.length; at++) {
		const word = list[at] as string;
		if (negated(list, at)) continue;
		if (ALONE.has(word)) return word;
		const next = list[at + 1];
		if (
			BEFORE_A_PERSON.has(word) &&
			next !== undefined &&
			PEOPLE_AND_PICTURES.has(next)
		) {
			return `${word} ${next}`;
		}
		for (const phrase of PHRASES) {
			if (phrase.every((part, offset) => list[at + offset] === part)) {
				return phrase.join(" ");
			}
		}
	}
	return null;
}
