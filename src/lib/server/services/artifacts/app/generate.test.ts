import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	NormalChatModelRunProvider,
	StreamingNormalChatModelRunEvent,
} from "$lib/server/services/normal-chat-model";

const resolveNormalChatModelRunProvider = vi.fn();
const buildNormalChatModelRunProviderOptions = vi.fn(
	(_provider?: unknown, _thinkingMode?: unknown) => ({
		"stub-provider": { enable_thinking: false },
	}),
);
const runStreamingNormalChatModelRun = vi.fn();
const mapNormalChatModelRunUsageToProviderSnapshot = vi.fn((usage) => ({
	promptTokens: usage.inputTokens,
	completionTokens: usage.outputTokens,
	totalTokens: usage.totalTokens,
	cachedInputTokens: usage.cachedInputTokens,
	cacheHitTokens: usage.cacheHitTokens,
	cacheMissTokens: usage.cacheMissTokens,
}));

vi.mock("$lib/server/services/normal-chat-model", () => ({
	resolveNormalChatModelRunProvider: (
		modelId: unknown,
		runtimeConfig: unknown,
	) => resolveNormalChatModelRunProvider(modelId, runtimeConfig),
	buildNormalChatModelRunProviderOptions: (
		provider: unknown,
		thinkingMode: unknown,
	) => buildNormalChatModelRunProviderOptions(provider, thinkingMode),
	runStreamingNormalChatModelRun: (params: unknown) =>
		runStreamingNormalChatModelRun(params),
	mapNormalChatModelRunUsageToProviderSnapshot: (usage: unknown) =>
		mapNormalChatModelRunUsageToProviderSnapshot(usage),
}));

const recordControlModelUsage = vi.fn().mockResolvedValue(undefined);
vi.mock("$lib/server/services/analytics", () => ({
	recordControlModelUsage: (params: unknown) => recordControlModelUsage(params),
}));

vi.mock("$lib/server/config-store", () => ({
	getConfig: () => ({}),
}));

const createArtifact = vi.fn();
vi.mock("$lib/server/services/artifacts", () => ({
	createArtifact: (params: unknown) => createArtifact(params),
}));

const {
	generateApp,
	APP_THINKING_MODE,
	APP_MAX_ATTEMPTS,
	extractAppHtml,
	classifyAppExtractionFailure,
} = await import("./generate");
const { APP_CONTRACT_PROMPT } = await import("./contract");

const PROVIDER: NormalChatModelRunProvider = {
	id: "provider-1",
	name: "stub-provider",
	displayName: "Stub Model",
	baseUrl: "http://127.0.0.1:30000/v1",
	modelName: "qwen3-6-27b",
	apiKey: "test-key",
};

function fenceEvents(
	html: string,
	overrides: Partial<{
		finishReason: string;
		usage: Record<string, number>;
	}> = {},
): StreamingNormalChatModelRunEvent[] {
	return [
		{ type: "text_delta", text: "```html\n" },
		{ type: "text_delta", text: html },
		{ type: "text_delta", text: "\n```" },
		{
			type: "usage",
			usage: {
				inputTokens: overrides.usage?.inputTokens ?? 100,
				outputTokens: overrides.usage?.outputTokens ?? 200,
				totalTokens: overrides.usage?.totalTokens ?? 300,
			},
		},
		{
			type: "finish",
			finishReason: (overrides.finishReason as never) ?? "stop",
			rawFinishReason: overrides.finishReason ?? "stop",
			model: {
				modelId: "provider-1",
				providerId: "provider-1",
				providerName: "stub-provider",
				displayName: "Stub Model",
				requestedModelName: "qwen3-6-27b",
				responseModelName: "qwen3-6-27b",
			},
		},
	];
}

async function* asAsyncIterable(
	events: StreamingNormalChatModelRunEvent[],
): AsyncIterable<StreamingNormalChatModelRunEvent> {
	for (const event of events) yield event;
}

const MINIMAL_APP_HTML =
	"<!doctype html><html><head><title>Trip cost splitter</title></head><body><h1>Trip cost splitter</h1></body></html>";

beforeEach(() => {
	vi.clearAllMocks();
	resolveNormalChatModelRunProvider.mockResolvedValue(PROVIDER);
	buildNormalChatModelRunProviderOptions.mockImplementation(() => ({
		"stub-provider": { enable_thinking: false },
	}));
});

function baseRequest(
	overrides: Partial<Parameters<typeof generateApp>[0]> = {},
) {
	return {
		userId: "user-1",
		conversationId: "conv-1",
		prompt: "Make me a cost splitter for the Vienna trip",
		language: "en" as const,
		...overrides,
	};
}

