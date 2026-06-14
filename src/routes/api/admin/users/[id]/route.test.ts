import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAdmin: vi.fn(),
}));

vi.mock("$lib/server/services/user-admin", () => ({
	deleteManagedUser: vi.fn(),
	updateManagedUserRole: vi.fn(),
}));

import { requireAdmin } from "$lib/server/auth/hooks";
import {
	deleteManagedUser,
	updateManagedUserRole,
} from "$lib/server/services/user-admin";
import { DELETE, PATCH } from "./+server";

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockDeleteManagedUser = deleteManagedUser as ReturnType<typeof vi.fn>;
const mockUpdateManagedUserRole = updateManagedUserRole as ReturnType<
	typeof vi.fn
>;
type AdminUserRouteEvent = Parameters<typeof PATCH>[0];

function makeEvent(
	method: "PATCH" | "DELETE",
	body?: unknown,
): AdminUserRouteEvent {
	return {
		request: new Request("http://localhost/api/admin/users/user-2", {
			method,
			headers:
				body === undefined ? undefined : { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		locals: { user: { id: "admin-1", role: "admin" } },
		params: { id: "user-2" },
		url: new URL("http://localhost/api/admin/users/user-2"),
		route: { id: "/api/admin/users/[id]" },
	} as AdminUserRouteEvent;
}

describe("admin user detail route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAdmin.mockReturnValue(undefined);
	});

	it("updates a user role", async () => {
		mockUpdateManagedUserRole.mockResolvedValue({
			id: "user-2",
			role: "admin",
		});

		const response = await PATCH(makeEvent("PATCH", { role: "admin" }));
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.user.role).toBe("admin");
		expect(mockUpdateManagedUserRole).toHaveBeenCalledWith({
			actorUserId: "admin-1",
			targetUserId: "user-2",
			role: "admin",
		});
	});

	it("returns 400 on invalid role updates", async () => {
		const response = await PATCH(makeEvent("PATCH", { role: "owner" }));
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toMatch(/role must be user or admin/i);
		expect(mockUpdateManagedUserRole).not.toHaveBeenCalled();
	});

	it("deletes a user", async () => {
		const response = await DELETE(makeEvent("DELETE"));
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.success).toBe(true);
		expect(mockDeleteManagedUser).toHaveBeenCalledWith({
			actorUserId: "admin-1",
			targetUserId: "user-2",
		});
	});

	it("maps last-admin safeguards to 400", async () => {
		mockDeleteManagedUser.mockRejectedValue(
			new Error("The last admin account cannot be removed or demoted."),
		);

		const response = await DELETE(makeEvent("DELETE"));
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toMatch(/last admin/i);
	});
});
