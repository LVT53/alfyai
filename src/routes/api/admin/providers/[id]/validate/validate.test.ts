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
		validateProviderConnection: vi.fn(),
	};
});

import { requireAdmin } from "$lib/server/auth/hooks";
import {
	decryptApiKey,
	getProviderWithSecrets,
	validateProviderConnection,
} from "$lib/server/services/providers";
import { POST } from "./+server";

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockDecryptApiKey = decryptApiKey as ReturnType<typeof vi.fn>;
const mockGetProviderWithSecrets = getProviderWithSecrets as ReturnType<
	typeof vi.fn
>;
const mockValidateProviderConnection = validateProviderConnection as ReturnType<
	typeof vi.fn
>;

type ProviderValidateEvent = Parameters<typeof POST>[0];

function makeValidateEvent(): ProviderValidateEvent {
	return {
		request: new Request(
			"http://localhost/api/admin/providers/provider-1/validate",
			{ method: "POST" },
		),
		locals: { user: { id: "admin-1", role: "admin" } },
		params: { id: "provider-1" },
		url: new URL("http://localhost/api/admin/providers/provider-1/validate"),
		route: { id: "/api/admin/providers/[id]/validate" },
	} as ProviderValidateEvent;
}

describe("admin provider validation route", () => {
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

	it("returns valid connection result", async () => {
		mockValidateProviderConnection.mockResolvedValue({ valid: true });

		const response = await POST(makeValidateEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data).toEqual({ valid: true });
		expect(mockValidateProviderConnection).toHaveBeenCalledWith(
			"https://api.example.com/v1",
			"decrypted-secret",
		);
	});

	it("returns invalid connection result", async () => {
		mockValidateProviderConnection.mockResolvedValue({
			valid: false,
			error: "Invalid API key",
		});

		const response = await POST(makeValidateEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data).toEqual({ valid: false, error: "Invalid API key" });
	});

	it("returns error on decryption failure", async () => {
		mockDecryptApiKey.mockImplementation(() => {
			throw new Error("cipher");
		});

		const response = await POST(makeValidateEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.valid).toBe(false);
		expect(data.error).toBe("Failed to decrypt API key");
		expect(mockValidateProviderConnection).not.toHaveBeenCalled();
	});

	it("returns 404 when provider not found", async () => {
		mockGetProviderWithSecrets.mockResolvedValue(null);

		const response = await POST(makeValidateEvent());
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data.error).toBe("Provider not found");
	});
});
