import { describe, expect, it } from "vitest";
import type { ThinkingSegment } from "$lib/server/services/messages-types";
import {
	extractUrls,
	extractUrlsFromValue,
	faviconRouteUrl,
	imageThumbnailRouteUrl,
	isBraveThumbnailUrl,
	provenanceKey,
	readFaviconRouteUrl,
	readImageThumbnailRouteUrl,
	sourceHostOf,
	toolImages,
	toolSourceHosts,
} from "./url-provenance";

// The vocabulary the provenance rule compares in: an address the app requests
// on its own must come from the user's words or a tool's result. These cases pin
// what counts as the same address, and what a message's tools returned.

const THUMB =
	"https://imgs.search.brave.com/Zq3s9x/rs:fit:500:0:0:0/g:ce/aHR0cHM6Ly9leGFtcGxlLmNvbS9jYXQuanBn";

function toolCall(
	name: string,
	candidates: Array<{ url?: string | null; metadata?: Record<string, string> }>,
	extra: Partial<Extract<ThinkingSegment, { type: "tool_call" }>> = {},
): ThinkingSegment {
	return {
		type: "tool_call",
		name,
		input: {},
		status: "done",
		candidates: candidates.map((candidate, index) => ({
			id: `c${index}`,
			title: `Result ${index}`,
			sourceType: "web" as const,
			...candidate,
		})),
		...extra,
	};
}

describe("provenanceKey", () => {
	it("names the same page the same way whatever the scheme, case, www or fragment", () => {
		const key = provenanceKey("https://example.com/Page?q=1");
		for (const same of [
			"http://example.com/Page?q=1",
			"https://EXAMPLE.com/Page?q=1",
			"https://www.example.com/Page?q=1",
			"https://example.com:443/Page?q=1",
			"https://example.com/Page?q=1#section",
			"  https://example.com/Page?q=1  ",
		]) {
			expect(provenanceKey(same), same).toBe(key);
		}
		expect(provenanceKey("https://example.com")).toBe(
			provenanceKey("https://example.com/"),
		);
	});

	it("keeps the path and query exact, so nothing can be added to an address", () => {
		const key = provenanceKey("https://example.com/page?q=1");
		for (const different of [
			"https://example.com/page?q=1&d=secret",
			"https://example.com/page/secret",
			"https://example.com/Page?q=1",
			"https://example.com/page?q=2",
			"https://secret.example.com/page?q=1",
			"https://example.com:8443/page?q=1",
		]) {
			expect(provenanceKey(different), different).not.toBe(key);
		}
	});

	it("reads a non-ASCII host and path the way the browser sends them", () => {
		expect(provenanceKey("https://bücher.example/café")).toBe(
			provenanceKey("https://xn--bcher-kva.example/caf%C3%A9"),
		);
	});

	it("refuses anything that is not an absolute http(s) address without credentials", () => {
		for (const value of [
			"",
			"example.com/page",
			"/api/favicon?domain=example.com",
			"//example.com/page",
			"https:/example.com/page",
			"https:\\\\example.com/page",
			"javascript:alert(1)",
			"data:image/png;base64,AAAA",
			"ftp://example.com/file",
			"https://user:pass@example.com/",
			"https://user@example.com/",
			`https://example.com/${"a".repeat(2_100)}`,
			42,
			null,
		]) {
			expect(provenanceKey(value), String(value).slice(0, 60)).toBeNull();
		}
	});
});

describe("sourceHostOf", () => {
	it("is the favicon proxy's host: lowercase, without a leading www", () => {
		expect(sourceHostOf("https://WWW.Example.com/a")).toBe("example.com");
		expect(sourceHostOf("http://docs.example.com:8080/a")).toBe(
			"docs.example.com",
		);
		expect(sourceHostOf("not a url")).toBeNull();
	});
});

describe("extractUrls", () => {
	it("finds absolute addresses in prose without the punctuation around them", () => {
		expect(
			extractUrls(
				"See https://example.com/a, then (https://example.org/b). Done: https://example.net/c!",
			),
		).toEqual([
			"https://example.com/a",
			"https://example.org/b",
			"https://example.net/c",
		]);
	});

	it("reads a Markdown link and keeps a bracket the address opened itself", () => {
		expect(
			extractUrls(
				"[Foo](https://en.wikipedia.org/wiki/Foo_(bar)) and [x](https://x.example/y)",
			),
		).toEqual([
			"https://en.wikipedia.org/wiki/Foo_(bar)",
			"https://x.example/y",
		]);
		expect(extractUrls("[https://a.example/](https://a.example/)")).toEqual([
			"https://a.example/",
		]);
	});

	it("reads bare domains only when asked, and never an email address", () => {
		const text =
			"go to example.com/page or www.example.org, mail me@example.net";
		expect(extractUrls(text)).toEqual([]);
		expect(extractUrls(text, { bareDomains: true })).toEqual([
			"https://example.com/page",
			"https://www.example.org",
		]);
	});

	it("does not read an absolute address's host or path a second time as a bare domain", () => {
		expect(
			extractUrls("https://example.com/docs.example.org", {
				bareDomains: true,
			}),
		).toEqual(["https://example.com/docs.example.org"]);
	});

	it("also reads an HTML-escaped ampersand as a plain one", () => {
		expect(extractUrls("https://example.com/?a=1&amp;b=2")).toEqual([
			"https://example.com/?a=1&amp;b=2",
			"https://example.com/?a=1&b=2",
		]);
	});

	it("lists each address once and stops at the limit", () => {
		const text = Array.from(
			{ length: 20 },
			(_, index) => `https://example.com/${index % 5}`,
		).join(" ");
		expect(extractUrls(text)).toHaveLength(5);
		expect(extractUrls(text, { limit: 3 })).toHaveLength(3);
	});
});

