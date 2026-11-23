// The invented account for the live recall check (memory recall part 1,
// Task 7). Synthetic only: no real person's memories or chats. Shaped like the
// sales account: 400 facts about an invented person and two projects of 100
// and 90 facts, about a third in Hungarian, delivered as sources of 10 facts.
// Every fact holds one marker word that no other fact holds, and every probe
// names its target facts by marker. Named `.test-helpers.ts` because the
// English-purity scan of `src/lib/server` skips test helpers, and a third of
// these sentences are Hungarian on purpose.

export type LiveScope = "personal" | "alpha" | "beta";
export type LiveLanguage = "en" | "hu";
export type LiveProbeCategory =
	| "exact"
	| "project_topic"
	| "personal_topic"
	| "cross_language"
	| "follow_up"
	| "date"
	| "long";

export interface LiveFact {
	marker: string;
	scope: LiveScope;
	language: LiveLanguage;
	text: string;
}

export interface LiveProbe {
	category: Exclude<LiveProbeCategory, "exact">;
	scope: LiveScope;
	language: LiveLanguage;
	/** The chat's title: a follow-up's chat is titled with its topic. */
	title: string;
	message: string;
	/** The markers of the facts the message is about. */
	targets: string[];
}

export interface LiveAccount {
	facts: LiveFact[];
	/** Each scope's facts, 10 to a source, in delivery order. */
	sources: { scope: LiveScope; text: string }[];
	probes: LiveProbe[];
	/** Markers of the facts whose published entries the exact-text probes quote. */
	exactMarkers: { scope: LiveScope; language: LiveLanguage; marker: string }[];
}

/** How many of a category's 20 probes must bring back a target. */
export const LIVE_PROBE_BARS: Record<LiveProbeCategory, number> = {
	exact: 20,
	project_topic: 17,
	personal_topic: 17,
	cross_language: 15,
	follow_up: 15,
	date: 17,
	long: 17,
};

export const LIVE_PROJECT_NAMES: Record<
	Exclude<LiveScope, "personal">,
	string
> = {
	alpha: "Harbour Cafe renovation",
	beta: "Summer language camp",
};

const SCOPE_SIZES: Record<LiveScope, number> = {
	personal: 400,
	alpha: 100,
	beta: 90,
};
export const FACTS_PER_SOURCE = 10;
const LONG_MESSAGE_CHARS = 500;

interface Topic {
	en: string;
	hu: string;
}
interface TopicalFact {
	scope: LiveScope;
	language: LiveLanguage;
	text: (marker: string) => string;
	topic: Topic;
}

