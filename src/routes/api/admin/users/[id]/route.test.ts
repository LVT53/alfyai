import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAdmin: vi.fn(),
}));

vi.mock("$lib/server/services/user-admin", () => ({
	deleteManagedUser: vi.fn(),
	setManagedUserExplicitPictureFilterExempt: vi.fn(),
	updateManagedUserRole: vi.fn(),
}));

import { requireAdmin } from "$lib/server/auth/hooks";
import {
	deleteManagedUser,
	setManagedUserExplicitPictureFilterExempt,
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

	it("exempts a person from the explicit-picture filter", async () => {
		const mockExempt = setManagedUserExplicitPictureFilterExempt as ReturnType<
			typeof vi.fn
		>;
		mockExempt.mockResolvedValue({
			id: "user-2",
			explicitPictureFilterExempt: true,
		});

		const response = await PATCH(
			makeEvent("PATCH", { explicitPictureFilterExempt: true }),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.user.explicitPictureFilterExempt).toBe(true);
		expect(mockExempt).toHaveBeenCalledWith({
			targetUserId: "user-2",
			exempt: true,
		});
		expect(mockUpdateManagedUserRole).not.toHaveBeenCalled();
	});

	it("returns 400 when the exemption is not a boolean", async () => {
		const response = await PATCH(
			makeEvent("PATCH", { explicitPictureFilterExempt: "yes" }),
		);
		expect(response.status).toBe(400);
		expect(
			setManagedUserExplicitPictureFilterExempt as ReturnType<typeof vi.fn>,
		).not.toHaveBeenCalled();
	});

	it("returns 400, not 500, for a JSON body that is not an object", async () => {
		for (const body of [null, 42, "admin", []]) {
			const response = await PATCH(makeEvent("PATCH", body));
			expect(response.status, JSON.stringify(body)).toBe(400);
		}
		expect(mockUpdateManagedUserRole).not.toHaveBeenCalled();
	});

	it("returns 400 for a role change and an exemption in one body", async () => {
		const response = await PATCH(
			makeEvent("PATCH", { role: "admin", explicitPictureFilterExempt: true }),
		);
		expect(response.status).toBe(400);
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
