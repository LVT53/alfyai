import { beforeEach, expect, it, vi } from "vitest";
import { ConnectionHttpError } from "$lib/server/services/connections/provider-http";
import { POST } from "./+server";

const service = vi.hoisted(() => ({
	plexSetupSession: vi.fn(),
	startPlexSetup: vi.fn(),
	pollPlexSetup: vi.fn(),
	selectPlexServer: vi.fn(),
}));
vi.mock("$lib/server/services/connections/providers/plex-setup", () => service);

const origin = "https://alfy.example";
const attemptId = "fa574529-c6b7-4d2c-81f2-9924d16e9ac8";
function request(
	action: string,
	body: unknown,
	options: { user?: boolean; cookie?: boolean; origin?: string } = {},
) {
	const url = new URL(`/api/connections/plex/link/${action}`, origin);
	return {
		url,
		params: { action },
		cookies: {
			get: (name: string) =>
				name === "session" && options.cookie !== false
					? "test-cookie"
					: undefined,
		},
		locals: { user: options.user === false ? null : { id: "me" } },
		request: new Request(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: options.origin ?? origin,
			},
			body: JSON.stringify(body),
		}),
	} as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
	vi.resetAllMocks();
	service.plexSetupSession.mockReturnValue("session-digest");
});

it.each([{ user: false }, { cookie: false }])(
	"requires both a signed-in user and their current session",
	async (options) => {
		await expect(POST(request("start", {}, options))).rejects.toMatchObject({
			status: 401,
		});
		expect(service.startPlexSetup).not.toHaveBeenCalled();
	},
);

it.each([
	["start", {}, "https://elsewhere.example", 403],
	["select", { attemptId, serverId: "home" }, "https://elsewhere.example", 403],
	["status", { attemptId, userId: "someone-else" }, origin, 400],
	[
		"select",
		{ attemptId, serverId: "home", serverUrl: "https://elsewhere.example" },
		origin,
		400,
	],
	["status", { attemptId: "not-an-attempt" }, origin, 400],
	["unknown", {}, origin, 404],
] as const)(
	"rejects invalid or cross-origin %s before contacting Plex",
	async (action, body, origin, status) => {
		await expect(POST(request(action, body, { origin }))).rejects.toMatchObject(
			{ status },
		);
		expect(service.startPlexSetup).not.toHaveBeenCalled();
		expect(service.pollPlexSetup).not.toHaveBeenCalled();
		expect(service.selectPlexServer).not.toHaveBeenCalled();
	},
);

it("keeps start, discovery and server selection private and bound to the signed-in session", async () => {
	const authUrl = "https://app.plex.tv/auth#?code=example";
	const ready = { status: "ready", servers: [{ id: "home", name: "Home" }] };
	const linked = {
		connection: { id: "plex-1", provider: "plex", label: "Home" },
	};
	service.startPlexSetup.mockResolvedValue({
		attemptId,
		authUrl,
		expiresAt: 1234,
	});
	service.pollPlexSetup.mockResolvedValue(ready);
	service.selectPlexServer.mockResolvedValue(linked);
	for (const [action, body, expected] of [
		[
			"start",
			{ connectionId: "plex-1" },
			{ attemptId, authUrl, expiresAt: 1234 },
		],
		["status", { attemptId }, ready],
		["select", { attemptId, serverId: "home" }, linked],
	] as const) {
		const response = await POST(request(action, body));
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toContain("no-store");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
		expect(await response.json()).toEqual(expected);
	}
	expect(service.plexSetupSession).toHaveBeenCalledWith("test-cookie");
	expect(service.startPlexSetup).toHaveBeenCalledWith(
		"me",
		"session-digest",
		"plex-1",
	);
	expect(service.pollPlexSetup).toHaveBeenCalledWith(
		"me",
		"session-digest",
		attemptId,
	);
	expect(service.selectPlexServer).toHaveBeenCalledWith(
		"me",
		"session-digest",
		attemptId,
		"home",
	);
});

it.each([
	["no_server_grant", 403],
	["server_unavailable", 422],
	["busy", 429],
	["rate_limited", 429],
	["expired", 410],
	["needs_reauth", 410],
	["pending", 409],
	["provider_failed", 502],
] as const)(
	"translates %s without forwarding provider credentials or raw errors",
	async (code, status) => {
		service.selectPlexServer.mockRejectedValue(
			new ConnectionHttpError(
				"private provider message: secret-test-token",
				code,
			),
		);
		const result = POST(request("select", { attemptId, serverId: "home" }));
		await expect(result).rejects.toMatchObject({
			status,
			body: { message: expect.any(String) },
		});
		await expect(result).rejects.not.toMatchObject({
			body: { message: expect.stringContaining("secret-test-token") },
		});
	},
);
