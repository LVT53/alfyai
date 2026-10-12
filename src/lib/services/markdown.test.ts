import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
	faviconRouteUrl,
	imageThumbnailRouteUrl,
} from "$lib/shared/url-provenance";

vi.mock("shiki", () => ({
	createHighlighter: vi.fn().mockResolvedValue({
		codeToHtml: vi.fn().mockReturnValue("<pre><code>mocked</code></pre>"),
	}),
}));

vi.mock("jsdom", () => ({
	JSDOM: vi.fn().mockImplementation(() => ({
		window: {},
	})),
}));

vi.mock("dompurify", () => ({
	default: vi.fn().mockReturnValue({
		sanitize: vi.fn().mockImplementation((html: string) => html),
	}),
}));

// image_search's own results: the picture's address and Brave's resized copy of it.
const CAT = "https://example.com/cat.jpg";
const THUMB =
	"https://imgs.search.brave.com/Zq3s9x/rs:fit:500:0:0:0/g:ce/aHR0cHM6Ly9leGFtcGxlLmNvbS9jYXQuanBn";
const CAT_RESULT = { url: CAT, thumbnail: THUMB };
const EXAMPLE_HOSTS = new Set(["example.com"]);

describe("Markdown Rendering Service", () => {
	it("renderMarkdown is exported as a function", async () => {
		const mod = await import("./markdown");
		expect(typeof mod.renderMarkdown).toBe("function");
	});

	it("renderHighlightedText is exported as a function", async () => {
		const mod = await import("./markdown");
		expect(typeof mod.renderHighlightedText).toBe("function");
	});

	it("initHighlighter is exported as a function", async () => {
		const mod = await import("./markdown");
		expect(typeof mod.initHighlighter).toBe("function");
	});

	it("renders markdown links as new-tab external links", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(
			"[Source](https://example.com/page)",
			false,
		);

		expect(html).toContain('href="https://example.com/page"');
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noopener noreferrer external"');
	});

	it("can render external source links as compact labeled chips", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(
			"See [Example Source](https://example.com/page) for details.",
			false,
			{ compactExternalLinks: true, toolSourceHosts: EXAMPLE_HOSTS },
		);

		expect(html).toContain('class="source-link-chip"');
		expect(html).toContain(
			'aria-label="Open source: Example Source - https://example.com/page"',
		);
		expect(html).toContain(
			'class="source-link-chip__label">Example Source</span>',
		);
		expect(html).toContain('class="source-link-chip__favicon"');
		// Privacy (C1): the favicon must be served from the app's same-origin
		// /api/favicon proxy, never leaked to a third-party favicon service.
		expect(html).toContain('src="/api/favicon?domain=example.com"');
		expect(html).not.toContain("google.com");
		expect(html).toContain('alt=""');
		expect(html).toContain('class="source-link-chip__icon"');
		expect(html).not.toContain(">Example Source</a>");
	});

	describe("image loading skeleton (C4)", () => {
		it("wraps an embedded image in a loading skeleton frame", async () => {
			const mod = await import("./markdown");
			const html = await mod.renderMarkdown(`![a diagram](${CAT})`, false, {
				toolImages: [CAT_RESULT],
			});

			// The image is wrapped in a skeleton frame that starts in the loading
			// state, so a slow image reserves space + shimmers instead of shifting.
			expect(html).toContain(
				'class="markdown-image-frame markdown-image-frame--loading"',
			);
			expect(html).toContain('class="markdown-image"');
			expect(html).toContain(`src="${imageThumbnailRouteUrl(THUMB)}"`);
			expect(html).toContain('alt="a diagram"');
			// Lazy/async decoding hints stay on the image.
			expect(html).toContain('loading="lazy"');
		});
	});

	describe("sourceFaviconUrl (C1 — favicon privacy)", () => {
		it("routes through the same-origin /api/favicon proxy, never google.com", async () => {
			const { sourceFaviconUrl } = await import("./markdown");
			const url = sourceFaviconUrl("https://example.com/page", EXAMPLE_HOSTS);
			expect(url).toBe("/api/favicon?domain=example.com");
			expect(url).not.toContain("google.com");
		});

		it("strips a leading www. from the host (mirrors getFaviconUrl)", async () => {
			const { sourceFaviconUrl } = await import("./markdown");
			expect(
				sourceFaviconUrl("https://www.nytimes.com/x", new Set(["nytimes.com"])),
			).toBe("/api/favicon?domain=nytimes.com");
		});

		it("encodes non-ASCII / punycode-eligible hosts safely", async () => {
			const { sourceFaviconUrl } = await import("./markdown");
			const url = sourceFaviconUrl(
				"https://sub.example.co.uk/path?q=1",
				new Set(["sub.example.co.uk"]),
			);
			expect(url).toBe("/api/favicon?domain=sub.example.co.uk");
		});

		it("returns null on a non-web / unparseable href (contract preserved)", async () => {
			const { sourceFaviconUrl } = await import("./markdown");
			expect(sourceFaviconUrl("not a url", EXAMPLE_HOSTS)).toBeNull();
			expect(sourceFaviconUrl("javascript:alert(1)", EXAMPLE_HOSTS)).toBeNull();
			expect(sourceFaviconUrl("", EXAMPLE_HOSTS)).toBeNull();
		});

		it("asks for no favicon of a host no tool returned", async () => {
			const { sourceFaviconUrl } = await import("./markdown");
			const href = "https://secret-0123abcd.attacker.test/page";
			expect(sourceFaviconUrl(href, EXAMPLE_HOSTS)).toBeNull();
			expect(sourceFaviconUrl(href, new Set())).toBeNull();
			expect(sourceFaviconUrl(href, undefined)).toBeNull();
		});
	});

	it("renders compact source chips with a hidden globe favicon fallback", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(
			"See [Example Source](https://example.com/page) for details.",
			false,
			{ compactExternalLinks: true, toolSourceHosts: EXAMPLE_HOSTS },
		);

		expect(html).toContain('class="source-link-chip__favicon"');
		expect(html).toContain(
			'<span class="source-link-chip__favicon-fallback" aria-hidden="true" hidden=""></span>',
		);
		expect(html).toContain('class="source-link-chip__icon"');
		expect(html).not.toContain("onerror=");
	});

	it("renders inline compact source references as source link chips", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(
			"Alpha claim (S2).\n\nSources: [S2](https://example.com/source)",
			false,
			{ compactExternalLinks: true },
		);

		expect(html).toContain("Alpha claim ");
		expect(html).toContain('href="https://example.com/source"');
		expect(html).toContain('class="source-link-chip"');
		expect(html).toContain('class="source-link-chip__label">S2</span>');
		expect(html).not.toContain("(S2)");
	});

	it("can render inline source references from candidates derived from the full assistant message", async () => {
		const mod = await import("./markdown");
		const sourceReferences = await mod.collectSourceReferenceCandidates(
			"Alpha claim (S2).\n\n```txt\nnot a source [S2](https://wrong.example)\n```\n\nSources:\n- [S1](https://one.example)\n- [S2](https://two.example)",
		);
		const html = await mod.renderMarkdown("Alpha claim (S2).", false, {
			compactExternalLinks: true,
			sourceReferences,
		});

		expect(html).toContain('href="https://two.example"');
		expect(html).toContain('class="source-link-chip__label">S2</span>');
		expect(html).not.toContain("https://wrong.example");
		expect(html).not.toContain("(S2)");
	});

	it("derives inline source reference labels from compact source links", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(
			"Alpha claim (Policy memo).\n\nSources: [Policy memo](https://example.com/policy)",
			false,
			{ compactExternalLinks: true },
		);

		expect(html).toContain('href="https://example.com/policy"');
		expect(html).toContain(
			'class="source-link-chip__label">Policy memo</span>',
		);
		expect(html).not.toContain("(Policy memo)");
	});

	it("does not render inline source references inside code or existing links", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(
			"Inline code `(Policy memo)` and [Local (Policy memo)](./draft.md).\n\nSources: [Policy memo](https://example.com/policy)",
			false,
			{ compactExternalLinks: true },
		);

		expect(html.match(/class="source-link-chip"/g) ?? []).toHaveLength(1);
		expect(html).toContain("<code>(Policy memo)</code>");
		expect(html).toContain("Local (Policy memo)");
	});

	it("removes bare source markers when rendering compact source-link chips", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(
			"Claim one 【S5】 and claim two【S12】.\n\nSources: [Example Source](https://example.com/page)",
			false,
			{ compactExternalLinks: true },
		);

		expect(html).toContain("Claim one and claim two.");
		expect(html).not.toContain("【S5】");
		expect(html).not.toContain("【S12】");
		expect(html).toContain('class="source-link-chip"');
	});

	it("uses a domain label when compact source link text is only a URL", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(
			"See [https://www.example.com/page](https://www.example.com/page).",
			false,
			{ compactExternalLinks: true },
		);

		expect(html).toContain(
			'class="source-link-chip__label">example.com</span>',
		);
	});

	it("renders document frontmatter and Obsidian-style callouts while keeping local links non-navigating", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(
			`---\ntitle: Client Notes\ntags:\n  - planning\n---\n\n> [!NOTE] Decision\n> Keep this visible.\n\n[Local](./draft.md) [[Wiki Link]] ![[Embed.png]]`,
			false,
		);

		expect(html).toContain("markdown-frontmatter");
		expect(html).toContain("Client Notes");
		expect(html).toContain("markdown-callout");
		expect(html).toContain("Decision");
		expect(html).not.toContain('href="./draft.md"');
		expect(html).toContain("[[Wiki Link]]");
		expect(html).toContain("![[Embed.png]]");
	});

	it("renders common reading structures for Markdown documents", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(
			`# Title\n\n## Section\n\n- Bullet\n- [x] Done\n\n1. First\n\n| Name | Value |\n| --- | --- |\n| Alpha | 1 |`,
			false,
		);

		expect(html).toContain("<h1>Title</h1>");
		expect(html).toContain("<h2>Section</h2>");
		expect(html).toContain("<ul>");
		expect(html).toContain("<ol>");
		expect(html).toContain('type="checkbox"');
		expect(html).toContain("markdown-table-wrap");
		expect(html).toContain("<th>Name</th>");
		expect(html).toContain("<td>Alpha</td>");
	});

	it("preserves Shiki inline styles for fenced code in rendered Markdown", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(
			"```ts\nconst answer: number = 42;\n```",
			false,
		);

		expect(html).toContain("<pre");
		expect(html).toContain("style=");
		expect(html).toContain("answer");
	});

	it("renders shell scripts through the Bash highlighter", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderHighlightedText(
			"#!/usr/bin/env bash\necho ok",
			"bash",
			false,
		);

		expect(html).toContain("<pre");
		expect(html).toContain("style=");
		expect(html).toContain("echo");
	});

	// The Shiki success branch used to return its HTML straight to `{@html}`,
	// the one path in this module that skipped the sanitizer. These pin the
	// contract both ways: the sanitizer now runs over it, AND it takes nothing
	// away from a legitimately highlighted block.
	describe("highlighted code is sanitized (and survives sanitizing)", () => {
		async function highlight(code: string, lang: string, isDark = false) {
			const mod = await import("./markdown");
			await mod.initHighlighter();
			return mod.renderHighlightedText(code, lang, isDark);
		}

		it("keeps a normal highlighted block byte-identical to Shiki's own output", async () => {
			const mod = await import("./markdown");
			await mod.initHighlighter();
			const { sanitizeHtml } = await import("$lib/utils/html-sanitizer");

			const rendered = await mod.renderHighlightedText(
				"const answer = 42;\n",
				"ts",
				false,
			);

			// Sanitizing the rendered output again is a no-op: the string that
			// reaches the DOM is exactly what the sanitizer already blessed.
			expect(sanitizeHtml(rendered, { allowStyleAttributes: true })).toBe(
				rendered,
			);
			// And the markup the app's CSS keys off is all still there.
			expect(rendered).toMatch(/<pre class="shiki github-light"/);
			expect(rendered).toContain('tabindex="0"');
			expect(rendered).toContain("<code>");
			expect(rendered).toContain('<span class="line">');
			expect(rendered).toMatch(/<span style="color:#[0-9A-Fa-f]{6}">/);
			expect(rendered).toContain("background-color:");
			expect(rendered).toContain("answer");
		});

		it("carries the dark theme's container styles through the sanitizer", async () => {
			const rendered = await highlight("const a = 1;\n", "ts", true);

			expect(rendered).toMatch(/<pre class="shiki github-dark"/);
			expect(rendered).toContain("background-color:#24292e");
		});

		it("neutralizes markup inside highlighted code", async () => {
			const rendered = await highlight(
				'const x = "<img src=x onerror=alert(1)>";\n',
				"js",
			);

			// The `<img` never opens a tag — Shiki writes `&#x3C;` and DOMPurify
			// re-serializes it as `&lt;`; either way it is text, not markup.
			expect(rendered).not.toContain("<img");
			expect(rendered).toMatch(/&lt;img src=x onerror=alert\(1\)&gt;/);
		});

		it.each([
			'js" onmouseover="alert(1)',
			"<img src=x onerror=alert(1)>",
			"js onload=alert(1)",
			"../../etc/passwd",
		])("falls back to an escaped plain block for hostile fence info %j", async (lang) => {
			const rendered = await highlight("const a = 1;\n", lang);

			// Shiki has no such language, so this takes the catch branch —
			// which was already sanitized. Nothing from the info string may
			// reach the output as markup.
			expect(rendered).toBe("<pre><code>const a = 1;\n</code></pre>");
			expect(rendered).not.toContain("onmouseover");
			expect(rendered).not.toContain("onerror");
			expect(rendered).not.toContain("<img");
		});

		it("never lets the fence info string become an attribute", async () => {
			// The only externally-supplied string that reaches Shiki is the fence
			// language; the theme is a module constant. Shiki resolves the
			// language against its loaded set and interpolates only the THEME name
			// into the container's class, so an attacker-controlled language can
			// neither select a theme nor break out of an attribute.
			const rendered = await highlight("x\n", 'javascript" data-evil="1');

			expect(rendered).not.toContain("data-evil");
			expect(rendered).toBe("<pre><code>x\n</code></pre>");
		});

		it("sanitizes a highlighted block rendered inside a full document too", async () => {
			const mod = await import("./markdown");
			const html = await mod.renderMarkdown(
				'```js\nconst x = "<script>alert(1)</script>";\n```',
				false,
			);

			expect(html).toContain("shiki");
			expect(html).not.toContain("<script");
		});
	});

	it("wraps tables as a first-class block from the renderer (not a post-process)", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(
			"| Name | Value |\n| --- | --- |\n| Alpha | 1 |",
			false,
		);

		expect(html).toContain('class="markdown-table-wrap"');
		expect(html).toContain('class="markdown-table"');
		expect(html).toContain("<th>Name</th>");
		expect(html).toContain("<td>Alpha</td>");
		expect(html).toMatch(/<\/table>\s*<\/div>/);
	});
});

