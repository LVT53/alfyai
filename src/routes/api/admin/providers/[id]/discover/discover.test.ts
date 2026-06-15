import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAdmin: vi.fn(),
}));

vi.mock("$lib/server/services/providers", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/providers")
	>("$lib/server/services/providers");

	return {
		...actual,
		decryptApiKey: vi.fn(),
		getProviderWithSecrets: vi.fn(),
		modelDiscovery: vi.fn(),
	};
});

import { requireAdmin } from "$lib/server/auth/hooks";
import {
	decryptApiKey,
	getProviderWithSecrets,
	modelDiscovery,
} from "$lib/server/services/providers";
import { POST } from "./+server";

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockDecryptApiKey = decryptApiKey as ReturnType<typeof vi.fn>;
const mockGetProviderWithSecrets = getProviderWithSecrets as ReturnType<
	typeof vi.fn
>;
const mockModelDiscovery = modelDiscovery as ReturnType<typeof vi.fn>;

type DiscoverEvent = Parameters<typeof POST>[0];

function makeDiscoverEvent(): DiscoverEvent {
	return {
		request: new Request(
			"http://localhost/api/admin/providers/provider-1/discover",
			{ method: "POST" },
		),
		locals: { user: { id: "admin-1", role: "admin" } },
		params: { id: "provider-1" },
		url: new URL("http://localhost/api/admin/providers/provider-1/discover"),
		route: { id: "/api/admin/providers/[id]/discover" },
	} as DiscoverEvent;
}

describe("admin provider discover route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAdmin.mockReturnValue(undefined);
		mockDecryptApiKey.mockReturnValue("decrypted-secret");
		mockGetProviderWithSecrets.mockResolvedValue({
			id: "provider-1",
			name: "test-provider",
			displayName: "Test Provider",
			baseUrl: "https://api.example.com/v1",
			apiKeyEncrypted: "encrypted",
			apiKeyIv: "iv",
			iconAssetId: null,
			processingRegionCode: null,
			privacyPolicyUrl: null,
			rateLimitFallbackEnabled: false,
			rateLimitFallbackBaseUrl: null,
			rateLimitFallbackModelName: null,
			rateLimitFallbackTimeoutMs: 10000,
			sortOrder: 0,
			enabled: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		});
	});

	it("returns discovered model IDs", async () => {
		mockModelDiscovery.mockResolvedValue([
			"gpt-4",
			"gpt-4-turbo",
			"gpt-3.5-turbo",
		]);

		const response = await POST(makeDiscoverEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data).toEqual({
			models: ["gpt-4", "gpt-4-turbo", "gpt-3.5-turbo"],
		});
		expect(mockModelDiscovery).toHaveBeenCalledWith(
			"https://api.example.com/v1",
			"decrypted-secret",
		);
	});

	it("returns empty model list when none found", async () => {
		mockModelDiscovery.mockResolvedValue([]);

		const response = await POST(makeDiscoverEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data).toEqual({ models: [] });
	});

	it("returns 400 for invalid API key", async () => {
		mockModelDiscovery.mockRejectedValue(new Error("Invalid API key"));

		const response = await POST(makeDiscoverEvent());
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toBe("Invalid API key");
	});

	it("returns 400 when endpoint not supported", async () => {
		mockModelDiscovery.mockRejectedValue(
			new Error("Model discovery endpoint not supported by this provider"),
		);

		const response = await POST(makeDiscoverEvent());
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toContain("not supported");
	});

	it("returns 502 on discovery failure", async () => {
		mockModelDiscovery.mockRejectedValue(
			new Error("Model discovery failed: network error"),
		);

		const response = await POST(makeDiscoverEvent());
		const data = await response.json();

		expect(response.status).toBe(502);
		expect(data.error).toContain("Model discovery failed");
	});

	it("returns 500 on decryption failure", async () => {
		mockDecryptApiKey.mockImplementation(() => {
			throw new Error("cipher");
		});

		const response = await POST(makeDiscoverEvent());
		const data = await response.json();

		expect(response.status).toBe(500);
		expect(data.error).toBe("Failed to decrypt API key");
		expect(mockModelDiscovery).not.toHaveBeenCalled();
	});

	it("returns 404 when provider not found", async () => {
		mockGetProviderWithSecrets.mockResolvedValue(null);

		const response = await POST(makeDiscoverEvent());
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data.error).toBe("Provider not found");
	});
});
