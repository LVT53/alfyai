import { beforeEach, describe, expect, it, vi } from "vitest";

// Both transport helpers reach the control model, the cost ledger, and the
// abort-signal composer through dynamic imports. Mock all three so the pure
// module can be exercised hermetically (no real vLLM, no DB, no heavy graph).
const sendJsonControlMessageMock = vi.fn();
vi.mock("../normal-chat-control-model", () => ({
	sendJsonControlMessage: sendJsonControlMessageMock,
}));

const recordControlModelUsageMock = vi.fn(async () => {});
vi.mock("../analytics", () => ({
	recordControlModelUsage: recordControlModelUsageMock,
}));

vi.mock("./shared-normal-chat-model-run-helpers", () => ({
	createRequestAbortSignal: (timeoutMs: number, signal?: AbortSignal) =>
		signal ?? (timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined),
}));

import {
	callShortLocalControlModel,
	generateShortLocalText,
	isHungarianText,
	isPlausibleShortText,
	isReasoningLeak,
	resolveShortTextLanguage,
} from "./short-local-text";

function controlResult(overrides: {
	text: string;
	modelId?: string;
	modelDisplayName?: string;
	usage?: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
	};
}) {
	return {
		text: overrides.text,
		rawResponse: null,
		modelId: overrides.modelId ?? "model2",
		modelDisplayName: overrides.modelDisplayName ?? "Model Two",
		usage: overrides.usage ?? {
			promptTokens: 10,
			completionTokens: 5,
			totalTokens: 15,
		},
	};
}

describe("isReasoningLeak", () => {
	it("flags leaked reasoning preambles", () => {
		for (const text of [
			"Here's a thinking process: 1. **Analyze User Input**",
			"Let me think about this problem",
			"Let me work through this step by step",
			"Okay, let me work through the summary",
			"First, let me analyze the request",
			"The user is asking about deployment",
			"This looks like a bug report",
		]) {
			expect(isReasoningLeak(text)).toBe(true);
		}
	});

	it("does not flag genuine short titles", () => {
		for (const text of [
			"React Component Basics",
			"How to Create React Components",
			"Debugging a JavaScript Undefined Error",
		]) {
			expect(isReasoningLeak(text)).toBe(false);
		}
	});
});

describe("isPlausibleShortText", () => {
	it("rejects empty, over-long, over-wordy, and leaked text (title-parity defaults)", () => {
		expect(isPlausibleShortText("")).toBe(false);
		expect(isPlausibleShortText("   ")).toBe(false);
		expect(isPlausibleShortText("x".repeat(101))).toBe(false);
		expect(isPlausibleShortText(Array(13).fill("w").join(" "))).toBe(false);
		expect(isPlausibleShortText("Let me think about this")).toBe(false);
	});

	it("accepts a normal short line", () => {
		expect(isPlausibleShortText("A Perfectly Fine Title")).toBe(true);
		expect(isPlausibleShortText("x".repeat(100))).toBe(true);
		expect(isPlausibleShortText(Array(12).fill("w").join(" "))).toBe(true);
	});

	it("honors custom bounds and rejectReasoningLeak=false", () => {
		expect(isPlausibleShortText("one two three", { maxWords: 2 })).toBe(false);
		expect(isPlausibleShortText("short", { maxChars: 3 })).toBe(false);
		expect(
			isPlausibleShortText("Let me think about it", {
				rejectReasoningLeak: false,
			}),
		).toBe(true);
	});
});

describe("resolveShortTextLanguage", () => {
	it("prefers an explicit preference over everything else", () => {
		expect(resolveShortTextLanguage("bármi magyar szöveg", "en")).toBe("en");
		expect(resolveShortTextLanguage("a plain english sentence", "hu")).toBe(
			"hu",
		);
	});

	it("honors inline language hints", () => {
		expect(resolveShortTextLanguage("Please answer in English")).toBe("en");
		expect(resolveShortTextLanguage("Summarize in english please")).toBe("en");
		expect(resolveShortTextLanguage("Kérlek válaszolj magyarul")).toBe("hu");
	});

	it("falls back to language detection", () => {
		expect(resolveShortTextLanguage("Egy magyar mondat és kérdés")).toBe("hu");
		expect(
			resolveShortTextLanguage("A short note about deployment steps"),
		).toBe("en");
	});
});

