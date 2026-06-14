import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAdmin: vi.fn(),
}));

vi.mock("$lib/server/services/provider-models", async () => {
	return {
		deleteProviderModel: vi.fn(),
		updateProviderModel: vi.fn(),
		updateProviderModelFromPayload: vi.fn(),
	};
});

import { requireAdmin } from "$lib/server/auth/hooks";
import {
	deleteProviderModel,
	updateProviderModel,
	updateProviderModelFromPayload,
} from "$lib/server/services/provider-models";
import { DELETE, PUT } from "./+server";

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockUpdateProviderModel = updateProviderModel as ReturnType<typeof vi.fn>;
const mockUpdateProviderModelFromPayload =
	updateProviderModelFromPayload as ReturnType<typeof vi.fn>;
const mockDeleteProviderModel = deleteProviderModel as ReturnType<typeof vi.fn>;

type ModelDetailEvent = Parameters<typeof PUT>[0];

function makeEvent(method: "PUT" | "DELETE", body?: unknown): ModelDetailEvent {
	return {
		request: new Request(
			"http://localhost/api/admin/providers/provider-1/models/model-1",
			{
				method,
				headers: { "Content-Type": "application/json" },
				body: body !== undefined ? JSON.stringify(body) : undefined,
			},
		),
		locals: { user: { id: "admin-1", role: "admin" } },
		params: { id: "provider-1", modelId: "model-1" },
		url: new URL(
			"http://localhost/api/admin/providers/provider-1/models/model-1",
		),
		route: { id: "/api/admin/providers/[id]/models/[modelId]" },
	} as ModelDetailEvent;
}

function validationError(message: string): Error {
	const error = new Error(message);
	error.name = "ProviderModelValidationError";
	return error;
}

