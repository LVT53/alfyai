import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/connections/resolve", () => ({
	getDefaultOnCapabilities: vi.fn(),
	getEnabledConnectionCapabilities: vi.fn(),
	resolveConnectionsForCapability: vi.fn(),
}));

// Connections redesign — the route also lists every connection the caller
// has (not only the serving ones) so the composer's account list can say how
// many are ready and which one needs attention.
vi.mock("$lib/server/services/connections/store", () => ({
	listConnectionsForUser: vi.fn(),
}));

import {
	getDefaultOnCapabilities,
	getEnabledConnectionCapabilities,
	resolveConnectionsForCapability,
} from "$lib/server/services/connections/resolve";
import { listConnectionsForUser } from "$lib/server/services/connections/store";
import { GET } from "./+server";

const mockListConnectionsForUser = listConnectionsForUser as ReturnType<
	typeof vi.fn
>;

const mockGetEnabledConnectionCapabilities =
	getEnabledConnectionCapabilities as ReturnType<typeof vi.fn>;
const mockGetDefaultOnCapabilities = getDefaultOnCapabilities as ReturnType<
	typeof vi.fn
>;
const mockResolveConnectionsForCapability =
	resolveConnectionsForCapability as ReturnType<typeof vi.fn>;

function makeEvent(userId = "owner-user") {
	return {
		request: new Request(
			"http://localhost/api/connections/active-capabilities",
		),
		locals: { user: { id: userId, role: "user" } },
		params: {},
		url: new URL("http://localhost/api/connections/active-capabilities"),
		route: { id: "/api/connections/active-capabilities" },
	} as Parameters<typeof GET>[0];
}