function parseHtml(html: string): HTMLElement {
	const root = document.createElement("div");
	root.innerHTML = html;
	return root;
}

describe("renderMarkdown: a reply's pictures are never requested from an address the model chose", () => {
	// The rule (docs/plans/exfil-channels): an address the browser requests without a
	// click comes from the user's words or a tool's result, never the model's. A
	// picture here is shown only when image_search returned it, and then from the app's
	// own thumbnail route; any other address is a link the reader may open, and is
	// never requested. Every case counts what the output would make a browser fetch.
	const requested = (html: string) =>
		Array.from(parseHtml(html).querySelectorAll("*")).flatMap((element) =>
			["src", "srcset", "poster", "background"].flatMap((attribute) => {
				const address = element.getAttribute(attribute);
				return address === null ? [] : [`${element.localName} ${address}`];
			}),
		);

	it("shows a picture an image_search call returned, from the app's thumbnail route and nowhere else", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(
			`![A cat](${CAT} "Cat title")`,
			false,
			{
				toolImages: [CAT_RESULT],
			},
		);

		const image = parseHtml(html).querySelector("img");
		expect(image?.getAttribute("src")).toBe(imageThumbnailRouteUrl(THUMB));
		expect(image?.getAttribute("alt")).toBe("A cat");
		expect(image?.getAttribute("title")).toBe("Cat title");
		expect(image?.classList.contains("markdown-image")).toBe(true);
		expect(html).toContain(
			'class="markdown-image-frame markdown-image-frame--loading"',
		);
		// Neither the picture's own address nor Brave's is written into the page.
		expect(html).not.toContain("https://");
		expect(requested(html)).toEqual([`img ${imageThumbnailRouteUrl(THUMB)}`]);
	});

	it("knows the picture by either address, and by the way a tool writes it, not the way the model does", async () => {
		const mod = await import("./markdown");
		for (const written of [
			CAT,
			THUMB,
			"http://www.example.com/cat.jpg#top",
			"HTTPS://EXAMPLE.COM/cat.jpg",
		]) {
			const html = await mod.renderMarkdown(`![A cat](${written})`, false, {
				toolImages: [CAT_RESULT],
			});
			expect(requested(html), written).toEqual([
				`img ${imageThumbnailRouteUrl(THUMB)}`,
			]);
		}
	});

	it("makes a link chip of any other address, never a request: a changed path, a query, a host, no results", async () => {
		const mod = await import("./markdown");
		for (const written of [
			"https://example.com/cat.jpg?d=SECRET",
			"https://example.com/cat.jpg/SECRET",
			"https://secret.example.com/cat.jpg",
			"https://example.org/cat.jpg",
			"https://imgs.search.brave.com/other/cat.jpg",
		]) {
			const html = await mod.renderMarkdown(`![A cat](${written})`, false, {
				toolImages: [CAT_RESULT],
			});
			expect(requested(html), written).toEqual([]);
			const chip = parseHtml(html).querySelector("a.source-link-chip--image");
			expect(chip?.getAttribute("href"), written).toBe(written);
		}
		const none = await mod.renderMarkdown(`![A cat](${CAT})`, false);
		expect(requested(none)).toEqual([]);
		expect(none).toContain("source-link-chip--image");
	});

	it("makes a chip of a result that has no thumbnail: there is nothing the app may fetch for it", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(`![A cat](${CAT})`, false, {
			toolImages: [{ url: CAT, thumbnail: null }],
		});
		expect(requested(html)).toEqual([]);
		expect(html).toContain("source-link-chip--image");
	});

	it("says what the chip is: the words or the host, the host, an external link, and that the picture was not loaded", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(
			"![A  cat on\ta sofa](https://cats.example.com/a/b.jpg?x=1&y=2)",
			false,
		);
		const chip = parseHtml(html).querySelector<HTMLAnchorElement>(
			"a.source-link-chip.source-link-chip--image",
		);

		expect(chip?.getAttribute("href")).toBe(
			"https://cats.example.com/a/b.jpg?x=1&y=2",
		);
		expect(chip?.getAttribute("target")).toBe("_blank");
		expect(chip?.getAttribute("rel")).toBe("noopener noreferrer external");
		expect(chip?.querySelector(".source-link-chip__label")?.textContent).toBe(
			"A cat on a sofa",
		);
		expect(chip?.querySelector(".source-link-chip__host")?.textContent).toBe(
			"cats.example.com",
		);
		expect(
			chip
				?.querySelector(".source-link-chip__image-icon")
				?.getAttribute("aria-hidden"),
		).toBe("true");
		expect(chip?.querySelector(".source-link-chip__icon")).not.toBeNull();
		// The sentence a reader and a screen reader get, with the words in it.
		const notice =
			"Image not loaded: A cat on a sofa. Open the link to see it.";
		expect(chip?.getAttribute("title")).toBe(notice);
		expect(chip?.getAttribute("aria-label")).toBe(notice);
		expect(chip?.querySelector("img")).toBeNull();
	});

	it("shows the host once when the picture has no words, and takes the sentence from the caller", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(
			"![](https://www.cats.example.com/b.jpg)",
			false,
			{
				imageNotLoadedLabel: (name) => `A kép nem töltődött be: ${name}.`,
			},
		);
		const chip = parseHtml(html).querySelector("a.source-link-chip--image");

		expect(chip?.querySelector(".source-link-chip__label")?.textContent).toBe(
			"cats.example.com",
		);
		expect(chip?.querySelector(".source-link-chip__host")).toBeNull();
		expect(chip?.getAttribute("title")).toBe(
			"A kép nem töltődött be: cats.example.com.",
		);
		expect(chip?.getAttribute("aria-label")).toBe(chip?.getAttribute("title"));
	});

	it("keeps the model's words out of markup: the words and the sentence are text", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(
			'![<img src=x onerror=alert(1)> "q"](https://cats.example.com/b.jpg)',
			false,
		);
		const root = parseHtml(html);
		expect(root.querySelector("img, [onerror]")).toBeNull();
		expect(root.querySelectorAll("a")).toHaveLength(1);
		expect(root.querySelector(".source-link-chip__label")?.textContent).toBe(
			'<img src=x onerror=alert(1)> "q"',
		);
	});

	it("gives only the words of an address that is not a web address, and no link", async () => {
		const mod = await import("./markdown");
		for (const written of [
			"./cat.png",
			"/api/favicon?domain=secret.example",
			"//x.test/cat.png",
			"cat.png",
			"javascript:alert(1)",
			"ftp://example.com/cat.png",
			"https://user:pw@example.com/cat.png",
			"data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
		]) {
			const html = await mod.renderMarkdown(`![A cat](${written})`, false, {
				toolImages: [CAT_RESULT],
			});
			expect(html, written).toBe("<p>A cat</p>\n");
		}
	});

	it("keeps the app's own thumbnail of a connected photo and a picture that holds its own bytes", async () => {
		const mod = await import("./markdown");
		const photo = "/api/connections/immich/thumbnail/0a1b2c3d-4e5f";
		const bytes = "data:image/png;base64,iVBORw0KGgo=";
		const html = await mod.renderMarkdown(
			`![Photo](${photo})\n\n![Pixel](${bytes})`,
			false,
		);
		expect(requested(html)).toEqual([`img ${photo}`, `img ${bytes}`]);
	});

	it("is a link chip, and not a link inside a link, when a picture is the text of a link", async () => {
		const mod = await import("./markdown");
		for (const options of [{}, { compactExternalLinks: true }]) {
			const html = await mod.renderMarkdown(
				"[![A cat](https://cats.example.com/b.jpg)](https://example.com/page)",
				false,
				options,
			);
			const root = parseHtml(html);
			expect(root.querySelectorAll("a"), JSON.stringify(options)).toHaveLength(
				1,
			);
			expect(root.querySelector("a")?.getAttribute("href")).toBe(
				"https://example.com/page",
			);
			expect(root.textContent).toContain("A cat");
			expect(requested(html)).toEqual([]);
		}
	});

	it("gives raw HTML nothing the renderer would not write itself", async () => {
		const mod = await import("./markdown");
		const route = imageThumbnailRouteUrl(THUMB);
		const other = imageThumbnailRouteUrl(
			"https://imgs.search.brave.com/Zq3s9x/other.jpg",
		);
		const html = await mod.renderMarkdown(
			[
				`<img src="${CAT}">`,
				`<img src="${THUMB}">`,
				`<img src="${other}">`,
				`<img src="/api/favicon?domain=secret.attacker.test">`,
				`<img src="${route}" srcset="${route} 1x, https://x.test/b.png 2x">`,
				`<picture><source srcset="${CAT}"><img src="${CAT}"></picture>`,
				`<video poster="${CAT}" src="${CAT}" controls></video>`,
				`<table background="${CAT}"><tr><td background="${CAT}">x</td></tr></table>`,
			].join("\n\n"),
			false,
			{ toolImages: [CAT_RESULT] },
		);
		// The one thumbnail address a tool returned is what the renderer writes itself;
		// writing it as HTML gains nothing and loses nothing. All else is gone.
		expect(requested(html)).toEqual([`img ${route}`]);
		expect(html).not.toMatch(/example\.com|x\.test|attacker/i);
	});
});

