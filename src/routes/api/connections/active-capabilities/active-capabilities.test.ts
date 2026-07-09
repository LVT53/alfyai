import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/connections/resolve", () => ({
	getDefaultOnCapabilities: vi.fn(),
	getEnabledConnectionCapabilities: vi.fn(),
	resolveConnectionsForCapability: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import {
	getDefaultOnCapabilities,
	getEnabledConnectionCapabilities,
	resolveConnectionsForCapability,
} from "$lib/server/services/connections/resolve";
import { GET } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
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
		mockRequireAuth.mockReturnValue(undefined);
		mockGetEnabledConnectionCapabilities.mockResolvedValue(new Set());
		mockGetDefaultOnCapabilities.mockResolvedValue(new Set());
		mockResolveConnectionsForCapability.mockResolvedValue([]);
	});

	it("requires auth", async () => {
		await GET(makeEvent());
		expect(mockRequireAuth).toHaveBeenCalled();
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

		expect(data).toEqual({ served: [], defaultOn: [], accounts: [] });
	});
});
