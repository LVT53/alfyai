// What the fix round's chat specs script the model to do (FX-1): the turns the
// owner's walk met with a real model, made deterministic.
//
// Its own module (like late-card-scenario.ts): the shared scenario file is read
// by every spec that scripts a model. The model's side of each turn lives in
// tests/mocks/ai-provider/chat-turn-scripts.ts.
import type { AskQuestion } from "../../../src/lib/shared/ask-user";

/**
 * A reply that makes a PDF: the model says a sentence, calls `produce_file` with
 * the document's text (a source-first PDF, rendered in-process, no sandbox), and
 * answers once more after the tool returned.
 */
export const AI_SMOKE_PRODUCE_PDF_MARKER =
	"Fake model step: produce the scripted PDF.";
export const AI_SMOKE_PRODUCE_PDF_INTRO = "Rendben, elkészítem a PDF-et. ";
export const AI_SMOKE_PRODUCE_PDF_TITLE = "Bécsi hétvégi útiterv";
export const AI_SMOKE_PRODUCE_PDF_FILENAME = "becsi-hetvegi-utiterv.pdf";
export const AI_SMOKE_PRODUCE_PDF_FINAL_TEXT = "Elkészült a PDF.";
export const AI_SMOKE_PRODUCE_PDF_CONTENT = [
	`# ${AI_SMOKE_PRODUCE_PDF_TITLE}`,
	"",
	"**Szombat:** reggeli a belvárosban, délután a Kunsthistorisches Museum, este vacsora a Naschmarkt környékén.",
	"",
	"**Vasárnap:** Schönbrunn kertjei, ebéd a Spittelbergen, délután vonat vissza Budapestre.",
].join("\n");

/**
 * A reply that makes a Document and then works on it, the way the model the audit
 * walked does: `create_artifact`, `read_artifact` (for the block ids and hashes),
 * then `edit_artifact`. The mode, written after the marker in the message, says how
 * the edits go:
 *   `edit`   one good edit,
 *   `retry`  a malformed edit (the tool refuses it), then a good one,
 *   `giveup` a malformed edit and then no more: the turn ends on the failure.
 */
export const AI_SMOKE_ITEM_TURN_MARKER =
	"Fake model step: make the scripted document and change it.";
export type ItemTurnMode = "edit" | "retry" | "giveup";
export const AI_SMOKE_ITEM_TURN_TITLE = "Bécsi hétvége";
export const AI_SMOKE_ITEM_TURN_BODY =
	"# Bécsi hétvége\n\nSzombat: a belváros és a múzeumok.\n\nVasárnap: Schönbrunn és hazaút.";
export const AI_SMOKE_ITEM_TURN_EDITED_TEXT =
	"Szombat: a belváros, a múzeumok és egy esti koncert.";
export const AI_SMOKE_ITEM_TURN_FINAL_TEXT = "Kész, átnézheted.";

export function itemTurnMessage(mode: ItemTurnMode): string {
	return `${AI_SMOKE_ITEM_TURN_MARKER} mode:${mode}`;
}

export function decodeItemTurnMode(text: string): ItemTurnMode | null {
	if (!text.includes(AI_SMOKE_ITEM_TURN_MARKER)) return null;
	const match = /mode:(edit|retry|giveup)/.exec(text);
	return (match?.[1] as ItemTurnMode | undefined) ?? null;
}

/**
 * A reply that drafts a skill, written the way the real model writes one: the
 * reply, then the `<skill_control_v1>` envelope with its JSON on a line of its
 * own. The stream splits that line where a real stream did (a frame that ends
 * in `{"vers`), the split that once lost the draft card on the server.
 */
export const AI_SMOKE_SKILL_DRAFT_MARKER =
	"Fake model step: draft the scripted skill.";
export const AI_SMOKE_SKILL_DRAFT_TEXT =
	"Here is a draft of the skill. Save it below if you want to keep it.";
export const AI_SMOKE_SKILL_DRAFT_NAME = "Weekly status digest";
export const AI_SMOKE_SKILL_DRAFT_INSTRUCTIONS =
	"Take the notes the person gives and write a short weekly status: what is done, what is in progress, and what is blocked.";
export const AI_SMOKE_SKILL_DRAFT_EXAMPLE =
	"Write my weekly status from these notes.";