describe("extractUrlsFromValue", () => {
	it("walks a payload's strings, nested in arrays and objects", () => {
		expect(
			extractUrlsFromValue({
				sources: [
					{ url: "https://a.example/1" },
					{ url: "https://b.example/2" },
				],
				answerBriefMarkdown: "Read [this](https://c.example/3).",
				count: 3,
				ok: true,
			}),
		).toEqual([
			"https://a.example/1",
			"https://b.example/2",
			"https://c.example/3",
		]);
	});

	it("is bounded in count and depth", () => {
		const many = Array.from(
			{ length: 50 },
			(_, index) => `https://example.com/${index}`,
		);
		expect(extractUrlsFromValue(many, 10)).toHaveLength(10);
		let deep: unknown = "https://deep.example/";
		for (let level = 0; level < 40; level += 1) deep = { next: deep };
		expect(extractUrlsFromValue(deep)).toEqual([]);
	});
});

describe("isBraveThumbnailUrl", () => {
	it("accepts Brave's image proxy over https only", () => {
		expect(isBraveThumbnailUrl(THUMB)).toBe(true);
		for (const value of [
			THUMB.replace("https:", "http:"),
			"https://imgs.search.brave.com.evil.example/x",
			"https://evil.example/imgs.search.brave.com/x",
			"https://imgs.search.brave.com:8443/x",
			"https://user@imgs.search.brave.com/x",
			"https://search.brave.com/images/x",
		]) {
			expect(isBraveThumbnailUrl(value), value).toBe(false);
		}
	});
});

describe("toolImages", () => {
	it("reads image_search's results, with the Brave thumbnail when there is one", () => {
		expect(
			toolImages([
				toolCall("image_search", [
					{
						url: "https://example.com/cat.jpg",
						metadata: { thumbnail: THUMB },
					},
					{ url: "https://example.com/dog.jpg" },
					{
						url: "https://example.com/owl.jpg",
						metadata: { thumbnail: "https://evil.example/owl.jpg" },
					},
				]),
			]),
		).toEqual([
			{ url: "https://example.com/cat.jpg", thumbnail: THUMB },
			{ url: "https://example.com/dog.jpg", thumbnail: null },
			{ url: "https://example.com/owl.jpg", thumbnail: null },
		]);
	});

	it("reads nothing from another tool, a running call, a bad address or no calls", () => {
		expect(
			toolImages([
				toolCall("research_web", [{ url: "https://example.com/cat.jpg" }]),
				toolCall("image_search", [{ url: "https://example.com/x.jpg" }], {
					status: "running",
				}),
				toolCall("image_search", [
					{ url: "javascript:alert(1)" },
					{ url: null },
				]),
				{ type: "text", content: "https://example.com/y.jpg" },
			]),
		).toEqual([]);
		expect(toolImages(undefined)).toEqual([]);
	});
});

describe("toolSourceHosts", () => {
	it("names the hosts of every tool's results and never of a call's input", () => {
		const hosts = toolSourceHosts([
			toolCall("research_web", [
				{ url: "https://www.example.com/a" },
				{ url: "https://docs.example.org/b" },
			]),
			toolCall("fetch_url", [], {
				input: { urls: ["https://secret.evil.example/"] },
			}),
			toolCall("calendar", [{ url: "" }, { url: null }]),
		]);
		expect([...hosts].sort()).toEqual(["docs.example.org", "example.com"]);
	});
});

describe("the app's own route addresses", () => {
	it("reads back exactly the thumbnail address it writes", () => {
		const src = imageThumbnailRouteUrl(THUMB);
		expect(readImageThumbnailRouteUrl(src)).toBe(THUMB);
		for (const value of [
			`${src}&extra=1`,
			`${src}#x`,
			`https://evil.example${src}`,
			`//evil.example${src}`,
			src.replace(
				"/api/image-search/thumbnail",
				"/api/image-search/thumbnail/x",
			),
			imageThumbnailRouteUrl("https://evil.example/cat.jpg"),
			"/api/image-search/thumbnail",
			null,
		]) {
			expect(readImageThumbnailRouteUrl(value), String(value)).toBeNull();
		}
	});

	it("reads back exactly the favicon address it writes", () => {
		expect(readFaviconRouteUrl(faviconRouteUrl("example.com"))).toBe(
			"example.com",
		);
		for (const value of [
			"/api/favicon?domain=example.com&x=1",
			"/api/favicon?other=example.com",
			"https://evil.example/api/favicon?domain=example.com",
			"/api/favicon/x?domain=example.com",
		]) {
			expect(readFaviconRouteUrl(value), value).toBeNull();
		}
	});
});
