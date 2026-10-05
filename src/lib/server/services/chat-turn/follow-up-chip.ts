import type { SupportedLanguage } from "../language";

/**
 * What a follow-up chip is, and the one check that says whether a candidate is
 * one.
 *
 * A chip is the NEXT MESSAGE THE PERSON WOULD SEND to Alfy. Tapping it sends its
 * text, as it stands, as the person's own message; it sits under Alfy's reply, so
 * it has to read as the person asking Alfy for something, never as Alfy talking
 * to the person. That rules out:
 *  - Alfy offering ("Szeretnéd, ha…?", "Would you like me to…?", "Írjam le…?");
 *  - a question put to the person ("Mennyi a kereted?", "What's your budget?"),
 *    and a statement about the person ("I work in software engineering"), which
 *    would put an invented fact in their mouth;
 *  - a generic push ("Tell me more", "Mondj többet", "What else?"), which asks
 *    for nothing in particular.
 * What is left is an instruction or a first-person question about a named thing
 * ("Hasonlítsd össze a két opciót", "How do I install Husky?"), short, one
 * sentence, in the turn's language.
 *
 * The patterns come from real model output (the chips of the 26 captured
 * conversations on the real model, before and after the prompt rewrite); each
 * has its example in follow-up-chip.test.ts, and the good chips from the same
 * outputs are tested to pass.
 */

export type FollowUpChipRejection =
	| "empty"
	| "too_short"
	| "too_long"
	| "format"
	| "script"
	| "language"
	| "offer"
	| "asks_person"
	| "not_a_request"
	| "generic";

export type FollowUpChipCheck =
	| { ok: true; text: string }
	| { ok: false; reason: FollowUpChipRejection };

const START = "(?<![\\p{L}\\p{N}'])";
const END = "(?![\\p{L}\\p{N}'])";
// Matches at the start of the chip.
const atStart = (source: string) => new RegExp(`^(?:${source})${END}`, "iu");
// Matches anywhere, on word boundaries (\b does not see accented letters).
const anywhere = (source: string) =>
	new RegExp(`${START}(?:${source})${END}`, "iu");
const wordSet = (list: string) => new Set(list.split(" "));

// ----- Alfy offering ---------------------------------------------------------
// The assistant asking whether the person wants something done ("Szeretnéd,
// ha…?", "Would you like me to…?"), or asking for something itself ("Megnézhetem
// a kódrészletet?"). The Hungarian first-person verbs are the "shall I…?" forms
// of what Alfy does (írjam, küldjem, mutassak); the person's own verbs (vegyek,
// kezdjem) are not on the list, nor is "Hogyan javítsam…?", which opens with a
// question word.
const OFFER_PATTERNS: Record<SupportedLanguage, RegExp[]> = {
	en: [
		atStart(
			"(?:would|do|did)\\s+you\\s+(?:like|want|prefer|need|wish|care|fancy)",
		),
		atStart("(?:want|need|like)\\s+me\\s+to"),
		atStart(
			"(?:shall|should|can|could|may|might|will)\\s+(?:i|we)\\s+(?:help|assist|draft|write|compile|create|make|build|prepare|put\\s+together|generate|list|summari[sz]e|explain|show|walk|send|provide|give|break|outline|map|plan|find|look|search|check|run|calculate|compare|turn|convert|translate|rewrite|rephrase|expand|elaborate|continue|go|proceed|start|begin|dive|tell|share|offer|suggest|recommend)",
		),
		atStart(
			"(?:let\\s+me|let\\s+us\\s+know|allow\\s+me|i\\s+can|i\\s+could|i'll|i\\s+will|i\\s+would|i\\s+might|i\\s+shall|i'd\\s+be\\s+happy|i'm\\s+happy|happy\\s+to|interested\\s+in|are\\s+you\\s+interested)",
		),
	],
	hu: [
		atStart(
			"(?:szeretnéd|szeretnél|szeretnétek|akarod|akarsz|kéred|kérsz|kérnél|kérnéd|érdekel|érdekelne|érdekelnek|érdekelnének|kívánod|óhajtod|segíthetek|segíthetünk|szolgálhatok|hadd|megnézhetem|megnézhetek|elküldhetem|megmutathatom|van\\s+kedved|van\\s+szükséged|van\\s+igényed)",
		),
		atStart(
			"(?:megírjam|írjam|írjak|elküldjem|küldjem|küldjek|küldök|készítsek|készítsem|mutassak|mutassam|segítsek|segítsem|adjak|adjam|magyarázzak|magyarázzam|összefoglaljam|foglaljam|összehasonlítsam|hasonlítsam|keressek|keressem|számoljak|számoljam|kiszámoljam|folytassam|bővítsem|rövidítsem|egyszerűsítsem|részletezzem|fordítsam|fordítsak|listázzam|vázoljam|átírjam|rendezzem|tervezzek|tervezzem|csináljak|csináljam|nézzek|nézzem|megmutassam|megnézzem|megnézek)",
		),
	],
};

