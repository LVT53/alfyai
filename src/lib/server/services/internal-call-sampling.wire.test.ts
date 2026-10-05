import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What every server-side model request that is NOT the chat turn's own run puts
// on the wire, read through a fake `fetch` (never what the code seems to pass).
//
// One family declares the sampling a local Qwen checkpoint needs: the qwen
// adapter's `defaultSampling` (provider-compatibility.ts). The checkpoint's own
// generation_config ships temperature 1.0, at which short Hungarian snippets a
// person reads come out garbled ("Rägyvágok"). The rule these tests pin:
//
//   - an answer a PERSON reads takes the whole family profile (temperature,
//     top_p, top_k);
//   - a deterministic MACHINE-read answer (a JSON classification) may keep its
//     own temperature, and the family's top_p/top_k still go along;
//   - a family with NO profile sends exactly what it always sent.

const mocks = vi.hoisted(() => ({
	getConfig: vi.fn(),
	getProviderByName: vi.fn(),
	getProviderWithSecrets: vi.fn(),
	listEnabledProviderModels: vi.fn(),
	recordControlModelUsage: vi.fn(),
	recordMemoryModelUsage: vi.fn(),
	updateMessageRailSummary: vi.fn(),
}));

vi.mock("../config-store", () => ({ getConfig: mocks.getConfig }));
vi.mock("./providers", () => ({
	getProviderByName: mocks.getProviderByName,
	getProviderWithSecrets: mocks.getProviderWithSecrets,
}));
vi.mock("./provider-models", () => ({
	listEnabledProviderModels: mocks.listEnabledProviderModels,
}));
vi.mock("./analytics", () => ({
	recordControlModelUsage: mocks.recordControlModelUsage,
}));
vi.mock("./memory-cost", () => ({
	recordMemoryModelUsage: mocks.recordMemoryModelUsage,
}));
vi.mock("./messages", () => ({
	updateMessageRailSummary: mocks.updateMessageRailSummary,
}));
vi.mock("../prompts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../prompts")>();
	return { ...actual, getSystemPrompt: (prompt: string) => prompt };
});

import { generateApp } from "./artifacts/app/generate";
import { verifyApp } from "./artifacts/app/verify";
import { generateFollowUpSuggestions } from "./chat-turn/follow-up-suggestions";
import { persistAssistantRailSummary } from "./chat-turn/rail-summary";
import { classifyThoughtStepChunk } from "./chat-turn/thought-step-classifier";
import { resolveTurnAcknowledgment } from "./chat-turn/turn-acknowledgment";
import { summarizeConversation } from "./chatgpt-import/summarizer";
import { callMemoryControlModel } from "./memory-control-model";
import { sendJsonControlMessage } from "./normal-chat-control-model";
import { runPlainNormalChatModelRun } from "./normal-chat-model";
import { classifyMemoryBatch } from "./task-state/control-model";
import { generateTitle } from "./title-generator";

const LOCAL_URL = "http://192.168.1.96:30000/v1";
const CLOUD_URL = "https://openai-compatible.example/v1";

/** The qwen family's one declared profile, as the wire carries it. */
const PROFILE = { temperature: 0.6, top_p: 0.95, top_k: 20 };
/** A machine-read answer's own temperature; the family's top_p/top_k go along. */
const keepsOwnTemperature = (temperature: number) => ({
	temperature,
	top_p: 0.95,
	top_k: 20,
});

function configFor(params: {
	modelName: string;
	baseUrl: string;
	displayName: string;
}) {
	const model = {
		baseUrl: params.baseUrl,
		apiKey: "",
		modelName: params.modelName,
		displayName: params.displayName,
		maxTokens: 8192,
		reasoningEffort: null,
	};
	return {
		requestTimeoutMs: 300_000,
		model1: model,
		model2: model,
		titleGenUrl: params.baseUrl,
		titleGenModel: params.modelName,
		titleGenApiKey: "",
		titleGenSystemPromptEn: "Write a short title.",
		titleGenSystemPromptHu: "Írj rövid címet.",
		titleGenSystemPromptCodeAppendixEn: "",
		titleGenSystemPromptCodeAppendixHu: "",
		contextSummarizerUrl: params.baseUrl,
		contextSummarizerModel: params.modelName,
		contextSummarizerApiKey: "",
		memoryConsolidationModel: "model2",
	};
}

const qwenConfig = () =>
	configFor({
		modelName: "qwen3-6-27b",
		baseUrl: LOCAL_URL,
		displayName: "Local Qwen",
	});
// A family the adapter has no sampling profile for.
const profilelessConfig = () =>
	configFor({
		modelName: "gpt-4.1",
		baseUrl: CLOUD_URL,
		displayName: "Cloud GPT",
	});

