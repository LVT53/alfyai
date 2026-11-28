import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, PATCH, POST } from "./+server";
import { GET as callback } from "./callback/+server";

const service = vi.hoisted(() => ({
	getBoschHostedSetup: vi.fn(),
	startBoschHostedSetup: vi.fn(),
	setBoschHostedGrants: vi.fn(),
	completeBoschHostedSetup: vi.fn(),
}));
vi.mock(
	"$lib/server/services/connections/providers/bosch-flow-hosted",
	() => service,
);

const rejectsCallback = vi.hoisted(() => vi.fn());
vi.mock("$lib/server/services/connections/providers/bosch-flow-oauth", () => ({
	boschRejectsCallback: rejectsCallback,
}));

const origin = "https://app.example";
const path = "/api/connections/bosch/hosted";
const state = "a".repeat(43);
const cookie = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
function event(
	method: string,
	route = path,
	body?: string,
	headers: Record<string, string> = {},
	user: string | null = "rider",
) {
	const url = new URL(route, origin);
	return {
		url,
		locals: { user: user && { id: user } },
		cookies: cookie,
		request: new Request(url, {
			method,
			headers: { "content-type": "application/json", origin, ...headers },
			body,
		}),
	} as unknown as Parameters<typeof GET>[0] & Parameters<typeof callback>[0];
}
const details = {
	clientId: "client",
	clientSecret: "private-secret",
	grants: ["fitness", "details"],
};
beforeEach(() => {
	vi.resetAllMocks();
	cookie.get.mockReturnValue(state);
	service.startBoschHostedSetup.mockResolvedValue({
		url: "https://provider.example/login",
		state,
	});
});
describe("hosted Bosch setup", () => {
	it("limits reads and updates to the signed-in rider", async () => {
		await expect(
			GET(event("GET", path, undefined, {}, null)),
		).rejects.toMatchObject({ status: 401 });
		service.getBoschHostedSetup.mockResolvedValue({
			mode: "helper",
			grants: [],
			clientSecret: "unpublished",
		});
		const response = await GET(event("GET"));
		expect(await response.json()).toEqual({
			mode: "helper",
			grants: [],
			callbackUrl: `${origin + path}/callback`,
		});
		expect(response.headers.get("cache-control")).toContain("no-store");
		expect(service.getBoschHostedSetup).toHaveBeenCalledWith("rider");
	});
	it("keeps the rider in setup when Bosch rejects the hosted callback", async () => {
		rejectsCallback.mockResolvedValue(true);
		await expect(
			POST(event("POST", path, JSON.stringify(details))),
		).rejects.toMatchObject({ status: 422 });
		expect(rejectsCallback).toHaveBeenCalledWith(
			details.clientId,
			new URL(`${origin + path}/callback`),
		);
		expect(service.startBoschHostedSetup).not.toHaveBeenCalled();
		expect(cookie.set).not.toHaveBeenCalled();
	});
	it("starts PKCE in the browser's own session without revealing client credentials", async () => {
		const response = await POST(event("POST", path, JSON.stringify(details)));
		expect(await response.json()).toEqual({
			authUrl: "https://provider.example/login",
		});
		expect(service.startBoschHostedSetup).toHaveBeenCalledWith(
			"rider",
			details,
			new URL(`${origin + path}/callback`),
		);
		expect(cookie.set).toHaveBeenCalledWith(
			expect.any(String),
			state,
			expect.objectContaining({
				httpOnly: true,
				sameSite: "lax",
				secure: true,
				path: `${path}/callback`,
			}),
		);
	});
	it.each([
		[JSON.stringify(details), { origin: "https://other.example" }, 403],
		[JSON.stringify(details), { "content-type": "text/plain" }, 415],
		[JSON.stringify({ ...details, grants: ["all"] }), {}, 400],
		[JSON.stringify({ ...details, clientId: "a".repeat(513) }), {}, 400],
		[JSON.stringify({ ...details, userId: "someone-else" }), {}, 400],
		[JSON.stringify({ ...details, clientSecret: "a".repeat(33000) }), {}, 413],
	] as const)(
		"rejects malformed or cross-site setup before starting Bosch",
		async (body, headers, status) => {
			await expect(
				POST(event("POST", path, body, headers as Record<string, string>)),
			).rejects.toMatchObject({ status });
			expect(service.startBoschHostedSetup).not.toHaveBeenCalled();
		},
	);
	it("saves only the selected grants on the active rider's native connection", async () => {
		const save = () =>
			PATCH(event("PATCH", path, JSON.stringify({ grants: ["location"] })));
		service.setBoschHostedGrants
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);
		await expect(save()).rejects.toMatchObject({ status: 409 });
		expect((await save()).status).toBe(204);
		expect(service.setBoschHostedGrants).toHaveBeenCalledWith("rider", [
			"location",
		]);
	});
	it("checks the browser state before exchanging, then clears it and drops OAuth parameters", async () => {
		const result = await callback(
			event("GET", `${path}/callback?code=private-code&state=${state}`),
		);
		expect(service.completeBoschHostedSetup).toHaveBeenCalledWith(
			"rider",
			"private-code",
			state,
			new URL(`${origin + path}/callback`),
		);
		expect(cookie.delete).toHaveBeenCalled();
		expect(result.headers.get("location")).toBe(
			"/settings?section=connections&connected=bosch",
		);
		expect(result.headers.get("referrer-policy")).toBe("no-referrer");
	});
	it("discards mismatched and duplicated parameters and preserves a newer browser attempt", async () => {
		for (const search of [
			"state=wrong&code=c",
			`state=${state}&state=wrong&code=c`,
			`state=${state}&code=c&code=z`,
		]) {
			const response = await callback(
				event("GET", `${path}/callback?${search}`),
			);
			expect(response.headers.get("location")).toContain("error=bosch_oauth_");
		}
		expect(service.completeBoschHostedSetup).not.toHaveBeenCalled();
		expect(cookie.delete).not.toHaveBeenCalled();
	});
	it("redirects a denial and an exchange failure without propagating private values", async () => {
		const denied = await callback(
			event("GET", `${path}/callback?state=${state}&error=denied`),
		);
		expect(denied.headers.get("location")).toContain(
			"error=bosch_oauth_denied",
		);
		service.completeBoschHostedSetup.mockRejectedValue(
			new Error("private provider message"),
		);
		const failed = await callback(
			event("GET", `${path}/callback?state=${state}&code=abc`),
		);
		expect(failed.headers.get("location")).toBe(
			"/settings?section=connections&error=bosch_oauth_failed",
		);
	});
});
