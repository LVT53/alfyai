// Corpus for the G0 tool-guidance A/B evaluation harness
// (scripts/evaluate-tool-guidance-ab.ts).
//
// This corpus exists to make the G1 hypothesis falsifiable: G1 will DELETE
// the Normal Chat guidance packs (src/lib/server/services/normal-chat-context.ts,
// `planNormalChatGuidancePacks`/`NORMAL_CHAT_GUIDANCE_PACKS`) and move each
// tool's usage rules into its own tool `description`
// (src/lib/server/services/normal-chat-tools/index.ts). The probe that
// motivated this slice proved pack SELECTION varies (English-only regexes
// keyed on the latest message; different packs for an EN vs HU phrasing of
// the identical request; follow-up turns can lose packs a first turn would
// have gotten) — this corpus is designed so that variance is likely to show
// up as an actual tool-SELECTION difference, not just a prompt-text
// difference, when this same file is run once against BEFORE (current,
// packs) and once against AFTER (G1, per-tool descriptions) code.
//
// Every fixture's `messages` array ends with the turn actually being
// evaluated (the last message must have `role: "user"`). For `isFollowUp`
// fixtures, everything before the final message is prior conversation
// context — this matters because `buildOutboundSystemPrompt`'s guidance-pack
// selection regexes run ONLY against the latest message's raw text
// (see normal-chat-context.ts `resolveGuidancePackSelection` /
// `planNormalChatGuidancePacks`, called with `params.message` = the current
// turn only, never the full history). A follow-up whose intent is only
// legible from earlier turns (e.g. "put THAT into a PDF") is exactly the
// case the probe flagged as pack-selection-hostile.
//
// LIMITATION (documented per the G0 task spec — also restated in the
// harness's markdown report): this is a hand-written corpus. Real user
// messages are messier — typos, code-switching mid-sentence, run-on
// phrasing, mixed EN/HU within one message — than anything below. A
// scripted corpus can demonstrate the MECHANISM (regex/length/language
// sensitivity in pack selection) but cannot prove real-traffic prevalence.
// Treat hit-rate deltas from this corpus as a lower bound on how often the
// mechanism fires in production, not an exact frequency.

export type EvalMessage = {
	role: "user" | "assistant";
	content: string;
};

export type ExpectedTool =
	| "research_web"
	| "fetch_url"
	| "image_search"
	| "produce_file"
	| "memory_context"
	| "none";

export type ToolGuidanceFixtureCategory =
	// EN/HU pairs of the SAME request/intent — isolates language as the only
	// variable in pack selection (the pack-selection regexes are English-only
	// word-boundary matches, so an HU phrasing of an identical intent can
	// select a different, usually smaller, pack set).
	| "language_pair"
	// Words that appear in the pack-selection trigger regexes but are used
	// here in an innocuous sense that should NOT cause a real tool call —
	// tests over-triggering (a guidance pack gets spliced in for a turn that
	// doesn't need it).
	| "false_positive_word"
	// Phrasing that SHOULD cause a research_web call but avoids every literal
	// trigger word in WEB_INTENT_RE/WEB_SOURCE_PRIORITY_RE/HIGH_RISK_RE (no
	// "today/current/latest/recent/source/verify/research/search/price/
	// availability/spec/policy/leadership") — tests under-triggering.
	| "false_negative_web"
	// "Put THAT into a PDF" style requests that SHOULD cause a produce_file
	// call but only make sense as follow-ups (the referent is in a prior
	// turn); the final turn alone often doesn't match FILE_INTENT_CONVERSION_RE
	// or the FILE_REVISION_RE + FILE_EDIT_CONTEXT_RE combination.
	| "false_negative_file"
	// <=8-word phrasing of a request, paired 1:1 (by underlying intent) with
	// a "length_cliff_long" fixture — isolates message length as a variable,
	// since `isLikelySimpleDirectPrompt` / `COMPLEX_PROMPT_MIN_WORDS` gate
	// pack selection on word count.
	| "length_cliff_short"
	// >=35-word phrasing of the SAME underlying intent as a
	// "length_cliff_short" fixture.
	| "length_cliff_long"
	// Dedicated image_search positive cases beyond the language/length pairs.
	| "image_search_case"
	// Dedicated memory_context positive cases beyond the language/length pairs.
	| "memory_context_case"
	// Dedicated fetch_url positive cases (a pasted URL in the turn).
	| "fetch_url_case"
	// Ordinary conversational turns with no tool need — a plain control
	// group so the corpus isn't 100% trigger-hunting.
	| "control";

export type ToolGuidanceFixture = {
	id: string;
	language: "en" | "hu";
	category: ToolGuidanceFixtureCategory;
	isFollowUp: boolean;
	messages: EvalMessage[];
	expectedTool: ExpectedTool;
	expectedSignals?: {
		citation?: boolean;
		image?: boolean;
		file?: boolean;
	};
};

function userTurn(content: string): EvalMessage {
	return { role: "user", content };
}

