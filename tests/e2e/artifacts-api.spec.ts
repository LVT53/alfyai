import { expect, test } from "@playwright/test";

// Item 6 of the client review, rulings 19 and 39: the artifact routes use
// requireApiUser, but for an unauthenticated /api/** request hooks.server.ts
// answers with its own 401 before the route ever runs (auth.spec.ts pins the
// same contract for /api/conversations) — so this is the HTTP layer's 401,
// not a route-handler-level test, which would be testing the wrong thing
// (ruling 19: "Do not write a route-handler-level test asserting a 401 from
// these routes: at that layer it would fail against the real helper.").
test.describe("Artifact routes, no session", () => {
	test("GET /api/artifacts/[id] answers 401 JSON, not a redirect", async ({
		request,
	}) => {
		const response = await request.get("/api/artifacts/some-artifact-id", {
			maxRedirects: 0,
		});

		expect(response.status()).toBe(401);
		expect(response.headers()["content-type"]).toContain("application/json");
		expect(response.headers()["x-session-expired"]).toBe("1");
		expect(await response.json()).toMatchObject({ code: "session_expired" });
	});

	test("GET /api/artifacts?conversationId=… answers 401 JSON, not a redirect", async ({
		request,
	}) => {
		const response = await request.get(
			"/api/artifacts?conversationId=some-conversation-id",
			{ maxRedirects: 0 },
		);

		expect(response.status()).toBe(401);
		expect(response.headers()["content-type"]).toContain("application/json");
		expect(response.headers()["x-session-expired"]).toBe("1");
		expect(await response.json()).toMatchObject({ code: "session_expired" });
	});
});
