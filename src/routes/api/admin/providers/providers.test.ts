import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAdmin: vi.fn(),
}));

vi.mock("$lib/server/config-store", () => ({
	refreshConfig: vi.fn(),
}));

vi.mock("$lib/server/services/providers", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/providers")
	>("$lib/server/services/providers");

	return {
		...actual,
		createProvider: vi.fn(),
		listProviders: vi.fn(),
		validateProviderConnection: vi.fn(),
		validateProviderName: vi.fn(),
	};
});

import { requireAdmin } from "$lib/server/auth/hooks";
import { refreshConfig } from "$lib/server/config-store";
import {
	createProvider,
	listProviders,
	validateProviderConnection,
	validateProviderName,
} from "$lib/server/services/providers";
import { GET, POST } from "./+server";

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockRefreshConfig = refreshConfig as ReturnType<typeof vi.fn>;
const mockCreateProvider = createProvider as ReturnType<typeof vi.fn>;
const mockListProviders = listProviders as ReturnType<typeof vi.fn>;
const mockValidateProviderConnection = validateProviderConnection as ReturnType<
	typeof vi.fn
>;
const mockValidateProviderName = validateProviderName as ReturnType<
	typeof vi.fn
>;

type ProviderEvent = Parameters<typeof POST>[0];

function makeEvent(body?: unknown): ProviderEvent {
	return {
		request: new Request("http://localhost/api/admin/providers", {
			method: body !== undefined ? "POST" : "GET",
			headers: { "Content-Type": "application/json" },
			body: body !== undefined ? JSON.stringify(body) : undefined,
		}),
		locals: { user: { id: "admin-1", role: "admin" } },
		params: {},
		url: new URL("http://localhost/api/admin/providers"),
		route: { id: "/api/admin/providers" },
	} as ProviderEvent;
}

