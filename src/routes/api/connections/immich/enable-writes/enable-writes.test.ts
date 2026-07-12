import { beforeEach, describe, expect, it, vi } from "vitest";

// Route-level test for POST /api/connections/immich/enable-writes — Issue
// 6.4's write-key provisioning route. The status-gating posture mirrors the
// credential connect routes (handleCredentialConnect): a thrown ImmichError's
// `.code` maps to a status via mapConnectError, but an UNEXPECTED, non-provider
// error must fall back to 502 rather than having mapConnectError read a stray
// `.code` off it.

vi.mock("$lib/server/services/connections/resolve", () => ({
	resolveConnectionsForCapability: vi.fn(),
}));

vi.mock("$lib/server/services/connections/providers/immich", () => {
	class ImmichError extends Error {
		code: string;
		constructor(message: string, code: string) {
			super(message);
			this.name = "ImmichError";
			this.code = code;
		}
	}
	return {
		ImmichError,
		immichEnableWrites: vi.fn(),
	};
});

import {
	ImmichError,
	immichEnableWrites,
} from "$lib/server/services/connections/providers/immich";
import { resolveConnectionsForCapability } from "$lib/server/services/connections/resolve";
import { POST } from "./+server";

const mockResolveConnectionsForCapability = vi.mocked(
	resolveConnectionsForCapability,
);
const mockImmichEnableWrites = vi.mocked(immichEnableWrites);

const ownerImmichConnection = {
	id: "conn-immich",
	userId: "owner-user",
	provider: "immich" as const,
	label: "Immich",
	accountIdentifier: "alice@example.com",
	status: "connected" as const,
	statusDetail: null,
	defaultOn: false,
	allowWrites: false,
	writeAllowlist: [],
	capabilities: ["photos"],
	config: {},
	oauthScopes: [],
	tokenExpiresAt: null,
	hasSecret: true,
	hasWriteSecret: false,
	createdAt: 1,
	updatedAt: 1,
};

function makeEvent(opts?: {
	body?: unknown;
	userId?: string | null;
}): Parameters<typeof POST>[0] {
	const body = opts?.body === undefined ? { password: "s3cret" } : opts.body;
	const url = new URL("http://localhost/api/connections/immich/enable-writes");
	const userId = opts?.userId === undefined ? "owner-user" : opts.userId;
	return {
		request: new Request(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: body === null ? "not json" : JSON.stringify(body),
		}),
		locals: { user: userId ? { id: userId, role: "user" } : null },
		url,
		route: { id: "/api/connections/immich/enable-writes" },
		// biome-ignore lint/suspicious/noExplicitAny: minimal RequestEvent stub
	} as any;
}

describe("POST /api/connections/immich/enable-writes", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockResolveConnectionsForCapability.mockResolvedValue([
			ownerImmichConnection,
		]);
		mockImmichEnableWrites.mockResolvedValue({
			connection: { ...ownerImmichConnection, hasWriteSecret: true },
		});
	});

	it("provisions the write key and returns the result on success", async () => {
		const response = await POST(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.connection.hasWriteSecret).toBe(true);
		expect(mockImmichEnableWrites).toHaveBeenCalledWith({
			userId: "owner-user",
			connectionId: "conn-immich",
			password: "s3cret",
		});
	});

	it("returns 401 for anonymous callers", async () => {
		await expect(POST(makeEvent({ userId: null }))).rejects.toMatchObject({
			status: 401,
		});
		expect(mockImmichEnableWrites).not.toHaveBeenCalled();
	});

	it("returns 400 when password is missing", async () => {
		const response = await POST(makeEvent({ body: {} }));
		expect(response.status).toBe(400);
		expect(mockImmichEnableWrites).not.toHaveBeenCalled();
	});

	it("returns 404 when the user has no immich connection", async () => {
		mockResolveConnectionsForCapability.mockResolvedValue([]);
		const response = await POST(makeEvent());
		expect(response.status).toBe(404);
		expect(mockImmichEnableWrites).not.toHaveBeenCalled();
	});

	it("maps an ImmichError connection_not_found to 404 with its message", async () => {
		mockImmichEnableWrites.mockRejectedValue(
			new ImmichError("Connection went away", "connection_not_found"),
		);
		const response = await POST(makeEvent());
		const data = await response.json();
		expect(response.status).toBe(404);
		expect(data.error).toBe("Connection went away");
	});

	it("maps an ImmichError invalid_credentials to 401 with its message", async () => {
		mockImmichEnableWrites.mockRejectedValue(
			new ImmichError("Invalid Immich credentials", "invalid_credentials"),
		);
		const response = await POST(makeEvent());
		const data = await response.json();
		expect(response.status).toBe(401);
		expect(data.error).toBe("Invalid Immich credentials");
	});

	it("maps an ImmichError with an unladdered code (needs_reauth) to 502", async () => {
		mockImmichEnableWrites.mockRejectedValue(
			new ImmichError("Please reconnect", "needs_reauth"),
		);
		const response = await POST(makeEvent());
		expect(response.status).toBe(502);
	});

	it("falls back to 502 + generic message for an UNEXPECTED non-provider error, even if it carries a stray .code", async () => {
		// The regression this fix guards: mapConnectError must NOT read a
		// `.code` off a raw, non-ImmichError. A rogue error whose `.code`
		// happens to be "connection_not_found" must still be a 502, not a 404.
		const rogue = Object.assign(new Error("boom"), {
			code: "connection_not_found",
		});
		mockImmichEnableWrites.mockRejectedValue(rogue);

		const response = await POST(makeEvent());
		const data = await response.json();
		expect(response.status).toBe(502);
		expect(data.error).toBe("Failed to enable Immich writes");
	});
});
