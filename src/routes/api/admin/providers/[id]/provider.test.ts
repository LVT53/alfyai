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
		deleteProvider: vi.fn(),
		updateProvider: vi.fn(),
	};
});

import { requireAdmin } from "$lib/server/auth/hooks";
import { refreshConfig } from "$lib/server/config-store";
import { deleteProvider, updateProvider } from "$lib/server/services/providers";
import { PUT, DELETE } from "./+server";

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockRefreshConfig = refreshConfig as ReturnType<typeof vi.fn>;
const mockUpdateProvider = updateProvider as ReturnType<typeof vi.fn>;
const mockDeleteProvider = deleteProvider as ReturnType<typeof vi.fn>;

type ProviderDetailEvent = Parameters<typeof PUT>[0];

function makeEvent(method: "PUT" | "DELETE", body?: unknown): ProviderDetailEvent {
	return {
		request: new Request(
			"http://localhost/api/admin/providers/provider-1",
			{
				method,
				headers: { "Content-Type": "application/json" },
				body: body !== undefined ? JSON.stringify(body) : undefined,
			},
		),
		locals: { user: { id: "admin-1", role: "admin" } },
		params: { id: "provider-1" },
		url: new URL("http://localhost/api/admin/providers/provider-1"),
		route: { id: "/api/admin/providers/[id]" },
	} as ProviderDetailEvent;
}

describe("admin provider detail route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAdmin.mockReturnValue(undefined);
		mockUpdateProvider.mockResolvedValue({
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
		mockDeleteProvider.mockResolvedValue(true);
	});

	describe("PUT", () => {
		it("updates display name", async () => {
			const response = await PUT(
				makeEvent("PUT", { displayName: "Updated Name" }),
			);
			const data = await response.json();

			expect(response.status).toBe(200);
			expect(data.provider.displayName).toBe("Test Provider");
			expect(mockUpdateProvider).toHaveBeenCalledWith(
				"provider-1",
				expect.objectContaining({ displayName: "Updated Name" }),
			);
			expect(mockRefreshConfig).toHaveBeenCalled();
		});

		it("updates enabled flag", async () => {
			mockUpdateProvider.mockResolvedValue({
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
				enabled: false,
				createdAt: new Date(),
				updatedAt: new Date(),
			});

			const response = await PUT(
				makeEvent("PUT", { enabled: false }),
			);
			const data = await response.json();

			expect(response.status).toBe(200);
			expect(data.provider.enabled).toBe(false);
			expect(mockUpdateProvider).toHaveBeenCalledWith(
				"provider-1",
				expect.objectContaining({ enabled: false }),
			);
		});

		it("updates base URL", async () => {
			const response = await PUT(
				makeEvent("PUT", { baseUrl: "https://new.example/v1" }),
			);

			expect(response.status).toBe(200);
			expect(mockUpdateProvider).toHaveBeenCalledWith(
				"provider-1",
				expect.objectContaining({ baseUrl: "https://new.example/v1" }),
			);
		});

		it("updates API key", async () => {
			const response = await PUT(
				makeEvent("PUT", { apiKey: "sk-new-key" }),
			);

			expect(response.status).toBe(200);
			expect(mockUpdateProvider).toHaveBeenCalledWith(
				"provider-1",
				expect.objectContaining({ apiKey: "sk-new-key" }),
			);
		});

		it("updates rate-limit fallback fields", async () => {
			const response = await PUT(
				makeEvent("PUT", {
					rateLimitFallbackEnabled: true,
					rateLimitFallbackBaseUrl: "https://fallback.example/v1",
					rateLimitFallbackApiKey: "sk-fallback",
					rateLimitFallbackModelName: "fallback-model",
					rateLimitFallbackTimeoutMs: 15000,
				}),
			);

			expect(response.status).toBe(200);
			expect(mockUpdateProvider).toHaveBeenCalledWith(
				"provider-1",
				expect.objectContaining({
					rateLimitFallbackEnabled: true,
					rateLimitFallbackBaseUrl: "https://fallback.example/v1",
					rateLimitFallbackApiKey: "sk-fallback",
					rateLimitFallbackModelName: "fallback-model",
					rateLimitFallbackTimeoutMs: 15000,
				}),
			);
		});

		it("updates sortOrder", async () => {
			const response = await PUT(
				makeEvent("PUT", { sortOrder: 3 }),
			);

			expect(response.status).toBe(200);
			expect(mockUpdateProvider).toHaveBeenCalledWith(
				"provider-1",
				expect.objectContaining({ sortOrder: 3 }),
			);
		});

		it("clears iconAssetId when empty string is passed", async () => {
			const response = await PUT(
				makeEvent("PUT", { iconAssetId: "" }),
			);

			expect(response.status).toBe(200);
			expect(mockUpdateProvider).toHaveBeenCalledWith(
				"provider-1",
				expect.objectContaining({ iconAssetId: null }),
			);
		});

		it("returns 404 when provider not found", async () => {
			mockUpdateProvider.mockResolvedValue(null);

			const response = await PUT(
				makeEvent("PUT", { displayName: "Ghost" }),
			);
			const data = await response.json();

			expect(response.status).toBe(404);
			expect(data.error).toBe("Provider not found");
		});

		it("rejects invalid types", async () => {
			const response = await PUT(
				makeEvent("PUT", { enabled: "not-a-boolean" }),
			);
			const data = await response.json();

			expect(response.status).toBe(400);
			expect(data.error).toContain("boolean");
		});
	});

	describe("DELETE", () => {
		it("deletes a provider", async () => {
			const response = await DELETE(makeEvent("DELETE"));
			const data = await response.json();

			expect(response.status).toBe(200);
			expect(data.success).toBe(true);
			expect(mockDeleteProvider).toHaveBeenCalledWith("provider-1");
			expect(mockRefreshConfig).toHaveBeenCalled();
		});

		it("returns 404 when provider not found", async () => {
			mockDeleteProvider.mockResolvedValue(false);

			const response = await DELETE(makeEvent("DELETE"));
			const data = await response.json();

			expect(response.status).toBe(404);
			expect(data.error).toBe("Provider not found");
		});
	});
});
