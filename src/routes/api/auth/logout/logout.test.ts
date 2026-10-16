import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/auth", () => ({
	clearSessionCookie: vi.fn(),
	deleteSession: vi.fn(),
}));

import { clearSessionCookie, deleteSession } from "$lib/server/services/auth";
import { POST } from "./+server";

const mockClearSessionCookie = clearSessionCookie as ReturnType<typeof vi.fn>;
const mockDeleteSession = deleteSession as ReturnType<typeof vi.fn>;
type LogoutEvent = Parameters<typeof POST>[0];

function makeEvent(sessionToken: string | null): LogoutEvent {
	const mockCookies = {
		get: vi.fn(() => sessionToken),
		delete: vi.fn(),
	};
	return { cookies: mockCookies } as unknown as LogoutEvent;
}

describe("POST /api/auth/logout", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns 200 with success:true", async () => {
		const event = makeEvent("valid-session-token");
		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.success).toBe(true);
	});

	// The cookie holds the token and the database holds its hash, so the route
	// hands the service the cookie's value and lets it hash: a route that looked
	// the row up by the raw token would delete nothing and leave the session live.
	it("ends the session behind the cookie's token", async () => {
		const event = makeEvent("my-session-token");
		await POST(event);

		expect(mockDeleteSession).toHaveBeenCalledOnce();
		expect(mockDeleteSession).toHaveBeenCalledWith("my-session-token");
	});

	it("clears the session cookie", async () => {
		const event = makeEvent("my-session-token");
		await POST(event);

		expect(mockClearSessionCookie).toHaveBeenCalledWith(event.cookies);
	});

	it("still returns success when no session cookie present", async () => {
		const event = makeEvent(null);
		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.success).toBe(true);
		expect(mockDeleteSession).not.toHaveBeenCalled();
		expect(mockClearSessionCookie).toHaveBeenCalledWith(event.cookies);
	});
});
