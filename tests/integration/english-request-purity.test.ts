// Everything the app writes into a model request is one English scaffold, and the
// account's UI language reaches none of it but the status-line call.
//
// The rule (owner, 2026-10-13): an English reader is never steered toward
// Hungarian by anything the app adds to their turn, and no account's language
// changes what a model is sent (I2, I3 in reply-language.test.ts's header). This
// holds it at the one place that cannot lie, the request itself: every model call
// a turn makes is driven through the app's own function against a capturing fake
// provider, for an account shown in English and one shown in Hungarian with the
// same data, and every string each request carries (system prompt, user packet,
// history, tool catalogue and schemas, response_format) is
//
//   1. searched for what only Hungarian has: a letter above U+007F (English
//      prompts and tool texts are ASCII plus typography, none of it a letter, so
//      every accented Hungarian word has one, whatever it says) and the app
//      naming the language; the fixtures are ASCII too, so anything found was
//      written by the server;
//   2. compared between the two accounts after blanking ids and times: the chat
//      call, the language call, the chips, the rail headline, the title, the
//      memory judge and every other call must be byte-identical. Only the
//      thought-step status line is written in the account's UI language (owner
//      decision 2), and so is the nightly persona summary (a screen, not a
//      turn).
//
// One exception is by design and held in reply-language.test.ts (I4): the
// language of what follows a reply is named by the model (the language call
// above, which sees the person's own words and never the account), and only
// when that call fails AND the reply says nothing AND nothing was recorded
// before it does the account's UI language name it. The call itself names the
// two languages it chooses between, the way Atlas's does, so the scan for the
// app naming a language skips it (and only it).
//
// Two more layers keep it from regressing:
//
//   3. coverage: every file that can make a model call is either driven here or
//      named exempt with a reason, so a new call cannot go unchecked (the
//      pattern of sampling.test.ts's call-site list);
//   4. the source: Hungarian letters live only in the files registered below,
//      each of which keeps them behind a language key, a detector or a UI string.
import { readdirSync, readFileSync } from "node:fs";
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
	process.env.TITLE_GEN_URL = "http://title.fake/v1";
	process.env.TITLE_GEN_MODEL = "fake-title";
	process.env.TITLE_GEN_API_KEY = "kt";
	process.env.PARALLEL_API_KEY = "kp";
});

import { generateAndVerifyApp } from "../../src/lib/server/services/artifacts/app/generate-and-verify";
import * as atlasAnswerTable from "../../src/lib/server/services/atlas-v3/answer-table";
import * as atlasAsk from "../../src/lib/server/services/atlas-v3/ask";
import * as atlasEvidence from "../../src/lib/server/services/atlas-v3/evidence-bank";
import * as atlasStandard from "../../src/lib/server/services/atlas-v3/language-standard";
import * as atlasOutline from "../../src/lib/server/services/atlas-v3/outline";
import * as atlasFence from "../../src/lib/server/services/atlas-v3/prompt-fence";
import * as atlasResearcher from "../../src/lib/server/services/atlas-v3/researcher";
import * as atlasWorkspace from "../../src/lib/server/services/atlas-v3/workspace";
import * as atlasWriter from "../../src/lib/server/services/atlas-v3/writer";
import { generateFollowUpSuggestions } from "../../src/lib/server/services/chat-turn/follow-up-suggestions";
import { persistAssistantRailSummary } from "../../src/lib/server/services/chat-turn/rail-summary";
import { resolveTurnReplyLanguage } from "../../src/lib/server/services/chat-turn/reply-language";
import { classifyThoughtStepChunk } from "../../src/lib/server/services/chat-turn/thought-step-classifier";
import { resolveTurnAcknowledgment } from "../../src/lib/server/services/chat-turn/turn-acknowledgment";
import { refreshConversationSummary } from "../../src/lib/server/services/conversation-summaries";
import type { SupportedLanguage } from "../../src/lib/server/services/language";
import { runUserMemoryConsolidation } from "../../src/lib/server/services/memory-consolidation";
import { generateAndStorePersonaSummary } from "../../src/lib/server/services/memory-consolidation/summary";
import { runMemoryJudgeOnSegment } from "../../src/lib/server/services/memory-judge";
import { generateTitle } from "../../src/lib/server/services/title-generator";
import {
	type Capture,
	capture,
	driveChat,
	FACTS,
	HISTORY,
	installFakeProvider,
	leaves,
	PERSONA,
	PERSONAL_INSTRUCTIONS,
	PROJECT_INSTRUCTIONS,
	REPLY,
	removeFakeProvider,
	seedWorld,
	type World,
} from "./language-capture";

