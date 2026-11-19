// Script the model's decision; verify the actual tool, next provider request
// and vision gate. Free model choice is evaluated separately with the same
// English and Hungarian prompts in image-search-intents.ts.
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createModelCapabilitySet } from "$lib/model-capabilities";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import { buildBaselineDepthMetadata } from "$lib/server/services/chat-turn/depth-metadata";
import { runPlainNormalChatSendModel } from "$lib/server/services/chat-turn/plain-normal-chat-model-run";
import { runStreamingNormalChatSendModel } from "$lib/server/services/chat-turn/streaming-normal-chat-model-run";
import { createConversation } from "$lib/server/services/conversations";
import { fetchPublisherThumbnail } from "$lib/server/services/image-search";
import { imageSearchIntents } from "../fixtures/ai/image-search-intents";
import { installFakeProvider, removeFakeProvider } from "./language-capture";

vi.hoisted(() => {
	process.env.PARALLEL_API_KEY = "test-key";
	process.env.PARALLEL_BASE_URL = "https://parallel.test";
	process.env.MODEL_1_SYSTEM_PROMPT = "alfyai-nemotron";
});
vi.mock("$lib/server/services/image-search", async (original) => ({
	...(await original<typeof import("$lib/server/services/image-search")>()),
	fetchPublisherThumbnail: vi.fn(),
}));

type WireMessage = {
	role: string;
	content: string | Array<{ type: string; image_url?: { url: string } }>;
};
type WireRequest = {
	stream?: boolean;
	messages: WireMessage[];
	tools?: Array<{ function: { name: string; parameters: unknown } }>;
};
type Scenario = "seeing" | "blind" | "unreadable" | "text" | "closing-failover";

const pictureUrl = "https://media.example.org/plugs.jpg";
const sourcePage = "https://example.org/connectors";
const userId = randomUUID();
const email = `${userId}@example.org`;
let thumbnail: Buffer;

beforeAll(async () => {
	await db
		.insert(users)
		.values({ id: userId, email, name: "Alex", passwordHash: "unused" });
	thumbnail = await sharp({
		create: { width: 64, height: 32, channels: 3, background: "#1a8933" },
	})
		.jpeg()
		.toBuffer();
});

afterAll(() => removeFakeProvider());

function modelResponse(
	body: WireRequest,
	action?: Record<string, unknown>,
): Response {
	const call = action && {
		id: typeof action.action === "string" ? "look" : "search",
		type: "function",
		function: { name: "image_search", arguments: JSON.stringify(action) },
	};
	const base = { id: "response", created: 1, model: "test-chat" };
	const finish = call ? "tool_calls" : "stop";
	const message = call
		? { role: "assistant", tool_calls: [call] }
		: { role: "assistant", content: "OK." };
	if (!body.stream)
		return Response.json({
			...base,
			object: "chat.completion",
			choices: [{ index: 0, message, finish_reason: finish }],
		});
	const frame = (delta: unknown, reason: string | null) =>
		"data: " +
		JSON.stringify({
			...base,
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta, finish_reason: reason }],
		}) +
		"\n\n";
	const delta = call
		? { role: "assistant", tool_calls: [{ ...call, index: 0 }] }
		: message;
	return new Response(
		`${frame(delta, null) + frame({}, finish)}data: [DONE]\n\n`,
		{ headers: { "Content-Type": "text/event-stream" } },
	);
}

function pixelUrls(messages: WireMessage[]) {
	return messages.flatMap(({ content }) =>
		typeof content === "string"
			? []
			: content.flatMap((part) =>
					part.type === "image_url" && part.image_url
						? [part.image_url.url]
						: [],
				),
	);
}

