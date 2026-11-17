// Spoken forms: how read aloud says one written word (spec §4.4, refined
// 2026-11-16; Plan 2, Task 0).
//
// Code is read the way a teacher says it aloud, and addresses, abbreviations,
// symbols, shortcuts and versions get a spoken form, from the data in
// `reading-dictionary.ts`. The browser builds every token of the speech script
// with `speakWord`, and the session route recomputes them with it to check
// them, so the two cannot disagree. Pure TypeScript with no DOM or Node API,
// because both sides import it.

import {
	ACRONYMS,
	CODE_CONTEXT_WORDS,
	CODE_SYMBOLS,
	CODE_WORDS,
	FILE_EXTENSIONS,
	HUNGARIAN_LETTER_POWERS,
	LINKING_WORDS,
	MATH_WORDS,
	NUMBER_WORDS,
	PROSE_ABBREVIATIONS,
	PROSE_SYMBOLS,
	SEPARATORS,
	SHELL_COMMANDS,
	SHELL_LANGUAGES,
	SHORTCUT_MODIFIERS,
	type SpokenForm,
} from "./reading-dictionary";

/** `math`: a formula the page shows as TeX, read as simple math (`speakMath`), whole as one word. */
export type WordKind = "prose" | "code" | "shell" | "listNumber" | "math";

type ReadingLanguage = "en" | "hu";

/** What the speech service takes: tokens of 1–80 characters, at most 40 and 160 characters a word. */
export const MAX_TOKEN_CHARS = 80;
const MAX_TOKENS = 40;
const MAX_JOINED_CHARS = 160;
/** The longest code word that is read at all. */
const MAX_CODE_WORD_CHARS = 512;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const words = (form: SpokenForm, language: ReadingLanguage): string[] =>
	form[language].split(" ");

const capitalize = (text: string): string =>
	text.charAt(0).toUpperCase() + text.slice(1);

const at = (text: string, index: number): string | undefined =>
	index >= 0 && index < text.length ? text.charAt(index) : undefined;

const isLetter = (c: string | undefined): boolean =>
	c !== undefined && /\p{L}/u.test(c);

const isAsciiDigit = (c: string | undefined): boolean =>
	c !== undefined && c >= "0" && c <= "9";

/** A character a name or a number is made of. */
const isNameChar = (c: string | undefined): boolean =>
	c !== undefined && /[\p{L}\p{Nd}_$]/u.test(c);

/** The marks go back on a spoken form's last token. */
function withTrailing(tokens: string[], trail: string): string[] {
	if (tokens.length === 0 || trail === "") return tokens;
	return [...tokens.slice(0, -1), `${tokens[tokens.length - 1]}${trail}`];
}

/** Every token 1–80 characters with no whitespace; a word too long to say gives nothing. */
function limit(tokens: string[]): string[] {
	const clean = tokens.flatMap((t) => t.split(/\s+/u)).filter((t) => t !== "");
	if (clean.length === 0 || clean.length > MAX_TOKENS) return [];
	if (clean.some((t) => t.length > MAX_TOKEN_CHARS)) return [];
	if (clean.join(" ").length > MAX_JOINED_CHARS) return [];
	return clean;
}

/** 0–99 as a word: "twenty-one", "huszonegy". */
function numberWord(n: number, language: ReadingLanguage): string {
	const data = NUMBER_WORDS[language];
	if (n < 20) return data.ones[n] ?? String(n);
	const tens = Math.floor(n / 10);
	const ones = n % 10;
	if (ones === 0) return data.tens[tens] ?? String(n);
	return `${data.tensBeforeOnes[tens]}${data.ones[ones]}`;
}

/** Digits in code: 0–99 (no leading zero) as words, anything else as written without `_`. */
function numberText(digits: string, language: ReadingLanguage): string {
	const clean = digits.replace(/_/gu, "");
	return /^(?:0|[1-9][0-9]?)$/u.test(clean)
		? numberWord(Number(clean), language)
		: clean;
}

// ---------------------------------------------------------------------------
// Addresses, email addresses, versions: prose and code read them the same way
// ---------------------------------------------------------------------------

