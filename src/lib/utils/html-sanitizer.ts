import DOMPurify from "isomorphic-dompurify";
import { decodeCssEscapes } from "./css-escapes";

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
	// A browser reads CSS with its escapes undone (`\75rl(` is `url(`), so that is the
	// text scrubbed; text with nothing in it to scrub comes back as it was written.
	const reading = css.includes("\\") ? decodeCssEscapes(css) : css;
	if (!/url\(|@import|image-set\(|src\(/i.test(reading)) return css;
	// Drop @import rules (both `@import "..."` and `@import url(...)` forms).
	let out = reading.replace(/@import\b[^;]*;?/gi, "");
	// Neutralize external url(...) references, handling quoted and bare targets.
	out = replaceCalls(out, /url\(/gi, (target) =>
		target.startsWith("#") || /^data:/i.test(target) ? null : "none",
	);
	// image-set() and src() take an address as a string, with no url() in it to catch.
	out = replaceCalls(
		out,
		/(?:-webkit-)?image-set\(|\bsrc\(\s*(?=["'])/gi,
		() => "none",
	);
	return out === reading ? css : out;
}

/**
 * Each call whose opening `head` matches, up to its first closing bracket, as
 * `decide` says: its replacement, or null to keep it. One pass over the text, so a
 * source of thousands of unclosed calls is not quadratic (the first version used a
 * lazy pattern that was). A call with no bracket to close it still counts: CSS ends
 * an open `url(` at the end of the value, and what is left would be its address.
 */
function replaceCalls(
	text: string,
	head: RegExp,
	decide: (target: string) => string | null,
): string {
	let out = "";
	let at = 0;
	for (const match of text.matchAll(head)) {
		if (match.index < at) continue;
		const open = match.index + match[0].length;
		const close = text.indexOf(")", open);
		const end = close < 0 ? text.length : close;
		const replacement = decide(
			text.slice(open, end).trim().replace(/^["']/, ""),
		);
		if (replacement === null) continue;
		out += text.slice(at, match.index) + replacement;
		at = close < 0 ? text.length : close + 1;
	}
	return out + text.slice(at);
}

/** A reference a diagram may keep: to something inside the picture, or a picture held in the attribute itself. */
function ownReference(value: string): boolean {
	const target = value.trim();
	return (
		target.startsWith("#") ||
		/^data:image\/(?:png|jpe?g|gif|webp|svg\+xml)[;,]/i.test(target)
	);
}

/**
 * Model markup kept to in-flow content (the `inert` option). A reply can have come
 * from a page the model read, so what it writes may not ask a reader for a
 * password, cover the page, or open something on its own.
 *
 * Elements that take input or draw above the page are dropped (their words stay).
 * `input` is the one control with a use in a reply: GFM's disabled task-list
 * checkbox, which is kept with the three attributes it is made of and nothing else.
 */
const INERT_FORBIDDEN_TAGS = [
	"form",
	"button",
	"select",
	"optgroup",
	"option",
	"datalist",
	"textarea",
	"dialog",
];

/** Attributes that open or focus something without a click. */
const INERT_FORBIDDEN_ATTRIBUTES = new Set([
	"popover",
	"popovertarget",
	"popovertargetaction",
	"autofocus",
]);

const TASK_CHECKBOX_ATTRIBUTES = new Set(["type", "checked", "disabled"]);

function isTaskCheckbox(node: Node): boolean {
	const element = node as Element;
	return (
		element.getAttribute?.("type")?.trim().toLowerCase() === "checkbox" &&
		element.hasAttribute("disabled")
	);
}

// What a colour can be in the CSS the renderer and Shiki write: a hex value, a
// keyword, or rgb()/hsl() with plain numbers.
const CSS_COLOR =
	/^(?:#[0-9a-f]{3,8}|[a-z]{3,20}|(?:rgb|hsl)a?\([\d\s.,%]+\))$/i;

// The CSS properties our markup carries in a `style` attribute, with the values each
// may take. Shiki writes a token's colour, background colour, font style and weight
// and text decoration, and nothing else (`getTokenStyleObject`, the one place its
// inline styles are made); the renderer's own markup writes no style at all.
// Anything that places or sizes a box (position, inset, z-index, transform, display,
// width, viewport units) is not here, so a style cannot make an overlay. A Map, not
// an object: a property named `constructor` must find nothing.
const INERT_STYLE_PROPERTIES = new Map<string, RegExp>([
	["color", CSS_COLOR],
	["background-color", CSS_COLOR],
	["font-style", /^(?:normal|italic|oblique)$/i],
	["font-weight", /^(?:normal|bold|bolder|lighter|[1-9]00)$/i],
	[
		"text-decoration",
		/^(?:none|(?:underline|line-through|overline)(?:\s+(?:underline|line-through|overline))*)$/i,
	],
]);

// The characters those values are written with. A browser reads CSS with its escapes
// undone (`pos\69tion` is `position`) and with comments cut out, so a text that holds
// a backslash, a slash, a quote or a brace is one this gate cannot read the way the
// browser does, and is dropped whole.
const READABLE_STYLE_TEXT = /^[\w\s#%.,:;()-]*$/;

/**
 * The declarations of a `style` value that are on the list above, or null when none
 * is. A value that is entirely on the list comes back exactly as it was written, so
 * Shiki's own output is not rewritten.
 */
function inertStyle(value: string): string | null {
	if (!READABLE_STYLE_TEXT.test(value)) return null;
	const kept: string[] = [];
	let dropped = false;
	for (const declaration of value.split(";")) {
		const text = declaration.trim();
		if (!text) continue;
		const colon = text.indexOf(":");
		const property = colon < 0 ? "" : text.slice(0, colon).trim().toLowerCase();
		const setting = colon < 0 ? "" : text.slice(colon + 1).trim();
		if (INERT_STYLE_PROPERTIES.get(property)?.test(setting)) {
			kept.push(`${property}:${setting}`);
		} else {
			dropped = true;
		}
	}
	if (kept.length === 0) return null;
	return dropped ? kept.join(";") : value;
}

/** The class names of a `class` value that `allow` accepts, or null when none is. */
function inertClasses(
	value: string,
	allow: (name: string) => boolean,
): string | null {
	const names = value.split(/\s+/).filter(Boolean);
	const kept = names.filter(allow);
	if (kept.length === 0) return null;
	return kept.length === names.length ? value : kept.join(" ");
}

/** The attribute `inert` leaves on an element: its value, or null to drop it. */
function inertAttribute(
	tag: string,
	attribute: string,
	value: string,
	inert: InertMarkup,
): string | null {
	if (INERT_FORBIDDEN_ATTRIBUTES.has(attribute)) return null;
	if (tag === "input") {
		return TASK_CHECKBOX_ATTRIBUTES.has(attribute) ? value : null;
	}
	if (attribute === "class") return inertClasses(value, inert.allowClass);
	if (attribute === "style") return inertStyle(value);
	return value;
}

/**
 * What the browser requests the moment it parses these attributes, with no click:
 * a picture, a poster, a table's background, a list of candidates. The model can
 * write an address with private data in its path, query or host (a prompt
 * injection in a page it read), and any of these would hand it to whoever owns the
 * address. So none survives unless the caller names the exact address and tag it
 * allows (`allowResource`); a raster picture that holds its own bytes needs no
 * request and is the one thing kept without being asked. Links are not here: a
 * click is the reader's choice.
 */
const FETCHING_ATTRIBUTES = new Set(["src", "srcset", "poster", "background"]);

/** What a caller is asked about: one address in an attribute that makes the browser fetch it. */
export type ResourceRequest = {
	/** The element, lowercase. */
	tag: string;
	/** The attribute, lowercase. For `srcset` one request is made for each address in the list. */
	attribute: "src" | "srcset" | "poster" | "background";
	/** The address exactly as the markup wrote it. */
	address: string;
};

function isFetchingAttribute(
	name: string,
): name is ResourceRequest["attribute"] {
	return FETCHING_ATTRIBUTES.has(name);
}

const RASTER_DATA_URI = /^data:image\/(?:png|jpe?g|gif|webp|avif)[;,]/i;

/**
 * Whether this is a picture that holds its own bytes in a raster format. Not SVG: a
 * picture that can draw, link and style is not what a reply needs to carry inline.
 */
export function isRasterImageDataUri(value: unknown): value is string {
	return typeof value === "string" && RASTER_DATA_URI.test(value);
}

function isAsciiSpace(character: string): boolean {
	return (
		character === " " ||
		character === "\t" ||
		character === "\n" ||
		character === "\f" ||
		character === "\r"
	);
}

/**
 * The addresses of a `srcset`, the way a browser reads it (HTML's "parse a srcset
 * attribute"): an address is a run of anything but white space, so a comma inside
 * one stays in it; commas after it end it, and when none does, the descriptors that
 * follow run to the next comma outside brackets. A reader that found fewer addresses
 * than the browser requests would let one through.
 */
function srcsetAddresses(value: string): string[] {
	const addresses: string[] = [];
	let at = 0;
	while (at < value.length) {
		while (
			at < value.length &&
			(isAsciiSpace(value[at]) || value[at] === ",")
		) {
			at += 1;
		}
		if (at >= value.length) break;
		const start = at;
		while (at < value.length && !isAsciiSpace(value[at])) at += 1;
		let address = value.slice(start, at);
		if (address.endsWith(",")) {
			address = address.replace(/,+$/, "");
		} else {
			let inBrackets = false;
			while (at < value.length) {
				const character = value[at];
				at += 1;
				if (character === "(") inBrackets = true;
				else if (character === ")") inBrackets = false;
				else if (character === "," && !inBrackets) break;
			}
		}
		if (address) addresses.push(address);
	}
	return addresses;
}

/** Whether the attribute may stay: a raster picture's own bytes on an <img>, or every address in it allowed by the caller. */
function resourceAllowed(
	allow: SanitizeHtmlOptions["allowResource"],
	tag: string,
	attribute: ResourceRequest["attribute"],
	value: string,
): boolean {
	if (tag === "img" && attribute === "src" && isRasterImageDataUri(value)) {
		return true;
	}
	if (!allow) return false;
	const addresses = attribute === "srcset" ? srcsetAddresses(value) : [value];
	return (
		addresses.length > 0 &&
		addresses.every((address) => allow({ tag, attribute, address }))
	);
}

/** An element that is nothing without the address the gate took from it. */
function isEmptyFetcher(element: Element): boolean {
	const tag = element.nodeName.toLowerCase();
	if (tag === "img") return !element.hasAttribute("src");
	if (tag === "source" || tag === "track") {
		return !element.hasAttribute("src") && !element.hasAttribute("srcset");
	}
	return false;
}

type InertMarkup = {
	/** Whether a class name is one the caller's own markup writes. Every other class is dropped. */
	allowClass: (name: string) => boolean;
};

type SanitizeHtmlOptions = {
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
	// It is also the diagram's second gate (the first reads the source,
	// `shared/artifacts/mermaid-source.ts`): a diagram is a picture, so the SVG it
	// returns has no link (`<a>` is unwrapped), keeps an `href` only to something
	// inside it (`#id`) or a picture it holds (`data:image/…`), and has any CSS
	// address scrubbed from every attribute and from <style> alike, since the
	// browser asks for a paint server, a cursor or a picture as soon as it draws.
	svg?: boolean;
	// Model markdown: in-flow content only. No form or other control (except GFM's
	// disabled task-list checkbox), no dialog or popover, a `style` that names none of
	// the properties that place or size a box, and no class the caller's own markup
	// does not write (the app's global utility classes, `fixed inset-0 z-50`, are
	// then not there to borrow). `renderMarkdown` always asks for this.
	inert?: InertMarkup;
	// The addresses a caller allows the browser to fetch on its own, one request per
	// address (see `FETCHING_ATTRIBUTES`). With none, nothing is: the image is removed
	// whole, and so is a <source> or <track> left with no address. The caller answers
	// for the exact address and the tag it is on; a script address is still refused by
	// DOMPurify after it says yes.
	allowResource?: (request: ResourceRequest) => boolean;
};

export function sanitizeHtml(
	html: string,
	options: SanitizeHtmlOptions = {},
): string {
	if (!html) return "";

	// Style is opted in on the SVG/mermaid path. Wrap the sanitize call in
	// DOMPurify hooks that scrub external references out of <style> element CSS
	// and inline `style` attribute values; on the SVG path they also reach every
	// other attribute (`fill`, `filter`, `cursor`, … take a url() as well) and drop
	// an `href` that points outside the picture. The same hooks are where nothing
	// that makes the browser fetch survives unless the caller allows it
	// (`FETCHING_ATTRIBUTES`), which holds for every caller. Hooks are global on the
	// instance, so they are added just for this call and removed in `finally` —
	// sanitize is synchronous (single-threaded), so no other sanitize call can
	// interleave. We prefer hooks over a raw-string regex because DOMPurify parses the
	// HTML for us; our regex only ever runs on already-isolated CSS text.
	const scrubStyleCss = Boolean(
		options.allowStyleTags || options.allowStyleAttributes || options.svg,
	);
	const inert = options.inert;

	const onElement = (node: Node, data: { tagName: string }) => {
		if (data.tagName === "input" && inert && !isTaskCheckbox(node)) {
			node.parentNode?.removeChild(node);
			return;
		}
		if (!scrubStyleCss || data.tagName !== "style") return;
		const element = node as unknown as { textContent: string | null };
		if (element.textContent) {
			element.textContent = scrubCssExternalReferences(element.textContent);
		}
	};
	const onAttribute = (
		node: Element,
		data: { attrName: string; attrValue: string; keepAttr: boolean },
	) => {
		const tag = node.nodeName.toLowerCase();
		if (
			isFetchingAttribute(data.attrName) &&
			!resourceAllowed(
				options.allowResource,
				tag,
				data.attrName,
				data.attrValue,
			)
		) {
			data.keepAttr = false;
			return;
		}
		if (inert) {
			const kept = inertAttribute(tag, data.attrName, data.attrValue, inert);
			if (kept === null) {
				data.keepAttr = false;
				return;
			}
			data.attrValue = kept;
		}
		if (!scrubStyleCss) return;
		if (
			options.svg &&
			(data.attrName === "href" || data.attrName === "xlink:href") &&
			!ownReference(data.attrValue)
		) {
			data.keepAttr = false;
			return;
		}
		if (data.attrValue && (options.svg || data.attrName === "style")) {
			data.attrValue = scrubCssExternalReferences(data.attrValue);
		}
	};
	// After an element's attributes are judged, one left with no address is removed
	// whole: DOMPurify does not remove it, and an <img> with no src is a broken-image
	// box the reader would see in place of the picture.
	const afterAttributes = (node: Element) => {
		if (isEmptyFetcher(node)) node.parentNode?.removeChild(node);
	};
	DOMPurify.addHook("uponSanitizeElement", onElement);
	DOMPurify.addHook("uponSanitizeAttribute", onAttribute);
	DOMPurify.addHook("afterSanitizeAttributes", afterAttributes);

	try {
		return runSanitizer(html, options);
	} finally {
		DOMPurify.removeHook("uponSanitizeElement", onElement);
		DOMPurify.removeHook("uponSanitizeAttribute", onAttribute);
		DOMPurify.removeHook("afterSanitizeAttributes", afterAttributes);
	}
}

function runSanitizer(html: string, options: SanitizeHtmlOptions): string {
	return DOMPurify.sanitize(html, {
		USE_PROFILES: options.svg
			? { html: true, svg: true, svgFilters: true }
			: { html: true },
		FORBID_TAGS: [
			"script",
			...(options.allowStyleTags ? [] : ["style"]),
			...(options.svg ? ["a"] : []),
			...(options.inert ? INERT_FORBIDDEN_TAGS : []),
		],
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
