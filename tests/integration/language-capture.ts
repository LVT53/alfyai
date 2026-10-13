// A capturing fake provider and a small world to drive the app's own model
// calls against, for the reply-language tests (reply-language.test.ts) and the
// English-request purity test (english-request-purity.test.ts).
//
// Nothing here decides anything: it records every request the app sends to a
// model (the global `fetch` is stubbed), answers with canned text, and seeds the
// same user data for an account of either UI language, so a test can ask what
// the UI language changed in what a model was sent.
//
// A test file sets the model environment itself in a `vi.hoisted` block (the
// config reads it on first import), then installs the provider in `beforeAll`.
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { vi } from "vitest";
import { getConfig } from "../../src/lib/server/config-store";
import { db } from "../../src/lib/server/db";
import { users } from "../../src/lib/server/db/schema";
import { buildBaselineDepthMetadata } from "../../src/lib/server/services/chat-turn/depth-metadata";
import { runPlainNormalChatSendModel } from "../../src/lib/server/services/chat-turn/plain-normal-chat-model-run";
import { createConversation } from "../../src/lib/server/services/conversations";
import {
	createMemoryProfileItem,
	ensureProjectionState,
	storePersonaSummaryProjection,
} from "../../src/lib/server/services/memory-profile/projection-store";
import { createMessage } from "../../src/lib/server/services/messages";
import {
	createProject,
	updateProject,
} from "../../src/lib/server/services/projects";

// --- the fixtures: English, ASCII ---------------------------------------------

export const PERSONAL_INSTRUCTIONS = "Keep answers short. Use metric units.";
export const PROJECT_INSTRUCTIONS =
	"This project is a kitchen renovation in Dublin. Quote costs in euros.";
export const FACTS = ["I live in Dublin.", "I prefer concise answers."];
export const PERSONA = "They live in Dublin and are renovating their kitchen.";
export const HISTORY: Array<[string, string]> = [
	[
		"Which tiles are best for a kitchen floor?",
		"Porcelain tiles are usually the best choice because they are hard-wearing and easy to clean.",
	],
	[
		"And what about the walls?",
		"For walls you can use ceramic tiles, which are lighter and cheaper than porcelain.",
	],
];
export const REPLY =
	"Heat pumps move heat instead of making it, so they usually need about a third of the energy a gas boiler needs for the same warmth; the catch is the upfront cost and the need for decent insulation. For a small apartment, check whether your building allows an outdoor unit first, then compare the running costs over ten years, and finally ask two installers for a written quote.";
const APP_ANSWER = `\`\`\`html\n<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Expense tracker</title></head><body><h1>Expense tracker</h1><button type="button">Add</button></body></html>\n\`\`\`\n`;

// --- the capturing provider ---------------------------------------------------

export type Capture = {
	/** Who asked: a driver name, then the account's label. */
	call: string;
	url: string;
	body: Record<string, unknown>;
};

export const captures: Capture[] = [];
let currentCall = "";

/** What the fake model answers, by the schema the caller asked for. */
function cannedReply(body: Record<string, unknown>): string {
	const name =
		(body.response_format as { json_schema?: { name?: string } } | undefined)
			?.json_schema?.name ?? "";
	if (name === "follow_up_suggestions") {
		return JSON.stringify({
			followUps: [
				"Compare the two options in a table",
				"Draft the email to the landlord",
			],
		});
	}
	if (name === "rail_headline")
		return JSON.stringify({ headline: "Choosing a heating system" });
	if (name === "persona_summary") {
		return JSON.stringify({
			sentences: [{ text: "They live in Dublin.", factIds: [] }],
		});
	}
	if (/in the language of|Write the whole app in/.test(JSON.stringify(body)))
		return APP_ANSWER;
	return JSON.stringify(body).includes("JSON") ? "{}" : REPLY;
}

