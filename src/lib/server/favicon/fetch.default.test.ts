import { afterEach, describe, expect, it, vi } from "vitest";

// What `fetchFavicon` does when its caller passes no `fetch` (the route, and
// every production path): it goes out through the outbound fetch, with a byte
// cap and a timeout, and never through the global `fetch`, which would connect
// to whatever a name resolves to.
const { outbound, createOutboundFetch } = vi.hoisted(() => {
	const outbound = vi.fn(
		async () =>
			new Response(new Uint8Array([1, 2, 3]), {
				status: 200,
				headers: { "content-type": "image/png" },
			}),
	);
	return { outbound, createOutboundFetch: vi.fn(() => outbound) };
});

vi.mock("$lib/server/outbound", () => ({ createOutboundFetch }));

import { fetchFavicon } from "./fetch";

describe("fetchFavicon without an injected fetch", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("builds its fetch from the outbound module, with a 1 MiB cap and a 6 s timeout", () => {
		expect(createOutboundFetch).toHaveBeenCalledTimes(1);
		expect(createOutboundFetch).toHaveBeenCalledWith(
			{},
			{ maxBytes: 1024 * 1024, timeoutMs: 6_000 },
		);
	});

	it("requests the source site through it, https only and without following redirects", async () => {
		const globalFetch = vi.spyOn(globalThis, "fetch");

		const result = await fetchFavicon("example.com");

		expect(result.kind).toBe("image");
		expect(outbound).toHaveBeenCalledTimes(1);
		expect(outbound).toHaveBeenCalledWith("https://example.com/favicon.ico", {
			redirect: "manual",
			headers: { accept: "image/*" },
		});
		expect(globalFetch).not.toHaveBeenCalled();
	});
});
