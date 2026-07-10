import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Route-level test for POST /api/connections/owntracks/start (Task 10) —
// mirrors caldav/start/start.test.ts's shape but exercises the OwnTracks
// connect route: binding a user-picked (otUser, otDevice) pair, no
// token/password accepted (requiresSecret: false — the recorder is admin-
// configured server-side), and its status-code mapping.

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

const connectMock = vi.fn();

vi.mock("$lib/server/services/connections/providers/owntracks", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/connections/providers/owntracks")
	>("$lib/server/services/connections/providers/owntracks");
	return {
		...actual,
		owntracksConnect: (...args: unknown[]) => connectMock(...args),
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
			"https://app.example.com/api/connections/owntracks/start",
			{ method: "POST", body: JSON.stringify(body) },
		),
		locals: { user: { id: "userA" } },
		params: {},
		url: new URL("https://app.example.com/api/connections/owntracks/start"),
		route: { id: "/api/connections/owntracks/start" },
		// biome-ignore lint/suspicious/noExplicitAny: minimal RequestEvent stub
	} as any;
}

describe("POST /api/connections/owntracks/start", () => {
	it("returns 400 when otUser or otDevice is missing", async () => {
		const { POST } = await import("./+server");
		const response = await POST(makeEvent({ otUser: "alice_ot" }));
		expect(response.status).toBe(400);
		expect(connectMock).not.toHaveBeenCalled();
	});

	it("returns 400 on invalid JSON body", async () => {
		const { POST } = await import("./+server");
		const event = {
			request: new Request(
				"https://app.example.com/api/connections/owntracks/start",
				{ method: "POST", body: "not json" },
			),
			locals: { user: { id: "userA" } },
			params: {},
			url: new URL("https://app.example.com/api/connections/owntracks/start"),
			route: { id: "/api/connections/owntracks/start" },
			// biome-ignore lint/suspicious/noExplicitAny: minimal RequestEvent stub
		} as any;
		const response = await POST(event);
		expect(response.status).toBe(400);
	});

	it("calls owntracksConnect with trimmed fields (device pick -> start) and returns its result", async () => {
		const { POST } = await import("./+server");
		connectMock.mockResolvedValueOnce({
			connection: { id: "conn1", provider: "owntracks" },
		});

		const response = await POST(
			makeEvent({ otUser: "  alice_ot  ", otDevice: " phone " }),
		);
		expect(response.status).toBe(200);
		expect(connectMock).toHaveBeenCalledWith({
			userId: "userA",
			otUser: "alice_ot",
			otDevice: "phone",
		});
		const bodyJson = await response.json();
		expect(bodyJson.connection.id).toBe("conn1");
	});

	it("passes an optional trimmed label through", async () => {
		const { POST } = await import("./+server");
		connectMock.mockResolvedValueOnce({
			connection: { id: "conn1", provider: "owntracks" },
		});

		await POST(
			makeEvent({
				otUser: "alice_ot",
				otDevice: "phone",
				label: "  My Phone  ",
			}),
		);
		expect(connectMock).toHaveBeenCalledWith({
			userId: "userA",
			otUser: "alice_ot",
			otDevice: "phone",
			label: "My Phone",
		});
	});

	it("maps a not_configured OwnTracksError to 409", async () => {
		const { POST } = await import("./+server");
		const { OwnTracksError } = await import(
			"$lib/server/services/connections/providers/owntracks"
		);
		connectMock.mockRejectedValueOnce(
			new OwnTracksError(
				"OwnTracks is not configured on this server",
				"not_configured",
			),
		);

		const response = await POST(
			makeEvent({ otUser: "alice_ot", otDevice: "phone" }),
		);
		expect(response.status).toBe(409);
	});

	it("maps an invalid_config OwnTracksError to 400", async () => {
		const { POST } = await import("./+server");
		const { OwnTracksError } = await import(
			"$lib/server/services/connections/providers/owntracks"
		);
		connectMock.mockRejectedValueOnce(
			new OwnTracksError(
				"An OwnTracks user and device are required",
				"invalid_config",
			),
		);

		const response = await POST(
			makeEvent({ otUser: "alice_ot", otDevice: "phone" }),
		);
		expect(response.status).toBe(400);
	});

	it("maps any other failure to 502", async () => {
		const { POST } = await import("./+server");
		connectMock.mockRejectedValueOnce(new Error("boom"));

		const response = await POST(
			makeEvent({ otUser: "alice_ot", otDevice: "phone" }),
		);
		expect(response.status).toBe(502);
	});
});
