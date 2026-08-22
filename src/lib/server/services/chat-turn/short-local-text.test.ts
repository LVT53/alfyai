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
	unwrapJsonControlText,
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

	// A2 hardening — the cap counter's `finally` decrement must free the slot
	// once a call settles, or the feature would permanently wedge after
	// `maxConcurrent` lifetime calls. Two sequential capped calls (each fully
	// settled before the next) both reach the network under a cap of 1, proving
	// the slot is released on completion.
	it("frees a cap slot after the call settles so a later call goes through (cap recovery)", async () => {
		sendJsonControlMessageMock.mockResolvedValue(
			controlResult({ text: '{"intentClass":"chat"}' }),
		);

		const first = await callShortLocalControlModel({
			message: "first",
			feature: "recovery_feature",
			userId: "u1",
			conversationId: "c1",
			systemPrompt: "s",
			maxConcurrent: 1,
		});
		expect(first?.text).toBe('{"intentClass":"chat"}');

		// Slot freed in the previous call's `finally` — a second call under the
		// same cap of 1 is admitted, not rejected.
		const second = await callShortLocalControlModel({
			message: "second",
			feature: "recovery_feature",
			userId: "u1",
			conversationId: "c1",
			systemPrompt: "s",
			maxConcurrent: 1,
		});
		expect(second?.text).toBe('{"intentClass":"chat"}');
		expect(sendJsonControlMessageMock).toHaveBeenCalledTimes(2);
	});

	// A2 hardening — `timeoutMs` is OPT-IN. When it (and any caller signal) is
	// omitted, the call must go out with NO abort signal at all, documenting
	// that the default is untimed (the caller owns the timeout decision).
	it("passes no abort signal when timeoutMs and signal are both omitted", async () => {
		sendJsonControlMessageMock.mockResolvedValue(
			controlResult({ text: '{"intentClass":"chat"}' }),
		);

		await callShortLocalControlModel({
			message: "no timeout",
			feature: "untimed_feature",
			userId: "u1",
			conversationId: "c1",
			systemPrompt: "s",
		});

		const [, , options] = sendJsonControlMessageMock.mock.calls[0] as [
			string,
			string,
			{ signal?: AbortSignal },
		];
		expect(options.signal).toBeUndefined();
	});
});

describe("unwrapJsonControlText", () => {
	it("extracts the string from a JSON-wrapped control result", () => {
		expect(unwrapJsonControlText('{"headline": "FlightLink Dublin Checklist"}')).toBe(
			"FlightLink Dublin Checklist",
		);
		expect(unwrapJsonControlText('{\n  "title": "Buy DD1 First"\n}')).toBe(
			"Buy DD1 First",
		);
		// Prefers a known text key, then the first non-empty string value.
		expect(unwrapJsonControlText('{"foo": "", "bar": "Fallback value"}')).toBe(
			"Fallback value",
		);
	});

	it("peels a ```json fence before parsing", () => {
		expect(
			unwrapJsonControlText('```json\n{"headline": "Fenced Headline"}\n```'),
		).toBe("Fenced Headline");
	});

	it("leaves genuine plain text and non-object JSON untouched", () => {
		expect(unwrapJsonControlText("A Short Headline")).toBe("A Short Headline");
		expect(unwrapJsonControlText("Cost is $5 { per unit }")).toBe(
			"Cost is $5 { per unit }",
		);
		// Malformed JSON object: return the raw text rather than throwing.
		expect(unwrapJsonControlText('{"headline": broken')).toBe(
			'{"headline": broken',
		);
		// A JSON object with no string value: leave it as-is.
		expect(unwrapJsonControlText('{"count": 3}')).toBe('{"count": 3}');
	});
});

describe("generateShortLocalText", () => {
	beforeEach(() => {
		sendJsonControlMessageMock.mockReset();
		recordControlModelUsageMock.mockClear();
	});

	it("unwraps a JSON-wrapped control result into plain text", async () => {
		// The transport forces JSON output, so a schemaless call returns
		// `{"headline":"…"}` — the seam must store the headline, not the JSON.
		sendJsonControlMessageMock.mockResolvedValue(
			controlResult({ text: '{"headline": "Limerick to Dublin fares"}' }),
		);

		const out = await generateShortLocalText({
			prompt: "Summarize this turn",
			feature: "rail_summary",
			userId: "u1",
			conversationId: "c1",
			systemPrompt: "Write a short headline.",
			maxTokens: 40,
			cleanup: { maxChars: 100, maxWords: 14 },
		});

		expect(out).toBe("Limerick to Dublin fares");
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

	// A2 hardening — the `cleanup.normalize` hook runs on the raw model text
	// BEFORE the plausibility/language checks. Proven by a raw output that is
	// implausible as-is (over the char bound) but which `normalize` reshapes
	// into an accepted headline.
	it("applies cleanup.normalize before the plausibility checks", async () => {
		sendJsonControlMessageMock.mockResolvedValue(
			controlResult({ text: `"Quoted Headline" ${"x".repeat(200)}` }),
		);

		const out = await generateShortLocalText({
			prompt: "Summarize this turn",
			feature: "rail_summary",
			userId: "u1",
			conversationId: "c1",
			// Strip the trailing noise + surrounding quotes: without this the raw
			// text is far over the 100-char plausibility bound and would be
			// rejected; with it, a clean short headline survives.
			cleanup: { normalize: (raw) => raw.replace(/^"([^"]+)".*$/s, "$1") },
		});

		expect(out).toBe("Quoted Headline");
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
