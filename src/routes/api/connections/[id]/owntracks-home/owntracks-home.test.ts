import { beforeEach, describe, expect, it, vi } from "vitest";

// Route-level test for PATCH /api/connections/[id]/owntracks-home — the
// missing piece Task 10 fills in: lets a user set/clear the home lat/lon
// that ownTracksHomeReference (providers/owntracks.ts) reads for the
// "distance to home" tool action. Mirrors nextcloud-folders.test.ts's
// scoping/provider-gate conventions: always resolve the connection via
// getConnection(userId, id) first (404 for another user's id or a missing
// connection), then 400 for a non-owntracks connection.

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/connections/store", () => ({
	getConnection: vi.fn(),
	updateConnection: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import {
	getConnection,
	updateConnection,
} from "$lib/server/services/connections/store";
import { PATCH } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockGetConnection = getConnection as ReturnType<typeof vi.fn>;
const mockUpdateConnection = updateConnection as ReturnType<typeof vi.fn>;

const ownTracksConnection = {
	id: "conn-ot",
	userId: "owner-user",
	provider: "owntracks" as const,
	label: "OwnTracks",
	accountIdentifier: "alice_ot/phone",
	status: "connected" as const,
	statusDetail: null,
	defaultOn: false,
	allowWrites: false,
	writeAllowlist: [],
	capabilities: ["location"],
	config: { otUser: "alice_ot", otDevice: "phone" },
	oauthScopes: [],
	tokenExpiresAt: null,
	hasSecret: false,
	hasWriteSecret: false,
	createdAt: 1,
	updatedAt: 1,
};

function makeEvent(
	body: unknown,
	id = "conn-ot",
	userId = "owner-user",
): Parameters<typeof PATCH>[0] {
	return {
		request: new Request(
			`http://localhost/api/connections/${id}/owntracks-home`,
			{ method: "PATCH", body: JSON.stringify(body) },
		),
		locals: { user: { id: userId, role: "user" } },
		params: { id },
		route: { id: "/api/connections/[id]/owntracks-home" },
		// biome-ignore lint/suspicious/noExplicitAny: minimal RequestEvent stub
	} as any;
}

describe("PATCH /api/connections/[id]/owntracks-home", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockGetConnection.mockResolvedValue(ownTracksConnection);
		mockUpdateConnection.mockResolvedValue({
			...ownTracksConnection,
			config: {
				otUser: "alice_ot",
				otDevice: "phone",
				homeLat: 47.5,
				homeLon: 19.05,
			},
		});
	});

	it("returns 404 for another user's connection id (no cross-user leak)", async () => {
		mockGetConnection.mockResolvedValue(null);

		const response = await PATCH(makeEvent({ homeLat: 47.5, homeLon: 19.05 }));
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data.error).toBeTruthy();
		expect(mockUpdateConnection).not.toHaveBeenCalled();
	});

	it("returns 400 for a non-owntracks connection", async () => {
		mockGetConnection.mockResolvedValue({
			...ownTracksConnection,
			provider: "google",
			capabilities: ["calendar"],
		});

		const response = await PATCH(makeEvent({ homeLat: 47.5, homeLon: 19.05 }));

		expect(response.status).toBe(400);
		expect(mockUpdateConnection).not.toHaveBeenCalled();
	});

	it("returns 400 on invalid JSON body", async () => {
		const event = {
			request: new Request(
				"http://localhost/api/connections/conn-ot/owntracks-home",
				{ method: "PATCH", body: "not json" },
			),
			locals: { user: { id: "owner-user", role: "user" } },
			params: { id: "conn-ot" },
			route: { id: "/api/connections/[id]/owntracks-home" },
			// biome-ignore lint/suspicious/noExplicitAny: minimal RequestEvent stub
		} as any;

		const response = await PATCH(event);
		expect(response.status).toBe(400);
	});

	it.each([
		[91, 19.05],
		[-91, 19.05],
		[47.5, 181],
		[47.5, -181],
	])("returns 400 for out-of-range lat/lon (%d, %d)", async (lat, lon) => {
		const response = await PATCH(makeEvent({ homeLat: lat, homeLon: lon }));
		expect(response.status).toBe(400);
		expect(mockUpdateConnection).not.toHaveBeenCalled();
	});

	it("returns 400 for non-numeric lat/lon", async () => {
		const response = await PATCH(
			makeEvent({ homeLat: "47.5", homeLon: 19.05 }),
		);
		expect(response.status).toBe(400);
		expect(mockUpdateConnection).not.toHaveBeenCalled();
	});

	it("returns 400 when only one of homeLat/homeLon is provided (mixed set/unset)", async () => {
		const response = await PATCH(makeEvent({ homeLat: 47.5, homeLon: null }));
		expect(response.status).toBe(400);
		expect(mockUpdateConnection).not.toHaveBeenCalled();
	});

	it("sets homeLat/homeLon, merging with the existing otUser/otDevice config (not clobbering it)", async () => {
		const response = await PATCH(makeEvent({ homeLat: 47.5, homeLon: 19.05 }));

		expect(response.status).toBe(200);
		expect(mockUpdateConnection).toHaveBeenCalledWith("owner-user", "conn-ot", {
			config: {
				otUser: "alice_ot",
				otDevice: "phone",
				homeLat: 47.5,
				homeLon: 19.05,
			},
		});
	});

	it("clears homeLat/homeLon when both are sent as null, preserving otUser/otDevice", async () => {
		mockGetConnection.mockResolvedValue({
			...ownTracksConnection,
			config: {
				otUser: "alice_ot",
				otDevice: "phone",
				homeLat: 47.5,
				homeLon: 19.05,
			},
		});

		const response = await PATCH(makeEvent({ homeLat: null, homeLon: null }));

		expect(response.status).toBe(200);
		expect(mockUpdateConnection).toHaveBeenCalledWith("owner-user", "conn-ot", {
			config: { otUser: "alice_ot", otDevice: "phone" },
		});
	});

	it("never includes ciphertext fields in the response body", async () => {
		const response = await PATCH(makeEvent({ homeLat: 47.5, homeLon: 19.05 }));
		const text = await response.text();
		expect(text).not.toContain("secretCiphertext");
		expect(text).not.toContain("writeSecretCiphertext");
	});
});