function scriptedTurn(scenario: Scenario) {
	const requests: WireRequest[] = [];
	const searches: unknown[] = [];
	const closingRequests: WireRequest[] = [];
	vi.mocked(fetchPublisherThumbnail)
		.mockReset()
		.mockResolvedValue(
			scenario === "unreadable"
				? null
				: { bytes: thumbnail, contentType: "image/jpeg" },
		);
	installFakeProvider();
	const fallback = fetch;
	vi.stubGlobal(
		"fetch",
		async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input) === "https://parallel.test/v1/images/search") {
				searches.push(JSON.parse(String(init?.body)));
				return Response.json({
					results: [
						{
							title: "Connector reference",
							image_url: pictureUrl,
							source_page_url: sourcePage,
						},
					],
				});
			}
			const body = JSON.parse(String(init?.body ?? "{}")) as WireRequest;
			if (String(input) === "https://blind-fallback.test/v1/chat/completions") {
				closingRequests.push(body);
				return modelResponse(body);
			}
			if (!body.tools?.some((tool) => tool.function.name === "image_search"))
				return fallback(input, init);
			requests.push(body);
			if (scenario !== "text") {
				if (requests.length === 1)
					return modelResponse(body, { query: "mini USB and micro USB plugs" });
				if (requests.length === 2) {
					const result = body.messages.findLast(
						(message) => message.role === "tool",
					);
					const id = JSON.stringify(result?.content).match(
						/image-search:[0-9a-f]{12}/,
					)?.[0];
					if (!id)
						throw new Error(
							"No image result id reached the model after search.",
						);
					return modelResponse(body, { action: "inspect", resultIds: [id] });
				}
			}
			if (scenario === "closing-failover") {
				throw Object.assign(new Error("request timed out"), {
					name: "TimeoutError",
				});
			}
			return modelResponse(body);
		},
	);
	return { requests, searches, closingRequests };
}

async function runTurn(
	message: string,
	canSee: boolean,
	transport: "plain" | "stream",
	runtimeConfig = getConfig(),
) {
	const { id: conversationId } = await createConversation(userId, "Web images");
	const params = {
		message,
		conversationId,
		userId,
		modelId: "model1" as const,
		user: { id: userId, email, displayName: "Alex" },
		runtimeConfig,
		depthMetadata: buildBaselineDepthMetadata({ reasoningDepth: "thorough" }),
		enabledConnectionCapabilities: [],
		overrideProvider: {
			id: "test",
			modelId: "model1" as const,
			name: "test-chat",
			displayName: "Test model",
			baseUrl: "http://model.fake/v1",
			modelName: "test-chat",
			apiKey: "test-key",
			capabilities: createModelCapabilitySet({
				imageMessageParts: {
					state: "manual_override",
					supported: canSee,
					source: "manual_override",
				},
			}),
		},
	};
	if (transport === "plain") {
		const result = await runPlainNormalChatSendModel(params);
		return result.normalChatToolCalls ?? [];
	}
	const result = await runStreamingNormalChatSendModel(params);
	for await (const _ of result.stream) {
		/* Drain through the adapter's terminal receipt. */
	}
	return result.getNormalChatToolCalls();
}

