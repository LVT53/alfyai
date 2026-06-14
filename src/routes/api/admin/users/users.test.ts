import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAdmin: vi.fn(),
}));

vi.mock("$lib/server/services/user-admin", () => ({
	createManagedUser: vi.fn(),
	listManagedUsers: vi.fn(),
}));

import { requireAdmin } from "$lib/server/auth/hooks";
import {
	createManagedUser,
	listManagedUsers,
} from "$lib/server/services/user-admin";
import { GET, POST } from "./+server";

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockCreateManagedUser = createManagedUser as ReturnType<typeof vi.fn>;
const mockListManagedUsers = listManagedUsers as ReturnType<typeof vi.fn>;
type AdminUsersEvent = Parameters<typeof GET>[0];

function makeEvent(body?: unknown): AdminUsersEvent {
	return {
		request: new Request("http://localhost/api/admin/users", {
			method: body === undefined ? "GET" : "POST",
			headers:
				body === undefined ? undefined : { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		locals: { user: { id: "admin-1", role: "admin" } },
		params: {},
		url: new URL("http://localhost/api/admin/users"),
		route: { id: "/api/admin/users" },
	} as AdminUsersEvent;
}

describe("admin users collection route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAdmin.mockReturnValue(undefined);
	});

	it("lists managed users", async () => {
		mockListManagedUsers.mockResolvedValue([
			{ id: "user-1", email: "u@example.com" },
		]);

		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.users).toHaveLength(1);
		expect(mockListManagedUsers).toHaveBeenCalled();
	});

	it("creates a managed user", async () => {
		mockCreateManagedUser.mockResolvedValue({
			id: "user-2",
			email: "new@example.com",
			role: "user",
		});

		const response = await POST(
			makeEvent({
				email: "new@example.com",
				password: "supersecret",
				name: "New User",
				role: "user",
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(201);
		expect(data.user.email).toBe("new@example.com");
		expect(mockCreateManagedUser).toHaveBeenCalledWith({
			email: "new@example.com",
			password: "supersecret",
			name: "New User",
			role: "user",
		});
	});

	it("returns 400 when required create fields are missing", async () => {
		const response = await POST(
			makeEvent({ email: "missing-password@example.com" }),
		);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toMatch(/email and password/i);
		expect(mockCreateManagedUser).not.toHaveBeenCalled();
	});

	it("maps duplicate user creation to 409", async () => {
		mockCreateManagedUser.mockRejectedValue(
			new Error("A user with that email already exists."),
		);

		const response = await POST(
			makeEvent({
				email: "taken@example.com",
				password: "supersecret",
				role: "user",
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(409);
		expect(data.error).toMatch(/already exists/i);
	});
});
