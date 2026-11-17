// The reading dictionary: data only. How read aloud says code, addresses,
// abbreviations, symbols, shortcuts, versions and numbers, in English and
// Hungarian (spec §4.4, refined 2026-11-16; Plan 2, Task 0).
//
// The English forms are the spec's. The Hungarian ones the spec does not give
// are the plan's (Decision 11): spelled the way a Hungarian teacher says them
// aloud, for the Hungarian voice, until the owner hears them. A form of several
// words becomes several tokens. Only `spoken-forms.ts` imports this file: the
// rules that choose between forms (context, case, marks) live there.

/** One spoken form, in both languages. */
export type SpokenForm = { en: string; hu: string };

/**
 * Code symbols, by what is written. Context decides whether a symbol is said
 * at all (a minus between two letters, a `<` between operands, a `|` outside
 * the shell): the rules are in `spoken-forms.ts`.
 */
export const CODE_SYMBOLS: Readonly<Record<string, SpokenForm>> = {
	"::": { en: "double colon", hu: "dupla kettőspont" },
	":=": { en: "colon equals", hu: "kettőspont egyenlő" },
	"->": { en: "arrow", hu: "nyíl" },
	"=>": { en: "arrow", hu: "nyíl" },
	"=": { en: "equals", hu: "egyenlő" },
	"==": { en: "double equals", hu: "dupla egyenlő" },
	"===": { en: "triple equals", hu: "tripla egyenlő" },
	"!=": { en: "not equals", hu: "nem egyenlő" },
	"!==": { en: "not double equals", hu: "nem dupla egyenlő" },
	"<": { en: "less than", hu: "kisebb mint" },
	">": { en: "greater than", hu: "nagyobb mint" },
	"<=": { en: "less than or equal", hu: "kisebb vagy egyenlő" },
	">=": { en: "greater than or equal", hu: "nagyobb vagy egyenlő" },
	"+": { en: "plus", hu: "plusz" },
	"-": { en: "minus", hu: "mínusz" },
	"++": { en: "plus plus", hu: "plusz plusz" },
	"--": { en: "minus minus", hu: "mínusz mínusz" },
	"+=": { en: "plus equals", hu: "plusz egyenlő" },
	"-=": { en: "minus equals", hu: "mínusz egyenlő" },
	"!": { en: "not", hu: "nem" },
	"&&": { en: "and", hu: "és" },
	"||": { en: "or", hu: "vagy" },
	"*": { en: "star", hu: "csillag" },
};

/** The words that code symbols and names say only in some contexts. */
export const CODE_CONTEXT_WORDS = {
	dot: { en: "dot", hu: "pont" },
	/** `%` between names or numbers. */
	mod: { en: "mod", hu: "modulo" },
	/** `%` straight after a number, with no name or number after it (`width: 50%`). */
	percent: { en: "percent", hu: "százalék" },
	/** `|` in the shell. */
	pipe: { en: "pipe", hu: "pájp" },
	/** `/` in a path. */
	slash: { en: "slash", hu: "per" },
	/** `~` in the shell, or straight before `/`. */
	home: { en: "home", hu: "hóm" },
	/** A `<…>` straight after a name: English says it before the type, Hungarian after. */
	ofType: { en: "of", hu: "típusú" },
	tag: { en: "tag", hu: "tag" },
	closing: { en: "closing", hu: "záró" },
	/** `__name__`. */
	dunder: { en: "dunder", hu: "dander" },
} as const satisfies Record<string, SpokenForm>;

/** A name that is the whole word, in any case. The keys are lower case. */
export const CODE_WORDS: Readonly<Record<string, SpokenForm>> = {
	println: { en: "print line", hu: "print lájn" },
	printf: { en: "print f", hu: "print ef" },
	def: { en: "define", hu: "definiál" },
	elif: { en: "else if", hu: "elsz if" },
	kwargs: { en: "keyword args", hu: "kulcsszavas argumentumok" },
	len: { en: "length", hu: "hossz" },
	nan: { en: "not a number", hu: "nem szám" },
	console: { en: "console", hu: "konzol" },
	std: { en: "standard", hu: "standard" },
	cout: { en: "c out", hu: "szí aut" },
	include: { en: "include", hu: "inklúd" },
	fmt: { en: "format", hu: "format" },
	fn: { en: "function", hu: "függvény" },
	fun: { en: "function", hu: "függvény" },
	func: { en: "function", hu: "függvény" },
	mut: { en: "mutable", hu: "módosítható" },
	select: { en: "select", hu: "szelekt" },
	chmod: { en: "change mode", hu: "cséndzs mód" },
};

