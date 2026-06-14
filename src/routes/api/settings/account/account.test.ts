import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/auth", () => ({
	clearSessionCookie: vi.fn(),
}));

vi.mock("$lib/server/services/cleanup", () => ({
	deleteUserAccountWithCleanup: vi.fn(),
	resetUserAccountStateWithCleanup: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import { clearSessionCookie } from "$lib/server/services/auth";
import {
	deleteUserAccountWithCleanup,
	resetUserAccountStateWithCleanup,
} from "$lib/server/services/cleanup";
import { DELETE, POST } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockClearSessionCookie = clearSessionCookie as ReturnType<typeof vi.fn>;
const mockDeleteUserAccountWithCleanup =
	deleteUserAccountWithCleanup as ReturnType<typeof vi.fn>;
const mockResetUserAccountStateWithCleanup =
	resetUserAccountStateWithCleanup as ReturnType<typeof vi.fn>;
type AccountRouteEvent = Parameters<typeof DELETE>[0];

function makeEvent(
	body: unknown,
	method: "DELETE" | "POST" = "DELETE",
	user = { id: "user-1" },
): AccountRouteEvent {
	return {
		request: new Request("http://localhost/api/settings/account", {
			method,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: { user },
		cookies: {
			delete: vi.fn(),
		},
		params: {},
		url: new URL("http://localhost/api/settings/account"),
		route: { id: "/api/settings/account" },
	} as AccountRouteEvent;
}

describe("DELETE /api/settings/account", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
	});

	it("deletes the user account and clears the session cookie on success", async () => {
		mockDeleteUserAccountWithCleanup.mockResolvedValue({ status: "deleted" });
		const event = makeEvent({ password: "secret" });

		const response = await DELETE(event);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.success).toBe(true);
		expect(mockDeleteUserAccountWithCleanup).toHaveBeenCalledWith(
			"user-1",
			"secret",
		);
		expect(mockClearSessionCookie).toHaveBeenCalledWith(event.cookies);
	});

	it("returns 401 when the password is incorrect", async () => {
		mockDeleteUserAccountWithCleanup.mockResolvedValue({
			status: "incorrect_password",
		});

		const response = await DELETE(makeEvent({ password: "wrong" }));
		const data = await response.json();

		expect(response.status).toBe(401);
		expect(data.error).toMatch(/incorrect password/i);
		expect(mockClearSessionCookie).not.toHaveBeenCalled();
	});

	it("returns 500 when cleanup fails", async () => {
		mockDeleteUserAccountWithCleanup.mockRejectedValue(
			new Error("honcho down"),
		);

		const response = await DELETE(makeEvent({ password: "secret" }));
		const data = await response.json();

		expect(response.status).toBe(500);
		expect(data.error).toMatch(/failed to fully delete account data/i);
		expect(mockClearSessionCookie).not.toHaveBeenCalled();
	});
});

describe("POST /api/settings/account", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
	});

	it("resets the user account state and preserves the session on success", async () => {
		mockResetUserAccountStateWithCleanup.mockResolvedValue({ status: "reset" });
		const event = makeEvent({ password: "secret" }, "POST");

		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.success).toBe(true);
		expect(mockResetUserAccountStateWithCleanup).toHaveBeenCalledWith(
			"user-1",
			"secret",
		);
		expect(mockClearSessionCookie).toHaveBeenCalledWith(event.cookies);
	});

	it("returns 401 when the reset password is incorrect", async () => {
		mockResetUserAccountStateWithCleanup.mockResolvedValue({
			status: "incorrect_password",
		});

		const response = await POST(makeEvent({ password: "wrong" }, "POST"));
		const data = await response.json();

		expect(response.status).toBe(401);
		expect(data.error).toMatch(/incorrect password/i);
	});

	it("returns 500 when reset cleanup fails", async () => {
		mockResetUserAccountStateWithCleanup.mockRejectedValue(
			new Error("db locked"),
		);

		const response = await POST(makeEvent({ password: "secret" }, "POST"));
		const data = await response.json();

		expect(response.status).toBe(500);
		expect(data.error).toMatch(/failed to fully reset account data/i);
	});
});