// Facts the probes ask about: each the only fact on its topic.
const TOPICAL: TopicalFact[] = [
	{
		scope: "personal",
		language: "en",
		text: (m) =>
			`My piano teacher is called ${m} and she gives lessons on Tuesday evenings.`,
		topic: { en: "my piano teacher", hu: "a zongoratanárom" },
	},
	{
		scope: "personal",
		language: "en",
		text: (m) =>
			`I named my sailing dinghy ${m} after my grandfather's village.`,
		topic: { en: "my sailing dinghy", hu: "a vitorlás csónakom" },
	},
	{
		scope: "personal",
		language: "en",
		text: (m) =>
			`My allergist, Dr ${m}, told me to avoid hazelnuts completely.`,
		topic: { en: "my nut allergy", hu: "a mogyoróallergiám" },
	},
	{
		scope: "personal",
		language: "en",
		text: (m) =>
			`The vegetable plot I rent is in the ${m} allotment gardens, plot number 14.`,
		topic: { en: "the vegetable plot I rent", hu: "a bérelt zöldségeskertem" },
	},
	{
		scope: "personal",
		language: "en",
		text: (m) =>
			`My running club is the ${m} Striders, and we train along the river on Sundays.`,
		topic: { en: "my running club", hu: "a futóklubom" },
	},
	{
		scope: "personal",
		language: "en",
		text: (m) => `My first car was a green hatchback that I nicknamed ${m}.`,
		topic: { en: "my first car", hu: "az első autóm" },
	},
	{
		scope: "personal",
		language: "en",
		text: (m) =>
			`I always order the ${m} blend from the tea shop next to my office.`,
		topic: {
			en: "the tea I order next to my office",
			hu: "a tea, amit az irodám mellett rendelek",
		},
	},
	{
		scope: "personal",
		language: "en",
		text: (m) => `My childhood best friend ${m} now works as a vet in Bristol.`,
		topic: {
			en: "my childhood best friend",
			hu: "a gyerekkori legjobb barátom",
		},
	},
	{
		scope: "personal",
		language: "en",
		text: (m) =>
			`I am restoring an old wall clock made by a clockmaker called ${m}.`,
		topic: {
			en: "the old clock I am restoring",
			hu: "a régi óra, amit felújítok",
		},
	},
	{
		scope: "personal",
		language: "en",
		text: (m) =>
			`My dentist works at the ${m} Clinic, and my next check-up is in the spring.`,
		topic: { en: "my dentist", hu: "a fogorvosom" },
	},
	{
		scope: "personal",
		language: "hu",
		text: (m) =>
			`Gyerekkoromban minden nyarat a nagymamám ${m} nevű falujában töltöttem.`,
		topic: {
			en: "where I spent my childhood summers",
			hu: "ahol a gyerekkori nyaraimat töltöttem",
		},
	},
	{
		scope: "personal",
		language: "hu",
		text: (m) =>
			`A kutyám neve ${m}, egy hároméves vizsla, aki imádja a vizet.`,
		topic: { en: "my dog", hu: "a kutyám" },
	},
	{
		scope: "personal",
		language: "hu",
		text: (m) =>
			`A kedvenc pékségem a ${m} pékség, ott veszem a kovászos kenyeret.`,
		topic: {
			en: "where I buy sourdough bread",
			hu: "ahol a kovászos kenyeret veszem",
		},
	},
	{
		scope: "personal",
		language: "hu",
		text: (m) =>
			`A jógaoktatóm, ${m}, azt javasolta, hogy reggelente nyújtsak.`,
		topic: { en: "my yoga teacher's advice", hu: "a jógaoktatóm tanácsa" },
	},
	{
		scope: "personal",
		language: "hu",
		text: (m) =>
			`A biciklimet a ${m} szervizben javíttatom, mert ott olcsó a fékcsere.`,
		topic: {
			en: "where I get my bike repaired",
			hu: "ahol a biciklimet javíttatom",
		},
	},
	{
		scope: "personal",
		language: "hu",
		text: (m) =>
			`A lakásomat egy ${m} márkájú kazán fűti, amit tavaly cseréltünk ki.`,
		topic: { en: "the boiler in my flat", hu: "a lakásom kazánja" },
	},
	{
		scope: "personal",
		language: "hu",
		text: (m) =>
			`Az unokahúgom, ${m}, szeptemberben kezdi az egyetemet Debrecenben.`,
		topic: {
			en: "my niece's university plans",
			hu: "az unokahúgom egyetemi tervei",
		},
	},
	{
		scope: "personal",
		language: "hu",
		text: (m) => `A kedvenc túraútvonalam a Bükkben a ${m}-nyereg felé vezet.`,
		topic: { en: "my favourite hiking route", hu: "a kedvenc túraútvonalam" },
	},
	{
		scope: "personal",
		language: "hu",
		text: (m) => `A könyvklubunk most a ${m} című regényt olvassa.`,
		topic: {
			en: "the novel my book club is reading",
			hu: "a regény, amit a könyvklubunk olvas",
		},
	},
	{
		scope: "personal",
		language: "hu",
		text: (m) => `A háziorvosom, dr. ${m}, csak csütörtök délután rendel.`,
		topic: {
			en: "my GP's surgery hours",
			hu: "a háziorvosom rendelési ideje",
		},
	},
	{
		scope: "alpha",
		language: "en",
		text: (m) =>
			`For the café renovation, the espresso machine will come from ${m} in the second week of May.`,
		topic: {
			en: "the espresso machine for the café",
			hu: "a kávézó eszpresszógépe",
		},
	},
	{
		scope: "alpha",
		language: "en",
		text: (m) =>
			`The café's new floor tiles are the ${m} pattern in dark green.`,
		topic: {
			en: "the café's new floor tiles",
			hu: "a kávézó új padlócsempéje",
		},
	},
	{
		scope: "alpha",
		language: "en",
		text: (m) => `We hired ${m} as the head barista for the café's reopening.`,
		topic: {
			en: "the head barista for the reopening",
			hu: "a vezető barista az újranyitásra",
		},
	},
	{
		scope: "alpha",
		language: "en",
		text: (m) => `The café's opening party will have a jazz trio called ${m}.`,
		topic: {
			en: "the band for the café's opening party",
			hu: "a zenekar a kávézó megnyitójára",
		},
	},
	{
		scope: "alpha",
		language: "en",
		text: (m) =>
			`The renovation budget is capped at 48,000 euros and tracked in a spreadsheet named ${m}.`,
		topic: { en: "the renovation budget", hu: "a felújítás költségkerete" },
	},
	{
		scope: "alpha",
		language: "hu",
		text: (m) => `A kávézó új neonfeliratát a ${m} műhely készíti.`,
		topic: {
			en: "the café's new neon sign",
			hu: "a kávézó új neonfelirata",
		},
	},
	{
		scope: "alpha",
		language: "hu",
		text: (m) => `A kávézó teraszára ${m} márkájú napernyőket rendeltünk.`,
		topic: {
			en: "the parasols for the café terrace",
			hu: "a kávézó teraszának napernyői",
		},
	},
	{
		scope: "alpha",
		language: "hu",
		text: (m) =>
			`A felújítás építésvezetője ${m}, aki minden hétfőn bejárást tart.`,
		topic: {
			en: "the renovation's site manager",
			hu: "a felújítás építésvezetője",
		},
	},
	{
		scope: "alpha",
		language: "hu",
		text: (m) => `A kávézó kávéját a ${m} pörkölőtől vesszük, etióp babból.`,
		topic: {
			en: "where the café's coffee beans come from",
			hu: "honnan jön a kávézó kávébabja",
		},
	},
	{
		scope: "alpha",
		language: "hu",
		text: (m) => `A kávézó új logóját egy ${m} nevű grafikus tervezte.`,
		topic: {
			en: "who designed the café's new logo",
			hu: "ki tervezte a kávézó új logóját",
		},
	},
	{
		scope: "beta",
		language: "en",
		text: (m) =>
			`The language camp will be held at a lakeside venue called ${m} in early July.`,
		topic: {
			en: "where the language camp will be held",
			hu: "hol lesz a nyelvi tábor",
		},
	},
	{
		scope: "beta",
		language: "en",
		text: (m) =>
			`${m} is the head teacher of the camp's advanced English group.`,
		topic: {
			en: "the head teacher of the advanced English group",
			hu: "a haladó angol csoport vezető tanára",
		},
	},
	{
		scope: "beta",
		language: "en",
		text: (m) =>
			`Camp registration closes on 15 May, and the form is hosted on a site called ${m}.`,
		topic: {
			en: "the camp registration form",
			hu: "a tábori jelentkezési lap",
		},
	},
	{
		scope: "beta",
		language: "en",
		text: (m) => `The camp bus will be provided by the ${m} coach company.`,
		topic: { en: "the camp bus", hu: "a tábori busz" },
	},
	{
		scope: "beta",
		language: "en",
		text: (m) => `Every camper gets an orange T-shirt printed by ${m}.`,
		topic: { en: "the camp T-shirts", hu: "a tábori pólók" },
	},
	{
		scope: "beta",
		language: "hu",
		text: (m) =>
			`A tábor esti programja egy ${m} nevű társasjáték-bajnokság lesz.`,
		topic: {
			en: "the camp's evening programme",
			hu: "a tábor esti programja",
		},
	},
	{
		scope: "beta",
		language: "hu",
		text: (m) => `A táborban ${m} főz, aki vegetáriánus menüt is készít.`,
		topic: { en: "who cooks at the camp", hu: "ki főz a táborban" },
	},
	{
		scope: "beta",
		language: "hu",
		text: (m) => `A tábor elsősegély-felelőse ${m}, aki mentőtiszt.`,
		topic: {
			en: "the camp's first-aid lead",
			hu: "a tábor elsősegély-felelőse",
		},
	},
	{
		scope: "beta",
		language: "hu",
		text: (m) => `A tábor részvételi díját ${m} kezeli, aki a pénztáros.`,
		topic: {
			en: "who handles the camp fee",
			hu: "ki kezeli a tábor részvételi díját",
		},
	},
	{
		scope: "beta",
		language: "hu",
		text: (m) => `A tábor kirándulása a ${m} nevű barlanghoz vezet.`,
		topic: { en: "the camp excursion", hu: "a tábori kirándulás" },
	},
];

