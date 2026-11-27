import { beforeEach, expect, it, vi } from "vitest";
import {
	distillConnectorPayload,
	hasLocalDistillEnabled,
	isCloudModel,
} from "../connections/locality";
import {
	loadBoschDetailForQuestion,
	loadBoschForQuestion,
} from "../connections/providers/bosch-flow-bridge";
import { resolveConnectionsForCapability } from "../connections/resolve";
import type { ConnectionPublic } from "../connections/store";
import { runCyclingTool } from "./cycling";
import { reasonCodeOf } from "./shared";

vi.mock("../connections/resolve", async (importOriginal) => ({
	...(await importOriginal<typeof import("../connections/resolve")>()),
	resolveConnectionsForCapability: vi.fn(),
}));
vi.mock("../connections/providers/bosch-flow-bridge", () => ({
	loadBoschForQuestion: vi.fn(),
	loadBoschDetailForQuestion: vi.fn(),
}));
vi.mock("../connections/locality", () => ({
	hasLocalDistillEnabled: vi.fn(),
	isCloudModel: vi.fn(),
	distillConnectorPayload: vi.fn(),
}));
vi.mock("./shared", async (importOriginal) => ({
	...(await importOriginal<typeof import("./shared")>()),
	isInsideToolCall: () => true,
	markCallLocallyDistilled: vi.fn(),
}));
const conn: ConnectionPublic = {
	id: "personal-1",
	userId: "rider",
	provider: "bosch",
	label: "My bike",
	accountIdentifier: "personal",
	status: "connected",
	statusDetail: null,
	defaultOn: true,
	allowWrites: false,
	writeAllowlist: [],
	capabilities: ["cycling"],
	config: {},
	oauthScopes: [],
	tokenExpiresAt: null,
	hasSecret: true,
	hasWriteSecret: false,
	createdAt: 0,
	updatedAt: 0,
};
const start = "2026-11-01T00:00:00Z";
const end = "2026-12-01T00:00:00Z";
const ride = { id: "r", startTime: start, endTime: null, distanceMeters: 1800 };
const snapshot = {
	syncedAt: Date.parse(end),
	complete: false,
	rides: [
		ride,
		ride,
		{ ...ride, id: "r2", distanceMeters: null },
		{ ...ride, id: "outside", startTime: end },
	],
	bikes: [{ name: "Private bike", id: "bike" }],
};
beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(resolveConnectionsForCapability).mockResolvedValue([conn]);
	vi.mocked(loadBoschForQuestion).mockResolvedValue({ snapshot, fresh: true });
});
it("requests data for only the requesting rider's chosen account", async () => {
	const out = await runCyclingTool(
		"rider",
		{ action: "bikes", account: "My bike" },
		"model",
	);
	expect(loadBoschForQuestion).toHaveBeenCalledWith("rider", "personal-1");
	expect(out.modelPayload.bikes).toEqual(snapshot.bikes);
	expect(out.modelPayload.fresh).toBe(true);
	vi.mocked(loadBoschForQuestion).mockClear();
	const other = await runCyclingTool(
		"rider",
		{ action: "bikes", account: "Another rider" },
		"model",
	);
	expect(other.modelPayload.success).toBe(false);
	expect(loadBoschForQuestion).not.toHaveBeenCalled();
});
it("counts unique rides in the half-open date range and discloses a partial archive and missing distances", async () => {
	const out = await runCyclingTool(
		"rider",
		{ action: "summary", start, end },
		"model",
	);
	expect(out.modelPayload.summary).toEqual({
		rideCount: 2,
		distanceMeters: 1800,
		ridesWithoutDistance: 1,
	});
	expect(out.modelPayload.complete).toBe(false);
	expect(out.modelPayload.message).toContain("incomplete");
});
it("labels the offline fallback with its timestamp and distinguishes no saved data", async () => {
	vi.mocked(loadBoschForQuestion)
		.mockResolvedValueOnce({ snapshot, fresh: false })
		.mockResolvedValueOnce({ snapshot: null, fresh: false });
	const cached = await runCyclingTool(
		"rider",
		{ action: "rides", limit: 1 },
		"model",
	);
	expect(cached.modelPayload.rides).toHaveLength(1);
	expect(cached.modelPayload.nextOffset).toBe(1);
	expect(cached.modelPayload.message).toContain("2026-12-01T00:00:00.000Z");
	expect(cached.modelPayload.fresh).toBe(false);
	expect(
		reasonCodeOf(
			(await runCyclingTool("rider", { action: "bikes" }, "model"))
				.modelPayload,
		),
	).toBe("not_set_up");
});
it("hides raw personal ride data when a cloud model receives a local summary", async () => {
	vi.mocked(hasLocalDistillEnabled).mockResolvedValue(true);
	vi.mocked(isCloudModel).mockResolvedValue(true);
	vi.mocked(distillConnectorPayload).mockResolvedValue({
		distilled: "One bike.",
	});
	vi.mocked(loadBoschForQuestion).mockResolvedValueOnce({
		snapshot,
		fresh: false,
	});
	const out = await runCyclingTool("rider", { action: "bikes" }, "cloud");
	expect(out.modelPayload.message).toContain("cached");
	expect(out.modelPayload.message).toContain("One bike.");
	expect(JSON.stringify(out.modelPayload)).not.toContain("Private bike");
	expect(out.candidates).toEqual([]);
});