const PROMPTS = [
	"hi",
	"What's the difference between a heat pump and a gas boiler for a small apartment?",
	"What are the public holidays in Hungary next year?",
	"Make me a small app to track my weekly expenses.",
	"Write a one page PDF summary of the benefits of cycling to work.",
];

// What the user, or the model, wrote. The scan blanks these before it looks, so
// "Hungary" in a prompt is the user's word and never the server's.
const AUTHORED = [
	PERSONAL_INSTRUCTIONS,
	PROJECT_INSTRUCTIONS,
	...FACTS,
	PERSONA,
	REPLY,
	...HISTORY.flat(),
	...PROMPTS.filter((p) => p.length >= 8),
];

// --- the detector -------------------------------------------------------------

/** A letter above U+007F: every accented Hungarian word has one, no list needed. */
const NON_ASCII_LETTER = /(?=\P{ASCII})\p{L}/gu;
/** The app naming the language: a steer even when it is spelt in ASCII. */
const NAMES_THE_LANGUAGE = /Hungar|Magyar/i;
/**
 * Hungarian written without accents (a phone, a lazy prompt): the letter scan
 * cannot see it, so a few words only Hungarian has are looked for as well. No
 * English word is on it, and nothing in the English scaffold uses one.
 */
const ASCII_HUNGARIAN =
	/\b(?:hogy|vagy|mert|nincs|kerlek|koszonom|magyarul|valaszolj|legyen|szeretnem|csak|egyszeru)\b/i;

type Offender = { call: string; where: string; found: string; around: string };

/**
 * The one call that names the two languages it chooses between: asking which
 * language a conversation is in cannot be done without them.
 */
const NAMES_THE_LANGUAGES_BY_DESIGN = /^conversation language/;

function offendersIn(item: Pick<Capture, "call" | "body">): Offender[] {
	const found: Offender[] = [];
	for (const leaf of leaves(item.body, "")) {
		let text = leaf.text;
		for (const authored of AUTHORED) text = text.split(authored).join(" ");
		for (const match of text.matchAll(NON_ASCII_LETTER)) {
			found.push({
				call: item.call,
				where: leaf.path,
				found: match[0],
				around: text.slice(Math.max(0, match.index - 40), match.index + 40),
			});
			break; // one per string is enough to fail it
		}
		const named =
			(NAMES_THE_LANGUAGES_BY_DESIGN.test(item.call)
				? null
				: NAMES_THE_LANGUAGE.exec(text)) ?? ASCII_HUNGARIAN.exec(text);
		if (named) {
			found.push({
				call: item.call,
				where: leaf.path,
				found: named[0],
				around: text.slice(Math.max(0, named.index - 40), named.index + 60),
			});
		}
	}
	return found;
}

// --- the worlds ---------------------------------------------------------------

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

const conversationOf = (world: World, index: number) =>
	[world.withHistory, world.inProject, world.fresh][index % 3];

/**
 * The language a turn names after its reply, with the request of the call that
 * names it labelled as its own (the chips and rail drivers send theirs next).
 */