describe("generateApp — thinking off, for real", () => {
	it("passes APP_THINKING_MODE ('off') to buildNormalChatModelRunProviderOptions even though nothing about the call carries the turn's own thinking setting", async () => {
		runStreamingNormalChatModelRun.mockImplementation(() =>
			asAsyncIterable(fenceEvents(MINIMAL_APP_HTML)),
		);

		await generateApp(baseRequest());

		const runArgs = runStreamingNormalChatModelRun.mock.calls[0][0];
		expect(typeof runArgs.resolveProviderOptions).toBe("function");
		runArgs.resolveProviderOptions(PROVIDER);
		expect(buildNormalChatModelRunProviderOptions).toHaveBeenCalledWith(
			PROVIDER,
			APP_THINKING_MODE,
		);
		expect(APP_THINKING_MODE).toBe("off");
	});

	it("reaches the wire as chat_template_kwargs.enable_thinking = false for a qwen-shaped provider — the REAL provider-compatibility functions, not a stub", async () => {
		const {
			buildNormalChatModelRunCompatibilityProviderOptions,
			transformNormalChatModelRunRequestBody,
		} = await vi.importActual<
			typeof import("$lib/server/services/normal-chat-model/provider-compatibility")
		>("$lib/server/services/normal-chat-model/provider-compatibility");

		const qwenProvider = {
			id: "p1",
			name: "local-qwen",
			displayName: "Local Qwen",
			baseUrl: "http://127.0.0.1:30000/v1",
			modelName: "qwen3-6-27b",
			apiKey: "x",
		} as never;

		const providerOptions = buildNormalChatModelRunCompatibilityProviderOptions(
			qwenProvider,
			APP_THINKING_MODE,
		);
		expect(providerOptions).toEqual({ enable_thinking: false });

		// This is what the AI SDK's openai-compatible provider does with a
		// call's providerOptions[provider.name] entry: merge it into the
		// outbound body before transformRequestBody runs.
		const wireBody = transformNormalChatModelRunRequestBody(
			{ model: "qwen3-6-27b", messages: [], ...providerOptions },
			qwenProvider,
		);

		expect(wireBody.chat_template_kwargs).toMatchObject({
			enable_thinking: false,
		});
	});
});

describe("generateApp — sampling", () => {
	it("caps maxOutputTokens at the provider's own lower ceiling", async () => {
		resolveNormalChatModelRunProvider.mockResolvedValue({
			...PROVIDER,
			maxOutputTokens: 1000,
		});
		runStreamingNormalChatModelRun.mockImplementation(() =>
			asAsyncIterable(fenceEvents(MINIMAL_APP_HTML)),
		);

		await generateApp(baseRequest());

		expect(
			runStreamingNormalChatModelRun.mock.calls[0][0].maxOutputTokens,
		).toBe(1000);
	});

	it("uses the contract's 24000 ceiling when the provider allows more", async () => {
		resolveNormalChatModelRunProvider.mockResolvedValue({
			...PROVIDER,
			maxOutputTokens: 100_000,
		});
		runStreamingNormalChatModelRun.mockImplementation(() =>
			asAsyncIterable(fenceEvents(MINIMAL_APP_HTML)),
		);

		await generateApp(baseRequest());

		expect(
			runStreamingNormalChatModelRun.mock.calls[0][0].maxOutputTokens,
		).toBe(24_000);
	});

	it("adds no sampling parameter of its own to the run params", async () => {
		runStreamingNormalChatModelRun.mockImplementation(() =>
			asAsyncIterable(fenceEvents(MINIMAL_APP_HTML)),
		);

		await generateApp(baseRequest());

		const runArgs = runStreamingNormalChatModelRun.mock.calls[0][0];
		expect(runArgs).not.toHaveProperty("temperature");
		expect(runArgs).not.toHaveProperty("topP");
		expect(runArgs).not.toHaveProperty("topK");
		expect(runArgs).not.toHaveProperty("providerOptions");
	});

	it("retries once, with the identical call, when the endpoint rejects top_k", async () => {
		runStreamingNormalChatModelRun
			.mockImplementationOnce(() => {
				throw new Error("400 Bad Request: unrecognized field top_k");
			})
			.mockReturnValueOnce(asAsyncIterable(fenceEvents(MINIMAL_APP_HTML)));

		const result = await generateApp(baseRequest());

		expect(result.ok).toBe(true);
		expect(runStreamingNormalChatModelRun).toHaveBeenCalledTimes(2);
		if (result.ok) {
			// The top_k compatibility retry is not a content-quality attempt.
			expect(result.attempts).toBe(1);
			expect(result.warnings.join(" ")).toMatch(/top_k/);
		}
	});
});

