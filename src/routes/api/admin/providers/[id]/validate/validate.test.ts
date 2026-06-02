import { beforeEach, describe, expect, it, vi } from "vitest";
import { createModelCapabilitySet } from "$lib/model-capabilities";

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
import { clearProvidersCache, refreshConfig } from "$lib/server/config-store";
import {
	decryptApiKey,
	getProviderWithSecrets,
	updateProvider,
	validateProviderConnection,
} from "$lib/server/services/inference-providers";
import { POST } from "./+server";

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockClearProvidersCache = clearProvidersCache as ReturnType<typeof vi.fn>;
const mockRefreshConfig = refreshConfig as ReturnType<typeof vi.fn>;
const mockDecryptApiKey = decryptApiKey as ReturnType<typeof vi.fn>;
const mockGetProviderWithSecrets = getProviderWithSecrets as ReturnType<
	typeof vi.fn
>;
const mockUpdateProvider = updateProvider as ReturnType<typeof vi.fn>;
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
		mockDecryptApiKey.mockReturnValue("secret");
		mockGetProviderWithSecrets.mockResolvedValue({
			id: "provider-1",
			name: "firepass",
			displayName: "Fire Pass Turbo",
			baseUrl: "https://api.fireworks.ai/inference/v1",
			apiKeyEncrypted: "encrypted",
			apiKeyIv: "iv",
			modelName: "accounts/fireworks/routers/kimi-k2p6-turbo",
			enabled: true,
			capabilities: createModelCapabilitySet(),
		});
	});

	it("returns and persists capability probe evidence", async () => {
		const capabilities = createModelCapabilitySet({
			chat: { state: "detected", source: "probe" },
			streaming: { state: "detected", source: "probe" },
			tools: { state: "detected", source: "probe" },
		});
		mockValidateProviderConnection.mockResolvedValue({
			valid: true,
			capabilities,
		});

		const response = await POST(makeValidateEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data).toMatchObject({
			valid: true,
			capabilities: {
				chat: { state: "detected", supported: true },
				streaming: { state: "detected", supported: true },
				tools: { state: "detected", supported: true },
			},
		});
		expect(mockUpdateProvider).toHaveBeenCalledWith("provider-1", {
			capabilities,
		});
		expect(mockClearProvidersCache).toHaveBeenCalled();
		expect(mockRefreshConfig).toHaveBeenCalled();
	});

	it("forwards configured reasoning controls when refreshing capability evidence", async () => {
		mockGetProviderWithSecrets.mockResolvedValue({
			id: "provider-1",
			name: "firepass",
			displayName: "Fire Pass Turbo",
			baseUrl: "https://api.fireworks.ai/inference/v1",
			apiKeyEncrypted: "encrypted",
			apiKeyIv: "iv",
			modelName: "accounts/fireworks/routers/kimi-k2p6-turbo",
			reasoningEffort: "high",
			thinkingType: "enabled",
			enabled: true,
			capabilities: createModelCapabilitySet(),
		});
		const capabilities = createModelCapabilitySet({
			reasoningControls: {
				state: "detected",
				source: "manual_override",
				detail: "Admin configured reasoning controls",
			},
		});
		mockValidateProviderConnection.mockResolvedValue({
			valid: true,
			capabilities,
		});

		const response = await POST(makeValidateEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(mockValidateProviderConnection).toHaveBeenCalledWith(
			"https://api.fireworks.ai/inference/v1",
			"secret",
			{
				modelName: "accounts/fireworks/routers/kimi-k2p6-turbo",
				reasoningEffort: "high",
				thinkingType: "enabled",
			},
		);
		expect(data).toMatchObject({
			valid: true,
			capabilities: {
				reasoningControls: {
					state: "detected",
					supported: true,
				},
			},
		});
		expect(mockUpdateProvider).toHaveBeenCalledWith("provider-1", {
			capabilities,
		});
	});
});
