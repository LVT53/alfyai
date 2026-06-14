import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAdmin: vi.fn(),
}));

vi.mock("$lib/server/services/user-admin", () => ({
	revokeManagedUserSessions: vi.fn(),
}));

import { requireAdmin } from "$lib/server/auth/hooks";
import { revokeManagedUserSessions } from "$lib/server/services/user-admin";
import { DELETE } from "./+server";

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockRevokeManagedUserSessions = revokeManagedUserSessions as ReturnType<
	typeof vi.fn
>;
type AdminUserSessionsEvent = Parameters<typeof DELETE>[0];

function makeEvent(): AdminUserSessionsEvent {
	return {
		request: new Request("http://localhost/api/admin/users/user-2/sessions", {
			method: "DELETE",
		}),
		locals: { user: { id: "admin-1", role: "admin" } },
		params: { id: "user-2" },
		url: new URL("http://localhost/api/admin/users/user-2/sessions"),
		route: { id: "/api/admin/users/[id]/sessions" },
	} as AdminUserSessionsEvent;
}

describe("admin user sessions route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAdmin.mockReturnValue(undefined);
	});

	it("revokes all sessions for the target user", async () => {
		const response = await DELETE(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.success).toBe(true);
		expect(mockRevokeManagedUserSessions).toHaveBeenCalledWith("user-2");
	});

	it("returns 404 when the user does not exist", async () => {
		mockRevokeManagedUserSessions.mockRejectedValue(
			new Error("User not found."),
		);

		const response = await DELETE(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data.error).toMatch(/not found/i);
	});
});