describe("renderMarkdown: a source chip asks for a favicon only of a host a tool returned", () => {
	it("shows the globe at once, with no image, for a host no tool returned", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(
			"See [Docs](https://secret-0123abcd.attacker.test/docs?d=SECRET).",
			false,
			{ compactExternalLinks: true, toolSourceHosts: EXAMPLE_HOSTS },
		);
		const root = parseHtml(html);
		const chip = root.querySelector("a.source-link-chip");

		expect(chip).not.toBeNull();
		expect(root.querySelector("img")).toBeNull();
		expect(html).not.toContain("/api/favicon");
		const globe = chip?.querySelector(".source-link-chip__favicon-fallback");
		expect(globe).not.toBeNull();
		expect(globe?.hasAttribute("hidden")).toBe(false);
	});

	it("asks the app's proxy for the favicon of a host a tool returned, www or not", async () => {
		const mod = await import("./markdown");
		for (const href of [
			"https://example.com/page",
			"https://www.example.com/page",
			"http://EXAMPLE.com:8080/page",
		]) {
			const html = await mod.renderMarkdown(`See [Docs](${href}).`, false, {
				compactExternalLinks: true,
				toolSourceHosts: EXAMPLE_HOSTS,
			});
			const image = parseHtml(html).querySelector("img");
			expect(image?.getAttribute("src"), href).toBe(
				faviconRouteUrl("example.com"),
			);
		}
	});

	it("shows no favicon when no tool results are passed at all (a preview, a history page)", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(
			"See [Docs](https://example.com/page).",
			false,
			{ compactExternalLinks: true },
		);
		expect(parseHtml(html).querySelector("img")).toBeNull();
		expect(html).toContain("source-link-chip__favicon-fallback");
	});

	it("keeps a favicon in raw HTML only where the renderer would write it", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(
			`<img src="${faviconRouteUrl("example.com")}">\n\n<img src="${faviconRouteUrl("secret.attacker.test")}">`,
			false,
			{ toolSourceHosts: EXAMPLE_HOSTS },
		);
		const sources = Array.from(
			parseHtml(html).querySelectorAll("img"),
			(image) => image.getAttribute("src"),
		);
		expect(sources).toEqual([faviconRouteUrl("example.com")]);
	});
});

