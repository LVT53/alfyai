import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAdmin: vi.fn(),
}));

vi.mock("$lib/server/services/routing/region-runtime", () => ({
	getRoutingRegionManager: vi.fn(),
	isRegionRoutingConfigured: vi.fn(),
}));

import { requireAdmin } from "$lib/server/auth/hooks";
import {
	getRoutingRegionManager,
	isRegionRoutingConfigured,
} from "$lib/server/services/routing/region-runtime";
import { GET } from "./+server";

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockGetManager = getRoutingRegionManager as ReturnType<typeof vi.fn>;
const mockConfigured = isRegionRoutingConfigured as ReturnType<typeof vi.fn>;

type RouteEvent = Parameters<typeof GET>[0];

function makeEvent(): RouteEvent {
	const url = "http://localhost/api/admin/routing-regions";
	return {
		request: new Request(url),
		locals: { user: { id: "admin-1", role: "admin" } },
		params: {},
		url: new URL(url),
		route: { id: "/api/admin/routing-regions" },
	} as unknown as RouteEvent;
}

const HUNGARY = { id: "hungary", name: "Hungary", transitStatus: "ready" };
const FEEDS = [
	{ id: "bkk", name: "BKK Budapest", status: "ready", refreshDays: 1 },
	{ id: "mav-gysev", name: "MÁV rail", status: "error", refreshDays: 7 },
];

describe("admin routing regions list route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAdmin.mockReturnValue(undefined);
		mockConfigured.mockReturnValue(true);
	});

	it("attaches each region's per-feed timetable detail", async () => {
		const describeTransitFeeds = vi.fn().mockReturnValue(FEEDS);
		mockGetManager.mockReturnValue({
			listRegions: vi.fn().mockResolvedValue([HUNGARY]),
			describeTransitFeeds,
		});
		const response = await GET(makeEvent());
		expect(response.status).toBe(200);
		// A country's timetables are ~21 downloads, so the table needs to say
		// WHICH operator is missing, not just that the region has an error.
		expect(await response.json()).toEqual({
			configured: true,
			regions: [{ ...HUNGARY, feeds: FEEDS }],
		});
		expect(describeTransitFeeds).toHaveBeenCalledWith(HUNGARY);
	});

	it("reports not-configured without touching the manager", async () => {
		mockConfigured.mockReturnValue(false);
		const response = await GET(makeEvent());
		expect(await response.json()).toEqual({ configured: false, regions: [] });
		expect(mockGetManager).not.toHaveBeenCalled();
	});

	it("refuses a non-admin", async () => {
		const forbidden = new Error("Forbidden");
		mockRequireAdmin.mockImplementation(() => {
			throw forbidden;
		});
		await expect(GET(makeEvent())).rejects.toBe(forbidden);
		expect(mockGetManager).not.toHaveBeenCalled();
	});
});