describe("isHungarianText", () => {
	it("detects Hungarian by accented characters", () => {
		expect(isHungarianText("Magyar cím")).toBe(true);
		expect(isHungarianText("Adatbázis tervezési tanácsok")).toBe(true);
	});

	it("detects Hungarian by strong function words without accents", () => {
		expect(isHungarianText("nem van meg")).toBe(true);
	});

	it("treats plain English as non-Hungarian", () => {
		expect(isHungarianText("How to Create React Components")).toBe(false);
		expect(isHungarianText("Practical Database Design Advice")).toBe(false);
	});
});

describe("callShortLocalControlModel", () => {
	beforeEach(() => {
		sendJsonControlMessageMock.mockReset();
		recordControlModelUsageMock.mockClear();
	});

	it("calls the control model and records spend via the shared cost path", async () => {
		sendJsonControlMessageMock.mockResolvedValue(
			controlResult({
				text: '{"intentClass":"chat"}',
				usage: { promptTokens: 40, completionTokens: 12, totalTokens: 52 },
			}),
		);

		const result = await callShortLocalControlModel({
			message: "hello there",
			feature: "unit_feature",
			userId: "u1",
			conversationId: "c1",
			systemPrompt: "classify this",
			thinkingMode: "off",
			temperature: 0,
			maxTokens: 150,
			timeoutMs: 800,
		});

		expect(result?.text).toBe('{"intentClass":"chat"}');

		const [message, modelId, options] = sendJsonControlMessageMock.mock
			.calls[0] as [
			string,
			string,
			{ thinkingMode?: string; temperature?: number; signal?: AbortSignal },
		];
		expect(message).toBe("hello there");
		expect(modelId).toBe("model2");
		expect(options.thinkingMode).toBe("off");
		expect(options.temperature).toBe(0);
		expect(options.signal).toBeInstanceOf(AbortSignal);

		expect(recordControlModelUsageMock).toHaveBeenCalledWith(
			expect.objectContaining({
				feature: "unit_feature",
				userId: "u1",
				conversationId: "c1",
				modelId: "model2",
				promptTokens: 40,
				completionTokens: 12,
				totalTokens: 52,
			}),
		);
	});

	it("returns null and records no spend when the control call rejects", async () => {
		sendJsonControlMessageMock.mockRejectedValue(new Error("upstream timeout"));

		const result = await callShortLocalControlModel({
			message: "hello there",
			feature: "unit_feature",
			userId: "u1",
			conversationId: "c1",
			systemPrompt: "classify this",
		});

		expect(result).toBeNull();
		expect(recordControlModelUsageMock).not.toHaveBeenCalled();
	});

	it("enforces a hard per-feature concurrency cap without a network attempt", async () => {
		const releases: Array<() => void> = [];
		sendJsonControlMessageMock.mockImplementation(
			() =>
				new Promise((resolve) => {
					releases.push(() =>
						resolve(controlResult({ text: '{"intentClass":"chat"}' })),
					);
				}),
		);

		const inFlight: Array<Promise<unknown>> = [];
		for (let i = 0; i < 2; i += 1) {
			const before = sendJsonControlMessageMock.mock.calls.length;
			inFlight.push(
				callShortLocalControlModel({
					message: `msg ${i}`,
					feature: "cap_feature",
					userId: "u1",
					conversationId: "c1",
					systemPrompt: "s",
					maxConcurrent: 2,
				}),
			);
			await vi.waitFor(() =>
				expect(sendJsonControlMessageMock.mock.calls.length).toBe(before + 1),
			);
		}

		const beforeOverCap = sendJsonControlMessageMock.mock.calls.length;
		const overCap = await callShortLocalControlModel({
			message: "one too many",
			feature: "cap_feature",
			userId: "u1",
			conversationId: "c1",
			systemPrompt: "s",
			maxConcurrent: 2,
		});

		expect(overCap).toBeNull();
		expect(sendJsonControlMessageMock.mock.calls.length).toBe(beforeOverCap);

		for (const release of releases) release();
		await Promise.all(inFlight);
	});
});