describe("generateApp — extraction", () => {
	it("extracts a clean one-fence answer", async () => {
		runStreamingNormalChatModelRun.mockImplementation(() =>
			asAsyncIterable(fenceEvents(MINIMAL_APP_HTML)),
		);

		const result = await generateApp(baseRequest());

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.html).toBe(MINIMAL_APP_HTML);
			expect(result.extraction).toBe("fence");
			expect(result.fences).toBe(1);
			expect(result.title).toBe("Trip cost splitter");
			expect(result.checks.length).toBe(19);
		}
	});

	it("still extracts the fence when the model wrote prose before and after it, and records a warning", async () => {
		const events: StreamingNormalChatModelRunEvent[] = [
			{ type: "text_delta", text: "Sure, here you go:\n\n```html\n" },
			{ type: "text_delta", text: MINIMAL_APP_HTML },
			{ type: "text_delta", text: "\n```\n\nEnjoy the app!" },
			{
				type: "usage",
				usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
			},
			{
				type: "finish",
				finishReason: "stop" as never,
				rawFinishReason: "stop",
				model: {
					modelId: "provider-1",
					providerId: "provider-1",
					providerName: "stub-provider",
					displayName: "Stub Model",
					requestedModelName: "qwen3-6-27b",
					responseModelName: "qwen3-6-27b",
				},
			},
		];
		runStreamingNormalChatModelRun.mockImplementation(() =>
			asAsyncIterable(events),
		);

		const result = await generateApp(baseRequest());

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.html).toBe(MINIMAL_APP_HTML);
			expect(result.extraction).toBe("fence");
			expect(result.fences).toBe(1);
			expect(result.warnings.join(" ")).toMatch(/prose outside the fence/);
		}
	});

	it("fails as no_fence after the retry when the answer never contains a fence", async () => {
		runStreamingNormalChatModelRun.mockImplementation(() =>
			asAsyncIterable([
				{ type: "text_delta", text: "I cannot make an app for that." },
				{
					type: "usage",
					usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
				},
				{
					type: "finish",
					finishReason: "stop" as never,
					rawFinishReason: "stop",
					model: {
						modelId: "provider-1",
						providerId: "provider-1",
						providerName: "stub-provider",
						displayName: "Stub Model",
						requestedModelName: "qwen3-6-27b",
						responseModelName: "qwen3-6-27b",
					},
				},
			]),
		);

		const result = await generateApp(baseRequest());

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("no_fence");
			expect(result.attempts).toBe(APP_MAX_ATTEMPTS);
		}
		expect(runStreamingNormalChatModelRun).toHaveBeenCalledTimes(
			APP_MAX_ATTEMPTS,
		);
	});

	it("does not accept a whole document recovered WITHOUT a fence — that is a no_fence failure, never a success", async () => {
		const wholeDocument = `<!doctype html><html><head><title>Recovered</title></head><body>${MINIMAL_APP_HTML}</body></html>`;
		runStreamingNormalChatModelRun.mockImplementation(() =>
			asAsyncIterable([
				{ type: "text_delta", text: wholeDocument },
				{
					type: "usage",
					usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
				},
				{
					type: "finish",
					finishReason: "stop" as never,
					rawFinishReason: "stop",
					model: {
						modelId: "provider-1",
						providerId: "provider-1",
						providerName: "stub-provider",
						displayName: "Stub Model",
						requestedModelName: "qwen3-6-27b",
						responseModelName: "qwen3-6-27b",
					},
				},
			]),
		);

		const result = await generateApp(baseRequest());

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("no_fence");
	});

	it("an empty fence is empty_content after the retry", async () => {
		runStreamingNormalChatModelRun.mockImplementation(() =>
			asAsyncIterable([
				{ type: "text_delta", text: "```html\n```" },
				{
					type: "usage",
					usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
				},
				{
					type: "finish",
					finishReason: "stop" as never,
					rawFinishReason: "stop",
					model: {
						modelId: "provider-1",
						providerId: "provider-1",
						providerName: "stub-provider",
						displayName: "Stub Model",
						requestedModelName: "qwen3-6-27b",
						responseModelName: "qwen3-6-27b",
					},
				},
			]),
		);

		const result = await generateApp(baseRequest());

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("empty_content");
	});
});