async function namedLanguage(
	world: World,
	message: string,
	conversationId: string,
): Promise<{ language: SupportedLanguage }> {
	const named: { language: SupportedLanguage } = { language: "en" };
	await capture(`conversation language (${world.uiLanguage}-ui)`, async () => {
		const turn = await resolveTurnReplyLanguage({
			userId: world.userId,
			conversationId,
			reply: REPLY,
			latestUserMessage: message,
			uiLanguage: world.uiLanguage,
		});
		named.language = turn.language;
	});
	return named;
}

/** Every model call one turn makes, driven through the app's own entry. */
const DRIVERS: Array<{
	name: string;
	drive: (
		world: World,
		message: string,
		conversationId: string,
	) => Promise<unknown>;
}> = [
	{
		name: "chat",
		drive: (world, message, conversationId) =>
			driveChat(world, message, conversationId),
	},
	{
		name: "title",
		drive: (world, message) =>
			generateTitle(message, REPLY, "auto", world.uiLanguage),
	},
	{
		// The one small call after the reply that names the conversation's
		// language for the person: it sees the person's words and the start of the
		// reply, never the account.
		name: "conversation language",
		drive: (world, message, conversationId) =>
			resolveTurnReplyLanguage({
				userId: world.userId,
				conversationId,
				reply: REPLY,
				latestUserMessage: message,
				uiLanguage: world.uiLanguage,
			}),
	},
	{
		// What follows a reply is in the language the turn named, by the same
		// function the turn's completion asks.
		name: "follow-up chips",
		drive: async (world, message, conversationId) => {
			const read = await namedLanguage(world, message, conversationId);
			return generateFollowUpSuggestions({
				userId: world.userId,
				conversationId,
				userMessage: message,
				assistantResponse: REPLY,
				recentHistory: HISTORY.flatMap(([u, a]) => [
					{ role: "user" as const, content: u },
					{ role: "assistant" as const, content: a },
				]),
				responseLanguage: read.language,
			});
		},
	},
	{
		name: "rail headline",
		drive: async (world, message, conversationId) => {
			const read = await namedLanguage(world, message, conversationId);
			return persistAssistantRailSummary({
				userId: world.userId,
				conversationId,
				assistantMessageId: "no-such-message",
				assistantResponse: REPLY,
				responseLanguage: read.language,
			});
		},
	},
	{
		// The one call written in the account's UI language (owner decision 2).
		name: "thought step",
		drive: (world, _message, conversationId) =>
			classifyThoughtStepChunk({
				userId: world.userId,
				conversationId,
				chunkText:
					"The user compares a heat pump and a gas boiler. Running cost matters, and so does whether an outdoor unit is allowed.",
				currentActivityClass: null,
				targetLanguage: world.uiLanguage,
			}),
	},
	{
		name: "turn acknowledgment",
		drive: (world, message, conversationId) =>
			resolveTurnAcknowledgment({
				userId: world.userId,
				conversationId,
				message,
			}),
	},
	{
		name: "memory judge",
		drive: (world, message, conversationId) =>
			runMemoryJudgeOnSegment({
				userId: world.userId,
				conversationId,
				trigger: "explicit",
				segmentOverride: [
					{ role: "user", content: message },
					{ role: "assistant", content: REPLY },
				],
			}),
	},
	{
		name: "conversation summary",
		drive: (world, message, conversationId) =>
			refreshConversationSummary({
				userId: world.userId,
				conversationId,
				userMessage: message,
				assistantResponse: REPLY,
			}),
	},
	{
		name: "persona summary",
		drive: (world) => generateAndStorePersonaSummary({ userId: world.userId }),
	},
	{
		name: "memory consolidation",
		drive: (world) => runUserMemoryConsolidation(world.userId, "purity"),
	},
	{
		name: "app generate and verify",
		drive: (world, message, conversationId) =>
			generateAndVerifyApp({
				userId: world.userId,
				conversationId,
				// The brief the model wrote, and the person's own message beside it.
				prompt: `Build this: ${message}`,
				requestText: message,
			}),
	},
];

