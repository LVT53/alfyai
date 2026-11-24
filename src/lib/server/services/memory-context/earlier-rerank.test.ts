import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rerankTexts = vi.hoisted(() => vi.fn());
vi.mock("../tei-reranker", () => ({ rerankTexts }));

import { clipMentionText } from "./earlier-mention";
import {
	EARLIER_RERANK_MAX_TEXTS,
	EARLIER_RERANK_TIMEOUT_MS,
	earlierJoins,
	scoreEarlierCandidates,
} from "./earlier-rerank";

const thresholds = { min: 0.002, wordMin: 0.0005 };
const words = (mentioned: boolean) => vi.fn(() => mentioned);

describe("earlierJoins", () => {
	it("takes the word rule alone when the reranker gave no score", () => {
		expect(earlierJoins(undefined, words(true), thresholds)).toBe(true);
		expect(earlierJoins(undefined, words(false), thresholds)).toBe(false);
	});

	it("lets a score at the main floor in without asking the words", () => {
		const mentioned = words(false);
		expect(earlierJoins(0.002, mentioned, thresholds)).toBe(true);
		expect(earlierJoins(0.9, mentioned, thresholds)).toBe(true);
		expect(mentioned).not.toHaveBeenCalled();
	});

	it("lets a score between the floors in only when the words mention the entry", () => {
		expect(earlierJoins(0.001, words(true), thresholds)).toBe(true);
		expect(earlierJoins(0.0005, words(true), thresholds)).toBe(true);
		expect(earlierJoins(0.001, words(false), thresholds)).toBe(false);
	});

	it("keeps out a score under the lower floor, whatever the words say", () => {
		expect(earlierJoins(0.0004, words(true), thresholds)).toBe(false);
		expect(earlierJoins(0, words(true), thresholds)).toBe(false);
		expect(earlierJoins(0.0004, words(false), thresholds)).toBe(false);
	});

	it("follows the floors it is given", () => {
		const strict = { min: 0.5, wordMin: 0.1 };
		expect(earlierJoins(0.4, words(false), strict)).toBe(false);
		expect(earlierJoins(0.4, words(true), strict)).toBe(true);
		expect(earlierJoins(0.05, words(true), strict)).toBe(false);
	});
});

describe("scoreEarlierCandidates", () => {
	const candidates = [
		{ key: "p:1", text: "The user had a dentist appointment." },
		{ key: "p:2", text: "The user was repainting the hallway." },
		{ key: "q:7", text: "The project's demo was planned for May." },
	];
	let warn: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		rerankTexts.mockReset();
		warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => warn.mockRestore());

	it("scores every candidate in one call and keys each score by its candidate", async () => {
		rerankTexts.mockResolvedValue([
			{ index: 2, score: 0.8 },
			{ index: 0, score: 0.004 },
			{ index: 1, score: 0.0001 },
		]);
		const scores = await scoreEarlierCandidates(
			"how did the dentist go?",
			candidates,
		);
		expect(rerankTexts).toHaveBeenCalledTimes(1);
		expect(rerankTexts).toHaveBeenCalledWith(
			expect.objectContaining({
				query: "how did the dentist go?",
				texts: candidates.map(({ text }) => text),
				timeoutMs: EARLIER_RERANK_TIMEOUT_MS,
			}),
		);
		expect(Object.fromEntries(scores ?? [])).toEqual({
			"p:1": { text: candidates[0]?.text, score: 0.004 },
			"p:2": { text: candidates[1]?.text, score: 0.0001 },
			"q:7": { text: candidates[2]?.text, score: 0.8 },
		});
		expect(warn).not.toHaveBeenCalled();
	});

	it("bounds the call by half a second", () => {
		expect(EARLIER_RERANK_TIMEOUT_MS).toBe(500);
	});

	it("reads a megabyte message as the word rule does, its first 4,000 and last 2,000 characters", async () => {
		rerankTexts.mockResolvedValue([{ index: 0, score: 0.5 }]);
		const message = `${"head ".repeat(100_000)}dentist${" tail".repeat(100_000)}`;
		await scoreEarlierCandidates(message, candidates.slice(0, 1));
		const { query } = rerankTexts.mock.calls[0]?.[0] ?? {};
		expect(query).toBe(clipMentionText(message));
		expect(query).toHaveLength(6_001);
	});

	it("sends at most six texts, the first six candidates", async () => {
		const many = Array.from({ length: 9 }, (_, i) => ({
			key: `b:${i}`,
			text: `Entry number ${i}`,
		}));
		rerankTexts.mockResolvedValue(
			many.slice(0, 6).map((_, index) => ({ index, score: 0.1 })),
		);
		const scores = await scoreEarlierCandidates("anything", many);
		expect(EARLIER_RERANK_MAX_TEXTS).toBe(6);
		expect(rerankTexts.mock.calls[0]?.[0].texts).toEqual(
			many.slice(0, 6).map(({ text }) => text),
		);
		expect([...(scores?.keys() ?? [])]).toEqual(
			many.slice(0, 6).map(({ key }) => key),
		);
	});

	it("leaves a candidate the reranker did not score out of the scores", async () => {
		rerankTexts.mockResolvedValue([
			{ index: 1, score: 0.3 },
			{ index: 99, score: 0.9 },
		]);
		const scores = await scoreEarlierCandidates("anything", candidates);
		expect([...(scores?.keys() ?? [])]).toEqual(["p:2"]);
	});

	it("makes no call for no candidates or a message with nothing in it", async () => {
		expect(await scoreEarlierCandidates("hello", [])).toBeNull();
		expect(await scoreEarlierCandidates("   \n ", candidates)).toBeNull();
		expect(rerankTexts).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
	});

	it.each([
		[
			"no reranker is configured",
			() => rerankTexts.mockResolvedValue(null),
			"not_configured",
		],
		[
			"the call timed out",
			() =>
				rerankTexts.mockRejectedValue(
					new DOMException("aborted", "AbortError"),
				),
			"timeout",
		],
		[
			"the call failed",
			() => rerankTexts.mockRejectedValue(new Error("TEI request failed: 503")),
			"error",
		],
		[
			"it answered with nothing",
			() => rerankTexts.mockResolvedValue([]),
			"empty",
		],
	])(
		"gives no scores, and logs one content-free line with its code, when %s",
		async (_when, arrange, code) => {
			arrange();
			const message = "how did the private dentist visit go?";
			expect(await scoreEarlierCandidates(message, candidates)).toBeNull();
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn).toHaveBeenCalledWith(
				"[KNOWLEDGE_MEMORY] Earlier rerank unavailable",
				{ code },
			);
			expect(JSON.stringify(warn.mock.calls)).not.toContain("dentist");
		},
	);
});
