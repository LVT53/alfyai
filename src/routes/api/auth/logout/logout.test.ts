import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/auth", () => ({
	clearSessionCookie: vi.fn(),
}));

vi.mock("$lib/server/db", () => ({
	db: {
		delete: vi.fn(),
	},
}));

vi.mock("$lib/server/db/schema", () => ({
	sessions: {},
}));

vi.mock("drizzle-orm", () => ({
	eq: vi.fn((col, val) => ({ col, val })),
}));

import { db } from "$lib/server/db";
import { clearSessionCookie } from "$lib/server/services/auth";
import { POST } from "./+server";

const mockClearSessionCookie = clearSessionCookie as ReturnType<typeof vi.fn>;
type LogoutEvent = Parameters<typeof POST>[0];
type MockDb = {
	delete: ReturnType<typeof vi.fn>;
};
type DeleteChain = {
	where: ReturnType<typeof vi.fn>;
};
const mockDb = db as MockDb;

function makeDeleteChain(): DeleteChain {
	const chain = {} as DeleteChain;
	chain.where = vi.fn(() => Promise.resolve());
	return chain;
}

function makeEvent(sessionToken: string | null): LogoutEvent {
	const mockCookies = {
		get: vi.fn(() => sessionToken),
		delete: vi.fn(),
	};
	return { cookies: mockCookies } as LogoutEvent;
}

describe("POST /api/auth/logout", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns 200 with success:true", async () => {
		const deleteChain = makeDeleteChain();
		mockDb.delete.mockReturnValue(deleteChain);

		const event = makeEvent("valid-session-token");
		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.success).toBe(true);
	});

	it("deletes session from DB when session cookie exists", async () => {
		const deleteChain = makeDeleteChain();
		mockDb.delete.mockReturnValue(deleteChain);

		const event = makeEvent("my-session-token");
		await POST(event);

		expect(mockDb.delete).toHaveBeenCalled();
		expect(deleteChain.where).toHaveBeenCalled();
	});

	it("clears the session cookie", async () => {
		const deleteChain = makeDeleteChain();
		mockDb.delete.mockReturnValue(deleteChain);

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
		expect(mockDb.delete).not.toHaveBeenCalled();
		expect(mockClearSessionCookie).toHaveBeenCalledWith(event.cookies);
	});
});