for (const transport of ["plain", "stream"] as const) {
	for (const language of ["en", "hu"] as const) {
		it(
			transport +
				" carries " +
				language +
				" visual search metadata then inspected pixels; same-subject text needs neither",
			async () => {
				const fixture = imageSearchIntents[0];
				const visual = scriptedTurn("seeing");
				const calls = await runTurn(fixture.visual[language], true, transport);
				expect(visual.searches).toHaveLength(1);
				expect(calls.map((call) => call.name)).toEqual([
					"image_search",
					"image_search",
				]);
				expect(visual.requests).toHaveLength(3);
				expect(JSON.stringify(visual.requests[0].messages)).toContain(
					fixture.visual[language],
				);
				expect(pixelUrls(visual.requests[0].messages)).toEqual([]);
				expect(pixelUrls(visual.requests[1].messages)).toEqual([]);
				const modelEvidence = visual.requests[1].messages.filter(
					(message) => message.role === "tool",
				);
				expect(JSON.stringify(modelEvidence)).toContain(sourcePage);
				expect(JSON.stringify(modelEvidence)).toContain(pictureUrl);
				expect(fetchPublisherThumbnail).toHaveBeenCalledTimes(1);
				expect(vi.mocked(fetchPublisherThumbnail).mock.calls[0][0]).toBe(
					pictureUrl,
				);
				const pixels = pixelUrls(visual.requests[2].messages);
				expect(pixels).toHaveLength(1);
				expect(pixels[0]).toMatch(/^data:image\/jpeg;base64,/);
				const { channels } = await sharp(
					Buffer.from(pixels[0].split(",")[1], "base64"),
				).stats();
				expect(channels[1].mean).toBeGreaterThan(channels[0].mean + 50);
				expect(JSON.stringify(calls)).not.toContain("base64,");

				const plain = scriptedTurn("text");
				const textCalls = await runTurn(
					fixture.text[language],
					true,
					transport,
				);
				expect(textCalls).toHaveLength(0);
				expect(plain.searches).toHaveLength(0);
				expect(plain.requests).toHaveLength(1);
				expect(JSON.stringify(plain.requests[0].messages)).toContain(
					fixture.text[language],
				);
				expect(pixelUrls(plain.requests[0].messages)).toEqual([]);
				expect(fetchPublisherThumbnail).not.toHaveBeenCalled();
			},
		);
	}
	it(`${transport} reprojects a seeing attempt's inspected image before a blind model closes`, async () => {
		const run = scriptedTurn("closing-failover");
		const config = getConfig();
		const calls = await runTurn(
			imageSearchIntents[0].visual.en,
			true,
			transport,
			{
				...config,
				modelTimeoutFailoverEnabled: true,
				modelTimeoutFailoverTargetModel: "model2",
				model2Enabled: true,
				model2: {
					...config.model2,
					baseUrl: "https://blind-fallback.test/v1",
					modelName: "blind-fallback",
					apiKey: "test-key",
				},
			},
		);
		expect(calls.map((call) => call.name)).toEqual([
			"image_search",
			"image_search",
		]);
		expect(run.searches).toHaveLength(1);
		expect(fetchPublisherThumbnail).toHaveBeenCalledTimes(1);
		expect(pixelUrls(run.requests[2].messages)).toHaveLength(1);
		expect(run.closingRequests).toHaveLength(1);
		const closing = run.closingRequests[0];
		expect(closing.tools).toBeUndefined();
		expect(pixelUrls(closing.messages)).toEqual([]);
		const wire = JSON.stringify(closing.messages);
		expect(wire).toContain(sourcePage);
		expect(wire).not.toContain("base64,");
		const inspection = closing.messages.findLast(
			(message) => message.role === "tool",
		);
		expect(inspection?.content).toMatch(/if they follow/);
		expect(inspection?.content).toMatch(/answer in text/);
		expect(
			closing.messages.some(
				(message) =>
					message.role === "user" &&
					JSON.stringify(message.content).includes(
						"this model cannot see images",
					),
			),
		).toBe(true);
	});
	it.each(["blind", "unreadable"] as const)(
		`${transport} withholds pixels after %s inspection`,
		async (scenario) => {
			const run = scriptedTurn(scenario);
			const calls = await runTurn(
				imageSearchIntents[0].visual.hu,
				scenario !== "blind",
				transport,
			);
			expect(calls.map((call) => call.name)).toEqual([
				"image_search",
				"image_search",
			]);
			expect(run.searches).toHaveLength(1);
			expect(run.requests).toHaveLength(3);
			expect(
				run.requests.flatMap((request) => pixelUrls(request.messages)),
			).toEqual([]);
			expect(fetchPublisherThumbnail).toHaveBeenCalledTimes(
				scenario === "blind" ? 0 : 1,
			);
			const answerEvidence = run.requests[2].messages.findLast(
				(message) => message.role === "tool",
			);
			expect(JSON.stringify(answerEvidence?.content)).toMatch(
				/no pixels|could not.*preview/i,
			);
			expect(JSON.stringify(answerEvidence?.content)).toMatch(
				/answer in text|text only/i,
			);
			expect(JSON.stringify(answerEvidence?.content)).not.toContain(
				"queuedIds",
			);
		},
	);
}
