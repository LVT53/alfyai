import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildToolResultCacheKey,
	getCachedToolResult,
	resetToolResultCacheForTests,
	setCachedToolResult,
	toolResultCacheSizeForTests,
} from "./tool-result-cache";

describe("tool-result-cache", () => {
	beforeEach(() => {
		resetToolResultCacheForTests();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("buildToolResultCacheKey", () => {
		it("produces the same key for the same conversation/tool/input", () => {
			const keyA = buildToolResultCacheKey({
				conversationId: "conv-1",
				toolName: "research_web",
				input: { query: "widget price", objective: "find it" },
			});
			const keyB = buildToolResultCacheKey({
				conversationId: "conv-1",
				toolName: "research_web",
				input: { objective: "find it", query: "widget price" },
			});
			expect(keyA).toBe(keyB);
		});

		it("differs across conversations, tools, or inputs", () => {
			const base = {
				conversationId: "conv-1",
				toolName: "research_web",
				input: { query: "widget price" },
			};
			const otherConversation = buildToolResultCacheKey({
				...base,
				conversationId: "conv-2",
			});
			const otherTool = buildToolResultCacheKey({
				...base,
				toolName: "fetch_url",
			});
			const otherInput = buildToolResultCacheKey({
				...base,
				input: { query: "widget cost" },
			});
			const original = buildToolResultCacheKey(base);
			expect(otherConversation).not.toBe(original);
			expect(otherTool).not.toBe(original);
			expect(otherInput).not.toBe(original);
		});
	});

	describe("get/set", () => {
		it("misses when nothing has been cached for a key", () => {
			const key = buildToolResultCacheKey({
				conversationId: "conv-1",
				toolName: "research_web",
				input: { query: "widget price" },
			});
			expect(getCachedToolResult(key)).toBeNull();
		});

		it("hits with the exact stored value after a set", () => {
			const key = buildToolResultCacheKey({
				conversationId: "conv-1",
				toolName: "research_web",
				input: { query: "widget price" },
			});
			const result = { sources: ["a"], evidence: [] };
			setCachedToolResult(key, result);
			expect(getCachedToolResult(key)).toEqual(result);
		});

		it("overwrites an existing entry on a second set", () => {
			const key = buildToolResultCacheKey({
				conversationId: "conv-1",
				toolName: "research_web",
				input: { query: "widget price" },
			});
			setCachedToolResult(key, { sources: ["a"] });
			setCachedToolResult(key, { sources: ["b"] });
			expect(getCachedToolResult(key)).toEqual({ sources: ["b"] });
			expect(toolResultCacheSizeForTests()).toBe(1);
		});
	});

	describe("TTL expiry", () => {
		it("expires an entry after 30 minutes and misses thereafter", () => {
			vi.useFakeTimers();
			const key = buildToolResultCacheKey({
				conversationId: "conv-1",
				toolName: "research_web",
				input: { query: "widget price" },
			});
			setCachedToolResult(key, { sources: ["a"] });

			// Just under the TTL: still a hit.
			vi.advanceTimersByTime(30 * 60 * 1000 - 1);
			expect(getCachedToolResult(key)).toEqual({ sources: ["a"] });

			// At/after the TTL: a miss, and the entry is evicted.
			vi.advanceTimersByTime(2);
			expect(getCachedToolResult(key)).toBeNull();
			expect(toolResultCacheSizeForTests()).toBe(0);
		});
	});

	describe("bounded size / LRU eviction", () => {
		it("evicts the least-recently-used entry once past 500 entries", () => {
			for (let i = 0; i < 500; i++) {
				setCachedToolResult(
					buildToolResultCacheKey({
						conversationId: "conv-1",
						toolName: "research_web",
						input: { query: `q${i}` },
					}),
					{ index: i },
				);
			}
			expect(toolResultCacheSizeForTests()).toBe(500);

			const firstKey = buildToolResultCacheKey({
				conversationId: "conv-1",
				toolName: "research_web",
				input: { query: "q0" },
			});
			expect(getCachedToolResult(firstKey)).toEqual({ index: 0 });

			// One more insertion pushes past the bound — evicts the entry that is
			// now least-recently-used. q0 was just re-touched by the get above, so
			// q1 (never touched again since insertion) is evicted instead.
			setCachedToolResult(
				buildToolResultCacheKey({
					conversationId: "conv-1",
					toolName: "research_web",
					input: { query: "q500" },
				}),
				{ index: 500 },
			);

			expect(toolResultCacheSizeForTests()).toBe(500);
			expect(getCachedToolResult(firstKey)).toEqual({ index: 0 });
			const evictedKey = buildToolResultCacheKey({
				conversationId: "conv-1",
				toolName: "research_web",
				input: { query: "q1" },
			});
			expect(getCachedToolResult(evictedKey)).toBeNull();
		});
	});
});
