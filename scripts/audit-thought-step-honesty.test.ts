import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FIX 5 [judge reliability] — regression coverage for
// scripts/audit-thought-step-honesty.ts's faithfulness judge hardening:
//   1. The judge's OpenAI-compatible request now goes through the app's own
//      `createOpenAICompatibleProviderForNormalChatModelRun` +
//      `buildNormalChatModelRunProviderOptions(provider, "off")` seam — the
//      SAME one `normal-chat-control-model.ts`'s `sendJsonControlMessage`
//      uses for the classifier's `thinkingMode: "off"` calls — instead of a
//      bare `createOpenAICompatible(...)`, so a self-hosted qwen judge gets
//      thinking disabled (both the top-level `enable_thinking: false` AND
//      its `chat_template_kwargs.enable_thinking: false` mirror for
//      vLLM/SGLang) exactly like every other control-model call already
//      does.
//   2. `parseFaithfulnessVerdict` parses via envelope extraction
//      (`parseJsonWithEnvelopeExtraction`) instead of a strict `JSON.parse`,
//      so a verdict wrapped in surrounding prose still parses.
//   3. `callFaithfulnessJudge` retries ONCE on a failed attempt (e.g. an
//      empty response from a judge whose thinking mode ate the whole
//      token budget); a SECOND failure still stays "unjudged" — fail-closed,
//      unchanged.
//
// This module has real top-level side effects on import (it opens a sqlite
// DB via `$lib/server/db`), so — same convention as
// thought-step-classifier.test.ts — DATABASE_PATH is pointed at a fresh
// temp file before every dynamic import. None of the functions under test
// here ever touch that DB (they don't call `sampleLiveTurns`/`main`), so no
// migration is needed — better-sqlite3 auto-creates an empty file.

let dbPath: string;

beforeEach(() => {
	dbPath = `/tmp/alfyai-audit-thought-step-honesty-${randomUUID()}.db`;
	process.env.DATABASE_PATH = dbPath;
	process.env.SESSION_SECRET ??= "mock-session-secret-for-dev-testing-only";
	vi.resetModules();
});

afterEach(async () => {
	try {
		const { sqlite } = await import("$lib/server/db");
		sqlite.close();
	} catch {
		// db module may not have been imported by this test
	}
	try {
		unlinkSync(dbPath);
	} catch {
		// best-effort
	}
});

describe("parseFaithfulnessVerdict — envelope-extraction parsing (FIX 5)", () => {
	it("parses a bare, well-formed JSON verdict", async () => {
		const { parseFaithfulnessVerdict } = await import(
			"./audit-thought-step-honesty"
		);
		expect(
			parseFaithfulnessVerdict('{"faithful": true, "reason": "matches"}'),
		).toEqual({ faithful: true, reason: "matches" });
	});

	it("accepts a verdict object wrapped in surrounding prose (envelope extraction, not a strict JSON.parse)", async () => {
		const { parseFaithfulnessVerdict } = await import(
			"./audit-thought-step-honesty"
		);
		const wrapped =
			'Let me think about this carefully. My verdict: {"faithful": false, "category": "fabrication", "reason": "adds a claim not in the span"} — that is final.';
		expect(parseFaithfulnessVerdict(wrapped)).toEqual({
			faithful: false,
			category: "fabrication",
			reason: "adds a claim not in the span",
		});
	});

	it("still tolerates a ```json code-fenced verdict", async () => {
		const { parseFaithfulnessVerdict } = await import(
			"./audit-thought-step-honesty"
		);
		const fenced = '```json\n{"faithful": true, "reason": "ok"}\n```';
		expect(parseFaithfulnessVerdict(fenced)).toEqual({
			faithful: true,
			reason: "ok",
		});
	});

	it("throws (stays unjudged upstream, never silently faithful) on an empty response", async () => {
		const { parseFaithfulnessVerdict } = await import(
			"./audit-thought-step-honesty"
		);
		expect(() => parseFaithfulnessVerdict("")).toThrow();
	});

	it("throws on prose with no embedded JSON object at all", async () => {
		const { parseFaithfulnessVerdict } = await import(
			"./audit-thought-step-honesty"
		);
		expect(() => parseFaithfulnessVerdict("I cannot answer that.")).toThrow();
	});
});

describe("createJudgeModel / callFaithfulnessJudge — qwen thinking-disable + retry (FIX 5)", () => {
	function qwenJudgeSlot() {
		return {
			baseURL: "https://judge.example/v1",
			apiKey: "judge-secret",
			modelName: "qwen3-32b-instruct",
			displayName: "Local Qwen Judge",
		};
	}

	function chatCompletionResponse(contentText: string) {
		return new Response(
			JSON.stringify({
				id: "chatcmpl-1",
				model: "qwen3-32b-instruct",
				created: 1_717_171_717,
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: contentText },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}

	it("disables qwen thinking on the judge request — both the top-level field and its chat_template_kwargs mirror for self-hosted vLLM", async () => {
		const { createJudgeModel, callFaithfulnessJudge } = await import(
			"./audit-thought-step-honesty"
		);
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
			chatCompletionResponse(
				JSON.stringify({ faithful: true, reason: "matches the span" }),
			),
		);
		const judgeModel = createJudgeModel(qwenJudgeSlot(), fetchMock);

		const result = await callFaithfulnessJudge({
			judgeModel,
			summary: "Weighing tradeoffs between caching and recomputation",
			anchoredSpanText:
				"There is a tradeoff between caching results and recomputation.",
		});

		expect(result).toEqual({
			status: "judged",
			verdict: { faithful: true, reason: "matches the span" },
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
		expect(body.enable_thinking).toBe(false);
		expect(body.chat_template_kwargs?.enable_thinking).toBe(false);
	});

	it("retries ONCE on an empty first response (the thinking-ate-the-budget failure mode) and succeeds on the second attempt", async () => {
		const { createJudgeModel, callFaithfulnessJudge } = await import(
			"./audit-thought-step-honesty"
		);
		const fetchMock = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(chatCompletionResponse(""))
			.mockResolvedValueOnce(
				chatCompletionResponse(
					JSON.stringify({
						faithful: false,
						category: "unmoored",
						reason: "vague, not grounded in the span",
					}),
				),
			);
		const judgeModel = createJudgeModel(qwenJudgeSlot(), fetchMock);

		const result = await callFaithfulnessJudge({
			judgeModel,
			summary: "Some summary",
			anchoredSpanText: "Some anchored span",
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result).toEqual({
			status: "judged",
			verdict: {
				faithful: false,
				category: "unmoored",
				reason: "vague, not grounded in the span",
			},
		});
	});

	it("stays unjudged (fail-closed) when BOTH attempts return an empty response", async () => {
		const { createJudgeModel, callFaithfulnessJudge } = await import(
			"./audit-thought-step-honesty"
		);
		const fetchMock = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(chatCompletionResponse(""));
		const judgeModel = createJudgeModel(qwenJudgeSlot(), fetchMock);

		const result = await callFaithfulnessJudge({
			judgeModel,
			summary: "Some summary",
			anchoredSpanText: "Some anchored span",
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result.status).toBe("unjudged");
	});
});
