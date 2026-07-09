import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/connections/store", () => ({
	getConnection: vi.fn(),
	setAllowWrites: vi.fn(),
	setDefaultOn: vi.fn(),
	setEnabledCapabilities: vi.fn(),
	setWriteAllowlist: vi.fn(),
	deleteConnection: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import {
	deleteConnection,
	getConnection,
	setAllowWrites,
	setDefaultOn,
	setEnabledCapabilities,
	setWriteAllowlist,
} from "$lib/server/services/connections/store";
import { DELETE, PATCH } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockGetConnection = getConnection as ReturnType<typeof vi.fn>;
const mockSetAllowWrites = setAllowWrites as ReturnType<typeof vi.fn>;
const mockSetDefaultOn = setDefaultOn as ReturnType<typeof vi.fn>;
const mockSetEnabledCapabilities = setEnabledCapabilities as ReturnType<
	typeof vi.fn
>;
const mockSetWriteAllowlist = setWriteAllowlist as ReturnType<typeof vi.fn>;
const mockDeleteConnection = deleteConnection as ReturnType<typeof vi.fn>;

const googleConnection = {
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

const nextcloudConnection = {
	...googleConnection,
	id: "conn-2",
	provider: "nextcloud" as const,
	label: "Nextcloud",
	capabilities: ["files"],
	oauthScopes: [],
};

function makeEvent(body: unknown, id = "conn-1", userId = "owner-user") {
	const method = body === undefined ? "DELETE" : "PATCH";
	return {
		request: new Request(`http://localhost/api/connections/${id}`, {
			method,
			headers: { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		locals: { user: { id: userId, role: "user" } },
		params: { id },
		url: new URL(`http://localhost/api/connections/${id}`),
		route: { id: "/api/connections/[id]" },
	} as Parameters<typeof PATCH>[0] & Parameters<typeof DELETE>[0];
}

describe("/api/connections/[id]", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockGetConnection.mockResolvedValue(googleConnection);
		mockSetAllowWrites.mockResolvedValue(googleConnection);
		mockSetDefaultOn.mockResolvedValue(googleConnection);
		mockSetEnabledCapabilities.mockResolvedValue(googleConnection);
		mockSetWriteAllowlist.mockResolvedValue(googleConnection);
		mockDeleteConnection.mockResolvedValue(true);
	});

	describe("PATCH", () => {
		it("returns 404 for another user's connection id (no cross-user mutation)", async () => {
			mockGetConnection.mockResolvedValue(null);

			const response = await PATCH(makeEvent({ allowWrites: true }));
			const data = await response.json();

			expect(response.status).toBe(404);
			expect(data.error).toBeTruthy();
			expect(mockSetAllowWrites).not.toHaveBeenCalled();
		});

		it("rejects a non-boolean allowWrites with 400", async () => {
			const response = await PATCH(
				makeEvent({ allowWrites: "yes" as unknown as boolean }),
			);
			expect(response.status).toBe(400);
			expect(mockSetAllowWrites).not.toHaveBeenCalled();
		});

		it("rejects a non-boolean defaultOn with 400", async () => {
			const response = await PATCH(
				makeEvent({ defaultOn: "yes" as unknown as boolean }),
			);
			expect(response.status).toBe(400);
			expect(mockSetDefaultOn).not.toHaveBeenCalled();
		});

		it("rejects an unknown capability with 400", async () => {
			const response = await PATCH(
				makeEvent({ capabilities: ["calendar", "photos"] }),
			);
			const data = await response.json();

			expect(response.status).toBe(400);
			expect(data.error).toBeTruthy();
			expect(mockSetEnabledCapabilities).not.toHaveBeenCalled();
		});

		it("updates only the supplied fields", async () => {
			const response = await PATCH(makeEvent({ allowWrites: true }));

			expect(response.status).toBe(200);
			expect(mockSetAllowWrites).toHaveBeenCalledWith(
				"owner-user",
				"conn-1",
				true,
			);
			expect(mockSetDefaultOn).not.toHaveBeenCalled();
			expect(mockSetEnabledCapabilities).not.toHaveBeenCalled();
		});

		it("applies allowed capabilities and returns the updated connection", async () => {
			const updated = { ...googleConnection, capabilities: ["calendar"] };
			mockSetEnabledCapabilities.mockResolvedValue(updated);
			mockGetConnection
				.mockResolvedValueOnce(googleConnection)
				.mockResolvedValueOnce(updated);

			const response = await PATCH(makeEvent({ capabilities: ["calendar"] }));
			const data = await response.json();

			expect(response.status).toBe(200);
			expect(mockSetEnabledCapabilities).toHaveBeenCalledWith(
				"owner-user",
				"conn-1",
				["calendar"],
			);
			expect(data).toEqual(updated);
		});

		it("never includes a secret field in the response body", async () => {
			const response = await PATCH(makeEvent({ allowWrites: true }));
			const text = await response.text();

			expect(text).not.toContain("secretCiphertext");
			expect(text).not.toContain("writeSecretCiphertext");
		});

		describe("writeAllowlist (Issue 7.1)", () => {
			beforeEach(() => {
				mockGetConnection.mockResolvedValue(nextcloudConnection);
			});

			it("normalizes and persists a valid list", async () => {
				const response = await PATCH(
					makeEvent(
						{ writeAllowlist: ["/AlfyAI", "Documents//Notes/"] },
						"conn-2",
					),
				);

				expect(response.status).toBe(200);
				expect(mockSetWriteAllowlist).toHaveBeenCalledWith(
					"owner-user",
					"conn-2",
					["/AlfyAI", "/Documents/Notes"],
				);
			});

			it("rejects a non-array writeAllowlist with 400", async () => {
				const response = await PATCH(
					makeEvent(
						{ writeAllowlist: "/AlfyAI" as unknown as string[] },
						"conn-2",
					),
				);

				expect(response.status).toBe(400);
				expect(mockSetWriteAllowlist).not.toHaveBeenCalled();
			});

			it("rejects an entry that escapes the allowed root (path traversal) with 400", async () => {
				const response = await PATCH(
					makeEvent({ writeAllowlist: ["/AlfyAI/../../etc"] }, "conn-2"),
				);
				const data = await response.json();

				expect(response.status).toBe(400);
				expect(data.error).toBeTruthy();
				expect(mockSetWriteAllowlist).not.toHaveBeenCalled();
			});

			it("rejects an empty-string entry with 400", async () => {
				const response = await PATCH(
					makeEvent({ writeAllowlist: ["/AlfyAI", "   "] }, "conn-2"),
				);

				expect(response.status).toBe(400);
				expect(mockSetWriteAllowlist).not.toHaveBeenCalled();
			});

			it("rejects more than 20 entries with 400", async () => {
				const tooMany = Array.from({ length: 21 }, (_, i) => `/folder-${i}`);
				const response = await PATCH(
					makeEvent({ writeAllowlist: tooMany }, "conn-2"),
				);

				expect(response.status).toBe(400);
				expect(mockSetWriteAllowlist).not.toHaveBeenCalled();
			});

			it("returns 404 for another user's connection id (no cross-user mutation)", async () => {
				mockGetConnection.mockResolvedValue(null);

				const response = await PATCH(
					makeEvent({ writeAllowlist: ["/AlfyAI"] }, "conn-2"),
				);

				expect(response.status).toBe(404);
				expect(mockSetWriteAllowlist).not.toHaveBeenCalled();
			});
		});
	});

	describe("DELETE", () => {
		it("removes the caller's connection", async () => {
			const response = await DELETE(makeEvent(undefined));
			const data = await response.json();

			expect(response.status).toBe(200);
			expect(data.ok).toBe(true);
			expect(mockDeleteConnection).toHaveBeenCalledWith("owner-user", "conn-1");
		});

		it("returns 404 for another user's connection id", async () => {
			mockDeleteConnection.mockResolvedValue(false);

			const response = await DELETE(makeEvent(undefined));
			const data = await response.json();

			expect(response.status).toBe(404);
			expect(data.error).toBeTruthy();
		});
	});
});
