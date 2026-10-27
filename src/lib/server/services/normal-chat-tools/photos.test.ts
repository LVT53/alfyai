import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getConfig } from "$lib/server/config-store";
import {
	distillConnectorPayload,
	hasLocalDistillEnabled,
	isCloudModel,
} from "$lib/server/services/connections/locality";
import { createPendingWrite } from "$lib/server/services/connections/pending-writes";
import {
	ImmichError,
	immichAlbumAssets,
	immichListAlbums,
	immichListPeople,
	immichMetadataSearch,
	immichSmartSearch,
	immichThumbnail,
} from "$lib/server/services/connections/providers/immich";
import {
	needsDisambiguation,
	resolveConnectionsForCapability,
} from "$lib/server/services/connections/resolve";
import type { ConnectionPublic } from "$lib/server/services/connections/store";
import { resolveNormalChatModelRunProvider } from "$lib/server/services/normal-chat-model";
import { describeImage } from "$lib/server/services/vision/describe";
import { modelIdCanSeeImages } from "$lib/server/services/vision/model-vision";
import {
	type PreparedImage,
	prepareImageForModel,
} from "$lib/server/services/vision/prepare-image";
import { createStepImageQueue } from "$lib/server/services/vision/step-images";

import { runPhotosTool, sanitizePhotosToolInput } from "./photos";

// These tests drive the tool's core directly, outside the envelope a real call
// runs in, to look at what a summary does to the payload. The mark the envelope
// carries is not what they are about (connector-distill.test.ts and
// shared.test.ts hold it), and a summary asked for with no call to mark is
// refused (ADR-0068), so the call is stood in for.
vi.mock("./shared", async (importOriginal) => ({
	...(await importOriginal<typeof import("./shared")>()),
	isInsideToolCall: () => true,
	markCallLocallyDistilled: vi.fn(),
}));

vi.mock("$lib/server/services/connections/resolve", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/connections/resolve")
	>("$lib/server/services/connections/resolve");
	return {
		...actual,
		resolveConnectionsForCapability: vi.fn(),
		needsDisambiguation: vi.fn(),
	};
});
vi.mock("$lib/server/services/connections/providers/immich", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/connections/providers/immich")
	>("$lib/server/services/connections/providers/immich");
	return {
		...actual,
		immichSmartSearch: vi.fn(),
		immichMetadataSearch: vi.fn(),
		immichListAlbums: vi.fn(),
		immichAlbumAssets: vi.fn(),
		immichListPeople: vi.fn(),
		immichThumbnail: vi.fn(),
	};
});
// What a look reaches for beyond the Immich download: where the summarising
// model is, whether a model can see, preparing the image and describing it.
vi.mock("$lib/server/config-store", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/server/config-store")>()),
	getConfig: vi.fn(),
}));
vi.mock("$lib/server/services/normal-chat-model", () => ({
	resolveNormalChatModelRunProvider: vi.fn(),
}));
vi.mock("$lib/server/services/vision/model-vision", () => ({
	modelIdCanSeeImages: vi.fn(),
}));
vi.mock("$lib/server/services/vision/describe", () => ({
	describeImage: vi.fn(),
}));
vi.mock(
	"$lib/server/services/vision/prepare-image",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("$lib/server/services/vision/prepare-image")
		>()),
		prepareImageForModel: vi.fn(),
	}),
);
vi.mock("$lib/server/services/connections/locality", () => ({
	hasLocalDistillEnabled: vi.fn(),
	isCloudModel: vi.fn(),
	distillConnectorPayload: vi.fn(),
}));
vi.mock("$lib/server/services/connections/pending-writes", () => ({
	createPendingWrite: vi.fn(),
}));

