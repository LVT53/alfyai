import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/connections/store", () => ({
	listConnectionsForUser: vi.fn(),
}));

import { listConnectionsForUser } from "$lib/server/services/connections/store";
import { GET } from "./+server";

const mockListConnectionsForUser = listConnectionsForUser as ReturnType<
	typeof vi.fn
>;

function makeEvent(userId = "owner-user") {
	return {
		request: new Request("http://localhost/api/connections"),
		locals: { user: { id: userId, role: "user" } },
		params: {},
		url: new URL("http://localhost/api/connections"),
		route: { id: "/api/connections" },
	} as Parameters<typeof GET>[0];
}

const secretlessConnection = {
	id: "conn-1",
	userId: "owner-user",
	provider: "google" as const,
	label: "Google",
	accountIdentifier: "person@example.com",
	status: "connected" as const,
	statusDetail: null,
	defaultOn: true,
	allowWrites: false,
	writeAllowlist: [],
	capabilities: ["calendar"],
	config: {},
	oauthScopes: ["calendar"],
	tokenExpiresAt: null,
	hasSecret: true,
	hasWriteSecret: false,
	createdAt: 1,
	updatedAt: 1,
};

describe("GET /api/connections", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockListConnectionsForUser.mockResolvedValue([]);
	});

	it("returns 401 (not a 302 redirect) for an anonymous caller", async () => {
		const event = {
			request: new Request("http://localhost/api/connections"),
			locals: { user: null },
			params: {},
			url: new URL("http://localhost/api/connections"),
			route: { id: "/api/connections" },
		} as Parameters<typeof GET>[0];
		await expect(GET(event)).rejects.toMatchObject({ status: 401 });
		expect(mockListConnectionsForUser).not.toHaveBeenCalled();
	});

	it("returns only the authenticated caller's connections", async () => {
		mockListConnectionsForUser.mockResolvedValue([secretlessConnection]);

		const response = await GET(makeEvent("owner-user"));
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.connections).toEqual([secretlessConnection]);
		expect(mockListConnectionsForUser).toHaveBeenCalledWith("owner-user");
	});

	it("never includes a secret field in the response body", async () => {
		mockListConnectionsForUser.mockResolvedValue([secretlessConnection]);

		const response = await GET(makeEvent());
		const text = await response.text();

		expect(text).not.toContain("secretCiphertext");
		expect(text).not.toContain("writeSecretCiphertext");
		expect(text).not.toMatch(/"secret":/);
	});
});