// ----- a question to the person, or a statement about them --------------------
// Asking about the person's own life, money, taste or situation. The person
// speaks about themselves in the first person ("ha sokat autózom"), never "if
// you drive a lot", and a chip that asks them something is Alfy's job, not
// theirs. "Which do you recommend?" is the person asking Alfy and is not here.
const ASKS_PERSON_PATTERNS: Record<SupportedLanguage, RegExp[]> = {
	en: [
		atStart("(?:do|did|are|were|have|has|is|was)\\s+you"),
		anywhere(
			"you(?:'re|\\s+are)?\\s+(?:currently\\s+|already\\s+|usually\\s+|often\\s+)?(?:prefer|like|want|need|have|own|use|live|work|earn|eat|drink|plan|planning|going|doing|looking|trying|using|having|feeling|studying|working|travell?ing|cooking|training|exercising|vegan|vegetarian|a\\s+beginner|new|experienced|familiar|comfortable)",
		),
		anywhere(
			"your\\s+(?:budget|income|salary|age|level|goals?|experience|schedule|situation|preferences?|needs?|diet|weight|height|name|location|city|team|stack|setup|timeline|deadline|favou?rite|current|usual|typical|family|partner|kids|children|job|company|business|background|plans?|health|dietary|allerg\\w*|home|house|apartment|garden|car|phone|laptop)",
		),
		anywhere("(?:if|when|since|because|whenever|while)\\s+you"),
	],
	hu: [
		atStart(
			"(?:szereted|szeretsz|dolgozol|laksz|élsz|eszel|iszol|edzel|sportolsz|főzöl|vásárolsz|tanulsz|szoktál|szoktad|használsz|vezetsz|utazol|alszol|voltál|jártál|próbáltad|próbáltál|ettél|ittál|láttad|olvastad|hallottál|érted)",
		),
		anywhere(
			"(?:kereted|kereseted|fizetésed|jövedelmed|korod|célod|céljaid|költségvetésed|büdzséd|tapasztalatod|helyzeted|igényeid|igényed|preferenciád|kedvenced|munkád|városod|csapatod|határidőd|időd|étrended|súlyod|magasságod|neved|lakhelyed|terveid)",
		),
		anywhere("hány\\s+éves\\s+vagy|mennyi\\s+(?:pénzed|időd)"),
		// "ha sokat autózol", "ha szereted": the person as "you".
		anywhere(
			"(?:ha|amikor|mivel|mert|amíg)\\s+(?:\\p{L}+\\s+){0,3}\\p{L}{3,}(?:ol|el|öl|sz|od|ed|öd)",
		),
	],
};

// ----- generic ----------------------------------------------------------------
// A chip made of nothing but these asks for nothing in particular ("Tell me
// more about this", "Mutass egy példát"): no thing is named.
const GENERIC_WORDS: Record<SupportedLanguage, Set<string>> = {
	en: wordSet(
		"tell me more about this that it these those them please can could would you give show explain elaborate expand further details detail detailed information info else anything something other another any next step steps tips tip example examples continue go on keep going summarize summarise summary what is are the a an and also too i want to know learn understand how why so ok okay thanks yes no sure right good great interesting now then say walk through in of for with my your there here do does did have has be will should might may get started start begin more some",
	),
	hu: wordSet(
		"mondj mondd mesélj adj add mutass magyarázd magyarázz részletezd folytasd tovább többet több még részlet részletek részletet részletesebben bővebben pontosabban információ információt infót kérek kérlek ezt azt ez az egy a és is valami valamit más mást következő lépés lépést lépések lépéseket tipp tippet tippeket példa példát példákat mi mit hogyan hogy miért erről arról róla ennek annak nekem kicsit ismét újra jó ok rendben köszi köszönöm igen nem persze vagy de akkor most tudnál tudsz lehet lehetne segítesz segíts kellene kell van nincs foglald össze összefoglalót összefoglalást összefoglaló elmagyarázni elmondani el meg ki fel le be még valamit",
	),
};

