import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/tool-health", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/server/services/tool-health")>();
	return { ...actual, getToolHealthSnapshot: vi.fn() };
});

import { requireAuth } from "$lib/server/auth/hooks";
import { getToolHealthSnapshot } from "$lib/server/services/tool-health";
import { GET } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockGetSnapshot = getToolHealthSnapshot as ReturnType<typeof vi.fn>;

type RouteEvent = Parameters<typeof GET>[0];

function makeEvent(): RouteEvent {
	return {
		request: new Request("http://localhost/api/system/capabilities"),
		locals: { user: { id: "user-1", role: "user" } },
		params: {},
		url: new URL("http://localhost/api/system/capabilities"),
		route: { id: "/api/system/capabilities" },
	} as RouteEvent;
}

describe("system capabilities route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockGetSnapshot.mockResolvedValue({
			checkedAt: "2026-09-05T10:00:00.000Z",
			durationMs: 5,
			tools: [
				{
					id: "research_web",
					tool: "research_web",
					backend: "Parallel API",
					status: "degraded",
					configured: true,
					probed: true,
					latencyMs: 40,
					detail: "authentication rejected (HTTP 401) https://secret.example",
					connectedConnections: null,
					checkedAt: "2026-09-05T10:00:00.000Z",
					degradedSince: "2026-09-05T09:30:00.000Z",
				},
				{
					id: "image_search",
					tool: "image_search",
					backend: "Brave Search",
					status: "healthy",
					configured: true,
					probed: true,
					latencyMs: 10,
					detail: "HTTP 200",
					connectedConnections: null,
					checkedAt: "2026-09-05T10:00:00.000Z",
					degradedSince: null,
				},
				{
					id: "map_route",
					tool: "map_route",
					backend: "OpenRouteService",
					status: "unconfigured",
					configured: false,
					probed: false,
					latencyMs: null,
					detail: "not configured",
					connectedConnections: null,
					checkedAt: "2026-09-05T10:00:00.000Z",
					degradedSince: null,
				},
			],
		});
	});

	it("returns only degraded tools without probe details", async () => {
		const response = await GET(makeEvent());
		expect(mockRequireAuth).toHaveBeenCalled();
		expect(mockGetSnapshot).toHaveBeenCalledWith({ maxAgeMs: 300_000 });
		const body = await response.json();
		expect(body).toEqual({
			degraded: [
				{
					tool: "research_web",
					backend: "Parallel API",
					since: "2026-09-05T09:30:00.000Z",
				},
			],
			checkedAt: "2026-09-05T10:00:00.000Z",
		});
		expect(JSON.stringify(body)).not.toContain("secret.example");
		expect(JSON.stringify(body)).not.toContain("detail");
	});

	it("does not read the snapshot when unauthenticated", async () => {
		const redirect = new Error("redirect");
		mockRequireAuth.mockImplementation(() => {
			throw redirect;
		});
		await expect(GET(makeEvent())).rejects.toBe(redirect);
		expect(mockGetSnapshot).not.toHaveBeenCalled();
	});
});