/**
 * The drivers whose every request may name the account's language, and why. None
 * is a turn's reply, a tool, or a thing written after one.
 */
const WRITTEN_IN_THE_UI_LANGUAGE: Record<string, string> = {
	"thought step":
		"the status line is written while Alfy thinks, before any reply text exists (owner decision 2)",
	"persona summary":
		"a nightly text the person reads under Memory, in their own language: a screen, not a turn",
};

/**
 * The one request inside another driver that may name it, by the schema it asks
 * for: a consolidation ends in the persona summary, and nothing else it sends
 * does.
 */
const UI_LANGUAGE_REQUEST_SCHEMAS: Record<string, string> = {
	persona_summary:
		"the nightly persona summary a consolidation ends in: a screen, not a turn",
};

function schemaNameOf(item: Capture): string {
	return (
		(
			item.body.response_format as
				| { json_schema?: { name?: string } }
				| undefined
		)?.json_schema?.name ?? ""
	);
}

/** The requests that are held to the rule: all but the screen's own. */
const heldToTheRule = (item: Capture) =>
	!(schemaNameOf(item) in UI_LANGUAGE_REQUEST_SCHEMAS);

async function requestsOf(
	world: World,
	driver: (typeof DRIVERS)[number],
): Promise<Capture[][]> {
	const perPrompt: Capture[][] = [];
	for (const [index, message] of PROMPTS.entries()) {
		perPrompt.push(
			await capture(`${driver.name} (${world.uiLanguage}-ui)`, () =>
				driver.drive(world, message, conversationOf(world, index)),
			),
		);
	}
	return perPrompt;
}

describe("the app's requests hold no server-authored Hungarian, whatever the account is shown in (I3)", () => {
	const ACCOUNTS = [
		{ shown: "English", world: () => en },
		{ shown: "Hungarian", world: () => hu },
	];
	for (const driver of DRIVERS) {
		for (const { shown, world } of ACCOUNTS) {
			it(`${driver.name}: nothing Hungarian in any request, for an account shown in ${shown}`, async () => {
				const account = world();
				if (
					account.uiLanguage === "hu" &&
					driver.name in WRITTEN_IN_THE_UI_LANGUAGE
				) {
					return; // written in the UI language by design (above)
				}
				const seen = (await requestsOf(account, driver)).flat();
				// A driver that sent nothing proves nothing (the 60 s thought-step
				// cap, a skipped consolidation): the call must have happened.
				if (driver.name !== "memory consolidation")
					expect(seen.length).toBeGreaterThan(0);
				expect(seen.filter(heldToTheRule).flatMap(offendersIn)).toEqual([]);
			}, 60_000);
		}
	}
});

/**
 * The remembered facts of a packet in a fixed order. Which of two facts the
 * memory projection lists first depends on when each was last touched (the
 * consolidation driver above touches them), not on the account's language, so the
 * comparison does not read the order.
 */
