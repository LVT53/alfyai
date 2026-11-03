import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearSessionExpiry,
	isSessionExpired,
	markSessionExpired,
} from "$lib/stores/session";
import { fetchServerHealth, HEALTH_REQUEST_MAX_MS } from "./health";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
		...init,
	});
}

describe("fetchServerHealth", () => {
	beforeEach(() => {
		clearSessionExpiry();
	});

	afterEach(() => {
		vi.useRealTimers();
		clearSessionExpiry();
	});

	it("reads /api/health uncached", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({ status: "OK", draining: false, activeStreams: 0 }),
		);

		await fetchServerHealth(fetchImpl);

		expect(fetchImpl).toHaveBeenCalledWith(
			"/api/health",
			expect.objectContaining({ cache: "no-store" }),
		);
	});

	it("says a healthy server is up", async () => {
		const health = await fetchServerHealth(
			vi.fn(async () =>
				jsonResponse({ status: "OK", draining: false, activeStreams: 2 }),
			),
		);

		expect(health).toEqual({ state: "up" });
	});

	it("says a draining server is draining", async () => {
		const health = await fetchServerHealth(
			vi.fn(async () =>
				jsonResponse({ status: "OK", draining: true, activeStreams: 1 }),
			),
		);

		expect(health).toEqual({ state: "draining" });
	});

	it("takes the legacy body, with no draining field, for a server that is up", async () => {
		const health = await fetchServerHealth(
			vi.fn(async () => jsonResponse({ status: "OK" })),
		);

		expect(health).toEqual({ state: "up" });
	});

	// During the restart the app process is away and the reverse proxy answers its
	// own page: that is what tells a restart from a phone that lost its signal.
	it.each([
		502, 503, 504,
	])("says the proxy is down when it answers its own %s page", async (status) => {
		const health = await fetchServerHealth(
			vi.fn(
				async () =>
					new Response("<html><body>Back soon</body></html>", {
						status,
						headers: { "Content-Type": "text/html" },
					}),
			),
		);

		expect(health).toEqual({ state: "proxy_down" });
	});

	it("says the proxy is down for a gateway status with no body, or a body that is not the health JSON", async () => {
		for (const body of [null, "{}", '{"error":"upstream"}', "nope"]) {
			expect(
				await fetchServerHealth(
					vi.fn(async () => new Response(body, { status: 502 })),
				),
			).toEqual({ state: "proxy_down" });
		}
	});

	// A phone without signal, a stalled network and a refused connection give the
	// fetch no answer at all. That says nothing of the server, and the app must not
	// take it for an update.
	it("says the server is unreachable when the request fails, which is not what the proxy's page is", async () => {
		const offline = await fetchServerHealth(
			vi.fn(async () => {
				throw new TypeError("Failed to fetch");
			}),
		);
		const proxy = await fetchServerHealth(
			vi.fn(
				async () => new Response("<html>maintenance</html>", { status: 503 }),
			),
		);

		expect(offline).toEqual({ state: "unreachable" });
		expect(proxy).toEqual({ state: "proxy_down" });
		expect(offline).not.toEqual(proxy);
	});

	it("says the server is unreachable for any other answer, even one with the health body", async () => {
		for (const response of [
			// A status that is not OK, with the health body: not the proxy's page.
			() => jsonResponse({ status: "OK", draining: true }, { status: 500 }),
			() => jsonResponse({ status: "OK" }, { status: 503 }),
			() => new Response("<html>login</html>", { status: 200 }),
			() => new Response("<html>nope</html>", { status: 404 }),
			() => new Response("<html>nope</html>", { status: 500 }),
			() => jsonResponse({}),
			() => jsonResponse({ status: "DOWN" }),
			() => jsonResponse(["OK"]),
			() => jsonResponse(null),
		]) {
			expect(await fetchServerHealth(vi.fn(async () => response()))).toEqual({
				state: "unreachable",
			});
		}
	});

	it("gives up on a request that does not answer, so a stalled connection holds no poll back", async () => {
		vi.useFakeTimers();
		const fetchImpl = vi.fn(
			(_input: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(new DOMException("aborted", "AbortError")),
					);
				}),
		);

		const pending = fetchServerHealth(fetchImpl);
		await vi.advanceTimersByTimeAsync(HEALTH_REQUEST_MAX_MS);

		expect(await pending).toEqual({ state: "unreachable" });
	});

	// The route is public: it answers 200 to a tab whose session has ended. The
	// wrapper in http.ts reads a success as "the session works" and would take the
	// signed-out row down.
	it("leaves the shell's session verdict alone", async () => {
		markSessionExpired();
		expect(isSessionExpired()).toBe(true);

		await fetchServerHealth(
			vi.fn(async () => jsonResponse({ status: "OK", draining: false })),
		);

		expect(isSessionExpired()).toBe(true);
	});
});
