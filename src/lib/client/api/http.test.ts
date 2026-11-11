import { get } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	SESSION_EXPIRED_CODE,
	SESSION_EXPIRED_HEADER,
	SESSION_EXPIRED_MESSAGE,
} from "$lib/session-expiry";
import {
	clearSessionExpiry,
	isSessionExpired,
	markSessionExpired,
	sessionExpiry,
} from "$lib/stores/session";
import {
	ApiError,
	readErrorPayload,
	reportAuthFailure,
	requestJson,
	requestResponse,
	requestText,
	requestVoid,
} from "./http";

function setPathname(pathname: string) {
	window.history.replaceState({}, "", pathname);
}

function jsonResponse(
	body: unknown,
	status: number,
	headers: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

/**
 * What the gate in `hooks.server.ts` answers an API call with once the session
 * is gone: 401, the code in the body, and the header the browser keys on.
 */
function gateRefusal(): Response {
	return jsonResponse(
		{ error: SESSION_EXPIRED_MESSAGE, code: SESSION_EXPIRED_CODE },
		401,
		{ [SESSION_EXPIRED_HEADER]: "1" },
	);
}

/**
 * What a session gate INSIDE a route answers with. Those refusals never reach
 * the hook, so they carry no header — the word is all there is to go on, and it
 * has to be enough.
 */
const unauthorized = () => jsonResponse({ error: "Unauthorized" }, 401);

/**
 * A clean slate for both halves of the store: no verdict, and the announcement
 * throttle re-armed (`clearSessionExpiry` only resets it when there was
 * something to clear). Tests compare `alertCount` as a delta, since it is
 * monotonic by design and deliberately survives a clear.
 */
beforeEach(() => {
	markSessionExpired();
	clearSessionExpiry();
	setPathname("/chat/conversation-1");
});

describe("ApiError surfacing", () => {
	it("throws an ApiError with status 401 for an unauthenticated API call", async () => {
		const error = await requestJson(
			"/api/conversations",
			undefined,
			"Failed to load conversations",
			async () => unauthorized(),
		).catch((err: unknown) => err);

		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).status).toBe(401);
		expect((error as Error).message).toBe("Unauthorized");
	});

	it("carries the details and code fields through a 401", async () => {
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
		expect((error as ApiError).code).toBe("no_session");
		expect((error as ApiError).details).toEqual({ a: 1 });
	});

	// A refusal with one code for several causes says which in `reason` (the 503
	// CAPACITY_EXCEEDED of a full server, a second reply and a server that is
	// draining for a deploy): a caller that has to treat the causes differently
	// reads it from here.
	it("carries the server's reason beside its code", async () => {
		const error = await requestJson(
			"/api/chat/turn-check",
			undefined,
			"failed",
			async () =>
				jsonResponse(
					{
						error: "Server at capacity. Please try again later.",
						code: "CAPACITY_EXCEEDED",
						reason: "draining",
						retryAfter: 10,
					},
					503,
				),
		).catch((err: unknown) => err);

		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).code).toBe("CAPACITY_EXCEEDED");
		expect((error as ApiError).reason).toBe("draining");
	});

	it("leaves the reason out when the body has none, or has one that is not a word", async () => {
		for (const body of [
			{ error: "Nope", code: "x" },
			{ error: "Nope", code: "x", reason: 7 },
			{ error: "Nope", code: "x", reason: "  " },
		]) {
			const error = await requestJson("/api/x", undefined, "failed", async () =>
				jsonResponse(body, 409),
			).catch((err: unknown) => err);

			expect((error as ApiError).reason).toBeUndefined();
		}
	});

	// While the app process is away the reverse proxy answers with its own page (a
	// restart: Apache's maintenance 503). That is a different thing from an error
	// the app wrote, and a caller that has to tell them apart reads the flag.
	describe("the reverse proxy's page", () => {
		const proxyPage = (status: number) => () =>
			new Response("<html><body>AlfyAI is being updated</body></html>", {
				status,
				headers: { "content-type": "text/html" },
			});

		it.each([
			502, 503, 504,
		])("marks a %s with an HTML body as the server being unavailable", async (status) => {
			const error = await requestJson("/api/x", undefined, "failed", async () =>
				proxyPage(status)(),
			).catch((err: unknown) => err);

			expect(error).toBeInstanceOf(ApiError);
			expect((error as ApiError).status).toBe(status);
			expect((error as ApiError).serverUnavailable).toBe(true);
		});

		it("marks a gateway status with no body at all", async () => {
			const error = await requestVoid(
				"/api/x",
				undefined,
				"failed",
				async () => new Response(null, { status: 502 }),
			).catch((err: unknown) => err);

			expect((error as ApiError).serverUnavailable).toBe(true);
		});

		it("does not mark an error the app wrote, whatever its status", async () => {
			for (const [body, status] of [
				[{ error: "Nope" }, 503],
				[{ message: "Service unavailable" }, 503],
				[{ error: "Server at capacity.", code: "CAPACITY_EXCEEDED" }, 503],
				[{ code: "model_timeout" }, 504],
			] as const) {
				const error = await requestJson(
					"/api/x",
					undefined,
					"failed",
					async () => jsonResponse(body, status),
				).catch((err: unknown) => err);

				expect((error as ApiError).serverUnavailable).toBeUndefined();
			}
		});

		it("does not mark a status the proxy does not use, even with an HTML body", async () => {
			for (const status of [400, 404, 409, 500]) {
				const error = await requestJson(
					"/api/x",
					undefined,
					"failed",
					async () => proxyPage(status)(),
				).catch((err: unknown) => err);

				expect((error as ApiError).serverUnavailable).toBeUndefined();
			}
		});
	});

	it("carries the gate's own code to the caller", async () => {
		const error = await requestJson(
			"/api/conversations",
			undefined,
			"failed",
			vi.fn(async () => gateRefusal()),
		).catch((err: unknown) => err);

		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).status).toBe(401);
		expect((error as ApiError).code).toBe(SESSION_EXPIRED_CODE);
		// The gate's body carries a sentence worth showing, rather than the bare
		// word every error surface used to echo.
		expect((error as Error).message).toBe(SESSION_EXPIRED_MESSAGE);
	});
});