describe("generateShortLocalText", () => {
	beforeEach(() => {
		sendJsonControlMessageMock.mockReset();
		recordControlModelUsageMock.mockClear();
	});

	it("returns cleaned text and records spend on success", async () => {
		sendJsonControlMessageMock.mockResolvedValue(
			controlResult({ text: "  A Short Headline  " }),
		);

		const out = await generateShortLocalText({
			prompt: "Summarize this turn",
			feature: "rail_summary",
			userId: "u1",
			conversationId: "c1",
			systemPrompt: "Write a short headline.",
			maxTokens: 40,
		});

		expect(out).toBe("A Short Headline");

		const [message, modelId, options] = sendJsonControlMessageMock.mock
			.calls[0] as [
			string,
			string,
			{ thinkingMode?: string; maxTokens?: number },
		];
		expect(message).toBe("Summarize this turn");
		expect(modelId).toBe("model2");
		expect(options.thinkingMode).toBe("off");
		expect(options.maxTokens).toBe(40);

		expect(recordControlModelUsageMock).toHaveBeenCalledWith(
			expect.objectContaining({ feature: "rail_summary", modelId: "model2" }),
		);
	});

	it("returns null for an empty prompt without calling the control model", async () => {
		const out = await generateShortLocalText({
			prompt: "   ",
			feature: "rail_summary",
			userId: "u1",
			conversationId: "c1",
		});

		expect(out).toBeNull();
		expect(sendJsonControlMessageMock).not.toHaveBeenCalled();
	});

	it("returns null when the model leaks its reasoning", async () => {
		sendJsonControlMessageMock.mockResolvedValue(
			controlResult({ text: "Let me think about how to phrase this" }),
		);

		const out = await generateShortLocalText({
			prompt: "Summarize this turn",
			feature: "rail_summary",
			userId: "u1",
			conversationId: "c1",
		});

		expect(out).toBeNull();
	});

	it("returns null when the text is not in the expected language", async () => {
		sendJsonControlMessageMock.mockResolvedValue(
			controlResult({ text: "Magyar cím" }),
		);

		const out = await generateShortLocalText({
			prompt: "Summarize this turn",
			feature: "rail_summary",
			userId: "u1",
			conversationId: "c1",
			language: "en",
		});

		expect(out).toBeNull();
	});

	it("returns null on a cap miss without a network attempt", async () => {
		const releases: Array<() => void> = [];
		sendJsonControlMessageMock.mockImplementation(
			() =>
				new Promise((resolve) => {
					releases.push(() =>
						resolve(controlResult({ text: "Fine Headline Here" })),
					);
				}),
		);

		const inFlight: Array<Promise<unknown>> = [];
		for (let i = 0; i < 2; i += 1) {
			const before = sendJsonControlMessageMock.mock.calls.length;
			inFlight.push(
				generateShortLocalText({
					prompt: `prompt ${i}`,
					feature: "rail_cap",
					userId: "u1",
					conversationId: "c1",
					maxConcurrent: 2,
				}),
			);
			await vi.waitFor(() =>
				expect(sendJsonControlMessageMock.mock.calls.length).toBe(before + 1),
			);
		}

		const before = sendJsonControlMessageMock.mock.calls.length;
		const overCap = await generateShortLocalText({
			prompt: "over the cap",
			feature: "rail_cap",
			userId: "u1",
			conversationId: "c1",
			maxConcurrent: 2,
		});

		expect(overCap).toBeNull();
		expect(sendJsonControlMessageMock.mock.calls.length).toBe(before);

		for (const release of releases) release();
		await Promise.all(inFlight);
	});
});
