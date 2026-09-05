import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAdmin: vi.fn(),
}));

vi.mock("$lib/server/services/tool-health", () => ({
	getToolHealthSnapshot: vi.fn(),
	runToolHealthChecks: vi.fn(),
}));

import { requireAdmin } from "$lib/server/auth/hooks";
import {
	getToolHealthSnapshot,
	runToolHealthChecks,
} from "$lib/server/services/tool-health";
import { GET, POST } from "./+server";

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockGetSnapshot = getToolHealthSnapshot as ReturnType<typeof vi.fn>;
const mockRun = runToolHealthChecks as ReturnType<typeof vi.fn>;

type RouteEvent = Parameters<typeof GET>[0];

function makeEvent(method = "GET"): RouteEvent {
	return {
		request: new Request("http://localhost/api/admin/tool-health", { method }),
		locals: { user: { id: "admin-1", role: "admin" } },
		params: {},
		url: new URL("http://localhost/api/admin/tool-health"),
		route: { id: "/api/admin/tool-health" },
	} as RouteEvent;
}

const snapshot = {
	checkedAt: "2026-09-05T10:00:00.000Z",
	durationMs: 12,
	tools: [],
};

describe("admin tool health route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAdmin.mockReturnValue(undefined);
		mockGetSnapshot.mockResolvedValue(snapshot);
		mockRun.mockResolvedValue(snapshot);
	});

	it("returns the cached snapshot for admins", async () => {
		const response = await GET(makeEvent());
		expect(mockRequireAdmin).toHaveBeenCalled();
		expect(mockGetSnapshot).toHaveBeenCalledTimes(1);
		expect(mockRun).not.toHaveBeenCalled();
		expect(await response.json()).toEqual({ snapshot });
	});

	it("forces a refresh on POST", async () => {
		const response = await POST(makeEvent("POST"));
		expect(mockRun).toHaveBeenCalledTimes(1);
		expect(mockGetSnapshot).not.toHaveBeenCalled();
		expect(await response.json()).toEqual({ snapshot });
	});

	it("does not probe when admin authorization fails", async () => {
		const forbidden = new Error("Forbidden");
		mockRequireAdmin.mockImplementation(() => {
			throw forbidden;
		});
		await expect(GET(makeEvent())).rejects.toBe(forbidden);
		await expect(POST(makeEvent("POST"))).rejects.toBe(forbidden);
		expect(mockGetSnapshot).not.toHaveBeenCalled();
		expect(mockRun).not.toHaveBeenCalled();
	});
});