function assistantTurn(content: string): EvalMessage {
	return { role: "assistant", content };
}

// ── A. language_pair (16: 8 pairs x EN/HU) ──────────────────────────────
//
// Each pair asks the identical underlying question in English and Hungarian.
// 4 of the 8 pairs are follow-ups (marked on both language variants) so the
// "follow-up loses the pack" mechanism gets an EN/HU comparison too.

const languagePairFixtures: ToolGuidanceFixture[] = [
	// A1 — current price lookup (follow-up). "price"/"current" are EN
	// WEB_INTENT_RE triggers; the HU equivalent has no English trigger words.
	{
		id: "lp-iphone-price-en",
		language: "en",
		category: "language_pair",
		isFollowUp: true,
		messages: [
			userTurn(
				"I'm trying to decide between the iPhone 16 Pro Max and the Galaxy S25 Ultra for my next phone.",
			),
			assistantTurn(
				"Both are strong flagships — the iPhone leans into camera consistency and iOS integration, while the Galaxy offers a stylus and more customizable Android features. Do you want a price or feature comparison?",
			),
			userTurn("What's the current price of the iPhone 16 Pro Max?"),
		],
		expectedTool: "research_web",
		expectedSignals: { citation: true },
	},
	{
		id: "lp-iphone-price-hu",
		language: "hu",
		category: "language_pair",
		isFollowUp: true,
		messages: [
			userTurn(
				"Azon gondolkodom, hogy az iPhone 16 Pro Max vagy a Galaxy S25 Ultra legyen a következő telefonom.",
			),
			assistantTurn(
				"Mindkettő erős csúcsmodell — az iPhone a kamera konzisztenciájára és az iOS integrációra épít, a Galaxy pedig stylust és rugalmasabb Android funkciókat kínál. Ár vagy funkció-összehasonlítást szeretnél?",
			),
			userTurn("Mennyibe kerül jelenleg az iPhone 16 Pro Max?"),
		],
		expectedTool: "research_web",
		expectedSignals: { citation: true },
	},
	// A2 — conceptual explanation, no tool needed.
	{
		id: "lp-sql-injection-en",
		language: "en",
		category: "language_pair",
		isFollowUp: false,
		messages: [
			userTurn(
				"Can you explain what a SQL injection attack is and how to prevent it?",
			),
		],
		expectedTool: "none",
	},
	{
		id: "lp-sql-injection-hu",
		language: "hu",
		category: "language_pair",
		isFollowUp: false,
		messages: [
			userTurn(
				"El tudnád magyarázni, mi az az SQL injection támadás, és hogyan lehet védekezni ellene?",
			),
		],
		expectedTool: "none",
	},
	// A3 — convert prior content to a file (follow-up).
	{
		id: "lp-export-notes-pdf-en",
		language: "en",
		category: "language_pair",
		isFollowUp: true,
		messages: [
			userTurn(
				"Let's plan tomorrow's team meeting. Agenda: budget review, hiring update, and the Q3 roadmap.",
			),
			assistantTurn(
				"Got it — here's a quick outline: 1) Budget review (15 min), 2) Hiring update (10 min), 3) Q3 roadmap discussion (20 min). Want me to add anything else?",
			),
			userTurn(
				"That's good. Turn this meeting outline into a downloadable PDF.",
			),
		],
		expectedTool: "produce_file",
		expectedSignals: { file: true },
	},
	{
		id: "lp-export-notes-pdf-hu",
		language: "hu",
		category: "language_pair",
		isFollowUp: true,
		messages: [
			userTurn(
				"Tervezzük meg a holnapi csapatmegbeszélést. Napirend: költségvetés áttekintése, felvételi frissítés, és a Q3 ütemterv.",
			),
			assistantTurn(
				"Rendben — íme egy gyors vázlat: 1) Költségvetés áttekintése (15 perc), 2) Felvételi frissítés (10 perc), 3) Q3 ütemterv megbeszélése (20 perc). Szeretnél még hozzáadni valamit?",
			),
			userTurn(
				"Ez jó. Alakítsd át ezt a megbeszélés-vázlatot letölthető PDF fájllá.",
			),
		],
		expectedTool: "produce_file",
		expectedSignals: { file: true },
	},
	// A4 — image request.
	{
		id: "lp-beach-sunset-photos-en",
		language: "en",
		category: "language_pair",
		isFollowUp: false,
		messages: [userTurn("Show me some pictures of a beach at sunset.")],
		expectedTool: "image_search",
		expectedSignals: { image: true },
	},
	{
		id: "lp-beach-sunset-photos-hu",
		language: "hu",
		category: "language_pair",
		isFollowUp: false,
		messages: [userTurn("Mutass néhány képet egy tengerparti naplementéről.")],
		expectedTool: "image_search",
		expectedSignals: { image: true },
	},
	// A5 — project-folder memory recall (follow-up).
	{
		id: "lp-project-folder-notes-en",
		language: "en",
		category: "language_pair",
		isFollowUp: true,
		messages: [
			userTurn("I'm back working in my Kitchen Renovation project."),
			assistantTurn(
				"Welcome back to the Kitchen Renovation project. What would you like to work on today?",
			),
			userTurn(
				"What did we previously decide about the cabinet color in my Kitchen Renovation project notes?",
			),
		],
		expectedTool: "memory_context",
	},
	{
		id: "lp-project-folder-notes-hu",
		language: "hu",
		category: "language_pair",
		isFollowUp: true,
		messages: [
			userTurn("Visszatértem a Konyhafelújítás projektemhez."),
			assistantTurn(
				"Üdv újra a Konyhafelújítás projektben. Min szeretnél ma dolgozni?",
			),
			userTurn(
				"Mit döntöttünk korábban a szekrények színéről a Konyhafelújítás projektmappám jegyzeteiben?",
			),
		],
		expectedTool: "memory_context",
	},
	// A6 — static general knowledge, no tool needed.
	{
		id: "lp-capital-australia-en",
		language: "en",
		category: "language_pair",
		isFollowUp: false,
		messages: [userTurn("What is the capital city of Australia?")],
		expectedTool: "none",
	},
	{
		id: "lp-capital-australia-hu",
		language: "hu",
		category: "language_pair",
		isFollowUp: false,
		messages: [userTurn("Mi Ausztrália fővárosa?")],
		expectedTool: "none",
	},
	// A7 — current/latest version lookup (follow-up).
	{
		id: "lp-nodejs-lts-en",
		language: "en",
		category: "language_pair",
		isFollowUp: true,
		messages: [
			userTurn(
				"We're starting a new backend service and want to pick a stable Node.js version to standardize on.",
			),
			assistantTurn(
				"Good idea to pin to an LTS release for stability. Want me to check which LTS line is current, or do you already have one in mind?",
			),
			userTurn("What is the latest LTS version of Node.js right now?"),
		],
		expectedTool: "research_web",
		expectedSignals: { citation: true },
	},
	{
		id: "lp-nodejs-lts-hu",
		language: "hu",
		category: "language_pair",
		isFollowUp: true,
		messages: [
			userTurn(
				"Egy új backend szolgáltatást indítunk, és szeretnénk egy stabil Node.js verziót választani, amire szabványosítunk.",
			),
			assistantTurn(
				"Jó ötlet egy LTS kiadáshoz rögzíteni a stabilitás miatt. Szeretnéd, hogy megnézzem, melyik LTS ág aktuális, vagy már van elképzelésed?",
			),
			userTurn("Melyik a Node.js jelenlegi legújabb LTS verziója?"),
		],
		expectedTool: "research_web",
		expectedSignals: { citation: true },
	},
	// A8 — rewrite/tone task, no tool needed.
	{
		id: "lp-cover-letter-rewrite-en",
		language: "en",
		category: "language_pair",
		isFollowUp: false,
		messages: [
			userTurn(
				'Please rewrite this cover letter paragraph to sound more confident: "I think I might be a good fit for this role."',
			),
		],
		expectedTool: "none",
	},
	{
		id: "lp-cover-letter-rewrite-hu",
		language: "hu",
		category: "language_pair",
		isFollowUp: false,
		messages: [
			userTurn(
				"Kérlek, írd át ezt a motivációs levél bekezdést, hogy magabiztosabban hangozzon: „Szerintem talán jó jelölt lennék erre a pozícióra.”",
			),
		],
		expectedTool: "none",
	},
];

