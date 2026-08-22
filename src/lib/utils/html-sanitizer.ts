import DOMPurify from "isomorphic-dompurify";

// Neutralize outbound/networked references inside a CSS string. DOMPurify passes
// <style> element CSS text (and, with the SVG profile, `style` attribute values)
// through largely uninspected, so a prompt-injected mermaid diagram's themeCSS
// could smuggle a CSS beacon / defacement vector from untrusted model output —
// e.g. `@import url(https://evil/x.css)` or `background:url(https://evil/leak)`.
// This app deliberately proxies outbound requests to avoid exactly that kind of
// third-party leak, so we close it in our own gate:
//   - `@import` rules are dropped entirely.
//   - `url(...)` targets that are external — http:, https:, protocol-relative
//     `//`, or any other non-`data:` scheme — are replaced with `none`.
// INTERNAL `url(#fragment)` refs (mermaid uses `url(#arrowhead)`-style marker /
// gradient references — removing them breaks diagrams) and inline `data:` URIs
// are preserved, as is every other declaration, so the diagram stays styled.
// Operating on CSS text (a much simpler grammar than HTML, and already parsed
// out of the DOM by DOMPurify's hooks below) keeps this scoped, not a broad
// HTML regex.
function scrubCssExternalReferences(css: string): string {
	if (!css) return css;
	// Drop @import rules (both `@import "..."` and `@import url(...)` forms).
	let out = css.replace(/@import\b[^;]*;?/gi, "");
	// Neutralize external url(...) references, handling quoted and bare targets.
	out = out.replace(
		/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi,
		(match, doubleQuoted, singleQuoted, bare) => {
			const target = String(doubleQuoted ?? singleQuoted ?? bare ?? "").trim();
			if (target.startsWith("#")) return match; // internal fragment ref — keep
			if (/^data:/i.test(target)) return match; // inline data URI — keep
			return "none"; // external / networked reference — drop
		},
	);
	return out;
}

export function sanitizeHtml(
	html: string,
	options: {
		allowStyleAttributes?: boolean;
		allowStyleTags?: boolean;
		// A3 Stage 2 (mermaid): mermaid renders its diagram to an SVG string that we
		// inject with {@html}. Turning this on enables DOMPurify's curated SVG
		// profile (svg + svgFilters) IN ADDITION to the html profile, so the broad,
		// evolving set of tags mermaid emits (svg, g, path, rect, circle, text,
		// tspan, marker, defs, line, polygon, …) survives. It is an explicit,
		// maintained allowlist — NOT a wildcard — and DOMPurify still strips
		// <script>, event handlers, and javascript: URLs from inside the SVG. We
		// prefer the profile over hand-listing dozens of SVG tags because that list
		// would drift out of date with mermaid's output and is easy to under-specify.
		svg?: boolean;
	} = {},
): string {
	if (!html) return "";

	// Style is opted in on the SVG/mermaid path. Wrap the sanitize call in
	// DOMPurify hooks that scrub external references out of <style> element CSS
	// and inline `style` attribute values. Hooks are global on the instance, so
	// they are added just for this call and removed in `finally` — sanitize is
	// synchronous (single-threaded), so no other sanitize call can interleave.
	// We prefer hooks over a raw-string regex because DOMPurify parses the HTML
	// for us; our regex only ever runs on already-isolated CSS text.
	const scrubStyleCss = Boolean(
		options.allowStyleTags || options.allowStyleAttributes,
	);
	if (scrubStyleCss) {
		DOMPurify.addHook("uponSanitizeElement", (node, data) => {
			if (data.tagName !== "style") return;
			const element = node as unknown as { textContent: string | null };
			if (element.textContent) {
				element.textContent = scrubCssExternalReferences(element.textContent);
			}
		});
		DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
			if (data.attrName === "style" && data.attrValue) {
				data.attrValue = scrubCssExternalReferences(data.attrValue);
			}
		});
	}

	try {
		return DOMPurify.sanitize(html, {
			USE_PROFILES: options.svg
				? { html: true, svg: true, svgFilters: true }
				: { html: true },
			FORBID_TAGS: options.allowStyleTags ? ["script"] : ["script", "style"],
			FORBID_ATTR: options.allowStyleAttributes ? [] : ["style"],
			// A3 rich blocks: <details>/<summary> back the accordion block (raw-HTML
			// passthrough syntax). They are part of DOMPurify's default HTML profile,
			// but listing them explicitly makes the rich-block contract intentional
			// and immune to a future default-profile change. No wildcards — every
			// rich-block tag is named. DOMPurify still strips event handlers,
			// javascript: URLs, and (unless opted in) style on these tags.
			ADD_TAGS: options.allowStyleTags
				? ["style", "details", "summary"]
				: ["details", "summary"],
			ADD_ATTR: ["target", "rel"],
			ALLOW_DATA_ATTR: false,
			ALLOW_UNKNOWN_PROTOCOLS: false,
		});
	} finally {
		if (scrubStyleCss) {
			DOMPurify.removeHook("uponSanitizeElement");
			DOMPurify.removeHook("uponSanitizeAttribute");
		}
	}
}

export function escapeHtml(
	value: string,
	options: { apostropheEntity?: "&#39;" | "&#039;" } = {},
): string {
	const apostropheEntity = options.apostropheEntity ?? "&#39;";

	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", apostropheEntity);
}
