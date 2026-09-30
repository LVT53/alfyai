import { describe, expect, it } from "vitest";
import { isHttpSourceUrl, isPhotoProxyPath } from "./block-urls";

// The two address rules a board holds to. A photo is loaded by the browser on
// its own (an <img> is a request nobody clicked), and a source is a link the
// reader may follow: neither may be an address a model or a stored board picked
// from outside what the app itself serves or what the web search returned.

/** Resolves an address the way a browser page served from the app does. */
const APP = "https://app.example";
const resolvedOrigin = (value: string): string => new URL(value, APP).origin;

describe("isPhotoProxyPath", () => {
	it("accepts the app's own thumbnail proxy, with and without a connection", () => {
		for (const value of [
			"/api/connections/immich/thumbnail/asset-1",
			"/api/connections/immich/thumbnail/3f2a9c1e-8d4b-4b8e-9a52-7c1d0e6f5a11",
			"/api/connections/immich/thumbnail/asset_1?connectionId=c1",
			"/api/connections/immich/thumbnail/asset-1?connectionId=3f2a9c1e-8d4b-4b8e-9a52-7c1d0e6f5a11",
			`/api/connections/immich/thumbnail/asset-1?connectionId=${encodeURIComponent("a b")}`,
		]) {
			expect(isPhotoProxyPath(value), value).toBe(true);
			expect(resolvedOrigin(value), value).toBe(APP);
		}
	});

	it("refuses an address from outside the app, in every shape a browser would follow", () => {
		for (const value of [
			"https://evil.example/p.png?d=secret",
			"http://evil.example/p.png",
			"//evil.example/p.png",
			"javascript:alert(1)",
			"data:image/png;base64,AAAA",
			"blob:https://app.example/1234",
			"file:///etc/passwd",
			"evil.example/p.png",
			"",
		]) {
			expect(isPhotoProxyPath(value), value).toBe(false);
		}
	});

	it("refuses the paths the URL parser turns into another origin: a backslash, a tab or a line break after the first slash", () => {
		// None of these is caught by "starts with one slash": the parser reads a
		// backslash as a slash and drops tabs and line breaks, so each of them
		// resolves to evil.example.
		for (const value of [
			"/\\evil.example/p.png",
			"/\t/evil.example/p.png",
			"/\n/evil.example/p.png",
			"/\r/evil.example/p.png",
			"/\\/evil.example",
		]) {
			// The premise: each of these really is another origin once resolved.
			expect(resolvedOrigin(value), JSON.stringify(value)).not.toBe(APP);
			expect(isPhotoProxyPath(value), JSON.stringify(value)).toBe(false);
		}
		// A backslash inside the proxy's own path is read as a slash too.
		expect(
			isPhotoProxyPath("/api/connections/immich/thumbnail/a\\..\\..\\evil"),
		).toBe(false);
	});

	it("refuses any path of the app that is not the thumbnail proxy, so a board cannot make the browser call another route on its own", () => {
		for (const value of [
			"/api/auth/logout",
			"/api/conversations/abc",
			"/api/chat/files/f1/download",
			"/api/connections/immich/thumbnail/",
			"/api/connections/immich/thumbnail/../../auth/logout",
			"/api/connections/immich/thumbnail/a/b",
			"/api/connections/immich/thumbnail/a%2f..%2fb",
			"/api/connections/immich/thumbnail/a.b",
			"/api/connections/immich/thumbnail/asset-1#fragment",
			"/api/connections/immich/thumbnail/asset-1?other=1",
			"/api/connections/immich/thumbnail/asset-1?connectionId=c1&x=y",
			"/api/connections/immich/thumbnail/asset-1?connectionId=",
			"/api/connections/immich/thumbnail/asset-1 ",
			" /api/connections/immich/thumbnail/asset-1",
			"/api/connections/immich/thumbnail/asset-1\n",
			"/photos/a.jpg",
			"/",
		]) {
			expect(isPhotoProxyPath(value), JSON.stringify(value)).toBe(false);
		}
	});

	it("refuses what is not text, and an id no route would accept", () => {
		for (const value of [null, undefined, 42, {}, ["/api/x"]]) {
			expect(isPhotoProxyPath(value)).toBe(false);
		}
		const id = "a".repeat(201);
		expect(isPhotoProxyPath(`/api/connections/immich/thumbnail/${id}`)).toBe(
			false,
		);
		expect(
			isPhotoProxyPath(`/api/connections/immich/thumbnail/${"a".repeat(200)}`),
		).toBe(true);
	});
});

describe("isHttpSourceUrl", () => {
	it("accepts a web address, whatever the case of its scheme", () => {
		for (const value of [
			"https://example.com",
			"http://example.com/a?b=c#d",
			"HTTPS://EXAMPLE.COM/PATH",
			"https://例え.jp/パス",
			"https://user:pw@example.com:8443/x",
		]) {
			expect(isHttpSourceUrl(value), value).toBe(true);
		}
	});

	it("refuses every other scheme and every address that only looks like one", () => {
		for (const value of [
			"javascript:alert(1)",
			"JaVaScRiPt:alert(1)",
			"data:text/html,<script>alert(1)</script>",
			"vbscript:msgbox(1)",
			"file:///etc/passwd",
			"ftp://example.com/x",
			"//example.com/x",
			"/relative/path",
			"example.com",
			"https:example.com",
			"https:/example.com",
			"https:\\\\example.com",
			"https://",
			"http://\u0000",
			" https://example.com",
			"https://example.com/ with space",
			"https://example.com/\nnewline",
			"",
		]) {
			expect(isHttpSourceUrl(value), JSON.stringify(value)).toBe(false);
		}
	});

	it("refuses what is not text and an address too long to be a link a reader would follow", () => {
		for (const value of [null, undefined, 42, {}]) {
			expect(isHttpSourceUrl(value)).toBe(false);
		}
		expect(isHttpSourceUrl(`https://example.com/${"a".repeat(2_100)}`)).toBe(
			false,
		);
	});
});
