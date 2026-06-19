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

describe("parseChatTurnRequest Atlas fields", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("defaults absent Atlas fields to a normal chat turn", async () => {
		const result = await parseChatTurnRequest(
			makeRequest({}),
			makeRuntimeConfig(),
			"send",
		);

		expect(result).toEqual(
			expect.objectContaining({
				ok: true,
				value: expect.objectContaining({
					atlasMode: false,
					atlasProfile: null,
					atlasAction: "create",
					parentAtlasId: null,
					clientAtlasTurnId: null,
				}),
			}),
		);
	});

	it("accepts an Atlas profile and trims Atlas idempotency fields", async () => {
		const result = await parseChatTurnRequest(
			makeRequest({
				atlasMode: true,
				atlasProfile: "in-depth",
				clientAtlasTurnId: " client-turn-1 ",
				atlasAction: "continue",
				parentAtlasId: " atlas-parent-1 ",
			}),
			makeRuntimeConfig(),
			"send",
		);

		expect(result).toEqual(
			expect.objectContaining({
				ok: true,
				value: expect.objectContaining({
					atlasMode: true,
					atlasProfile: "in-depth",
					atlasAction: "continue",
					parentAtlasId: "atlas-parent-1",
					clientAtlasTurnId: "client-turn-1",
					pendingSkill: null,
					forceWebSearch: false,
				}),
			}),
		);
	});

	it("rejects invalid Atlas profiles when Atlas mode is enabled", async () => {
		const result = await parseChatTurnRequest(
			makeRequest({ atlasMode: true, atlasProfile: "deep" }),
			makeRuntimeConfig(),
			"send",
		);

		expect(result).toEqual({
			ok: false,
			error: {
				status: 400,
				error: "atlasProfile must be one of overview, in-depth, or exhaustive",
				code: "INVALID_ATLAS_PROFILE",
			},
		});
	});

	it("ignores Atlas-only fields for non-Atlas turns", async () => {
		const result = await parseChatTurnRequest(
			makeRequest({
				atlasProfile: "exhaustive",
				clientAtlasTurnId: "client-turn-1",
				atlasAction: "revise",
				parentAtlasId: "atlas-parent-1",
			}),
			makeRuntimeConfig(),
			"stream",
		);

		expect(result).toEqual(
			expect.objectContaining({
				ok: true,
				value: expect.objectContaining({
					atlasMode: false,
					atlasProfile: null,
					atlasAction: "create",
					parentAtlasId: null,
					clientAtlasTurnId: null,
					reasoningDepth: "auto",
					thinkingMode: "auto",
				}),
			}),
		);
	});
});
