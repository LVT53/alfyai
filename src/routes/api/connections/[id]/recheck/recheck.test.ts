import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/connections/store", () => ({
	getConnection: vi.fn(),
}));

vi.mock("$lib/server/services/connections/health", () => ({
	checkConnectionHealth: vi.fn(),
}));

import { checkConnectionHealth } from "$lib/server/services/connections/health";
import { _resetConnectionRecheckRateLimitForTests } from "$lib/server/services/connections/recheck-rate-limit";
import { getConnection } from "$lib/server/services/connections/store";
import { POST } from "./+server";

const mockGetConnection = getConnection as ReturnType<typeof vi.fn>;
const mockCheckHealth = checkConnectionHealth as ReturnType<typeof vi.fn>;

const storedConnection = {
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
	statusChangedAt: null,
	lastUsedAt: null,
	createdAt: 1,
	updatedAt: 1,
};

function makeEvent(id = "conn-1", userId = "owner-user") {
	return {
		request: new Request(`http://localhost/api/connections/${id}/recheck`, {
			method: "POST",
		}),
		locals: { user: { id: userId, role: "user" } },
		params: { id },
		url: new URL(`http://localhost/api/connections/${id}/recheck`),
		route: { id: "/api/connections/[id]/recheck" },
	} as Parameters<typeof POST>[0];
}

describe("POST /api/connections/[id]/recheck", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		_resetConnectionRecheckRateLimitForTests();
		mockGetConnection.mockResolvedValue(storedConnection);
		mockCheckHealth.mockResolvedValue({ status: "connected", detail: null });
	});

	it("404s on another user's connection id without ever calling an adapter", async () => {
		mockGetConnection.mockResolvedValue(null);

		const response = await POST(makeEvent("conn-1", "other-user"));
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data.error).toBeTruthy();
		// The whole point of checking ownership BEFORE the health call: a
		// stranger's id must never cause us to talk to that stranger's
		// provider.
		expect(mockCheckHealth).not.toHaveBeenCalled();
	});

	it("checks health for the calling user and returns the refreshed connection", async () => {
		const refreshed = {
			...storedConnection,
			status: "needs_reauth" as const,
			statusDetail: "Token was refused",
			statusChangedAt: 1234,
		};
		// First read is the ownership check, second is the re-read after the
		// health call has written the new status through the store.
		mockGetConnection
			.mockResolvedValueOnce(storedConnection)
			.mockResolvedValueOnce(refreshed);
		mockCheckHealth.mockResolvedValue({
			status: "needs_reauth",
			detail: "Token was refused",
		});

		const response = await POST(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(mockCheckHealth).toHaveBeenCalledWith("owner-user", "conn-1");
		expect(data.connection.status).toBe("needs_reauth");
		expect(data.connection.statusDetail).toBe("Token was refused");
	});

	it("falls back to the connection it already had if the re-read comes back empty", async () => {
		mockGetConnection
			.mockResolvedValueOnce(storedConnection)
			.mockResolvedValueOnce(null);

		const response = await POST(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.connection.id).toBe("conn-1");
	});

	it("still answers 200 when the provider check reports an error", async () => {
		// checkConnectionHealth never throws — a broken adapter becomes an
		// "error" status that has already been persisted. The route must not
		// turn that into a failed request; the tab needs the new status.
		mockCheckHealth.mockResolvedValue({
			status: "error",
			detail: "connect ECONNREFUSED",
		});
		mockGetConnection
			.mockResolvedValueOnce(storedConnection)
			.mockResolvedValueOnce({
				...storedConnection,
				status: "error",
				statusDetail: "connect ECONNREFUSED",
			});

		const response = await POST(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.connection.status).toBe("error");
	});

	// A client decides when this route runs, and running it makes THIS server
	// call a third-party provider. Without a cap, a stuck tab (or a script)
	// could hammer the provider from our IP under the user's own credentials.
	it("caps how often one user can make the server call a provider", async () => {
		let last: Response | undefined;
		for (let i = 0; i < 20; i += 1) {
			last = await POST(makeEvent());
		}

		expect(last?.status).toBe(429);
		// The cap is what stops the outbound calls, so it must bite before the
		// adapter is reached — not merely change the response.
		expect(mockCheckHealth.mock.calls.length).toBeLessThan(20);
	});

	it("keeps one user's cap out of another user's way", async () => {
		for (let i = 0; i < 20; i += 1) {
			await POST(makeEvent("conn-1", "owner-user"));
		}

		const other = await POST(makeEvent("conn-2", "second-user"));
		expect(other.status).toBe(200);
	});
});
