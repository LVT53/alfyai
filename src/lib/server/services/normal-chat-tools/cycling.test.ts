import { beforeEach, expect, it, vi } from "vitest";
import {
	distillConnectorPayload,
	hasLocalDistillEnabled,
	isCloudModel,
} from "../connections/locality";
import { loadBoschForQuestion } from "../connections/providers/bosch-flow-bridge";
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
