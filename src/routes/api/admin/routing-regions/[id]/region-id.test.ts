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
import { DELETE, PATCH, POST } from "./+server";

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockGetManager = getRoutingRegionManager as ReturnType<typeof vi.fn>;
const mockConfigured = isRegionRoutingConfigured as ReturnType<typeof vi.fn>;

type RouteEvent = Parameters<typeof PATCH>[0];

const REGION_ID = "ireland-and-northern-ireland";

function makeEvent(method: string, body?: unknown, id = REGION_ID): RouteEvent {
	const url = `http://localhost/api/admin/routing-regions/${encodeURIComponent(id)}`;
	return {
		request: new Request(url, {
			method,
			...(body === undefined
				? {}
				: {
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(body),
					}),
		}),
		locals: { user: { id: "admin-1", role: "admin" } },
		params: { id: encodeURIComponent(id) },
		url: new URL(url),
		route: { id: "/api/admin/routing-regions/[id]" },
	} as unknown as RouteEvent;
}

function fakeManager() {
	return {
		retryRegion: vi.fn().mockResolvedValue({ id: REGION_ID, status: "queued" }),
		setResident: vi
			.fn()
			.mockResolvedValue({ id: REGION_ID, resident: true, status: "queued" }),
		removeRegion: vi.fn().mockResolvedValue(true),
	};
}

describe("admin routing region [id] route", () => {
	let manager: ReturnType<typeof fakeManager>;

	beforeEach(() => {
		vi.clearAllMocks();
		manager = fakeManager();
		mockRequireAdmin.mockReturnValue(undefined);
		mockConfigured.mockReturnValue(true);
		mockGetManager.mockReturnValue(manager);
	});

	it("sets a region resident", async () => {
		const response = await PATCH(makeEvent("PATCH", { resident: true }));
		expect(response.status).toBe(200);
		expect(manager.setResident).toHaveBeenCalledWith(REGION_ID, true);
		expect(await response.json()).toEqual({
			region: { id: REGION_ID, resident: true, status: "queued" },
		});
	});

	it("clears the resident flag", async () => {
		manager.setResident.mockResolvedValue({ id: REGION_ID, resident: false });
		await PATCH(makeEvent("PATCH", { resident: false }));
		expect(manager.setResident).toHaveBeenCalledWith(REGION_ID, false);
	});

	it("decodes an encoded region id", async () => {
		await PATCH(makeEvent("PATCH", { resident: true }, "europe/germany"));
		expect(manager.setResident).toHaveBeenCalledWith("europe/germany", true);
	});

	it("rejects a body without a boolean resident flag", async () => {
		for (const body of [{}, { resident: "yes" }, { resident: 1 }]) {
			const response = await PATCH(makeEvent("PATCH", body));
			expect(response.status).toBe(400);
		}
		const noBody = await PATCH(makeEvent("PATCH"));
		expect(noBody.status).toBe(400);
		expect(manager.setResident).not.toHaveBeenCalled();
	});

	it("404s an unknown region", async () => {
		manager.setResident.mockResolvedValue(null);
		const response = await PATCH(makeEvent("PATCH", { resident: true }));
		expect(response.status).toBe(404);
	});

	it("409s when routing is not configured", async () => {
		mockConfigured.mockReturnValue(false);
		const response = await PATCH(makeEvent("PATCH", { resident: true }));
		expect(response.status).toBe(409);
		expect(mockGetManager).not.toHaveBeenCalled();
	});

	it("refuses every verb when admin authorization fails", async () => {
		const forbidden = new Error("Forbidden");
		mockRequireAdmin.mockImplementation(() => {
			throw forbidden;
		});
		await expect(PATCH(makeEvent("PATCH", { resident: true }))).rejects.toBe(
			forbidden,
		);
		await expect(POST(makeEvent("POST"))).rejects.toBe(forbidden);
		await expect(DELETE(makeEvent("DELETE"))).rejects.toBe(forbidden);
		expect(mockGetManager).not.toHaveBeenCalled();
	});
});
