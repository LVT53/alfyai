import { describe, expect, it } from "vitest";
import { buildContextPacket, TokenBudget } from "./token-budget";

describe("TokenBudget", () => {
	it("should correctly track remaining tokens after system + history reservation", () => {
		const budget = new TokenBudget(200);
		budget.reserve(
			"system",
			"This is a system prompt that uses about 100 tokens here",
		);
		budget.reserve(
			"history",
			"Some history content around 50 tokens worth of information",
		);

		expect(budget.remaining()).toBeLessThan(200);
		const used = budget.getSlotUsage();
		expect(used.get("system")).toBeGreaterThan(0);
		expect(used.get("history")).toBeGreaterThan(0);
	});

	it("should return 0 remaining when system + history exceed total budget", () => {
		const budget = new TokenBudget(30);
		budget.reserve(
			"system",
			"This is a very long system prompt that definitely exceeds the total budget available for all tokens combined together with lots of extra words to ensure we go over",
		);
		budget.reserve(
			"history",
			"Another very long history entry that pushes the total well over what remains after system reservation with more content to guarantee overage",
		);

		expect(budget.remaining()).toBe(0);
	});

	it("should correctly track per-slot usage in getSlotUsage", () => {
		const budget = new TokenBudget(500);
		budget.reserve("slot1", "short text");
		budget.reserve("slot2", "medium length text here");

		const usage = budget.getSlotUsage();
		expect(usage.get("slot1")).toBeGreaterThan(0);
		expect(usage.get("slot2")).toBeGreaterThan(0);
		expect(usage.size).toBe(2);
	});

	it("should handle partial reservations when text exceeds remaining budget", () => {
		const budget = new TokenBudget(20);
		const largeText =
			"This is a very long piece of text that definitely exceeds the remaining budget by a significant margin";
		budget.reserve("large", largeText);

		const usage = budget.getSlotUsage();
		expect(usage.get("large")).toBeGreaterThan(20);
		expect(budget.remaining()).toBe(0);
	});

	it("should return remainingChars as remaining * 4", () => {
		const budget = new TokenBudget(100);
		budget.reserve("system", "test");

		expect(budget.remainingChars()).toBe(budget.remaining() * 4);
	});
});

describe("buildContextPacket", () => {
	it("should correctly truncate doc sections when budget is small", () => {
		const result = buildContextPacket({
			systemPrompt:
				"This is a system prompt with significant content that will consume a large portion of the available token budget allocation for this test scenario",
			historySections: [
				{
					title: "History Section",
					body: "Long history content that takes up tokens and reduces the remaining budget for document sections below the threshold needed",
				},
			],
			docSections: [
				{
					title: "Doc1",
					body: "First document with substantial content that will definitely need truncation when the token budget is insufficient for all sections",
				},
				{
					title: "Doc2",
					body: "Second document with additional substantial content that will definitely need truncation when the token budget is insufficient for all sections",
				},
				{
					title: "Doc3",
					body: "Third document with additional substantial content that will definitely need truncation when the token budget is insufficient for all sections",
				},
			],
			userMessage: "User message here",
			totalBudget: 50,
		});

		expect(result.compactionApplied).toBe(true);
		expect(result.estimatedTokens).toBeGreaterThan(0);
	});

	it("should include all sections when budget is large", () => {
		const result = buildContextPacket({
			systemPrompt: "System prompt here",
			historySections: [
				{ title: "History1", body: "History content one" },
				{ title: "History2", body: "History content two" },
			],
			docSections: [
				{ title: "Doc1", body: "Document one content" },
				{ title: "Doc2", body: "Document two content" },
			],
			userMessage: "User message here",
			totalBudget: 50000,
		});

		expect(result.compactionApplied).toBe(false);
		expect(result.inputValue).toContain("System prompt");
		expect(result.inputValue).toContain("History1");
		expect(result.inputValue).toContain("Doc1");
	});

	it("should reserve system prompt first, history second, docs get remainder", () => {
		const budget = new TokenBudget(500);
		const systemPrompt = "System prompt text";
		const _historySections = [{ title: "History", body: "History text" }];
		const _docSections = [{ title: "Doc", body: "Document text" }];

		const sysTokens = budget.remaining();
		budget.reserve("system", systemPrompt);
		const afterSys = budget.remaining();
		expect(afterSys).toBeLessThan(sysTokens);

		budget.reserve("history", "History text");
		const afterHist = budget.remaining();
		expect(afterHist).toBeLessThan(afterSys);

		budget.reserve("doc", "Document text");
		const afterDoc = budget.remaining();
		expect(afterDoc).toBeLessThan(afterHist);
	});

	it("should assemble inputValue in correct order", () => {
		const result = buildContextPacket({
			systemPrompt: "## System\nSystem prompt content",
			historySections: [{ title: "Previous", body: "History body" }],
			docSections: [{ title: "Document", body: "Doc body" }],
			userMessage: "What is the answer?",
			totalBudget: 50000,
		});

		const value = result.inputValue;
		const sysIndex = value.indexOf("System prompt");
		const histIndex = value.indexOf("Previous");
		const docIndex = value.indexOf("Document");
		const msgIndex = value.indexOf("What is the answer");

		expect(sysIndex).toBeLessThan(histIndex);
		expect(histIndex).toBeLessThan(docIndex);
		expect(docIndex).toBeLessThan(msgIndex);
	});

	it("should return correct compactionApplied flag", () => {
		const smallBudget = buildContextPacket({
			systemPrompt:
				"Very long system prompt that takes significant space in the token budget allocation for this context packet construction with even more content to ensure we use more tokens",
			historySections: [
				{
					title: "H1",
					body: "Long history entry that consumes more tokens from the limited budget remaining after system reservation for this compact test case",
				},
				{
					title: "H2",
					body: "Another long history entry that further reduces available tokens for document sections in this constrained budget scenario",
				},
			],
			docSections: [
				{
					title: "D1",
					body: "Document content that we expect to be truncated due to insufficient remaining budget after system and history allocations",
				},
			],
			userMessage: "User query here",
			totalBudget: 40,
		});

		expect(smallBudget.compactionApplied).toBe(true);

		const largeBudget = buildContextPacket({
			systemPrompt: "Short",
			historySections: [{ title: "H1", body: "Short" }],
			docSections: [{ title: "D1", body: "Short" }],
			userMessage: "Short",
			totalBudget: 50000,
		});

		expect(largeBudget.compactionApplied).toBe(false);
	});
});