// ── B. false_positive_word (10: 6 EN + 4 HU) ────────────────────────────
//
// Every EN fixture below uses one of the required trigger words (look,
// project, notes, score, policy, search) in an innocuous sense. expectedTool
// is always "none" — the interesting measurement is whether the guidance
// pack that gets spliced in (image-search for "look", memory-core for
// "project"/"notes", full-mode for "score"/"policy") also causes an
// unwanted tool call, not just unwanted prompt text.

const falsePositiveWordFixtures: ToolGuidanceFixture[] = [
	{
		id: "fp-look-en",
		language: "en",
		category: "false_positive_word",
		isFollowUp: false,
		messages: [
			userTurn(
				"I've been meaning to look into learning to play the guitar someday — any tips for a total beginner?",
			),
		],
		expectedTool: "none",
	},
	{
		id: "fp-project-en",
		language: "en",
		category: "false_positive_word",
		isFollowUp: false,
		messages: [
			userTurn(
				"I want to start a small woodworking project this weekend — any beginner-friendly ideas?",
			),
		],
		expectedTool: "none",
	},
	{
		id: "fp-notes-en",
		language: "en",
		category: "false_positive_word",
		isFollowUp: false,
		messages: [
			userTurn(
				"Do you have any tips for taking better notes by hand versus typing them?",
			),
		],
		expectedTool: "none",
	},
	{
		id: "fp-score-en",
		language: "en",
		category: "false_positive_word",
		isFollowUp: false,
		messages: [
			userTurn(
				"How is a bowling score actually calculated when you get a strike?",
			),
		],
		expectedTool: "none",
	},
	{
		id: "fp-policy-en",
		language: "en",
		category: "false_positive_word",
		isFollowUp: false,
		messages: [
			userTurn(
				"As a general policy, I try to answer all my emails within 24 hours — is that a reasonable personal rule?",
			),
		],
		expectedTool: "none",
	},
	{
		id: "fp-search-en",
		language: "en",
		category: "false_positive_word",
		isFollowUp: false,
		messages: [
			userTurn(
				"In my old philosophy notes I wrote about the 'search for meaning' as a lifelong process — can you riff on that idea?",
			),
		],
		expectedTool: "none",
	},
	{
		id: "fp-project-hu",
		language: "hu",
		category: "false_positive_word",
		isFollowUp: false,
		messages: [
			userTurn(
				"Szeretnék belevágni egy kisebb asztalos projektbe ezen a hétvégén — van kezdőknek szóló ötleted?",
			),
		],
		expectedTool: "none",
	},
	{
		id: "fp-notes-hu",
		language: "hu",
		category: "false_positive_word",
		isFollowUp: false,
		messages: [
			userTurn(
				"Van valami tanácsod, hogyan lehet jobb kézzel írt jegyzeteket készíteni, mint gépelve?",
			),
		],
		expectedTool: "none",
	},
	{
		id: "fp-score-hu",
		language: "hu",
		category: "false_positive_word",
		isFollowUp: false,
		messages: [
			userTurn(
				"Hogyan számolják ki pontosan a bowling pontszámot, ha valaki strike-ot dob?",
			),
		],
		expectedTool: "none",
	},
	{
		id: "fp-policy-hu",
		language: "hu",
		category: "false_positive_word",
		isFollowUp: false,
		messages: [
			userTurn(
				"Általános szabályként igyekszem minden e-mailemre 24 órán belül válaszolni — ez egy ésszerű személyes elv?",
			),
		],
		expectedTool: "none",
	},
];