describe("admin provider model detail route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAdmin.mockReturnValue(undefined);
		mockUpdateProviderModel.mockResolvedValue({
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
		mockUpdateProviderModelFromPayload.mockResolvedValue({
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
		mockDeleteProviderModel.mockResolvedValue(true);
	});

	describe("PUT", () => {
		it("updates display name", async () => {
			const payload = { displayName: "Updated Name" };
			const response = await PUT(makeEvent("PUT", payload));
			const data = await response.json();

			expect(response.status).toBe(200);
			expect(data.model.displayName).toBe("Test Model");
			expect(mockUpdateProviderModelFromPayload).toHaveBeenCalledWith(
				"model-1",
				payload,
			);
			expect(mockUpdateProviderModel).not.toHaveBeenCalled();
		});

		it("updates enabled flag", async () => {
			mockUpdateProviderModelFromPayload.mockResolvedValue({
				id: "model-1",
				providerId: "provider-1",
				name: "test-model",
				displayName: "Test Model",
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
				createdAt: new Date(),
				updatedAt: new Date(),
			});

			const response = await PUT(makeEvent("PUT", { enabled: false }));
			const data = await response.json();

			expect(response.status).toBe(200);
			expect(data.model.enabled).toBe(false);
			expect(mockUpdateProviderModelFromPayload).toHaveBeenCalledWith(
				"model-1",
				{ enabled: false },
			);
		});

		it("updates context window settings", async () => {
			const payload = {
				maxModelContext: 128000,
				compactionUiThreshold: 102400,
				targetConstructedContext: 76800,
			};
			const response = await PUT(makeEvent("PUT", payload));

			expect(response.status).toBe(200);
			expect(mockUpdateProviderModelFromPayload).toHaveBeenCalledWith(
				"model-1",
				payload,
			);
		});

		it("updates max tokens and message length", async () => {
			const payload = { maxTokens: 4096, maxMessageLength: 100000 };
			const response = await PUT(makeEvent("PUT", payload));

			expect(response.status).toBe(200);
			expect(mockUpdateProviderModelFromPayload).toHaveBeenCalledWith(
				"model-1",
				payload,
			);
		});

		it("updates reasoning and thinking settings", async () => {
			const payload = {
				reasoningEffort: "medium",
				thinkingType: "enabled",
			};
			const response = await PUT(makeEvent("PUT", payload));

			expect(response.status).toBe(200);
			expect(mockUpdateProviderModelFromPayload).toHaveBeenCalledWith(
				"model-1",
				payload,
			);
		});

		it("updates pricing fields", async () => {
			const payload = {
				inputUsdMicrosPer1m: 15,
				outputUsdMicrosPer1m: 60,
				cacheHitUsdMicrosPer1m: 5,
				cacheMissUsdMicrosPer1m: 10,
			};
			const response = await PUT(makeEvent("PUT", payload));

			expect(response.status).toBe(200);
			expect(mockUpdateProviderModelFromPayload).toHaveBeenCalledWith(
				"model-1",
				payload,
			);
		});

		it("updates capabilities JSON", async () => {
			const payload = { capabilitiesJson: '{"vision":true,"tools":true}' };
			const response = await PUT(makeEvent("PUT", payload));

			expect(response.status).toBe(200);
			expect(mockUpdateProviderModelFromPayload).toHaveBeenCalledWith(
				"model-1",
				payload,
			);
		});

		it("updates sort order", async () => {
			const payload = { sortOrder: 5 };
			const response = await PUT(makeEvent("PUT", payload));

			expect(response.status).toBe(200);
			expect(mockUpdateProviderModelFromPayload).toHaveBeenCalledWith(
				"model-1",
				payload,
			);
		});

		it("sets nullable fields to null", async () => {
			const payload = {
				maxModelContext: null,
				compactionUiThreshold: null,
			};
			const response = await PUT(makeEvent("PUT", payload));

			expect(response.status).toBe(200);
			expect(mockUpdateProviderModelFromPayload).toHaveBeenCalledWith(
				"model-1",
				payload,
			);
		});

		it("returns 404 when model not found", async () => {
			mockUpdateProviderModelFromPayload.mockResolvedValue(null);

			const response = await PUT(makeEvent("PUT", { displayName: "Ghost" }));
			const data = await response.json();

			expect(response.status).toBe(404);
			expect(data.error).toBe("Model not found");
		});

		it("rejects invalid enabled type", async () => {
			mockUpdateProviderModelFromPayload.mockRejectedValue(
				validationError("enabled must be a boolean"),
			);
			const response = await PUT(
				makeEvent("PUT", { enabled: "not-a-boolean" }),
			);
			const data = await response.json();

			expect(response.status).toBe(400);
			expect(data.error).toContain("boolean");
		});

		it("rejects invalid sortOrder type", async () => {
			mockUpdateProviderModelFromPayload.mockRejectedValue(
				validationError("sortOrder must be a number"),
			);
			const response = await PUT(makeEvent("PUT", { sortOrder: "first" }));
			const data = await response.json();

			expect(response.status).toBe(400);
			expect(data.error).toContain("sortOrder");
		});

		it("rejects negative maxModelContext", async () => {
			mockUpdateProviderModelFromPayload.mockRejectedValue(
				validationError(
					"maxModelContext must be a non-negative number or null",
				),
			);
			const response = await PUT(makeEvent("PUT", { maxModelContext: -1 }));
			const data = await response.json();

			expect(response.status).toBe(400);
			expect(data.error).toContain("maxModelContext");
		});

		it("rejects invalid reasoningEffort type", async () => {
			mockUpdateProviderModelFromPayload.mockRejectedValue(
				validationError("reasoningEffort must be a string"),
			);
			const response = await PUT(makeEvent("PUT", { reasoningEffort: 123 }));
			const data = await response.json();

			expect(response.status).toBe(400);
			expect(data.error).toContain("reasoningEffort");
		});
	});

	describe("DELETE", () => {
		it("deletes a model", async () => {
			const response = await DELETE(makeEvent("DELETE"));
			const data = await response.json();

			expect(response.status).toBe(200);
			expect(data.success).toBe(true);
			expect(mockDeleteProviderModel).toHaveBeenCalledWith("model-1");
		});

		it("returns 404 when model not found", async () => {
			mockDeleteProviderModel.mockResolvedValue(false);

			const response = await DELETE(makeEvent("DELETE"));
			const data = await response.json();

			expect(response.status).toBe(404);
			expect(data.error).toBe("Model not found");
		});
	});
});