function sortedFacts(text: string): string {
	return text.replace(
		/(## Baseline Memory Profile\n[^\n]*\n)((?:- [^\n]*\n)+)/g,
		(_whole, heading: string, facts: string) =>
			`${heading}${facts.split("\n").filter(Boolean).sort().join("\n")}\n`,
	);
}

/** A request with the ids and times of one account's world blanked. */
function blanked(body: unknown, world: World): string {
	return JSON.stringify(
		JSON.parse(JSON.stringify(body), (_key, value) =>
			typeof value === "string" ? sortedFacts(value) : value,
		),
	)
		.split(world.userId)
		.join("<user>")
		.split(world.email)
		.join("<email>")
		.split(world.withHistory)
		.join("<conversation:history>")
		.split(world.inProject)
		.join("<conversation:project>")
		.split(world.fresh)
		.join("<conversation:fresh>")
		.replace(
			/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
			"<id>",
		)
		.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<time>");
}

/** Where two requests first differ, with the words around it: a failure shows the place. */
function firstDifference(english: string, hungarian: string): string {
	let at = 0;
	while (at < english.length && english[at] === hungarian[at]) at += 1;
	const around = (text: string) =>
		text.slice(Math.max(0, at - 160), at + 160).replace(/\\n/g, "\n");
	return `at ${at} of ${english.length}/${hungarian.length}\n--- shown in English\n${around(english)}\n--- shown in Hungarian\n${around(hungarian)}`;
}

describe("the UI language reaches no request but the status line's (I2)", () => {
	for (const driver of DRIVERS) {
		if (driver.name in WRITTEN_IN_THE_UI_LANGUAGE) continue;
		it(`${driver.name}: byte-identical requests for an account shown in English and one shown in Hungarian`, async () => {
			const english = (await requestsOf(en, driver)).map((requests) =>
				requests.filter(heldToTheRule),
			);
			const hungarian = (await requestsOf(hu, driver)).map((requests) =>
				requests.filter(heldToTheRule),
			);
			expect(english.map((r) => r.length)).toEqual(
				hungarian.map((r) => r.length),
			);
			for (const [index, requests] of english.entries()) {
				for (const [at, request] of requests.entries()) {
					const expected = blanked(request.body, en);
					const received = blanked(hungarian[index][at].body, hu);
					expect(
						received === expected ? null : firstDifference(expected, received),
						`${driver.name}, prompt ${index}, request ${at}`,
					).toBeNull();
				}
			}
		}, 60_000);
	}

	it("the status line, and the nightly persona summary, are the ones that differ: they name the account's language", async () => {
		for (const name of ["thought step", "persona summary"]) {
			const driver = DRIVERS.find((d) => d.name === name);
			if (!driver) throw new Error(`no ${name} driver`);
			const [english] = (await requestsOf(en, driver)).flat();
			const [hungarian] = (await requestsOf(hu, driver)).flat();
			expect(JSON.stringify(english?.body), name).toContain("English");
			expect(JSON.stringify(hungarian?.body), name).toContain("Hungarian");
		}
	}, 60_000);
});

describe("Atlas: the English side of every language-keyed prompt", () => {
	it("holds no Hungarian", () => {
		const modules: Array<Record<string, unknown>> = [
			atlasAnswerTable,
			atlasAsk,
			atlasEvidence,
			atlasFence,
			atlasOutline,
			atlasResearcher,
			atlasWorkspace,
			atlasWriter,
			{ standards: atlasStandard.ATLAS_V3_LANGUAGE_STANDARDS },
		];
		const offenders: Offender[] = [];
		let scanned = 0;
		for (const mod of modules) {
			for (const [name, value] of Object.entries(mod)) {
				if (!value || typeof value !== "object" || !("en" in value)) continue;
				scanned += 1;
				offenders.push(
					...offendersIn({
						call: `atlas ${name}`,
						body: { en: (value as { en: unknown }).en } as Record<
							string,
							unknown
						>,
					}),
				);
			}
		}
		expect(scanned).toBeGreaterThan(10);
		expect(offenders).toEqual([]);
	});
});

// --- layers 3 and 4: the source -----------------------------------------------

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

function sources(roots: string[]): Array<{ file: string; code: string }> {
	return roots.flatMap((root) =>
		readdirSync(join(SRC, root), { recursive: true })
			.map(String)
			.filter(
				(f) =>
					f.endsWith(".ts") &&
					!/\.test[.-]|\.d\.ts|test-helpers|test-support|eval-fixtures/.test(f),
			)
			.map((f) => {
				const file = relative(SRC, join(SRC, root, f));
				const code = readFileSync(join(SRC, root, f), "utf8")
					.replace(/\/\*[\s\S]*?\*\//g, "")
					.replace(/(^|[^:])\/\/.*$/gm, "$1");
				return { file, code };
			}),
	);
}

const MODEL_CALL_NAMES =
	"sendJsonControlMessage|callMemoryControlModel|requestContextSummarizer|requestStructuredControlModel|callShortLocalControlModel|generateShortLocalText|runPlainNormalChatModelRun|runStreamingNormalChatModelRun|generateText|streamText|generateObject|streamObject";
const MODEL_CALL = new RegExp(`\\b(?:${MODEL_CALL_NAMES})\\s*[(<]`);
/** `import { generateText as ask }`: the name a file calls it by. */
const MODEL_CALL_ALIAS = new RegExp(
	`\\b(?:${MODEL_CALL_NAMES})\\s+as\\s+(\\w+)`,
	"g",
);

/** Whether a file can make a model call, under the name it imports it by too. */
function callsAModel(code: string): boolean {
	if (MODEL_CALL.test(code)) return true;
	for (const alias of code.matchAll(MODEL_CALL_ALIAS)) {
		if (new RegExp(`\\b${alias[1]}\\s*[(<]`).test(code)) return true;
	}
	return false;
}

/** Who can make a model call, and how an English turn's request from it is checked. */
const MODEL_CALLERS: Record<string, string> = {
	"lib/server/services/chat-turn/plain-normal-chat-model-run.ts":
		"driver: chat",
	"lib/server/services/chat-turn/streaming-normal-chat-model-run.ts":
		"driver: chat (the same prepareOutboundContext and createToolPack)",
	"lib/server/services/chat-turn/shared-normal-chat-model-run-helpers.ts":
		"driver: chat (automatic compression sender)",
	"lib/server/services/chat-turn/short-local-text.ts":
		"drivers: title, chips, rail headline, acknowledgment (the primitive)",
	"lib/server/services/chat-turn/follow-up-suggestions.ts":
		"driver: follow-up chips",
	"lib/server/services/chat-turn/rail-summary.ts": "driver: rail headline",
	"lib/server/services/chat-turn/conversation-language.ts":
		"driver: conversation language (it names the two languages it chooses between, by design)",
	"lib/server/services/chat-turn/thought-step-classifier.ts":
		"driver: thought step",
	"lib/server/services/chat-turn/turn-acknowledgment.ts":
		"driver: turn acknowledgment",
	"lib/server/services/title-generator.ts": "driver: title",
	"lib/server/services/memory-judge/index.ts": "driver: memory judge",
	"lib/server/services/memory-consolidation/steps.ts":
		"driver: memory consolidation",
	"lib/server/services/memory-consolidation/summary.ts":
		"driver: persona summary",
	"lib/server/services/conversation-summaries.ts":
		"driver: conversation summary",
	"lib/server/services/artifacts/app/generate.ts":
		"driver: app generate and verify",
	"lib/server/services/artifacts/app/verify.ts":
		"driver: app generate and verify",
	"lib/server/services/atlas/model-stage.ts":
		"the transport of Atlas; its prompts are the atlas-v3 constants scanned above",
	"lib/server/services/atlas-v3/question-language.ts":
		"exempt: one English question about a question's language; the question is the person's own text, held by layer 4",
	"lib/server/services/normal-chat-model/index.ts":
		"the transport: no prompt text of its own",
	"lib/server/services/normal-chat-control-model.ts":
		"the control transport: no prompt text of its own",
	"lib/server/services/memory-control-model.ts":
		"the memory control transport: no prompt text of its own",
	"lib/server/services/artifacts/comments.ts":
		"exempt: the @Alfy reply prompt is English-only, held by layer 4",
	"lib/server/services/artifacts/canvas-comments.ts":
		"exempt: the board @Alfy reply prompt is English-only, held by layer 4",
	"lib/server/services/connections/locality.ts":
		"exempt: the connector distill prompt is English-only, held by layer 4",
	"lib/server/services/chatgpt-import/summarizer.ts":
		"exempt: a one-off import summary, English-only, held by layer 4",
	"lib/server/services/memory-recuration.ts":
		"exempt: admin-triggered re-audit, English-only, held by layer 4",
	"lib/server/services/task-state.ts":
		"exempt: checkpoint summaries, English-only, held by layer 4",
	"lib/server/services/task-state/artifacts.ts":
		"exempt: historical summaries, English-only, held by layer 4",
	"lib/server/services/task-state/control-model.ts":
		"exempt: the control client (and an unused classifier), English-only, held by layer 4",
};

/**
 * Files that may hold Hungarian letters in code, and why. A new one is a
 * decision. None of these is a prompt the model reads on a turn that is not
 * Hungarian by its own content: the model-facing scaffold is English only.
 */
const HUNGARIAN_BY_DESIGN: Record<string, string> = {
	// UI copy and chrome: shown to a person, never sent to a model
	"lib/server/services/skills/user-skills.ts":
		"hu skill texts, shown in the UI",
	"lib/server/services/browser-push.ts": "hu notification text",
	"lib/server/services/artifact-tours.ts": "UI copy",
	"lib/server/artifact-tour-defaults.ts": "UI copy",
	"lib/server/services/announcement-campaigns.ts": "UI copy",
	"lib/server/services/file-production/renderers/standard-report-html.ts":
		"hu report labels",
	"lib/shared/file-types/model-facing.ts": "hu wording of the file-type table",
	// After the reply: written in the language of the reply, so a Hungarian
	// reply gets Hungarian chips, status lines and titles (the prompts below
	// are only sent when that is the language asked for)
	"lib/server/services/title-generator.ts": "hu title examples",
	"lib/server/services/chat-turn/follow-up-suggestions.ts": "hu chip examples",
	"lib/server/services/chat-turn/thought-step-classifier.ts":
		"hu status-line examples",
	"lib/server/services/chat-turn/rail-summary.ts": "hu headline examples",
	// the reader and the checks: read, never sent
	"lib/server/services/language.ts": "the reader's word lists",
	"lib/server/services/chat-turn/short-local-text.ts": "leak checks",
	"lib/server/services/chat-turn/follow-up-chip.ts": "the chip check",
	"lib/server/services/chat-turn/context-selection.ts": "context cues",
	"lib/server/services/chat-turn/proactive-connector-context.ts":
		"connector cues",
	"lib/server/services/memory-context/query.ts": "stopwords",
	"lib/server/services/memory-context/read.ts": "recall cues",
	"lib/server/services/memory-judge/runner.ts": "the explicit-memory cue",
	"lib/server/services/memory-judge/schema.ts":
		"hedge and evidence-trail gates",
	"lib/server/utils/prompt-context.ts": "context cues",
	"lib/server/services/normal-chat-tools/produce-file.ts":
		"a Latin-1 letter range in a regex",
	"lib/server/services/file-production/source-schema.ts":
		"superscript letters in a pattern",
	// Atlas: a full parallel set keyed by the question's language, English side
	// scanned above
	"lib/server/services/atlas-v3/abstain.ts": "atlas hu set",
	"lib/server/services/atlas-v3/answer-table.ts": "atlas hu set",
	"lib/server/services/atlas-v3/ask.ts": "atlas hu set",
	"lib/server/services/atlas-v3/critic.ts": "atlas hu set",
	"lib/server/services/atlas-v3/evidence-bank.ts": "atlas hu set",
	"lib/server/services/atlas-v3/goal.ts": "atlas hu set",
	"lib/server/services/atlas-v3/language-standard.ts":
		"atlas hu register and sources",
	"lib/server/services/atlas-v3/number-match.ts": "atlas number words",
	"lib/server/services/atlas-v3/outline.ts": "atlas hu set",
	"lib/server/services/atlas-v3/pipeline.ts": "atlas hu set",
	"lib/server/services/atlas-v3/progress.ts": "atlas hu set",
	"lib/server/services/atlas-v3/prompt-fence.ts": "atlas hu set",
	"lib/server/services/atlas-v3/render.ts": "atlas hu set",
	"lib/server/services/atlas-v3/researcher.ts": "atlas hu set",
	"lib/server/services/atlas-v3/seed.ts": "atlas heading cues",
	"lib/server/services/atlas-v3/source-filters.ts": "atlas stopwords",
	"lib/server/services/atlas-v3/source-tier.ts": "atlas url cues",
	"lib/server/services/atlas-v3/verify.ts": "atlas placeholders",
	"lib/server/services/atlas-v3/workspace.ts": "atlas hu set",
	"lib/server/services/atlas-v3/writer.ts": "atlas hu set",
	// proper nouns of the places the routing tools cover
	"lib/server/services/routing/gtfs-catalogue.ts":
		"operator names (MAV, Bus Eireann) in the coverage label",
	// chrome: shown to a person, never sent to a model
	"routes/api/chat/send/+server.ts":
		"the Atlas kickoff and error messages for an account shown in Hungarian",
};

describe("English prompt text stays English (source layers)", () => {
	// The routes too: a route that calls a model with a prompt of its own is a
	// caller like any service (review RV-L, M6).
	const all = sources(["lib/server", "lib/shared", "routes"]);

	it("every file that can make a model call is driven here or named exempt", () => {
		const callers = all
			.filter(({ code }) => callsAModel(code))
			.map(({ file }) => file)
			.sort();
		const unlisted = callers.filter((file) => !(file in MODEL_CALLERS));
		const stale = Object.keys(MODEL_CALLERS).filter(
			(file) => !callers.includes(file),
		);
		expect({ unlisted, stale }).toEqual({ unlisted: [], stale: [] });
	});

	it("Hungarian letters are in registered files only", () => {
		const holders = all
			.filter(({ code }) =>
				[...code].some((c) => c.charCodeAt(0) > 127 && /\p{L}/u.test(c)),
			)
			.map(({ file }) => file)
			.sort();
		const unregistered = holders.filter(
			(file) => !(file in HUNGARIAN_BY_DESIGN),
		);
		expect(unregistered).toEqual([]);
	});

	it("an exempt model caller holds no Hungarian letter at all", () => {
		const exempt = Object.entries(MODEL_CALLERS)
			.filter(
				([, how]) => how.startsWith("exempt") || how.includes("no prompt text"),
			)
			.map(([file]) => file);
		const bad = all
			.filter(({ file }) => exempt.includes(file))
			.filter(({ code }) =>
				[...code].some((c) => c.charCodeAt(0) > 127 && /\p{L}/u.test(c)),
			)
			.map(({ file }) => file);
		expect(bad).toEqual([]);
	});

	it("the tool catalogue, the skill catalogue and the App contract hold no Hungarian letter", () => {
		// The files that write the scaffold of a Normal Chat turn: they were
		// language-keyed until 2026-10-13 and are one English text now.
		const scaffold = [
			"lib/server/services/normal-chat-tools/index.ts",
			"lib/server/services/normal-chat-tools/research-web-tool.ts",
			"lib/server/services/normal-chat-tools/tool-health-hints.ts",
			"lib/server/services/normal-chat-tools/artifact-tools/kind-prose.ts",
			"lib/server/services/normal-chat-tools/artifact-tools/edit.ts",
			"lib/server/services/url-provenance/refusal-text.ts",
			"lib/server/services/skills/prompt-context.ts",
			"lib/server/services/artifacts/app/contract.ts",
			"lib/server/services/artifacts/app/generate.ts",
			"lib/server/services/artifacts/app/verify.ts",
			"lib/server/services/memory-judge/prompt.ts",
			"lib/server/services/normal-chat-context.ts",
		];
		const found = new Set(all.map(({ file }) => file));
		for (const file of scaffold) expect(found.has(file), file).toBe(true);
		const holders = all
			.filter(({ file }) => scaffold.includes(file))
			.filter(({ code }) =>
				[...code].some((c) => c.charCodeAt(0) > 127 && /\p{L}/u.test(c)),
			)
			.map(({ file }) => file);
		expect(holders).toEqual([]);
	});
});
