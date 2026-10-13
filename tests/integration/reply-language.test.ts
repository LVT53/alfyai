// The reply language is the model's to choose (owner decision, 2026-10-13).
//
// No code reads the person's message, their history or their account and turns a
// guess into an order. Every Normal Chat turn carries the same rule, in the same
// place, and the model chooses under it; what the app writes after the reply
// follows the reply it actually got. This file holds the invariants that make
// that so, against the app's own entry points and a capturing fake provider:
//
//   I1  nothing guesses: the turn guidance holds REPLY_LANGUAGE_RULE byte for byte
//       whatever the message or the account, and the code that guessed is gone;
//   I2  the UI language reaches no model request but the status-line call, and
//       I3  what the app writes into a request is one English scaffold
//       (english-request-purity.test.ts);
//   I4  after the reply, chips, rail headline and title take the language of
//       the reply that was written; I5 observability (language.test.ts,
//       chat-turn/reply-language.test.ts).
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
import { persistAssistantRailSummary } from "../../src/lib/server/services/chat-turn/rail-summary";
import { resolveTurnReplyLanguage } from "../../src/lib/server/services/chat-turn/reply-language";
import {
	createMessage,
	getLastReplyLanguage,
} from "../../src/lib/server/services/messages";
import { REPLY_LANGUAGE_RULE } from "../../src/lib/server/services/normal-chat-context";
import { generateTitle } from "../../src/lib/server/services/title-generator";
import {
	capture,
	driveChat,
	installFakeProvider,
	lastMessageText,
	leaves,
	removeFakeProvider,
	seedWorld,
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

// --- I4: what follows the reply follows the reply ------------------------------

const HUNGARIAN_REPLY =
	"Természetesen segítek. Először gyűjtsd össze, hogy mi az, ami nem fér bele a határidőbe, aztán döntsd el, hogy melyiket lehet kihagyni, mert nem minden egyformán fontos, és nem kell mindent megcsinálnod egyszerre. Ha szeretnéd, hogy közösen nézzük át a listát, akkor írd le, hogy mi van rajta.";
const ENGLISH_REPLY =
	"Of course. First list everything that does not fit the deadline, then decide which of the items can be left out, because they are not all equally important and you do not need to do everything at once. If you would like us to go through the list together, write down what is on it.";

/** The chips, the rail headline and the title of one turn, as the app asks for them. */
async function afterReply(
	world: World,
	reply: string,
	message: string,
): Promise<{ chips: string; rail: string; title: string }> {
	const read = await resolveTurnReplyLanguage({
		userId: world.userId,
		conversationId: world.fresh,
		reply,
		latestUserMessage: message,
		uiLanguage: world.uiLanguage,
	});
	const [chips] = await capture("chips", () =>
		generateFollowUpSuggestions({
			userId: world.userId,
			conversationId: world.fresh,
			userMessage: message,
			assistantResponse: reply,
			responseLanguage: read.language,
		}),
	);
	const [rail] = await capture("rail", () =>
		persistAssistantRailSummary({
			userId: world.userId,
			conversationId: world.fresh,
			assistantMessageId: "no-such-message",
			assistantResponse: reply,
			responseLanguage: read.language,
		}),
	);
	const [title] = await capture("title", () =>
		generateTitle(message, reply, "auto", world.uiLanguage),
	);
	return {
		chips: JSON.stringify(chips?.body),
		rail: JSON.stringify(rail?.body),
		title: JSON.stringify(title?.body),
	};
}

describe("I4: chips, rail headline and title take the language of the reply that was written", () => {
	it("a Hungarian reply gets Hungarian ones, for an account shown in English", async () => {
		const sent = await afterReply(
			en,
			HUNGARIAN_REPLY,
			"Help me plan what to cut from this week.",
		);
		expect(sent.chips).toContain("in Hungarian");
		expect(sent.rail).toContain("in Hungarian");
		// The Hungarian title prompt carries Hungarian example titles.
		expect(sent.title).toContain("React komponens létrehozási alapok");
	});

	it("an English reply gets English ones, for an account shown in Hungarian", async () => {
		const sent = await afterReply(
			hu,
			ENGLISH_REPLY,
			"Segíts eldönteni, mit hagyjak ki a héten.",
		);
		expect(sent.chips).not.toContain("in Hungarian");
		expect(sent.rail).not.toContain("in Hungarian");
		expect(sent.title).not.toContain("React komponens létrehozási alapok");
	});

	it("the person's own title language still wins", async () => {
		const [title] = await capture("title", () =>
			generateTitle("Plan my week", HUNGARIAN_REPLY, "en", "hu"),
		);
		expect(JSON.stringify(title?.body)).not.toContain(
			"React komponens létrehozási alapok",
		);
	});
});

// --- I5: the reply's language is on the record -----------------------------------

describe("I5: the language a reply was read as is stored on it and read back", () => {
	it("falls back, for a reply that says nothing, to the conversation's last reply that did", async () => {
		const conversationId = en.fresh;
		await createMessage(conversationId, "user", "Segíts a tervvel.");
		await createMessage(
			conversationId,
			"assistant",
			HUNGARIAN_REPLY,
			undefined,
			undefined,
			{ replyLanguage: "hu" },
		);
		await createMessage(conversationId, "user", "ok");
		await createMessage(
			conversationId,
			"assistant",
			"Rendben.",
			undefined,
			undefined,
			{ replyLanguage: "unknown" },
		);

		// The newest reply read as unknown and is skipped.
		expect(await getLastReplyLanguage(conversationId, en.userId)).toBe("hu");
		// Another account's call reads as having none.
		expect(await getLastReplyLanguage(conversationId, hu.userId)).toBeNull();

		const read = await resolveTurnReplyLanguage({
			userId: en.userId,
			conversationId,
			reply: "Done.",
			latestUserMessage: "ok",
			uiLanguage: "en",
		});
		expect(read).toEqual({ language: "hu", read: "unknown" });
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
