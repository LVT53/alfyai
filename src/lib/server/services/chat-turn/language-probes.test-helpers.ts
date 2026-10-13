// The conversations that a word-list reader of the REPLY gets wrong, kept as data
// (the review RV-L's probe table, plus both directions of an explicit request for
// the replies in a language).
//
// A requested piece of writing, a translation, a pasted text and an explicit
// request for the replies in a language all change what the REPLY is written in
// without changing the language the person writes in. What follows a reply (the
// follow-up chips, the rail headline, a generated title) is the person's next
// message or a label in their sidebar: it belongs in the language they WRITE in,
// which only a reader of the request can tell. The model names it, in one small
// call after the reply (conversation-language.ts); these rows are what that call
// is asked about and what a good answer is, in both directions.
//
// Used by reply-language.test.ts (the call faked: the turn takes its answer) and
// by tests/integration/reply-language.test.ts (the chips, the rail headline and
// the title are asked for in the language the call named).

export type LanguageProbe = {
	id: string;
	about: string;
	uiLanguage: "en" | "hu";
	/** The language stored on the conversation's last reply, when it has one. */
	previous: "en" | "hu" | null;
	/** The person's message before this one, when the conversation has one. */
	previousMessage?: string;
	message: string;
	reply: string;
	/** The language the person is writing in: what a good answer names. */
	person: "en" | "hu";
};

const HU_POEM = `Őszi szél fúj, hull a levél,
a fák között már csend honol,
nem szól a madár, csak a szél beszél,
és minden ág halkan dalol.

Ha jön az este, hűs a táj,
mert a nap már nem melegít,
de szívemben még nyár a táj,
és ez a fény most is segít.`;

const HU_LETTER = `Tisztelt Hölgyem/Uram!

Ezúton szeretném jelezni érdeklődésemet a meghirdetett szoftverfejlesztői pozíció iránt. Az elmúlt öt évben webes alkalmazások fejlesztésével foglalkoztam, és úgy érzem, hogy a tapasztalatom jól illeszkedik az Önök által keresett profilhoz. Korábban egy kis csapatban dolgoztam, ahol nemcsak a fejlesztésért, hanem a kód minőségéért is felelős voltam.

Köszönöm, hogy időt szánt a jelentkezésem elolvasására.

Tisztelettel:
Alex Morgan`;

const EN_EMAIL = `Subject: Running late tomorrow

Hi Mark,

I wanted to let you know that I will be about an hour late tomorrow because of a doctor's appointment. I will make up the time in the afternoon, and I can join the stand-up from my phone if that helps.

Best regards,
Anna`;

const HU_EMAIL = `Tárgy: Holnapi késés

Kedves Márk!

Szeretném jelezni, hogy holnap körülbelül egy órát késni fogok, mert orvoshoz kell mennem. A kiesett időt délután bepótolom, és ha szükséges, a reggeli megbeszélésre telefonról is be tudok kapcsolódni. Köszönöm a megértésedet, és elnézést kérek a kellemetlenségért.

Üdvözlettel:
Anna`;

const HU_TRANSLATION = `Kedves Szomszéd! Szeretném jelezni, hogy a jövő héten felújítás miatt néhány napig zaj lesz a lakásunkban. A munkát reggel kilenc és délután öt között végzik, és igyekszünk, hogy minél kevesebb kellemetlenséget okozzunk. Ha bármi problémája van, kérem, szóljon nekem, és megpróbáljuk megoldani. Köszönöm a türelmét!`;

const HU_PASTE =
	"Köszönöm szépen a meghívást, de sajnos nem tudok elmenni, mert beteg vagyok. Remélem, hogy legközelebb sikerül, és akkor majd együtt ünnepelünk. Ha van kedved, a jövő héten átjöhetnél hozzánk, mert nagyon régen nem találkoztunk, és sok mindent el kell mesélnem.";

const HU_ARTICLE =
	"A kormány szerint az infláció jövőre csökkenni fog, de az elemzők szerint ez nem biztos. A jegybank elnöke azt mondta, hogy a kamatok egyelőre nem változnak, mert a forint árfolyama még mindig ingadozik. Az ellenzék szerint a lakosság terhei továbbra is nagyon magasak, és a béremelések nem tartanak lépést az árakkal.";

const HU_DIALOGUE =
	"Szia! Hogy vagy? Én jól vagyok, köszönöm. Mit csinálsz ma? Ha van időd, menjünk el egy kávéra, mert nagyon szép az idő.\n\n(Hi! How are you? I'm fine, thanks. What are you doing today? If you have time, let's go for a coffee, because the weather is very nice.)";

const EN_CODE_FIX =
	"Here's the fix:\n\n```js\nfunction f(xs) {\n  return xs.map((x) => x * 2);\n}\n```\n\nYou forgot the `return`.";

