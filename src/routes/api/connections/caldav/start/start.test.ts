import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Route-level test for POST /api/connections/caldav/start — mirrors
// providers/caldav-tasks.test.ts's caldavConnect coverage but exercises the
// actual route handler, including its status-code mapping (400 missing
// field(s) / 401 invalid credentials / 502 other failure) and JSON parsing.

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

const connectMock = vi.fn();

vi.mock("$lib/server/services/connections/providers/caldav-tasks", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/connections/providers/caldav-tasks")
	>("$lib/server/services/connections/providers/caldav-tasks");
	return {
		...actual,
		caldavConnect: (...args: unknown[]) => connectMock(...args),
	};
});

beforeEach(() => {
	connectMock.mockReset();
});

afterEach(() => {
	vi.clearAllMocks();
});

function makeEvent(
	body: unknown,
): Parameters<typeof import("./+server").POST>[0] {
	return {
		request: new Request(
			"https://app.example.com/api/connections/caldav/start",
			{
				method: "POST",
				body: JSON.stringify(body),
			},
		),
		locals: { user: { id: "userA" } },
		params: {},
		url: new URL("https://app.example.com/api/connections/caldav/start"),
		route: { id: "/api/connections/caldav/start" },
		// biome-ignore lint/suspicious/noExplicitAny: minimal RequestEvent stub
	} as any;
}

describe("POST /api/connections/caldav/start", () => {
	it("returns 400 when any required field is missing", async () => {
		const { POST } = await import("./+server");
		const response = await POST(
			makeEvent({ serverUrl: "https://dav.example.com" }),
		);
		expect(response.status).toBe(400);
		expect(connectMock).not.toHaveBeenCalled();
	});

	it("returns 400 on invalid JSON body", async () => {
		const { POST } = await import("./+server");
		const event = {
			request: new Request(
				"https://app.example.com/api/connections/caldav/start",
				{ method: "POST", body: "not json" },
			),
			locals: { user: { id: "userA" } },
			params: {},
			url: new URL("https://app.example.com/api/connections/caldav/start"),
			route: { id: "/api/connections/caldav/start" },
			// biome-ignore lint/suspicious/noExplicitAny: minimal RequestEvent stub
		} as any;
		const response = await POST(event);
		expect(response.status).toBe(400);
	});

	it("calls caldavConnect with trimmed fields and returns its result on success", async () => {
		const { POST } = await import("./+server");
		connectMock.mockResolvedValueOnce({
			connection: { id: "conn1", provider: "caldav" },
		});

		const response = await POST(
			makeEvent({
				serverUrl: "  https://dav.example.com/dav/  ",
				username: " alice ",
				appPassword: " app-pw ",
			}),
		);
		expect(response.status).toBe(200);
		expect(connectMock).toHaveBeenCalledWith({
			userId: "userA",
			serverUrl: "https://dav.example.com/dav/",
			username: "alice",
			appPassword: "app-pw",
		});
		const bodyJson = await response.json();
		expect(bodyJson.connection.id).toBe("conn1");
	});

	it("maps an invalid_credentials CalDavError to 401", async () => {
		const { POST } = await import("./+server");
		const { CalDavError } = await import(
			"$lib/server/services/connections/providers/caldav-tasks"
		);
		connectMock.mockRejectedValueOnce(
			new CalDavError(
				"The server rejected the credentials",
				"invalid_credentials",
			),
		);

		const response = await POST(
			makeEvent({
				serverUrl: "https://dav.example.com/dav/",
				username: "alice",
				appPassword: "bad-pw",
			}),
		);
		expect(response.status).toBe(401);
		const bodyJson = await response.json();
		expect(bodyJson.error).not.toContain("bad-pw");
	});

	it("maps any other failure to 502", async () => {
		const { POST } = await import("./+server");
		connectMock.mockRejectedValueOnce(new Error("network down"));

		const response = await POST(
			makeEvent({
				serverUrl: "https://dav.example.com/dav/",
				username: "alice",
				appPassword: "app-pw",
			}),
		);
		expect(response.status).toBe(502);
	});
});