const resolveConnectionsForCapabilityMock = vi.mocked(
	resolveConnectionsForCapability,
);
const needsDisambiguationMock = vi.mocked(needsDisambiguation);
const immichSmartSearchMock = vi.mocked(immichSmartSearch);
const immichMetadataSearchMock = vi.mocked(immichMetadataSearch);
const immichListAlbumsMock = vi.mocked(immichListAlbums);
const immichAlbumAssetsMock = vi.mocked(immichAlbumAssets);
const immichListPeopleMock = vi.mocked(immichListPeople);
const immichThumbnailMock = vi.mocked(immichThumbnail);
const getConfigMock = vi.mocked(getConfig);
const resolveRunProviderMock = vi.mocked(resolveNormalChatModelRunProvider);
const modelIdCanSeeImagesMock = vi.mocked(modelIdCanSeeImages);
const describeImageMock = vi.mocked(describeImage);
const prepareImageForModelMock = vi.mocked(prepareImageForModel);
const hasLocalDistillEnabledMock = vi.mocked(hasLocalDistillEnabled);
const isCloudModelMock = vi.mocked(isCloudModel);
const distillConnectorPayloadMock = vi.mocked(distillConnectorPayload);
const createPendingWriteMock = vi.mocked(createPendingWrite);

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
		hasWriteSecret: false,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function resetAllMocks() {
	resolveConnectionsForCapabilityMock.mockReset();
	needsDisambiguationMock.mockReset();
	immichSmartSearchMock.mockReset();
	immichMetadataSearchMock.mockReset();
	immichListAlbumsMock.mockReset();
	immichAlbumAssetsMock.mockReset();
	immichListPeopleMock.mockReset();
	immichThumbnailMock.mockReset();
	getConfigMock.mockReset();
	resolveRunProviderMock.mockReset();
	modelIdCanSeeImagesMock.mockReset();
	describeImageMock.mockReset();
	prepareImageForModelMock.mockReset();
	hasLocalDistillEnabledMock.mockReset();
	isCloudModelMock.mockReset();
	distillConnectorPayloadMock.mockReset();
	createPendingWriteMock.mockReset();
	needsDisambiguationMock.mockReturnValue(false);
	hasLocalDistillEnabledMock.mockResolvedValue(false);
	isCloudModelMock.mockResolvedValue(false);
	createPendingWriteMock.mockImplementation(async (_userId, params) => ({
		id: "pending-1",
		preview: params.preview,
	}));
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

	it("keeps the model's request to look, whichever way it went", () => {
		expect(
			sanitizePhotosToolInput({ action: "search", query: "cats", look: true }),
		).toEqual({ action: "search", query: "cats", look: true });
		expect(
			sanitizePhotosToolInput({ action: "search", query: "cats", look: false }),
		).toEqual({ action: "search", query: "cats", look: false });
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

	it("account selector routes the search to the matching Immich connection", async () => {
		const connA = makeConn({ id: "conn-a", label: "Alice Photos" });
		const connB = makeConn({ id: "conn-b", label: "Bob Photos" });
		resolveConnectionsForCapabilityMock.mockResolvedValue([connA, connB]);
		needsDisambiguationMock.mockReturnValue(true);
		immichSmartSearchMock.mockResolvedValue([]);

		const outcome = await runPhotosTool(
			"user-1",
			{ action: "search", query: "beach", account: "Bob Photos" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(true);
		expect(immichSmartSearchMock).toHaveBeenCalledWith(
			"user-1",
			"conn-b",
			expect.objectContaining({ query: "beach" }),
		);
	});

	it("an account selector matching nothing returns a graceful listing message", async () => {
		const connA = makeConn({ id: "conn-a", label: "Alice Photos" });
		const connB = makeConn({ id: "conn-b", label: "Bob Photos" });
		resolveConnectionsForCapabilityMock.mockResolvedValue([connA, connB]);
		needsDisambiguationMock.mockReturnValue(true);

		const outcome = await runPhotosTool(
			"user-1",
			{ action: "search", query: "beach", account: "google" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("Alice Photos");
		expect(outcome.modelPayload.message).toContain("Bob Photos");
		expect(immichSmartSearchMock).not.toHaveBeenCalled();
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
				description: "Sunset at the beach",
				imageUrl:
					"/api/connections/immich/thumbnail/asset-1?connectionId=conn-1",
			},
		]);
		// The imageUrl is the AUTHED per-user app proxy (Task 11a), never the
		// raw Immich path (thumbnailPath, which stays candidates-only below) —
		// the model gets a URL it can embed, not a route requiring the vault key.
		expect(outcome.modelPayload.results[0]?.imageUrl).not.toContain(
			"/api/assets/",
		);
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

	it("Option A on + cloud model: the ENTIRE model-bound payload carries only the distilled summary — raw fileName/place/description absent, candidates keep the real data", async () => {
		seedSearch();
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		distillConnectorPayloadMock.mockResolvedValue({
			distilled: "One photo of a person recovering after a medical procedure.",
		});

		const outcome = await searchOnce();

		// The single most important assertion: raw filename/place/description
		// must not appear ANYWHERE in the whole model-facing payload — not just
		// `results`, but also `citations`.
		const serializedPayload = JSON.stringify(outcome.modelPayload);
		expect(serializedPayload).not.toContain("hospital-visit.jpg");
		expect(serializedPayload).not.toContain("St. Mary's Hospital");
		expect(serializedPayload).not.toContain("recovering after surgery");
		expect(outcome.modelPayload.results[0]?.fileName).toBeUndefined();
		expect(outcome.modelPayload.results[0]?.place).toBeUndefined();
		expect(outcome.modelPayload.results[0]?.description).toBeUndefined();
		// id/takenAt/imageUrl are structural (derived from the asset id the
		// gate already preserves) and survive the distill gate — imageUrl
		// reveals nothing beyond the id: the model never sees photo bytes, only
		// a URL to the authed per-user proxy the client fetches through.
		expect(outcome.modelPayload.results[0]?.id).toBe("asset-1");
		expect(outcome.modelPayload.results[0]?.takenAt).toBe(
			"2026-06-01T09:55:00.000Z",
		);
		expect(outcome.modelPayload.results[0]?.imageUrl).toBe(
			"/api/connections/immich/thumbnail/asset-1?connectionId=conn-1",
		);
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
		expect(serializedPayload).not.toContain("recovering after surgery");
		expect(outcome.modelPayload.message).toContain("withheld");
		expect(outcome.candidates).toEqual([
			expect.objectContaining({ title: "hospital-visit.jpg" }),
		]);
	});
});

describe("runPhotosTool — add_to_album (Issue 6.4)", () => {
	beforeEach(resetAllMocks);

	function makeWritableConn(overrides: Partial<ConnectionPublic> = {}) {
		return makeConn({
			allowWrites: true,
			hasWriteSecret: true,
			...overrides,
		});
	}

	it("allowWrites=true + hasWriteSecret=true: returns a PENDING result (preview + id) and creates a pending row — the write-executor is never called", async () => {
		const conn = makeWritableConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

		const outcome = await runPhotosTool(
			"user-1",
			{ action: "add_to_album", assetIds: ["asset-1", "asset-2"] },
			LOCAL_MODEL_ID,
			"conv-1",
		);

		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.action).toBe("add_to_album");
		expect(outcome.modelPayload.pendingWriteId).toBe("pending-1");
		expect(outcome.modelPayload.preview).toBeDefined();
		expect(outcome.modelPayload.message).toContain("has NOT been applied yet");
		expect(outcome.modelPayload.message.toLowerCase()).toContain("confirm");

		expect(createPendingWriteMock).toHaveBeenCalledTimes(1);
		const call = createPendingWriteMock.mock.calls[0]?.[1];
		expect(call).toMatchObject({
			connectionId: "conn-1",
			provider: "immich",
			// 7.5 — threaded from ctx.conversationId.
			conversationId: "conv-1",
		});
		expect(call?.op).toMatchObject({
			provider: "immich",
			connectionId: "conn-1",
			action: "immich.add_to_album",
			destructive: false,
			reversible: true,
		});
		const content = JSON.parse(call?.content ?? "{}");
		expect(content).toEqual({
			assetIds: ["asset-1", "asset-2"],
			albumName: "AlfyAI",
		});
		// Immich smart search / the write-executor are never invoked directly
		// from the tool — only a pending row is created.
		expect(immichSmartSearchMock).not.toHaveBeenCalled();
	});

	it("allowWrites=false: returns a note and creates NO pending row", async () => {
		const conn = makeWritableConn({ allowWrites: false });
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

		const outcome = await runPhotosTool(
			"user-1",
			{ action: "add_to_album", assetIds: ["asset-1"] },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("turned off");
		expect(outcome.modelPayload.message).toContain("settings");
		expect(createPendingWriteMock).not.toHaveBeenCalled();
	});

	it("hasWriteSecret=false: returns a note asking to enable Immich writes, and creates NO pending row", async () => {
		const conn = makeWritableConn({ hasWriteSecret: false });
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

		const outcome = await runPhotosTool(
			"user-1",
			{ action: "add_to_album", assetIds: ["asset-1"] },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("Enable Immich writes");
		expect(createPendingWriteMock).not.toHaveBeenCalled();
	});

	it("no assetIds: returns a note and creates NO pending row", async () => {
		const conn = makeWritableConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

		const outcome = await runPhotosTool(
			"user-1",
			{ action: "add_to_album", assetIds: [] },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("At least one photo");
		expect(createPendingWriteMock).not.toHaveBeenCalled();
	});

	it("no Photos connection: returns a note and creates NO pending row", async () => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([]);

		const outcome = await runPhotosTool(
			"user-1",
			{ action: "add_to_album", assetIds: ["asset-1"] },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(createPendingWriteMock).not.toHaveBeenCalled();
	});

	// Option A (locality) — whole-payload test. add_to_album's assetIds are
	// OPAQUE ids, never filenames; the tool never looks up a filename for
	// them in this action, so the raw filename from an earlier search (e.g.
	// "hospital-visit.jpg", the same sensitive name used in the search-side
	// Option A tests above) must never appear anywhere in the resulting
	// add_to_album payload, on a cloud model, regardless of the local-distill
	// toggle — there is nothing connector-read to redact because nothing
	// connector-read was ever included in the first place.
	it("Option A + cloud model: the add_to_album payload never contains a filename from a prior search — nothing raw to redact by construction", async () => {
		const conn = makeWritableConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);

		const outcome = await runPhotosTool(
			"user-1",
			// A model naively passing a filename-shaped string as an "asset id"
			// must still never have that string echoed back to the model as a
			// human-readable label — this action does not use it as one.
			{ action: "add_to_album", assetIds: ["hospital-visit.jpg"] },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(true);
		const serializedMessage = outcome.modelPayload.message;
		expect(serializedMessage).not.toContain("hospital-visit.jpg");
		expect(JSON.stringify(outcome.modelPayload.preview)).not.toContain(
			"hospital-visit.jpg",
		);
		// The local-distill decision path is never invoked for this action —
		// there is no connector-read rawText to gate.
		expect(distillConnectorPayloadMock).not.toHaveBeenCalled();
	});
});

describe("runPhotosTool — search_by_date (B1 metadata search)", () => {
	beforeEach(resetAllMocks);

	it("forwards date/place/type/favorite filters to immichMetadataSearch and returns results + candidates", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		immichMetadataSearchMock.mockResolvedValue([
			{
				id: "asset-1",
				fileName: "june.jpg",
				takenAt: "2019-06-15T09:55:00.000Z",
				type: "IMAGE",
				place: "Paris, France",
				thumbnailPath: "/api/assets/asset-1/thumbnail",
			},
		]);

		const outcome = await runPhotosTool(
			"user-1",
			{
				action: "search_by_date",
				from: "2019-06-01",
				to: "2019-06-30",
				city: "Paris",
				type: "IMAGE",
				favorites: true,
			},
			LOCAL_MODEL_ID,
		);

		expect(immichMetadataSearchMock).toHaveBeenCalledWith("user-1", "conn-1", {
			takenAfter: "2019-06-01",
			takenBefore: "2019-06-30",
			city: "Paris",
			type: "IMAGE",
			isFavorite: true,
		});
		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.action).toBe("search_by_date");
		expect(outcome.modelPayload.results[0]?.fileName).toBe("june.jpg");
		expect(outcome.candidates[0]).toEqual(
			expect.objectContaining({ id: "photos:asset-1" }),
		);
		expect(immichSmartSearchMock).not.toHaveBeenCalled();
	});

	it("resolves personName -> personIds via immichListPeople, then filters the metadata search", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		immichListPeopleMock.mockResolvedValue([
			{ id: "p1", name: "Alice" },
			{ id: "p2", name: "Bob" },
		]);
		immichMetadataSearchMock.mockResolvedValue([]);

		await runPhotosTool(
			"user-1",
			{ action: "search_by_date", personName: "alice" },
			LOCAL_MODEL_ID,
		);

		expect(immichListPeopleMock).toHaveBeenCalledWith("user-1", "conn-1");
		expect(immichMetadataSearchMock).toHaveBeenCalledWith("user-1", "conn-1", {
			personIds: ["p1"],
		});
	});

	it("returns a graceful note (no metadata search) when personName matches nobody", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		immichListPeopleMock.mockResolvedValue([{ id: "p1", name: "Alice" }]);

		const outcome = await runPhotosTool(
			"user-1",
			{ action: "search_by_date", personName: "Zebediah" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("Zebediah");
		expect(immichMetadataSearchMock).not.toHaveBeenCalled();
	});

	// Option A applies to metadata-search results exactly like smart search:
	// they carry the same sensitive fileName/place/description.
	it("Option A + cloud model: metadata-search results are distilled out of the model payload", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		distillConnectorPayloadMock.mockResolvedValue({ distilled: "One photo." });
		immichMetadataSearchMock.mockResolvedValue([
			{
				id: "asset-1",
				fileName: "hospital-visit.jpg",
				takenAt: "2019-06-15T09:55:00.000Z",
				type: "IMAGE",
				place: "St. Mary's Hospital",
				thumbnailPath: "/api/assets/asset-1/thumbnail",
			},
		]);

		const outcome = await runPhotosTool(
			"user-1",
			{ action: "search_by_date", from: "2019-06-01" },
			"cloud-model",
		);

		const serialized = JSON.stringify(outcome.modelPayload);
		expect(serialized).not.toContain("hospital-visit.jpg");
		expect(serialized).not.toContain("St. Mary's Hospital");
		expect(outcome.modelPayload.message).toContain("One photo.");
		// Candidates keep the real data for the user's own Sources tab.
		expect(outcome.candidates[0]).toEqual(
			expect.objectContaining({ title: "hospital-visit.jpg" }),
		);
	});
});

describe("runPhotosTool — list_albums / album / list_people (B1/B6 browse)", () => {
	beforeEach(resetAllMocks);

	it("list_albums: surfaces album summaries (discovery, no distill gate)", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		immichListAlbumsMock.mockResolvedValue([
			{ id: "album-1", albumName: "Vacation", assetCount: 42 },
		]);

		const outcome = await runPhotosTool(
			"user-1",
			{ action: "list_albums" },
			"cloud-model",
		);

		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.action).toBe("list_albums");
		expect(outcome.modelPayload.albums).toEqual([
			{ id: "album-1", name: "Vacation", assetCount: 42 },
		]);
		// Discovery metadata, mirrors calendar list_calendars — not distilled.
		expect(distillConnectorPayloadMock).not.toHaveBeenCalled();
	});

	it("album: requires an albumId", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

		const outcome = await runPhotosTool(
			"user-1",
			{ action: "album" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("albumId");
		expect(immichAlbumAssetsMock).not.toHaveBeenCalled();
	});

	it("album: fetches the album's assets and returns them as photo results", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		immichAlbumAssetsMock.mockResolvedValue([
			{
				id: "asset-1",
				fileName: "beach.jpg",
				takenAt: "2026-06-01T10:00:00.000Z",
				type: "IMAGE",
				thumbnailPath: "/api/assets/asset-1/thumbnail",
			},
		]);

		const outcome = await runPhotosTool(
			"user-1",
			{ action: "album", albumId: "album-1" },
			LOCAL_MODEL_ID,
		);

		expect(immichAlbumAssetsMock).toHaveBeenCalledWith("user-1", "conn-1", {
			albumId: "album-1",
		});
		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.action).toBe("album");
		expect(outcome.modelPayload.results[0]?.fileName).toBe("beach.jpg");
	});

	it("list_people: surfaces named people (discovery, no distill gate)", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		immichListPeopleMock.mockResolvedValue([
			{ id: "p1", name: "Alice" },
			{ id: "p2", name: "Bob" },
		]);

		const outcome = await runPhotosTool(
			"user-1",
			{ action: "list_people" },
			"cloud-model",
		);

		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.action).toBe("list_people");
		expect(outcome.modelPayload.people).toEqual([
			{ id: "p1", name: "Alice" },
			{ id: "p2", name: "Bob" },
		]);
		expect(distillConnectorPayloadMock).not.toHaveBeenCalled();
	});

	it("list_albums: maps a needs_reauth error to a graceful note", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		immichListAlbumsMock.mockRejectedValue(
			new ImmichError("Immich rejected the stored API key", "needs_reauth"),
		);

		const outcome = await runPhotosTool(
			"user-1",
			{ action: "list_albums" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("reconnected");
	});
});

