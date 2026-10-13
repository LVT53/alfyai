// The reply language is the model's to choose (owner decision, 2026-10-13).
//
// No code reads the person's message, their history or their account and turns a
// guess into an order. Every Normal Chat turn carries the same rule, in the same
// place, and the model chooses under it; what the app writes after the reply is
// in the language of the conversation for the person, which the model names in
// one small call after the reply (and a deterministic chain names when it
// cannot). This file holds the invariants that make that so, against the app's
// own entry points and a capturing fake provider:
//
//   I1  nothing guesses: the turn guidance holds REPLY_LANGUAGE_RULE byte for byte
//       whatever the message or the account, nothing else in the chat request
//       tells the model a reply language, and the code that guessed is gone;
//   I2  the UI language reaches no model request but the status-line call, and
//       I3  what the app writes into a request is one English scaffold
//       (english-request-purity.test.ts);
//   I4  after the reply, chips, rail headline and title take the language the
//       model names for the person, whatever language the reply is in;
//       I5 observability (language.test.ts, chat-turn/reply-language.test.ts).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	process.env.MODEL_1_BASEURL = "http://model1.fake/v1";
	process.env.MODEL_1_NAME = "fake-model-1";
	process.env.MODEL_1_API_KEY = "k1";
	process.env.MODEL_1_SYSTEM_PROMPT = "alfyai-nemotron";
	process.env.MODEL_2_BASEURL = "http://model2.fake/v1";
	process.env.MODEL_2_NAME = "fake-model-2";
	process.env.MODEL_2_API_KEY = "k2";
	process.env.PARALLEL_API_KEY = "kp";
});

import { generateFollowUpSuggestions } from "../../src/lib/server/services/chat-turn/follow-up-suggestions";
import { LANGUAGE_PROBES } from "../../src/lib/server/services/chat-turn/language-probes.test-helpers";
import { persistAssistantRailSummary } from "../../src/lib/server/services/chat-turn/rail-summary";
import { resolveTurnReplyLanguage } from "../../src/lib/server/services/chat-turn/reply-language";
import { createConversation } from "../../src/lib/server/services/conversations";
import {
	createMessage,
	getLastConversationLanguage,
	getPreviousUserMessageText,
} from "../../src/lib/server/services/messages";
import { REPLY_LANGUAGE_RULE } from "../../src/lib/server/services/normal-chat-context";
import { generateTitle } from "../../src/lib/server/services/title-generator";
import {
	capture,
	driveChat,
	FACTS,
	HISTORY,
	installFakeProvider,
	lastMessageText,
	leaves,
	PERSONA,
	PERSONAL_INSTRUCTIONS,
	PROJECT_INSTRUCTIONS,
	REPLY,
	removeFakeProvider,
	seedWorld,
	setConversationLanguageAnswer,
	type World,
} from "./language-capture";

// What a person might type. The first ones are plain; the rest are the shapes a
// word-list detector got wrong (a language word used as a modifier, a unit or a
// place that is also a Hungarian word, an interjection, a short reply), and the
// requests for a language that the model has to read for itself.
const MESSAGES = [
	"hi",
	"ok",
	"Which heating system should I pick for a small apartment?",
	"Mit érdemes választani egy kis lakáshoz: hőszivattyút vagy gázkazánt?",
	"Use Hungarian names for the characters in my story.",
	"Keep the Hungarian terms in the glossary and translate the rest.",
	"What's 12 volt in watts?",
	"Rent a van in Budapest - any tips?",
	"Ha! Tell me another one.",
	"Írj egy e-mailt angolul a kollégámnak, hogy holnap nem tudok bemenni.",
	"Válaszolj angolul: mi a fotoszintézis?",
	"Answer in Hungarian: what is photosynthesis?",
];

/** The turn guidance a chat request carries after the person's message. */
function turnGuidanceOf(body: Record<string, unknown>): string {
	const text = lastMessageText(body, "user");
	const at = text.lastIndexOf("## Turn Guidance");
	return at === -1 ? "" : text.slice(at);
}

/**
 * What a person or the model wrote, which a scan of the app's own words blanks:
 * the fixtures' instructions, facts, persona, history and reply, and the
 * messages themselves.
 */
