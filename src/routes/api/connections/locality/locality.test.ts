import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/connections/locality", () => ({
	hasLocalDistillEnabled: vi.fn(),
	setLocalDistillEnabled: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import {
	hasLocalDistillEnabled,
	setLocalDistillEnabled,
} from "$lib/server/services/connections/locality";
import { GET, PATCH } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockHasLocalDistillEnabled = hasLocalDistillEnabled as ReturnType<
	typeof vi.fn
>;
const mockSetLocalDistillEnabled = setLocalDistillEnabled as ReturnType<
	typeof vi.fn
>;

function makeGetEvent(userId = "owner-user") {
	return {
		request: new Request("http://localhost/api/connections/locality"),
		locals: { user: { id: userId, role: "user" } },
		params: {},
		url: new URL("http://localhost/api/connections/locality"),
		route: { id: "/api/connections/locality" },
	} as Parameters<typeof GET>[0];
}

function makePatchEvent(body: unknown, userId = "owner-user") {
	return {
		request: new Request("http://localhost/api/connections/locality", {
			method: "PATCH",
			body: JSON.stringify(body),
		}),
		locals: { user: { id: userId, role: "user" } },
		params: {},
		url: new URL("http://localhost/api/connections/locality"),
		route: { id: "/api/connections/locality" },
	} as Parameters<typeof PATCH>[0];
}

describe("GET /api/connections/locality", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockHasLocalDistillEnabled.mockResolvedValue(false);
	});

	it("requires auth", async () => {
		await GET(makeGetEvent());
		expect(mockRequireAuth).toHaveBeenCalled();
	});

	it("returns the caller's local-distill preference", async () => {
		mockHasLocalDistillEnabled.mockResolvedValue(true);

		const response = await GET(makeGetEvent("user-b"));
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data).toEqual({ localDistill: true });
		expect(mockHasLocalDistillEnabled).toHaveBeenCalledWith("user-b");
	});
});

describe("PATCH /api/connections/locality", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockSetLocalDistillEnabled.mockResolvedValue(undefined);
	});

	it("requires auth", async () => {
		await PATCH(makePatchEvent({ localDistill: true }));
		expect(mockRequireAuth).toHaveBeenCalled();
	});

	it("400s on invalid JSON", async () => {
		const event = {
			request: new Request("http://localhost/api/connections/locality", {
				method: "PATCH",
				body: "not json",
			}),
			locals: { user: { id: "owner-user", role: "user" } },
			params: {},
			url: new URL("http://localhost/api/connections/locality"),
			route: { id: "/api/connections/locality" },
		} as Parameters<typeof PATCH>[0];

		const response = await PATCH(event);

		expect(response.status).toBe(400);
	});

	it("400s when localDistill is not a boolean", async () => {
		const response = await PATCH(makePatchEvent({ localDistill: "yes" }));
		expect(response.status).toBe(400);
	});

	it("persists and echoes the new preference, scoped to the caller", async () => {
		const response = await PATCH(
			makePatchEvent({ localDistill: true }, "user-b"),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data).toEqual({ localDistill: true });
		expect(mockSetLocalDistillEnabled).toHaveBeenCalledWith("user-b", true);
	});

	it("persists localDistill:false", async () => {
		const response = await PATCH(makePatchEvent({ localDistill: false }));
		const data = await response.json();

		expect(data).toEqual({ localDistill: false });
		expect(mockSetLocalDistillEnabled).toHaveBeenCalledWith(
			"owner-user",
			false,
		);
	});
});