it.each([true, false])(
	"treats an entirely empty Bosch snapshot as unverified access (fresh=%s)",
	async (fresh) => {
		vi.mocked(loadBoschForQuestion).mockResolvedValue({
			snapshot: { ...snapshot, complete: true, bikes: [], rides: [] },
			fresh,
		});
		vi.mocked(hasLocalDistillEnabled).mockResolvedValue(true);
		vi.mocked(isCloudModel).mockResolvedValue(true);
		for (const action of ["bikes", "rides", "summary"] as const) {
			const { modelPayload, candidates } = await runCyclingTool(
				"rider",
				{ action, start, end },
				"cloud",
			);
			expect(modelPayload).toMatchObject({
				success: false,
				complete: false,
				summary: null,
				fresh,
				syncedAt: new Date(snapshot.syncedAt).toISOString(),
			});
			expect(modelPayload.message).toContain("Manage Access");
			if (!fresh)
				expect(modelPayload.message).toContain(
					new Date(snapshot.syncedAt).toISOString(),
				);
			expect(candidates).toEqual([]);
			expect(reasonCodeOf(modelPayload)).toBe("no_visible_rider_data");
		}
		expect(distillConnectorPayload).not.toHaveBeenCalled();
	},
);
it("can still report zero in a requested range with data from another period", async () => {
	vi.mocked(loadBoschForQuestion).mockResolvedValue({
		snapshot: {
			...snapshot,
			complete: true,
			bikes: [],
			rides: [{ ...ride, startTime: end }],
		},
		fresh: true,
	});
	const { modelPayload } = await runCyclingTool(
		"rider",
		{ action: "summary", start, end },
		"model",
	);
	expect(modelPayload).toMatchObject({
		success: true,
		complete: true,
		summary: { rideCount: 0, distanceMeters: 0 },
	});
});

it("requires current detail consent without serving cached summaries as detail", async () => {
	vi.mocked(loadBoschDetailForQuestion).mockResolvedValue({
		status: "consent_required",
	});
	const out = await runCyclingTool(
		"rider",
		{ action: "bike_profile", id: "b1" },
		"model",
	);
	expect(loadBoschDetailForQuestion).toHaveBeenCalledWith(
		"rider",
		"personal-1",
		{ action: "bike_profile", id: "b1" },
	);
	expect(loadBoschForQuestion).not.toHaveBeenCalled();
	expect(out.modelPayload.success).toBe(false);
	expect(reasonCodeOf(out.modelPayload)).toBe("detail_consent_required");
});
it("distills detailed location locally and never returns the raw fields or candidates to a protected cloud turn", async () => {
	vi.mocked(loadBoschDetailForQuestion).mockResolvedValue({
		status: "ready",
		result: {
			fields: [{ path: "activityDetails.0.longitude", value: 72.114839 }],
			nextOffset: null,
		},
	});
	vi.mocked(hasLocalDistillEnabled).mockResolvedValue(true);
	vi.mocked(isCloudModel).mockResolvedValue(true);
	vi.mocked(distillConnectorPayload)
		.mockResolvedValueOnce({ distilled: "The ride crossed town." })
		.mockResolvedValueOnce({ unavailable: true });
	for (const expected of ["The ride crossed town.", "withheld"]) {
		const out = await runCyclingTool(
			"rider",
			{ action: "ride_route", id: "r1" },
			"cloud",
		);
		expect(out.modelPayload.message).toContain(expected);
		expect(out.modelPayload.detail).toBeUndefined();
		expect(out.candidates).toEqual([]);
		expect(JSON.stringify(out)).not.toContain("72.114839");
	}
});

it("includes Bosch units for a requested odometer, preserving the selected bike and path", async () => {
	vi.mocked(loadBoschDetailForQuestion).mockResolvedValue({
		status: "ready",
		result: {
			fields: [{ path: "driveUnit.odometer", value: 21000 }],
			nextOffset: null,
		},
	});
	const { modelPayload } = await runCyclingTool(
		"rider",
		{ action: "bike_profile", id: "b1", field: "driveUnit.odometer" },
		"model",
	);
	expect(modelPayload.units).toEqual({ "driveUnit.odometer": "m" });
	expect(modelPayload.detail?.fields).toEqual([
		{ path: "driveUnit.odometer", value: 21000 },
	]);
});
it.each([
	["access_denied", "detail_access_denied"],
	["not_found", "item_not_found"],
	["offline", "detail_unavailable"],
] as const)(
	"keeps %s separate from a zero-valued dealer measurement",
	async (status, reason) => {
		vi.mocked(loadBoschDetailForQuestion).mockResolvedValue({ status });
		const { modelPayload } = await runCyclingTool(
			"rider",
			{ action: "battery_capacity", id: "b1" },
			"model",
		);
		expect(reasonCodeOf(modelPayload)).toBe(reason);
		expect(modelPayload.summary).toBeNull();
		expect(modelPayload.detail).toBeUndefined();
	},
);
