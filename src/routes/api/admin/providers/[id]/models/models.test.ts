import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAdmin: vi.fn(),
}));

vi.mock("$lib/server/services/provider-models", async () => {
	return {
		createProviderModel: vi.fn(),
		createProviderModelFromPayload: vi.fn(),
		listProviderModels: vi.fn(),
	};
});

import { requireAdmin } from "$lib/server/auth/hooks";
import {
	createProviderModel,
	createProviderModelFromPayload,
	listProviderModels,
} from "$lib/server/services/provider-models";
import { GET, POST } from "./+server";

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockCreateProviderModel = createProviderModel as ReturnType<typeof vi.fn>;
const mockCreateProviderModelFromPayload =
	createProviderModelFromPayload as ReturnType<typeof vi.fn>;
const mockListProviderModels = listProviderModels as ReturnType<typeof vi.fn>;

type ModelsEvent = Parameters<typeof POST>[0];

function makeEvent(body?: unknown): ModelsEvent {
	return {
		request: new Request(
			"http://localhost/api/admin/providers/provider-1/models",
			{
				method: body !== undefined ? "POST" : "GET",
				headers: { "Content-Type": "application/json" },
				body: body !== undefined ? JSON.stringify(body) : undefined,
			},
		),
		locals: { user: { id: "admin-1", role: "admin" } },
		params: { id: "provider-1" },
		url: new URL("http://localhost/api/admin/providers/provider-1/models"),
		route: { id: "/api/admin/providers/[id]/models" },
	} as ModelsEvent;
}

function validationError(message: string): Error {
	const error = new Error(message);
	error.name = "ProviderModelValidationError";
	return error;
}

