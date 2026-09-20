import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAdmin: vi.fn(),
}));

vi.mock("$lib/server/services/mineru/capabilities", () => ({
	getMineruStatusReport: vi.fn(),
}));

import { requireAdmin } from "$lib/server/auth/hooks";
import { getMineruStatusReport } from "$lib/server/services/mineru/capabilities";
import { GET } from "./+server";

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockReport = getMineruStatusReport as ReturnType<typeof vi.fn>;

type RouteEvent = Parameters<typeof GET>[0];

function makeEvent(search = ""): RouteEvent {
	const url = new URL(`http://localhost/api/admin/mineru-status${search}`);
	return {
		request: new Request(url, { method: "GET" }),
		locals: { user: { id: "admin-1", role: "admin" } },
		params: {},
		url,
		route: { id: "/api/admin/mineru-status" },
	} as RouteEvent;
}

const report = {
	checkedAt: "2026-09-20T10:00:00.000Z",
	baseUrl: "http://127.0.0.1:8001",
	reachable: true,
	version: "4.0.4",
	webhook: false,
	outputFormats: ["markdown", "middle_json", "structured_content", "zip"],
	sources: ["file_id", "url", "inline"],
	tiers: [{ id: "flash", description: "Fast.", currentModel: "flash" }],
	accessLevel: "anonymous",
	limits: {
		maxFileSizeBytes: 209715200,
		maxPagesPerFile: 1000,
		maxFilesPerJob: 100,
		maxConcurrentJobs: 1,
	},
	error: null,
	cached: false,
};

describe("admin MinerU status route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAdmin.mockReturnValue(undefined);
		mockReport.mockResolvedValue(report);
	});

	it("requires an admin", async () => {
		await GET(makeEvent());
		expect(mockRequireAdmin).toHaveBeenCalledTimes(1);
	});

	it("serves the cached report by default", async () => {
		const response = await GET(makeEvent());
		expect(mockReport).toHaveBeenCalledWith({ refresh: false });
		expect(await response.json()).toEqual({ report });
	});

	it("forces a live probe for refresh=1", async () => {
		await GET(makeEvent("?refresh=1"));
		expect(mockReport).toHaveBeenCalledWith({ refresh: true });
	});

	it("treats any other refresh value as no refresh", async () => {
		await GET(makeEvent("?refresh=please"));
		expect(mockReport).toHaveBeenCalledWith({ refresh: false });
	});

	it("passes an unreachable report through unchanged", async () => {
		// The card needs the taxonomy code and the message; the route must not
		// turn a probe failure into an HTTP error, or "MinerU is down" would be
		// indistinguishable from "this endpoint is broken".
		mockReport.mockResolvedValue({
			...report,
			reachable: false,
			version: null,
			tiers: [],
			error: { code: "unavailable", message: "fetch failed (ECONNREFUSED)" },
		});
		const response = await GET(makeEvent());
		expect(response.status).toBe(200);
		const body = (await response.json()) as { report: typeof report };
		expect(body.report.reachable).toBe(false);
		expect(body.report.error).toEqual({
			code: "unavailable",
			message: "fetch failed (ECONNREFUSED)",
		});
	});
});
