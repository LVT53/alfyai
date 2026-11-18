import { beforeEach, describe, expect, it, vi } from "vitest";

// Route-level test for GET /api/connections/nextcloud/preview — the only
// route that hands Nextcloud preview bytes to the browser. Ownership is
// resolved before the vault secret is read, so another user's connection id
// 404s without any fetch or decryption; the adapter (nextcloudPreview) is
// mocked so the route contract is tested without a Nextcloud server.
vi.mock("$lib/server/services/connections/store", () => ({
	getConnection: vi.fn(),
	getConnectionSecret: vi.fn(),
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
		nextcloudPreview: vi.fn(),
	};
});

import {
	NextcloudFilesError,
	nextcloudPreview,
} from "$lib/server/services/connections/providers/nextcloud-files";
import {
	getConnection,
	getConnectionSecret,
} from "$lib/server/services/connections/store";
import { GET } from "./+server";

const mockGetConnection = vi.mocked(getConnection);
const mockGetConnectionSecret = vi.mocked(getConnectionSecret);
const mockPreview = vi.mocked(nextcloudPreview);

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
	config: { serverUrl: "https://cloud.example.com", loginName: "alice" },
	oauthScopes: [],
	tokenExpiresAt: null,
	hasSecret: true,
	hasWriteSecret: false,
	createdAt: 1,
	updatedAt: 1,
};

function jpegPreview() {
	return {
		bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).buffer,
		contentType: "image/jpeg",
	};
}

function makeEvent(
	query: {
		connectionId?: string | null;
		fileId?: string | null;
		path?: string | null;
		size?: string | null;
		userId?: string | null;
	} = {},
): Parameters<typeof GET>[0] {
	const url = new URL("http://localhost/api/connections/nextcloud/preview");
	const set = (key: string, value: string | null | undefined) => {
		if (value !== null && value !== undefined) url.searchParams.set(key, value);
	};
	set(
		"connectionId",
		query.connectionId === undefined ? "conn-nc" : query.connectionId,
	);
	set("fileId", query.fileId);
	set("path", query.path);
	set("size", query.size === undefined ? "192" : query.size);
	const userId = query.userId === undefined ? "owner-user" : query.userId;
	return {
		request: new Request(url),
		locals: { user: userId ? { id: userId, role: "user" } : null },
		params: {},
		url,
		route: { id: "/api/connections/nextcloud/preview" },
	} as Parameters<typeof GET>[0];
}