const AUTHORED = [
	PERSONAL_INSTRUCTIONS,
	PROJECT_INSTRUCTIONS,
	...FACTS,
	PERSONA,
	REPLY,
	...HISTORY.flat(),
	...MESSAGES.filter((message) => message.length >= 8),
];

/** The two languages by name: the app names neither in a request it writes. */
const LANGUAGE_NAME = /\b(?:English|Hungarian|Magyar)\b/i;

/** A sentence that tells the model what language to write or reply in. */
const REPLY_LANGUAGE_INSTRUCTION =
	/\b(?:repl(?:y|ies)|respon(?:d|ds|se|ses)|answers?|writ(?:e|es|ten|ing)|speak|speaks)\b[^.\n]{0,80}\b(?:English|Hungarian|Magyar|languages?)\b|\b(?:English|Hungarian|Magyar)\b[^.\n]{0,40}\b(?:repl(?:y|ies)|respon(?:se|ses)|answers?)\b/i;

let en: World;
let hu: World;

beforeAll(async () => {
	installFakeProvider();
	en = await seedWorld("en");
	hu = await seedWorld("hu");
});

afterAll(() => {
	removeFakeProvider();
});

describe("I1: nothing guesses the reply language", () => {
	it("every turn's guidance holds REPLY_LANGUAGE_RULE, byte for byte, and nothing else about language", async () => {
		const bodies: Array<{
			who: string;
			message: string;
			body: Record<string, unknown>;
		}> = [];
		for (const world of [en, hu]) {
			for (const message of MESSAGES) {
				const [request] = await capture(`chat ${world.uiLanguage}`, () =>
					driveChat(world, message, world.withHistory),
				);
				bodies.push({
					who: `${world.uiLanguage}-ui`,
					message,
					body: request.body,
				});
			}
		}
		expect(bodies).toHaveLength(MESSAGES.length * 2);

		const guidanceWithoutRule: Array<{
			who: string;
			message: string;
			text: string;
		}> = [];
		for (const { who, message, body } of bodies) {
			const guidance = turnGuidanceOf(body);
			expect(guidance, `${who}: ${message}`).not.toBe("");
			// The rule is a section of its own, equal to the constant.
			expect(
				guidance.split("\n\n").includes(REPLY_LANGUAGE_RULE),
				`${who}: ${message}`,
			).toBe(true);
			guidanceWithoutRule.push({
				who,
				message,
				text: guidance.replace(REPLY_LANGUAGE_RULE, "<rule>"),
			});
		}
		// Everything else in the guidance is the same for every message and both
		// accounts: nothing about the message or the account reaches it.
		const [first, ...rest] = guidanceWithoutRule;
		for (const other of rest) {
			expect(other.text, `${other.who}: ${other.message}`).toBe(first.text);
		}
	});

	it("no request names a language policy of its own, or orders one", async () => {
		const ORDERS =
			/Response language policy|Required response language|Detected latest user-message language|you MUST respond in|hard requirement/i;
		for (const world of [en, hu]) {
			for (const message of MESSAGES) {
				const [request] = await capture(`chat ${world.uiLanguage}`, () =>
					driveChat(world, message, world.fresh),
				);
				const orders = leaves(request.body, "")
					.filter(({ text }) => ORDERS.test(text))
					.map(({ path }) => path);
				expect(orders, `${world.uiLanguage}-ui: ${message}`).toEqual([]);
			}
		}
	});

	it("nothing else the app writes into the chat request tells the model what language to reply in", async () => {
		// The rule above is one sentence of the turn guidance and the memory
		// section carries one note about it; every other sentence the app wrote
		// (the base prompt, the instructions framing, the memory, the skills, the
		// tool catalogue, the guidance) is scanned for a reply-language instruction
		// (a verb of replying or writing near a language) and for the names of the
		// two languages. What the person, the model and the fixtures wrote is
		// blanked first.
		const allowed = new Set([
			...REPLY_LANGUAGE_RULE.split("\n"),
			// The Baseline Memory Profile section's note (chat-turn/context-selection.ts).
			"They never set the reply language.",
		]);
		const offenders = new Map<string, string>();
		for (const world of [en, hu]) {
			for (const message of MESSAGES) {
				const [request] = await capture(`chat ${world.uiLanguage}`, () =>
					driveChat(world, message, world.withHistory),
				);
				for (const { path, text: raw } of leaves(request.body, "")) {
					let text = raw;
					for (const authored of AUTHORED)
						text = text.split(authored).join(" ");
					for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
						const line = sentence.trim();
						if (!line || allowed.has(line)) continue;
						if (
							REPLY_LANGUAGE_INSTRUCTION.test(line) ||
							LANGUAGE_NAME.test(line)
						) {
							offenders.set(
								`${path.replace(/\[\d+\]/g, "[]")} :: ${line.slice(0, 160)}`,
								line,
							);
						}
					}
				}
			}
		}
		expect([...offenders.keys()]).toEqual([]);
	});

	it("the tool catalogue does not depend on the message or the account", async () => {
		const catalogues = new Set<string>();
		for (const world of [en, hu]) {
			for (const message of MESSAGES) {
				const [request] = await capture(`chat ${world.uiLanguage}`, () =>
					driveChat(world, message, world.fresh),
				);
				catalogues.add(JSON.stringify(request.body.tools ?? null));
			}
		}
		expect(catalogues.size).toBe(1);
	});
});

