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
		createProvider: vi.fn(),
		listProviders: vi.fn(),
		validateProviderConnection: vi.fn(),
	};
});

import { requireAdmin } from "$lib/server/auth/hooks";
import { clearProvidersCache, refreshConfig } from "$lib/server/config-store";
import {
	createProvider,
	validateProviderConnection,
} from "$lib/server/services/inference-providers";
import { POST } from "./+server";

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockClearProvidersCache = clearProvidersCache as ReturnType<typeof vi.fn>;
const mockRefreshConfig = refreshConfig as ReturnType<typeof vi.fn>;
const mockCreateProvider = createProvider as ReturnType<typeof vi.fn>;
const mockValidateProviderConnection = validateProviderConnection as ReturnType<
	typeof vi.fn
>;

type ProviderPostEvent = Parameters<typeof POST>[0];

function makePostEvent(body: unknown): ProviderPostEvent {
	return {
		request: new Request("http://localhost/api/admin/providers", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: { user: { id: "admin-1", role: "admin" } },
		params: {},
		url: new URL("http://localhost/api/admin/providers"),
		route: { id: "/api/admin/providers" },
	} as ProviderPostEvent;
}

describe("admin providers collection route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAdmin.mockReturnValue(undefined);
		mockValidateProviderConnection.mockResolvedValue({ valid: true });
		mockCreateProvider.mockResolvedValue({
			id: "provider-1",
			name: "disabled_provider",
			displayName: "Disabled Provider",
			baseUrl: "https://provider.example/v1",
			modelName: "example-model",
			enabled: false,
			maxModelContext: null,
		});
	});

	it("creates a disabled third-party provider without max model context", async () => {
		const response = await POST(
			makePostEvent({
				name: "disabled_provider",
				displayName: "Disabled Provider",
				baseUrl: "https://provider.example/v1",
				apiKey: "test-key",
				modelName: "example-model",
				enabled: false,
				maxModelContext: null,
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(201);
		expect(data.provider.name).toBe("disabled_provider");
		expect(mockCreateProvider).toHaveBeenCalledWith(
			expect.objectContaining({
				enabled: false,
				maxModelContext: null,
			}),
		);
		expect(mockClearProvidersCache).toHaveBeenCalled();
		expect(mockRefreshConfig).toHaveBeenCalled();
	});

	it("rejects an enabled third-party provider without max model context", async () => {
		const response = await POST(
			makePostEvent({
				name: "enabled_provider",
				displayName: "Enabled Provider",
				baseUrl: "https://provider.example/v1",
				apiKey: "test-key",
				modelName: "example-model",
				enabled: true,
				maxModelContext: null,
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toBe("Max model context is required");
		expect(mockValidateProviderConnection).not.toHaveBeenCalled();
		expect(mockCreateProvider).not.toHaveBeenCalled();
		expect(mockClearProvidersCache).not.toHaveBeenCalled();
	});

	it("passes the selected model name when validating a Fire Pass provider", async () => {
		const response = await POST(
			makePostEvent({
				name: "firepass",
				displayName: "Fire Pass",
				baseUrl: "https://api.fireworks.ai/inference/v1",
				apiKey: "fpk_test_key",
				modelName: "accounts/fireworks/routers/kimi-k2p6-turbo",
				enabled: true,
				maxModelContext: 256000,
			}),
		);

		expect(response.status).toBe(201);
		expect(mockValidateProviderConnection).toHaveBeenCalledWith(
			"https://api.fireworks.ai/inference/v1",
			"fpk_test_key",
			{
				modelName: "accounts/fireworks/routers/kimi-k2p6-turbo",
				reasoningEffort: null,
				thinkingType: null,
			},
		);
	});

	it("passes configured reasoning controls when validating a new provider", async () => {
		const response = await POST(
			makePostEvent({
				name: "firepass",
				displayName: "Fire Pass",
				baseUrl: "https://api.fireworks.ai/inference/v1",
				apiKey: "fpk_test_key",
				modelName: "accounts/fireworks/routers/kimi-k2p6-turbo",
				reasoningEffort: "high",
				thinkingType: "enabled",
				enabled: true,
				maxModelContext: 256000,
			}),
		);

		expect(response.status).toBe(201);
		expect(mockValidateProviderConnection).toHaveBeenCalledWith(
			"https://api.fireworks.ai/inference/v1",
			"fpk_test_key",
			{
				modelName: "accounts/fireworks/routers/kimi-k2p6-turbo",
				reasoningEffort: "high",
				thinkingType: "enabled",
			},
		);
	});

	it("passes fallback config when creating a provider", async () => {
		mockCreateProvider.mockResolvedValueOnce({
			id: "provider-1",
			name: "firepass",
			displayName: "Fire Pass",
			baseUrl: "https://api.fireworks.ai/inference/v1",
			modelName: "accounts/fireworks/routers/kimi-k2p6-turbo",
			enabled: true,
			maxModelContext: 262_144,
			rateLimitFallbackEnabled: true,
			rateLimitFallbackBaseUrl: "https://api.moonshot.ai/v1",
			rateLimitFallbackModelName: "kimi-k2.6",
			rateLimitFallbackTimeoutMs: 12_000,
		});

		const response = await POST(
			makePostEvent({
				name: "firepass",
				displayName: "Fire Pass",
				baseUrl: "https://api.fireworks.ai/inference/v1",
				apiKey: "fpk_test_key",
				modelName: "accounts/fireworks/routers/kimi-k2p6-turbo",
				enabled: true,
				maxModelContext: 262_144,
				rateLimitFallbackEnabled: true,
				rateLimitFallbackBaseUrl: "https://api.moonshot.ai/v1",
				rateLimitFallbackApiKey: "fallback-key",
				rateLimitFallbackModelName: "kimi-k2.6",
				rateLimitFallbackTimeoutMs: 12_000,
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(201);
		expect(mockCreateProvider).toHaveBeenCalledWith(
			expect.objectContaining({
				rateLimitFallbackEnabled: true,
				rateLimitFallbackBaseUrl: "https://api.moonshot.ai/v1",
				rateLimitFallbackApiKey: "fallback-key",
				rateLimitFallbackModelName: "kimi-k2.6",
				rateLimitFallbackTimeoutMs: 12_000,
			}),
		);
		expect(data.provider).not.toHaveProperty("rateLimitFallbackApiKey");
		expect(data.provider).not.toHaveProperty("rateLimitFallbackApiKeyEncrypted");
		expect(mockValidateProviderConnection).toHaveBeenCalledWith(
			"https://api.moonshot.ai/v1",
			"fallback-key",
			{ modelName: "kimi-k2.6" },
		);
	});

	it("rejects enabled fallback config without a fallback API key", async () => {
		const response = await POST(
			makePostEvent({
				name: "firepass",
				displayName: "Fire Pass",
				baseUrl: "https://api.fireworks.ai/inference/v1",
				apiKey: "fpk_test_key",
				modelName: "accounts/fireworks/routers/kimi-k2p6-turbo",
				enabled: true,
				maxModelContext: 262_144,
				rateLimitFallbackEnabled: true,
				rateLimitFallbackBaseUrl: "https://api.moonshot.ai/v1",
				rateLimitFallbackApiKey: "",
				rateLimitFallbackModelName: "kimi-k2.6",
				rateLimitFallbackTimeoutMs: 12_000,
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toBe("Rate-limit fallback API key is required");
		expect(mockCreateProvider).not.toHaveBeenCalled();
	});

	it("uses researched Fireworks limits as defaults for Fire Pass Kimi Turbo", async () => {
		const response = await POST(
			makePostEvent({
				name: "firepass",
				displayName: "Fire Pass",
				baseUrl: "https://api.fireworks.ai/inference/v1",
				apiKey: "fpk_test_key",
				modelName: "accounts/fireworks/routers/kimi-k2p6-turbo",
				enabled: true,
			}),
		);

		expect(response.status).toBe(201);
		expect(mockCreateProvider).toHaveBeenCalledWith(
			expect.objectContaining({
				maxModelContext: 262_144,
				maxMessageLength: 1_048_576,
			}),
		);
	});

	it("rejects fallback timeouts below one second", async () => {
		const response = await POST(
			makePostEvent({
				name: "firepass",
				displayName: "Fire Pass",
				baseUrl: "https://api.fireworks.ai/inference/v1",
				apiKey: "fpk_test_key",
				modelName: "accounts/fireworks/routers/kimi-k2p6-turbo",
				enabled: true,
				maxModelContext: 262_144,
				rateLimitFallbackEnabled: true,
				rateLimitFallbackBaseUrl: "https://api.moonshot.ai/v1",
				rateLimitFallbackApiKey: "fallback-key",
				rateLimitFallbackModelName: "kimi-k2.6",
				rateLimitFallbackTimeoutMs: 999,
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toBe("Rate-limit fallback timeout must be at least 1000");
		expect(mockValidateProviderConnection).not.toHaveBeenCalled();
		expect(mockCreateProvider).not.toHaveBeenCalled();
	});
});
