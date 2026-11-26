import type { MemoryKind } from "$lib/memory-types";
import type {
	JudgeDate,
	JudgeEntry,
	JudgeFixture,
	JudgeJunkReason,
	JudgeQuestion,
	JudgeVerdict,
} from "./quality-judge";

/**
 * The quality judge's synthetic set (Layer 2 of the Memory quality report):
 * made-up entries, each with the verdict a careful reader gives it, half in
 * Hungarian and half in English. They cover every junk reason in both
 * languages, the three kinds, plausible, implausible and missing event
 * dates, and true and false repeats. Every name and detail is invented, or a
 * public fact for the entries that are not about the person; none is anyone's
 * data. `lenient` names the questions a careful reader could answer either
 * way, so agreement is reported with and without them. The kinds follow bank
 * config 3's words (a purchase is lasting). The judge's prompt uses none of
 * these entries as an example (`QUALITY_JUDGE_PROMPT`), so the check measures
 * the model. The file name keeps it out of the source scan for Hungarian
 * letters, as the memory judge's eval set is: these entries are data the
 * model reads, never the app's own words.
 */

function useful(
	kind: MemoryKind,
	date: JudgeDate = "no_date",
	duplicateOf: string | null = null,
): JudgeVerdict {
	return { useful: true, junkReason: null, kind, date, duplicateOf };
}

function junk(
	junkReason: JudgeJunkReason,
	kind: MemoryKind,
	date: JudgeDate = "no_date",
): JudgeVerdict {
	return { useful: false, junkReason, kind, date, duplicateOf: null };
}

/** A fixture's entry: its id is the fixture's name, `stored` the kind the store would hold. */
interface FixtureEntry {
	text: string;
	stored: MemoryKind | null;
	said: string;
	event?: string;
	candidates?: JudgeEntry["candidates"];
}

function inLanguage(language: JudgeFixture["language"]) {
	return (
		name: string,
		entry: FixtureEntry,
		expect: JudgeVerdict,
		lenient?: readonly JudgeQuestion[],
	): JudgeFixture => ({
		name,
		language,
		entry: {
			id: name,
			text: entry.text,
			kind: entry.stored,
			eventAt: entry.event ?? null,
			lastMentionedAt: entry.said,
			candidates: entry.candidates ?? [],
		},
		expect,
		...(lenient ? { lenient } : {}),
	});
}

const en = inLanguage("en");
const hu = inLanguage("hu");

