import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Route-level test for GET /api/connections/owntracks/devices (Task 10) —
// the device-selection listing the connect wizard's picker (otDevices in
// ConnectWizardModal.svelte) calls before startOwnTracksConnect binds one.

const listDevicesMock = vi.fn();

vi.mock("$lib/server/services/connections/providers/owntracks", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/connections/providers/owntracks")
	>("$lib/server/services/connections/providers/owntracks");
	return {
		...actual,
		owntracksListDevices: (...args: unknown[]) => listDevicesMock(...args),
	};
});

beforeEach(() => {
	listDevicesMock.mockReset();
});

afterEach(() => {
	vi.clearAllMocks();
});

function makeEvent(): Parameters<typeof import("./+server").GET>[0] {
	return {
		request: new Request(
			"https://app.example.com/api/connections/owntracks/devices",
		),
		locals: { user: { id: "userA" } },
		params: {},
		url: new URL("https://app.example.com/api/connections/owntracks/devices"),
		route: { id: "/api/connections/owntracks/devices" },
		// biome-ignore lint/suspicious/noExplicitAny: minimal RequestEvent stub
	} as any;
}

describe("GET /api/connections/owntracks/devices", () => {
	it("returns the (otUser, otDevice) pairs from owntracksListDevices as { devices }", async () => {
		const { GET } = await import("./+server");
		listDevicesMock.mockResolvedValueOnce([
			{ otUser: "alice_ot", otDevice: "phone" },
			{ otUser: "alice_ot", otDevice: "watch" },
		]);

		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data).toEqual({
			devices: [
				{ otUser: "alice_ot", otDevice: "phone" },
				{ otUser: "alice_ot", otDevice: "watch" },
			],
		});
		expect(listDevicesMock).toHaveBeenCalledWith("userA");
	});

	it("maps a not_configured OwnTracksError to 409", async () => {
		const { GET } = await import("./+server");
		const { OwnTracksError } = await import(
			"$lib/server/services/connections/providers/owntracks"
		);
		listDevicesMock.mockRejectedValueOnce(
			new OwnTracksError(
				"OwnTracks is not configured on this server",
				"not_configured",
			),
		);

		const response = await GET(makeEvent());
		expect(response.status).toBe(409);
	});

	it("maps any other failure to 502", async () => {
		const { GET } = await import("./+server");
		listDevicesMock.mockRejectedValueOnce(new Error("boom"));

		const response = await GET(makeEvent());
		expect(response.status).toBe(502);
	});
});