async function fakeFetch(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	const url =
		typeof input === "string"
			? input
			: String((input as URL).href ?? (input as Request).url);
	let body: Record<string, unknown> = {};
	try {
		body = JSON.parse(String(init?.body ?? "{}"));
	} catch {
		body = {};
	}
	captures.push({ call: currentCall, url, body });
	const content = cannedReply(body);
	if (body.stream === true) {
		const chunk = (delta: Record<string, unknown>, finish: string | null) =>
			`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "fake", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
		return new Response(
			`${chunk({ role: "assistant", content }, null)}${chunk({}, "stop")}data: [DONE]\n\n`,
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
	}
	return new Response(
		JSON.stringify({
			id: "c",
			object: "chat.completion",
			created: 0,
			model: "fake",
			choices: [
				{
					index: 0,
					message: { role: "assistant", content },
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

export function installFakeProvider(): void {
	vi.stubGlobal("fetch", fakeFetch);
}

export function removeFakeProvider(): void {
	vi.unstubAllGlobals();
}

/** Runs `fn` and returns the requests it made, each labelled with `call`. */
export async function capture(
	call: string,
	fn: () => Promise<unknown>,
): Promise<Capture[]> {
	currentCall = call;
	const before = captures.length;
	await fn();
	return captures.slice(before);
}

// --- the world: one account, the same data whatever its UI language -----------

export type World = {
	userId: string;
	email: string;
	uiLanguage: "en" | "hu";
	/** A conversation with two earlier turns. */
	withHistory: string;
	/** A conversation in a project that has instructions. */
	inProject: string;
	/** A conversation with nothing in it. */
	fresh: string;
	/** The `user` object the routes hand to the model run. */
	user: () => { id: string; displayName: string; email: string };
};

export async function seedWorld(uiLanguage: "en" | "hu"): Promise<World> {
	const userId = randomUUID();
	const email = `lang-${uiLanguage}-${randomUUID().slice(0, 6)}@example.com`;
	await db.insert(users).values({
		id: userId,
		email,
		passwordHash: await bcrypt.hash("pw", 4),
		name: "Alex Morgan",
		role: "user",
		uiLanguage,
		personalInstructions: PERSONAL_INSTRUCTIONS,
	});
	const project = await createProject(userId, "Kitchen renovation");
	await updateProject(userId, project.id, {
		instructions: PROJECT_INSTRUCTIONS,
	});
	const inProject = (
		await createConversation(userId, "Tiles", { projectId: project.id })
	).id;
	const withHistory = (await createConversation(userId, "Plain chat")).id;
	const fresh = (await createConversation(userId, "Fresh chat")).id;
	for (const id of [inProject, withHistory]) {
		for (const [u, a] of HISTORY) {
			await createMessage(id, "user", u);
			await createMessage(id, "assistant", a);
		}
	}
	for (const fact of FACTS) {
		await createMemoryProfileItem({
			userId,
			category: "about_you",
			scope: { type: "global" },
			statement: fact,
		});
	}
	const projection = await ensureProjectionState({
		userId,
		resetGeneration: 0,
	});
	await storePersonaSummaryProjection({
		projectionStateId: projection.id,
		personaSummaryText: PERSONA,
		personaSummaryLinksJson: "[]",
		now: new Date(),
	});
	return {
		userId,
		email,
		uiLanguage,
		withHistory,
		inProject,
		fresh,
		user: () => ({ id: userId, displayName: "Alex Morgan", email }),
	};
}

// --- the chat call ------------------------------------------------------------

/** One Normal Chat model call, through the app's own plain model run. */
export function driveChat(
	world: World,
	message: string,
	conversationId: string,
): Promise<unknown> {
	return runPlainNormalChatSendModel({
		userId: world.userId,
		runtimeConfig: getConfig(),
		message,
		conversationId,
		modelId: "model1",
		// The account, as the routes hand it over. Its UI language is carried
		// here the way the stream route carries it (a variable, so this stays
		// an input the model run does not take).
		user: world.user(),
		depthMetadata: buildBaselineDepthMetadata({ reasoningDepth: "thorough" }),
		enabledConnectionCapabilities: [],
		overrideProvider: {
			id: "fake",
			modelId: "model1",
			name: "fake",
			displayName: "Fake Model",
			baseUrl: "http://model1.fake/v1",
			modelName: "fake-model-1",
			apiKey: "k1",
		},
	});
}

// --- reading a request --------------------------------------------------------

/** The text of the last message with this role: a string, or its text parts. */
export function lastMessageText(
	body: Record<string, unknown>,
	role: string,
): string {
	const messages = (body.messages ?? []) as Array<{
		role: string;
		content: unknown;
	}>;
	const last = [...messages].reverse().find((m) => m.role === role);
	if (!last) return "";
	if (typeof last.content === "string") return last.content;
	if (Array.isArray(last.content)) {
		return last.content
			.map((part) =>
				part && typeof part === "object" && "text" in part
					? String((part as { text: unknown }).text)
					: "",
			)
			.join("");
	}
	return "";
}

/** Every string a request holds, with the path it sits at. */
export function leaves(
	value: unknown,
	path: string,
	out: Array<{ path: string; text: string }> = [],
): Array<{ path: string; text: string }> {
	if (typeof value === "string") {
		out.push({ path, text: value });
	} else if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			leaves(item, `${path}[${index}]`, out);
		}
	} else if (value && typeof value === "object") {
		for (const [key, item] of Object.entries(value)) {
			leaves(item, path ? `${path}.${key}` : key, out);
		}
	}
	return out;
}