const ENGLISH: JudgeFixture[] = [
	en(
		"en-01-sister-vienna",
		{
			text: "The user's sister, Clara, lives in Vienna and works as a pharmacist.",
			stored: "lasting",
			said: "2025-04-02T18:20:00.000Z",
		},
		useful("lasting"),
	),
	// Config 3: something bought is lasting however recently, even when the
	// store still holds the older config's temporary.
	en(
		"en-02-ebike-purchase",
		{
			text: "The user bought a red e-bike in May 2025 and rides it to work.",
			stored: "temporary",
			said: "2025-05-12T07:45:00.000Z",
			event: "2025-05-10T00:00:00.000Z",
		},
		useful("lasting", "plausible"),
	),
	en(
		"en-03-thesis",
		{
			text: "The user is writing a master's thesis on wetland birds.",
			stored: "ongoing",
			said: "2025-03-15T10:05:00.000Z",
		},
		useful("ongoing"),
	),
	en(
		"en-04-wisdom-tooth",
		{
			text: "The user is having a wisdom tooth removed at the dentist on 21 November 2025.",
			stored: "temporary",
			said: "2025-11-17T09:30:00.000Z",
			event: "2025-11-21T00:00:00.000Z",
		},
		useful("temporary", "plausible"),
	),
	en(
		"en-05-slide-title",
		{
			text: "The user needs a catchy title for a slide deck about office recycling.",
			stored: "temporary",
			said: "2025-06-03T14:10:00.000Z",
		},
		junk("request_or_task", "temporary"),
		["kind"],
	),
	en(
		"en-06-wine-stain",
		{
			text: "The user asked how to get a red wine stain out of a wool carpet.",
			stored: null,
			said: "2025-01-04T20:40:00.000Z",
		},
		junk("request_or_task", "temporary"),
		["kind"],
	),
	en(
		"en-07-sourdough",
		{
			text: "The assistant explained that sourdough should rise for 4 to 12 hours, depending on the room temperature.",
			stored: "lasting",
			said: "2025-02-20T08:15:00.000Z",
		},
		junk("assistant_content", "lasting"),
		["kind", "junkReason"],
	),
	en(
		"en-08-stretching",
		{
			text: "The assistant recommended a 20-minute stretching routine with five exercises.",
			stored: "temporary",
			said: "2025-07-01T06:50:00.000Z",
		},
		junk("assistant_content", "temporary"),
		["kind"],
	),
	en(
		"en-09-thanks",
		{
			text: "The user thanked the assistant and wished it a nice evening.",
			stored: "temporary",
			said: "2025-03-30T21:00:00.000Z",
		},
		junk("small_talk_or_vague", "temporary"),
		["kind"],
	),
	en(
		"en-10-vague-work",
		{
			text: "The user is interested in some things related to their work.",
			stored: "lasting",
			said: "2025-05-19T11:00:00.000Z",
		},
		junk("small_talk_or_vague", "lasting"),
		["kind"],
	),
	en(
		"en-11-rain",
		{
			text: "The user got caught in the rain on the way home on Tuesday.",
			stored: "temporary",
			said: "2025-02-11T19:00:00.000Z",
			event: "2025-02-11T00:00:00.000Z",
		},
		junk("passing_event", "temporary", "plausible"),
	),
	en(
		"en-12-coffee-keyboard",
		{
			text: "The user spilled coffee on their keyboard this morning.",
			stored: "temporary",
			said: "2025-03-10T09:12:00.000Z",
			event: "2025-03-10T00:00:00.000Z",
		},
		junk("passing_event", "temporary", "plausible"),
	),
	en(
		"en-13-capital",
		{
			text: "Canberra is the capital of Australia.",
			stored: "lasting",
			said: "2025-04-14T16:00:00.000Z",
		},
		junk("not_about_the_person", "lasting"),
		["kind"],
	),
	en(
		"en-14-fictional-detective",
		{
			text: "Sherlock Holmes lives at 221B Baker Street in London.",
			stored: null,
			said: "2025-06-22T13:30:00.000Z",
		},
		junk("not_about_the_person", "lasting"),
		["kind"],
	),
	// Config 3: how the assistant should answer in general is kept, even as a request.
	en(
		"en-15-short-answers",
		{
			text: "The user prefers short answers without bullet points.",
			stored: "lasting",
			said: "2025-08-02T12:00:00.000Z",
		},
		useful("lasting"),
	),
	en(
		"en-16-move-dated-ahead",
		{
			text: "The user moved from Leeds to Bristol in 2019.",
			stored: "lasting",
			said: "2025-01-14T18:00:00.000Z",
			event: "2029-06-30T00:00:00.000Z",
		},
		useful("lasting", "implausible"),
	),
	en(
		"en-17-plan-dated-before",
		{
			text: "The user plans to run the Lisbon half marathon next March.",
			stored: "temporary",
			said: "2025-09-20T07:00:00.000Z",
			event: "2017-03-19T00:00:00.000Z",
		},
		useful("temporary", "implausible"),
		["kind"],
	),
	en(
		"en-18-son-born",
		{
			text: "The user's son, Oliver, was born on 3 March 2021.",
			stored: "lasting",
			said: "2025-05-05T19:20:00.000Z",
			event: "2021-03-03T00:00:00.000Z",
		},
		useful("lasting", "plausible"),
	),
	en(
		"en-19-graz-repeat",
		{
			text: "The user lives in Graz with their partner, Tom.",
			stored: "lasting",
			said: "2025-04-20T10:00:00.000Z",
			candidates: [
				{
					id: "en-19-c1",
					text: "The user lives with their partner Tom in Graz.",
				},
				{
					id: "en-19-c2",
					text: "The user's partner, Tom, works in Graz as an architect.",
				},
			],
		},
		useful("lasting", "no_date", "en-19-c1"),
	),
	en(
		"en-20-beagle-not-repeat",
		{
			text: "The user has a beagle named Biscuit.",
			stored: null,
			said: "2025-02-02T15:00:00.000Z",
			candidates: [
				{
					id: "en-20-c1",
					text: "The user's neighbour has a beagle named Rocky.",
				},
				{
					id: "en-20-c2",
					text: "The user takes Biscuit to puppy training on Saturdays.",
				},
			],
		},
		useful("lasting"),
	),
	// Config 3: the language the assistant replies in is never a memory.
	en(
		"en-21-reply-language",
		{
			text: "The user wants the assistant to always reply in English.",
			stored: "lasting",
			said: "2025-01-09T09:00:00.000Z",
		},
		junk("other", "lasting"),
		["junkReason", "kind"],
	),
	// The candidate says all the entry says and more: the entry adds nothing.
	en(
		"en-22-peanut-contained",
		{
			text: "The user is allergic to peanuts.",
			stored: "lasting",
			said: "2025-03-03T12:30:00.000Z",
			candidates: [
				{ id: "en-22-c1", text: "The user is allergic to cat hair." },
				{
					id: "en-22-c2",
					text: "The user has a severe peanut allergy and always carries an adrenaline pen.",
				},
			],
		},
		useful("lasting", "no_date", "en-22-c2"),
		["duplicateOf"],
	),
	en(
		"en-23-job-date-contradicts",
		{
			text: "The user has worked at Northwind Bank since 2018.",
			stored: "lasting",
			said: "2025-04-04T08:00:00.000Z",
			event: "2012-09-01T00:00:00.000Z",
		},
		useful("lasting", "implausible"),
	),
	en(
		"en-24-car-not-repeat",
		{
			text: "The user drives a blue Skoda Octavia.",
			stored: "lasting",
			said: "2025-06-08T17:00:00.000Z",
			candidates: [
				{ id: "en-24-c1", text: "The user drives a grey Skoda Octavia." },
			],
		},
		useful("lasting"),
	),
];

