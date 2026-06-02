import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAdmin: vi.fn(),
}));

vi.mock("$lib/server/config-store", () => ({
	clearProvidersCache: vi.fn(),
	refreshConfig: vi.fn(),
}));

vi.mock("$lib/server/services/inference-providers", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/inference-providers")
	>("$lib/server/services/inference-providers");

	return {
		...actual,
		decryptApiKey: vi.fn(),
		getProviderWithSecrets: vi.fn(),
		updateProvider: vi.fn(),
		validateProviderConnection: vi.fn(),
	};
});

import { requireAdmin } from "$lib/server/auth/hooks";
import {
	decryptApiKey,
	getProviderWithSecrets,
	updateProvider,
	validateProviderConnection,
} from "$lib/server/services/inference-providers";
import { PUT } from "./+server";

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockDecryptApiKey = decryptApiKey as ReturnType<typeof vi.fn>;
const mockGetProviderWithSecrets = getProviderWithSecrets as ReturnType<typeof vi.fn>;
const mockUpdateProvider = updateProvider as ReturnType<typeof vi.fn>;
const mockValidateProviderConnection = validateProviderConnection as ReturnType<
	typeof vi.fn
>;

type ProviderPutEvent = Parameters<typeof PUT>[0];

function makePutEvent(body: unknown): ProviderPutEvent {
	return {
		request: new Request("http://localhost/api/admin/providers/provider-1", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: { user: { id: "admin-1", role: "admin" } },
		params: { id: "provider-1" },
		url: new URL("http://localhost/api/admin/providers/provider-1"),
		route: { id: "/api/admin/providers/[id]" },
	} as ProviderPutEvent;
}

describe("admin provider detail route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAdmin.mockReturnValue(undefined);
		mockDecryptApiKey.mockReturnValue("existing-fallback-secret");
		mockValidateProviderConnection.mockResolvedValue({ valid: true });
		mockGetProviderWithSecrets.mockResolvedValue({
			id: "provider-1",
			name: "firepass",
			displayName: "Fire Pass Turbo",
			baseUrl: "https://api.fireworks.ai/inference/v1",
			apiKeyEncrypted: "encrypted-primary",
			apiKeyIv: "primary-iv",
			modelName: "accounts/fireworks/routers/kimi-k2p6-turbo",
			reasoningEffort: null,
			thinkingType: null,
			enabled: true,
			sortOrder: 0,
			maxModelContext: 262_144,
			compactionUiThreshold: null,
			targetConstructedContext: null,
			maxMessageLength: null,
			maxTokens: null,
			rateLimitFallbackEnabled: false,
			rateLimitFallbackBaseUrl: null,
			rateLimitFallbackModelName: null,
			rateLimitFallbackTimeoutMs: 10_000,
			rateLimitFallbackApiKeyEncrypted: "encrypted-fallback",
			rateLimitFallbackApiKeyIv: "fallback-iv",
			createdAt: new Date("2026-05-15T12:00:00.000Z"),
			updatedAt: new Date("2026-05-15T12:00:00.000Z"),
		});
		mockUpdateProvider.mockResolvedValue({
			id: "provider-1",
			name: "firepass",
			displayName: "Fire Pass Turbo",
			baseUrl: "https://api.fireworks.ai/inference/v1",
			modelName: "accounts/fireworks/routers/kimi-k2p6-turbo",
			reasoningEffort: null,
			thinkingType: null,
			enabled: true,
			sortOrder: 0,
			maxModelContext: 262_144,
			compactionUiThreshold: null,
			targetConstructedContext: null,
			maxMessageLength: null,
			maxTokens: null,
			rateLimitFallbackEnabled: true,
			rateLimitFallbackBaseUrl: "https://api.moonshot.ai/v1",
			rateLimitFallbackModelName: "kimi-k2.6",
			rateLimitFallbackTimeoutMs: 15_000,
			createdAt: new Date("2026-05-15T12:00:00.000Z"),
			updatedAt: new Date("2026-05-15T12:30:00.000Z"),
		});
	});

	it("updates fallback settings without requiring the unchanged fallback API key", async () => {
		const response = await PUT(
			makePutEvent({
				rateLimitFallbackEnabled: true,
				rateLimitFallbackBaseUrl: "https://api.moonshot.ai/v1",
				rateLimitFallbackApiKey: "",
				rateLimitFallbackModelName: "kimi-k2.6",
				rateLimitFallbackTimeoutMs: 15_000,
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.provider).toEqual(
			expect.objectContaining({
				rateLimitFallbackEnabled: true,
				rateLimitFallbackBaseUrl: "https://api.moonshot.ai/v1",
				rateLimitFallbackModelName: "kimi-k2.6",
				rateLimitFallbackTimeoutMs: 15_000,
			}),
		);
		expect(data.provider).not.toHaveProperty("rateLimitFallbackApiKey");
		expect(data.provider).not.toHaveProperty("rateLimitFallbackApiKeyEncrypted");
		expect(mockUpdateProvider).toHaveBeenCalledWith(
			"provider-1",
			expect.objectContaining({
				rateLimitFallbackEnabled: true,
				rateLimitFallbackBaseUrl: "https://api.moonshot.ai/v1",
				rateLimitFallbackModelName: "kimi-k2.6",
				rateLimitFallbackTimeoutMs: 15_000,
			}),
		);
		expect(mockUpdateProvider.mock.calls[0][1]).not.toHaveProperty(
			"rateLimitFallbackApiKey",
		);
		expect(mockValidateProviderConnection).toHaveBeenCalledWith(
			"https://api.moonshot.ai/v1",
			"existing-fallback-secret",
			{ modelName: "kimi-k2.6" },
		);
	});

	it("revalidates capabilities with configured reasoning controls when they change", async () => {
		const response = await PUT(
			makePutEvent({
				reasoningEffort: "high",
				thinkingType: "enabled",
			}),
		);

		expect(response.status).toBe(200);
		expect(mockValidateProviderConnection).toHaveBeenCalledWith(
			"https://api.fireworks.ai/inference/v1",
			"existing-fallback-secret",
			{
				modelName: "accounts/fireworks/routers/kimi-k2p6-turbo",
				reasoningEffort: "high",
				thinkingType: "enabled",
			},
		);
		expect(mockUpdateProvider).toHaveBeenCalledWith(
			"provider-1",
			expect.objectContaining({
				reasoningEffort: "high",
				thinkingType: "enabled",
			}),
		);
	});
});