// ── C. false_negative_web (8: 5 EN + 3 HU) ──────────────────────────────
//
// Role-holder / volatile-fact questions that SHOULD trigger research_web but
// deliberately avoid every literal EN trigger word so pack selection likely
// stays compact (no web-core/web-detailed pack).

const falseNegativeWebFixtures: ToolGuidanceFixture[] = [
	{
		id: "fn-web-openai-ceo-en",
		language: "en",
		category: "false_negative_web",
		isFollowUp: false,
		messages: [userTurn("Who is the CEO of OpenAI right now?")],
		expectedTool: "research_web",
		expectedSignals: { citation: true },
	},
	{
		id: "fn-web-twitter-runs-en",
		language: "en",
		category: "false_negative_web",
		isFollowUp: false,
		messages: [userTurn("Who actually runs Twitter these days?")],
		expectedTool: "research_web",
		expectedSignals: { citation: true },
	},
	{
		id: "fn-web-anthropic-headcount-en",
		language: "en",
		category: "false_negative_web",
		isFollowUp: true,
		messages: [
			userTurn(
				"I've been reading about the big AI safety-focused labs, Anthropic in particular.",
			),
			assistantTurn(
				"Anthropic is known for its focus on AI safety research and the Claude model family. What would you like to know?",
			),
			userTurn("How many people work at Anthropic these days?"),
		],
		expectedTool: "research_web",
		expectedSignals: { citation: true },
	},
	{
		id: "fn-web-musk-networth-en",
		language: "en",
		category: "false_negative_web",
		isFollowUp: true,
		messages: [
			userTurn("Tesla had a pretty big product announcement this month."),
			assistantTurn(
				"Yes, Tesla has been in the news a lot lately between vehicle updates and Elon Musk's other ventures.",
			),
			userTurn("What's Elon Musk's net worth these days?"),
		],
		expectedTool: "research_web",
		expectedSignals: { citation: true },
	},
	{
		id: "fn-web-zuckerberg-meta-en",
		language: "en",
		category: "false_negative_web",
		isFollowUp: true,
		messages: [
			userTurn("Meta has been investing heavily in AI infrastructure."),
			assistantTurn(
				"That's right, Meta has poured billions into data centers and AI model development over the past couple of years.",
			),
			userTurn("Is Mark Zuckerberg still running Meta as CEO?"),
		],
		expectedTool: "research_web",
		expectedSignals: { citation: true },
	},
	{
		id: "fn-web-openai-ceo-hu",
		language: "hu",
		category: "false_negative_web",
		isFollowUp: false,
		messages: [userTurn("Ki az OpenAI jelenlegi vezérigazgatója?")],
		expectedTool: "research_web",
		expectedSignals: { citation: true },
	},
	{
		id: "fn-web-anthropic-headcount-hu",
		language: "hu",
		category: "false_negative_web",
		isFollowUp: false,
		messages: [userTurn("Hány embert foglalkoztat mostanában az Anthropic?")],
		expectedTool: "research_web",
		expectedSignals: { citation: true },
	},
	{
		id: "fn-web-zuckerberg-meta-hu",
		language: "hu",
		category: "false_negative_web",
		isFollowUp: false,
		messages: [userTurn("Mark Zuckerberg még mindig a Meta vezérigazgatója?")],
		expectedTool: "research_web",
		expectedSignals: { citation: true },
	},
];