const HUNGARIAN: JudgeFixture[] = [
	hu(
		"hu-01-grandmother",
		{
			text: "A felhasználó nagymamája, Irén, egyedül él Kecskeméten.",
			stored: "lasting",
			said: "2025-03-03T17:00:00.000Z",
		},
		useful("lasting"),
	),
	hu(
		"hu-02-car-purchase",
		{
			text: "A felhasználó tavaly ősszel vett egy használt Suzuki Swiftet.",
			stored: "temporary",
			said: "2025-02-03T08:30:00.000Z",
			event: "2024-10-15T00:00:00.000Z",
		},
		useful("lasting", "plausible"),
	),
	hu(
		"hu-03-guitar",
		{
			text: "A felhasználó gitározni tanul, és hetente egyszer jár órára.",
			stored: "ongoing",
			said: "2025-05-06T18:45:00.000Z",
		},
		useful("ongoing"),
	),
	hu(
		"hu-04-anatomy-exam",
		{
			text: "A felhasználónak 2026. január 12-én anatómiavizsgája lesz.",
			stored: "temporary",
			said: "2025-12-01T20:00:00.000Z",
			event: "2026-01-12T00:00:00.000Z",
		},
		useful("temporary", "plausible"),
	),
	hu(
		"hu-05-birthday-greeting",
		{
			text: "A felhasználó születésnapi köszöntőt kért a kollégájának.",
			stored: "temporary",
			said: "2025-04-11T10:20:00.000Z",
		},
		junk("request_or_task", "temporary"),
		["kind"],
	),
	hu(
		"hu-06-spreadsheet-formula",
		{
			text: "A felhasználó segítséget kért egy Excel-képlethez, amely összesíti a havi kiadásait.",
			stored: null,
			said: "2025-02-25T19:10:00.000Z",
		},
		junk("request_or_task", "temporary"),
		["kind"],
	),
	hu(
		"hu-07-seedlings",
		{
			text: "Az asszisztens azt javasolta, hogy a paradicsompalántákat május közepén érdemes kiültetni.",
			stored: "temporary",
			said: "2025-04-02T07:40:00.000Z",
		},
		junk("assistant_content", "temporary"),
		["kind"],
	),
	hu(
		"hu-08-interest",
		{
			text: "Az asszisztens elmagyarázta, mi a különbség az egyszerű és a kamatos kamat között.",
			stored: "lasting",
			said: "2025-01-28T16:30:00.000Z",
		},
		junk("assistant_content", "lasting"),
		["kind", "junkReason"],
	),
	hu(
		"hu-09-good-night",
		{
			text: "A felhasználó jó éjszakát kívánt az asszisztensnek.",
			stored: "temporary",
			said: "2025-03-21T22:50:00.000Z",
		},
		junk("small_talk_or_vague", "temporary"),
		["kind"],
	),
	hu(
		"hu-10-vague-talk",
		{
			text: "A felhasználó szeretne megbeszélni valamit.",
			stored: "temporary",
			said: "2025-06-12T13:00:00.000Z",
		},
		junk("small_talk_or_vague", "temporary"),
		["kind", "junkReason"],
	),
	hu(
		"hu-11-missed-bus",
		{
			text: "A felhasználó ma reggel lekéste a buszt.",
			stored: "temporary",
			said: "2025-04-08T07:55:00.000Z",
			event: "2025-04-08T00:00:00.000Z",
		},
		junk("passing_event", "temporary", "plausible"),
	),
	hu(
		"hu-12-phone-battery",
		{
			text: "A felhasználó tegnap este elfelejtette feltölteni a telefonját.",
			stored: "temporary",
			said: "2025-05-21T08:00:00.000Z",
			event: "2025-05-20T00:00:00.000Z",
		},
		junk("passing_event", "temporary", "plausible"),
	),
	hu(
		"hu-13-lake",
		{
			text: "A Balaton Közép-Európa legnagyobb tava.",
			stored: null,
			said: "2025-07-15T11:30:00.000Z",
		},
		junk("not_about_the_person", "lasting"),
		["kind"],
	),
	hu(
		"hu-14-poet-born",
		{
			text: "Petőfi Sándor 1823-ban született Kiskőrösön.",
			stored: "lasting",
			said: "2025-03-15T09:00:00.000Z",
			event: "1823-01-01T00:00:00.000Z",
		},
		junk("not_about_the_person", "lasting", "plausible"),
		["kind"],
	),
	hu(
		"hu-15-short-answers",
		{
			text: "A felhasználó rövid, lényegre törő válaszokat szeretne, felsorolások nélkül.",
			stored: "lasting",
			said: "2025-08-09T14:00:00.000Z",
		},
		useful("lasting"),
	),
	hu(
		"hu-16-graduation-dated-ahead",
		{
			text: "A felhasználó 2015-ben érettségizett Pécsen.",
			stored: "lasting",
			said: "2025-03-10T18:00:00.000Z",
			event: "2032-06-15T00:00:00.000Z",
		},
		useful("lasting", "implausible"),
	),
	hu(
		"hu-17-holiday-dated-before",
		{
			text: "A felhasználó jövő nyáron a családjával Horvátországba készül nyaralni.",
			stored: "temporary",
			said: "2025-02-14T20:30:00.000Z",
			event: "2016-07-01T00:00:00.000Z",
		},
		useful("temporary", "implausible"),
	),
	hu(
		"hu-18-lactose-repeat",
		{
			text: "A felhasználó laktózérzékeny.",
			stored: "lasting",
			said: "2025-01-30T12:00:00.000Z",
			candidates: [
				{ id: "hu-18-c1", text: "A felhasználó gluténérzékeny." },
				{ id: "hu-18-c2", text: "A felhasználónak laktózérzékenysége van." },
			],
		},
		useful("lasting", "no_date", "hu-18-c2"),
	),
	hu(
		"hu-19-school-not-repeat",
		{
			text: "A felhasználó lánya, Zsófi, 2024 szeptemberében kezdte az iskolát.",
			stored: "lasting",
			said: "2025-01-10T19:00:00.000Z",
			event: "2024-09-02T00:00:00.000Z",
			candidates: [
				{
					id: "hu-19-c1",
					text: "A felhasználó fia, Bence, 2022 szeptemberében kezdte az óvodát.",
				},
				{
					id: "hu-19-c2",
					text: "Zsófi, a felhasználó lánya, szeret rajzolni.",
				},
			],
		},
		useful("lasting", "plausible"),
		["kind"],
	),
	hu(
		"hu-20-reply-language",
		{
			text: "A felhasználó azt kérte, hogy az asszisztens mindig magyarul válaszoljon.",
			stored: "lasting",
			said: "2025-02-01T10:00:00.000Z",
		},
		junk("other", "lasting"),
		["junkReason", "kind"],
	),
	hu(
		"hu-21-bathroom",
		{
			text: "A felhasználó a debreceni lakásában újítja fel a fürdőszobát.",
			stored: "ongoing",
			said: "2025-04-25T17:30:00.000Z",
		},
		useful("ongoing"),
	),
	hu(
		"hu-22-nurse-contained",
		{
			text: "A felhasználó ápolóként dolgozik Szegeden.",
			stored: "lasting",
			said: "2025-05-02T21:00:00.000Z",
			candidates: [
				{
					id: "hu-22-c1",
					text: "A felhasználó egy szegedi gyermekkórházban dolgozik ápolóként, többnyire éjszakai műszakban.",
				},
				{ id: "hu-22-c2", text: "A felhasználó a párjával Szegeden lakik." },
			],
		},
		useful("lasting", "no_date", "hu-22-c1"),
		["duplicateOf"],
	),
	hu(
		"hu-23-move-date-contradicts",
		{
			text: "A felhasználó 2020-ban költözött Győrbe.",
			stored: "lasting",
			said: "2025-03-01T09:30:00.000Z",
			event: "2023-08-01T00:00:00.000Z",
		},
		useful("lasting", "implausible"),
	),
	hu(
		"hu-24-food-not-repeat",
		{
			text: "A felhasználó kedvenc étele a töltött káposzta.",
			stored: null,
			said: "2025-06-20T18:00:00.000Z",
			candidates: [
				{ id: "hu-24-c1", text: "A felhasználó kedvenc étele a lecsó." },
			],
		},
		useful("lasting"),
	),
];

export const QUALITY_JUDGE_FIXTURES: readonly JudgeFixture[] = [
	...ENGLISH,
	...HUNGARIAN,
];
