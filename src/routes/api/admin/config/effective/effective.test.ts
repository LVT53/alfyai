import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAdmin: vi.fn(),
}));

vi.mock("$lib/server/services/admin-effective-config", () => ({
	getEffectiveConfigReport: vi.fn(),
}));

import { requireAdmin } from "$lib/server/auth/hooks";
import { getEffectiveConfigReport } from "$lib/server/services/admin-effective-config";
import { GET } from "./+server";

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockReport = getEffectiveConfigReport as ReturnType<typeof vi.fn>;

type RouteEvent = Parameters<typeof GET>[0];

function makeEvent(): RouteEvent {
	return {
		request: new Request("http://localhost/api/admin/config/effective"),
		locals: { user: { id: "admin-1", role: "admin" } },
		params: {},
		url: new URL("http://localhost/api/admin/config/effective"),
		route: { id: "/api/admin/config/effective" },
	} as RouteEvent;
}

describe("admin effective config route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAdmin.mockReturnValue(undefined);
		mockReport.mockResolvedValue({
			generatedAt: "2026-09-05T10:00:00.000Z",
			entries: [],
			models: [],
		});
	});

	it("returns the effective config report for admins", async () => {
		const response = await GET(makeEvent());
		expect(mockRequireAdmin).toHaveBeenCalled();
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			generatedAt: "2026-09-05T10:00:00.000Z",
			entries: [],
			models: [],
		});
	});

	it("does not build the report when authorization fails", async () => {
		const forbidden = new Error("Forbidden");
		mockRequireAdmin.mockImplementation(() => {
			throw forbidden;
		});
		await expect(GET(makeEvent())).rejects.toBe(forbidden);
		expect(mockReport).not.toHaveBeenCalled();
	});
});
