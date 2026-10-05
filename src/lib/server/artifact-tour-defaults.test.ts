import { describe, expect, it } from "vitest";
import artifactsDict from "$lib/i18n/artifacts";
import {
	type ArtifactTourType,
	SHIPPED_ARTIFACT_TOUR_TYPES,
} from "$lib/shared/artifacts/tours";
import {
	ARTIFACT_TOUR_CONTENT_VERSION,
	ARTIFACT_TOUR_DEFAULTS,
} from "./artifact-tour-defaults";

const KINDS: ArtifactTourType[] = ["document", "app", "canvas", "slides"];

describe("ARTIFACT_TOUR_DEFAULTS", () => {
	it("has a default for every tour type, and file is not one of them", () => {
		expect(Object.keys(ARTIFACT_TOUR_DEFAULTS).sort()).toEqual(
			[...KINDS].sort(),
		);
		expect(Object.keys(ARTIFACT_TOUR_DEFAULTS)).not.toContain("file");
	});

	it("keeps the derived union honest: ArtifactTourType has exactly four members", () => {
		// A compile-time exhaustiveness check: if `ArtifactKind` grows a sixth
		// kind, `ArtifactTourType` widens and this object literal stops
		// type-checking until the new kind gets copy in ARTIFACT_TOUR_DEFAULTS.
		const exhaustive: Record<ArtifactTourType, true> = {
			document: true,
			app: true,
			canvas: true,
			slides: true,
		};
		expect(Object.keys(exhaustive)).toHaveLength(4);
	});

	it("gives every default exactly three slides", () => {
		for (const kind of KINDS) {
			expect(ARTIFACT_TOUR_DEFAULTS[kind].slides).toHaveLength(3);
		}
	});

	it("gives every default both en and hu for every title, body and summary", () => {
		for (const kind of KINDS) {
			const content = ARTIFACT_TOUR_DEFAULTS[kind];
			expect(content.summary.en.length).toBeGreaterThan(0);
			expect(content.summary.hu.length).toBeGreaterThan(0);
			for (const slide of content.slides) {
				expect(slide.title.en.length).toBeGreaterThan(0);
				expect(slide.title.hu.length).toBeGreaterThan(0);
				expect(slide.body.en.length).toBeGreaterThan(0);
				expect(slide.body.hu.length).toBeGreaterThan(0);
			}
		}
	});

	it("keeps en and hu at paragraph parity for every slide", () => {
		// Neither language is left as a placeholder or a copy of the other.
		for (const kind of KINDS) {
			const content = ARTIFACT_TOUR_DEFAULTS[kind];
			expect(content.summary.en).not.toBe(content.summary.hu);
			for (const slide of content.slides) {
				expect(slide.title.en).not.toBe(slide.title.hu);
				expect(slide.body.en).not.toBe(slide.body.hu);
			}
		}
	});

	// Every string a kind's default copy says: the summary and the three
	// slides' titles and bodies, in one language or in both.
	function strings(kind: ArtifactTourType, languages: ("en" | "hu")[]) {
		const content = ARTIFACT_TOUR_DEFAULTS[kind];
		return languages.flatMap((language) => [
			content.summary[language],
			...content.slides.flatMap((slide) => [
				slide.title[language],
				slide.body[language],
			]),
		]);
	}

	it("never says the word artifact in any default string, in either language", () => {
		// ADR-0066: "Artifact" is engineering's word; the Hungarian one is the
		// same word with Hungarian endings ("artefaktum").
		for (const kind of KINDS) {
			for (const value of strings(kind, ["en", "hu"])) {
				expect(value, `${kind}: ${value}`).not.toMatch(/artifact|artefakt/i);
			}
		}
	});

	// The tour is where a reader learns what a kind is called, so it is the worst
	// place to invent a fifth word for it (slice 6 T7).
	it("says each kind's ratified Hungarian name in its own Hungarian copy", () => {
		const ratified = {
			document: "dokumentum",
			app: "alkalmazás",
			canvas: "tábla",
			slides: "diasor",
		} as const;
		for (const kind of KINDS) {
			// The ratified name is the artifacts.type.* row, which is the source…
			expect(artifactsDict.hu[`artifacts.type.${kind}`].toLowerCase()).toBe(
				ratified[kind],
			);
			// …and the kind's own Hungarian copy says it, in some inflection.
			expect(
				strings(kind, ["hu"]).join(" ").toLowerCase(),
				`${kind} names itself`,
			).toContain(ratified[kind]);
		}
	});

	it("never names a kind in Hungarian by an English word or an invented one", () => {
		// "vászon" is what "canvas" becomes when someone translates it as a noun.
		const foreign = /\b(canvas|document|slides?|deck|apps?)\b|vászon/i;
		for (const kind of KINDS) {
			for (const value of strings(kind, ["hu"])) {
				expect(value, `${kind}: ${value}`).not.toMatch(foreign);
			}
		}
	});

	it("uses the shipped copy verbatim, per kind and language", () => {
		expect(ARTIFACT_TOUR_DEFAULTS.document).toEqual({
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
						hu: "Írhatsz közvetlenül, kipipálhatod a listákat, és táblázatokat vagy füleket adhatsz hozzá. Alfy módosításai kiemelve érkeznek, mellettük a Megtartás és a Visszavonás.",
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
		});

		expect(ARTIFACT_TOUR_DEFAULTS.app).toEqual({
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
		});

		expect(ARTIFACT_TOUR_DEFAULTS.canvas).toEqual({
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
		});

		expect(ARTIFACT_TOUR_DEFAULTS.slides).toEqual({
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
		});
	});

	it("names the type the way the UI does, per language", () => {
		// artifacts.type.* parity: the four kinds this file knows about are
		// exactly the four kinds the UI names via artifacts.type.*, in both
		// shipped languages, so the tour can never introduce a fifth word.
		for (const kind of KINDS) {
			const key = `artifacts.type.${kind}` as keyof typeof artifactsDict.en;
			expect(artifactsDict.en[key]).toBeTruthy();
			expect(artifactsDict.hu[key]).toBeTruthy();
		}
	});

	it("keeps Slides' copy for its return, and reaches nobody with it (ruling 69)", () => {
		// The table has an entry for every kind a tour can be written for; the
		// shipped list is what decides who is served. Slides is in the first
		// and not in the second, so its copy is dead data until Slides ships.
		expect(ARTIFACT_TOUR_DEFAULTS.slides.slides).toHaveLength(3);
		expect(SHIPPED_ARTIFACT_TOUR_TYPES).not.toContain("slides");
		// Every shipped kind has copy, so nothing on the list can come up empty.
		for (const kind of SHIPPED_ARTIFACT_TOUR_TYPES) {
			expect(ARTIFACT_TOUR_DEFAULTS[kind].slides).toHaveLength(3);
		}
	});

	it("has a stable content version", () => {
		expect(ARTIFACT_TOUR_CONTENT_VERSION).toBe(1);
	});
});