// ── D. false_negative_file (6: 4 EN + 2 HU, ALL follow-up) ──────────────
//
// "Put THAT into a PDF" style — the referent only exists in the prior turn,
// so the final turn alone rarely matches FILE_INTENT_CONVERSION_RE or the
// FILE_REVISION_RE + FILE_EDIT_CONTEXT_RE combination used by pack
// selection, even though produce_file is clearly the right call.

const falseNegativeFileFixtures: ToolGuidanceFixture[] = [
	{
		id: "fn-file-recipe-pdf-en",
		language: "en",
		category: "false_negative_file",
		isFollowUp: true,
		messages: [
			userTurn("Give me a simple recipe for homemade pizza dough."),
			assistantTurn(
				"Sure — combine 500g flour, 325ml warm water, 7g instant yeast, 2 tsp salt, and 1 tbsp olive oil. Mix, knead for 10 minutes, then let it rise for about an hour before shaping.",
			),
			userTurn("Put that into a PDF for me."),
		],
		expectedTool: "produce_file",
		expectedSignals: { file: true },
	},
	{
		id: "fn-file-workout-pdf-en",
		language: "en",
		category: "false_negative_file",
		isFollowUp: true,
		messages: [
			userTurn(
				"Can you build me a simple 3-day beginner strength training plan?",
			),
			assistantTurn(
				"Day 1: squats, push-ups, rows. Day 2: rest or light cardio. Day 3: deadlifts, overhead press, pull-ups. Repeat weekly, adding weight gradually.",
			),
			userTurn(
				"Can you make that into something I can print out and stick on my fridge?",
			),
		],
		expectedTool: "produce_file",
		expectedSignals: { file: true },
	},
	{
		id: "fn-file-budget-pdf-en",
		language: "en",
		category: "false_negative_file",
		isFollowUp: true,
		messages: [
			userTurn(
				"Help me sketch a simple monthly budget: $3200 income, $1200 rent, $400 groceries, $200 utilities, $150 subscriptions.",
			),
			assistantTurn(
				"That leaves $1250 unallocated after those four categories — roughly 39% of your income for savings, debt, or discretionary spending.",
			),
			userTurn("Great, save this as something I can download."),
		],
		expectedTool: "produce_file",
		expectedSignals: { file: true },
	},
	{
		id: "fn-file-itinerary-pdf-en",
		language: "en",
		category: "false_negative_file",
		isFollowUp: true,
		messages: [
			userTurn("Sketch out a 3-day itinerary for a first trip to Lisbon."),
			assistantTurn(
				"Day 1: Alfama & São Jorge Castle. Day 2: Belém (Jerónimos Monastery, pastel de nata). Day 3: day trip to Sintra.",
			),
			userTurn(
				"Nice — get this ready as a file I can send to my travel partner.",
			),
		],
		expectedTool: "produce_file",
		expectedSignals: { file: true },
	},
	{
		id: "fn-file-recept-pdf-hu",
		language: "hu",
		category: "false_negative_file",
		isFollowUp: true,
		messages: [
			userTurn("Adj egy egyszerű receptet házi pizzatésztához."),
			assistantTurn(
				"Persze — keverj össze 500g lisztet, 325ml langyos vizet, 7g instant élesztőt, 2 teáskanál sót és 1 evőkanál olívaolajat. Gyúrd 10 percig, majd hagyd kelni kb. egy órát, mielőtt formázod.",
			),
			userTurn("Ezt csináld meg nekem egy letölthető fájlba."),
		],
		expectedTool: "produce_file",
		expectedSignals: { file: true },
	},
	{
		id: "fn-file-koltsegvetes-pdf-hu",
		language: "hu",
		category: "false_negative_file",
		isFollowUp: true,
		messages: [
			userTurn(
				"Segíts összeállítani egy egyszerű havi költségvetést: 1 100 000 Ft bevétel, 400 000 Ft bérleti díj, 150 000 Ft élelmiszer, 70 000 Ft rezsi.",
			),
			assistantTurn(
				"Ez 480 000 Ft-ot hagy szabadon e négy kategória után — a bevétel körülbelül 44%-a megtakarításra, adósságra vagy egyéb kiadásokra.",
			),
			userTurn("Szuper, mentsd el ezt egy letölthető formátumba."),
		],
		expectedTool: "produce_file",
		expectedSignals: { file: true },
	},
];

// ── E. length_cliff_short (6: 3 EN + 3 HU, <=8 words) ───────────────────
// ── F. length_cliff_long  (6: 3 EN + 3 HU, >=35 words) ──────────────────
//
// Paired 1:1 by underlying intent with length_cliff_long below (tesla price,
// cat photos, notes-to-PDF) so a report can compare the same intent at two
// very different lengths.

