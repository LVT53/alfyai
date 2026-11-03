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

	it("says a healthy server is reachable and not draining", async () => {
		const health = await fetchServerHealth(
			vi.fn(async () =>
				jsonResponse({ status: "OK", draining: false, activeStreams: 2 }),
			),
		);

		expect(health).toEqual({ reachable: true, draining: false });
	});

	it("says a draining server is reachable and draining", async () => {
		const health = await fetchServerHealth(
			vi.fn(async () =>
				jsonResponse({ status: "OK", draining: true, activeStreams: 1 }),
			),
		);

		expect(health).toEqual({ reachable: true, draining: true });
	});

	it("takes the legacy body, with no draining field, for a server that is not draining", async () => {
		const health = await fetchServerHealth(
			vi.fn(async () => jsonResponse({ status: "OK" })),
		);

		expect(health).toEqual({ reachable: true, draining: false });
	});

	it("says the server is away when the proxy answers its maintenance page", async () => {
		const health = await fetchServerHealth(
			vi.fn(
				async () =>
					new Response("<html><body>Back soon</body></html>", {
						status: 503,
						headers: { "Content-Type": "text/html" },
					}),
			),
		);

		expect(health).toEqual({ reachable: false, draining: false });
	});

	it("says the server is away for a status that is not OK, even with the health body", async () => {
		const health = await fetchServerHealth(
			vi.fn(async () =>
				jsonResponse({ status: "OK", draining: true }, { status: 500 }),
			),
		);

		expect(health).toEqual({ reachable: false, draining: false });
	});

	it("says the server is away for a 200 that is not the health JSON", async () => {
		for (const response of [
			() => new Response("<html>login</html>", { status: 200 }),
			() => jsonResponse({}),
			() => jsonResponse({ status: "DOWN" }),
			() => jsonResponse(["OK"]),
			() => jsonResponse(null),
		]) {
			expect(await fetchServerHealth(vi.fn(async () => response()))).toEqual({
				reachable: false,
				draining: false,
			});
		}
	});

	it("says the server is away when the request fails", async () => {
		const health = await fetchServerHealth(
			vi.fn(async () => {
				throw new TypeError("Failed to fetch");
			}),
		);

		expect(health).toEqual({ reachable: false, draining: false });
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

		expect(await pending).toEqual({ reachable: false, draining: false });
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