// Filler facts make each bank its size. Each template takes a marker and a
// variant, so no two filler facts are the same statement.
type Filler = (marker: string, n: number) => string;
const pick = <T>(list: readonly T[], n: number) => list[n % list.length];
const YEARS = ["2019", "2020", "2021", "2022", "2023", "2024"];
const COLOURS_EN = ["red", "yellow", "navy", "grey", "teal", "striped"];
const INSTRUMENTS_EN = ["violin", "accordion", "saxophone", "guitar", "cello"];
const TOOLS_EN = ["drill", "ladder", "lawnmower", "tent", "pressure washer"];
const SPOTS_HU = ["az ablakpárkányon", "a könyvespolcon", "az íróasztalomon"];
const INSTRUMENTS_HU = ["hegedűn", "harmonikán", "szaxofonon", "gitáron"];
const TOOLS_HU = ["fúrómat", "létrámat", "fűnyírómat", "sátramat"];
const ROOMS_EN = [
	"kitchen",
	"counter area",
	"back office",
	"terrace",
	"storeroom",
];
const ITEMS_HU = ["pult", "csempe", "lámpák", "székek", "hűtőpult"];
const CITIES_EN = ["Pécs", "Győr", "Szeged", "Eger", "Sopron"];

const PERSONAL_FILLERS: Record<LiveLanguage, Filler[]> = {
	en: [
		(m, n) =>
			`I visited a small museum called ${m} on a weekend trip in ${pick(YEARS, n)}.`,
		(m, n) =>
			`My colleague ${m} lent me a ${pick(COLOURS_EN, n)} umbrella when it rained.`,
		(m, n) =>
			`A street musician called ${m} played the ${pick(INSTRUMENTS_EN, n)} outside my office.`,
		(m, n) =>
			`My neighbour ${m} borrowed my ${pick(TOOLS_EN, n)} and brought it back a week later.`,
		(m, n) =>
			`I keep a houseplant named ${m} that I bought in ${pick(YEARS, n)}.`,
		(m, n) =>
			`I tried a podcast called ${m} about ${pick(["gardening", "history", "chess", "cooking", "astronomy"], n)}.`,
		(m, n) =>
			`I once had dinner at a diner called ${m} on a ${pick(["Monday", "Wednesday", "Friday", "Sunday"], n)} night.`,
	],
	hu: [
		(m) => `Egy ${m} nevű kis múzeumban jártam egy hétvégi kirándulás során.`,
		(m, n) => `Van egy ${m} nevű szobanövényem, ami ${pick(SPOTS_HU, n)} áll.`,
		(m, n) =>
			`Egy ${m} nevű utcazenész ${pick(INSTRUMENTS_HU, n)} játszott az irodám előtt.`,
		(m, n) => `A ${m} nevű szomszédom kölcsönkérte a ${pick(TOOLS_HU, n)}.`,
	],
};
const PROJECT_FILLERS: Record<
	Exclude<LiveScope, "personal">,
	Record<LiveLanguage, Filler[]>
