/**
 * The code-owned first-open tour copy (Feature 2 · Artifacts, Slice 6) — the
 * same shape as `prompts.ts`'s `SYSTEM_PROMPTS` registry: content that ships
 * in code so the feature works before any admin publishes a campaign
 * (ADR-0012 says a seeded template is not auto-published), and that a
 * published `artifact_tour` campaign snapshot overrides per kind
 * (`services/artifact-tours.ts`, decisions.md ruling 4).
 *
 * The table holds copy for every kind a tour can be written for, which is more
 * than the kinds whose tour ships: ruling 69 shelved Slides, so its entry
 * waits here, unreachable, until `SHIPPED_ARTIFACT_TOUR_TYPES`
 * (`$lib/shared/artifacts/tours`) names it. Nothing may serve, seed or list a
 * kind by walking this table's keys; walk the shipped list.
 *
 * Every string here is shipped product copy, not a placeholder — see
 * `docs/plans/claude-at-home-2/slice-6.md` §"The shipped copy" for the table
 * this file transcribes verbatim. "Artifact" never appears (ADR-0066); the
 * tour names the kind the way the rest of the UI does, through
 * `artifacts.type.*`.
 */
import type {
	ArtifactTourSlideContent,
	ArtifactTourType,
	LocalizedText,
} from "$lib/shared/artifacts/tours";

export type ArtifactTourContent = {
	artifactType: ArtifactTourType;
	summary: LocalizedText;
	/** Exactly three, in order — checked in artifact-tour-defaults.test.ts. */
	slides: ArtifactTourSlideContent[];
};

/**
 * Bumping this re-shows every default tour once, deliberately. It is a
 * product decision, not a cache key: raise it only when the shipped copy
 * changed in a way a user should see again.
 */
export const ARTIFACT_TOUR_CONTENT_VERSION = 1;

export const ARTIFACT_TOUR_DEFAULTS: Record<
	ArtifactTourType,
	ArtifactTourContent