describe("renderMarkdown keeps a reply's markup inert", () => {
	// A reply can have come from a page the model read. Its raw HTML may not ask for a
	// password, cover the page or borrow the app's utility classes; everything the
	// renderer writes itself must come through the same gate exactly as it did.
	it("drops a form, a fixed overlay and the app's utility classes from raw HTML", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(
			[
				"Hello there.",
				"",
				'<form action="https://x.test/steal" method="post"><input type="password" name="pw"><button>Sign in</button></form>',
				"",
				'<div style="position:fixed;inset:0;z-index:9999;background:red;color:red">cover</div>',
				"",
				'<div class="fixed inset-0 z-50 bg-black">cover two</div>',
				"",
				'<dialog open>modal</dialog> <span popover>pop</span> <span popovertarget="x">open</span>',
			].join("\n"),
			false,
		);

		expect(html).not.toMatch(
			/<form|<input|<button|<dialog|popover|position|fixed|inset|z-50|z-index|x\.test/i,
		);
		expect(html).toContain("Hello there.");
		for (const text of ["cover", "cover two", "modal", "pop"]) {
			expect(html).toContain(text);
		}
		// What survives of the styled box is the one property it may carry.
		expect(html).toContain('<div style="color:red">cover</div>');
	});

	it("keeps every class and style the renderer writes itself", async () => {
		const mod = await import("./markdown");
		await mod.initHighlighter();
		const html = await mod.renderMarkdown(
			[
				"---",
				"title: Client Notes",
				"---",
				"",
				"> [!WARNING] Careful",
				"> Mind the gap.",
				"",
				"| Name | Value |",
				"| --- | --- |",
				"| Alpha | 1 |",
				"",
				"- [x] Done",
				"- [ ] Open",
				"",
				"<details open><summary>More</summary>body</details>",
				"",
				"```ts",
				"const answer: number = 42;",
				"```",
				"",
				"See [Example Source](https://example.com/page).",
			].join("\n"),
			false,
			{ compactExternalLinks: true },
		);

		for (const kept of [
			'class="markdown-frontmatter"',
			'class="markdown-frontmatter-row"',
			'class="markdown-callout markdown-callout-warning"',
			'class="markdown-callout-title"',
			'class="markdown-callout-body"',
			'class="markdown-table-wrap"',
			'class="markdown-table"',
			'<input checked="" disabled="" type="checkbox">',
			'<input disabled="" type="checkbox">',
			"<details open=",
			"<summary>More</summary>",
			'class="shiki github-light"',
			'<span class="line">',
			'class="source-link-chip"',
			'class="source-link-chip__label"',
			'class="source-link-chip__icon"',
		]) {
			expect(html, kept).toContain(kept);
		}
		// Shiki's colours are what its styles are for.
		expect(html).toMatch(/<span style="color:#[0-9A-Fa-f]{6}">/);
		expect(html).toMatch(
			/<pre class="shiki github-light" style="[^"]*background-color:#/,
		);
	});

	it("lists every class the renderer's own source writes, so none is stripped from its own markup", async () => {
		const mod = await import("./markdown");
		// The code only: a comment may quote a class attribute while it explains one.
		const source = readFileSync(
			`${process.cwd()}/src/lib/services/markdown.ts`,
			"utf-8",
		).replace(/^\s*\/\/.*$/gm, "");
		const written = new Set<string>();
		for (const match of source.matchAll(/class="([^"]+)"/g)) {
			for (const name of match[1].split(/\s+/)) {
				// A name built from the model's word (`markdown-callout-${type}`) is the
				// callout's, and has its own pattern.
				if (!name.includes("$")) written.add(name);
			}
		}
		expect(written.size).toBeGreaterThan(10);
		for (const name of written) {
			const html = await mod.renderMarkdown(
				`<div class="${name}">x</div>`,
				false,
			);
			expect(html, name).toContain(`class="${name}"`);
		}
	});

	it("keeps a callout type's own class and nothing a reply could borrow in it", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(
			'> [!tip] Hint\n> Try it.\n\n<aside class="markdown-callout-x fixed inset-0">y</aside>',
			false,
		);
		expect(html).toContain("markdown-callout markdown-callout-tip");
		expect(html).toContain('class="markdown-callout-x"');
		expect(html).not.toMatch(/fixed|inset/);
	});

	it("is the same for a checklist item's inline markdown", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderInlineMarkdown(
			'buy <button>now</button> <span class="fixed inset-0" style="position:fixed">milk</span>',
			false,
		);
		expect(html).not.toMatch(/<button|fixed|inset|position|style=|class=/i);
		expect(html).toContain("now");
		expect(html).toContain("milk");
	});
});