> = {
	alpha: {
		en: [
			(m, n) =>
				`For the café renovation, ${m} quoted ${1200 + n * 37} euros for the ${pick(ROOMS_EN, n)}.`,
			(m, n) =>
				`The café's ${pick(ROOMS_EN, n)} will be painted in a colour called ${m}.`,
			(m, n) =>
				`We named a new pastry on the café menu the ${m}, priced at ${3 + (n % 5)} euros.`,
		],
		hu: [
			(m, n) =>
				`A kávézó felújításához a ${m} céget választottuk a ${pick(ITEMS_HU, n)} beszállítójának.`,
			(m, n) =>
				`A ${m} nevű villanyszerelő ${900 + n * 41} eurós árajánlatot adott a kávézóra.`,
		],
	},
	beta: {
		en: [
			(m, n) =>
				`Camp group ${m} will be led by a volunteer from ${pick(CITIES_EN, n)}.`,
			(m, n) =>
				`For the language camp we priced a hostel called ${m} at ${20 + (n % 9)} euros a night.`,
			(m, n) =>
				`The camp's ${pick(["drama", "singing", "quiz", "film", "debate"], n)} session will take place in a room called ${m}.`,
		],
		hu: [
			(m) => `A nyelvi tábor ${m} nevű csoportját egy önkéntes vezeti.`,
			(m, n) =>
				`A táborhoz a ${m} nevű szállót néztük ki ${2 + (n % 5)} éjszakára.`,
		],
	},
};

