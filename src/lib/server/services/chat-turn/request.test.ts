import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "$lib/server/config-store";
import { parseChatTurnRequest } from "./request";

vi.mock("$lib/server/services/provider-models", () => ({
	listEnabledProviderModels: vi.fn(async () => []),
}));

vi.mock("$lib/server/services/providers", () => ({
	getProviderByName: vi.fn(async () => null),
	getProviderWithSecrets: vi.fn(async () => null),
}));

function makeRuntimeConfig(): RuntimeConfig {
	return {
		maxMessageLength: 10_000,
		model1MaxMessageLength: 10_000,
		model2MaxMessageLength: 10_000,
		model1: { displayName: "Model 1" },
		model2: { displayName: "Model 2" },
		model2Enabled: true,
	} as RuntimeConfig;
}

function makeRequest(body: Record<string, unknown>): Request {
	return new Request("http://localhost/api/chat/stream", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			message: "Explain the plan",
			conversationId: "conv-1",
			model: "model1",
			...body,
		}),
	});
}

describe("parseChatTurnRequest reasoning depth", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("accepts canonical reasoningDepth and maps Max to current provider-native reasoning", async () => {
		const result = await parseChatTurnRequest(
			makeRequest({ reasoningDepth: "max" }),
			makeRuntimeConfig(),
			"stream",
		);

		expect(result).toEqual(
			expect.objectContaining({
				ok: true,
				value: expect.objectContaining({
					reasoningDepth: "max",
					thinkingMode: "on",
				}),
			}),
		);
	});

	it("maps hidden legacy thinkingMode values when canonical reasoningDepth is absent", async () => {
		const result = await parseChatTurnRequest(
			makeRequest({ thinkingMode: "off" }),
			makeRuntimeConfig(),
			"stream",
		);

		expect(result).toEqual(
			expect.objectContaining({
				ok: true,
				value: expect.objectContaining({
					reasoningDepth: "off",
					thinkingMode: "off",
				}),
			}),
		);
	});

	it("defaults invalid reasoningDepth to Auto baseline behavior", async () => {
		const result = await parseChatTurnRequest(
			makeRequest({ reasoningDepth: "extended" }),
			makeRuntimeConfig(),
			"send",
		);

		expect(result).toEqual(
			expect.objectContaining({
				ok: true,
				value: expect.objectContaining({
					reasoningDepth: "auto",
					thinkingMode: "auto",
				}),
			}),
		);
	});
});