describe("generateApp — the agentic reflex", () => {
	it("retries exactly once on a tool_call event, then fails as tool_call on the second", async () => {
		const toolCallEvents: StreamingNormalChatModelRunEvent[] = [
			{
				type: "tool_call",
				callId: "call-1",
				toolName: "explore",
				input: {},
			},
			{
				type: "usage",
				usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
			},
			{
				type: "finish",
				finishReason: "tool-calls" as never,
				rawFinishReason: "tool_calls",
				model: {
					modelId: "provider-1",
					providerId: "provider-1",
					providerName: "stub-provider",
					displayName: "Stub Model",
					requestedModelName: "qwen3-6-27b",
					responseModelName: "qwen3-6-27b",
				},
			},
		];
		runStreamingNormalChatModelRun.mockImplementation(() =>
			asAsyncIterable(toolCallEvents),
		);

		const result = await generateApp(baseRequest());

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("tool_call");
			expect(result.attempts).toBe(2);
		}
		expect(runStreamingNormalChatModelRun).toHaveBeenCalledTimes(2);
	});
});

describe("generateApp — finish_reason=length", () => {
	it("does not accept a length-truncated partial answer, and reports too_long after the retry repeats it", async () => {
		runStreamingNormalChatModelRun.mockImplementation(() =>
			asAsyncIterable([
				{ type: "text_delta", text: "```html\n<!doctype html><html><body>" },
				{
					type: "usage",
					usage: { inputTokens: 5, outputTokens: 24_000, totalTokens: 24_005 },
				},
				{
					type: "finish",
					finishReason: "length" as never,
					rawFinishReason: "length",
					model: {
						modelId: "provider-1",
						providerId: "provider-1",
						providerName: "stub-provider",
						displayName: "Stub Model",
						requestedModelName: "qwen3-6-27b",
						responseModelName: "qwen3-6-27b",
					},
				},
			]),
		);

		const result = await generateApp(baseRequest());

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("too_long");
			expect(result.attempts).toBe(APP_MAX_ATTEMPTS);
		}
		expect(runStreamingNormalChatModelRun).toHaveBeenCalledTimes(
			APP_MAX_ATTEMPTS,
		);
	});
});

describe("generateApp — the prompt is the whole session", () => {
	it("sends APP_CONTRACT_PROMPT byte-identical as the system message, and one user message with no history", async () => {
		runStreamingNormalChatModelRun.mockImplementation(() =>
			asAsyncIterable(fenceEvents(MINIMAL_APP_HTML)),
		);

		await generateApp(baseRequest({ prompt: "Build me a pomodoro timer" }));

		const runArgs = runStreamingNormalChatModelRun.mock.calls[0][0];
		expect(runArgs.system).toBe(APP_CONTRACT_PROMPT);
		expect(runArgs.messages).toHaveLength(1);
		expect(runArgs.messages[0]).toEqual({
			role: "user",
			content: expect.stringContaining("Build me a pomodoro timer"),
		});
		expect(runArgs.messages[0].content).toContain("English");
	});

	it("writes the language instruction in Hungarian for a Hungarian request", async () => {
		runStreamingNormalChatModelRun.mockImplementation(() =>
			asAsyncIterable(fenceEvents(MINIMAL_APP_HTML)),
		);

		await generateApp(
			baseRequest({ language: "hu", prompt: "Segíts egy bevásárlólistát" }),
		);

		const runArgs = runStreamingNormalChatModelRun.mock.calls[0][0];
		expect(runArgs.messages[0].content).toContain("Hungarian");
	});
});

describe("generateApp — never writes to the database", () => {
	it("never calls createArtifact", async () => {
		runStreamingNormalChatModelRun.mockImplementation(() =>
			asAsyncIterable(fenceEvents(MINIMAL_APP_HTML)),
		);

		await generateApp(baseRequest());

		expect(createArtifact).not.toHaveBeenCalled();
	});
});

describe("generateApp — cost", () => {
	it("records one model-run usage for the app_generation feature on success", async () => {
		runStreamingNormalChatModelRun.mockImplementation(() =>
			asAsyncIterable(
				fenceEvents(MINIMAL_APP_HTML, {
					usage: { inputTokens: 111, outputTokens: 222, totalTokens: 333 },
				}),
			),
		);

		await generateApp(baseRequest());

		expect(recordControlModelUsage).toHaveBeenCalledTimes(1);
		expect(recordControlModelUsage).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				conversationId: "conv-1",
				feature: "app_generation",
				promptTokens: 111,
				completionTokens: 222,
				totalTokens: 333,
			}),
		);
	});

	it("also records cost on a failed generation — the model still ran", async () => {
		runStreamingNormalChatModelRun.mockImplementation(() =>
			asAsyncIterable([
				{
					type: "usage",
					usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55 },
				},
				{
					type: "finish",
					finishReason: "stop" as never,
					rawFinishReason: "stop",
					model: {
						modelId: "provider-1",
						providerId: "provider-1",
						providerName: "stub-provider",
						displayName: "Stub Model",
						requestedModelName: "qwen3-6-27b",
						responseModelName: "qwen3-6-27b",
					},
				},
			]),
		);

		const result = await generateApp(baseRequest());

		expect(result.ok).toBe(false);
		expect(recordControlModelUsage).toHaveBeenCalled();
	});
});