> = {
	document: {
		artifactType: "document",
		summary: {
			en: "Empty document. Start writing, or ask Alfy to draft it.",
			hu: "Üres dokumentum. Kezdj el írni, vagy kérd meg Alfyt, hogy megírja.",
		},
		slides: [
			{
				title: {
					en: "A page you both write on",
					hu: "Egy lap, amit ketten írtok",
				},
				body: {
					en: "A document is a real file you keep, not a message that scrolls away. Alfy edits it with you, and every version is kept.",
					hu: "A dokumentum igazi fájl, ami megmarad — nem üzenet, ami elgörög. Alfy együtt szerkeszti veled, és minden verzió megmarad.",
				},
			},
			{
				title: {
					en: "What you can do in it",
					hu: "Mit tudsz benne csinálni",
				},
				body: {
					en: "Type directly, tick off checklists, and add tables or tabs. Alfy's changes arrive highlighted, with Keep and Undo beside them.",
					hu: "Írhatsz közvetlenül, kipipálhatod a listákat, és táblázatokat vagy füleket adhatsz hozzá. Alfy módosításai kiemelve érkeznek, mellettük a „Megtartom” és a „Visszavonom” gomb.",
				},
			},
			{
				title: { en: "How to ask for one", hu: "Hogyan kérj ilyet" },
				body: {
					en: 'Say what you need — "write up the meeting notes", "draft the letter" — and Alfy opens it here. Any answer can also be opened as a document.',
					hu: "Mondd el, mire van szükséged — „írd meg a megbeszélés jegyzőkönyvét”, „fogalmazd meg a levelet” —, és Alfy itt nyitja meg. Bármelyik válasz megnyitható dokumentumként is.",
				},
			},
		],
	},
	app: {
		artifactType: "app",
		summary: {
			en: "Nothing here yet. Ask Alfy to build a small tool.",
			hu: "Itt még nincs semmi. Kérd meg Alfyt, hogy építsen egy kis eszközt.",
		},
		slides: [
			{
				title: {
					en: "A small tool that runs here",
					hu: "Egy kis eszköz, ami itt fut",
				},
				body: {
					en: "A self-contained program built for one job: a calculator, a quiz, a tracker. It runs here, in this panel, beside the chat that made it.",
					hu: "Önálló program, egyetlen feladatra: egy kalkulátor, egy kvíz, egy nyilvántartó. Itt fut, ebben a panelben, a chat mellett, amiben készült.",
				},
			},
			{
				title: {
					en: "It remembers what you put in it",
					hu: "Megjegyzi, amit beírtál",
				},
				body: {
					en: "Your answers are stored with the app, so they are still there tomorrow. They stay in your account, and nothing is shared.",
					hu: "A válaszaid az alkalmazásnál maradnak, így holnap is ott lesznek. A fiókodban maradnak, és semmi nem kerül megosztásra.",
				},
			},
			{
				title: { en: "How to ask for one", hu: "Hogyan kérj ilyet" },
				body: {
					en: 'Describe the tool and the job: "a tip calculator", "a quiz on the French Revolution". Alfy builds it, checks the numbers, then shows it.',
					hu: "Írd le az eszközt és a feladatát: „borravaló-kalkulátor”, „kvíz a francia forradalomról”. Alfy megépíti, ellenőrzi a számokat, aztán megmutatja.",
				},
			},
		],
	},
	canvas: {
		artifactType: "canvas",
		summary: {
			en: "Empty board. Insert a block or draw on it.",
			hu: "Üres tábla. Szúrj be egy blokkot, vagy rajzolj rá.",
		},
		slides: [
			{
				title: { en: "A board for anything", hu: "Egy tábla, bármire" },
				body: {
					en: "A free surface: sticky notes, frames, arrows and live blocks, arranged however you think. It is for arranging, not for writing.",
					hu: "Szabad felület: cetlik, keretek, nyilak és élő blokkok, úgy elrendezve, ahogy gondolkodsz. Rendezésre való, nem írásra.",
				},
			},
			{
				title: {
					en: "Draw on it, and place things",
					hu: "Rajzolj rá, és helyezz el dolgokat",
				},
				body: {
					en: "Sketch with pen and highlighter, drop in a chart, a checklist, a map or a file, then pan and zoom without losing the thread.",
					hu: "Firkálhatsz tollal és kiemelővel, behúzhatsz diagramot, listát, térképet vagy fájlt, aztán görgethetsz és nagyíthatsz anélkül, hogy elveszítenéd a fonalat.",
				},
			},
			{
				title: { en: "How to ask for one", hu: "Hogyan kérj ilyet" },
				body: {
					en: 'Ask for a board when the shape of the problem matters: "put the trip options on a board". Alfy can also rearrange a board you already have.',
					hu: "Akkor kérj táblát, amikor a probléma elrendezése számít: „tedd a táblára az útiterveket”. Egy meglévő táblát is át tud rendezni.",
				},
			},
		],
	},
	// Plan 2b T16. The Image has no empty state (an item always holds a
	// picture), so its summary is never an empty-state line: it is the tour's
	// one-line gist, what the admin's preview shows on the summary slide. The
	// slides name the panel's controls by their labels (Before / After, Mark,
	// Attach, History's Restore), and the test holds them to the dictionary.
	image: {
		artifactType: "image",
		summary: {
			en: "A picture Alfy made. Ask for a change and it becomes a new version.",
			hu: "Egy kép, amit Alfy készített. Kérj rajta változtatást, és új verzió lesz belőle.",
		},
		slides: [
			{
				title: { en: "Your picture, in versions", hu: "A képed, verziókban" },
				body: {
					en: "This is the picture Alfy made for you. Ask for a change in the chat and you get a new version; the earlier ones are kept.",
					hu: "Ezt a képet Alfy készítette neked. Kérj rajta változtatást a chatben, és új verziót kapsz; a korábbiak megmaradnak.",
				},
			},
			{
				title: {
					en: "Before / After, and Mark",
					hu: "Előtte / Utána, és Jelölés",
				},
				body: {
					en: "When a picture was made from another, Before / After shows what changed. With Mark, draw lettered boxes on it: they go with your next message, so Alfy knows where to change it.",
					hu: "Ha a kép egy másikból készült, az Előtte / Utána megmutatja, mi változott. A Jelöléssel betűs kereteket rajzolhatsz rá: a következő üzeneteddel mennek, így Alfy tudja, hol változtasson.",
				},
			},
			{
				title: {
					en: "Earlier pictures, and Attach",
					hu: "Korábbi képek és Csatolás",
				},
				body: {
					en: "An earlier picture opens History: drag to compare two versions, and Restore the one you want. Attach puts this picture into your next message.",
					hu: "Egy korábbi kép megnyitja az Előzményeket: húzással összevetheted a két verziót, és a Visszaállítással visszahozhatod, amelyiket szeretnéd. A Csatolás a következő üzenetedbe teszi ezt a képet.",
				},
			},
		],
	},
	slides: {
		artifactType: "slides",
		summary: {
			en: "Empty deck. Add a slide to start.",
			hu: "Üres diasor. Adj hozzá egy diát a kezdéshez.",
		},
		slides: [
			{
				title: {
					en: "A deck you can present",
					hu: "Egy diasor, amit bemutathatsz",
				},
				body: {
					en: "A real deck: a fixed set of layouts, speaker notes, and a present mode that fills the screen.",
					hu: "Igazi diasor: rögzített elrendezések, előadói jegyzetek, és egy vetítő mód, ami kitölti a képernyőt.",
				},
			},
			{
				title: { en: "Built for export", hu: "Exportra készült" },
				body: {
					en: "Because the layouts are fixed, the deck exports to PowerPoint cleanly. The file is a real .pptx, not a picture of one.",
					hu: "Mivel az elrendezések rögzítettek, a diasor tisztán exportálható PowerPointba. A fájl igazi .pptx, nem annak a képe.",
				},
			},
			{
				title: { en: "How to ask for one", hu: "Hogyan kérj ilyet" },
				body: {
					en: 'Ask for a deck and say who it is for: "a six-slide intro to the project for Monday". You can also ask about one slide at a time.',
					hu: "Kérj diasort, és mondd meg, kinek szól: „hat diás bemutató a projektről hétfőre”. Egyetlen diáról is kérdezhetsz.",
				},
			},
		],
	},
};
