export type SupportedLanguage = 'en' | 'hu';

const DEFAULT_SHORT_INPUT_THRESHOLD = 10;

// Direct port of the old short-input fallback words.
const HUNGARIAN_SHORT_WORDS = new Set([
	'igen',
	'nem',
	'köszönöm',
	'köszi',
	'szia',
	'helló',
	'kérem',
	'jó',
	'rossz',
	'miért',
	'hogyan',
	'hol',
	'mi',
	'ki',
	'na',
	'hát',
	'nos',
	'oké',
	'persze',
	'talán',
	'nincs',
	'van',
	'volt',
	'lesz',
	'kell',
	'tudok',
	'hé'
]);

// Extra lexical markers to approximate the old lingua-backed behavior for
// longer mixed prompts like "Irj egy angol emailt".
const HUNGARIAN_FUNCTION_WORDS = new Set([
	'a',
	'az',
	'egy',
	'és',
	'hogy',
	'de',
	'vagy',
	'ha',
	'akkor',
	'mert',
	'ami',
	'aki',
	'ezt',
	'azt',
	'itt',
	'ott',
	'nekem',
	'neki',
	'vel',
	'nélkül',
	'kell',
	'legyen',
	'lehet',
	'írj',
	'irj',
	'mondd',
	'mondj',
	'válaszolj',
	'valaszolj',
	'fordítsd',
	'forditsd',
	'fordíts',
	'fordits',
	'magyarázd',
	'magyarazd',
	'kérlek',
	'kerlek',
	'emailt',
	'levelet',
	'angol',
	'magyar',
	'magyarul',
	'angolul'
]);

const ENGLISH_FUNCTION_WORDS = new Set([
	'the',
	'and',
	'or',
	'if',
	'then',
	'please',
	'write',
	'answer',
	'translate',
	'explain',
	'email',
	'message',
	'about',
	'for',
	'with',
	'without',
	'this',
	'that',
	'hello',
	'thanks',
	'thank',
	'you',
	'tell',
	'me'
]);

const HUNGARIAN_MARKERS = /[áéíóöőúüű]/i;
const HUNGARIAN_BIGRAMS = /(sz|zs|cs|gy|ny|ty|ly)/i;
const HUNGARIAN_SUFFIXES = [
	'nak',
	'nek',
	'ban',
	'ben',
	'val',
	'vel',
	'ból',
	'ből',
	'rol',
	'ról',
	'ről',
	'tól',
	'től',
	'hoz',
	'hez',
	'höz',
	'ért',
	'ként',
	'ul',
	'ül'
];

function normalizeWord(word: string): string {
	return word.toLowerCase().trim().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
}

function scoreHungarian(tokens: string[]): number {
	let score = 0;

	for (const token of tokens) {
		if (!token) continue;

		if (HUNGARIAN_SHORT_WORDS.has(token)) {
			score += 4;
		}

		if (HUNGARIAN_FUNCTION_WORDS.has(token)) {
			score += 3;
		}

		if (HUNGARIAN_MARKERS.test(token)) {
			score += 4;
		}

		if (HUNGARIAN_BIGRAMS.test(token)) {
			score += 1;
		}

		if (HUNGARIAN_SUFFIXES.some((suffix) => token.length > suffix.length + 2 && token.endsWith(suffix))) {
			score += 1;
		}
	}

	return score;
}

function scoreEnglish(tokens: string[]): number {
	let score = 0;

	for (const token of tokens) {
		if (!token) continue;

		if (ENGLISH_FUNCTION_WORDS.has(token)) {
			score += 2;
		}

		if (/^[\p{L}]+$/u.test(token) && !HUNGARIAN_BIGRAMS.test(token)) {
			score += 0.25;
		}
	}

	return score;
}

export function detectLanguage(
	text: string,
	options?: { shortInputThreshold?: number }
): SupportedLanguage {
	const trimmed = text.trim();
	if (!trimmed) {
		return 'en';
	}

	const shortInputThreshold = options?.shortInputThreshold ?? DEFAULT_SHORT_INPUT_THRESHOLD;
	const normalized = trimmed.toLowerCase();

	// Exact port of the old short-input branch.
	if (shortInputThreshold > 0 && trimmed.length < shortInputThreshold) {
		const shortNormalized = normalized.replace(/[?!.,]+$/g, '');
		return HUNGARIAN_SHORT_WORDS.has(shortNormalized) ? 'hu' : 'en';
	}

	const tokens = (normalized.match(/[\p{L}]+/gu) ?? []).map(normalizeWord).filter(Boolean);
	if (tokens.length === 0) {
		return 'en';
	}

	const hungarianScore = scoreHungarian(tokens);
	const englishScore = scoreEnglish(tokens);

	if (hungarianScore === 0) {
		return 'en';
	}

	// Bias toward Hungarian when we see clear directive language such as
	// "Irj egy angol emailt", which was previously handled well by the
	// dedicated language detector node.
	if (hungarianScore >= englishScore + 1.5) {
		return 'hu';
	}

	return HUNGARIAN_MARKERS.test(normalized) ? 'hu' : 'en';
}
