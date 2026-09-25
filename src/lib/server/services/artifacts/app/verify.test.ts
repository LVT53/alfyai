import { beforeEach, describe, expect, it, vi } from "vitest";

const sendJsonControlMessage = vi.fn();
vi.mock("$lib/server/services/normal-chat-control-model", () => ({
	sendJsonControlMessage: (
		message: unknown,
		modelId: unknown,
		options: unknown,
	) => sendJsonControlMessage(message, modelId, options),
}));

const resolveNormalChatModelRunProvider = vi.fn();
const runPlainNormalChatModelRun = vi.fn();
const buildNormalChatModelRunProviderOptions = vi.fn(
	(_provider?: unknown, _thinkingMode?: unknown) => ({
		"stub-provider": { enable_thinking: false },
	}),
);
vi.mock("$lib/server/services/normal-chat-model", () => ({
	resolveNormalChatModelRunProvider: (
		modelId: unknown,
		runtimeConfig: unknown,
	) => resolveNormalChatModelRunProvider(modelId, runtimeConfig),
	runPlainNormalChatModelRun: (params: unknown) =>
		runPlainNormalChatModelRun(params),
	buildNormalChatModelRunProviderOptions: (
		provider: unknown,
		thinkingMode: unknown,
	) => buildNormalChatModelRunProviderOptions(provider, thinkingMode),
}));

const createNormalChatTools = vi.fn(
	(_ctx?: unknown): { tools: { research_web: unknown } } => ({
		tools: { research_web: undefined },
	}),
);
vi.mock("$lib/server/services/normal-chat-tools", () => ({
	createNormalChatTools: (ctx: unknown) => createNormalChatTools(ctx),
}));

const recordControlModelUsage = vi.fn().mockResolvedValue(undefined);
vi.mock("$lib/server/services/analytics", () => ({
	recordControlModelUsage: (params: unknown) => recordControlModelUsage(params),
}));

let parallelApiKey = "";
vi.mock("$lib/server/config-store", () => ({
	getConfig: () => ({ parallelApiKey }),
}));

const { verifyApp } = await import("./verify");

const PROVIDER = {
	id: "provider-1",
	name: "stub-provider",
	displayName: "Stub Model",
	baseUrl: "http://127.0.0.1:30000/v1",
	modelName: "qwen3-6-27b",
	apiKey: "test-key",
};

function classifierUsage() {
	return { promptTokens: 50, completionTokens: 10, totalTokens: 60 };
}

function verifierResult(
	text: string,
	overrides: Partial<{ usage: Record<string, number> }> = {},
) {
	return {
		text,
		finishReason: "stop",
		usage: overrides.usage ?? {
			promptTokens: 500,
			completionTokens: 100,
			totalTokens: 600,
		},
		model: {
			modelId: "provider-1",
			providerId: "provider-1",
			providerName: "stub-provider",
			displayName: "Stub Model",
			requestedModelName: "qwen3-6-27b",
			responseModelName: "qwen3-6-27b",
		},
	};
}