const lengthCliffShortFixtures: ToolGuidanceFixture[] = [
	{
		id: "len-short-tesla-price-en",
		language: "en",
		category: "length_cliff_short",
		isFollowUp: false,
		messages: [userTurn("Tesla Model 3 price right now?")],
		expectedTool: "research_web",
		expectedSignals: { citation: true },
	},
	{
		id: "len-short-cat-photos-en",
		language: "en",
		category: "length_cliff_short",
		isFollowUp: false,
		messages: [userTurn("Show me pictures of cute cats.")],
		expectedTool: "image_search",
		expectedSignals: { image: true },
	},
	{
		id: "len-short-notes-pdf-en",
		language: "en",
		category: "length_cliff_short",
		isFollowUp: true,
		messages: [
			userTurn("List 5 tips for better sleep."),
			assistantTurn(
				"1) Consistent sleep schedule. 2) No screens 1h before bed. 3) Cool, dark room. 4) Limit caffeine after noon. 5) Light exercise during the day.",
			),
			userTurn("Save that as a downloadable PDF."),
		],
		expectedTool: "produce_file",
		expectedSignals: { file: true },
	},
	{
		id: "len-short-tesla-price-hu",
		language: "hu",
		category: "length_cliff_short",
		isFollowUp: false,
		messages: [userTurn("Mennyibe kerül most a Tesla Model 3?")],
		expectedTool: "research_web",
		expectedSignals: { citation: true },
	},
	{
		id: "len-short-cat-photos-hu",
		language: "hu",
		category: "length_cliff_short",
		isFollowUp: false,
		messages: [userTurn("Mutass képeket aranyos macskákról.")],
		expectedTool: "image_search",
		expectedSignals: { image: true },
	},
	{
		id: "len-short-notes-pdf-hu",
		language: "hu",
		category: "length_cliff_short",
		isFollowUp: true,
		messages: [
			userTurn("Adj 5 tippet a jobb alváshoz."),
			assistantTurn(
				"1) Rendszeres alvási ütemterv. 2) Ne nézz képernyőt lefekvés előtt 1 órával. 3) Hűvös, sötét szoba. 4) Kerüld a koffeint dél után. 5) Napközbeni könnyű testmozgás.",
			),
			userTurn("Mentsd el ezt letölthető PDF-be."),
		],
		expectedTool: "produce_file",
		expectedSignals: { file: true },
	},
];

const lengthCliffLongFixtures: ToolGuidanceFixture[] = [
	{
		id: "len-long-tesla-price-en",
		language: "en",
		category: "length_cliff_long",
		isFollowUp: false,
		messages: [
			userTurn(
				"I've been going back and forth for a couple of weeks now trying to decide whether to finally commit to buying a Tesla Model 3, and before I make any decision I'd really like to know roughly how much the base trim actually costs to buy today.",
			),
		],
		expectedTool: "research_web",
		expectedSignals: { citation: true },
	},
	{
		id: "len-long-cat-photos-en",
		language: "en",
		category: "length_cliff_long",
		isFollowUp: false,
		messages: [
			userTurn(
				"My daughter has been asking me all week for a cat, and before we actually go to the shelter this weekend I thought it might cheer her up if you could show her a handful of really cute pictures of kittens playing together right now.",
			),
		],
		expectedTool: "image_search",
		expectedSignals: { image: true },
	},
	{
		id: "len-long-notes-pdf-en",
		language: "en",
		category: "length_cliff_long",
		isFollowUp: true,
		messages: [
			userTurn("List 5 tips for better sleep."),
			assistantTurn(
				"1) Consistent sleep schedule. 2) No screens 1h before bed. 3) Cool, dark room. 4) Limit caffeine after noon. 5) Light exercise during the day.",
			),
			userTurn(
				"Those are genuinely helpful, thank you — I'd like to actually stick them somewhere I'll see them every night, so could you take everything you just gave me and turn it into a proper downloadable PDF file I can print out and pin above my bed?",
			),
		],
		expectedTool: "produce_file",
		expectedSignals: { file: true },
	},
	{
		id: "len-long-tesla-price-hu",
		language: "hu",
		category: "length_cliff_long",
		isFollowUp: false,
		messages: [
			userTurn(
				"Már jó pár hete azon gondolkodom, hogy vajon végre belevágjak-e egy Tesla Model 3 megvásárlásába, és mielőtt bármilyen komolyabb döntést hoznék ebben az ügyben, tényleg nagyon szeretném pontosan tudni, hogy nagyjából mennyibe kerül most az alapkivitel megvásárlása itthon.",
			),
		],
		expectedTool: "research_web",
		expectedSignals: { citation: true },
	},
	{
		id: "len-long-cat-photos-hu",
		language: "hu",
		category: "length_cliff_long",
		isFollowUp: false,
		messages: [
			userTurn(
				"A lányom egész héten azt kérdezgeti tőlem, hogy kaphat-e végre egy macskát, és mielőtt hétvégén tényleg elmennénk a menhelyre, arra gondoltam, biztosan felvidítaná, ha most mutatnál neki néhány igazán cuki képet, ahogy kiscicák együtt játszanak valahol.",
			),
		],
		expectedTool: "image_search",
		expectedSignals: { image: true },
	},
	{
		id: "len-long-notes-pdf-hu",
		language: "hu",
		category: "length_cliff_long",
		isFollowUp: true,
		messages: [
			userTurn("Adj 5 tippet a jobb alváshoz."),
			assistantTurn(
				"1) Rendszeres alvási ütemterv. 2) Ne nézz képernyőt lefekvés előtt 1 órával. 3) Hűvös, sötét szoba. 4) Kerüld a koffeint dél után. 5) Napközbeni könnyű testmozgás.",
			),
			userTurn(
				"Ezek tényleg nagyon hasznosak voltak, köszönöm szépen — szeretném valahova kitenni őket úgy, hogy minden egyes este lássam lefekvés előtt, szóval megtennéd nekem, hogy mindazt, amit az előbb pontosan leírtál, átalakítod egy rendes, letölthető PDF fájllá, amit ki tudok nyomtatni és kifüggeszthetek az ágyam fölé a falra?",
			),
		],
		expectedTool: "produce_file",
		expectedSignals: { file: true },
	},
];