// Five-letter invented words, spread over the space so neighbours differ.
const ONSETS = "bdfgklmnprstvz";
const VOWELS = "aeiou";
const CODAS = "knrstx";
const MARKER_SPACE =
	ONSETS.length * VOWELS.length * ONSETS.length * VOWELS.length * CODAS.length;
function marker(k: number): string {
	let n = (k * 7919 + 13) % MARKER_SPACE;
	const take = (letters: string) => {
		const letter = letters[n % letters.length];
		n = Math.floor(n / letters.length);
		return letter;
	};
	const word = `${take(ONSETS)}${take(VOWELS)}${take(ONSETS)}${take(VOWELS)}${take(CODAS)}`;
	return `${word[0].toUpperCase()}${word.slice(1)}`;
}

const LONG_LEAD: Record<LiveLanguage, string> = {
	en: "It has been a long week and I am going through my notes before the weekend, because there are lots of small things I keep forgetting and I would rather sort them out now than on Monday morning. I wrote some of them on paper, some in my phone and some only in my head, so bear with me while I go through them one by one and try to remember what I already told you. ",
	hu: "Hosszú hetem volt, és a hétvége előtt átnézem a jegyzeteimet, mert rengeteg apróságot elfelejtek, és inkább most rendezem el őket, mint hétfő reggel. Néhányat papírra írtam, néhányat a telefonomba, néhányat csak fejben tartok, úgyhogy légy türelmes, amíg egyenként végigmegyek rajtuk, és próbálok visszaemlékezni, mit mondtam már neked korábban. ",
};

function ask(topic: Topic, language: LiveLanguage): string {
	return language === "en"
		? `What do you remember about ${topic.en}?`
		: `Mit tudsz erről: ${topic.hu}?`;
}
function withDate(topic: Topic, language: LiveLanguage, n: number): string {
	if (language === "en")
		return n % 2
			? `On Friday I have to deal with ${topic.en}. What do you know about it?`
			: `Last March I told you about ${topic.en}. What was it again?`;
	return n % 2
		? `Pénteken ezzel lesz dolgom: ${topic.hu}. Mit tudsz róla?`
		: `Tavaly márciusban meséltem erről: ${topic.hu}. Mi is volt az?`;
}
function long(topic: Topic, language: LiveLanguage): string {
	const question = ask(topic, language);
	const room = LONG_MESSAGE_CHARS - Array.from(question).length;
	let lead = "";
	while (Array.from(lead).length < room) lead += LONG_LEAD[language];
	return `${Array.from(lead).slice(0, room).join("")}${question}`;
}

