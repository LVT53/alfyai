import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/connections/locality", () => ({
	shouldWarnCloudConnector: vi.fn(),
}));

vi.mock("$lib/server/services/connections/resolve", () => ({
	getEnabledConnectionCapabilities: vi.fn(),
}));

import { shouldWarnCloudConnector } from "$lib/server/services/connections/locality";
import { getEnabledConnectionCapabilities } from "$lib/server/services/connections/resolve";
import { POST } from "./+server";

const mockShouldWarn = shouldWarnCloudConnector as ReturnType<typeof vi.fn>;
const mockGetEnabledConnectionCapabilities =
	getEnabledConnectionCapabilities as ReturnType<typeof vi.fn>;

function makeEvent(body: unknown, userId = "owner-user") {
	return {
		request: new Request("http://localhost/api/connections/cloud-warning", {
			method: "POST",
			body: JSON.stringify(body),
		}),
		locals: { user: { id: userId, role: "user" } },
		params: {},
		url: new URL("http://localhost/api/connections/cloud-warning"),
		route: { id: "/api/connections/cloud-warning" },
	} as Parameters<typeof POST>[0];
}

describe("POST /api/connections/cloud-warning", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetEnabledConnectionCapabilities.mockResolvedValue(new Set());
		mockShouldWarn.mockResolvedValue(false);
	});

	it("returns 401 (not a 302 redirect) for an anonymous caller", async () => {
		const event = {
			request: new Request("http://localhost/api/connections/cloud-warning", {
				method: "POST",
				body: JSON.stringify({ modelId: "model2", capabilities: [] }),
			}),
			locals: { user: null },
			params: {},
			url: new URL("http://localhost/api/connections/cloud-warning"),
			route: { id: "/api/connections/cloud-warning" },
		} as Parameters<typeof POST>[0];
		await expect(POST(event)).rejects.toMatchObject({ status: 401 });
		expect(mockShouldWarn).not.toHaveBeenCalled();
	});

	it("400s on invalid JSON", async () => {
		const event = {
			request: new Request("http://localhost/api/connections/cloud-warning", {
				method: "POST",
				body: "not json",
			}),
			locals: { user: { id: "owner-user", role: "user" } },
			params: {},
			url: new URL("http://localhost/api/connections/cloud-warning"),
			route: { id: "/api/connections/cloud-warning" },
		} as Parameters<typeof POST>[0];

		const response = await POST(event);

		expect(response.status).toBe(400);
	});

	it("400s when modelId is missing or not a string", async () => {
		const response = await POST(makeEvent({ capabilities: [] }));
		expect(response.status).toBe(400);
	});

	it("400s when capabilities is not an array", async () => {
		const response = await POST(
			makeEvent({ modelId: "model2", capabilities: "calendar" }),
		);
		expect(response.status).toBe(400);
	});

	it("returns shouldWarn:true for an active served capability with a cloud model and no ack", async () => {
		mockGetEnabledConnectionCapabilities.mockResolvedValue(
			new Set(["calendar"]),
		);
		mockShouldWarn.mockResolvedValue(true);

		const response = await POST(
			makeEvent({ modelId: "provider:abc:def", capabilities: ["calendar"] }),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data).toEqual({ shouldWarn: true });
		expect(mockShouldWarn).toHaveBeenCalledWith({
			userId: "owner-user",
			modelId: "provider:abc:def",
			activeCapabilities: ["calendar"],
		});
	});

	it("returns shouldWarn:false once the underlying check reports acked", async () => {
		mockGetEnabledConnectionCapabilities.mockResolvedValue(
			new Set(["calendar"]),
		);
		mockShouldWarn.mockResolvedValue(false);

		const response = await POST(
			makeEvent({ modelId: "provider:abc:def", capabilities: ["calendar"] }),
		);
		const data = await response.json();

		expect(data).toEqual({ shouldWarn: false });
	});

	it("returns shouldWarn:false when there are no active capabilities", async () => {
		mockGetEnabledConnectionCapabilities.mockResolvedValue(new Set());
		mockShouldWarn.mockResolvedValue(false);

		const response = await POST(
			makeEvent({ modelId: "provider:abc:def", capabilities: [] }),
		);
		const data = await response.json();

		expect(data).toEqual({ shouldWarn: false });
		expect(mockShouldWarn).toHaveBeenCalledWith({
			userId: "owner-user",
			modelId: "provider:abc:def",
			activeCapabilities: [],
		});
	});

	it("intersects client-claimed capabilities with the server-served set — a claimed capability the user doesn't serve never reaches shouldWarnCloudConnector", async () => {
		mockGetEnabledConnectionCapabilities.mockResolvedValue(
			new Set(["calendar"]),
		);
		mockShouldWarn.mockResolvedValue(true);

		await POST(
			makeEvent({
				modelId: "provider:abc:def",
				capabilities: ["calendar", "email", "photos"],
			}),
		);

		expect(mockShouldWarn).toHaveBeenCalledWith({
			userId: "owner-user",
			modelId: "provider:abc:def",
			activeCapabilities: ["calendar"],
		});
	});

	it("scopes the served-capability lookup to the authenticated caller", async () => {
		await POST(
			makeEvent(
				{ modelId: "provider:abc:def", capabilities: ["calendar"] },
				"user-b",
			),
		);

		expect(mockGetEnabledConnectionCapabilities).toHaveBeenCalledWith("user-b");
	});
});
