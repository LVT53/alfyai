import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Route-level test for POST /api/connections/todoist/start — mirrors
// providers/todoist.test.ts's todoistConnect coverage but exercises the
// actual route handler, including its status-code mapping (400 missing
// token / 401 invalid token / 502 other failure) and JSON parsing.

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

const connectMock = vi.fn();

vi.mock("$lib/server/services/connections/providers/todoist", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/connections/providers/todoist")
	>("$lib/server/services/connections/providers/todoist");
	return {
		...actual,
		todoistConnect: (...args: unknown[]) => connectMock(...args),
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
			"https://app.example.com/api/connections/todoist/start",
			{
				method: "POST",
				body: JSON.stringify(body),
			},
		),
		locals: { user: { id: "userA" } },
		params: {},
		url: new URL("https://app.example.com/api/connections/todoist/start"),
		route: { id: "/api/connections/todoist/start" },
		// biome-ignore lint/suspicious/noExplicitAny: minimal RequestEvent stub
	} as any;
}

describe("POST /api/connections/todoist/start", () => {
	it("returns 400 when token is missing", async () => {
		const { POST } = await import("./+server");
		const response = await POST(makeEvent({}));
		expect(response.status).toBe(400);
		expect(connectMock).not.toHaveBeenCalled();
	});

	it("returns 400 on invalid JSON body", async () => {
		const { POST } = await import("./+server");
		const event = {
			request: new Request(
				"https://app.example.com/api/connections/todoist/start",
				{ method: "POST", body: "not json" },
			),
			locals: { user: { id: "userA" } },
			params: {},
			url: new URL("https://app.example.com/api/connections/todoist/start"),
			route: { id: "/api/connections/todoist/start" },
			// biome-ignore lint/suspicious/noExplicitAny: minimal RequestEvent stub
		} as any;
		const response = await POST(event);
		expect(response.status).toBe(400);
	});

	it("calls todoistConnect with the trimmed token and returns its result on success", async () => {
		const { POST } = await import("./+server");
		connectMock.mockResolvedValueOnce({
			connection: { id: "conn1", provider: "todoist" },
		});

		const response = await POST(makeEvent({ token: "  token-abc  " }));
		expect(response.status).toBe(200);
		expect(connectMock).toHaveBeenCalledWith({
			userId: "userA",
			token: "token-abc",
		});
		const bodyJson = await response.json();
		expect(bodyJson.connection.id).toBe("conn1");
	});

	it("maps an invalid_token TodoistError to 401", async () => {
		const { POST } = await import("./+server");
		const { TodoistError } = await import(
			"$lib/server/services/connections/providers/todoist"
		);
		connectMock.mockRejectedValueOnce(
			new TodoistError("Invalid Todoist API token", "invalid_token"),
		);

		const response = await POST(makeEvent({ token: "bad-token" }));
		expect(response.status).toBe(401);
		const bodyJson = await response.json();
		expect(bodyJson.error).not.toContain("bad-token");
	});

	it("maps any other failure to 502", async () => {
		const { POST } = await import("./+server");
		connectMock.mockRejectedValueOnce(new Error("network down"));

		const response = await POST(makeEvent({ token: "token-abc" }));
		expect(response.status).toBe(502);
	});
});
