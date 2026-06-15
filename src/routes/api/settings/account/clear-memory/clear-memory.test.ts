import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/auth", () => ({
	clearSessionCookie: vi.fn(),
}));

vi.mock("$lib/server/services/privacy-controls", () => ({
	clearMemoryAndKnowledge: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import { clearSessionCookie } from "$lib/server/services/auth";
import { clearMemoryAndKnowledge } from "$lib/server/services/privacy-controls";
import { POST } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockClearSessionCookie = clearSessionCookie as ReturnType<typeof vi.fn>;
const mockClearMemoryAndKnowledge = clearMemoryAndKnowledge as ReturnType<
	typeof vi.fn
>;
type ClearMemoryRouteEvent = Parameters<typeof POST>[0];

function makeEvent(body: unknown, user = { id: "user-1" }): ClearMemoryRouteEvent {
	return {
		request: new Request(
			"http://localhost/api/settings/account/clear-memory",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			},
		),
		locals: { user },
		cookies: {
			delete: vi.fn(),
		},
		params: {},
		url: new URL("http://localhost/api/settings/account/clear-memory"),
		route: { id: "/api/settings/account/clear-memory" },
	} as unknown as ClearMemoryRouteEvent;
}

describe("POST /api/settings/account/clear-memory", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
	});

	it("clears memory and knowledge without clearing the signed-in session", async () => {
		mockClearMemoryAndKnowledge.mockResolvedValue({
			status: "cleared",
			deletedArtifactIds: ["knowledge-1"],
		});

		const event = makeEvent({ password: "secret" });
		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data).toEqual({ success: true, deletedArtifactIds: ["knowledge-1"] });
		expect(mockClearMemoryAndKnowledge).toHaveBeenCalledWith(
			"user-1",
			"secret",
		);
		expect(mockClearSessionCookie).not.toHaveBeenCalled();
	});

	it("returns 401 when the password is incorrect", async () => {
		mockClearMemoryAndKnowledge.mockResolvedValue({
			status: "incorrect_password",
		});

		const response = await POST(makeEvent({ password: "wrong" }));
		const data = await response.json();

		expect(response.status).toBe(401);
		expect(data.error).toMatch(/incorrect password/i);
		expect(mockClearSessionCookie).not.toHaveBeenCalled();
	});
});