describe("GET /api/connections/active-capabilities", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetEnabledConnectionCapabilities.mockResolvedValue(new Set());
		mockGetDefaultOnCapabilities.mockResolvedValue(new Set());
		mockResolveConnectionsForCapability.mockResolvedValue([]);
		mockListConnectionsForUser.mockResolvedValue([]);
	});

	it("returns 401 (not a 302 redirect) for an anonymous caller", async () => {
		const event = {
			request: new Request(
				"http://localhost/api/connections/active-capabilities",
			),
			locals: { user: null },
			params: {},
			url: new URL("http://localhost/api/connections/active-capabilities"),
			route: { id: "/api/connections/active-capabilities" },
		} as Parameters<typeof GET>[0];
		await expect(GET(event)).rejects.toMatchObject({ status: 401 });
		expect(mockGetEnabledConnectionCapabilities).not.toHaveBeenCalled();
	});

	it("scopes the lookups to the authenticated caller", async () => {
		await GET(makeEvent("owner-user"));

		expect(mockGetEnabledConnectionCapabilities).toHaveBeenCalledWith(
			"owner-user",
		);
		expect(mockGetDefaultOnCapabilities).toHaveBeenCalledWith("owner-user");
	});

	it("returns served/defaultOn in registry order and accounts per served capability", async () => {
		mockGetEnabledConnectionCapabilities.mockResolvedValue(
			new Set(["files", "calendar"]),
		);
		mockGetDefaultOnCapabilities.mockResolvedValue(new Set(["files"]));
		mockResolveConnectionsForCapability.mockImplementation(
			async (_userId: string, capability: string) => {
				if (capability === "calendar") {
					return [
						{
							id: "conn-work",
							label: "Work Google",
							provider: "google",
							accountIdentifier: "work@gmail.com",
							hasSecret: true,
						},
						{
							id: "conn-personal",
							label: "Personal Google",
							provider: "google",
							accountIdentifier: "personal@gmail.com",
							hasSecret: true,
						},
					];
				}
				return [
					{
						id: "conn-nextcloud",
						label: "Nextcloud",
						provider: "nextcloud",
						accountIdentifier: "",
						hasSecret: true,
					},
				];
			},
		);

		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		// registry order: calendar before files (see CAPABILITIES in registry.ts)
		expect(data.served).toEqual(["calendar", "files"]);
		expect(data.defaultOn).toEqual(["files"]);
		expect(data.accounts).toEqual([
			{
				capability: "calendar",
				connections: [
					{ id: "conn-work", label: "Work Google", provider: "google" },
					{ id: "conn-personal", label: "Personal Google", provider: "google" },
				],
			},
			{
				capability: "files",
				connections: [
					{ id: "conn-nextcloud", label: "Nextcloud", provider: "nextcloud" },
				],
			},
		]);
	});

	it("never includes a secret field in the response body", async () => {
		mockGetEnabledConnectionCapabilities.mockResolvedValue(new Set(["files"]));
		mockResolveConnectionsForCapability.mockResolvedValue([
			{
				id: "conn-nextcloud",
				label: "Nextcloud",
				provider: "nextcloud",
				hasSecret: true,
				secretCiphertext: "should-never-appear",
			},
		]);

		const response = await GET(makeEvent());
		const text = await response.text();

		expect(text).not.toContain("secretCiphertext");
		expect(text).not.toMatch(/"secret":/);
		expect(text).not.toContain("hasSecret");
	});

	it("returns empty arrays when the user has no served capabilities", async () => {
		const response = await GET(makeEvent());
		const data = await response.json();

		expect(data).toEqual({
			served: [],
			defaultOn: [],
			accounts: [],
			connections: [],
		});
	});

	// The composer's account list needs the ones that AREN'T serving too —
	// "4 of 6 accounts are ready" and "GitHub needs attention" are both about
	// those.
	describe("the per-account list", () => {
		function conn(overrides: Record<string, unknown> = {}) {
			return {
				id: "c1",
				label: "Nextcloud",
				provider: "nextcloud",
				accountIdentifier: "cloud.example.com",
				status: "connected",
				defaultOn: true,
				capabilities: ["files", "contacts"],
				...overrides,
			};
		}

		it("lists every connection, including the broken ones", async () => {
			mockGetEnabledConnectionCapabilities.mockResolvedValue(
				new Set(["files", "contacts"]),
			);
			mockListConnectionsForUser.mockResolvedValue([
				conn(),
				conn({
					id: "c2",
					label: "GitHub",
					provider: "github",
					status: "needs_reauth",
					capabilities: ["repos"],
				}),
			]);

			const data = await (await GET(makeEvent())).json();
			expect(data.connections).toHaveLength(2);
			// Ordered by label so the composer's list doesn't reshuffle itself
			// between fetches.
			expect(data.connections.map((c: { id: string }) => c.id)).toEqual([
				"c2",
				"c1",
			]);
			expect(data.connections[0]).toMatchObject({
				id: "c2",
				status: "needs_reauth",
			});
		});

		// Narrowing only: a capability the user isn't served can never appear
		// here, so a selection built from this list can't widen access.
		it("reports only the capabilities the connection actually serves", async () => {
			mockGetEnabledConnectionCapabilities.mockResolvedValue(
				new Set(["files"]),
			);
			mockListConnectionsForUser.mockResolvedValue([conn()]);

			const data = await (await GET(makeEvent())).json();
			expect(data.connections[0].capabilities).toEqual(["files"]);
		});

		it("reports no capabilities for a connection that isn't connected", async () => {
			mockGetEnabledConnectionCapabilities.mockResolvedValue(
				new Set(["files", "contacts"]),
			);
			mockListConnectionsForUser.mockResolvedValue([
				conn({ status: "needs_reauth" }),
			]);

			const data = await (await GET(makeEvent())).json();
			expect(data.connections[0].capabilities).toEqual([]);
		});

		it("never reports a capability the provider cannot serve", async () => {
			mockGetEnabledConnectionCapabilities.mockResolvedValue(
				new Set(["files", "email"]),
			);
			mockListConnectionsForUser.mockResolvedValue([
				conn({ capabilities: ["files", "email"] }),
			]);

			const data = await (await GET(makeEvent())).json();
			expect(data.connections[0].capabilities).toEqual(["files"]);
		});
	});
});