describe("GET /api/connections/nextcloud/preview", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetConnection.mockResolvedValue(nextcloudConnection);
		mockGetConnectionSecret.mockResolvedValue("app-secret");
		mockPreview.mockResolvedValue(jpegPreview());
	});

	it("serves an owned connection's preview with private caching", async () => {
		const response = await GET(makeEvent({ fileId: "42", size: "192" }));

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/jpeg");
		expect(response.headers.get("cache-control")).toBe("private, max-age=300");
		expect(response.headers.get("content-length")).toBe(
			String(jpegPreview().bytes.byteLength),
		);
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(
			new Uint8Array(jpegPreview().bytes),
		);
		expect(mockGetConnection).toHaveBeenCalledWith("owner-user", "conn-nc");
		expect(mockGetConnectionSecret).toHaveBeenCalledWith(
			"owner-user",
			"conn-nc",
		);
		expect(mockPreview).toHaveBeenCalledWith(
			nextcloudConnection,
			"app-secret",
			{ fileId: 42, size: 192 },
		);
	});

	it("serves the viewer size (1600) with the same private headers", async () => {
		const response = await GET(makeEvent({ fileId: "42", size: "1600" }));

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/jpeg");
		expect(response.headers.get("cache-control")).toBe("private, max-age=300");
		expect(response.headers.get("content-length")).toBe(
			String(jpegPreview().bytes.byteLength),
		);
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(
			new Uint8Array(jpegPreview().bytes),
		);
		expect(mockPreview).toHaveBeenCalledWith(
			nextcloudConnection,
			"app-secret",
			{ fileId: 42, size: 1600 },
		);
	});

	it("serves the path form when the result has no file id, untouched", async () => {
		const path = "/Photos/lake 1.jpg";
		const response = await GET(makeEvent({ path, size: "96" }));

		expect(response.status).toBe(200);
		expect(mockPreview).toHaveBeenCalledWith(
			nextcloudConnection,
			"app-secret",
			{ path, size: 96 },
		);
	});

	it("prefers the file id when both fileId and path are given", async () => {
		const response = await GET(
			makeEvent({ fileId: "42", path: "/Photos/lake.jpg" }),
		);

		expect(response.status).toBe(200);
		expect(mockPreview).toHaveBeenCalledWith(
			nextcloudConnection,
			"app-secret",
			{ fileId: 42, size: 192 },
		);
	});

	it("returns 401 (not a 302 redirect) for anonymous callers instead of leaking bytes", async () => {
		await expect(GET(makeEvent({ userId: null }))).rejects.toMatchObject({
			status: 401,
		});
		expect(mockGetConnection).not.toHaveBeenCalled();
		expect(mockGetConnectionSecret).not.toHaveBeenCalled();
		expect(mockPreview).not.toHaveBeenCalled();
	});

	it("404s another user's connection without fetching", async () => {
		mockGetConnection.mockResolvedValue(null);

		const response = await GET(makeEvent({ fileId: "42" }));

		expect(response.status).toBe(404);
		expect(mockGetConnection).toHaveBeenCalledWith("owner-user", "conn-nc");
		expect(mockGetConnectionSecret).not.toHaveBeenCalled();
		expect(mockPreview).not.toHaveBeenCalled();
	});

	it("404s a connection of another provider without fetching", async () => {
		mockGetConnection.mockResolvedValue({
			...nextcloudConnection,
			provider: "google",
			capabilities: ["calendar"],
		});

		const response = await GET(makeEvent({ fileId: "42" }));

		expect(response.status).toBe(404);
		expect(mockPreview).not.toHaveBeenCalled();
	});

	it.each(["4000", "800", "96.0", "096", "48", ""])(
		"400s a size it did not ask for (%s) without fetching",
		async (size) => {
			const response = await GET(makeEvent({ fileId: "42", size }));

			expect(response.status).toBe(400);
			expect(mockPreview).not.toHaveBeenCalled();
		},
	);

	it("400s when size is missing", async () => {
		const response = await GET(makeEvent({ fileId: "42", size: null }));

		expect(response.status).toBe(400);
		expect(mockPreview).not.toHaveBeenCalled();
	});

	it.each(["0", "-1", "abc", "1.5", "", "9007199254740993"])(
		"400s a fileId that is not a positive integer (%s)",
		async (fileId) => {
			const response = await GET(makeEvent({ fileId }));

			expect(response.status).toBe(400);
			expect(mockPreview).not.toHaveBeenCalled();
		},
	);

	it("400s when neither fileId nor path is given", async () => {
		const response = await GET(makeEvent());

		expect(response.status).toBe(400);
		expect(mockPreview).not.toHaveBeenCalled();
	});

	it("400s when connectionId is missing", async () => {
		const response = await GET(makeEvent({ connectionId: null, fileId: "42" }));

		expect(response.status).toBe(400);
		expect(mockGetConnection).not.toHaveBeenCalled();
	});

	it("404s when Nextcloud has no preview", async () => {
		mockPreview.mockResolvedValue(null);

		const response = await GET(makeEvent({ fileId: "42" }));

		expect(response.status).toBe(404);
		expect(mockPreview).toHaveBeenCalled();
	});

	it("401s when the stored credential was rejected", async () => {
		mockPreview.mockRejectedValue(
			new NextcloudFilesError(
				"Nextcloud connection needs re-authorization",
				"needs_reauth",
			),
		);

		const response = await GET(makeEvent({ fileId: "42" }));

		expect(response.status).toBe(401);
	});

	it("401s when the connection has no stored secret", async () => {
		mockGetConnectionSecret.mockResolvedValue(null);

		const response = await GET(makeEvent({ fileId: "42" }));

		expect(response.status).toBe(401);
		expect(mockPreview).not.toHaveBeenCalled();
	});

	it("400s a path the adapter refuses", async () => {
		mockPreview.mockRejectedValue(
			new NextcloudFilesError(
				"Path escapes the Nextcloud files root",
				"invalid_path",
			),
		);

		const response = await GET(makeEvent({ path: "/../secret", size: "96" }));

		expect(response.status).toBe(400);
		expect(mockPreview).toHaveBeenCalledWith(
			nextcloudConnection,
			"app-secret",
			{ path: "/../secret", size: 96 },
		);
	});

	it("502s an upstream failure", async () => {
		mockPreview.mockRejectedValue(
			new NextcloudFilesError("Nextcloud preview failed", "request_failed"),
		);

		const response = await GET(makeEvent({ fileId: "42" }));

		expect(response.status).toBe(502);
	});

	it("502s an unknown failure with a fixed message, never err.message", async () => {
		mockPreview.mockRejectedValue(new Error("boom: password=app-secret"));

		const response = await GET(makeEvent({ fileId: "42" }));
		const data = await response.json();

		expect(response.status).toBe(502);
		expect(data.error).toBe("Failed to load the Nextcloud preview");
		expect(JSON.stringify(data)).not.toMatch(/boom|password|app-secret/i);
	});
});
