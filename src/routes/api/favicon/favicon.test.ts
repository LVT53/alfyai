import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/favicon/fetch", () => ({
	fetchFavicon: vi.fn(),
}));

import { fetchFavicon } from "$lib/server/favicon/fetch";
import { GLOBE_FALLBACK_SVG } from "$lib/server/favicon/globe";
import {
	noteSourceUrls,
	resetUrlProvenanceForTests,
} from "$lib/server/services/url-provenance";
import { GET } from "./+server";

// The favicon proxy fetches `https://<host>/favicon.ico` on the server. It used
// to do that for any host the browser named, and the model writes the hosts the
// browser names (a source chip, a tool row), so a prompt-injected model could
// have the server call a host with private data in its name. Now a host is
// served only when a tool returned it to THIS user (docs/plans/exfil-channels).

const fetchFaviconMock = vi.mocked(fetchFavicon);
type FaviconEvent = Parameters<typeof GET>[0];

function eventFor(
	domain: string | null,
	user: { id: string } | null = { id: "user-1" },
): FaviconEvent {
	const query = domain === null ? "" : `?domain=${encodeURIComponent(domain)}`;
	return {
		url: new URL(`http://localhost/api/favicon${query}`),
		request: new Request(`http://localhost/api/favicon${query}`),
		locals: { user },
	} as unknown as FaviconEvent;
}

const ICON_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

async function bodyText(response: Response): Promise<string> {
	return new TextDecoder().decode(await response.arrayBuffer());
}

describe("GET /api/favicon", () => {
	beforeEach(() => {
		resetUrlProvenanceForTests();
		fetchFaviconMock.mockReset();
		fetchFaviconMock.mockResolvedValue({
			kind: "image",
			bytes: ICON_BYTES,
			contentType: "image/png",
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("never calls out for a host no tool returned to this user: the globe, never cached", async () => {
		const response = await GET(eventFor("exfil-attempt.example"));

		expect(fetchFaviconMock).not.toHaveBeenCalled();
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/svg+xml");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await bodyText(response)).toBe(GLOBE_FALLBACK_SVG);
	});

	it("does not remember a refusal: the same host is served once a tool has returned it", async () => {
		const refused = await GET(eventFor("later-found.example"));
		expect(fetchFaviconMock).not.toHaveBeenCalled();
		expect(refused.headers.get("cache-control")).toBe("no-store");

		noteSourceUrls("user-1", ["https://later-found.example/article"]);
		const served = await GET(eventFor("later-found.example"));

		expect(fetchFaviconMock).toHaveBeenCalledTimes(1);
		expect(fetchFaviconMock.mock.calls[0]?.[0]).toBe("later-found.example");
		expect(served.headers.get("content-type")).toBe("image/png");
	});

	it("serves the icon of a host a tool returned, privately: the answer depends on who asks", async () => {
		noteSourceUrls("user-1", ["https://www.Source-Site.example/page"]);

		const response = await GET(eventFor("source-site.example"));

		expect(fetchFaviconMock).toHaveBeenCalledTimes(1);
		expect(fetchFaviconMock.mock.calls[0]?.[0]).toBe("source-site.example");
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/png");
		const cacheControl = response.headers.get("cache-control") ?? "";
		expect(cacheControl).toContain("private");
		expect(cacheControl).not.toContain("public");
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(ICON_BYTES);
	});

	it("asks the ledger with the host as the page would, with or without www and in any case", async () => {
		noteSourceUrls("user-1", ["https://news.example/a"]);

		await GET(eventFor("NEWS.example"));
		await GET(eventFor("www.news.example"));

		expect(fetchFaviconMock).toHaveBeenCalledTimes(2);
	});

	it("does not serve a host another user's tools returned", async () => {
		noteSourceUrls("user-2", ["https://theirs.example/a"]);

		const response = await GET(eventFor("theirs.example", { id: "user-1" }));

		expect(fetchFaviconMock).not.toHaveBeenCalled();
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("never calls out for what is not a public host name, even when a tool returned it", async () => {
		noteSourceUrls("user-1", [
			"http://169.254.169.254/latest/meta-data",
			"http://localhost:5173/x",
		]);

		for (const domain of [
			"169.254.169.254",
			"localhost",
			"[::1]",
			"example.com/path",
			"",
			null,
		]) {
			const response = await GET(eventFor(domain));
			expect(response.headers.get("cache-control"), String(domain)).toBe(
				"no-store",
			);
		}
		expect(fetchFaviconMock).not.toHaveBeenCalled();
	});

	it("answers a host whose icon could not be fetched with the globe, kept only privately and briefly", async () => {
		noteSourceUrls("user-1", ["https://no-icon.example/a"]);
		fetchFaviconMock.mockResolvedValue({ kind: "globe" });

		const response = await GET(eventFor("no-icon.example"));

		expect(response.headers.get("content-type")).toBe("image/svg+xml");
		expect(response.headers.get("cache-control")).toBe("private, max-age=300");
		expect(await bodyText(response)).toBe(GLOBE_FALLBACK_SVG);
	});

	it("is refused without a session", async () => {
		noteSourceUrls("user-1", ["https://source-site.example/a"]);

		await expect(
			GET(eventFor("source-site.example", null)),
		).rejects.toMatchObject({ status: 401 });
		expect(fetchFaviconMock).not.toHaveBeenCalled();
	});

	it("puts no host in any log line", async () => {
		const logs = [
			vi.spyOn(console, "log").mockImplementation(() => {}),
			vi.spyOn(console, "info").mockImplementation(() => {}),
			vi.spyOn(console, "warn").mockImplementation(() => {}),
			vi.spyOn(console, "error").mockImplementation(() => {}),
			vi.spyOn(console, "debug").mockImplementation(() => {}),
		];
		noteSourceUrls("user-1", ["https://logged-source.example/a"]);

		await GET(eventFor("logged-source.example"));
		await GET(eventFor("never-returned.example"));

		for (const log of logs) {
			expect(JSON.stringify(log.mock.calls)).not.toContain("example");
		}
	});
});
