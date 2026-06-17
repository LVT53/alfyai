import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/account-data-archive", () => ({
	createAccountDataArchive: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import { createAccountDataArchive } from "$lib/server/services/account-data-archive";
import { POST } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockCreateAccountDataArchive = createAccountDataArchive as ReturnType<
	typeof vi.fn
>;

type ArchiveRouteEvent = Parameters<typeof POST>[0];

function makeEvent(body: unknown, user = { id: "user-1" }): ArchiveRouteEvent {
	return {
		request: new Request("http://localhost/api/settings/account/archive", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: { user },
		cookies: {
			delete: vi.fn(),
		},
		params: {},
		url: new URL("http://localhost/api/settings/account/archive"),
		route: { id: "/api/settings/account/archive" },
	} as unknown as ArchiveRouteEvent;
}

function makeRawEvent(
	body: string,
	user = { id: "user-1" },
): ArchiveRouteEvent {
	return {
		request: new Request("http://localhost/api/settings/account/archive", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
		}),
		locals: { user },
		cookies: {
			delete: vi.fn(),
		},
		params: {},
		url: new URL("http://localhost/api/settings/account/archive"),
		route: { id: "/api/settings/account/archive" },
	} as unknown as ArchiveRouteEvent;
}

describe("POST /api/settings/account/archive", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
	});

	it("returns transient ZIP stream with neutral archive headers", async () => {
		const zipBytes = Buffer.from("zip-bytes");
		const zipStream = new Response(zipBytes).body;
		if (!zipStream) {
			throw new Error("Expected ZIP response body stream");
		}
		mockCreateAccountDataArchive.mockResolvedValue({
			status: "ok",
			filename: "AlfyAI Data Archive 2026-06-15.zip",
			zipStream,
		});

		const response = await POST(makeEvent({ password: "secret" }));

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("application/zip");
		expect(response.headers.get("Content-Disposition")).toBe(
			'attachment; filename="AlfyAI Data Archive 2026-06-15.zip"',
		);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(Buffer.from(await response.arrayBuffer())).toEqual(zipBytes);
		expect(mockCreateAccountDataArchive).toHaveBeenCalledWith("user-1", {
			password: "secret",
		});
	});

	it("returns 401 JSON when the password is incorrect", async () => {
		mockCreateAccountDataArchive.mockResolvedValue({
			status: "incorrect_password",
		});

		const response = await POST(makeEvent({ password: "wrong" }));
		const data = await response.json();

		expect(response.status).toBe(401);
		expect(data).toEqual({ error: "Incorrect password" });
	});

	it("returns 400 JSON for invalid request bodies", async () => {
		const invalidJsonResponse = await POST(makeRawEvent("{"));
		expect(invalidJsonResponse.status).toBe(400);
		expect(await invalidJsonResponse.json()).toEqual({ error: "Invalid JSON" });

		const missingPasswordResponse = await POST(makeEvent({ password: 123 }));
		expect(missingPasswordResponse.status).toBe(400);
		expect(await missingPasswordResponse.json()).toEqual({
			error: "password is required",
		});
		expect(mockCreateAccountDataArchive).not.toHaveBeenCalled();
	});
});
