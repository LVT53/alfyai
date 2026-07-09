import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/connections/store", () => ({
	getConnection: vi.fn(),
}));

vi.mock("$lib/server/services/connections/providers/nextcloud-files", () => {
	class NextcloudFilesError extends Error {
		code: string;
		constructor(message: string, code: string) {
			super(message);
			this.name = "NextcloudFilesError";
			this.code = code;
		}
	}
	return {
		NextcloudFilesError,
		nextcloudListFolders: vi.fn(),
	};
});

import { requireAuth } from "$lib/server/auth/hooks";
import {
	NextcloudFilesError,
	nextcloudListFolders,
} from "$lib/server/services/connections/providers/nextcloud-files";
import { getConnection } from "$lib/server/services/connections/store";
import { GET } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockGetConnection = getConnection as ReturnType<typeof vi.fn>;
const mockListFolders = nextcloudListFolders as ReturnType<typeof vi.fn>;

const nextcloudConnection = {
	id: "conn-nc",
	userId: "owner-user",
	provider: "nextcloud" as const,
	label: "Nextcloud",
	accountIdentifier: "alice",
	status: "connected" as const,
	statusDetail: null,
	defaultOn: false,
	allowWrites: true,
	writeAllowlist: ["/AlfyAI"],
	capabilities: ["files"],
	config: {},
	oauthScopes: [],
	tokenExpiresAt: null,
	hasSecret: true,
	hasWriteSecret: false,
	createdAt: 1,
	updatedAt: 1,
};

function makeEvent(id = "conn-nc", userId = "owner-user", path?: string) {
	const url = new URL(
		`http://localhost/api/connections/${id}/nextcloud-folders`,
	);
	if (path !== undefined) url.searchParams.set("path", path);
	return {
		request: new Request(url),
		locals: { user: { id: userId, role: "user" } },
		params: { id },
		url,
		route: { id: "/api/connections/[id]/nextcloud-folders" },
	} as Parameters<typeof GET>[0];
}

describe("GET /api/connections/[id]/nextcloud-folders", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockGetConnection.mockResolvedValue(nextcloudConnection);
		mockListFolders.mockResolvedValue([
			{ path: "/Documents", name: "Documents" },
			{ path: "/Photos", name: "Photos" },
		]);
	});

	it("returns the folders from nextcloudListFolders as { folders }", async () => {
		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data).toEqual({
			folders: [
				{ path: "/Documents", name: "Documents" },
				{ path: "/Photos", name: "Photos" },
			],
		});
		expect(mockListFolders).toHaveBeenCalledWith("owner-user", "conn-nc", {
			path: undefined,
		});
	});

	it("forwards the ?path query param", async () => {
		await GET(makeEvent("conn-nc", "owner-user", "/Documents"));
		expect(mockListFolders).toHaveBeenCalledWith("owner-user", "conn-nc", {
			path: "/Documents",
		});
	});

	it("returns 404 for another user's connection id (no cross-user leak)", async () => {
		mockGetConnection.mockResolvedValue(null);

		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data.error).toBeTruthy();
		expect(mockListFolders).not.toHaveBeenCalled();
	});

	it("returns 400 for a non-nextcloud connection", async () => {
		mockGetConnection.mockResolvedValue({
			...nextcloudConnection,
			provider: "google",
			capabilities: ["calendar"],
		});

		const response = await GET(makeEvent());
		expect(response.status).toBe(400);
		expect(mockListFolders).not.toHaveBeenCalled();
	});

	it("returns 400 for a nextcloud connection without the files capability", async () => {
		mockGetConnection.mockResolvedValue({
			...nextcloudConnection,
			capabilities: [],
		});

		const response = await GET(makeEvent());
		expect(response.status).toBe(400);
		expect(mockListFolders).not.toHaveBeenCalled();
	});

	it("maps a needs_reauth typed error to 409, without leaking a secret", async () => {
		mockListFolders.mockRejectedValue(
			new NextcloudFilesError(
				"Nextcloud connection needs re-authorization",
				"needs_reauth",
			),
		);

		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(409);
		expect(JSON.stringify(data)).not.toMatch(/password|secret|token/i);
	});

	it("maps an unknown thrown error to 502", async () => {
		mockListFolders.mockRejectedValue(new Error("boom"));

		const response = await GET(makeEvent());
		expect(response.status).toBe(502);
	});

	it("never includes a secret field in the response body", async () => {
		const response = await GET(makeEvent());
		const text = await response.text();
		expect(text).not.toMatch(/secret|password/i);
	});
});