function fenceJson(payload: unknown): string {
	return `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
}

function baseParams(overrides: Partial<Parameters<typeof verifyApp>[0]> = {}) {
	return {
		userId: "user-1",
		conversationId: "conv-1",
		html: "<html><body>an app</body></html>",
		prompt: "Make me a Danube capitals quiz",
		language: "en" as const,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	parallelApiKey = "";
	resolveNormalChatModelRunProvider.mockResolvedValue(PROVIDER);
	createNormalChatTools.mockReturnValue({ tools: { research_web: undefined } });
});

describe("verifyApp — the classifier gate", () => {
	it("costs zero verifier calls for a non-checkable app (a timer)", async () => {
		sendJsonControlMessage.mockResolvedValue({
			text: JSON.stringify({ checkable: false, kinds: [] }),
			rawResponse: {},
			modelId: "model2",
			modelDisplayName: "Model 2",
			usage: classifierUsage(),
		});

		const result = await verifyApp(baseParams());

		expect(result.checked).toBe(false);
		expect(sendJsonControlMessage).toHaveBeenCalledTimes(1);
		expect(runPlainNormalChatModelRun).not.toHaveBeenCalled();
	});

	it("passes thinking:'off' to the classifier call", async () => {
		sendJsonControlMessage.mockResolvedValue({
			text: JSON.stringify({ checkable: false, kinds: [] }),
			rawResponse: {},
			modelId: "model2",
			modelDisplayName: "Model 2",
			usage: classifierUsage(),
		});

		await verifyApp(baseParams());

		const [, modelId, options] = sendJsonControlMessage.mock.calls[0];
		expect(modelId).toBe("model2");
		expect((options as { thinkingMode?: string }).thinkingMode).toBe("off");
	});
});

describe("verifyApp — the three prototype bug classes", () => {
	it("flags mislabelled_aggregate (a cumulative table labelled per-year)", async () => {
		sendJsonControlMessage.mockResolvedValue({
			text: JSON.stringify({ checkable: true, kinds: ["table"] }),
			rawResponse: {},
			modelId: "model2",
			modelDisplayName: "Model 2",
			usage: classifierUsage(),
		});
		runPlainNormalChatModelRun.mockResolvedValue(
			verifierResult(
				fenceJson({
					findings: [
						{
							claim: "Year 3: 45,000 Ft",
							problem:
								"The column is labelled per-year but the value is the running cumulative total.",
							class: "mislabelled_aggregate",
							location: "Yearly total column",
							settled: true,
						},
					],
					repairedHtml: null,
					repairSafe: false,
				}),
			),
		);

		const result = await verifyApp(baseParams());

		expect(result.checked).toBe(true);
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0].class).toBe("mislabelled_aggregate");
	});

	it("flags wrong_unit (a plural gloss among singulars)", async () => {
		sendJsonControlMessage.mockResolvedValue({
			text: JSON.stringify({ checkable: true, kinds: ["named_facts"] }),
			rawResponse: {},
			modelId: "model2",
			modelDisplayName: "Model 2",
			usage: classifierUsage(),
		});
		runPlainNormalChatModelRun.mockResolvedValue(
			verifierResult(
				fenceJson({
					findings: [
						{
							claim: "béka (frog, singular) among plural nouns",
							problem:
								"The Hungarian gloss is singular where its neighbours are plural.",
							class: "wrong_unit",
							location: "Flashcard 4",
							settled: true,
						},
					],
					repairedHtml: null,
					repairSafe: false,
				}),
			),
		);

		const result = await verifyApp(baseParams({ language: "hu" }));

		expect(result.findings[0].class).toBe("wrong_unit");
	});

	it("flags wrong_key (a quiz answer key naming a city not on the Danube)", async () => {
		sendJsonControlMessage.mockResolvedValue({
			text: JSON.stringify({ checkable: true, kinds: ["answer_key"] }),
			rawResponse: {},
			modelId: "model2",
			modelDisplayName: "Model 2",
			usage: classifierUsage(),
		});
		runPlainNormalChatModelRun.mockResolvedValue(
			verifierResult(
				fenceJson({
					findings: [
						{
							claim: "Correct answer: Bucharest",
							problem:
								"Bucharest is not on the Danube; Budapest is the easternmost Danube capital asked for.",
							class: "wrong_key",
							location: "Question 3",
							settled: true,
						},
					],
					repairedHtml: null,
					repairSafe: false,
				}),
			),
		);

		const result = await verifyApp(baseParams());

		expect(result.findings[0].class).toBe("wrong_key");
	});
});

describe("verifyApp — clean and repaired", () => {
	it("is clean with no findings, and reports the verification call's usage", async () => {
		sendJsonControlMessage.mockResolvedValue({
			text: JSON.stringify({ checkable: true, kinds: ["computed_numbers"] }),
			rawResponse: {},
			modelId: "model2",
			modelDisplayName: "Model 2",
			usage: classifierUsage(),
		});
		runPlainNormalChatModelRun.mockResolvedValue(
			verifierResult(
				fenceJson({ findings: [], repairedHtml: null, repairSafe: false }),
			),
		);

		const result = await verifyApp(baseParams());

		expect(result.verdict).toBe("clean");
		expect(result.findings).toEqual([]);
		expect(result.usage).not.toBeNull();
		expect(result.usage?.totalTokens).toBeGreaterThan(0);
	});

	it("repairs once when the model is sure and the repair is safe", async () => {
		sendJsonControlMessage.mockResolvedValue({
			text: JSON.stringify({ checkable: true, kinds: ["computed_numbers"] }),
			rawResponse: {},
			modelId: "model2",
			modelDisplayName: "Model 2",
			usage: classifierUsage(),
		});
		const repaired = "<html><body>fixed total</body></html>";
		runPlainNormalChatModelRun.mockResolvedValue(
			verifierResult(
				fenceJson({
					findings: [
						{
							claim: "Total: 900",
							problem:
								"The displayed total does not match the sum of the rows (should be 950).",
							class: "other",
							location: "Total row",
							settled: true,
						},
					],
					repairedHtml: repaired,
					repairSafe: true,
				}),
			),
		);

		const result = await verifyApp(baseParams());

		expect(result.verdict).toBe("repaired");
		expect(result.repairedHtml).toBe(repaired);
		expect(result.repairedHtml).not.toBe(baseParams().html);
		expect(result.findings).toHaveLength(1);
	});

	it("a repair that would introduce a new, unverified claim is uncertain with the ORIGINAL html, never clean", async () => {
		sendJsonControlMessage.mockResolvedValue({
			text: JSON.stringify({ checkable: true, kinds: ["computed_numbers"] }),
			rawResponse: {},
			modelId: "model2",
			modelDisplayName: "Model 2",
			usage: classifierUsage(),
		});
		runPlainNormalChatModelRun.mockResolvedValue(
			verifierResult(
				fenceJson({
					findings: [
						{
							claim: "Total: 900",
							problem:
								"The total looks wrong but a confident fix would need an unverified extra fee assumption.",
							class: "other",
							location: "Total row",
							settled: true,
						},
					],
					repairedHtml: "<html>a guess with a new claim</html>",
					// The model itself flags this repair as unsafe.
					repairSafe: false,
				}),
			),
		);

		const result = await verifyApp(baseParams());

		expect(result.verdict).toBe("uncertain");
		expect(result.repairedHtml).toBeNull();
	});
});

describe("verifyApp — degrades honestly when it cannot settle a claim", () => {
	it("is unavailable, not clean, when a real-world claim needs research_web and it is not configured", async () => {
		parallelApiKey = "";
		sendJsonControlMessage.mockResolvedValue({
			text: JSON.stringify({ checkable: true, kinds: ["named_facts"] }),
			rawResponse: {},
			modelId: "model2",
			modelDisplayName: "Model 2",
			usage: classifierUsage(),
		});
		runPlainNormalChatModelRun.mockResolvedValue(
			verifierResult(
				fenceJson({
					findings: [
						{
							claim: "Vienna is the capital of Hungary",
							problem: "Could not settle this without web research.",
							class: "other",
							location: null,
							settled: false,
						},
					],
					repairedHtml: null,
					repairSafe: false,
				}),
			),
		);

		const result = await verifyApp(baseParams());

		expect(result.verdict).toBe("unavailable");
		expect(result.reason).not.toBeNull();
	});

	it("is unavailable when the verifier call itself fails, never clean", async () => {
		sendJsonControlMessage.mockResolvedValue({
			text: JSON.stringify({ checkable: true, kinds: ["computed_numbers"] }),
			rawResponse: {},
			modelId: "model2",
			modelDisplayName: "Model 2",
			usage: classifierUsage(),
		});
		runPlainNormalChatModelRun.mockRejectedValue(
			new Error("upstream timed out"),
		);

		const result = await verifyApp(baseParams());

		expect(result.verdict).toBe("unavailable");
		expect(result.reason).toContain("upstream timed out");
	});

	it("is unavailable when the classifier call itself fails, never clean", async () => {
		sendJsonControlMessage.mockRejectedValue(
			new Error("control model unreachable"),
		);

		const result = await verifyApp(baseParams());

		expect(result.verdict).toBe("unavailable");
		expect(runPlainNormalChatModelRun).not.toHaveBeenCalled();
	});
});

describe("verifyApp — the prompt carries the request and the html only", () => {
	it("sends exactly one user message with the prompt and the html, nothing else from the session", async () => {
		sendJsonControlMessage.mockResolvedValue({
			text: JSON.stringify({ checkable: true, kinds: ["computed_numbers"] }),
			rawResponse: {},
			modelId: "model2",
			modelDisplayName: "Model 2",
			usage: classifierUsage(),
		});
		runPlainNormalChatModelRun.mockResolvedValue(
			verifierResult(
				fenceJson({ findings: [], repairedHtml: null, repairSafe: false }),
			),
		);

		await verifyApp(baseParams({ prompt: "Build a HUF loan calculator" }));

		const runArgs = runPlainNormalChatModelRun.mock.calls[0][0];
		expect(runArgs.messages).toHaveLength(1);
		expect(runArgs.messages[0].role).toBe("user");
		expect(runArgs.messages[0].content).toContain(
			"Build a HUF loan calculator",
		);
		expect(runArgs.messages[0].content).toContain("an app");
	});

	it("gives the verifier the research_web tool only when Parallel is configured", async () => {
		parallelApiKey = "test-parallel-key";
		createNormalChatTools.mockReturnValue({
			tools: { research_web: { description: "stub" } },
		});
		sendJsonControlMessage.mockResolvedValue({
			text: JSON.stringify({ checkable: true, kinds: ["named_facts"] }),
			rawResponse: {},
			modelId: "model2",
			modelDisplayName: "Model 2",
			usage: classifierUsage(),
		});
		runPlainNormalChatModelRun.mockResolvedValue(
			verifierResult(
				fenceJson({ findings: [], repairedHtml: null, repairSafe: false }),
			),
		);

		await verifyApp(baseParams());

		const runArgs = runPlainNormalChatModelRun.mock.calls[0][0];
		expect(runArgs.tools).toBeDefined();
		expect(Object.keys(runArgs.tools)).toEqual(["research_web"]);
	});
});