// ── G. image_search_case (4: 2 EN + 2 HU) ───────────────────────────────

const imageSearchCaseFixtures: ToolGuidanceFixture[] = [
	{
		id: "img-eiffel-tower-en",
		language: "en",
		category: "image_search_case",
		isFollowUp: false,
		messages: [
			userTurn("Can you find some photos of the Eiffel Tower lit up at night?"),
		],
		expectedTool: "image_search",
		expectedSignals: { image: true },
	},
	{
		id: "img-pasta-plating-en",
		language: "en",
		category: "image_search_case",
		isFollowUp: false,
		messages: [
			userTurn(
				"I need some inspiration pictures for how to plate a pasta dish nicely.",
			),
		],
		expectedTool: "image_search",
		expectedSignals: { image: true },
	},
	{
		id: "img-halaszbastya-hu",
		language: "hu",
		category: "image_search_case",
		isFollowUp: false,
		messages: [
			userTurn(
				"Tudnál mutatni néhány fotót a budapesti Halászbástyáról napnyugtakor?",
			),
		],
		expectedTool: "image_search",
		expectedSignals: { image: true },
	},
	{
		id: "img-eskuvoi-dekor-hu",
		language: "hu",
		category: "image_search_case",
		isFollowUp: false,
		messages: [
			userTurn(
				"Keress nekem inspiráló képeket egyszerű, letisztult esküvői dekorációról.",
			),
		],
		expectedTool: "image_search",
		expectedSignals: { image: true },
	},
];

// ── H. memory_context_case (4: 2 EN + 2 HU) ─────────────────────────────

const memoryContextCaseFixtures: ToolGuidanceFixture[] = [
	{
		id: "mem-old-conversation-en",
		language: "en",
		category: "memory_context_case",
		isFollowUp: false,
		messages: [
			userTurn(
				"Did we ever talk about which city I was planning to move to last year?",
			),
		],
		expectedTool: "memory_context",
	},
	{
		id: "mem-diet-preference-en",
		language: "en",
		category: "memory_context_case",
		isFollowUp: true,
		messages: [
			userTurn("I'm meal-prepping for the week."),
			assistantTurn("Nice, want a few recipe ideas?"),
			userTurn(
				"Sure, but first — what have I told you before about my dietary restrictions?",
			),
		],
		expectedTool: "memory_context",
	},
	{
		id: "mem-korabbi-beszelgetes-hu",
		language: "hu",
		category: "memory_context_case",
		isFollowUp: false,
		messages: [
			userTurn(
				"Beszéltünk már korábban arról, melyik városba terveztem költözni tavaly?",
			),
		],
		expectedTool: "memory_context",
	},
	{
		id: "mem-etkezesi-preferencia-hu",
		language: "hu",
		category: "memory_context_case",
		isFollowUp: true,
		messages: [
			userTurn("Heti étkezéstervezést csinálok."),
			assistantTurn("Remek, szeretnél néhány recept ötletet?"),
			userTurn(
				"Igen, de előtte — mit mondtam korábban az étkezési korlátozásaimról?",
			),
		],
		expectedTool: "memory_context",
	},
];

// ── I. fetch_url_case (4: 2 EN + 2 HU) ──────────────────────────────────