/**
 * The app's one reaction to an expired session: the shell's signed-out row goes
 * up. Not a navigation — see the note on `noteSessionExpiry`.
 */
describe("central session-expiry handling", () => {
	it("raises the row when the gate refuses the call", async () => {
		await expect(
			requestJson(
				"/api/conversations",
				undefined,
				"failed",
				vi.fn(async () => gateRefusal()),
			),
		).rejects.toBeInstanceOf(ApiError);

		expect(isSessionExpired()).toBe(true);
	});

	// The second signal. A route's own gate answers before the hook ever sees
	// the request, so there is no header on it.
	it("raises the row for a route's own Unauthorized, with no header to read", async () => {
		await requestJson("/api/conversations", undefined, "Failed", async () =>
			unauthorized(),
		).catch(() => undefined);

		expect(isSessionExpired()).toBe(true);
	});

	it("recognises the thrown-error body shape requireApiUser produces", async () => {
		await requestJson("/api/connections", undefined, "Failed", async () =>
			jsonResponse({ message: "Unauthorized" }, 401),
		).catch(() => undefined);

		expect(isSessionExpired()).toBe(true);
	});

	it("covers the void and raw-response helpers too", async () => {
		await requestVoid(
			"/api/conversations/x",
			{ method: "DELETE" },
			"failed",
			vi.fn(async () => gateRefusal()),
		).catch(() => undefined);
		expect(isSessionExpired()).toBe(true);

		clearSessionExpiry();
		await requestResponse(
			"/api/knowledge/x/download",
			undefined,
			vi.fn(async () => gateRefusal()),
		);
		expect(isSessionExpired()).toBe(true);
	});

	// The three `requestResponse` callers build their own errors and read the
	// body themselves, as do the two raw `fetch` sites (`preview-runtime`,
	// `DocumentsList`) and the download probe. All of them land here.
	it("also fires for the callers that read the body themselves", async () => {
		await readErrorPayload(gateRefusal(), "Failed to export conversation");

		expect(isSessionExpired()).toBe(true);
	});

	it("reports a streaming 401 through the same handler", () => {
		reportAuthFailure(401, "Unauthorized");

		expect(isSessionExpired()).toBe(true);
	});

	it("reads the header off a streaming response whose body says nothing useful", () => {
		reportAuthFailure(401, "HTTP 401", gateRefusal());

		expect(isSessionExpired()).toBe(true);
	});

	// Signing in on another tab heals this one without a reload.
	it("lowers the row again once a call succeeds", async () => {
		markSessionExpired();

		await requestJson(
			"/api/conversations",
			undefined,
			"failed",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ ok: true }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
			),
		);

		expect(isSessionExpired()).toBe(false);
	});

	it("re-arms once the session is restored", () => {
		reportAuthFailure(401, "Unauthorized");
		expect(isSessionExpired()).toBe(true);

		clearSessionExpiry();
		expect(isSessionExpired()).toBe(false);

		reportAuthFailure(401, "Unauthorized");
		expect(isSessionExpired()).toBe(true);
	});
});

