import { beforeEach, describe, expect, it, vi } from "vitest";

const goto = vi.fn(async () => undefined);

vi.mock("$app/navigation", () => ({ goto }));

/**
 * `noteSessionExpiry` keeps one module-level promise, so each test imports a
 * fresh copy of the module rather than leaking a pending navigation into the
 * next one.
 */
async function freshHttp() {
	vi.resetModules();
	return import("./http");
}

function setPathname(pathname: string) {
	window.history.replaceState({}, "", pathname);
}

function jsonResponse(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const unauthorized = () => jsonResponse({ error: "Unauthorized" }, 401);

describe("ApiError surfacing", () => {
	beforeEach(() => {
		goto.mockClear();
		setPathname("/chat/conversation-1");
	});

	it("throws an ApiError with status 401 for an unauthenticated API call", async () => {
		const { ApiError, requestJson } = await freshHttp();

		const error = await requestJson(
			"/api/conversations",
			undefined,
			"Failed to load conversations",
			async () => unauthorized(),
		).catch((err: unknown) => err);

		expect(error).toBeInstanceOf(ApiError);
		expect((error as InstanceType<typeof ApiError>).status).toBe(401);
		expect((error as Error).message).toBe("Unauthorized");
	});

	it("carries the details and code fields through a 401", async () => {
		const { ApiError, requestVoid } = await freshHttp();

		const error = await requestVoid(
			"/api/conversations/c1",
			{ method: "DELETE" },
			"Failed",
			async () =>
				jsonResponse(
					{ error: "Unauthorized", code: "no_session", details: { a: 1 } },
					401,
				),
		).catch((err: unknown) => err);

		expect(error).toBeInstanceOf(ApiError);
		expect((error as InstanceType<typeof ApiError>).code).toBe("no_session");
		expect((error as InstanceType<typeof ApiError>).details).toEqual({ a: 1 });
	});
});

describe("central session-expiry navigation", () => {
	beforeEach(() => {
		goto.mockClear();
		setPathname("/chat/conversation-1");
	});

	it("navigates to /login once when the session is gone", async () => {
		const { requestJson } = await freshHttp();

		await requestJson("/api/conversations", undefined, "Failed", async () =>
			unauthorized(),
		).catch(() => undefined);
		await vi.waitFor(() => expect(goto).toHaveBeenCalledTimes(1));

		expect(goto).toHaveBeenCalledWith("/login", { invalidateAll: true });
	});

	it("also fires for the requestResponse callers that read the body themselves", async () => {
		const { readErrorPayload } = await freshHttp();

		await readErrorPayload(unauthorized(), "Failed to export conversation");
		await vi.waitFor(() => expect(goto).toHaveBeenCalledTimes(1));
	});

	it("recognises the thrown-error body shape requireApiUser produces", async () => {
		const { requestJson } = await freshHttp();

		await requestJson("/api/connections", undefined, "Failed", async () =>
			jsonResponse({ message: "Unauthorized" }, 401),
		).catch(() => undefined);
		await vi.waitFor(() => expect(goto).toHaveBeenCalledTimes(1));
	});

	it("reports a streaming 401 through the same handler", async () => {
		const { reportAuthFailure } = await freshHttp();

		reportAuthFailure(401, "Unauthorized");
		await vi.waitFor(() => expect(goto).toHaveBeenCalledTimes(1));
	});

	it("falls back to a full page load when the router refuses", async () => {
		const assign = vi.fn();
		const original = window.location;
		Object.defineProperty(window, "location", {
			configurable: true,
			value: { ...original, pathname: "/chat/c1", assign },
		});
		goto.mockRejectedValueOnce(new Error("no router"));

		try {
			const { reportAuthFailure } = await freshHttp();
			reportAuthFailure(401, "Unauthorized");
			await vi.waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
		} finally {
			Object.defineProperty(window, "location", {
				configurable: true,
				value: original,
			});
		}
	});
});

describe("no redirect storms", () => {
	beforeEach(() => {
		goto.mockClear();
		setPathname("/chat/conversation-1");
	});

	// A page with a poller, an evidence fetch and a conversation refresh in
	// flight produces a burst of 401s the moment the session dies. One
	// navigation, not one per request.
	it("collapses a burst of concurrent 401s into a single navigation", async () => {
		const { requestJson } = await freshHttp();

		await Promise.all(
			Array.from({ length: 12 }, () =>
				requestJson(
					"/api/knowledge/extraction",
					undefined,
					"Failed",
					async () => unauthorized(),
				).catch(() => undefined),
			),
		);
		await vi.waitFor(() => expect(goto).toHaveBeenCalledTimes(1));
		await Promise.resolve();

		expect(goto).toHaveBeenCalledTimes(1);
	});

	// The poller's component has not torn down yet, or a request that was
	// already in flight resolves after the navigation landed.
	it("ignores 401s that arrive once the login page is showing", async () => {
		const { reportAuthFailure } = await freshHttp();
		setPathname("/login");

		for (let i = 0; i < 5; i += 1) reportAuthFailure(401, "Unauthorized");
		await Promise.resolve();

		expect(goto).not.toHaveBeenCalled();
	});

	// The login form's own 401 — a wrong password — must not bounce the page
	// it is already on, nor any other page.
	it("does not navigate for a failed login attempt", async () => {
		const { requestJson } = await freshHttp();
		setPathname("/login");

		await requestJson(
			"/api/auth/login",
			{ method: "POST" },
			"Login failed",
			async () => jsonResponse({ error: "Invalid email or password" }, 401),
		).catch(() => undefined);
		await Promise.resolve();

		expect(goto).not.toHaveBeenCalled();
	});

	// The settings routes re-ask for the password before a destructive action
	// and answer 401 when it is wrong — inside a perfectly good session.
	it.each([
		"Incorrect password",
		"Current password is incorrect",
		"Invalid email or password",
	])("does not navigate for the re-auth refusal %j", async (message) => {
		const { requestJson } = await freshHttp();

		const error = await requestJson(
			"/api/settings/account",
			{ method: "DELETE" },
			"Failed",
			async () => jsonResponse({ error: message }, 401),
		).catch((err: unknown) => err);
		await Promise.resolve();

		expect((error as { status?: number }).status).toBe(401);
		expect(goto).not.toHaveBeenCalled();
	});

	it("does not navigate for a provider's own 401", async () => {
		const { requestJson } = await freshHttp();

		await requestJson(
			"/api/connections/immich/start",
			{ method: "POST" },
			"Failed",
			async () =>
				jsonResponse(
					{ error: "Immich rejected the API key.", code: "invalid_token" },
					401,
				),
		).catch(() => undefined);
		await Promise.resolve();

		expect(goto).not.toHaveBeenCalled();
	});

	it.each([
		403, 404, 500,
	])("does not navigate for an unrelated %i", async (status) => {
		const { requestJson } = await freshHttp();

		await requestJson("/api/conversations", undefined, "Failed", async () =>
			jsonResponse({ error: "Unauthorized" }, status),
		).catch(() => undefined);
		await Promise.resolve();

		expect(goto).not.toHaveBeenCalled();
	});

	// Signing in again has to re-arm the handling: the guard is an in-flight
	// latch, not a once-per-page-load flag.
	it("re-arms after the navigation settles", async () => {
		const { reportAuthFailure } = await freshHttp();

		reportAuthFailure(401, "Unauthorized");
		await vi.waitFor(() => expect(goto).toHaveBeenCalledTimes(1));

		setPathname("/chat/conversation-2");
		reportAuthFailure(401, "Unauthorized");
		await vi.waitFor(() => expect(goto).toHaveBeenCalledTimes(2));
	});
});