/**
 * Acronyms, as written in prose. In code they are matched in any case (a name
 * `sql` or a piece of `getHTMLPage`).
 */
export const ACRONYMS: ReadonlyArray<{ written: string; form: SpokenForm }> = [
	{ written: "SQL", form: { en: "S Q L", hu: "esz kú el" } },
	{ written: "API", form: { en: "A P I", hu: "á pé í" } },
	{ written: "URL", form: { en: "U R L", hu: "ú er el" } },
	{ written: "HTML", form: { en: "H T M L", hu: "há té em el" } },
	{ written: "CSS", form: { en: "C S S", hu: "cé esz esz" } },
	{ written: "npm", form: { en: "N P M", hu: "en pé em" } },
	{ written: "JSON", form: { en: "Jason", hu: "dzséjszon" } },
	{ written: "YAML", form: { en: "yamel", hu: "jemel" } },
	{ written: "GUI", form: { en: "gooey", hu: "gúi" } },
];

/** Abbreviations in prose, each only in a paragraph of its own language. */
export const PROSE_ABBREVIATIONS: Readonly<
	Record<"en" | "hu", ReadonlyArray<readonly [written: string, spoken: string]>>
> = {
	en: [
		["e.g.", "for example"],
		["i.e.", "that is"],
		["etc.", "et cetera"],
	],
	hu: [
		["pl.", "például"],
		["kb.", "körülbelül"],
		["stb.", "és a többi"],
		["ún.", "úgynevezett"],
		["ill.", "illetve"],
		["db", "darab"],
	],
};

/** Symbols in prose. Longest first: `°C` and `°F` come before `°`. */
export const PROSE_SYMBOLS: ReadonlyArray<readonly [string, SpokenForm]> = [
	["°C", { en: "degrees Celsius", hu: "Celsius-fok" }],
	["°F", { en: "degrees Fahrenheit", hu: "Fahrenheit-fok" }],
	["°", { en: "degrees", hu: "fok" }],
	["×", { en: "times", hu: "szorozva" }],
	["÷", { en: "divided by", hu: "osztva" }],
	// Two words, not the spec's "plusz-mínusz": the speech service's "két" rule
	// then sees "plusz" and keeps "kettő" before it.
	["±", { en: "plus or minus", hu: "plusz mínusz" }],
	["≤", { en: "less than or equal to", hu: "kisebb vagy egyenlő" }],
	["≥", { en: "greater than or equal to", hu: "nagyobb vagy egyenlő" }],
	["≠", { en: "not equal to", hu: "nem egyenlő" }],
	["≈", { en: "approximately", hu: "körülbelül" }],
	["²", { en: "squared", hu: "négyzet" }],
	["³", { en: "cubed", hu: "köb" }],
	["½", { en: "half", hu: "fél" }],
	["%", { en: "percent", hu: "százalék" }],
];

/** Keyboard modifiers, by lower-case name or glyph. */
export const SHORTCUT_MODIFIERS: Readonly<Record<string, SpokenForm>> = {
	ctrl: { en: "Control", hu: "kontrol" },
	control: { en: "Control", hu: "kontrol" },
	"⌃": { en: "Control", hu: "kontrol" },
	cmd: { en: "Command", hu: "kommand" },
	command: { en: "Command", hu: "kommand" },
	"⌘": { en: "Command", hu: "kommand" },
	shift: { en: "Shift", hu: "sift" },
	"⇧": { en: "Shift", hu: "sift" },
	alt: { en: "Alt", hu: "alt" },
	option: { en: "Option", hu: "opsön" },
	opt: { en: "Option", hu: "opsön" },
	"⌥": { en: "Option", hu: "opsön" },
};

/** The words that link a written address, email address or version. */
export const LINKING_WORDS = {
	version: { en: "version", hu: "verzió" },
	at: { en: "at", hu: "kukac" },
	dot: { en: "dot", hu: "pont" },
} as const satisfies Record<string, SpokenForm>;

/**
 * Number words. `tens[i]` is the word for i × 10 (index 0 and 1 are unused);
 * `tensBeforeOnes[i]` is the Hungarian form of it that a ones word follows
 * ("huszon" + "egy").
 */