describe("401s that are not the session", () => {
	// The login form's own 401 — a wrong password — must not tell the user they
	// have been signed out of a session they never had.
	it("leaves the row alone for a failed login attempt", async () => {
		setPathname("/login");

		await requestJson(
			"/api/auth/login",
			{ method: "POST" },
			"Login failed",
			async () => jsonResponse({ error: "Invalid email or password" }, 401),
		).catch(() => undefined);

		expect(isSessionExpired()).toBe(false);
	});

	// The settings routes re-ask for the password before a destructive action
	// and answer 401 when it is wrong — inside a perfectly good session.
	it.each([
		"Incorrect password",
		"Current password is incorrect",
		"Invalid email or password",
	])("leaves the row alone for the re-auth refusal %j", async (message) => {
		const error = await requestJson(
			"/api/settings/account",
			{ method: "DELETE" },
			"Failed",
			async () => jsonResponse({ error: message }, 401),
		).catch((err: unknown) => err);

		expect((error as ApiError).status).toBe(401);
		expect(isSessionExpired()).toBe(false);
	});

	it("leaves the row alone for a provider's own 401", async () => {
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

		expect(isSessionExpired()).toBe(false);
	});

	it.each([
		403, 404, 500,
	])("leaves the row alone for an unrelated %i", async (status) => {
		await requestJson("/api/conversations", undefined, "Failed", async () =>
			jsonResponse({ error: "Unauthorized" }, status),
		).catch(() => undefined);

		expect(isSessionExpired()).toBe(false);
	});
});

describe("one row, one announcement", () => {
	// A page with a poller, an evidence fetch and a conversation refresh in
	// flight produces a burst of 401s the moment the session dies. One row and
	// one announcement, not one per request.
	it("collapses a burst of concurrent 401s into a single announcement", async () => {
		const before = get(sessionExpiry).alertCount;

		await Promise.all(
			Array.from({ length: 12 }, () =>
				requestJson(
					"/api/knowledge/extraction",
					undefined,
					"Failed",
					async () => gateRefusal(),
				).catch(() => undefined),
			),
		);

		expect(isSessionExpired()).toBe(true);
		expect(get(sessionExpiry).alertCount).toBe(before + 1);
	});

	// There is no shell on /login and so no row, and a refusal there must not
	// leave a verdict behind for whatever the user lands on next.
	it("ignores 401s that arrive once the login page is showing", () => {
		setPathname("/login");

		for (let i = 0; i < 5; i += 1) reportAuthFailure(401, "Unauthorized");

		expect(isSessionExpired()).toBe(false);
	});
});