// Ruling 58 (RV-2A's sandbox review): a violation-severity audit rule
// (self-navigation, WebRTC) retries once with the violation named, then
// refuses — never shipped, even as a glitch.
describe("generateApp — a contract violation retries once, then refuses (ruling 58)", () => {
	const VIOLATING_HTML =
		'<!doctype html><html><head><title>x</title></head><body><script>location.href = "https://exfiltrate.invalid";</script></body></html>';

	it("retries with the violation named when attempt 1 violates, and succeeds if attempt 2 is clean", async () => {
		runStreamingNormalChatModelRun
			.mockReturnValueOnce(asAsyncIterable(fenceEvents(VIOLATING_HTML)))
			.mockReturnValueOnce(asAsyncIterable(fenceEvents(MINIMAL_APP_HTML)));

		const result = await generateApp(baseRequest());

		expect(runStreamingNormalChatModelRun).toHaveBeenCalledTimes(2);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.html).toBe(MINIMAL_APP_HTML);
			expect(result.attempts).toBe(2);
			expect(result.warnings.join(" ")).toMatch(/contract violation/);
			expect(result.warnings.join(" ")).toMatch(/no-navigate/);
		}

		// The retry's own user message names the violation, still as a single
		// fresh turn (A1.6 — never chat history: exactly one message either way).
		const secondCallArgs = runStreamingNormalChatModelRun.mock.calls[1][0];
		expect(secondCallArgs.messages).toHaveLength(1);
		expect(secondCallArgs.messages[0].content).toMatch(
			/not allowed inside this app's sandboxed frame/,
		);
		expect(secondCallArgs.messages[0].content).toMatch(/no-navigate/);
	});

	it("refuses with contract_violation when both attempts violate, never shipping the html", async () => {
		runStreamingNormalChatModelRun.mockImplementation(() =>
			asAsyncIterable(fenceEvents(VIOLATING_HTML)),
		);

		const result = await generateApp(baseRequest());

		expect(runStreamingNormalChatModelRun).toHaveBeenCalledTimes(2);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("contract_violation");
			expect(result.detail).toMatch(/no-navigate/);
			expect(result.attempts).toBe(2);
		}
	});

	it("does not retry on a dialog or eval glitch — those ship as a card-line glitch, not a refusal", async () => {
		const glitchyHtml =
			'<!doctype html><html><head><title>x</title></head><body><button onclick="alert(1)">go</button></body></html>';
		runStreamingNormalChatModelRun.mockReturnValueOnce(
			asAsyncIterable(fenceEvents(glitchyHtml)),
		);

		const result = await generateApp(baseRequest());

		expect(runStreamingNormalChatModelRun).toHaveBeenCalledTimes(1);
		expect(result.ok).toBe(true);
		if (result.ok) {
			const dialogsCheck = result.checks.find((c) => c.rule === "no-dialogs");
			expect(dialogsCheck?.passed).toBe(false);
		}
	});
});

describe("extractAppHtml / classifyAppExtractionFailure — exported for the eval harness's scorer (A9)", () => {
	it("extracts the fenced html and classifies a successful fence as needing no failure reason", () => {
		const extraction = extractAppHtml(
			"```html\n<!doctype html><html><body>hi</body></html>\n```",
			"stop",
		);
		expect(extraction.ok).toBe(true);
		expect(extraction.strategy).toBe("fence");
	});

	it("classifies a blank fence as empty_content, matching generateApp's own policy", () => {
		const extraction = extractAppHtml("```html\n```", "stop");
		expect(classifyAppExtractionFailure(extraction)).toBe("empty_content");
	});

	it("classifies no fence, cut off by the token budget, as too_long", () => {
		const extraction = extractAppHtml("some partial prose, no fence", "length");
		expect(classifyAppExtractionFailure(extraction)).toBe("too_long");
	});

	it("classifies no fence and not truncated as no_fence, even when a whole document was recovered", () => {
		const extraction = extractAppHtml(
			"<!doctype html><html><body>no fence around this</body></html>",
			"stop",
		);
		expect(extraction.strategy).toBe("recovered-document");
		expect(classifyAppExtractionFailure(extraction)).toBe("no_fence");
	});
});
