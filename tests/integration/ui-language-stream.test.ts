// The account's UI language does not reach the chat call, through the layer where
// it lives (I2).
//
// english-request-purity.test.ts holds I2 for every call a turn makes, but its
// chat driver (language-capture.ts's driveChat) hands the model run a user with no
// UI language, so "an account shown in Hungarian" differs from one shown in
// English only in its database row. In the chat path the UI language exists in
// the routes and the stream orchestrator, which carries it to the status-line
// classifier and to completion (the last fallback of what is written after the
// reply). This file drives the chat call through the orchestrator itself, with
// the UI language on the user it is handed, against the capturing fake provider,
// and compares what the model is sent for an account shown in English and one
// shown in Hungarian: byte for byte, after blanking ids and times.
//
// A fresh conversation per account and per prompt, with the same history: the
// orchestrator stores the turn, and nothing here should leave rows another test
// of the purity file would read.
import { randomUUID } from "node:crypto";
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

import { buildBaselineDepthMetadata } from "../../src/lib/server/services/chat-turn/depth-metadata";
import { runChatStreamOrchestrator } from "../../src/lib/server/services/chat-turn/stream-orchestrator";
import type { ChatTurnPreflight } from "../../src/lib/server/services/chat-turn/types";
import { createConversation } from "../../src/lib/server/services/conversations";
import { createMessage } from "../../src/lib/server/services/messages";
import {
	type Capture,
	capture,
	captures,
	HISTORY,
	installFakeProvider,
	removeFakeProvider,
	seedWorld,
	type World,
} from "./language-capture";

const PROMPTS = [
	"hi",
	"What's the difference between a heat pump and a gas boiler for a small apartment?",
	"Mit érdemes választani egy kis lakáshoz: hőszivattyút vagy gázkazánt?",
	"Answer in Hungarian: what is photosynthesis?",
];

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

function turnFor(
	conversationId: string,
	message: string,
	streamId: string,
): ChatTurnPreflight {
	return {
		conversationId,
		normalizedMessage: message,
		streamId,
		modelId: "model1",
		modelDisplayName: "Fake Model",
		skipPersistUserMessage: false,
		turnOrigin: "send",
		attachmentIds: [],
		linkedSources: [],
		pendingSkill: null,
		reasoningDepth: "thorough",
		thinkingMode: "auto",
		forceWebSearch: false,
		atlasMode: false,
		atlasProfile: null,
		atlasAction: "create",
		parentAtlasId: null,
		clientAtlasTurnId: null,
		depthMetadata: buildBaselineDepthMetadata({ reasoningDepth: "thorough" }),
	};
}

/**
 * Waits until the turn has stopped making requests: the terminal frame comes
 * before the post-turn work (memory, embeddings, the chips) is done, and that
 * work must not run into the next test, or past the end of this file.
 */
async function untilQuiet(quietMs = 250, limitMs = 5_000): Promise<void> {
	const started = Date.now();
	let seen = captures.length;
	let quietSince = Date.now();
	while (Date.now() - started < limitMs) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		if (captures.length !== seen) {
			seen = captures.length;
			quietSince = Date.now();
		} else if (Date.now() - quietSince >= quietMs) {
			return;
		}
	}
}

/**
 * One streamed turn through the orchestrator, as the stream route hands it over:
 * the account's UI language on the user. Returns the chat requests the model got.
 */
async function streamedChatRequests(
	world: World,
	message: string,
): Promise<Capture[]> {
	const conversation = await createConversation(world.userId, "Streamed");
	for (const [u, a] of HISTORY) {
		await createMessage(conversation.id, "user", u);
		await createMessage(conversation.id, "assistant", a);
	}
	const requests = await capture(
		`stream (${world.uiLanguage}-ui)`,
		async () => {
			const response = runChatStreamOrchestrator({
				user: { ...world.user(), uiLanguage: world.uiLanguage },
				turn: turnFor(conversation.id, message, `stream-${randomUUID()}`),
				upstreamMessage: message,
				downstreamAbortSignal: new AbortController().signal,
				requestStartTime: Date.now(),
			});
			// The stream is finished when the body is: the terminal frame, then [DONE].
			await response.text();
			await untilQuiet();
		},
	);
	// The chat call is the one that streams; the turn's other calls (the status
	// line, the chips, the language call) are held by the purity test.
	return requests.filter((request) => request.body.stream === true);
}

/**
 * The remembered facts of a packet in a fixed order. Which of two facts the
 * memory projection lists first depends on when each was last touched, not on the
 * account's language (english-request-purity.test.ts does the same).
 */
function sortedFacts(text: string): string {
	return text.replace(
		/(## Baseline Memory Profile\n[^\n]*\n)((?:- [^\n]*\n)+)/g,
		(_whole, heading: string, facts: string) =>
			`${heading}${facts.split("\n").filter(Boolean).sort().join("\n")}\n`,
	);
}

function blanked(body: unknown, world: World, conversationId?: string): string {
	let json = JSON.stringify(
		JSON.parse(JSON.stringify(body), (_key, value) =>
			typeof value === "string" ? sortedFacts(value) : value,
		),
	);
	for (const [value, label] of [
		[world.userId, "<user>"],
		[world.email, "<email>"],
		[world.withHistory, "<conversation:history>"],
		[world.inProject, "<conversation:project>"],
		[world.fresh, "<conversation:fresh>"],
		[conversationId, "<conversation>"],
	] as const) {
		if (value) json = json.split(value).join(label);
	}
	return json
		.replace(
			/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
			"<id>",
		)
		.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<time>");
}

/** Where two requests first differ, with the words around it. */
function firstDifference(english: string, hungarian: string): string {
	let at = 0;
	while (at < english.length && english[at] === hungarian[at]) at += 1;
	const around = (text: string) =>
		text.slice(Math.max(0, at - 160), at + 160).replace(/\\n/g, "\n");
	return `at ${at} of ${english.length}/${hungarian.length}\n--- shown in English\n${around(english)}\n--- shown in Hungarian\n${around(hungarian)}`;
}

describe("the UI language reaches no chat request, through the stream orchestrator (I2)", () => {
	for (const message of PROMPTS) {
		it(`byte-identical chat requests for an account shown in English and one shown in Hungarian: ${message.slice(0, 40)}`, async () => {
			const english = await streamedChatRequests(en, message);
			const hungarian = await streamedChatRequests(hu, message);
			// A run that sent nothing proves nothing.
			expect(english.length).toBeGreaterThan(0);
			expect(hungarian.length).toBe(english.length);
			for (const [at, request] of english.entries()) {
				const expected = blanked(request.body, en);
				const received = blanked(hungarian[at].body, hu);
				expect(
					received === expected ? null : firstDifference(expected, received),
					`request ${at}`,
				).toBeNull();
			}
		}, 60_000);
	}
});
