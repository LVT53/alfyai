import { beforeEach, describe, expect, it, vi } from "vitest";

// Route-level test for GET /api/connections/immich/thumbnail/[assetId] —
// Task 11a's authed, per-user Immich thumbnail proxy. The whole point of
// this route is that an assetId alone is meaningless without the caller's
// OWN connection: immichThumbnail resolves the vault key via
// getConnectionSecret(userId, connectionId), and getConnection/
// resolveConnectionsForCapability are both scoped by userId. Mirrors the
// getConnection-first-then-404 convention from nextcloud-folders.test.ts /
// owntracks-home.test.ts, plus the "propagates auth redirects" convention
// from conversations/[id]/conversation-detail.test.ts.

vi.mock("$lib/server/services/connections/store", () => ({
	getConnection: vi.fn(),
}));

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
		immichThumbnail: vi.fn(),
	};
});

import {
	ImmichError,
	immichThumbnail,
} from "$lib/server/services/connections/providers/immich";
import { resolveConnectionsForCapability } from "$lib/server/services/connections/resolve";
import { getConnection } from "$lib/server/services/connections/store";
import { GET } from "./+server";

const mockGetConnection = vi.mocked(getConnection);
const mockResolveConnectionsForCapability = vi.mocked(
	resolveConnectionsForCapability,
);
const mockImmichThumbnail = vi.mocked(immichThumbnail);

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
	assetId?: string;
	userId?: string | null;
	connectionId?: string;
}): Parameters<typeof GET>[0] {
	const assetId = opts?.assetId ?? "asset-1";
	const url = new URL(
		`http://localhost/api/connections/immich/thumbnail/${assetId}`,
	);
	if (opts?.connectionId)
		url.searchParams.set("connectionId", opts.connectionId);
	const userId = opts?.userId === undefined ? "owner-user" : opts.userId;
	return {
		request: new Request(url),
		locals: { user: userId ? { id: userId, role: "user" } : null },
		params: { assetId },
		url,
		route: { id: "/api/connections/immich/thumbnail/[assetId]" },
		// biome-ignore lint/suspicious/noExplicitAny: minimal RequestEvent stub
	} as any;
}

describe("GET /api/connections/immich/thumbnail/[assetId]", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockResolveConnectionsForCapability.mockResolvedValue([
			ownerImmichConnection,
		]);
		mockGetConnection.mockResolvedValue(ownerImmichConnection);
		mockImmichThumbnail.mockResolvedValue({
			bytes: new TextEncoder().encode("fake-jpeg-bytes").buffer,
			contentType: "image/jpeg",
		});
	});

	it("streams the thumbnail bytes with the correct content-type for a connected immich account", async () => {
		const response = await GET(makeEvent());

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/jpeg");
		expect(response.headers.get("cache-control")).toBe("private, max-age=300");
		expect(response.headers.get("content-length")).toBe(
			String(new TextEncoder().encode("fake-jpeg-bytes").byteLength),
		);
		// Task 11b hardening: stop a browser from MIME-sniffing the Immich-
		// reported content-type into something else.
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		const body = new Uint8Array(await response.arrayBuffer());
		expect(new TextDecoder().decode(body)).toBe("fake-jpeg-bytes");
		expect(mockImmichThumbnail).toHaveBeenCalledWith(
			"owner-user",
			"conn-immich",
			{ assetId: "asset-1" },
		);
	});

	it("returns 401 (not a 302 redirect) for anonymous callers instead of leaking bytes", async () => {
		await expect(GET(makeEvent({ userId: null }))).rejects.toMatchObject({
			status: 401,
		});
		expect(mockImmichThumbnail).not.toHaveBeenCalled();
	});

	it("returns 404 when the user has no immich connection", async () => {
		mockResolveConnectionsForCapability.mockResolvedValue([]);

		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data.error).toBeTruthy();
		expect(mockImmichThumbnail).not.toHaveBeenCalled();
	});

	it("resolves a specific ?connectionId= belonging to the caller and uses it", async () => {
		mockGetConnection.mockResolvedValue({
			...ownerImmichConnection,
			id: "conn-other-immich",
		});

		const response = await GET(
			makeEvent({ connectionId: "conn-other-immich" }),
		);

		expect(response.status).toBe(200);
		expect(mockGetConnection).toHaveBeenCalledWith(
			"owner-user",
			"conn-other-immich",
		);
		expect(mockImmichThumbnail).toHaveBeenCalledWith(
			"owner-user",
			"conn-other-immich",
			{ assetId: "asset-1" },
		);
		// The unscoped resolver must not be consulted when the caller pinned
		// a specific connectionId.
		expect(mockResolveConnectionsForCapability).not.toHaveBeenCalled();
	});

	it("returns 404 (and never calls immichThumbnail) for a ?connectionId= owned by another user — isolation", async () => {
		// getConnection is user-scoped (WHERE userId = ? AND id = ?), so
		// another user's connection id resolves to null exactly like a
		// missing connection — this is the cross-user isolation guarantee.
		mockGetConnection.mockResolvedValue(null);

		const response = await GET(
			makeEvent({ connectionId: "someone-elses-conn" }),
		);
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data.error).toBeTruthy();
		expect(mockImmichThumbnail).not.toHaveBeenCalled();
	});

	it("returns 404 for a ?connectionId= that belongs to the caller but isn't an immich connection", async () => {
		mockGetConnection.mockResolvedValue({
			...ownerImmichConnection,
			provider: "nextcloud",
			capabilities: ["files"],
		});

		const response = await GET(makeEvent({ connectionId: "conn-nc" }));

		expect(response.status).toBe(404);
		expect(mockImmichThumbnail).not.toHaveBeenCalled();
	});

	it("rejects an assetId containing path-traversal-flavored characters before calling immichThumbnail", async () => {
		const response = await GET(makeEvent({ assetId: "..%2Fsecrets" }));

		expect(response.status).toBe(400);
		expect(mockImmichThumbnail).not.toHaveBeenCalled();
	});

	it("maps a needs_reauth ImmichError to 401 without leaking the api key", async () => {
		mockImmichThumbnail.mockRejectedValue(
			new ImmichError("Immich rejected the stored API key", "needs_reauth"),
		);

		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(401);
		expect(JSON.stringify(data)).not.toMatch(/api[-_]?key|x-api-key/i);
	});

	it("maps an upstream request_failed ImmichError to 502 without leaking raw upstream body", async () => {
		mockImmichThumbnail.mockRejectedValue(
			new ImmichError("Failed to fetch the photo thumbnail", "request_failed"),
		);

		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(502);
		expect(JSON.stringify(data)).not.toMatch(/api[-_]?key|x-api-key|secret/i);
	});

	it("maps an unknown thrown error to 502 with a clean generic message", async () => {
		mockImmichThumbnail.mockRejectedValue(
			new Error("connect ECONNREFUSED 10.0.0.5:2283 x-api-key=super-secret"),
		);

		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(502);
		expect(JSON.stringify(data)).not.toMatch(
			/x-api-key|super-secret|10\.0\.0\.5/,
		);
	});
});