// ----- the turn's language ------------------------------------------------------
// The app's per-message detector reads a short Hungarian chip without accents
// ("Melyik romkocsma a legjobb?") as English, so a chip is judged on positive
// evidence only: words only the other language has. A proper noun with an accent
// (Széchenyi, Belém) is not evidence.
const ENGLISH_ONLY_WORDS = wordSet(
	"the you your this that these those with for what which how why where when who can could would should do does did are was were have had it its of to at by from about into any some more not i me my please show give make list draft write compare explain turn tell",
);
const HUNGARIAN_ONLY_WORDS = wordSet(
	"melyik hogyan milyen mennyi mennyibe mikor miért kérlek kérek szeretném szeretnék ajánlasz ajánlod javasolsz hogy és egy nem van kell még ezt azt erről nekem mutass készíts írd hasonlítsd foglald magyarázd számold tedd",
);

type LanguageEvidence = {
	english: number;
	hungarianWords: number;
	hungarianMarks: number;
	exclusiveLetters: boolean;
};

function languageEvidence(text: string): LanguageEvidence {
	const tokens = text.split(/[^\p{L}\p{N}']+/u).filter(Boolean);
	const lower = tokens.map((token) => token.toLowerCase());
	const hungarianWords = lower.filter((word) =>
		HUNGARIAN_ONLY_WORDS.has(word),
	).length;
	// Accented letters in a word that does not start with a capital.
	const accented = tokens.filter(
		(token) => /^\p{Ll}/u.test(token) && /[áéíóöőúüű]/.test(token),
	).length;
	return {
		english: lower.filter((word) => ENGLISH_ONLY_WORDS.has(word)).length,
		hungarianWords,
		hungarianMarks: hungarianWords + accented,
		exclusiveLetters: tokens.some(
			(token) => /^\p{Ll}/u.test(token) && /[őű]/.test(token),
		),
	};
}

function isInLanguage(text: string, language: SupportedLanguage): boolean {
	const evidence = languageEvidence(text);
	if (language === "hu") {
		return !(evidence.english >= 2 && evidence.hungarianMarks === 0);
	}
	return !(
		evidence.exclusiveLetters ||
		(evidence.english === 0 && evidence.hungarianWords >= 1)
	);
}

// ----- what a chip that is not a question opens with ------------------------------
// A chip that ends in a question mark is a question about a named thing and needs
// no opener. One without it has to read as a request, not as the person telling
// Alfy something about themselves ("I work in software engineering",
// "Szoftverfejlesztő vagyok"): in English that is a sentence opening with a
// pronoun, a determiner or an acknowledgment; in Hungarian a request opens with
// an imperative, a question word or a polite opener.
const ENGLISH_STATEMENT_OPENERS = atStart(
	"(?:i(?!\\s+(?:want|need|would\\s+like|prefer|wonder))|i'm|i've|i'll|my|we|we're|we've|it|it's|the|this|that|these|those|there|he|she|they|you|you're|your|not|no|nope|thanks|thank|sounds|great|nice|awesome|perfect|cool|wow|hmm|well|exactly|indeed|interesting|got|alright|fine|cheers|because|since|but|so)",
);
const HUNGARIAN_REQUEST_OPENERS = atStart(
	"(?:kérlek|kérek|kérem|szeretném|szeretnék|jó\\s+lenne|lehetne|legyen|igen|persze|rendben|akkor|és|még|most|ugyanezt|először|hogyan|hogy|mit|mi|miért|melyik|milyen|mennyi|mennyibe|mennyire|mikor|hol|hová|hova|honnan|kinek|kit|ki|\\p{L}+-e|van|lehet|kell|érdemes|használhatok|vehetek|készíts|készítsd|írj|írd|hasonlítsd|hasonlíts|foglald|mutass|mutasd|magyarázd|magyarázz|számold|számolj|adj|add|tedd|tegyél|cseréld|rövidítsd|bővítsd|fordítsd|javítsd|sorold|sorolj|vedd|nézd|nézz|keress|keresd|segíts|mondd|mondj|mesélj|küldj|küldd|rajzolj|rajzold|vázold|vázolj|bontsd|rangsorold|válaszd|ajánlj|javasolj|ellenőrizd|részletezd|folytasd|kezdd|hozz|hozd|gyűjtsd|listázd|összegezd|egyszerűsítsd|alakítsd|módosítsd|változtasd|becsüld|tervezz|tervezd|szervezd|rendezd|csoportosítsd|alkalmazd|mérd|illeszd|nevezd|vezesd|vezess|oldd|ábrázold|jelöld|emeld|rakd|döntsd|vidd|hagyd|töröld|szúrd|vond|pontozd|árazd|teszteld|próbáld|használd|tartsd|szedd|állítsd|igazítsd|rövidebben|részletesebben|egyszerűbben)",
);
// An imperative that is not in the list above: "Oszd be", "Rendezd át",
// "Foglalj össze". The second-person imperative ends in -j, -d, -ss, -ts or -zz.
const HUNGARIAN_IMPERATIVE_SHAPE = atStart("\\p{L}{2,}(?:j|d|ss|ts|zz)");

function opensLikeRequest(text: string, language: SupportedLanguage): boolean {
	if (language === "en") return !ENGLISH_STATEMENT_OPENERS.test(text);
	return (
		HUNGARIAN_REQUEST_OPENERS.test(text) ||
		HUNGARIAN_IMPERATIVE_SHAPE.test(text)
	);
}

function normalizeChip(raw: string): string {
	return raw
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^[-•*]\s+/, "")
		.replace(/^["'“”„‘’]+|["'“”„‘’]+$/g, "")
		.replace(/[.!…]+$/, "")
		.trim();
}

const NON_LATIN_SCRIPT_RE =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Thai}\p{Script=Devanagari}]/u;

/**
 * Whether `raw` is a follow-up chip, and the chip's normalized text when it is
 * (whitespace collapsed, a trailing full stop or "!" and wrapping quotes
 * removed). `language` is the turn's reply language; without it the checks that
 * need one run for both. `maxWords` is the chip's word budget.
 */
export function checkFollowUpChip(
	raw: string,
	options: { language?: SupportedLanguage; maxWords: number },
): FollowUpChipCheck {
	const text = normalizeChip(raw);
	const reject = (reason: FollowUpChipRejection): FollowUpChipCheck => ({
		ok: false,
		reason,
	});
	const body = text.replace(/\?$/, "").trim();
	if (!body) return reject("empty");

	const wordList = body.split(" ").filter(Boolean);
	if (wordList.length < 2) return reject("too_short");
	if (wordList.length > options.maxWords) return reject("too_long");

	// One plain sentence: no list, markdown or JSON leftovers, at most one comma,
	// no sentence break inside ("package.json" and "3.5" are fine).
	if (/[{}[\]<>|\\*`~^]/.test(text)) return reject("format");
	if (/[.!?:;](?:\s|$)/.test(body)) return reject("format");
	if ((body.match(/,/g) ?? []).length > 1) return reject("format");

	if (NON_LATIN_SCRIPT_RE.test(text)) return reject("script");

	if (options.language && !isInLanguage(text, options.language)) {
		return reject("language");
	}

	// Without a turn language the chip is read in the language it looks written in.
	const evidence = languageEvidence(text);
	const language: SupportedLanguage =
		options.language ??
		(evidence.english === 0 && evidence.hungarianMarks > 0 ? "hu" : "en");

	const languages: SupportedLanguage[] = options.language
		? [options.language]
		: ["en", "hu"];
	for (const checked of languages) {
		if (OFFER_PATTERNS[checked].some((pattern) => pattern.test(text))) {
			return reject("offer");
		}
		if (ASKS_PERSON_PATTERNS[checked].some((pattern) => pattern.test(text))) {
			return reject("asks_person");
		}
	}

	if (!text.endsWith("?") && !opensLikeRequest(text, language)) {
		return reject("not_a_request");
	}

	const lowerWords = body
		.toLowerCase()
		.split(/[^\p{L}\p{N}']+/u)
		.filter(Boolean);
	const generic = GENERIC_WORDS[language];
	if (lowerWords.every((word) => generic.has(word))) return reject("generic");
	// A chip whose words are all generic in the OTHER language, when the turn's
	// language is not known, is generic too.
	if (
		!options.language &&
		lowerWords.every(
			(word) => GENERIC_WORDS.en.has(word) || GENERIC_WORDS.hu.has(word),
		)
	) {
		return reject("generic");
	}

	return { ok: true, text };
}