const fetchUrlCaseFixtures: ToolGuidanceFixture[] = [
	{
		id: "url-fetch-article-en",
		language: "en",
		category: "fetch_url_case",
		isFollowUp: false,
		messages: [
			userTurn(
				"Can you read this article and summarize the key points? https://example.com/articles/remote-work-trends-2026",
			),
		],
		expectedTool: "fetch_url",
		expectedSignals: { citation: true },
	},
	{
		id: "url-fetch-product-en",
		language: "en",
		category: "fetch_url_case",
		isFollowUp: false,
		messages: [
			userTurn(
				"What does this product page say about the return policy? https://example.com/products/wireless-earbuds-pro",
			),
		],
		expectedTool: "fetch_url",
		expectedSignals: { citation: true },
	},
	{
		id: "url-fetch-cikk-hu",
		language: "hu",
		category: "fetch_url_case",
		isFollowUp: false,
		messages: [
			userTurn(
				"El tudnád olvasni ezt a cikket, és összefoglalni a lényeget? https://example.com/cikkek/tavmunka-trendek-2026",
			),
		],
		expectedTool: "fetch_url",
		expectedSignals: { citation: true },
	},
	{
		id: "url-fetch-termek-hu",
		language: "hu",
		category: "fetch_url_case",
		isFollowUp: false,
		messages: [
			userTurn(
				"Mit ír ez a termékoldal a visszaküldési feltételekről? https://example.com/termekek/vezetek-nelkuli-fulhallgato",
			),
		],
		expectedTool: "fetch_url",
		expectedSignals: { citation: true },
	},
];

// ── J. control (4: 2 EN + 2 HU) ─────────────────────────────────────────
//
// Ordinary conversational turns with no tool need — a plain baseline so the
// corpus isn't 100% trigger-hunting.

const controlFixtures: ToolGuidanceFixture[] = [
	{
		id: "ctrl-dream-smalltalk-en",
		language: "en",
		category: "control",
		isFollowUp: true,
		messages: [
			userTurn("Why do we dream?"),
			assistantTurn(
				"Dreaming is thought to help process emotions and consolidate memories, though scientists still debate its exact purpose.",
			),
			userTurn(
				"That's a really interesting way to think about it, thanks for explaining.",
			),
		],
		expectedTool: "none",
	},
	{
		id: "ctrl-programmer-joke-en",
		language: "en",
		category: "control",
		isFollowUp: false,
		messages: [userTurn("Tell me a short joke about programmers.")],
		expectedTool: "none",
	},
	{
		id: "ctrl-almodas-kisbeszelgetes-hu",
		language: "hu",
		category: "control",
		isFollowUp: true,
		messages: [
			userTurn("Miért álmodunk?"),
			assistantTurn(
				"Az álmodás feltehetően segít feldolgozni az érzelmeket és rögzíteni az emlékeket, bár a tudósok még vitatják a pontos célját.",
			),
			userTurn(
				"Ez tényleg érdekes módja a dolog megközelítésének, köszönöm a magyarázatot.",
			),
		],
		expectedTool: "none",
	},
	{
		id: "ctrl-programozo-vicc-hu",
		language: "hu",
		category: "control",
		isFollowUp: false,
		messages: [userTurn("Mondj egy rövid viccet a programozókról.")],
		expectedTool: "none",
	},
];

export const toolGuidanceFixtures: ToolGuidanceFixture[] = [
	...languagePairFixtures,
	...falsePositiveWordFixtures,
	...falseNegativeWebFixtures,
	...falseNegativeFileFixtures,
	...lengthCliffShortFixtures,
	...lengthCliffLongFixtures,
	...imageSearchCaseFixtures,
	...memoryContextCaseFixtures,
	...fetchUrlCaseFixtures,
	...controlFixtures,
];

export type ToolGuidanceCorpusStats = {
	total: number;
	huCount: number;
	huPercent: number;
	enCount: number;
	followUpCount: number;
	byCategory: Record<string, number>;
	byExpectedTool: Record<string, number>;
};

/**
 * Pure descriptive-statistics summary of the corpus (not a scoring
 * function — no model output involved). Used by the harness to render the
 * "corpus breakdown" section of its report, and by
 * `tool-guidance-fixtures.test.ts` to guard the corpus-shape constraints
 * (>=60 turns, >=40% Hungarian, >=15 follow-up turns) as a regression test
 * rather than a one-time hand count.
 */
export function summarizeToolGuidanceCorpus(
	fixtures: ToolGuidanceFixture[],
): ToolGuidanceCorpusStats {
	const total = fixtures.length;
	const huCount = fixtures.filter((f) => f.language === "hu").length;
	const enCount = total - huCount;
	const followUpCount = fixtures.filter((f) => f.isFollowUp).length;

	const byCategory: Record<string, number> = {};
	const byExpectedTool: Record<string, number> = {};
	for (const fixture of fixtures) {
		byCategory[fixture.category] = (byCategory[fixture.category] ?? 0) + 1;
		byExpectedTool[fixture.expectedTool] =
			(byExpectedTool[fixture.expectedTool] ?? 0) + 1;
	}

	return {
		total,
		huCount,
		huPercent: total > 0 ? huCount / total : 0,
		enCount,
		followUpCount,
		byCategory,
		byExpectedTool,
	};
}