export const NUMBER_WORDS = {
	en: {
		ones: [
			"zero",
			"one",
			"two",
			"three",
			"four",
			"five",
			"six",
			"seven",
			"eight",
			"nine",
			"ten",
			"eleven",
			"twelve",
			"thirteen",
			"fourteen",
			"fifteen",
			"sixteen",
			"seventeen",
			"eighteen",
			"nineteen",
		],
		tens: [
			"",
			"",
			"twenty",
			"thirty",
			"forty",
			"fifty",
			"sixty",
			"seventy",
			"eighty",
			"ninety",
		],
		tensBeforeOnes: [
			"",
			"",
			"twenty-",
			"thirty-",
			"forty-",
			"fifty-",
			"sixty-",
			"seventy-",
			"eighty-",
			"ninety-",
		],
	},
	hu: {
		ones: [
			"nulla",
			"egy",
			"kettő",
			"három",
			"négy",
			"öt",
			"hat",
			"hét",
			"nyolc",
			"kilenc",
			"tíz",
			"tizenegy",
			"tizenkettő",
			"tizenhárom",
			"tizennégy",
			"tizenöt",
			"tizenhat",
			"tizenhét",
			"tizennyolc",
			"tizenkilenc",
		],
		tens: [
			"",
			"",
			"húsz",
			"harminc",
			"negyven",
			"ötven",
			"hatvan",
			"hetven",
			"nyolcvan",
			"kilencven",
		],
		tensBeforeOnes: [
			"",
			"",
			"huszon",
			"harminc",
			"negyven",
			"ötven",
			"hatvan",
			"hetven",
			"nyolcvan",
			"kilencven",
		],
	},
} as const;

/** Extensions that make a prose word a file name ("report dot pdf"). */
export const FILE_EXTENSIONS: ReadonlySet<string> = new Set(
	"pdf doc docx xls xlsx ppt pptx odt txt md csv json yaml yml xml html css js ts tsx jsx py java c cpp h cs go rs kt swift php sql sh zip gz tar png jpg jpeg gif svg webp mp3 mp4 wav mov".split(
		" ",
	),
);

/** Commands that make a block or an inline code run with no language a shell. */
export const SHELL_COMMANDS: ReadonlySet<string> = new Set(
	"ls cd cat grep echo sudo git npm npx curl ssh mkdir rm cp mv find chmod chown tail head docker systemctl export source sed awk tar pip".split(
		" ",
	),
);

/** Block languages that are a shell. */
export const SHELL_LANGUAGES: ReadonlySet<string> = new Set([
	"sh",
	"bash",
	"zsh",
	"shell",
	"console",
	"fish",
	"powershell",
	"ps1",
]);

/**
 * Simple math, as `speakMath` reads the TeX a reply shows (the owner's staging find,
 * 2026-11-17): the operators' words. A Hungarian power is "x a 10. hatványon" and
 * "x az n-edik hatványon"; the speech service says the ordinal ("tizedik").
 */
export const MATH_WORDS = {
	times: { en: "times", hu: "szorozva" },
	dividedBy: { en: "divided by", hu: "osztva" },
	over: { en: "over", hu: "per" },
	equals: { en: "equals", hu: "egyenlő" },
	notEqual: { en: "not equal to", hu: "nem egyenlő" },
	plus: { en: "plus", hu: "plusz" },
	minus: { en: "minus", hu: "mínusz" },
	plusOrMinus: { en: "plus or minus", hu: "plusz mínusz" },
	approximately: { en: "approximately", hu: "körülbelül" },
	lessThan: { en: "less than", hu: "kisebb mint" },
	greaterThan: { en: "greater than", hu: "nagyobb mint" },
	atMost: { en: "less than or equal to", hu: "kisebb vagy egyenlő" },
	atLeast: { en: "greater than or equal to", hu: "nagyobb vagy egyenlő" },
	squared: { en: "squared", hu: "négyzet" },
	cubed: { en: "cubed", hu: "köb" },
	squareRootOf: { en: "the square root of", hu: "négyzetgyök" },
	percent: { en: "percent", hu: "százalék" },
	/** English: "x to the power of n". Hungarian: "x a 10. hatványon". */
	toThePowerOf: { en: "to the power of", hu: "hatványon" },
} as const satisfies Record<string, SpokenForm>;

/**
 * A letter as a Hungarian power, with its article ("x az n-edik hatványon"): the
 * letters whose spoken name takes a known ending. Another letter is not read.
 */
export const HUNGARIAN_LETTER_POWERS: Readonly<Record<string, string>> = {
	a: "az a-adik",
	b: "a b-edik",
	c: "a c-edik",
	d: "a d-edik",
	i: "az i-edik",
	j: "a j-edik",
	k: "a k-adik",
	m: "az m-edik",
	n: "az n-edik",
	p: "a p-edik",
	t: "a t-edik",
	x: "az x-edik",
};

/** An arrow or a separator dot between items in prose. */
export const SEPARATORS: ReadonlySet<string> = new Set([
	"→",
	"⇒",
	"⟶",
	"->",
	"=>",
	"·",
	"•",
	"∙",
]);
