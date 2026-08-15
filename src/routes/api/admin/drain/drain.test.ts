import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockConfig } = vi.hoisted(() => ({
	mockConfig: { alfyaiApiSigningKey: "" },
}));

vi.mock("$lib/server/env", () => ({
	config: mockConfig,
}));

vi.mock("$lib/server/auth/hooks", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/server/auth/hooks")>();
	return {
		...actual,
		requireAdmin: vi.fn(),
	};
});

vi.mock("$lib/server/services/chat-turn/active-streams", () => ({
	isDraining: vi.fn(),
	setDraining: vi.fn(),
	getStreamStats: vi.fn(),
}));

import { requireAdmin } from "$lib/server/auth/hooks";
import {
	getStreamStats,
	isDraining,
	setDraining,
} from "$lib/server/services/chat-turn/active-streams";
import { GET, POST } from "./+server";

type DrainRouteEvent = Parameters<typeof GET>[0];

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockIsDraining = isDraining as ReturnType<typeof vi.fn>;
const mockSetDraining = setDraining as ReturnType<typeof vi.fn>;
const mockGetStreamStats = getStreamStats as ReturnType<typeof vi.fn>;

function makeEvent(
	params: {
		method?: string;
		body?: unknown;
		authorization?: string;
		user?: { id: string; role: string } | null;
	} = {},
): DrainRouteEvent {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (params.authorization) headers.Authorization = params.authorization;
	return {
		request: new Request("http://localhost/api/admin/drain", {
			method: params.method ?? "GET",
			headers,
			...(params.method === "POST"
				? { body: JSON.stringify(params.body ?? {}) }
				: {}),
		}),
		locals: { user: params.user ?? null },
		params: {},
		url: new URL("http://localhost/api/admin/drain"),
		route: { id: "/api/admin/drain" },
	} as unknown as DrainRouteEvent;
}

describe("admin drain route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockConfig.alfyaiApiSigningKey = "";
		mockIsDraining.mockReturnValue(false);
		mockGetStreamStats.mockReturnValue({
			globalActiveCount: 0,
			perUserCounts: new Map(),
			maxGlobal: 3,
			maxPerUser: 1,
		});
	});

	describe("GET", () => {
		it("returns 401 when neither an admin session nor a service bearer token is present", async () => {
			mockRequireAdmin.mockImplementation(() => {
				throw new Error("Forbidden");
			});

			const response = await GET(makeEvent());

			expect(response.status).toBe(401);
		});

		it("returns the drain state for an admin session", async () => {
			mockRequireAdmin.mockReturnValue(undefined);
			mockIsDraining.mockReturnValue(true);
			mockGetStreamStats.mockReturnValue({
				globalActiveCount: 2,
				perUserCounts: new Map(),
				maxGlobal: 3,
				maxPerUser: 1,
			});

			const response = await GET(
				makeEvent({ user: { id: "admin-1", role: "admin" } }),
			);
			const data = await response.json();

			expect(response.status).toBe(200);
			expect(data).toEqual({ draining: true, activeStreams: 2 });
		});

		it("returns the drain state for a matching service bearer token", async () => {
			mockRequireAdmin.mockImplementation(() => {
				throw new Error("Forbidden");
			});
			mockConfig.alfyaiApiSigningKey = "secret-signing-key";

			const response = await GET(
				makeEvent({ authorization: "Bearer secret-signing-key" }),
			);

			expect(response.status).toBe(200);
		});

		it("returns 401 for a mismatched bearer token", async () => {
			mockRequireAdmin.mockImplementation(() => {
				throw new Error("Forbidden");
			});
			mockConfig.alfyaiApiSigningKey = "secret-signing-key";

			const response = await GET(
				makeEvent({ authorization: "Bearer wrong-token" }),
			);

			expect(response.status).toBe(401);
		});

		it("returns 401 for a bearer token when no signing key is configured", async () => {
			mockRequireAdmin.mockImplementation(() => {
				throw new Error("Forbidden");
			});
			mockConfig.alfyaiApiSigningKey = "";

			const response = await GET(
				makeEvent({ authorization: "Bearer anything" }),
			);

			expect(response.status).toBe(401);
		});
	});

	describe("POST", () => {
		it("returns 401 when unauthorized", async () => {
			mockRequireAdmin.mockImplementation(() => {
				throw new Error("Forbidden");
			});

			const response = await POST(
				makeEvent({ method: "POST", body: { draining: true } }),
			);

			expect(response.status).toBe(401);
			expect(mockSetDraining).not.toHaveBeenCalled();
		});

		it("sets draining true via admin session and returns the resulting state", async () => {
			mockRequireAdmin.mockReturnValue(undefined);
			mockIsDraining.mockReturnValue(true);

			const response = await POST(
				makeEvent({
					method: "POST",
					user: { id: "admin-1", role: "admin" },
					body: { draining: true },
				}),
			);
			const data = await response.json();

			expect(mockSetDraining).toHaveBeenCalledWith(true);
			expect(response.status).toBe(200);
			expect(data).toEqual({ draining: true, activeStreams: 0 });
		});

		it("sets draining false via the service bearer token", async () => {
			mockRequireAdmin.mockImplementation(() => {
				throw new Error("Forbidden");
			});
			mockConfig.alfyaiApiSigningKey = "secret-signing-key";
			mockIsDraining.mockReturnValue(false);

			const response = await POST(
				makeEvent({
					method: "POST",
					authorization: "Bearer secret-signing-key",
					body: { draining: false },
				}),
			);

			expect(mockSetDraining).toHaveBeenCalledWith(false);
			expect(response.status).toBe(200);
		});

		it("returns 400 for invalid JSON", async () => {
			mockRequireAdmin.mockReturnValue(undefined);
			const event = {
				request: new Request("http://localhost/api/admin/drain", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: "{",
				}),
				locals: { user: { id: "admin-1", role: "admin" } },
				params: {},
				url: new URL("http://localhost/api/admin/drain"),
				route: { id: "/api/admin/drain" },
			} as unknown as DrainRouteEvent;

			const response = await POST(event);

			expect(response.status).toBe(400);
			expect(mockSetDraining).not.toHaveBeenCalled();
		});

		it("returns 400 when draining is not a boolean", async () => {
			mockRequireAdmin.mockReturnValue(undefined);

			const response = await POST(
				makeEvent({
					method: "POST",
					user: { id: "admin-1", role: "admin" },
					body: { draining: "yes" },
				}),
			);

			expect(response.status).toBe(400);
			expect(mockSetDraining).not.toHaveBeenCalled();
		});
	});
});
