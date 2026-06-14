import { describe, expect, it } from "vitest";
import {
	extractiveCompress,
	sentenceTokenOverlap,
} from "./extractive-compression";

describe("sentenceTokenOverlap", () => {
	it("returns overlap count for matching tokens", () => {
		const overlap = sentenceTokenOverlap(
			"memory decay formula",
			"The memory decay formula applies exponential decay",
		);
		expect(overlap).toBe(3);
	});

	it("filters out stopwords from tokenization", () => {
		const overlap = sentenceTokenOverlap(
			"the memory formula",
			"The memory decay formula is used",
		);
		expect(overlap).toBe(2);
	});

	it("returns 0 for empty query", () => {
		const overlap = sentenceTokenOverlap("", "Some sentence with tokens");
		expect(overlap).toBe(0);
	});

	it("returns 0 when no tokens match", () => {
		const overlap = sentenceTokenOverlap(
			"kubernetes docker",
			"The weather is nice today",
		);
		expect(overlap).toBe(0);
	});

	it("handles multiple overlapping tokens", () => {
		const overlap = sentenceTokenOverlap(
			"project management software development",
			"The software project uses management tools for development",
		);
		expect(overlap).toBe(4);
	});
});

describe("extractiveCompress", () => {
	it("respects maxChars limit", () => {
		const chunks = [
			"This is the first chunk with some content about memory systems.",
			"This is the second chunk with different content about databases.",
			"This is the third chunk discussing query optimization techniques.",
			"Here we have another sentence about indexing strategies.",
			"Finally, a sentence about caching mechanisms and performance.",
		];

		const result = extractiveCompress({
			chunks,
			query: "memory",
			maxChars: 200,
		});

		expect(result.text.length).toBeLessThanOrEqual(200);
	});

	it("ranks sentences with query token overlap higher", () => {
		const chunks = [
			"Python is a programming language.",
			"The memory decay formula is importance times exponential decay.",
			"JavaScript is used for web development.",
		];

		const result = extractiveCompress({
			chunks,
			query: "memory decay formula",
			maxChars: 80,
		});

		const memorySentence =
			"The memory decay formula is importance times exponential decay.";
		expect(result.text).toContain(memorySentence);
	});

	it("preserves original document order of selected sentences", () => {
		const chunks = [
			"First sentence here.",
			"Memory systems store data.",
			"Third sentence here.",
		];

		const result = extractiveCompress({
			chunks,
			query: "memory systems store",
			maxChars: 200,
		});

		expect(result.text).toContain("First");
		expect(result.text).toContain("Memory");
		expect(result.text).toContain("Third");
		const firstPos = result.text.indexOf("First");
		const memoryPos = result.text.indexOf("Memory");
		const thirdPos = result.text.indexOf("Third");
		expect(firstPos).toBeLessThan(memoryPos);
		expect(memoryPos).toBeLessThan(thirdPos);
	});

	it("handles multi-chunk ordering correctly", () => {
		const chunks = [
			"Chunk one sentence alpha.",
			"Chunk one sentence beta.",
			"Chunk two sentence gamma.",
		];

		const result = extractiveCompress({
			chunks,
			query: "chunk",
			maxChars: 500,
		});

		const alphaPos = result.text.indexOf("alpha");
		const betaPos = result.text.indexOf("beta");
		const gammaPos = result.text.indexOf("gamma");

		expect(alphaPos).toBeLessThan(betaPos);
		expect(betaPos).toBeLessThan(gammaPos);
	});

	it("returns first N sentences for empty query", () => {
		const chunks = [
			"First sentence is short.",
			"Second sentence is medium length.",
			"Third sentence is the longest one here.",
		];

		const result = extractiveCompress({
			chunks,
			query: "",
			maxChars: 50,
		});

		expect(result.text).toBe("First sentence is short.");
	});

	it("returns first N sentences for whitespace-only query", () => {
		const chunks = [
			"First sentence is short.",
			"Second sentence is medium length.",
			"Third sentence is the longest one here.",
		];

		const result = extractiveCompress({
			chunks,
			query: "   ",
			maxChars: 50,
		});

		expect(result.text).toBe("First sentence is short.");
	});

	it("handles single chunk with all relevant sentences", () => {
		const chunks = [
			"The memory decay formula is important. It calculates importance decay. Python is a language.",
		];

		const result = extractiveCompress({
			chunks,
			query: "memory decay",
			maxChars: 200,
		});

		expect(result.text).toContain("memory decay formula");
		expect(result.text.length).toBeGreaterThan(50);
	});

	it("computes compression ratio correctly", () => {
		const chunks = [
			"This is a very long chunk that contains many sentences about various topics including memory systems, databases, and query optimization. Each sentence adds to the overall length of the content.",
		];

		const result = extractiveCompress({
			chunks,
			query: "memory",
			maxChars: 50,
		});

		expect(result.compressionRatio).toBeGreaterThan(0);
		expect(result.compressionRatio).toBeLessThanOrEqual(1);
	});

	it("handles empty chunks array", () => {
		const result = extractiveCompress({
			chunks: [],
			query: "test",
			maxChars: 100,
		});

		expect(result.text).toBe("");
		expect(result.compressionRatio).toBe(0);
	});

	it("handles zero maxChars", () => {
		const chunks = ["Some content that should not be included."];

		const result = extractiveCompress({
			chunks,
			query: "content",
			maxChars: 0,
		});

		expect(result.text).toBe("");
		expect(result.compressionRatio).toBe(1);
	});

	it("handles negative maxChars", () => {
		const chunks = ["Some content."];

		const result = extractiveCompress({
			chunks,
			query: "content",
			maxChars: -10,
		});

		expect(result.text).toBe("");
		expect(result.compressionRatio).toBe(1);
	});

	it("uses token overlap scoring for sentence selection", () => {
		const chunks = [
			"Memory systems help store data. The decay formula uses exponential calculation. SQL databases handle queries.",
		];

		const result = extractiveCompress({
			chunks,
			query: "memory decay formula",
			maxChars: 80,
		});

		const memoryDecaySentence =
			"The decay formula uses exponential calculation.";
		expect(result.text).toContain(memoryDecaySentence);
	});

	it("greedy selection respects character budget", () => {
		const chunks = [
			"Short sentence one.",
			"Medium length sentence two here.",
			"Longer sentence three with more content.",
			"Even longer sentence four with substantial content.",
			"Very long sentence five that contains lots of text content.",
		];

		const result = extractiveCompress({
			chunks,
			query: "sentence",
			maxChars: 100,
		});

		expect(result.text.length).toBeLessThanOrEqual(100);
		expect(result.compressionRatio).toBeGreaterThan(0);
		expect(result.compressionRatio).toBeLessThanOrEqual(1);
	});

	it("sentence splitting handles multiple sentence endings", () => {
		const chunks = ["First sentence? Second sentence! Third sentence."];

		const result = extractiveCompress({
			chunks,
			query: "first",
			maxChars: 200,
		});

		expect(result.text).toContain("First sentence?");
	});
});