export const LANGUAGE_PROBES: LanguageProbe[] = [
	// An English writer asks for a piece in Hungarian, or for a translation.
	{
		id: "en asks for an email in Hungarian",
		about: "ruling 75's own example: English around, Hungarian email",
		uiLanguage: "en",
		previous: null,
		message: "Write an email to my colleague in Hungarian",
		reply: `Here is a draft:\n\n${HU_EMAIL}`,
		person: "en",
	},
	{
		id: "en asks for a cover letter in Hungarian",
		about: "a long Hungarian letter and one English line",
		uiLanguage: "en",
		previous: null,
		message: "Write my cover letter in Hungarian",
		reply: `Sure! Here is a draft you can adapt:\n\n${HU_LETTER}`,
		person: "en",
	},
	{
		id: "en asks for a Hungarian cover letter for a job",
		about: "the language word is an adjective, not a request for the reply",
		uiLanguage: "en",
		previous: null,
		message: "Write a Hungarian cover letter for a junior developer job",
		reply: `Sure! Here is a draft:\n\n${HU_EMAIL}\n\n${HU_TRANSLATION}`,
		person: "en",
	},
	{
		id: "en asks for a poem in Hungarian",
		about: "an English frame, a Hungarian poem, an English offer",
		uiLanguage: "en",
		previous: null,
		message: "Write a short poem in Hungarian about autumn.",
		reply: `Here's a short poem in Hungarian about autumn:\n\n${HU_POEM}\n\nWant me to translate it into English?`,
		person: "en",
	},
	{
		id: "en asks to translate it to Hungarian (a frame)",
		about: "a translation with one English line before it",
		uiLanguage: "en",
		previous: "en",
		message: "Translate it to Hungarian",
		reply: `Here you go:\n\n${HU_TRANSLATION}`,
		person: "en",
	},
	{
		id: "en asks to translate it to Hungarian (bare)",
		about: "the translation alone: nothing in the reply says English",
		uiLanguage: "en",
		previous: "en",
		message: "Translate it to Hungarian",
		reply: HU_TRANSLATION,
		person: "en",
	},
	{
		id: "en asks for the Hungarian version",
		about: "a short request, the Hungarian text alone",
		uiLanguage: "en",
		previous: null,
		message: "Hungarian version please",
		reply: HU_EMAIL,
		person: "en",
	},
	{
		id: "en asks to make the Hungarian more formal",
		about: "the conversation's reply before this one was Hungarian",
		uiLanguage: "en",
		previous: "hu",
		previousMessage: "Translate it to Hungarian",
		message: "Now make it more formal",
		reply: `Here is a more formal version:\n\n${HU_TRANSLATION}`,
		person: "en",
	},
	{
		id: "en practises a Hungarian dialogue",
		about: "a Hungarian dialogue with an English gloss, for a learner",
		uiLanguage: "en",
		previous: null,
		message: "Let's practise a simple dialogue.",
		reply: HU_DIALOGUE,
		person: "en",
	},
	// An English writer, a Hungarian text pasted in.
	{
		id: "en pastes a Hungarian text and asks in English",
		about: "the message holds a Hungarian paragraph; the notes quote its words",
		uiLanguage: "en",
		previous: null,
		message: `Can you translate this and explain the grammar?\n\n${HU_PASTE}`,
		reply:
			'Here\'s the translation: "Thank you very much for the invitation, but unfortunately I can\'t go because I\'m sick. I hope it works out next time, and then we will celebrate together."\n\nA few grammar notes:\n- "nem tudok elmenni": "nem" negates the verb, and "tudok" is "I can".\n- "mert" means "because", and "hogy" introduces a clause, like "that".\n- "sok mindent" is "many things".',
		person: "en",
	},
	{
		id: "en pastes a Hungarian article",
		about: "an English summary that quotes the article",
		uiLanguage: "en",
		previous: null,
		message: `What does this article say?\n\n${HU_ARTICLE}`,
		reply:
			'The article reports that the government expects inflation to fall next year, while analysts are not sure. The central bank governor said rates will stay where they are "egyelőre", because the forint is still volatile ("még mindig ingadozik"). The opposition says household burdens are still very high and wages are not keeping up with prices ("nem tartanak lépést az árakkal").',
		person: "en",
	},
	{
		id: "en pastes a letter from a neighbour",
		about: "an English summary of a Hungarian letter",
		uiLanguage: "en",
		previous: null,
		message: `What does this letter from my neighbour mean?\n\n${HU_TRANSLATION} ${HU_TRANSLATION}`,
		reply:
			"Your neighbour is letting you know that there will be renovation noise in their flat next week, between nine in the morning and five in the afternoon. They will try to keep the disturbance low, and if anything bothers you, you should tell them so they can fix it.",
		person: "en",
	},
	{
		id: "en asks about code, shown in Hungarian",
		about: "a reply that is mostly code, for an account shown in Hungarian",
		uiLanguage: "hu",
		previous: null,
		message: "Why does this return undefined?",
		reply: EN_CODE_FIX,
		person: "en",
	},
	// A Hungarian writer asks for a piece in English, or about English.
	{
		id: "hu asks for an email in English",
		about:
			"the current AGENTS.md example, verbatim: Hungarian frame, English email",
		uiLanguage: "hu",
		previous: "hu",
		message: "Írj egy e-mailt angolul a kollégámnak",
		reply: `Íme egy javaslat:\n\n${EN_EMAIL}`,
		person: "hu",
	},
	{
		id: "hu asks for an email in English (a reason given)",
		about:
			"a Hungarian frame with one witness, an English email, a Hungarian offer",
		uiLanguage: "hu",
		previous: null,
		message: "Írj egy e-mailt angolul a főnökömnek, hogy holnap késni fogok.",
		reply: `Íme az e-mail:\n\n${EN_EMAIL}\n\nHa szeretnéd, módosíthatom a hangnemét.`,
		person: "hu",
	},
	{
		id: "hu asks how to say a word in English",
		about: "a Hungarian question about English; the answer is mostly English",
		uiLanguage: "hu",
		previous: "hu",
		message: "Hogy mondják angolul, hogy alma?",
		reply: "Angolul: apple. Például: I ate an apple.",
		person: "hu",
	},
	{
		id: "hu asks for a translation into English",
		about: "a short request after a Hungarian conversation",
		uiLanguage: "hu",
		previous: "hu",
		message: "Fordítsd le angolra.",
		reply: `Here is the English version:\n\n${EN_EMAIL}`,
		person: "hu",
	},
	// An explicit request for the replies in a language, both ways: the person
	// still WRITES the language they write in, and a chip is their next message, so
	// the chips, the headline and the title stay in it. (The reply is Hungarian or
	// English as asked; the rule above makes it so, and nothing here flips.)
	{
		id: "en asks for the answer in Hungarian",
		about:
			"the replies are asked for in Hungarian, the person writes English: their chips are English",
		uiLanguage: "en",
		previous: "en",
		message: "Answer in Hungarian: what is photosynthesis?",
		reply:
			"A fotoszintézis az a folyamat, amelynek során a növények a fényenergiát kémiai energiává alakítják, miközben szén-dioxidot és vizet vesznek fel, és oxigént bocsátanak ki.",
		person: "en",
	},
	{
		id: "hu asks for the answer in English",
		about:
			"the replies are asked for in English, the person writes Hungarian: their chips are Hungarian",
		uiLanguage: "hu",
		previous: "hu",
		message: "Válaszolj angolul: mi a fotoszintézis?",
		reply:
			"Photosynthesis is the process by which plants turn light into chemical energy, taking in carbon dioxide and water and releasing oxygen.",
		person: "hu",
	},
	// Plain conversations, both ways.
	{
		id: "en writes English, gets English",
		about: "the ordinary case",
		uiLanguage: "hu",
		previous: null,
		message: "Which is better, a heat pump or a gas boiler?",
		reply:
			"Heat pumps move heat instead of making it, so they usually need about a third of the energy a gas boiler needs for the same warmth. The catch is the upfront cost and the need for decent insulation.",
		person: "en",
	},
	{
		id: "hu writes Hungarian, gets Hungarian",
		about: "the ordinary case",
		uiLanguage: "en",
		previous: null,
		message: "Melyik jobb, a hőszivattyú vagy a gázkazán?",
		reply:
			"A hőszivattyú a hőt nem előállítja, hanem átmozgatja, ezért általában a gázkazán energiájának körülbelül a harmadára van szüksége ugyanahhoz a meleghez.",
		person: "hu",
	},
	{
		id: "en writes English, the model answers in Hungarian",
		about:
			"the failure the owner asked never to see: the chips must not follow the reply",
		uiLanguage: "en",
		previous: "en",
		message: "What should I cook for six people on Saturday?",
		reply:
			"Természetesen segítek. Először döntsd el, hogy mennyit szeretnél költeni, aztán válassz egy főételt, amit előre el lehet készíteni, mert így nem kell az egész napot a konyhában töltened.",
		person: "en",
	},
	{
		id: "hu writes Hungarian, the model answers in English",
		about: "the same failure the other way",
		uiLanguage: "hu",
		previous: "hu",
		message: "Mit főzzek szombaton hat főre?",
		reply:
			"Of course. First decide how much you want to spend, then pick a main dish that can be prepared ahead, because that way you do not have to spend the whole day in the kitchen.",
		person: "hu",
	},
];
