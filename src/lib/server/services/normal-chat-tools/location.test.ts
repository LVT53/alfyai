import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	distillConnectorPayload,
	hasLocalDistillEnabled,
	isCloudModel,
} from "$lib/server/services/connections/locality";
import {
	OwnTracksError,
	owntracksLastLocation,
	owntracksLocationHistory,
} from "$lib/server/services/connections/providers/owntracks";
import {
	needsDisambiguation,
	resolveConnectionsForCapability,
} from "$lib/server/services/connections/resolve";
import type { ConnectionPublic } from "$lib/server/services/connections/store";

import {
	locationToolInputSchema,
	runLocationTool,
	sanitizeLocationToolInput,
} from "./location";

vi.mock("$lib/server/services/connections/resolve", () => ({
	resolveConnectionsForCapability: vi.fn(),
	needsDisambiguation: vi.fn(),
}));
vi.mock("$lib/server/services/connections/providers/owntracks", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/connections/providers/owntracks")
	>("$lib/server/services/connections/providers/owntracks");
	return {
		...actual,
		owntracksLastLocation: vi.fn(),
		owntracksLocationHistory: vi.fn(),
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
const owntracksLastLocationMock = vi.mocked(owntracksLastLocation);
const owntracksLocationHistoryMock = vi.mocked(owntracksLocationHistory);
const hasLocalDistillEnabledMock = vi.mocked(hasLocalDistillEnabled);
const isCloudModelMock = vi.mocked(isCloudModel);
const distillConnectorPayloadMock = vi.mocked(distillConnectorPayload);

const LOCAL_MODEL_ID = "model1";

function makeConn(overrides: Partial<ConnectionPublic> = {}): ConnectionPublic {
	return {
		id: "conn-1",
		userId: "user-1",
		provider: "owntracks",
		label: "OwnTracks",
		accountIdentifier: "alice_ot/phone",
		status: "connected",
		statusDetail: null,
		defaultOn: false,
		allowWrites: false,
		writeAllowlist: [],
		capabilities: ["location"],
		config: { otUser: "alice_ot", otDevice: "phone" },
		oauthScopes: [],
		tokenExpiresAt: null,
		hasSecret: false,
		hasWriteSecret: false,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function resetAllMocks() {
	resolveConnectionsForCapabilityMock.mockReset();
	needsDisambiguationMock.mockReset();
	owntracksLastLocationMock.mockReset();
	owntracksLocationHistoryMock.mockReset();
	hasLocalDistillEnabledMock.mockReset();
	isCloudModelMock.mockReset();
	distillConnectorPayloadMock.mockReset();
	needsDisambiguationMock.mockReturnValue(false);
	hasLocalDistillEnabledMock.mockResolvedValue(false);
	isCloudModelMock.mockResolvedValue(false);
}

// ---------------------------------------------------------------------------
// Input schema — no write action, and NO device/user override field exists
// ---------------------------------------------------------------------------

describe("locationToolInputSchema", () => {
	it("only accepts read actions (last, history) — no write action exists", () => {
		const actionSchema = locationToolInputSchema.shape.action;
		const values = actionSchema.options as readonly string[];
		expect(values).toEqual(expect.arrayContaining(["last", "history"]));
		for (const value of values) {
			expect(value).not.toMatch(/write|create|update|delete|set|share/i);
		}
		expect(values).toHaveLength(2);
	});

	it("has NO otUser/otDevice/connection override field — isolation is enforced entirely server-side", () => {
		const shape = locationToolInputSchema.shape;
		const keys = Object.keys(shape);
		expect(keys).toEqual(
			expect.arrayContaining(["action", "from", "to", "limit"]),
		);
		for (const key of keys) {
			expect(key.toLowerCase()).not.toMatch(
				/otuser|otdevice|device|user|connection|account/i,
			);
		}
	});
});

describe("sanitizeLocationToolInput", () => {
	it("trims from/to and drops undefined optional fields", () => {
		expect(
			sanitizeLocationToolInput({
				action: "history",
				from: "  2026-01-01  ",
				to: "  2026-01-31  ",
			}),
		).toEqual({ action: "history", from: "2026-01-01", to: "2026-01-31" });
	});

	it("keeps limit when supplied and defaults to no optional fields for 'last'", () => {
		expect(sanitizeLocationToolInput({ action: "last" })).toEqual({
			action: "last",
		});
		expect(sanitizeLocationToolInput({ action: "history", limit: 10 })).toEqual(
			{ action: "history", limit: 10 },
		);
	});
});

// ---------------------------------------------------------------------------
// runLocationTool
// ---------------------------------------------------------------------------

describe("runLocationTool", () => {
	beforeEach(resetAllMocks);

	it("returns a graceful note without throwing when there is no Location connection", async () => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([]);

		const outcome = await runLocationTool(
			"user-1",
			{ action: "last" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain(
			"don't have a Location connection",
		);
		expect(outcome.modelPayload.results).toEqual([]);
		expect(outcome.modelPayload.citations).toEqual([]);
		expect(owntracksLastLocationMock).not.toHaveBeenCalled();
	});

	it("surfaces ambiguity but still executes against the first (sorted) connection", async () => {
		const connA = makeConn({ id: "conn-a", label: "Alice OwnTracks" });
		const connB = makeConn({ id: "conn-b", label: "Bob OwnTracks" });
		resolveConnectionsForCapabilityMock.mockResolvedValue([connA, connB]);
		needsDisambiguationMock.mockReturnValue(true);
		owntracksLastLocationMock.mockResolvedValue(null);

		const outcome = await runLocationTool(
			"user-1",
			{ action: "last" },
			LOCAL_MODEL_ID,
		);

		expect(owntracksLastLocationMock).toHaveBeenCalledWith("user-1", "conn-a");
		expect(outcome.modelPayload.message).toContain("2 Location connections");
		expect(outcome.modelPayload.message).toContain("Alice OwnTracks");
		expect(outcome.modelPayload.message).toContain("Bob OwnTracks");
	});

	it("passes ONLY (userId, connectionId) to owntracksLastLocation/History — never an otUser/otDevice argument", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		owntracksLastLocationMock.mockResolvedValue(null);
		owntracksLocationHistoryMock.mockResolvedValue([]);

		await runLocationTool("user-1", { action: "last" }, LOCAL_MODEL_ID);
		expect(owntracksLastLocationMock).toHaveBeenCalledWith("user-1", "conn-1");
		expect(owntracksLastLocationMock.mock.calls[0]).toHaveLength(2);

		await runLocationTool("user-1", { action: "history" }, LOCAL_MODEL_ID);
		expect(owntracksLocationHistoryMock).toHaveBeenCalledWith(
			"user-1",
			"conn-1",
			{},
		);
	});

	it("last: returns a result, citation, and Sources-tab candidate with real coordinates", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		owntracksLastLocationMock.mockResolvedValue({
			lat: 47.5,
			lon: 19.05,
			at: "2026-07-01T12:00:00.000Z",
			place: "Budapest",
			battery: 80,
		});

		const outcome = await runLocationTool(
			"user-1",
			{ action: "last" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.results).toEqual([
			{
				at: "2026-07-01T12:00:00.000Z",
				lat: 47.5,
				lon: 19.05,
				place: "Budapest",
				battery: 80,
			},
		]);
		expect(outcome.modelPayload.citations).toEqual([
			{ label: "Budapest", url: "" },
		]);
		expect(outcome.candidates).toHaveLength(1);
		expect(outcome.candidates[0]).toEqual(
			expect.objectContaining({
				sourceType: "tool",
				metadata: { lat: 47.5, lon: 19.05 },
			}),
		);
	});

	it("last: no fix available yet -> success with empty results, no throw", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		owntracksLastLocationMock.mockResolvedValue(null);

		const outcome = await runLocationTool(
			"user-1",
			{ action: "last" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.results).toEqual([]);
		expect(outcome.modelPayload.message).toContain("No location fix");
	});

	it("history: forwards from/to/limit to owntracksLocationHistory and returns results", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		owntracksLocationHistoryMock.mockResolvedValue([
			{ lat: 1, lon: 2, at: "2026-01-01T00:00:00.000Z" },
			{ lat: 3, lon: 4, at: "2026-01-02T00:00:00.000Z", place: "Home" },
		]);

		const outcome = await runLocationTool(
			"user-1",
			{ action: "history", from: "2026-01-01", to: "2026-01-31", limit: 5 },
			LOCAL_MODEL_ID,
		);

		expect(owntracksLocationHistoryMock).toHaveBeenCalledWith(
			"user-1",
			"conn-1",
			{ from: "2026-01-01", to: "2026-01-31", limit: 5 },
		);
		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.results).toHaveLength(2);
		expect(outcome.modelPayload.citations).toEqual([
			{ label: "Location at 2026-01-01T00:00:00.000Z", url: "" },
			{ label: "Home", url: "" },
		]);
	});

	it("history: empty range -> success with empty results and a clear message", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		owntracksLocationHistoryMock.mockResolvedValue([]);

		const outcome = await runLocationTool(
			"user-1",
			{ action: "history" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.results).toEqual([]);
		expect(outcome.modelPayload.message).toContain("No location history");
	});

	it("maps a not_configured adapter error to a graceful note without throwing", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		owntracksLastLocationMock.mockRejectedValue(
			new OwnTracksError("OwnTracks is not configured", "not_configured"),
		);

		const outcome = await runLocationTool(
			"user-1",
			{ action: "last" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("isn't configured");
	});

	it("maps generic adapter failures to a graceful note without throwing", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		owntracksLastLocationMock.mockRejectedValue(new Error("network exploded"));

		const outcome = await runLocationTool(
			"user-1",
			{ action: "last" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain(
			"couldn't reach your location",
		);
	});
});

// ---------------------------------------------------------------------------
// Locality Option A distillation gate — location is the MOST sensitive data
// in the whole connections feature.
// ---------------------------------------------------------------------------

describe("runLocationTool — locality Option A distillation gate", () => {
	beforeEach(resetAllMocks);

	function seedLast() {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		owntracksLastLocationMock.mockResolvedValue({
			lat: 47.497913,
			lon: 19.040236,
			at: "2026-07-01T12:00:00.000Z",
			place: "1052 Budapest, Deák Ferenc tér",
		});
	}

	async function lastOnce() {
		return runLocationTool("user-1", { action: "last" }, "whichever-model");
	}

	it("Option A off: raw lat/lon/place are returned unchanged and distill is not called", async () => {
		seedLast();
		hasLocalDistillEnabledMock.mockResolvedValue(false);
		isCloudModelMock.mockResolvedValue(true);

		const outcome = await lastOnce();

		expect(outcome.modelPayload.results[0]?.lat).toBe(47.497913);
		expect(outcome.modelPayload.results[0]?.place).toBe(
			"1052 Budapest, Deák Ferenc tér",
		);
		expect(distillConnectorPayloadMock).not.toHaveBeenCalled();
	});

	it("Option A on + local model: raw lat/lon/place are returned unchanged and distill is not called", async () => {
		seedLast();
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(false);

		const outcome = await lastOnce();

		expect(outcome.modelPayload.results[0]?.lon).toBe(19.040236);
		expect(distillConnectorPayloadMock).not.toHaveBeenCalled();
	});

	it("Option A on + cloud model: the ENTIRE model-bound payload carries only the distilled summary — raw lat/lon AND place absent, candidates keep the real coordinates", async () => {
		seedLast();
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		distillConnectorPayloadMock.mockResolvedValue({
			distilled: "The user is at a location in central Budapest.",
		});

		const outcome = await lastOnce();

		// The single most important assertion in this whole feature: raw
		// lat/lon and the place name must not appear ANYWHERE in the
		// whole model-facing payload — not just `results`, but also
		// `citations`.
		const serializedPayload = JSON.stringify(outcome.modelPayload);
		expect(serializedPayload).not.toContain("47.497913");
		expect(serializedPayload).not.toContain("19.040236");
		expect(serializedPayload).not.toContain("Deák Ferenc tér");
		expect(outcome.modelPayload.results[0]?.lat).toBeUndefined();
		expect(outcome.modelPayload.results[0]?.lon).toBeUndefined();
		expect(outcome.modelPayload.results[0]?.place).toBeUndefined();
		expect(outcome.modelPayload.message).toContain(
			"The user is at a location in central Budapest.",
		);
		expect(distillConnectorPayloadMock).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				capability: "location",
				rawText: expect.stringContaining("47.497913"),
			}),
		);
		// The MODEL-facing citation label is redacted too — the raw place must
		// never reach the cloud model through this side channel.
		expect(outcome.modelPayload.citations).toEqual([
			expect.objectContaining({ url: "" }),
		]);
		expect(outcome.modelPayload.citations[0]?.label).not.toContain(
			"Deák Ferenc tér",
		);
		// The user's own Sources-tab candidates keep the real coordinates.
		expect(outcome.candidates).toEqual([
			expect.objectContaining({
				metadata: { lat: 47.497913, lon: 19.040236 },
			}),
		]);
	});

	it("Option A on + cloud model + distill unavailable: raw details are withheld, not leaked", async () => {
		seedLast();
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		distillConnectorPayloadMock.mockResolvedValue({ unavailable: true });

		const outcome = await lastOnce();

		const serializedPayload = JSON.stringify(outcome.modelPayload);
		expect(serializedPayload).not.toContain("47.497913");
		expect(serializedPayload).not.toContain("Deák Ferenc tér");
		expect(outcome.modelPayload.message).toContain("withheld");
		expect(outcome.candidates).toEqual([
			expect.objectContaining({
				metadata: { lat: 47.497913, lon: 19.040236 },
			}),
		]);
	});

	it("a 'no fix available' result never triggers distillation (nothing raw to protect)", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		owntracksLastLocationMock.mockResolvedValue(null);
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);

		await runLocationTool("user-1", { action: "last" }, "cloud-model");

		expect(distillConnectorPayloadMock).not.toHaveBeenCalled();
	});
});
