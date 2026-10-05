import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every short answer a person reads (the title, the thought-step status line,
// the rail headline, the follow-up chips) and the turn acknowledgment ask the
// server for NO thinking. What matters is the form the server reads, and that
// was checked on the real vLLM v0.31 through /tokenize on the same message list:
//
//   body                                         rendered generation prompt ends with
//   (nothing)                                    "<think>\n"                 thinking on
//   chat_template_kwargs.enable_thinking=false   "<think>\n\n</think>\n\n"   thinking off
//   enable_thinking=false at the top level only  "<think>\n"                 ignored
//   extra_body.chat_template_kwargs only         "<think>\n"                 ignored
//
// So `chat_template_kwargs` is the one that counts, and it is what these tests
// read off the wire (through a fake `fetch`, never what the code seems to pass).
// The model still re-opens a think block now and then; short-local-text.ts's
// stripLeakedThinking is what deals with that.

const mocks = vi.hoisted(() => ({
	getConfig: vi.fn(),
	getProviderByName: vi.fn(),
	getProviderWithSecrets: vi.fn(),
	listEnabledProviderModels: vi.fn(),
	recordControlModelUsage: vi.fn(),
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
vi.mock("./messages", () => ({
	updateMessageRailSummary: mocks.updateMessageRailSummary,
}));
vi.mock("../prompts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../prompts")>();
	return { ...actual, getSystemPrompt: (prompt: string) => prompt };
});

import { generateFollowUpSuggestions } from "./chat-turn/follow-up-suggestions";
import { persistAssistantRailSummary } from "./chat-turn/rail-summary";
import { classifyThoughtStepChunk } from "./chat-turn/thought-step-classifier";
import { resolveTurnAcknowledgment } from "./chat-turn/turn-acknowledgment";
import { generateTitle } from "./title-generator";

const LOCAL_URL = "http://192.168.1.96:30000/v1";

function qwenConfig() {
	const model = {
		baseUrl: LOCAL_URL,
		apiKey: "",
		modelName: "qwen3-6-27b",
		displayName: "Local Qwen",
		maxTokens: 8192,
		reasoningEffort: null,
	};
	return {
		requestTimeoutMs: 300_000,
		model1: model,
		model2: model,
		titleGenUrl: LOCAL_URL,
		titleGenModel: "qwen3-6-27b",
		titleGenApiKey: "",
		titleGenSystemPromptEn: "",
		titleGenSystemPromptHu: "",
		titleGenSystemPromptCodeAppendixEn: "",
		titleGenSystemPromptCodeAppendixHu: "",
	};
}

let fetchMock: ReturnType<typeof vi.fn>;

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

/** The body of the first request that actually left. */
function sentBody(): Record<string, unknown> {
	const init = fetchMock.mock.calls[0]?.[1] as { body?: unknown } | undefined;
	expect(init, "no request reached the fake fetch").toBeDefined();
	return JSON.parse(String(init?.body ?? "{}"));
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
	mocks.updateMessageRailSummary.mockResolvedValue(undefined);
	fetchMock = vi.fn(async () => chatCompletion('{"ok":true}'));
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("short internal calls on a qwen-family model: thinking is off in the form the server reads", () => {
	it("title generation", async () => {
		fetchMock.mockImplementation(async () => chatCompletion("Heti étrend"));
		await generateTitle(HU_USER, HU_REPLY, "hu");
		expect(sentBody().chat_template_kwargs).toEqual({ enable_thinking: false });
	});

	it("thought-step classifier (the status line)", async () => {
		await classifyThoughtStepChunk({
			userId: "u1",
			conversationId: "c1",
			chunkText:
				"The user wants a weekly meal plan in Hungarian, so I should list dishes per day.",
			currentActivityClass: null,
			targetLanguage: "hu",
		});
		expect(sentBody().chat_template_kwargs).toEqual({ enable_thinking: false });
	});

	it("turn acknowledgment", async () => {
		await resolveTurnAcknowledgment({
			userId: "u1",
			conversationId: "c1",
			message: HU_USER,
		});
		expect(sentBody().chat_template_kwargs).toEqual({ enable_thinking: false });
	});

	it("rail summary", async () => {
		await persistAssistantRailSummary({
			userId: "u1",
			conversationId: "c1",
			assistantMessageId: "m1",
			userMessage: HU_USER,
			assistantResponse: HU_REPLY,
		});
		expect(sentBody().chat_template_kwargs).toEqual({ enable_thinking: false });
	});

	it("follow-up suggestions", async () => {
		await generateFollowUpSuggestions({
			userId: "u1",
			conversationId: "c1",
			userMessage: HU_USER,
			assistantResponse: HU_REPLY,
		});
		expect(sentBody().chat_template_kwargs).toEqual({ enable_thinking: false });
	});
});