const URL_SPAN = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'`<>(){}[\],;]*/u;
const WWW_SPAN = /^www\.[^\s"'`<>(){}[\],;]*/iu;
const EMAIL =
	/^[\p{L}\p{Nd}._%+-]+@[\p{L}\p{Nd}-]+(?:\.[\p{L}\p{Nd}-]+)*\.\p{L}{2,}$/u;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;
const VERSION = /^[vV]([0-9]+(?:\.[0-9]+)+)$/u;

/** Parts joined by the word for a dot: "example dot com". */
function joinWithDots(
	parts: readonly string[],
	language: ReadingLanguage,
): string[] {
	const out: string[] = [];
	for (const part of parts) {
		if (part === "") continue;
		if (out.length > 0) out.push(LINKING_WORDS.dot[language]);
		out.push(part);
	}
	return out;
}

/** The host of an address: no scheme, credentials, port, path or `www.`. */
function hostOf(address: string): string {
	const afterScheme = address.includes("://")
		? address.slice(address.indexOf("://") + 3)
		: address;
	const authority = afterScheme.split(/[/?#]/u, 1)[0] ?? "";
	return authority
		.slice(authority.lastIndexOf("@") + 1)
		.replace(/:\d*$/u, "")
		.replace(/^www\./iu, "");
}

/** The site name of an address, every dot said; an IPv4 host stays as written. */
function hostTokens(host: string, language: ReadingLanguage): string[] {
	if (host === "") return [];
	return IPV4.test(host) ? [host] : joinWithDots(host.split("."), language);
}

/** An address in the word: what is before it, its host, and what is after it. */
function findAddress(
	text: string,
	language: ReadingLanguage,
): { before: string; host: string; tokens: string[]; after: string } | null {
	// Only a word that holds "://" can hold a URL: the scan would otherwise try
	// every letter of a long word.
	const url = text.includes("://") ? URL_SPAN.exec(text) : null;
	const www = url ? null : WWW_SPAN.exec(text);
	const found = url ?? www;
	if (!found) return null;
	const start = found.index;
	const end = start + found[0].length;
	const host = hostOf(found[0]);
	return {
		before: text.slice(0, start),
		host,
		tokens: hostTokens(host, language),
		after: text.slice(end),
	};
}

/** "name at site dot com". */
function emailTokens(text: string, language: ReadingLanguage): string[] | null {
	if (!EMAIL.test(text)) return null;
	const at = text.lastIndexOf("@");
	return [
		...joinWithDots(text.slice(0, at).split("."), language),
		LINKING_WORDS.at[language],
		...joinWithDots(text.slice(at + 1).split("."), language),
	];
}

// ---------------------------------------------------------------------------
// Prose
// ---------------------------------------------------------------------------

/** An em dash (or two hyphens) with a letter on each side: the dash of "eggs—one", not a range or a flag. */
const JOINING_DASH = /(?<=\p{L})(?:[\u2014\u2015]|--)(?=\p{L})/u;
const LEADING_MARKS = /^[("'„“]+/u;
const TRAILING_MARKS = /[.,;:!?)"'”]+$/u;
const FILE_PART = /^[\p{L}\p{Nd}_-]+$/u;
const SHORTCUT_KEY = /^[\p{L}\p{Nd}]{1,12}$/u;
const SHORTCUT_GLYPHS = /^([⌃⌘⇧⌥]+)([\p{L}\p{Nd}]{1,12})$/u;
const SUPERSCRIPT_UNIT = /^(?:m|dm|cm|mm|km)[²³]$/u;
/** A suffix after an acronym, in Hungarian: "API-t", "JSON-ban" (lower-case letters, so no accent is listed here). */
const HUNGARIAN_SUFFIX = /^\p{Ll}{1,8}$/u;

const hasProseSymbol = (text: string): boolean =>
	PROSE_SYMBOLS.some(([symbol]) => text.includes(symbol));

function fileNameTokens(
	core: string,
	language: ReadingLanguage,
): string[] | null {
	const parts = core.split(".");
	const extension = parts[parts.length - 1]?.toLowerCase() ?? "";
	if (parts.length < 2 || !FILE_EXTENSIONS.has(extension)) return null;
	if (parts.some((part) => !FILE_PART.test(part))) return null;
	return joinWithDots(parts, language);
}

function modifierWords(
	names: readonly string[],
	language: ReadingLanguage,
): string[] | null {
	const spoken: string[] = [];
	for (const name of names) {
		const form = SHORTCUT_MODIFIERS[name.toLowerCase()];
		if (!form) return null;
		spoken.push(...words(form, language));
	}
	return spoken;
}

/** Modifiers joined by `+`, or modifier glyphs straight before the key. */
function shortcutTokens(
	core: string,
	language: ReadingLanguage,
): string[] | null {
	const glyphs = SHORTCUT_GLYPHS.exec(core);
	if (glyphs?.[1] && glyphs[2]) {
		const modifiers = modifierWords([...glyphs[1]], language);
		return modifiers ? [...modifiers, glyphs[2]] : null;
	}
	if (!core.includes("+")) return null;
	const parts = core.split("+");
	const key = parts.pop() ?? "";
	if (parts.length === 0 || !SHORTCUT_KEY.test(key)) return null;
	const modifiers = modifierWords(parts, language);
	return modifiers ? [...modifiers, key] : null;
}

/** An abbreviation of the paragraph's language, as listed or with a capital first letter. */
function abbreviationTokens(
	core: string,
	trail: string,
	language: ReadingLanguage,
): string[] | null {
	// A period an abbreviation ends in is part of it, so try the longest first.
	for (let keep = trail.length; keep >= 0; keep--) {
		const candidate = core + trail.slice(0, keep);
		for (const [written, spoken] of PROSE_ABBREVIATIONS[language]) {
			const tokens = spoken.split(" ");
			if (candidate === written) return withTrailing(tokens, trail.slice(keep));
			if (candidate === capitalize(written)) {
				tokens[0] = capitalize(tokens[0] ?? "");
				return withTrailing(tokens, trail.slice(keep));
			}
		}
	}
	return null;
}

/** An acronym as written, alone or with a hyphenated Hungarian suffix. */
function acronymTokens(
	core: string,
	language: ReadingLanguage,
): string[] | null {
	for (const { written, form } of ACRONYMS) {
		if (core === written) return words(form, language);
		if (language === "hu" && core.startsWith(`${written}-`)) {
			const suffix = core.slice(written.length + 1);
			if (HUNGARIAN_SUFFIX.test(suffix)) {
				const spoken = words(form, language);
				spoken[spoken.length - 1] = `${spoken[spoken.length - 1]}${suffix}`;
				return spoken;
			}
		}
	}
	return null;
}

/** Each listed prose symbol replaced by its words, the text between kept as it is. */
function replaceProseSymbols(
	text: string,
	language: ReadingLanguage,
): { tokens: string[]; replaced: boolean } {
	const tokens: string[] = [];
	let run = "";
	let replaced = false;
	let i = 0;
	while (i < text.length) {
		const hit = PROSE_SYMBOLS.find(
			([symbol]) =>
				text.startsWith(symbol, i) &&
				(symbol.length === 1 || !isLetter(at(text, i + symbol.length))),
		);
		if (hit) {
			if (run !== "") tokens.push(run);
			run = "";
			tokens.push(...words(hit[1], language));
			replaced = true;
			i += hit[0].length;
		} else {
			run += text.charAt(i);
			i += 1;
		}
	}
	if (run !== "") tokens.push(run);
	return { tokens, replaced };
}

function speakProse(shown: string, language: ReadingLanguage): string[] {
	// 1. A word with no letter, no digit and no listed symbol is not said.
	if (!/[\p{L}\p{Nd}]/u.test(shown) && !hasProseSymbol(shown)) return [];
	const lead = LEADING_MARKS.exec(shown)?.[0] ?? "";
	const rest = shown.slice(lead.length);
	const trail = TRAILING_MARKS.exec(rest)?.[0] ?? "";
	const core = rest.slice(0, rest.length - trail.length);

	// 2. An address, or an email address.
	const address = findAddress(core, language);
	if (address) return withTrailing(address.tokens, trail);
	const email = emailTokens(core, language);
	if (email) return withTrailing(email, trail);
	// 3. A file name.
	const file = fileNameTokens(core, language);
	if (file) return withTrailing(file, trail);
	// 4. A shortcut.
	const shortcut = shortcutTokens(core, language);
	if (shortcut) return withTrailing(shortcut, trail);
	// 5. A version.
	const version = VERSION.exec(core);
	if (version?.[1])
		return withTrailing([LINKING_WORDS.version[language], version[1]], trail);
	// 6. An abbreviation of the paragraph's language.
	const abbreviation = abbreviationTokens(core, trail, language);
	if (abbreviation) return abbreviation;
	// 7. An acronym.
	const acronym = acronymTokens(core, language);
	if (acronym) return withTrailing(acronym, trail);
	// 8. For the speech service: it reads numbers and units.
	if (/^\p{Nd}/u.test(rest) || SUPERSCRIPT_UNIT.test(core)) return [shown];
	// 9. Words an em dash joins ("eggs—one at a time—then") are said with a pause between them.
	const dashed = core.split(JOINING_DASH);
	if (dashed.length > 1) {
		const parts = dashed.map((part, i) =>
			i < dashed.length - 1 ? `${part},` : part,
		);
		parts[0] = `${lead}${parts[0]}`;
		return withTrailing(parts, trail);
	}
	// 10. Otherwise the word as written, a listed symbol said as its words.
	const { tokens, replaced } = replaceProseSymbols(core, language);
	return replaced ? withTrailing(tokens, trail) : [shown];
}

// ---------------------------------------------------------------------------
// Code
// ---------------------------------------------------------------------------

const CLOSING_TAG = /^<\/([a-z][a-z0-9-]*)>/u;
const OPENING_TAG = /^<([a-z][a-z0-9-]*)\/?>/u;
const HEX = /^0[xX][0-9A-Fa-f_]+/u;
const TAG = /^<(\/?)([a-z][a-z0-9-]*)(?:\/?>|$)/u;
const NUMBER = /^[0-9][0-9_]*(?:\.[0-9]+)?/u;
const NAME = /^[\p{L}\p{Nd}_$]+/u;
const DOTTED_DIGITS = /^[0-9]+(?:\.[0-9]+){2,}$/u;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
/** The symbols of the dictionary, longest first. */
const SYMBOLS = Object.keys(CODE_SYMBOLS).sort((a, b) => b.length - a.length);

type Lexeme = { tokens: string[]; length: number };

/** A hash, a UUID or a key: letters and digits that switch back and forth. */
function isOpaqueId(word: string): boolean {
	if (!/^[A-Za-z0-9_-]+$/u.test(word)) return false;
	const chars = [...word].filter((c) => /[A-Za-z0-9]/u.test(c));
	if (chars.length < 12) return false;
	if (chars.filter(isAsciiDigit).length < 3) return false;
	let switches = 0;
	for (let i = 1; i < chars.length; i++)
		if (isAsciiDigit(chars[i]) !== isAsciiDigit(chars[i - 1])) switches += 1;
	return switches >= 4;
}

type NameClass = "separator" | "upper" | "lower" | "digit";

function classOf(c: string): NameClass {
	if (c === "_" || c === "$") return "separator";
	if (/\p{Lu}/u.test(c)) return "upper";
	if (/\p{L}/u.test(c)) return "lower";
	return /\p{Nd}/u.test(c) ? "digit" : "separator";
}

/**
 * The pieces of a name: at `_` and `$`, between a lower-case letter or a digit
 * and a capital, before the last capital of a run followed by a lower-case
 * letter ("XML Http Request"), and between letters and digits.
 */
function splitName(name: string): string[] {
	const chars = [...name];
	const pieces: string[] = [];
	let current = "";
	for (let i = 0; i < chars.length; i++) {
		const char = chars[i] ?? "";
		const kind = classOf(char);
		if (kind === "separator") {
			if (current !== "") pieces.push(current);
			current = "";
			continue;
		}
		const previous = i > 0 ? classOf(chars[i - 1] ?? "") : "separator";
		const next =
			i + 1 < chars.length ? classOf(chars[i + 1] ?? "") : "separator";
		const boundary =
			(kind === "upper" && (previous === "lower" || previous === "digit")) ||
			(kind === "upper" && previous === "upper" && next === "lower") ||
			(kind === "digit" && (previous === "lower" || previous === "upper")) ||
			(kind === "lower" && previous === "digit");
		if (boundary && current !== "") {
			pieces.push(current);
			current = "";
		}
		current += char;
	}
	if (current !== "") pieces.push(current);
	return pieces;
}

function acronymForm(lowerName: string): SpokenForm | null {
	return (
		ACRONYMS.find(({ written }) => written.toLowerCase() === lowerName)?.form ??
		null
	);
}

/** A name: a dunder, a code word or an acronym that is the whole name, or its pieces. */
function readName(raw: string, language: ReadingLanguage): string[] {
	const name = raw.replace(/^\$+/u, "");
	if (name === "") return [];
	const dunder = /^__(.+?)__$/u.exec(name);
	if (dunder?.[1] && /[\p{L}\p{Nd}]/u.test(dunder[1]))
		return [
			...words(CODE_CONTEXT_WORDS.dunder, language),
			...readName(dunder[1], language),
		];
	const lower = name.toLowerCase();
	const word = CODE_WORDS[lower];
	if (word) return words(word, language);
	const whole = acronymForm(lower);
	if (whole) return words(whole, language);

	// A name of two or more letters that is all capitals has its other pieces
	// lower-cased ("max size"); a one-letter name stays ("T").
	const letters = name.replace(/[^\p{L}]/gu, "");
	const capitalsOnly =
		[...letters].length >= 2 &&
		letters === letters.toUpperCase() &&
		letters !== letters.toLowerCase();
	const out: string[] = [];
	for (const piece of splitName(name)) {
		if (/^[0-9]+$/u.test(piece)) {
			out.push(numberText(piece, language));
			continue;
		}
		const acronym = acronymForm(piece.toLowerCase());
		if (acronym) out.push(...words(acronym, language));
		else out.push(capitalsOnly ? piece.toLowerCase() : piece);
	}
	return out;
}

/**
 * A tag that `lexCode` does not take at the word's start: a closing tag
 * anywhere (`<b>x</b>`), and an opening tag straight after another tag. After a
 * name `<…>` is a type parameter, so an opening tag there is not one.
 */
function lexTag(
	word: string,
	start: number,
	language: ReadingLanguage,
): Lexeme | null {
	const rest = word.slice(start);
	const closing = CLOSING_TAG.exec(rest);
	if (closing)
		return {
			tokens: [
				...words(CODE_CONTEXT_WORDS.closing, language),
				closing[1] ?? "",
				...words(CODE_CONTEXT_WORDS.tag, language),
			],
			length: closing[0].length,
		};
	if (at(word, start - 1) !== ">") return null;
	const opening = OPENING_TAG.exec(rest);
	return opening
		? {
				tokens: [opening[1] ?? "", ...words(CODE_CONTEXT_WORDS.tag, language)],
				length: opening[0].length,
			}
		: null;
}

/** `<…>` straight after a name, or as the whole word: a type parameter. */
function lexGeneric(
	word: string,
	start: number,
	shell: boolean,
	language: ReadingLanguage,
): Lexeme | null {
	if (start > 0 && !isNameChar(at(word, start - 1))) return null;
	let depth = 0;
	for (let j = start; j < word.length; j++) {
		const c = word.charAt(j);
		if (c === "<") depth += 1;
		else if (c === ">") {
			depth -= 1;
			if (depth === 0) {
				const inner = lexCode(word.slice(start + 1, j), shell, language);
				// What reads as nothing is skipped whole: reading it again from
				// the outside doubled the work with every level of nesting.
				if (inner.length === 0) return { tokens: [], length: j + 1 - start };
				const of = words(CODE_CONTEXT_WORDS.ofType, language);
				return {
					tokens: language === "en" ? [...of, ...inner] : [...inner, ...of],
					length: j + 1 - start,
				};
			}
		}
	}
	return null;
}

/** A symbol of the dictionary, said or dropped by what stands around it. */
function symbolTokens(
	symbol: string,
	word: string,
	start: number,
	language: ReadingLanguage,
): string[] {
	const spoken = words(CODE_SYMBOLS[symbol] as SpokenForm, language);
	const before = at(word, start - 1);
	const after = at(word, start + symbol.length);
	switch (symbol) {
		case "<":
		case ">":
		case "<=":
		case ">=":
			// A comparison stands alone or has a name or a number on each side.
			return word === symbol || (isNameChar(before) && isNameChar(after))
				? spoken
				: [];
		case "-":
			return isLetter(before) && isLetter(after) ? [] : spoken;
		case "!":
			return isNameChar(before) ? [] : spoken;
		default:
			return spoken;
	}
}

const isPathNeighbour = (c: string | undefined): boolean =>
	isNameChar(c) || c === "." || c === "~";

/** `.`, `%`, `|`, `/` and `~`, which are said only where they mean something. Null for any other character. */
function contextSymbolTokens(
	c: string,
	word: string,
	start: number,
	shell: boolean,
	language: ReadingLanguage,
): string[] | null {
	const before = at(word, start - 1);
	const after = at(word, start + 1);
	switch (c) {
		case ".":
			// A full stop after inline code is the sentence's, not a dot.
			return isNameChar(after) ? words(CODE_CONTEXT_WORDS.dot, language) : [];
		case "%":
			return isAsciiDigit(before) && !isNameChar(after)
				? words(CODE_CONTEXT_WORDS.percent, language)
				: words(CODE_CONTEXT_WORDS.mod, language);
		case "|":
			return shell ? words(CODE_CONTEXT_WORDS.pipe, language) : [];
		case "/":
			return isPathNeighbour(before) || isPathNeighbour(after)
				? words(CODE_CONTEXT_WORDS.slash, language)
				: [];
		case "~":
			return shell || after === "/"
				? words(CODE_CONTEXT_WORDS.home, language)
				: [];
		default:
			return null;
	}
}

function lexAt(
	word: string,
	start: number,
	shell: boolean,
	language: ReadingLanguage,
): Lexeme {
	const c = word.charAt(start);
	if (word.startsWith("std::", start) && !isNameChar(at(word, start - 1)))
		return { tokens: words(CODE_WORDS.std as SpokenForm, language), length: 5 };
	if (c === "<") {
		const tag = lexTag(word, start, language);
		if (tag) return tag;
	}
	if (c === "<" && at(word, start + 1) !== "=") {
		const generic = lexGeneric(word, start, shell, language);
		if (generic) return generic;
	}
	const symbol = SYMBOLS.find((s) => word.startsWith(s, start));
	if (symbol)
		return {
			tokens: symbolTokens(symbol, word, start, language),
			length: symbol.length,
		};
	const context = contextSymbolTokens(c, word, start, shell, language);
	if (context) return { tokens: context, length: 1 };
	if (isAsciiDigit(c)) {
		// A hexadecimal literal is one token as written, not "zero x one F".
		const hex = HEX.exec(word.slice(start));
		if (hex)
			return { tokens: [hex[0].replace(/_/gu, "")], length: hex[0].length };
		const number = NUMBER.exec(word.slice(start));
		if (number)
			return {
				tokens: [numberText(number[0], language)],
				length: number[0].length,
			};
	}
	const name = NAME.exec(word.slice(start));
	if (name)
		return { tokens: readName(name[0], language), length: name[0].length };
	// Anything else, brackets and quotes included, is dropped.
	return { tokens: [], length: 1 };
}

/** Read left to right, longest match first. */
function lexCode(
	word: string,
	shell: boolean,
	language: ReadingLanguage,
): string[] {
	const out: string[] = [];
	let i = 0;
	const tag = TAG.exec(word);
	if (tag) {
		if (tag[1]) out.push(...words(CODE_CONTEXT_WORDS.closing, language));
		out.push(tag[2] ?? "", ...words(CODE_CONTEXT_WORDS.tag, language));
		i = tag[0].length;
	}
	while (i < word.length) {
		const lexeme = lexAt(word, i, shell, language);
		out.push(...lexeme.tokens);
		i += lexeme.length;
	}
	return out;
}

function speakCode(
	shown: string,
	shell: boolean,
	language: ReadingLanguage,
): string[] {
	const address = findAddress(shown, language);
	if (address)
		return [
			...lexCode(address.before, shell, language),
			...address.tokens,
			...lexCode(address.after, shell, language),
		];
	const email = emailTokens(shown, language);
	if (email) return email;
	if (isOpaqueId(shown)) return [];
	const version = VERSION.exec(shown);
	if (version?.[1]) return [LINKING_WORDS.version[language], version[1]];
	if (DOTTED_DIGITS.test(shown) || DATE.test(shown)) return [shown];
	return lexCode(shown, shell, language);
}

// ---------------------------------------------------------------------------
// List numbers
// ---------------------------------------------------------------------------

/** "3." is "Three."; from 100 on the digits and a comma. */
function speakListNumber(shown: string, language: ReadingLanguage): string[] {
	const match = /^(\d{1,4})[.)]$/u.exec(shown);
	if (!match?.[1]) return [];
	const n = Number(match[1]);
	return n <= 99 ? [`${capitalize(numberWord(n, language))}.`] : [`${n},`];
}

// ---------------------------------------------------------------------------
// The public surface
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Simple math (the owner's staging find, 2026-11-17)
// ---------------------------------------------------------------------------

/**
 * The delimiters the page may show around TeX: `$$…$$`, `$…$`, `\(…\)` and `\[…\]`,
 * or the plain brackets marked leaves of `\(…\)` and `\[…\]`.
 */
const MATH_DELIMITERS: ReadonlyArray<readonly [string, string]> = [
	["$$", "$$"],
	["$", "$"],
	["\\(", "\\)"],
	["\\[", "\\]"],
	["(", ")"],
	["[", "]"],
];

type MathWord = keyof typeof MATH_WORDS;

const MATH_OPERATOR_CHARS: Readonly<Record<string, MathWord>> = {
	"=": "equals",
	"+": "plus",
	"-": "minus",
	"\u2212": "minus",
	// An en dash between numbers in a sum (`ARITHMETIC` in the speech script).
	"\u2013": "minus",
	"×": "times",
	"·": "times",
	"*": "times",
	"÷": "dividedBy",
	"/": "over",
	"±": "plusOrMinus",
	"≈": "approximately",
	"≠": "notEqual",
	"<": "lessThan",
	">": "greaterThan",
	"≤": "atMost",
	"≥": "atLeast",
};

const MATH_OPERATOR_COMMANDS: Readonly<Record<string, MathWord>> = {
	times: "times",
	cdot: "times",
	ast: "times",
	div: "dividedBy",
	pm: "plusOrMinus",
	approx: "approximately",
	neq: "notEqual",
	ne: "notEqual",
	leq: "atMost",
	le: "atMost",
	geq: "atLeast",
	ge: "atLeast",
	lt: "lessThan",
	gt: "greaterThan",
};

/** Commands that only space the formula or size the bracket after them. */
const MATH_SILENT_COMMANDS: ReadonlySet<string> = new Set([
	"left",
	"right",
	"quad",
	"qquad",
	",",
	";",
	":",
	"!",
	" ",
]);
const MATH_FRACTIONS: ReadonlySet<string> = new Set(["frac", "dfrac", "tfrac"]);
const MATH_TEXT_COMMANDS: ReadonlySet<string> = new Set([
	"text",
	"textrm",
	"textit",
	"mathrm",
	"mathit",
	"operatorname",
]);
const MATH_CURRENCIES: ReadonlySet<string> = new Set(["€", "£", "$"]);
const ASCII_LETTER = /^[A-Za-z]$/u;

/**
 * Reads one formula: numbers, letters, the operators of `MATH_WORDS`, `\frac{a}{b}`,
 * powers and `\sqrt{x}`. Every method answers null at anything else, and then the
 * whole formula is left unsaid, as every formula was before. `plain` is a sum written
 * in a sentence, with no TeX in it ("1,000 + 2,000 = 3,000"): its numbers are read as
 * written, but for their commas (`writtenNumber`).
 */
class MathReader {
	private i = 0;

	constructor(
		private readonly text: string,
		private readonly language: ReadingLanguage,
		private readonly plain: boolean,
	) {}

	private say(word: MathWord): string[] {
		return words(MATH_WORDS[word], this.language);
	}

	private skipSpaces() {
		while (this.i < this.text.length && /[\s~]/u.test(this.text.charAt(this.i)))
			this.i += 1;
	}

	/** Up to the end, or up to the "}" that closes a group (`inGroup`). */
	expression(inGroup: boolean): string[] | null {
		const out: string[] = [];
		while (this.i < this.text.length) {
			const c = this.text.charAt(this.i);
			if (/[\s~]/u.test(c) || "()[].".includes(c)) {
				this.i += 1;
				continue;
			}
			if (c === "}") {
				if (!inGroup) return null;
				this.i += 1;
				return out;
			}
			const tokens = this.item(c, out);
			if (tokens === null) return null;
			out.push(...tokens);
		}
		return inGroup ? null : out;
	}

	/** One item at `c`; `out` is what came before, for a percent sign or a comma. */
	private item(c: string, out: string[]): string[] | null {
		if (c === "{") {
			this.i += 1;
			return this.expression(true);
		}
		if (c === ",") {
			this.i += 1;
			const last = out[out.length - 1];
			if (last !== undefined && !/[,.;:]$/u.test(last))
				out[out.length - 1] = `${last},`;
			return [];
		}
		if (c === "%") {
			this.i += 1;
			return this.percent(out);
		}
		if (c === "^") {
			// A power needs something to raise: "^note" alone is a footnote, not math.
			if (out.length === 0) return null;
			this.i += 1;
			return this.power();
		}
		if (isAsciiDigit(c)) return this.number(null);
		if (MATH_CURRENCIES.has(c)) {
			this.i += 1;
			return this.currency(c);
		}
		if (ASCII_LETTER.test(c)) {
			this.i += 1;
			return [c];
		}
		const operator = MATH_OPERATOR_CHARS[c];
		if (operator) {
			this.i += 1;
			return this.say(operator);
		}
		if (c === "\\") return this.command(out);
		return null;
	}

	private command(out: string[]): string[] | null {
		this.i += 1;
		const first = this.text.charAt(this.i);
		if (!ASCII_LETTER.test(first)) {
			this.i += 1;
			if (first === "%") return this.percent(out);
			if (first === "$") return this.currency("$");
			return MATH_SILENT_COMMANDS.has(first) ? [] : null;
		}
		let name = "";
		while (ASCII_LETTER.test(this.text.charAt(this.i))) {
			name += this.text.charAt(this.i);
			this.i += 1;
		}
		if (MATH_SILENT_COMMANDS.has(name)) return [];
		const operator = MATH_OPERATOR_COMMANDS[name];
		if (operator) return this.say(operator);
		if (MATH_FRACTIONS.has(name)) {
			const top = this.group();
			const bottom = top && this.group();
			return top && bottom ? [...top, ...this.say("over"), ...bottom] : null;
		}
		if (name === "sqrt") {
			this.skipSpaces();
			if (this.text.charAt(this.i) === "[") return null;
			const under = this.group();
			return under ? [...this.say("squareRootOf"), ...under] : null;
		}
		if (MATH_TEXT_COMMANDS.has(name)) return this.textGroup();
		return null;
	}

	/** `{…}`, or the one digit or letter TeX takes as a group (`\frac12`). */
	private group(): string[] | null {
		this.skipSpaces();
		const c = this.text.charAt(this.i);
		if (c === "{") {
			this.i += 1;
			return this.expression(true);
		}
		if (isAsciiDigit(c) || ASCII_LETTER.test(c)) {
			this.i += 1;
			return [c];
		}
		return null;
	}

	/** `\text{…}`: its words, letters and digits only. */
	private textGroup(): string[] | null {
		this.skipSpaces();
		if (this.text.charAt(this.i) !== "{") return null;
		const end = this.text.indexOf("}", this.i);
		if (end === -1) return null;
		const inner = this.text.slice(this.i + 1, end).trim();
		this.i = end + 1;
		const parts = inner === "" ? [] : inner.split(/\s+/u);
		return parts.every((part) => /^[\p{L}\p{Nd}]+$/u.test(part)) ? parts : null;
	}

	/** "x squared", "x to the power of n"; in Hungarian "x a 10. hatványon", "x az n-edik hatványon". */
	private power(): string[] | null {
		const exponent = this.group();
		if (!exponent || exponent.length === 0) return null;
		const only = exponent.length === 1 ? exponent[0] : undefined;
		if (only === "2") return this.say("squared");
		if (only === "3") return this.say("cubed");
		if (this.language === "en")
			return [...this.say("toThePowerOf"), ...exponent];
		if (only === undefined) return null;
		const power = this.say("toThePowerOf");
		if (/^[0-9]{1,4}$/u.test(only)) {
			// The article goes by the ordinal's first sound: "az első", "az ötödik", "az ezredik".
			const vowel =
				only === "1" ||
				only.startsWith("5") ||
				(only.length === 4 && only.startsWith("1"));
			return [vowel ? "az" : "a", `${only}.`, ...power];
		}
		const letter = HUNGARIAN_LETTER_POWERS[only];
		return letter ? [...letter.split(" "), ...power] : null;
	}

	/** After a number "50%", which the speech service reads; else the word. */
	private percent(out: string[]): string[] {
		const last = out[out.length - 1];
		if (last !== undefined && /[0-9]$/u.test(last)) {
			out[out.length - 1] = `${last}%`;
			return [];
		}
		return this.say("percent");
	}

	private currency(symbol: string): string[] | null {
		this.skipSpaces();
		return isAsciiDigit(this.text.charAt(this.i)) ? this.number(symbol) : null;
	}

	private digits(): string {
		let run = "";
		while (isAsciiDigit(this.text.charAt(this.i))) {
			run += this.text.charAt(this.i);
			this.i += 1;
		}
		return run;
	}

	/**
	 * A number goes to the speech service whole, written the way its language's
	 * normalizer reads it. A currency goes before it in English ("€4341.0505") and
	 * after it in Hungarian ("4341,0505 €").
	 */
	private number(before: string | null): string[] | null {
		const value = this.plain ? this.writtenNumber() : this.texNumber();
		if (value === null) return null;
		let symbol = before;
		if (symbol === null) {
			const save = this.i;
			this.skipSpaces();
			const next = this.text.charAt(this.i);
			if (next === "€" || next === "£") {
				symbol = next;
				this.i += 1;
			} else this.i = save;
		}
		if (symbol === null) return [value];
		return this.language === "en" ? [`${symbol}${value}`] : [value, symbol];
	}

	/**
	 * A number in TeX, as its language's normalizer reads it ("4341.0505"; "4341,0505"
	 * in Hungarian, whose comma is the decimal mark). `{,}` groups thousands; a single
	 * `{,}` before other than three digits is a decimal comma ("3{,}14").
	 */
	private texNumber(): string | null {
		const groups = [this.digits()];
		while (
			this.text.startsWith("{,}", this.i) &&
			isAsciiDigit(this.text.charAt(this.i + 3))
		) {
			this.i += 3;
			groups.push(this.digits());
		}
		let fraction: string | null = null;
		if (
			this.text.charAt(this.i) === "." &&
			isAsciiDigit(this.text.charAt(this.i + 1))
		) {
			this.i += 1;
			fraction = this.digits();
		}
		let whole = groups.join("");
		if (fraction === null && groups.slice(1).some((g) => g.length !== 3)) {
			if (groups.length !== 2) return null;
			whole = groups[0] ?? "";
			fraction = groups[1] ?? "";
		}
		return fraction === null
			? whole
			: `${whole}${this.language === "hu" ? "," : "."}${fraction}`;
	}

	/**
	 * A number in a plain sum, as written but for its commas (the third re-walk's
	 * New 4). A "," before three digits groups thousands, as `{,}` does in TeX, and is
	 * dropped: the Hungarian normalizer reads "1,000" as a decimal. A single "," before
	 * other than three digits is a decimal comma, written with the language's mark
	 * ("1,5"; "1.5" in English, whose normalizer reads "1,5" as "one,five"). A "." stays
	 * as written, since each normalizer reads it its own way ("3.75"; in Hungarian
	 * "1.000" is a thousand).
	 */
	private writtenNumber(): string | null {
		let value = this.digits();
		let decimal = false;
		while (
			(this.text.charAt(this.i) === "," || this.text.charAt(this.i) === ".") &&
			isAsciiDigit(this.text.charAt(this.i + 1))
		) {
			const mark = this.text.charAt(this.i);
			this.i += 1;
			const group = this.digits();
			if (mark === ".") value += `.${group}`;
			else if (decimal) return null;
			else if (group.length === 3) value += group;
			else {
				value += `${this.language === "hu" ? "," : "."}${group}`;
				decimal = true;
			}
		}
		return value;
	}
}

/** A formula the page shows as TeX, or a sum written in a sentence, read as simple math; null when any part of it is not. */
function readMath(shown: string, language: ReadingLanguage): string[] | null {
	let text = shown.trim();
	for (const [open, close] of MATH_DELIMITERS) {
		if (
			text.length >= open.length + close.length &&
			text.startsWith(open) &&
			text.endsWith(close)
		) {
			text = text.slice(open.length, text.length - close.length);
			break;
		}
	}
	// A sum in a sentence (`ARITHMETIC` in the speech script) holds no TeX mark at all.
	const plain = !/[\\^_{}$]/u.test(shown);
	const tokens = new MathReader(text, language, plain).expression(false);
	return tokens && tokens.length > 0 ? tokens : null;
}

/**
 * Whether a formula the page shows as TeX is simple math, read aloud as a `math`
 * word in at least one language; else it is left unsaid, as before.
 */
export function isSimpleMath(shown: string): boolean {
	return readMath(shown, "en") !== null || readMath(shown, "hu") !== null;
}

/**
 * The tokens one written word (a run with no whitespace) is spoken as, or `[]`
 * when it is not spoken. Every token is 1–80 characters with no whitespace, and
 * a word whose reading would pass 40 tokens or 160 characters gives `[]`.
 */
export function speakWord(
	shown: string,
	kind: WordKind,
	language: ReadingLanguage,
): string[] {
	if (kind === "listNumber") return limit(speakListNumber(shown, language));
	if (kind === "prose") return limit(speakProse(shown, language));
	if (kind === "math") return limit(readMath(shown, language) ?? []);
	// A code word this long is not a name or an expression: it is never said, and
	// never read, so no word can take the thread (both sides run this function).
	if (shown.length > MAX_CODE_WORD_CHARS) return [];
	return limit(speakCode(shown, kind === "shell", language));
}

/**
 * The site name a word is spoken as when it is an address ("bbc.com" for
 * "https://www.bbc.com/news/x"): no scheme, credentials, port, path or `www.`.
 * Null when the word is no address. This is how a PROSE word is read (an
 * address there is spoken as its host alone), and the session route searches the
 * reply for it, and not for the whole address, because the page may show the
 * address only by its host, as a source chip does. A code word also speaks the
 * names around its address, so it is searched whole.
 */
export function addressHost(shown: string): string | null {
	const lead = LEADING_MARKS.exec(shown)?.[0] ?? "";
	const rest = shown.slice(lead.length);
	const trail = TRAILING_MARKS.exec(rest)?.[0] ?? "";
	const core = rest.slice(0, rest.length - trail.length);
	return findAddress(core, "en")?.host || null;
}

/** An arrow or a separator dot between items in prose. */
export function isSeparator(shown: string): boolean {
	return SEPARATORS.has(shown);
}

/**
 * True when `before` (the text up to a sentence boundary) ends in a number and
 * a period ("16.") or in one of the language's abbreviations, as a whole word,
 * written as listed or with a capital first letter ("pl.", "Pl.", "e.g.").
 */
export function keepsSentenceOpen(
	before: string,
	language: ReadingLanguage,
): boolean {
	const text = before.trimEnd();
	if (/[0-9]\.$/u.test(text)) return true;
	for (const [written] of PROSE_ABBREVIATIONS[language]) {
		if (!written.endsWith(".")) continue;
		for (const form of [written, capitalize(written)]) {
			if (!text.endsWith(form)) continue;
			const beforeForm = at(text, text.length - form.length - 1);
			if (beforeForm === undefined || !/[\p{L}\p{Nd}]/u.test(beforeForm))
				return true;
		}
	}
	return false;
}

/**
 * Whether code is a shell's: a block in a shell language, or inline code (or a
 * block with no language) that starts with one of the shell's commands.
 */
export function codeKindOf(
	blockLanguage: string,
	firstWord: string,
): "code" | "shell" {
	const language = blockLanguage.trim().toLowerCase();
	if (SHELL_LANGUAGES.has(language)) return "shell";
	return language === "" && SHELL_COMMANDS.has(firstWord) ? "shell" : "code";
}