/**
 * A reply that stops to ask the person ("Ask me first"): the model writes a sentence,
 * calls `ask_user` and waits, and once it has the answer it carries on by saying what it
 * was told, so a test sees the answer the way the model read it. The mode, written after
 * the marker in the message, says how the turn goes:
 *   `one`        one question that takes one pick (the mockup's section 1),
 *   `four`       one question that takes one pick and has four answers, the most a
 *                question may have (owner, 2026-11-05),
 *   `refused`    its first card breaks a count and a mark at once; the app refuses it
 *                once, naming both, and the model asks again with both fixed (owner,
 *                2026-11-05),
 *   `many`       a card of two questions, the first taking several picks (section 2),
 *   `twice`      after the first answer it asks again, once (section 7),
 *   `slow`       the ask is held until the test releases it (`AI_SMOKE_ASK_HOLD_ASK`), so
 *                the reply is still being written for as long as the test wants,
 *   `slowresume` the words after the answer are held until the test releases them
 *                (`AI_SMOKE_ASK_HOLD_RESUME`), so the resume runs for as long as the
 *                test wants,
 *   `read`       it makes a Document and reads it back before it asks, so the resume
 *                has a tool result that a history digest would cut,
 *   `detail`     one question that carries an optional `detail` under its title (W5,
 *                docs/plans/ui-wishes-2026-11): the card draws it, and the folded
 *                answered line does not.
 * The names `slow` and `slowresume` are kept from when they waited a fixed time: a
 * fixed wait races the machine the test runs on, a hold does not. The request is
 * recorded when it arrives, before the hold, so a test that polls the provider's
 * requests knows the reply is there; the harness lets go with `release(name)`, and
 * `reset()` and `stop()` let go of every hold.
 */
export const AI_SMOKE_ASK_MARKER =
	"Fake model step: ask me first before you answer.";
export type AskTurnMode =
	| "one"
	| "four"
	| "refused"
	| "many"
	| "twice"
	| "slow"
	| "slowresume"
	| "read"
	| "detail";
export const AI_SMOKE_ASK_INTRO =
	"The biggest fork is the shape of the day itself, so let's settle that first.";
export const AI_SMOKE_ASK_SECOND_INTRO =
	"With 25 to 30 people, the next fork is where they all fit.";
export const AI_SMOKE_ASK_AFTER_PREFIX = "Carrying on with: ";
/** The holds of the `slow` mode (the first ask) and the `slowresume` mode (the words after the answer). */
export const AI_SMOKE_ASK_HOLD_ASK = "ask-first";
export const AI_SMOKE_ASK_HOLD_RESUME = "ask-resume";
export const AI_SMOKE_ASK_CALL_ID = "call_ask_1";
/** The call of the card the `refused` mode asks first, the one the app refuses. */
export const AI_SMOKE_ASK_BROKEN_CALL_ID = "call_ask_broken";
export const AI_SMOKE_ASK_SECOND_CALL_ID = "call_ask_2";
export const AI_SMOKE_ASK_READ_CALL_ID = "call_ask_read";

/**
 * The Document the `read` mode makes and reads back. The sentence that ends it starts
 * past the 1,500 characters a tool result's digest keeps, and the paragraphs are more
 * than the five lines a digest lists, so a reply rebuilt from digests has lost it.
 */
export const AI_SMOKE_ASK_READ_TAIL = "The lake path is closed on Sundays.";
export const AI_SMOKE_ASK_READ_TITLE = "A day by the lake";
export const AI_SMOKE_ASK_READ_BODY = [
	`# ${AI_SMOKE_ASK_READ_TITLE}`,
	"Morning: coffee and rolls at the harbour kiosk, then a slow walk along the shore while the light is still low and the water is flat. Bring a jacket, because the wind picks up before ten.",
	"Late morning: the rowing boats open at eleven and cost twelve euros an hour. One hour is enough to reach the reed beds on the far side, where the herons stand about in the shallows.",
	"Lunch: the fish place by the pier serves grilled perch with potatoes until two. Book a table on the terrace if the sky is clear, since the room inside is small and loud.",
	"Early afternoon: the botanical garden is five minutes uphill from the pier, with benches in the shade and a glasshouse for when the weather turns. Allow an hour and a half for the whole loop.",
	"Mid afternoon: ice cream at the pier, then a rest on the lawn. The playground behind the boathouse has room for children of every age, and the grass dries quickly after rain.",
	"Late afternoon: the ferry across to the old town leaves every thirty minutes. The last one back is at eight, so there is time for a walk through the market streets before supper.",
	"Evening: supper at the old brewery, which has a long table that seats fourteen. The kitchen closes at nine, and the music in the courtyard starts at half past seven.",
	"Getting around: the bus runs along the shore every twenty minutes, and bicycles can be hired at the harbour for the whole day. Parking near the pier fills up by half past ten.",
	"If it rains: the lake museum next to the ferry landing has a boat hall and a cafe on the first floor, and the entrance is free for children under twelve.",
	"Packing: sun cream, a hat, swimming things, a towel for each person and a bag for the wet clothes. The kiosks take cards, but the rowing boats take cash only.",
	"What to book: the terrace table at the fish place and the long table at the brewery. Everything else can be decided on the day.",
	AI_SMOKE_ASK_READ_TAIL,
].join("\n\n");