// --- I4: what follows the reply is in the language the model names -----------------

const HUNGARIAN_REPLY =
	"Természetesen segítek. Először gyűjtsd össze, hogy mi az, ami nem fér bele a határidőbe, aztán döntsd el, hogy melyiket lehet kihagyni, mert nem minden egyformán fontos, és nem kell mindent megcsinálnod egyszerre. Ha szeretnéd, hogy közösen nézzük át a listát, akkor írd le, hogy mi van rajta.";

/**
 * What the Hungarian prompts carry and the English ones do not, in the system
 * prompt of each call (the person's own words and the reply are in the request
 * too, and may say "Hungarian" themselves).
 */
const HUNGARIAN_CHIPS_PROMPT = "in Hungarian, best first";
const HUNGARIAN_RAIL_PROMPT = "Write the headline in Hungarian.";
const HUNGARIAN_TITLE_EXAMPLE = "React komponens létrehozási alapok";

/** A reply with no words of any language in it: the reader cannot name it. */
const CODE_REPLY = [
	"```ts",
	"export function total(items: Array<{ price: number }>): number {",
	"\treturn items.reduce((sum, item) => sum + item.price, 0);",
	"}",
	"",
	"export const answer = total([{ price: 2 }, { price: 3 }, { price: 5 }]);",
	"```",
	"",
	"```ts",
	"console.log(answer); // 10",
	"```",
].join("\n");

type AfterReply = {
	language: string;
	via: string;
	/** The request each call sent, or null when it sent none (a reply too short to need one). */
	chips: string | null;
	rail: string | null;
	title: string | null;
};

/**
 * The language call, then the chips, the rail headline and the title of one turn,
 * as the app asks for them, with the fake model answering the call as set.
 */
async function afterReply(
	world: World,
	reply: string,
	message: string,
	answer: "en" | "hu" | "unusable",
	conversationId: string = world.fresh,
): Promise<AfterReply> {
	setConversationLanguageAnswer(answer);
	const turn = await resolveTurnReplyLanguage({
		userId: world.userId,
		conversationId,
		reply,
		latestUserMessage: message,
		uiLanguage: world.uiLanguage,
	});
	const [chips] = await capture("chips", () =>
		generateFollowUpSuggestions({
			userId: world.userId,
			conversationId,
			userMessage: message,
			assistantResponse: reply,
			responseLanguage: turn.language,
		}),
	);
	const [rail] = await capture("rail", () =>
		persistAssistantRailSummary({
			userId: world.userId,
			conversationId,
			assistantMessageId: "no-such-message",
			assistantResponse: reply,
			responseLanguage: turn.language,
		}),
	);
	const [title] = await capture("title", () =>
		generateTitle(message, reply, "auto", world.uiLanguage, turn.language),
	);
	const body = (request: { body: unknown } | undefined) =>
		request ? JSON.stringify(request.body) : null;
	return {
		language: turn.language,
		via: turn.via,
		chips: body(chips),
		rail: body(rail),
		title: body(title),
	};
}