// ---------------------------------------------------------------------------
// look: the model asks to see the photos it found
// ---------------------------------------------------------------------------

const CLOUD_MODEL_ID = "provider:cloud:chat";
const LOCAL_SEEING_MODEL_ID = "model2";

const localSeeingProvider = {
	id: "local",
	name: "local",
	displayName: "Local",
	baseUrl: "http://192.168.1.96:30000/v1",
	modelName: "flash-next",
	apiKey: "key",
};

function preparedFor(assetId: string): PreparedImage {
	return {
		base64: Buffer.from(assetId).toString("base64"),
		mediaType: "image/jpeg",
		width: 64,
		height: 48,
		estimatedTokens: 6,
	};
}

function assetIdOf(image: PreparedImage): string {
	return Buffer.from(image.base64, "base64").toString();
}

function thumbnailBytesOf(assetId: string) {
	return {
		bytes: new TextEncoder().encode(assetId).buffer as ArrayBuffer,
		contentType: "image/webp",
	};
}

describe("runPhotosTool — look (thumbnails when a question needs them)", () => {
	// A thumbnail that is skipped says so in the log; these tests read the
	// outcome instead.
	let warn: ReturnType<typeof vi.spyOn>;

	afterEach(() => {
		warn.mockRestore();
	});

	beforeEach(() => {
		resetAllMocks();
		warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		getConfigMock.mockReturnValue({
			memoryConsolidationModel: LOCAL_SEEING_MODEL_ID,
		} as unknown as ReturnType<typeof getConfig>);
		resolveRunProviderMock.mockResolvedValue(localSeeingProvider);
		// A download hands back the asset's own id as its bytes, so a test can tell
		// which thumbnail became which picture.
		immichThumbnailMock.mockImplementation(async (_user, _conn, { assetId }) =>
			thumbnailBytesOf(assetId),
		);
		prepareImageForModelMock.mockImplementation(async (input) =>
			preparedFor(new TextDecoder().decode(input)),
		);
		describeImageMock.mockImplementation(
			async ({ image }) => `seen ${assetIdOf(image)}`,
		);
	});

	function seedPhotos(count: number) {
		resolveConnectionsForCapabilityMock.mockResolvedValue([makeConn()]);
		const found = Array.from({ length: count }, (_, index) => ({
			id: `asset-${index + 1}`,
			fileName: `IMG_${String(index + 1).padStart(4, "0")}.jpg`,
			takenAt: "2026-06-01T09:55:00.000Z",
			type: "IMAGE" as const,
			thumbnailPath: `/api/assets/asset-${index + 1}/thumbnail`,
		}));
		immichSmartSearchMock.mockResolvedValue(found);
		immichMetadataSearchMock.mockResolvedValue(found);
		immichAlbumAssetsMock.mockResolvedValue(found);
	}

	/** The model can see and is local (or the person has not asked for privacy). */
	function arrangeSeeingModel() {
		modelIdCanSeeImagesMock.mockResolvedValue(true);
	}

	async function lookFor(
		count = 10,
		input: Parameters<typeof runPhotosTool>[1] = {
			action: "search",
			query: "beach",
			look: true,
		},
		modelId = LOCAL_MODEL_ID,
	) {
		seedPhotos(count);
		const queue = createStepImageQueue();
		const outcome = await runPhotosTool("user-1", input, modelId, undefined, {
			queue,
		});
		return { outcome, queue };
	}

	it("queues the thumbnails of the first eight of ten results and says that eight follow", async () => {
		arrangeSeeingModel();

		const { outcome, queue } = await lookFor(10);

		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.message).toContain("8 thumbnails follow");
		expect(outcome.viewedCount).toBe(8);
		const entries = queue.drain();
		expect(entries).toHaveLength(1);
		expect(entries[0]?.images).toHaveLength(8);
		expect(entries[0]?.images.map((entry) => assetIdOf(entry.image))).toEqual(
			Array.from({ length: 8 }, (_, index) => `asset-${index + 1}`),
		);
		expect(entries[0]?.label).toBe(
			`Thumbnails from the photos tool, in result order: ${Array.from(
				{ length: 8 },
				(_, index) =>
					`${index + 1} = IMG_${String(index + 1).padStart(4, "0")}.jpg`,
			).join(", ")}`,
		);
		// The results themselves are what they always were.
		expect(outcome.modelPayload.results).toHaveLength(10);
		expect(outcome.modelPayload.results[0]?.fileName).toBe("IMG_0001.jpg");
		expect(immichThumbnailMock).toHaveBeenCalledTimes(8);
	});

	it("tells the model it saw fewer than the results it was given", async () => {
		arrangeSeeingModel();

		const { outcome } = await lookFor(10);

		expect(outcome.modelPayload.message).toContain("8 of the 10 results");
	});

	it("does not call the one thumbnail of a single result 'thumbnails'", async () => {
		arrangeSeeingModel();

		const { outcome } = await lookFor(1);

		expect(outcome.modelPayload.message).toContain("1 thumbnail follows");
		expect(outcome.viewedCount).toBe(1);
	});

	it("counts only the thumbnails it got when some of the eight will not download", async () => {
		arrangeSeeingModel();
		const failing = ["asset-2", "asset-5", "asset-7"];
		immichThumbnailMock.mockImplementation(
			async (_user, _conn, { assetId }) => {
				if (failing.includes(assetId)) {
					throw new ImmichError(
						"Failed to fetch the photo thumbnail",
						"request_failed",
					);
				}
				return thumbnailBytesOf(assetId);
			},
		);

		const { outcome, queue } = await lookFor(8);

		expect(outcome.viewedCount).toBe(5);
		expect(outcome.modelPayload.message).toContain("5 thumbnails follow");
		expect(queue.drain()[0]?.images).toHaveLength(5);
		expect(outcome.modelPayload.success).toBe(true);
	});

	it("says the photos could not be looked at when no thumbnail could be had, and queues nothing", async () => {
		arrangeSeeingModel();
		immichThumbnailMock.mockRejectedValue(
			new ImmichError("Failed to fetch the photo thumbnail", "request_failed"),
		);

		const { outcome, queue } = await lookFor(3);

		expect(outcome.viewedCount).toBe(0);
		expect(outcome.modelPayload.message).toContain("could not be looked at");
		expect(queue.drain()).toEqual([]);
		expect(outcome.modelPayload.results).toHaveLength(3);
	});

	it.each([
		["search", { action: "search", query: "beach", look: true }],
		[
			"search_by_date",
			{ action: "search_by_date", from: "2026-06-01", look: true },
		],
		["album", { action: "album", albumId: "album-1", look: true }],
	] as const)("looks at the results of %s too", async (_name, input) => {
		arrangeSeeingModel();

		const { outcome, queue } = await lookFor(3, input);

		expect(outcome.viewedCount).toBe(3);
		expect(queue.drain()[0]?.images).toHaveLength(3);
	});

	it.each([
		["when the model did not ask", { action: "search", query: "beach" }],
		[
			"when the model asked not to",
			{ action: "search", query: "beach", look: false },
		],
	] as const)("looks at nothing %s", async (_name, input) => {
		arrangeSeeingModel();

		const { outcome, queue } = await lookFor(5, input);

		expect(immichThumbnailMock).not.toHaveBeenCalled();
		expect(queue.drain()).toEqual([]);
		expect(outcome.viewedCount).toBeUndefined();
		expect(outcome.modelPayload.message).not.toContain("thumbnail");
		// Nothing was asked of the models either.
		expect(modelIdCanSeeImagesMock).not.toHaveBeenCalled();
		expect(describeImageMock).not.toHaveBeenCalled();
	});

	it("has nothing to look at in an empty result", async () => {
		arrangeSeeingModel();

		const { outcome, queue } = await lookFor(0);

		expect(outcome.modelPayload.message).toBe(
			"No photos found for that search.",
		);
		expect(immichThumbnailMock).not.toHaveBeenCalled();
		expect(queue.drain()).toEqual([]);
	});

	it("looks at nothing for the actions that return no photos", async () => {
		arrangeSeeingModel();
		resolveConnectionsForCapabilityMock.mockResolvedValue([
			makeConn({ allowWrites: true, hasWriteSecret: true }),
		]);
		immichListAlbumsMock.mockResolvedValue([
			{ id: "album-1", albumName: "Vacation", assetCount: 3 },
		]);
		immichListPeopleMock.mockResolvedValue([{ id: "p1", name: "Alice" }]);
		const queue = createStepImageQueue();

		const inputs: Array<Parameters<typeof runPhotosTool>[1]> = [
			{ action: "list_albums", look: true },
			{ action: "list_people", look: true },
			{ action: "add_to_album", assetIds: ["asset-1"], look: true },
		];
		for (const input of inputs) {
			const outcome = await runPhotosTool(
				"user-1",
				input,
				LOCAL_MODEL_ID,
				undefined,
				{ queue },
			);
			expect(outcome.viewedCount).toBeUndefined();
		}

		expect(immichThumbnailMock).not.toHaveBeenCalled();
		expect(queue.drain()).toEqual([]);
	});

	it("looks at nothing for a model that cannot see, and says so", async () => {
		modelIdCanSeeImagesMock.mockResolvedValue(false);

		const { outcome, queue } = await lookFor(10);

		expect(outcome.viewedCount).toBe(0);
		expect(outcome.modelPayload.message).toContain("could not be looked at");
		expect(immichThumbnailMock).not.toHaveBeenCalled();
		expect(queue.drain()).toEqual([]);
		// The details are still there to answer from.
		expect(outcome.modelPayload.results).toHaveLength(10);
		expect(outcome.modelPayload.success).toBe(true);
	});

	it("looks at nothing when the caller gave it nowhere to queue pictures", async () => {
		arrangeSeeingModel();
		seedPhotos(3);

		const outcome = await runPhotosTool(
			"user-1",
			{ action: "search", query: "beach", look: true },
			LOCAL_MODEL_ID,
		);

		expect(outcome.viewedCount).toBe(0);
		expect(outcome.modelPayload.message).toContain("could not be looked at");
		expect(immichThumbnailMock).not.toHaveBeenCalled();
	});

	it("does not let a look that breaks take the search with it", async () => {
		arrangeSeeingModel();
		seedPhotos(3);
		const queue = createStepImageQueue();
		vi.spyOn(queue, "push").mockImplementation(() => {
			throw new Error("the queue is broken");
		});

		const outcome = await runPhotosTool(
			"user-1",
			{ action: "search", query: "beach", look: true },
			LOCAL_MODEL_ID,
			undefined,
			{ queue },
		);

		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.results).toHaveLength(3);
		expect(outcome.modelPayload.message).toContain("could not be looked at");
		expect(outcome.viewedCount).toBe(0);
	});

	it("queues nothing for a call that was already given up", async () => {
		arrangeSeeingModel();
		seedPhotos(3);
		const queue = createStepImageQueue();

		const outcome = await runPhotosTool(
			"user-1",
			{ action: "search", query: "beach", look: true },
			LOCAL_MODEL_ID,
			undefined,
			{ queue, signal: AbortSignal.abort() },
		);

		expect(queue.drain()).toEqual([]);
		expect(outcome.viewedCount).toBe(0);
	});

	it("never describes what it queues: a thumbnail is not an artifact", async () => {
		arrangeSeeingModel();

		await lookFor(3);

		expect(describeImageMock).not.toHaveBeenCalled();
	});

	it("still shows the pixels to a local model when the person keeps summarising local", async () => {
		arrangeSeeingModel();
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(false);

		const { outcome, queue } = await lookFor(3);

		expect(outcome.viewedCount).toBe(3);
		expect(queue.drain()[0]?.images).toHaveLength(3);
		expect(distillConnectorPayloadMock).not.toHaveBeenCalled();
	});

	it("shows the pixels to a cloud model that can see when the person does not keep summarising local", async () => {
		arrangeSeeingModel();
		hasLocalDistillEnabledMock.mockResolvedValue(false);
		isCloudModelMock.mockResolvedValue(true);

		const { outcome, queue } = await lookFor(
			3,
			{ action: "search", query: "beach", look: true },
			CLOUD_MODEL_ID,
		);

		expect(outcome.viewedCount).toBe(3);
		expect(queue.drain()[0]?.images).toHaveLength(3);
	});

	describe("a cloud model for a person who keeps summarising local", () => {
		beforeEach(() => {
			hasLocalDistillEnabledMock.mockResolvedValue(true);
			isCloudModelMock.mockImplementation(async (id) => id === CLOUD_MODEL_ID);
			distillConnectorPayloadMock.mockResolvedValue({
				distilled: "Three beach photos; the second is the sharpest.",
			});
		});

		function arrangeLocalModelThatSees() {
			modelIdCanSeeImagesMock.mockImplementation(
				async (id) => id === LOCAL_SEEING_MODEL_ID,
			);
		}

		const lookAsCloud = (count = 3) =>
			lookFor(
				count,
				{ action: "search", query: "beach", look: true },
				CLOUD_MODEL_ID,
			);

		it("has the local model that can see describe them: no pixel is queued", async () => {
			arrangeLocalModelThatSees();

			const { outcome, queue } = await lookAsCloud(10);

			expect(queue.drain()).toEqual([]);
			expect(outcome.viewedCount).toBe(0);
			expect(describeImageMock).toHaveBeenCalledTimes(8);
			for (const [call] of describeImageMock.mock.calls) {
				expect(call.provider).toBe(localSeeingProvider);
			}
			expect(resolveRunProviderMock).toHaveBeenCalledWith(
				LOCAL_SEEING_MODEL_ID,
				expect.anything(),
			);
		});

		it("hands one description per photo to the summary, with the photo it belongs to", async () => {
			arrangeLocalModelThatSees();

			await lookAsCloud(3);

			const rawText = distillConnectorPayloadMock.mock.calls[0]?.[0].rawText;
			const lines = (rawText ?? "").split("\n");
			expect(lines).toHaveLength(3);
			expect(lines[0]).toMatch(/IMG_0001\.jpg.*looks like: seen asset-1/);
			expect(lines[1]).toMatch(/IMG_0002\.jpg.*looks like: seen asset-2/);
			expect(lines[2]).toMatch(/IMG_0003\.jpg.*looks like: seen asset-3/);
		});

		it("lets the cloud model see only the summary: no description, no file name, no thumbnail", async () => {
			arrangeLocalModelThatSees();

			const { outcome } = await lookAsCloud(3);

			expect(outcome.modelPayload.message).toContain(
				"Three beach photos; the second is the sharpest.",
			);
			const wire = JSON.stringify(outcome.modelPayload);
			expect(wire).not.toContain("seen asset-");
			expect(wire).not.toContain("lookDescription");
			expect(wire).not.toContain("IMG_0001.jpg");
			expect(wire).not.toContain(preparedFor("asset-1").base64);
			// The person's own Sources tab keeps the real names.
			expect(outcome.candidates[0]?.title).toBe("IMG_0001.jpg");
		});

		it("leaves out a description it could not make, and the summary still goes ahead", async () => {
			arrangeLocalModelThatSees();
			describeImageMock.mockImplementation(async ({ image }) => {
				if (assetIdOf(image) === "asset-2") throw new Error("no description");
				return `seen ${assetIdOf(image)}`;
			});

			const { outcome } = await lookAsCloud(3);

			const rawText = distillConnectorPayloadMock.mock.calls[0]?.[0].rawText;
			expect(rawText).toContain("seen asset-1");
			expect(rawText).not.toContain("seen asset-2");
			expect(rawText).toContain("seen asset-3");
			expect(outcome.modelPayload.message).toContain("Three beach photos");
		});

		it("withholds the details, as it always did, when the summary cannot be made", async () => {
			arrangeLocalModelThatSees();
			distillConnectorPayloadMock.mockResolvedValue({ unavailable: true });

			const { outcome } = await lookAsCloud(3);

			expect(outcome.modelPayload.message).toContain("withheld");
			const wire = JSON.stringify(outcome.modelPayload);
			expect(wire).not.toContain("seen asset-");
			expect(wire).not.toContain("IMG_0001.jpg");
		});

		it("looks at nothing when no local model can see: not a download, not a description", async () => {
			modelIdCanSeeImagesMock.mockResolvedValue(false);

			const { outcome, queue } = await lookAsCloud(3);

			expect(immichThumbnailMock).not.toHaveBeenCalled();
			expect(describeImageMock).not.toHaveBeenCalled();
			expect(queue.drain()).toEqual([]);
			expect(outcome.viewedCount).toBe(0);
			expect(outcome.modelPayload.message).toContain("could not be looked at");
			// The photos' details still go through the summary, as before.
			expect(distillConnectorPayloadMock).toHaveBeenCalledTimes(1);
			expect(JSON.stringify(outcome.modelPayload)).not.toContain(
				"IMG_0001.jpg",
			);
		});

		it("looks at nothing when the model that could see is not local", async () => {
			isCloudModelMock.mockResolvedValue(true);
			modelIdCanSeeImagesMock.mockResolvedValue(true);

			const { queue } = await lookAsCloud(3);

			expect(immichThumbnailMock).not.toHaveBeenCalled();
			expect(describeImageMock).not.toHaveBeenCalled();
			expect(queue.drain()).toEqual([]);
		});

		it("queues no pixel even if the cloud model itself can see", async () => {
			modelIdCanSeeImagesMock.mockResolvedValue(true);

			const { queue } = await lookAsCloud(3);

			expect(queue.drain()).toEqual([]);
		});
	});
});