describe("session authority across response ordering", () => {
	function deferred<T>() {
		let resolve!: (value: T) => void;
		const promise = new Promise<T>((done) => {
			resolve = done;
		});
		return { promise, resolve };
	}

	it.each([
		"response",
		"json",
		"void",
		"text",
	])("does not let an old success clear a newer expiry (%s)", async (helper) => {
		const pending = deferred<Response>();
		const fetchImpl = vi.fn(() => pending.promise);
		const oldSuccess =
			helper === "response"
				? requestResponse("/api/old", undefined, fetchImpl)
				: helper === "json"
					? requestJson("/api/old", undefined, "failed", fetchImpl)
					: helper === "void"
						? requestVoid("/api/old", undefined, "failed", fetchImpl)
						: requestText("/api/old", undefined, "failed", fetchImpl);
		await requestResponse("/api/refused", undefined, async () => gateRefusal());
		const count = get(sessionExpiry).alertCount;
		pending.resolve(jsonResponse({}, 200));
		await oldSuccess;
		expect(isSessionExpired()).toBe(true);
		await requestResponse("/api/refused-again", undefined, async () =>
			gateRefusal(),
		);
		expect(get(sessionExpiry).alertCount).toBe(count);
	});

	it.each([
		gateRefusal,
		unauthorized,
	])("does not let an old refusal undo newer healing (%s)", async (refusal) => {
		const pending = deferred<Response>();
		const oldFailure = requestJson(
			"/api/old",
			undefined,
			"failed",
			() => pending.promise,
		).catch((error: unknown) => error);
		markSessionExpired();
		await requestResponse("/api/healed", undefined, async () =>
			jsonResponse({}, 200),
		);
		const count = get(sessionExpiry).alertCount;
		pending.resolve(refusal());
		expect(await oldFailure).toBeInstanceOf(ApiError);
		expect(isSessionExpired()).toBe(false);
		expect(get(sessionExpiry).alertCount).toBe(count);
	});

	it.each([
		gateRefusal,
		unauthorized,
	])("retains raw response authority while its error body is delayed (%s)", async (refusal) => {
		const response = refusal();
		const body = deferred<string>();
		const text = await response.text();
		vi.spyOn(response, "text").mockReturnValue(body.promise);
		const raw = await requestResponse(
			"/api/old",
			undefined,
			async () => response,
		);
		expect(raw).toBe(response);
		const reading = readErrorPayload(raw, "failed");
		markSessionExpired();
		await requestResponse("/api/healed", undefined, async () =>
			jsonResponse({}, 200),
		);
		const count = get(sessionExpiry).alertCount;
		body.resolve(text);
		await reading;
		expect(isSessionExpired()).toBe(false);
		expect(get(sessionExpiry).alertCount).toBe(count);
	});

	it("invalidates an in-flight refusal on an explicit reset even while healthy", async () => {
		const pending = deferred<Response>();
		const old = requestResponse("/api/old", undefined, () => pending.promise);
		clearSessionExpiry();
		pending.resolve(gateRefusal());
		await old;
		expect(isSessionExpired()).toBe(false);
	});

	it("keeps the direct-fetch await scheduling and raw identity", async () => {
		const response = jsonResponse({}, 200);
		const events: string[] = [];
		const fetchImpl = vi.fn(() => Promise.resolve(response));
		const result = requestResponse("/api/raw", undefined, fetchImpl).then(
			(raw) => {
				events.push("response");
				expect(raw).toBe(response);
			},
		);
		await Promise.resolve();
		await Promise.resolve();
		expect(events).toEqual(["response"]);
		expect(fetchImpl).toHaveBeenCalledWith("/api/raw");
		await result;
	});
});