/** The mockup's section 1: one question, three answers, the first one Alfy's pick. */
export const AI_SMOKE_ASK_ONE: AskQuestion[] = [
	{
		question: "Which way should we take it?",
		options: [
			{
				label: "A party at home",
				note: "Easiest to organise, and the whole family can come",
				recommended: true,
			},
			{
				label: "Dinner out, just close family",
				note: "Quieter; book three or four weeks ahead",
			},
			{
				label: "A weekend away together",
				note: "The most memorable, and the most to arrange",
			},
		],
	},
];

/**
 * One question with four answers, the most a question may have (owner, 2026-11-05, after the
 * real-model measurement): the third is Alfy's pick, so the mark is neither first nor last,
 * and the first and the last carry a note of different length.
 */
export const AI_SMOKE_ASK_FOUR: AskQuestion[] = [
	{
		question: "Where should we hold it?",
		options: [
			{ label: "At home", note: "Free, and no one has to travel far" },
			{ label: "In the garden" },
			{
				label: "At a restaurant",
				note: "Book three weeks ahead",
				recommended: true,
			},
			{
				label: "Somewhere by the lake",
				note: "The most to arrange, and the best photographs",
			},
		],
	},
];

/**
 * A card that breaks a count and a mark at once (owner, 2026-11-05): five answers on its
 * question, and none marked Recommended. The `refused` mode asks it first, as
 * `AI_SMOKE_ASK_BROKEN_CALL_ID`.
 */
export const AI_SMOKE_ASK_BROKEN: AskQuestion[] = [
	{
		question: "Which way should we take it?",
		options: [
			{ label: "A party at home" },
			{ label: "Dinner out, just close family" },
			{ label: "A weekend away together" },
			{ label: "A picnic by the lake" },
			{ label: "A day at the zoo" },
		],
	},
];

/** The same card with both fixed: four answers, one of them marked. The `refused` mode asks it once the refusal has said what was wrong. */
export const AI_SMOKE_ASK_FIXED: AskQuestion[] = [
	{
		question: "Which way should we take it?",
		options: [
			{ label: "A party at home", recommended: true },
			{ label: "Dinner out, just close family" },
			{ label: "A weekend away together" },
			{ label: "A picnic by the lake" },
		],
	},
];

/**
 * The mockup's section 2, as a card may be asked since 2026-11-05 (owner, after his first
 * live test: "I only want 1 ask card at a time"): one question that takes several picks
 * (none is Alfy's). A card of two or three questions can only be a stored one now.
 */
export const AI_SMOKE_ASK_MANY: AskQuestion[] = [
	{
		question: "Who's coming?",
		multiple: true,
		options: [{ label: "Adults" }, { label: "Kids" }, { label: "Grandma" }],
	},
];

/** The mockup's section 7: the question Alfy asks later in the same reply, the second answer its pick. */
export const AI_SMOKE_ASK_SECOND: AskQuestion[] = [
	{
		question: "Inside or in the garden?",
		options: [
			{ label: "Inside", note: "No weather worries, but tight for 30" },
			{
				label: "In the garden, with a tent",
				note: "Room for everyone; book the tent by February",
				recommended: true,
			},
		],
	},
];

/**
 * W5 (docs/plans/ui-wishes-2026-11): one question with an optional detail under its
 * title, in the model's own words. The `detail` mode asks it, so a browser test can
 * see the card draw the explanation and the folded answered line leave it behind.
 */
export const AI_SMOKE_ASK_DETAIL_TEXT =
	"We can put the tent up on Saturday morning, and there is room inside if it rains.";
export const AI_SMOKE_ASK_DETAIL: AskQuestion[] = [
	{
		question: "Inside or in the garden?",
		detail: AI_SMOKE_ASK_DETAIL_TEXT,
		options: [
			{ label: "Inside", note: "No weather worries, but tight for 30" },
			{
				label: "In the garden, with a tent",
				note: "Room for everyone; book the tent by February",
				recommended: true,
			},
		],
	},
];

export function askTurnMessage(mode: AskTurnMode): string {
	return `${AI_SMOKE_ASK_MARKER} ask:${mode}`;
}

export function decodeAskTurnMode(text: string): AskTurnMode | null {
	if (!text.includes(AI_SMOKE_ASK_MARKER)) return null;
	const match =
		/ask:(one|four|refused|many|twice|slowresume|slow|read|detail)\b/.exec(
			text,
		);
	return (match?.[1] as AskTurnMode | undefined) ?? null;
}
