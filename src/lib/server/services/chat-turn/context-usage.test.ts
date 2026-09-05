import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationContextStatus } from "$lib/server/services/knowledge/context-types";

const { mockRecordConversationPromptUsage } = vi.hoisted(() => ({
	mockRecordConversationPromptUsage: vi.fn(),
}));

vi.mock("$lib/server/services/knowledge", () => ({
	recordConversationPromptUsage: mockRecordConversationPromptUsage,
}));

import {
	recordCompletedTurnContextUsage,
	resolveCompletedTurnPromptUsage,
} from "./context-usage";

function contextStatus(
	overrides: Partial<ConversationContextStatus> = {},
): ConversationContextStatus {
	return {
		conversationId: "conv-1",
		userId: "user-1",
		estimatedTokens: 4_000,
		promptTokens: 4_000,
		promptTokensSource: "estimated",
		maxContextTokens: 200_000,
		thresholdTokens: 160_000,
		targetTokens: 180_000,
		compactionApplied: false,
		compactionMode: "none",
		routingStage: "deterministic",
		routingConfidence: 1,
		verificationStatus: "skipped",
		layersUsed: [],
		workingSetCount: 0,
		workingSetArtifactIds: [],
		workingSetApplied: false,
		taskStateApplied: false,
		promptArtifactCount: 0,
		recentTurnCount: 2,
		summary: null,
		updatedAt: 1,
		...overrides,
	};
}

describe("resolveCompletedTurnPromptUsage", () => {
	it("prefers the provider's last-step input count over the summed prompt tokens", () => {
		expect(
			resolveCompletedTurnPromptUsage({
				providerUsage: {
					promptTokens: 30_000,
					lastStepPromptTokens: 12_345.4,
					source: "provider",
				},
				estimatedPromptTokens: 9_000,
			}),
		).toEqual({ promptTokens: 12_345, promptTokensSource: "provider" });
	});

	it("falls back to the provider's summed prompt tokens when no last-step count exists", () => {
		expect(
			resolveCompletedTurnPromptUsage({
				providerUsage: { promptTokens: 8_000, source: "provider" },
				estimatedPromptTokens: 9_000,
			}),
		).toEqual({ promptTokens: 8_000, promptTokensSource: "provider" });
	});

	it("uses the full-prompt estimate when the provider reported no input tokens", () => {
		expect(
			resolveCompletedTurnPromptUsage({
				providerUsage: { completionTokens: 50, source: "provider" },
				estimatedPromptTokens: 9_000,
				contextStatus: contextStatus(),
			}),
		).toEqual({ promptTokens: 9_000, promptTokensSource: "estimated" });
	});

	it("falls back to the pre-request packet estimate and otherwise reports nothing", () => {
		expect(
			resolveCompletedTurnPromptUsage({
				providerUsage: null,
				contextStatus: contextStatus({ estimatedTokens: 4_000 }),
			}),
		).toEqual({ promptTokens: 4_000, promptTokensSource: "estimated" });
		expect(
			resolveCompletedTurnPromptUsage({
				providerUsage: null,
				estimatedPromptTokens: 0,
				contextStatus: null,
			}),
		).toBeNull();
	});
});

describe("recordCompletedTurnContextUsage", () => {
	beforeEach(() => {
		mockRecordConversationPromptUsage.mockReset();
	});

	it("persists provider-reported prompt usage and returns the refreshed status", async () => {
		const refreshed = contextStatus({
			promptTokens: 12_345,
			promptTokensSource: "provider",
		});
		mockRecordConversationPromptUsage.mockResolvedValue(refreshed);

		const result = await recordCompletedTurnContextUsage({
			userId: "user-1",
			conversationId: "conv-1",
			contextStatus: contextStatus(),
			providerUsage: { promptTokens: 12_345, source: "provider" },
			estimatedPromptTokens: 9_000,
		});

		expect(mockRecordConversationPromptUsage).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			promptTokens: 12_345,
			promptTokensSource: "provider",
		});
		expect(result).toBe(refreshed);
	});

	it("persists the estimate when the provider reported no input tokens", async () => {
		mockRecordConversationPromptUsage.mockImplementation(async (params) =>
			contextStatus({
				promptTokens: params.promptTokens,
				promptTokensSource: params.promptTokensSource,
			}),
		);

		const result = await recordCompletedTurnContextUsage({
			userId: "user-1",
			conversationId: "conv-1",
			contextStatus: contextStatus(),
			providerUsage: null,
			estimatedPromptTokens: 9_000,
		});

		expect(result).toMatchObject({
			promptTokens: 9_000,
			promptTokensSource: "estimated",
		});
	});

	it("returns the incoming status untouched when there is nothing to record", async () => {
		const result = await recordCompletedTurnContextUsage({
			userId: "user-1",
			conversationId: "conv-1",
			contextStatus: null,
			providerUsage: null,
		});

		expect(result).toBeNull();
		expect(mockRecordConversationPromptUsage).not.toHaveBeenCalled();
	});

	it("degrades to an in-memory copy carrying the new figures when the write fails or finds no row", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		mockRecordConversationPromptUsage.mockRejectedValueOnce(
			new Error("db down"),
		);

		const failed = await recordCompletedTurnContextUsage({
			userId: "user-1",
			conversationId: "conv-1",
			contextStatus: contextStatus(),
			providerUsage: { promptTokens: 5_000, source: "provider" },
		});
		expect(failed).toMatchObject({
			promptTokens: 5_000,
			promptTokensSource: "provider",
			maxContextTokens: 200_000,
		});
		expect(warn).toHaveBeenCalledTimes(1);

		mockRecordConversationPromptUsage.mockResolvedValueOnce(null);
		const missingRow = await recordCompletedTurnContextUsage({
			userId: "user-1",
			conversationId: "conv-1",
			contextStatus: contextStatus(),
			providerUsage: { promptTokens: 6_000, source: "provider" },
		});
		expect(missingRow).toMatchObject({
			promptTokens: 6_000,
			promptTokensSource: "provider",
		});
		warn.mockRestore();
	});
});