describe("admin providers collection route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAdmin.mockReturnValue(undefined);
		mockValidateProviderName.mockReturnValue(true);
		mockValidateProviderConnection.mockResolvedValue({ valid: true });
		mockCreateProvider.mockResolvedValue({
			id: "provider-1",
			name: "test-provider",
			displayName: "Test Provider",
			baseUrl: "https://api.example.com/v1",
			iconAssetId: null,
			rateLimitFallbackEnabled: false,
			rateLimitFallbackBaseUrl: null,
			rateLimitFallbackModelName: null,
			rateLimitFallbackTimeoutMs: 10000,
			sortOrder: 0,
			enabled: true,
			createdAt: new Date("2026-06-01T12:00:00.000Z"),
			updatedAt: new Date("2026-06-01T12:00:00.000Z"),
		});
		mockListProviders.mockResolvedValue([]);
	});

	describe("GET", () => {
		it("returns the provider list", async () => {
			mockListProviders.mockResolvedValue([
				{
					id: "p-1",
					name: "a",
					displayName: "A",
					baseUrl: "https://a.example/v1",
					iconAssetId: null,
					rateLimitFallbackEnabled: false,
					rateLimitFallbackBaseUrl: null,
					rateLimitFallbackModelName: null,
					rateLimitFallbackTimeoutMs: 10000,
					sortOrder: 0,
					enabled: true,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			]);

			const response = await GET(makeEvent());
			const data = await response.json();

			expect(response.status).toBe(200);
			expect(data).toEqual({
				providers: expect.arrayContaining([
					expect.objectContaining({ id: "p-1", name: "a" }),
				]),
			});
		});

		it("returns 500 on service failure", async () => {
			mockListProviders.mockRejectedValue(new Error("DB error"));

			const response = await GET(makeEvent());
			const data = await response.json();

			expect(response.status).toBe(500);
			expect(data.error).toBe("Failed to list providers");
		});
	});

	describe("POST", () => {
		it("creates a provider with required fields", async () => {
			const response = await POST(
				makeEvent({
					name: "test-provider",
					displayName: "Test Provider",
					baseUrl: "https://api.example.com/v1",
					apiKey: "sk-test-key",
				}),
			);
			const data = await response.json();

			expect(response.status).toBe(201);
			expect(data.provider.name).toBe("test-provider");
			expect(mockCreateProvider).toHaveBeenCalledWith(
				expect.objectContaining({
					name: "test-provider",
					displayName: "Test Provider",
					baseUrl: "https://api.example.com/v1",
					apiKey: "sk-test-key",
					enabled: undefined,
				}),
			);
			expect(mockRefreshConfig).toHaveBeenCalled();
		});

		it("creates a disabled provider when enabled is false", async () => {
			mockCreateProvider.mockResolvedValue({
				id: "provider-2",
				name: "disabled-provider",
				displayName: "Disabled",
				baseUrl: "https://api.example.com/v1",
				iconAssetId: null,
				rateLimitFallbackEnabled: false,
				rateLimitFallbackBaseUrl: null,
				rateLimitFallbackModelName: null,
				rateLimitFallbackTimeoutMs: 10000,
				sortOrder: 0,
				enabled: false,
				createdAt: new Date("2026-06-01T12:00:00.000Z"),
				updatedAt: new Date("2026-06-01T12:00:00.000Z"),
			});

			const response = await POST(
				makeEvent({
					name: "disabled-provider",
					displayName: "Disabled",
					baseUrl: "https://api.example.com/v1",
					apiKey: "sk-test-key",
					enabled: false,
				}),
			);
			const data = await response.json();

			expect(response.status).toBe(201);
			expect(data.provider.name).toBe("disabled-provider");
			expect(mockCreateProvider).toHaveBeenCalledWith(
				expect.objectContaining({ enabled: false }),
			);
		});

		it("passes rate-limit fallback fields through", async () => {
			const response = await POST(
				makeEvent({
					name: "fallback-provider",
					displayName: "Fallback",
					baseUrl: "https://api.example.com/v1",
					apiKey: "sk-test-key",
					rateLimitFallbackEnabled: true,
					rateLimitFallbackBaseUrl: "https://fallback.example/v1",
					rateLimitFallbackApiKey: "sk-fallback",
					rateLimitFallbackModelName: "fallback-model",
					rateLimitFallbackTimeoutMs: 15000,
				}),
			);

			expect(response.status).toBe(201);
			expect(mockCreateProvider).toHaveBeenCalledWith(
				expect.objectContaining({
					rateLimitFallbackEnabled: true,
					rateLimitFallbackBaseUrl: "https://fallback.example/v1",
					rateLimitFallbackApiKey: "sk-fallback",
					rateLimitFallbackModelName: "fallback-model",
					rateLimitFallbackTimeoutMs: 15000,
				}),
			);
		});

		it("rejects missing name", async () => {
			const response = await POST(
				makeEvent({
					displayName: "No Name",
					baseUrl: "https://api.example.com/v1",
					apiKey: "sk-test-key",
				}),
			);
			const data = await response.json();

			expect(response.status).toBe(400);
			expect(data.error).toContain("required");
		});

		it("rejects invalid name format", async () => {
			mockValidateProviderName.mockReturnValue(false);

			const response = await POST(
				makeEvent({
					name: "invalid name!",
					displayName: "Bad Name",
					baseUrl: "https://api.example.com/v1",
					apiKey: "sk-test-key",
				}),
			);
			const data = await response.json();

			expect(response.status).toBe(400);
			expect(data.error).toContain("letters, numbers");
		});

		it("rejects failed connection test", async () => {
			mockValidateProviderConnection.mockResolvedValue({
				valid: false,
				error: "Invalid API key",
			});

			const response = await POST(
				makeEvent({
					name: "bad-conn",
					displayName: "Bad Connection",
					baseUrl: "https://api.example.com/v1",
					apiKey: "sk-bad",
				}),
			);
			const data = await response.json();

			expect(response.status).toBe(400);
			expect(data.error).toBe("Invalid API key");
			expect(mockCreateProvider).not.toHaveBeenCalled();
		});

		it("returns 409 on duplicate name", async () => {
			mockCreateProvider.mockRejectedValue(
				new Error("UNIQUE constraint failed: providers.name"),
			);

			const response = await POST(
				makeEvent({
					name: "duplicate",
					displayName: "Duplicate",
					baseUrl: "https://api.example.com/v1",
					apiKey: "sk-test-key",
				}),
			);
			const data = await response.json();

			expect(response.status).toBe(409);
			expect(data.error).toContain("already exists");
		});

		it("passes sortOrder when provided", async () => {
			const response = await POST(
				makeEvent({
					name: "sorted",
					displayName: "Sorted",
					baseUrl: "https://api.example.com/v1",
					apiKey: "sk-test-key",
					sortOrder: 5,
				}),
			);

			expect(response.status).toBe(201);
			expect(mockCreateProvider).toHaveBeenCalledWith(
				expect.objectContaining({ sortOrder: 5 }),
			);
		});
	});
});
