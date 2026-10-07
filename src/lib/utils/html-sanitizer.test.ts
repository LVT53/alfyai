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