function expectWrittenIn(
	sent: AfterReply,
	language: "en" | "hu",
	label: string,
): void {
	const hungarian = language === "hu";
	if (sent.chips !== null) {
		expect(sent.chips.includes(HUNGARIAN_CHIPS_PROMPT), `${label}: chips`).toBe(
			hungarian,
		);
	}
	if (sent.rail !== null) {
		expect(sent.rail.includes(HUNGARIAN_RAIL_PROMPT), `${label}: rail`).toBe(
			hungarian,
		);
	}
	// The Hungarian title prompt carries Hungarian example titles.
	if (sent.title !== null) {
		expect(
			sent.title.includes(HUNGARIAN_TITLE_EXAMPLE),
			`${label}: title`,
		).toBe(hungarian);
	}
}

describe("I4: chips, rail headline and title are written in the language the model names for the person", () => {
	it("every row of the review's probe table, in both directions: the person's language, whatever the reply reads as", async () => {
		const asked = { chips: 0, rail: 0, title: 0 };
		for (const probe of LANGUAGE_PROBES) {
			const world = probe.uiLanguage === "en" ? en : hu;
			// A good model's answer to the question, as the table says it.
			const sent = await afterReply(
				world,
				probe.reply,
				probe.message,
				probe.person,
			);
			expect(sent.via, probe.id).toBe("model");
			expect(sent.language, probe.id).toBe(probe.person);
			expectWrittenIn(sent, probe.person, probe.id);
			for (const key of ["chips", "rail", "title"] as const) {
				if (sent[key] !== null) asked[key] += 1;
			}
		}
		// A short reply needs no chips or rail headline; most rows are long enough
		// that the test is about requests that were really sent.
		expect(asked.chips).toBeGreaterThanOrEqual(LANGUAGE_PROBES.length - 6);
		expect(asked.rail).toBeGreaterThanOrEqual(LANGUAGE_PROBES.length - 8);
		expect(asked.title).toBe(LANGUAGE_PROBES.length);
	});

	it("an English writer given a Hungarian reply gets English ones (the model failed, the chips do not follow it)", async () => {
		const sent = await afterReply(
			en,
			HUNGARIAN_REPLY,
			"Help me plan what to cut from this week.",
			"en",
		);
		expectWrittenIn(sent, "en", "an English writer, a Hungarian reply");
	});

	it("the person's own title language still wins over the conversation's", async () => {
		const [title] = await capture("title", () =>
			generateTitle("Plan my week", HUNGARIAN_REPLY, "en", "hu", "hu"),
		);
		expect(JSON.stringify(title?.body)).not.toContain(HUNGARIAN_TITLE_EXAMPLE);
		const [hungarian] = await capture("title", () =>
			generateTitle("Plan my week", HUNGARIAN_REPLY, "hu", "en", "en"),
		);
		expect(JSON.stringify(hungarian?.body)).toContain(HUNGARIAN_TITLE_EXAMPLE);
	});

	it("an answer the app cannot use falls to the reply's own words", async () => {
		const sent = await afterReply(
			en,
			HUNGARIAN_REPLY,
			"Help me plan what to cut from this week.",
			"unusable",
		);
		expect(sent.via).toBe("fallback");
		expect(sent.language).toBe("hu");
		expectWrittenIn(sent, "hu", "unusable answer, a Hungarian reply");
	});

	it("an answer the app cannot use, a reply that says nothing and nothing before it: the account's UI language is the last fallback (the one place it reaches a request after a reply)", async () => {
		const fresh = await createConversation(hu.userId, "Nothing yet");
		const sent = await afterReply(hu, CODE_REPLY, "ok", "unusable", fresh.id);
		expect(sent.via).toBe("fallback");
		expect(sent.language).toBe("hu");
		expectWrittenIn(sent, "hu", "the UI language as the last fallback");

		const freshEnglish = await createConversation(en.userId, "Nothing yet");
		const english = await afterReply(
			en,
			CODE_REPLY,
			"ok",
			"unusable",
			freshEnglish.id,
		);
		expectWrittenIn(english, "en", "the UI language as the last fallback");
	});
});

// --- I5: the language is on the record ----------------------------------------------

