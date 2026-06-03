import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAdmin: vi.fn(),
}));

vi.mock("$lib/server/services/provider-models", async () => {
	return {
		batchCreateProviderModels: vi.fn(),
	};
});

import { requireAdmin } from "$lib/server/auth/hooks";
import { batchCreateProviderModels } from "$lib/server/services/provider-models";
import { POST } from "./+server";

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockBatchCreateProviderModels = batchCreateProviderModels as ReturnType<
	typeof vi.fn
>;

type BatchEvent = Parameters<typeof POST>[0];

function makeEvent(body?: unknown): BatchEvent {
	return {
		request: new Request(
			"http://localhost/api/admin/providers/provider-1/models/batch",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: body !== undefined ? JSON.stringify(body) : undefined,
			},
		),
		locals: { user: { id: "admin-1", role: "admin" } },
		params: { id: "provider-1" },
		url: new URL(
			"http://localhost/api/admin/providers/provider-1/models/batch",
		),
		route: { id: "/api/admin/providers/[id]/models/batch" },
	} as BatchEvent;
}

function makeModelEntry(id: number) {
	return {
		id: `model-${id}`,
		providerId: "provider-1",
		name: `model-${id}`,
		displayName: `Model ${id}`,
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
		enabled: true,
		sortOrder: 0,
		createdAt: new Date("2026-06-01T12:00:00.000Z"),
		updatedAt: new Date("2026-06-01T12:00:00.000Z"),
	};
}

describe("admin provider models batch route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAdmin.mockReturnValue(undefined);
		mockBatchCreateProviderModels.mockResolvedValue([]);
	});

	it("batch creates models", async () => {
		mockBatchCreateProviderModels.mockResolvedValue([
			makeModelEntry(1),
			makeModelEntry(2),
		]);

		const response = await POST(
			makeEvent({
				models: [
					{ name: "gpt-4" },
					{ name: "gpt-3.5", displayName: "GPT 3.5" },
				],
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(201);
		expect(data.models).toHaveLength(2);
		expect(mockBatchCreateProviderModels).toHaveBeenCalledWith(
			"provider-1",
			[
				{ name: "gpt-4", displayName: undefined },
				{ name: "gpt-3.5", displayName: "GPT 3.5" },
			],
		);
	});

	it("returns empty array for no models", async () => {
		mockBatchCreateProviderModels.mockResolvedValue([]);

		const response = await POST(
			makeEvent({ models: [] }),
		);
		const data = await response.json();

		expect(response.status).toBe(201);
		expect(data.models).toEqual([]);
	});

	it("rejects missing models array", async () => {
		const response = await POST(makeEvent({}));
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toContain("array");
	});

	it("rejects non-array models", async () => {
		const response = await POST(makeEvent({ models: "not-array" }));
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toContain("array");
	});

	it("rejects entry with missing name", async () => {
		const response = await POST(
			makeEvent({
				models: [
					{ displayName: "No Name" },
				],
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toContain("models[0].name");
	});

	it("rejects entry with empty name", async () => {
		const response = await POST(
			makeEvent({
				models: [
					{ name: "   " },
				],
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toContain("models[0].name");
	});

	it("rejects entry with invalid displayName type", async () => {
		const response = await POST(
			makeEvent({
				models: [
					{ name: "ok", displayName: 123 },
				],
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toContain("displayName");
	});

	it("returns 404 when provider does not exist", async () => {
		mockBatchCreateProviderModels.mockRejectedValue(
			new Error('Provider with id "provider-1" does not exist'),
		);

		const response = await POST(
			makeEvent({ models: [{ name: "ghost" }] }),
		);
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data.error).toContain("does not exist");
	});

	it("returns 500 on unexpected service failure", async () => {
		mockBatchCreateProviderModels.mockRejectedValue(new Error("DB error"));

		const response = await POST(
			makeEvent({ models: [{ name: "broken" }] }),
		);
		const data = await response.json();

		expect(response.status).toBe(500);
		expect(data.error).toContain("Failed to batch create");
	});
});