function chatCompletion(content: string) {
	return new Response(
		JSON.stringify({
			id: "chatcmpl-1",
			model: "served-model",
			created: 1_717_171_717,
			choices: [
				{
					index: 0,
					message: { role: "assistant", content },
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

/** A streamed answer, for the paths that run through the chat run's streaming call. */
function sseCompletion(text: string) {
	const chunk = (delta: object, finish: string | null = null) =>
		`data: ${JSON.stringify({
			id: "chatcmpl-1",
			object: "chat.completion.chunk",
			created: 1_717_171_717,
			model: "served-model",
			choices: [{ index: 0, delta, finish_reason: finish }],
		})}\n\n`;
	return new Response(
		`${chunk({ role: "assistant", content: text })}${chunk({}, "stop")}data: [DONE]\n\n`,
		{ status: 200, headers: { "Content-Type": "text/event-stream" } },
	);
}

let fetchMock: ReturnType<typeof vi.fn>;

/** The sampling fields of the first request body that actually left. */
function wire(): { temperature?: number; top_p?: number; top_k?: number } {
	const init = fetchMock.mock.calls[0]?.[1] as { body?: unknown } | undefined;
	expect(init, "no request reached the fake fetch").toBeDefined();
	const body = JSON.parse(String(init?.body ?? "{}"));
	return {
		temperature: body.temperature,
		top_p: body.top_p,
		top_k: body.top_k,
	};
}

const HU_USER = "Szia! Segítenél összeállítani egy heti étrendet?";
const HU_REPLY =
	"Természetesen! Íme egy egyszerű heti étrend: hétfőn zöldséges leves és rakott krumpli, kedden csirkemell salátával, szerdán halászlé és túrós csusza, csütörtökön gulyás, pénteken sült zöldségek rizzsel, a hétvégén pedig könnyű vacsorák és gyümölcs.";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getConfig.mockReturnValue(qwenConfig());
	mocks.getProviderByName.mockResolvedValue(null);
	mocks.getProviderWithSecrets.mockResolvedValue(null);
	mocks.listEnabledProviderModels.mockResolvedValue([]);
	mocks.recordControlModelUsage.mockResolvedValue(undefined);
	mocks.recordMemoryModelUsage.mockResolvedValue(undefined);
	mocks.updateMessageRailSummary.mockResolvedValue(undefined);
	fetchMock = vi.fn(async () => chatCompletion('{"ok":true}'));
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("internal model calls on a qwen-family model: what reaches the wire", () => {
	it("control transport: an answer a person reads (no caller temperature) takes the family profile", async () => {
		await sendJsonControlMessage("hello", "model2", {
			systemPrompt: "Answer briefly.",
		}).catch(() => null);
		expect(wire()).toEqual(PROFILE);
	});

	it("control transport: a machine-read answer keeps its own temperature while top_p/top_k ride along", async () => {
		await sendJsonControlMessage("hello", "model2", {
			systemPrompt: "Classify.",
			temperature: 0,
		}).catch(() => null);
		expect(wire()).toEqual(keepsOwnTemperature(0));
	});

	it("turn acknowledgment: a JSON classification keeps temperature 0, family top_p/top_k ride along", async () => {
		await resolveTurnAcknowledgment({
			userId: "u1",
			conversationId: "c1",
			message: HU_USER,
		});
		expect(wire()).toEqual(keepsOwnTemperature(0));
	});

	it("rail summary: the headline a person reads takes the family profile", async () => {
		await persistAssistantRailSummary({
			userId: "u1",
			conversationId: "c1",
			assistantMessageId: "m1",
			userMessage: HU_USER,
			assistantResponse: HU_REPLY,
		});
		expect(wire()).toEqual(PROFILE);
	});

	it("title generation: the title a person reads takes the family profile", async () => {
		fetchMock.mockImplementation(async () => chatCompletion("Heti étrend"));
		await generateTitle(HU_USER, HU_REPLY, "hu");
		expect(wire()).toEqual(PROFILE);
	});

	it("ChatGPT-import summarizer: a digest only the memory judge reads keeps its low temperature, family top_p/top_k ride along", async () => {
		fetchMock.mockImplementation(async () => chatCompletion("Összefoglaló."));
		await summarizeConversation(
			[
				{ role: "user", content: HU_USER },
				{ role: "assistant", content: HU_REPLY },
			],
			"Heti étrend",
		);
		expect(wire()).toEqual(keepsOwnTemperature(0.2));
	});

	it("task-state classifier: a JSON classification keeps temperature 0, family top_p/top_k ride along", async () => {
		fetchMock.mockImplementation(async () =>
			chatCompletion('{"classifications":[{"id":"f1","status":"PERSONAL"}]}'),
		);
		await classifyMemoryBatch([
			{ id: "f1", statement: "Szereti a gulyást.", category: "preference" },
		] as never);
		expect(wire()).toEqual(keepsOwnTemperature(0));
	});

	it("memory adapter: a deterministic JSON extraction (judge, consolidation, recuration) keeps temperature 0, family top_p/top_k ride along", async () => {
		await callMemoryControlModel({
			userId: "u1",
			feature: "judge",
			systemPrompt: "Extract facts.",
			userMessage: "{}",
			modelId: "model2",
			inputSizeHint: 3,
		}).catch(() => null);
		expect(wire()).toEqual(keepsOwnTemperature(0));
	});

	it("chat turn (plain run): the profile's own route, through the same helper", async () => {
		await runPlainNormalChatModelRun({
			provider: {
				id: "p1",
				name: "model1",
				displayName: "Local Qwen",
				baseUrl: LOCAL_URL,
				modelName: "qwen3-6-27b",
				apiKey: "",
			},
			messages: [{ role: "user", content: [{ type: "text", text: HU_USER }] }],
			fetch: fetchMock as typeof fetch,
		}).catch(() => null);
		expect(wire()).toEqual(PROFILE);
	});

	it("App generator: the App a person opens takes the family profile through the chat run (the contract holds no copy)", async () => {
		fetchMock.mockImplementation(async () => sseCompletion("no app here"));
		await generateApp({
			userId: "u1",
			conversationId: "c1",
			prompt: "Egy egyszerű visszaszámláló alkalmazás",
			language: "hu",
		}).catch(() => null);
		expect(wire()).toEqual(PROFILE);
	});

	it("App verification classifier: a JSON verdict keeps temperature 0, family top_p/top_k ride along", async () => {
		await verifyApp({
			userId: "u1",
			conversationId: "c1",
			html: "<!doctype html><html><body>12:00</body></html>",
			prompt: "egy óra",
			language: "hu",
		}).catch(() => null);
		expect(wire()).toEqual(keepsOwnTemperature(0));
	});
});

describe("a family with no sampling profile sends exactly what it always sent", () => {
	beforeEach(() => {
		mocks.getConfig.mockReturnValue(profilelessConfig());
	});

	it("control transport: the flat 0.1, no top_p, no top_k", async () => {
		await sendJsonControlMessage("hello", "model2", {
			systemPrompt: "Answer briefly.",
		}).catch(() => null);
		expect(wire()).toEqual({ temperature: 0.1 });
	});

	it("control transport: a machine-read caller's own temperature, nothing else", async () => {
		await sendJsonControlMessage("hello", "model2", {
			systemPrompt: "Classify.",
			temperature: 0,
		}).catch(() => null);
		expect(wire()).toEqual({ temperature: 0 });
	});

	it("thought-step classifier: still temperature 0", async () => {
		await classifyThoughtStepChunk({
			userId: "u1",
			conversationId: "c1",
			chunkText: "The user wants a weekly meal plan.",
			currentActivityClass: null,
			targetLanguage: "hu",
		});
		expect(wire()).toEqual({ temperature: 0 });
	});

	it("follow-up suggestions: still temperature 0.4", async () => {
		await generateFollowUpSuggestions({
			userId: "u1",
			conversationId: "c1",
			userMessage: HU_USER,
			assistantResponse: HU_REPLY,
		});
		expect(wire()).toEqual({ temperature: 0.4 });
	});

	it("title generation: still temperature 0.2", async () => {
		fetchMock.mockImplementation(async () => chatCompletion("Heti étrend"));
		await generateTitle(HU_USER, HU_REPLY, "hu");
		expect(wire()).toEqual({ temperature: 0.2 });
	});

	it("ChatGPT-import summarizer: still temperature 0.2", async () => {
		fetchMock.mockImplementation(async () => chatCompletion("Összefoglaló."));
		await summarizeConversation(
			[{ role: "user", content: HU_USER }],
			"Heti étrend",
		);
		expect(wire()).toEqual({ temperature: 0.2 });
	});

	it("rail summary: the control transport's flat 0.1", async () => {
		await persistAssistantRailSummary({
			userId: "u1",
			conversationId: "c1",
			assistantMessageId: "m1",
			userMessage: HU_USER,
			assistantResponse: HU_REPLY,
		});
		expect(wire()).toEqual({ temperature: 0.1 });
	});

	it("chat turn (plain run): nothing at all, as before", async () => {
		await runPlainNormalChatModelRun({
			provider: {
				id: "p1",
				name: "cloud",
				displayName: "Cloud GPT",
				baseUrl: CLOUD_URL,
				modelName: "gpt-4.1",
				apiKey: "",
			},
			messages: [{ role: "user", content: [{ type: "text", text: HU_USER }] }],
			fetch: fetchMock as typeof fetch,
		}).catch(() => null);
		expect(wire()).toEqual({});
	});
});