describe("I5: the conversation's language is stored on the reply and read back", () => {
	it("reads back the last reply that has one, scoped to the account", async () => {
		const conversationId = (await createConversation(en.userId, "Stored")).id;
		await createMessage(conversationId, "user", "Segíts a tervvel.");
		await createMessage(
			conversationId,
			"assistant",
			HUNGARIAN_REPLY,
			undefined,
			undefined,
			{ conversationLanguage: "hu", replyLanguage: "hu" },
		);
		await createMessage(conversationId, "user", "ok");
		// An older reply (from before this was recorded) has none: it is skipped.
		await createMessage(conversationId, "assistant", "Rendben.");

		expect(await getLastConversationLanguage(conversationId, en.userId)).toBe(
			"hu",
		);
		// Another account's call reads as having none.
		expect(
			await getLastConversationLanguage(conversationId, hu.userId),
		).toBeNull();
	});

	it("reads back the person's message before the one being answered, whether or not the answered one is stored yet", async () => {
		const conversationId = (await createConversation(en.userId, "Earlier")).id;
		await createMessage(conversationId, "user", "Translate it to Hungarian");
		await createMessage(conversationId, "assistant", "Here you go.");
		await createMessage(conversationId, "user", "Now make it more formal");

		// The turn's own message is not stored yet (send, stream): the newest
		// stored one is the one before it.
		expect(
			await getPreviousUserMessageText(
				conversationId,
				en.userId,
				"Thanks, that is perfect",
			),
		).toBe("Now make it more formal");
		// A retry has stored it: the one before that.
		expect(
			await getPreviousUserMessageText(
				conversationId,
				en.userId,
				"Now make it more formal",
			),
		).toBe("Translate it to Hungarian");
		expect(
			await getPreviousUserMessageText(
				conversationId,
				hu.userId,
				"Thanks, that is perfect",
			),
		).toBeNull();
		const empty = await createConversation(en.userId, "Empty");
		expect(
			await getPreviousUserMessageText(empty.id, en.userId, "hi"),
		).toBeNull();
	});

	it("a turn whose call fails and whose reply says nothing falls back to the language stored on the conversation", async () => {
		const conversationId = (await createConversation(en.userId, "Fallback")).id;
		await createMessage(conversationId, "user", "Segíts a tervvel.");
		await createMessage(
			conversationId,
			"assistant",
			HUNGARIAN_REPLY,
			undefined,
			undefined,
			{ conversationLanguage: "hu", replyLanguage: "hu" },
		);

		setConversationLanguageAnswer("unusable");
		const turn = await resolveTurnReplyLanguage({
			userId: en.userId,
			conversationId,
			reply: "Done.",
			latestUserMessage: "ok",
			uiLanguage: "en",
		});
		expect(turn).toEqual({ language: "hu", reply: "unknown", via: "fallback" });

		// And when the model answers, it is the model.
		setConversationLanguageAnswer("en");
		expect(
			await resolveTurnReplyLanguage({
				userId: en.userId,
				conversationId,
				reply: "Done.",
				latestUserMessage: "ok",
				uiLanguage: "en",
			}),
		).toEqual({ language: "en", reply: "unknown", via: "model" });
	});
});

// --- the code that guessed is gone ---------------------------------------------

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function sourceFiles(root: string): string[] {
	return readdirSync(join(ROOT, root), { recursive: true })
		.map(String)
		.filter((f) => /\.(ts|svelte)$/.test(f) && !f.includes("node_modules"))
		.map((f) => relative(ROOT, join(ROOT, root, f)))
		.filter((f) => statSync(join(ROOT, f)).isFile());
}

/**
 * What decided a turn's reply language before the reply, what carried it, and
 * the word-list detectors under them. None of it may come back: the model
 * chooses, and what is written after the reply reads the reply.
 */
const GONE = [
	"resolveTurnResponseLanguage",
	"resolvedResponseLanguage",
	"buildResponseLanguageGuard",
	"resolveResponseLanguage",
	"detectExplicitLanguageRequest",
	"detectContentLanguageRequest",
	"classifyLanguageSignal",
	"detectLanguage",
	"resolveShortTextLanguage",
	"isHungarianText",
	"listRecentUserMessageTexts",
	"getLastReplyLanguage",
];

describe("I1: the code that decided the language before the reply is gone", () => {
	it("no source file names it", () => {
		const thisFile = relative(ROOT, fileURLToPath(import.meta.url));
		const hits: string[] = [];
		for (const file of [...sourceFiles("src"), ...sourceFiles("scripts")]) {
			if (file === thisFile) continue;
			const code = readFileSync(join(ROOT, file), "utf8");
			for (const name of GONE) {
				if (new RegExp(`\\b${name}\\b`).test(code)) {
					hits.push(`${file}: ${name}`);
				}
			}
		}
		expect(hits).toEqual([]);
	});
});