describe("admin provider models collection route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAdmin.mockReturnValue(undefined);
		mockCreateProviderModel.mockResolvedValue({
			id: "model-1",
			providerId: "provider-1",
			name: "test-model",
			displayName: "Test Model",
			maxModelContext: 262144,
			compactionUiThreshold: 209715,
			targetConstructedContext: 157286,
			maxMessageLength: null,
			maxTokens: null,
			reasoningEffort: null,
			thinkingType: null,
			capabilitiesJson: "{}",
			inputUsdMicrosPer1m: 0,
			cachedInputUsdMicrosPer1m: 0,
			cacheHitUsdMicrosPer1m: 0,
			cacheMissUsdMicrosPer1m: 0,
			outputUsdMicrosPer1m: 0,
			enabled: true,
			sortOrder: 0,
			createdAt: new Date("2026-06-01T12:00:00.000Z"),
			updatedAt: new Date("2026-06-01T12:00:00.000Z"),
		});
		mockCreateProviderModelFromPayload.mockResolvedValue({
			id: "model-1",
			providerId: "provider-1",
			name: "test-model",
			displayName: "Test Model",
			maxModelContext: 262144,
			compactionUiThreshold: 209715,
			targetConstructedContext: 157286,
			maxMessageLength: null,
			maxTokens: null,
			reasoningEffort: null,
			thinkingType: null,
			capabilitiesJson: "{}",
			inputUsdMicrosPer1m: 0,
			cachedInputUsdMicrosPer1m: 0,
			cacheHitUsdMicrosPer1m: 0,
			cacheMissUsdMicrosPer1m: 0,
			outputUsdMicrosPer1m: 0,
			enabled: true,
			sortOrder: 0,
			createdAt: new Date("2026-06-01T12:00:00.000Z"),
			updatedAt: new Date("2026-06-01T12:00:00.000Z"),
		});
		mockListProviderModels.mockResolvedValue([]);
	});

	describe("GET", () => {
		it("lists models for the provider", async () => {
			mockListProviderModels.mockResolvedValue([
				{
					id: "model-1",
					providerId: "provider-1",
					name: "gpt-4",
					displayName: "GPT-4",
					maxModelContext: 128000,
					compactionUiThreshold: null,
					targetConstructedContext: null,
					maxMessageLength: null,
					maxTokens: null,
					reasoningEffort: null,
					thinkingType: null,
					capabilitiesJson: "{}",
					inputUsdMicrosPer1m: 30,
					cachedInputUsdMicrosPer1m: 15,
					cacheHitUsdMicrosPer1m: 0,
					cacheMissUsdMicrosPer1m: 0,
					outputUsdMicrosPer1m: 60,
					enabled: true,
					sortOrder: 0,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			]);

			const response = await GET(makeEvent());
			const data = await response.json();

			expect(response.status).toBe(200);
			expect(mockListProviderModels).toHaveBeenCalledWith("provider-1");
			expect(data).toEqual({
				models: expect.arrayContaining([
					expect.objectContaining({ id: "model-1", name: "gpt-4" }),
				]),
			});
		});

		it("returns empty array when no models exist", async () => {
			mockListProviderModels.mockResolvedValue([]);

			const response = await GET(makeEvent());
			const data = await response.json();

			expect(response.status).toBe(200);
			expect(data.models).toEqual([]);
		});

		it("returns 500 on service failure", async () => {
			mockListProviderModels.mockRejectedValue(new Error("DB error"));

			const response = await GET(makeEvent());
			const data = await response.json();

			expect(response.status).toBe(500);
			expect(data.error).toBe("Failed to list provider models");
		});
	});

	describe("POST", () => {
		it("creates a model with required name", async () => {
			const payload = { name: "gpt-4o" };
			const response = await POST(makeEvent(payload));
			const data = await response.json();

			expect(response.status).toBe(201);
			expect(data.model.name).toBe("test-model");
			expect(mockCreateProviderModelFromPayload).toHaveBeenCalledWith(
				"provider-1",
				payload,
			);
			expect(mockCreateProviderModel).not.toHaveBeenCalled();
		});

		it("creates a model with display name and context settings", async () => {
			const payload = {
				name: "claude-3",
				displayName: "Claude 3",
				maxModelContext: 200000,
				compactionUiThreshold: 160000,
				targetConstructedContext: 120000,
			};
			const response = await POST(makeEvent(payload));

			expect(response.status).toBe(201);
			expect(mockCreateProviderModelFromPayload).toHaveBeenCalledWith(
				"provider-1",
				payload,
			);
		});

		it("creates a model with pricing fields", async () => {
			const payload = {
				name: "pricing-model",
				inputUsdMicrosPer1m: 15,
				cachedInputUsdMicrosPer1m: 7,
				outputUsdMicrosPer1m: 60,
			};
			const response = await POST(makeEvent(payload));

			expect(response.status).toBe(201);
			expect(mockCreateProviderModelFromPayload).toHaveBeenCalledWith(
				"provider-1",
				payload,
			);
		});

		it("creates a model with reasoning effort and thinking type", async () => {
			const payload = {
				name: "reasoning-model",
				reasoningEffort: "high",
				thinkingType: "enabled",
			};
			const response = await POST(makeEvent(payload));

			expect(response.status).toBe(201);
			expect(mockCreateProviderModelFromPayload).toHaveBeenCalledWith(
				"provider-1",
				payload,
			);
		});

		it("creates a model with capabilities JSON", async () => {
			const payload = {
				name: "capable-model",
				capabilitiesJson: '{"vision":true}',
			};
			const response = await POST(makeEvent(payload));

			expect(response.status).toBe(201);
			expect(mockCreateProviderModelFromPayload).toHaveBeenCalledWith(
				"provider-1",
				payload,
			);
		});

		it("creates a disabled model", async () => {
			mockCreateProviderModelFromPayload.mockResolvedValue({
				id: "model-2",
				providerId: "provider-1",
				name: "disabled-model",
				displayName: "Disabled Model",
				maxModelContext: null,
				compactionUiThreshold: null,
				targetConstructedContext: null,
				maxMessageLength: null,
				maxTokens: null,
				reasoningEffort: null,
				thinkingType: null,
				capabilitiesJson: "{}",
				inputUsdMicrosPer1m: 0,
				cachedInputUsdMicrosPer1m: 0,
				cacheHitUsdMicrosPer1m: 0,
				cacheMissUsdMicrosPer1m: 0,
				outputUsdMicrosPer1m: 0,
				enabled: false,
				sortOrder: 0,
				createdAt: new Date("2026-06-01T12:00:00.000Z"),
				updatedAt: new Date("2026-06-01T12:00:00.000Z"),
			});

			const response = await POST(
				makeEvent({ name: "disabled-model", enabled: false }),
			);
			const data = await response.json();

			expect(response.status).toBe(201);
			expect(data.model.enabled).toBe(false);
			expect(mockCreateProviderModelFromPayload).toHaveBeenCalledWith(
				"provider-1",
				{ name: "disabled-model", enabled: false },
			);
		});

		it("rejects missing name", async () => {
			mockCreateProviderModelFromPayload.mockRejectedValue(
				validationError("name is required"),
			);
			const response = await POST(makeEvent({ displayName: "No Name" }));
			const data = await response.json();

			expect(response.status).toBe(400);
			expect(data.error).toContain("name");
		});

		it("rejects empty name", async () => {
			mockCreateProviderModelFromPayload.mockRejectedValue(
				validationError("name is required"),
			);
			const response = await POST(makeEvent({ name: "   " }));
			const data = await response.json();

			expect(response.status).toBe(400);
			expect(data.error).toContain("name");
		});

		it("rejects invalid maxModelContext type", async () => {
			mockCreateProviderModelFromPayload.mockRejectedValue(
				validationError("maxModelContext must be a non-negative number"),
			);
			const response = await POST(
				makeEvent({ name: "bad", maxModelContext: "not-a-number" }),
			);
			const data = await response.json();

			expect(response.status).toBe(400);
			expect(data.error).toContain("maxModelContext");
		});

		it("rejects negative maxModelContext", async () => {
			mockCreateProviderModelFromPayload.mockRejectedValue(
				validationError("maxModelContext must be a non-negative number"),
			);
			const response = await POST(
				makeEvent({ name: "bad", maxModelContext: -1 }),
			);
			const data = await response.json();

			expect(response.status).toBe(400);
			expect(data.error).toContain("maxModelContext");
		});

		it("rejects invalid enabled type", async () => {
			mockCreateProviderModelFromPayload.mockRejectedValue(
				validationError("enabled must be a boolean"),
			);
			const response = await POST(makeEvent({ name: "bad", enabled: "yes" }));
			const data = await response.json();

			expect(response.status).toBe(400);
			expect(data.error).toContain("enabled");
		});

		it("returns 404 when provider does not exist", async () => {
			mockCreateProviderModelFromPayload.mockRejectedValue(
				new Error('Provider with id "provider-1" does not exist'),
			);

			const response = await POST(makeEvent({ name: "ghost-model" }));
			const data = await response.json();

			expect(response.status).toBe(404);
			expect(data.error).toContain("does not exist");
		});

		it("returns 500 on unexpected service failure", async () => {
			mockCreateProviderModelFromPayload.mockRejectedValue(
				new Error("DB error"),
			);

			const response = await POST(makeEvent({ name: "broken" }));
			const data = await response.json();

			expect(response.status).toBe(500);
			expect(data.error).toContain("Failed to create");
		});
	});
});
