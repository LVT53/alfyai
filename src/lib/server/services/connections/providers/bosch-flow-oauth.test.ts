import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	beginBoschLogin,
	boschRejectsCallback,
	exchangeBoschCode,
	refreshBoschGrant,
} from "./bosch-flow-oauth";

const callback = new URL("https://example.org/api/oauth/bosch/callback");
const client = { clientId: "test-client", clientSecret: "synthetic-secret" };
describe("Bosch rider authorization", () => {
	it("creates distinct login attempts and binds each code to its verifier", () => {
		const one = beginBoschLogin(client.clientId, callback);
		const two = beginBoschLogin(client.clientId, callback);
		expect(one.state).not.toBe(two.state);
		expect(one.verifier).not.toBe(two.verifier);
		const url = new URL(one.url);
		expect(url.searchParams.get("code_challenge")).toBe(
			createHash("sha256").update(one.verifier).digest("base64url"),
		);
		expect(url.searchParams.get("redirect_uri")).toBe(callback.href);
		expect(one.url).not.toContain(one.verifier);
	});
	it("exchanges the code and retains the refresh credential when Bosch omits a replacement", async () => {
		const request = vi.fn(async () =>
			Response.json({
				access_token: "test-token",
				token_type: "Bearer",
				expires_in: 300,
			}),
		);
		expect(
			(await exchangeBoschCode(client, "code", "verifier", callback, request))
				.refreshToken,
		).toBeNull();
		expect(
			(await refreshBoschGrant(client, "existing", request)).refreshToken,
		).toBe("existing");
	});
});
it("distinguishes a temporary token service failure from a revoked rider grant", async () => {
	const fetch = vi.fn(async () =>
		Response.json({ error: "temporarily_unavailable" }, { status: 400 }),
	);
	await expect(
		refreshBoschGrant(client, "refresh", fetch),
	).rejects.toMatchObject({ code: "provider_unavailable" });
});

it("checks only the public redirect registration through a separate silent request", async () => {
	const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
		const probe = new URL(String(url));
		expect(probe.origin).toBe("https://p9.authz.bosch.com");
		expect(probe.searchParams.get("redirect_uri")).toBe(callback.href);
		expect(probe.searchParams.get("prompt")).toBe("none");
		expect(probe.searchParams.has("client_secret")).toBe(false);
		expect(init?.redirect).toBe("manual");
		return Response.json(
			{ error: "Invalid parameter: redirect_uri" },
			{ status: 400 },
		);
	});
	expect(await boschRejectsCallback(client.clientId, callback, fetcher)).toBe(
		true,
	);
	for (const response of [
		Response.redirect(callback),
		Response.json({ error: "invalid_client" }, { status: 400 }),
		new Response(null, { status: 503 }),
	]) {
		expect(
			await boschRejectsCallback(
				client.clientId,
				callback,
				async () => response,
			),
		).toBe(false);
	}
});
