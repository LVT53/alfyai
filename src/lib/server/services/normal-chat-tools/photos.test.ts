import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	distillConnectorPayload,
	hasLocalDistillEnabled,
	isCloudModel,
} from "$lib/server/services/connections/locality";
import {
	ImmichError,
	immichSmartSearch,
} from "$lib/server/services/connections/providers/immich";
import {
	needsDisambiguation,
	resolveConnectionsForCapability,
} from "$lib/server/services/connections/resolve";
import type { ConnectionPublic } from "$lib/server/services/connections/store";

import { runPhotosTool, sanitizePhotosToolInput } from "./photos";

vi.mock("$lib/server/services/connections/resolve", () => ({
	resolveConnectionsForCapability: vi.fn(),
	needsDisambiguation: vi.fn(),
}));
vi.mock("$lib/server/services/connections/providers/immich", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/connections/providers/immich")
	>("$lib/server/services/connections/providers/immich");
	return {
		...actual,
		immichSmartSearch: vi.fn(),
	};
});
vi.mock("$lib/server/services/connections/locality", () => ({
	hasLocalDistillEnabled: vi.fn(),
	isCloudModel: vi.fn(),
	distillConnectorPayload: vi.fn(),
}));

const resolveConnectionsForCapabilityMock = vi.mocked(
	resolveConnectionsForCapability,
);
const needsDisambiguationMock = vi.mocked(needsDisambiguation);
const immichSmartSearchMock = vi.mocked(immichSmartSearch);
const hasLocalDistillEnabledMock = vi.mocked(hasLocalDistillEnabled);
const isCloudModelMock = vi.mocked(isCloudModel);
const distillConnectorPayloadMock = vi.mocked(distillConnectorPayload);

const LOCAL_MODEL_ID = "model1";