describe("loadMarkdownBlocks (chat block model)", () => {
	it("produces typed blocks for a mixed document in source order", async () => {
		const mod = await import("./markdown");
		const blocks = await mod.loadMarkdownBlocks(
			"intro\n\n```js\ncode();\n```\n\n- [ ] a\n- [x] b\n\n| A |\n| - |\n| 1 |",
		);

		expect(blocks.map((b) => b.kind)).toEqual([
			"html",
			"code",
			"checklist",
			"table",
		]);
	});

	it("strips a leading [Translation unavailable] marker before splitting", async () => {
		const mod = await import("./markdown");
		const blocks = await mod.loadMarkdownBlocks(
			"[Translation unavailable] plain answer",
		);

		expect(blocks).toHaveLength(1);
		expect(blocks[0].kind).toBe("html");
		expect(blocks[0].raw).not.toContain("[Translation unavailable]");
		expect(blocks[0].raw).toContain("plain answer");
	});

	it("exposes checklist items with their checked/task state", async () => {
		const mod = await import("./markdown");
		const blocks = await mod.loadMarkdownBlocks("- [ ] todo\n- [x] done");
		const [block] = blocks;

		expect(block.kind).toBe("checklist");
		if (block.kind !== "checklist") throw new Error("expected checklist");
		expect(block.items).toEqual([
			{ checked: false, task: true, text: "todo" },
			{ checked: true, task: true, text: "done" },
		]);
	});

	it("rescues a checklist the model wrapped in a bare code fence (no `- ` markers)", async () => {
		const mod = await import("./markdown");
		// The exact failure mode seen in production: bare ``` fence, `[ ]` items
		// with no list marker. It must become an interactive checklist, not code.
		const blocks = await mod.loadMarkdownBlocks(
			"```\n[ ] Confirm the flight time\n[x] Book the coach\n[ ] Pack the bags\n```",
		);

		expect(blocks.map((b) => b.kind)).toEqual(["checklist"]);
		const [block] = blocks;
		if (block.kind !== "checklist") throw new Error("expected checklist");
		expect(block.items).toEqual([
			{ checked: false, task: true, text: "Confirm the flight time" },
			{ checked: true, task: true, text: "Book the coach" },
			{ checked: false, task: true, text: "Pack the bags" },
		]);
	});

	it("rescues an INDENTED fenced checklist into real checkboxes, not indented code", async () => {
		const mod = await import("./markdown");
		// A whole checklist indented 4 spaces inside the fence: the normalizer must
		// dedent it, or the injected `- [ ]` markers would re-lex as a code block.
		const blocks = await mod.loadMarkdownBlocks(
			"```\n    [ ] Confirm the flight\n    [ ] Check in\n    [ ] Drop bags\n```",
		);

		expect(blocks.map((b) => b.kind)).toEqual(["checklist"]);
		const [block] = blocks;
		if (block.kind !== "checklist") throw new Error("expected checklist");
		expect(block.items.map((item) => item.text)).toEqual([
			"Confirm the flight",
			"Check in",
			"Drop bags",
		]);
	});

	it("rescues a fenced checklist whose items are indented under a flush label", async () => {
		const mod = await import("./markdown");
		const blocks = await mod.loadMarkdownBlocks(
			"```\nChecklist:\n    [ ] a\n    [ ] b\n```",
		);

		expect(blocks.map((b) => b.kind)).toEqual(["html", "checklist"]);
	});

	it("rescues a multi-section fenced checklist, keeping section labels as prose", async () => {
		const mod = await import("./markdown");
		const blocks = await mod.loadMarkdownBlocks(
			"```\nBefore you fly\n[ ] Confirm the flight\n[ ] Check in\n\nAt the airport\n[ ] Drop bags\n```",
		);

		// Labels become prose; each checkbox run becomes its own interactive list.
		expect(blocks.map((b) => b.kind)).toEqual([
			"html",
			"checklist",
			"html",
			"checklist",
		]);
	});

	it("leaves a genuine code fence untouched", async () => {
		const mod = await import("./markdown");
		const blocks = await mod.loadMarkdownBlocks(
			"```js\nconst x = arr[0];\nif (x) run();\nreturn x;\n```",
		);

		expect(blocks.map((b) => b.kind)).toEqual(["code"]);
	});

	it("does not rescue a fence tagged as markdown source", async () => {
		const mod = await import("./markdown");
		const blocks = await mod.loadMarkdownBlocks(
			"```markdown\n[ ] one\n[ ] two\n```",
		);

		expect(blocks.map((b) => b.kind)).toEqual(["code"]);
	});

	it("does not rescue an unterminated (streaming) fence mid-stream", async () => {
		const mod = await import("./markdown");
		const blocks = await mod.loadMarkdownBlocks("```\n[ ] one\n[ ] two");

		expect(blocks.map((b) => b.kind)).toEqual(["code"]);
	});
});

describe("renderInlineMarkdown (checklist item bodies)", () => {
	it("renders inline emphasis without wrapping block tags", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderInlineMarkdown("buy **milk**", false);

		expect(html).toContain("<strong>milk</strong>");
		expect(html).not.toContain("<p>");
	});

	it("renders inline links as external new-tab links", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderInlineMarkdown(
			"call [bob](https://example.com)",
			false,
		);

		expect(html).toContain('href="https://example.com"');
		expect(html).toContain('target="_blank"');
	});
});