/** Builds the invented account; throws if a marker is not unique to its fact. */
export function buildLiveAccount(): LiveAccount {
	const makers: {
		scope: LiveScope;
		language: LiveLanguage;
		make: (marker: string) => string;
	}[] = TOPICAL.map(({ scope, language, text }) => ({
		scope,
		language,
		make: text,
	}));
	for (const scope of ["personal", "alpha", "beta"] as const) {
		const templates =
			scope === "personal" ? PERSONAL_FILLERS : PROJECT_FILLERS[scope];
		const own = makers.filter((maker) => maker.scope === scope).length;
		for (let i = 0; own + i < SCOPE_SIZES[scope]; i++) {
			// About a third in Hungarian.
			const language: LiveLanguage = i % 3 === 2 ? "hu" : "en";
			const fill = pick(templates[language], i);
			const n = Math.floor(i / 3);
			makers.push({ scope, language, make: (m) => fill(m, n) });
		}
	}
	// A marker must not occur in any sentence's own words.
	const skeletons = makers.map((maker) => maker.make("\u0000").toLowerCase());
	let next = 0;
	const freshMarker = () => {
		for (;;) {
			const candidate = marker(next++);
			if (!skeletons.some((text) => text.includes(candidate.toLowerCase())))
				return candidate;
		}
	};
	const facts: LiveFact[] = makers.map(({ scope, language, make }) => {
		const m = freshMarker();
		return { marker: m, scope, language, text: make(m) };
	});
	const topical = TOPICAL.map((fact, index) => ({
		...fact,
		marker: facts[index].marker,
	}));
	const texts = facts.map((fact) => fact.text.toLowerCase());
	for (const fact of facts) {
		const holders = texts.filter((text) =>
			text.includes(fact.marker.toLowerCase()),
		).length;
		if (holders !== 1)
			throw new Error(`live fixture: marker shared by ${holders} facts`);
	}
	const sources: LiveAccount["sources"] = [];
	for (const scope of ["personal", "alpha", "beta"] as const) {
		const own = facts.filter((fact) => fact.scope === scope);
		// A stride of 7 (prime to 400, 100 and 90) spreads the probed facts
		// over the sources, as a person mentions things over many chats.
		const order = own.map((_, i) => own[(i * 7) % own.length]);
		for (let at = 0; at < order.length; at += FACTS_PER_SOURCE)
			sources.push({
				scope,
				text: order
					.slice(at, at + FACTS_PER_SOURCE)
					.map((fact) => fact.text)
					.join(" "),
			});
	}
	const personal = topical.filter((fact) => fact.scope === "personal");
	const project = topical.filter((fact) => fact.scope !== "personal");
	const probe = (
		category: LiveProbe["category"],
		fact: (typeof topical)[number],
		language: LiveLanguage,
		message: string,
		title = "Synthetic recall check",
	): LiveProbe => ({
		category,
		scope: fact.scope,
		language,
		title,
		message,
		targets: [fact.marker],
	});
	const flip = (language: LiveLanguage): LiveLanguage =>
		language === "en" ? "hu" : "en";
	const probes: LiveProbe[] = [
		...personal.map((fact) =>
			probe(
				"personal_topic",
				fact,
				fact.language,
				ask(fact.topic, fact.language),
			),
		),
		...project.map((fact) =>
			probe(
				"project_topic",
				fact,
				fact.language,
				ask(fact.topic, fact.language),
			),
		),
		...personal.map((fact) =>
			probe(
				"cross_language",
				fact,
				flip(fact.language),
				ask(fact.topic, flip(fact.language)),
			),
		),
		...personal.map((fact) =>
			probe(
				"follow_up",
				fact,
				fact.language,
				fact.language === "en" ? "and the details?" : "és a részletek?",
				fact.topic[fact.language],
			),
		),
		...personal.map((fact, n) =>
			probe(
				"date",
				fact,
				fact.language,
				withDate(fact.topic, fact.language, n),
			),
		),
		...project.map((fact) =>
			probe("long", fact, fact.language, long(fact.topic, fact.language)),
		),
	];
	// The exact-text probes quote the published entries of these facts: ten
	// personal, five of each project, half of them Hungarian.
	const exactMarkers = [
		...personal.slice(0, 5),
		...personal.slice(10, 15),
		...project.filter((fact) => fact.scope === "alpha").slice(3, 8),
		...project.filter((fact) => fact.scope === "beta").slice(2, 7),
	].map(({ scope, language, marker }) => ({ scope, language, marker }));
	return { facts, sources, probes, exactMarkers };
}
