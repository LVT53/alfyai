import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/connections/store", () => ({
	getConnection: vi.fn(),
}));

import { getConnection } from "$lib/server/services/connections/store";
import { requireOwnedConnection } from "./ownership";

const mockGetConnection = getConnection as ReturnType<typeof vi.fn>;

const connection = {
	id: "conn-1",
	provider: "owntracks",
	capabilities: ["location"],
	// biome-ignore lint/suspicious/noExplicitAny: partial ConnectionPublic fixture
} as any;

beforeEach(() => {
	vi.clearAllMocks();
});

describe("requireOwnedConnection", () => {
	it("returns the connection scoped by userId when it exists", async () => {
		mockGetConnection.mockResolvedValue(connection);
		const result = await requireOwnedConnection("user-1", "conn-1");
		expect(mockGetConnection).toHaveBeenCalledWith("user-1", "conn-1");
		expect(result).toEqual({ ok: true, connection });
	});

	it("returns a 404 { error } response for a missing / other-user connection", async () => {
		mockGetConnection.mockResolvedValue(null);
		const result = await requireOwnedConnection("user-1", "conn-x");
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.response.status).toBe(404);
		expect((await result.response.json()).error).toBe("Connection not found");
	});

	it("uses a custom not-found message when provided", async () => {
		mockGetConnection.mockResolvedValue(null);
		const result = await requireOwnedConnection("user-1", "conn-x", {
			notFoundMessage: "Immich connection not found",
		});
		if (result.ok) throw new Error("expected failure");
		expect((await result.response.json()).error).toBe(
			"Immich connection not found",
		);
	});

	it("returns a 400 mismatch response when the guard fails", async () => {
		mockGetConnection.mockResolvedValue(connection);
		const result = await requireOwnedConnection("user-1", "conn-1", {
			guard: (c) => c.provider === "immich",
			mismatchMessage: "Connection does not support this",
		});
		if (result.ok) throw new Error("expected failure");
		expect(result.response.status).toBe(400);
		expect((await result.response.json()).error).toBe(
			"Connection does not support this",
		);
	});

	it("allows the mismatch status to be overridden (e.g. 404)", async () => {
		mockGetConnection.mockResolvedValue(connection);
		const result = await requireOwnedConnection("user-1", "conn-1", {
			guard: (c) => c.provider === "immich",
			mismatchStatus: 404,
			mismatchMessage: "Immich connection not found",
		});
		if (result.ok) throw new Error("expected failure");
		expect(result.response.status).toBe(404);
	});

	it("passes the guard for a matching connection", async () => {
		mockGetConnection.mockResolvedValue(connection);
		const result = await requireOwnedConnection("user-1", "conn-1", {
			guard: (c) => c.provider === "owntracks",
		});
		expect(result.ok).toBe(true);
	});
});