function makeConn(overrides: Partial<ConnectionPublic> = {}): ConnectionPublic {
	return {
		id: "conn-1",
		userId: "user-1",
		provider: "immich",
		label: "Immich",
		accountIdentifier: "alice@example.com",
		status: "connected",
		statusDetail: null,
		defaultOn: false,
		allowWrites: false,
		writeAllowlist: [],
		capabilities: ["photos"],
		config: { origin: "https://photos.example.com", immichUserId: "user-1" },
		oauthScopes: [],
		tokenExpiresAt: null,
		hasSecret: true,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function resetAllMocks() {
	resolveConnectionsForCapabilityMock.mockReset();
	needsDisambiguationMock.mockReset();
	immichSmartSearchMock.mockReset();
	hasLocalDistillEnabledMock.mockReset();
	isCloudModelMock.mockReset();
	distillConnectorPayloadMock.mockReset();
	needsDisambiguationMock.mockReturnValue(false);
	hasLocalDistillEnabledMock.mockResolvedValue(false);
	isCloudModelMock.mockResolvedValue(false);
}

describe("sanitizePhotosToolInput", () => {
	it("trims the query and drops an undefined limit", () => {
		expect(
			sanitizePhotosToolInput({ action: "search", query: "  beach sunset  " }),
		).toEqual({ action: "search", query: "beach sunset" });
	});

	it("keeps a supplied limit", () => {
		expect(
			sanitizePhotosToolInput({ action: "search", query: "cats", limit: 5 }),
		).toEqual({ action: "search", query: "cats", limit: 5 });
	});
});

describe("runPhotosTool", () => {
	beforeEach(resetAllMocks);

	it("returns a graceful note without throwing when there is no Photos connection", async () => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([]);

		const outcome = await runPhotosTool(
			"user-1",
			{ action: "search", query: "beach" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain(
			"don't have a Photos connection",
		);
		expect(outcome.modelPayload.results).toEqual([]);
		expect(outcome.modelPayload.citations).toEqual([]);
		expect(immichSmartSearchMock).not.toHaveBeenCalled();
	});

	it("surfaces ambiguity but still executes against the first (sorted) connection", async () => {
		const connA = makeConn({ id: "conn-a", label: "Alice Photos" });
		const connB = makeConn({ id: "conn-b", label: "Bob Photos" });
		resolveConnectionsForCapabilityMock.mockResolvedValue([connA, connB]);
		needsDisambiguationMock.mockReturnValue(true);
		immichSmartSearchMock.mockResolvedValue([]);

		const outcome = await runPhotosTool(
			"user-1",
			{ action: "search", query: "beach" },
			LOCAL_MODEL_ID,
		);

		expect(immichSmartSearchMock).toHaveBeenCalledWith(
			"user-1",
			"conn-a",
			expect.objectContaining({ query: "beach" }),
		);
		expect(outcome.modelPayload.message).toContain("2 Photos connections");
		expect(outcome.modelPayload.message).toContain("Alice Photos");
		expect(outcome.modelPayload.message).toContain("Bob Photos");
	});

	it("search: requires a query", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

		const outcome = await runPhotosTool(
			"user-1",
			{ action: "search", query: "" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("search query is required");
		expect(immichSmartSearchMock).not.toHaveBeenCalled();
	});

	it("search: returns results, citations, and Sources-tab candidates carrying the thumbnailPath", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		immichSmartSearchMock.mockResolvedValue([
			{
				id: "asset-1",
				fileName: "beach.jpg",
				takenAt: "2026-06-01T09:55:00.000Z",
				type: "IMAGE",
				place: "Malibu, California",
				people: ["Alice"],
				description: "Sunset at the beach",
				thumbnailPath: "/api/assets/asset-1/thumbnail",
			},
		]);

		const outcome = await runPhotosTool(
			"user-1",
			{ action: "search", query: "beach" },
			LOCAL_MODEL_ID,
		);

		expect(immichSmartSearchMock).toHaveBeenCalledWith("user-1", "conn-1", {
			query: "beach",
		});
		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.results).toEqual([
			{
				id: "asset-1",
				fileName: "beach.jpg",
				takenAt: "2026-06-01T09:55:00.000Z",
				type: "IMAGE",
				place: "Malibu, California",
				people: ["Alice"],
				description: "Sunset at the beach",
			},
		]);
		expect(outcome.modelPayload.citations).toEqual([
			{ label: "beach.jpg", url: "" },
		]);
		// Never send raw photo bytes / thumbnail bytes to the model — only the
		// textual results/citations above appear in modelPayload.
		expect(JSON.stringify(outcome.modelPayload)).not.toContain("thumbnailPath");

		expect(outcome.candidates).toEqual([
			expect.objectContaining({
				id: "photos:asset-1",
				title: "beach.jpg",
				sourceType: "tool",
				metadata: expect.objectContaining({
					thumbnailPath: "/api/assets/asset-1/thumbnail",
				}),
			}),
		]);
	});

	it("maps needs_reauth adapter errors to a graceful note without leaking the key", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		immichSmartSearchMock.mockRejectedValue(
			new ImmichError("Immich rejected the stored API key", "needs_reauth"),
		);

		const outcome = await runPhotosTool(
			"user-1",
			{ action: "search", query: "beach" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("reconnected");
	});

	it("maps generic adapter failures to a graceful note without throwing", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		immichSmartSearchMock.mockRejectedValue(new Error("network exploded"));

		const outcome = await runPhotosTool(
			"user-1",
			{ action: "search", query: "beach" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain(
			"couldn't reach your photos",
		);
	});
});

describe("runPhotosTool — locality Option A distillation gate", () => {
	beforeEach(resetAllMocks);

	function seedSearch() {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		immichSmartSearchMock.mockResolvedValue([
			{
				id: "asset-1",
				fileName: "hospital-visit.jpg",
				takenAt: "2026-06-01T09:55:00.000Z",
				type: "IMAGE",
				place: "St. Mary's Hospital, Springfield",
				people: ["Alice Smith"],
				description: "Alice recovering after surgery",
				thumbnailPath: "/api/assets/asset-1/thumbnail",
			},
		]);
	}

	async function searchOnce() {
		return runPhotosTool(
			"user-1",
			{ action: "search", query: "hospital" },
			"whichever-model",
		);
	}

	it("Option A off: raw photo metadata is returned unchanged and distill is not called", async () => {
		seedSearch();
		hasLocalDistillEnabledMock.mockResolvedValue(false);
		isCloudModelMock.mockResolvedValue(true);

		const outcome = await searchOnce();

		expect(outcome.modelPayload.results[0]?.fileName).toBe(
			"hospital-visit.jpg",
		);
		expect(distillConnectorPayloadMock).not.toHaveBeenCalled();
	});

	it("Option A on + local model: raw photo metadata is returned unchanged and distill is not called", async () => {
		seedSearch();
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(false);

		const outcome = await searchOnce();

		expect(outcome.modelPayload.results[0]?.place).toContain("St. Mary's");
		expect(distillConnectorPayloadMock).not.toHaveBeenCalled();
	});

	it("Option A on + cloud model: the ENTIRE model-bound payload carries only the distilled summary — raw fileName/place/people/description absent, candidates keep the real data", async () => {
		seedSearch();
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		distillConnectorPayloadMock.mockResolvedValue({
			distilled: "One photo of a person recovering after a medical procedure.",
		});

		const outcome = await searchOnce();

		// The single most important assertion: raw filename/place/people/
		// description must not appear ANYWHERE in the whole model-facing
		// payload — not just `results`, but also `citations`.
		const serializedPayload = JSON.stringify(outcome.modelPayload);
		expect(serializedPayload).not.toContain("hospital-visit.jpg");
		expect(serializedPayload).not.toContain("St. Mary's Hospital");
		expect(serializedPayload).not.toContain("Alice Smith");
		expect(serializedPayload).not.toContain("recovering after surgery");
		expect(outcome.modelPayload.results[0]?.fileName).toBeUndefined();
		expect(outcome.modelPayload.results[0]?.place).toBeUndefined();
		expect(outcome.modelPayload.results[0]?.people).toBeUndefined();
		expect(outcome.modelPayload.results[0]?.description).toBeUndefined();
		expect(outcome.modelPayload.message).toContain(
			"One photo of a person recovering after a medical procedure.",
		);
		expect(distillConnectorPayloadMock).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				capability: "photos",
				rawText: expect.stringContaining("hospital-visit.jpg"),
			}),
		);
		// The MODEL-facing citation label is redacted too — the raw filename
		// must never reach the cloud model through this side channel.
		expect(outcome.modelPayload.citations).toEqual([
			expect.objectContaining({ url: "" }),
		]);
		expect(outcome.modelPayload.citations[0]?.label).not.toContain(
			"hospital-visit.jpg",
		);
		// The user's own Sources-tab candidates keep the real filename and
		// thumbnailPath, since that's the user's own data on their own screen.
		expect(outcome.candidates).toEqual([
			expect.objectContaining({
				title: "hospital-visit.jpg",
				metadata: expect.objectContaining({
					thumbnailPath: "/api/assets/asset-1/thumbnail",
				}),
			}),
		]);
	});

	it("Option A on + cloud model + distill unavailable: raw details are withheld, not leaked", async () => {
		seedSearch();
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		distillConnectorPayloadMock.mockResolvedValue({ unavailable: true });

		const outcome = await searchOnce();

		const serializedPayload = JSON.stringify(outcome.modelPayload);
		expect(serializedPayload).not.toContain("hospital-visit.jpg");
		expect(serializedPayload).not.toContain("Alice Smith");
		expect(outcome.modelPayload.message).toContain("withheld");
		expect(outcome.candidates).toEqual([
			expect.objectContaining({ title: "hospital-visit.jpg" }),
		]);
	});
});
