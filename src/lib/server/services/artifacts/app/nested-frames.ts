// A document inside the App's document: the one thing the bootstrap's WebRTC
// guard cannot reach from the outside (ADR-0068).
//
// An App's frame is opaque-origin and its CSP governs what it can fetch, but a
// frame the App makes ITSELF has a window of its own, with a fresh
// `RTCPeerConnection`, and the browser lets it run the script it was given: the
// CSP is inherited, and `frame-src` is not asked about `about:srcdoc`. So the
// App's own realm is emptied by the bootstrap and nested documents are kept from
// existing at all, in two places:
//
//   - in the browser, by the bootstrap's Trusted Types policy, which refuses
//     every string that would make a frame (`bootstrap.ts`), and
//   - on the server, here, for the markup the browser's parser makes a frame of
//     without any script running: an App whose own HTML carries one is not served
//     (`routes/api/artifacts/[id]/app`).
//
// Both read the same pattern, so they cannot drift apart.
import { foldScriptText } from "./script-text";

/** The start tags that open a document of their own (or, for `portal` and `fencedframe`, would). */
export const NESTED_FRAME_TAG_NAMES = [
	"iframe",
	"frameset",
	"frame",
	"fencedframe",
	"portal",
	"object",
	"embed",
] as const;

/**
 * The start tags, as the source of a case-insensitive regular expression: a tag
 * name that ends at whitespace, a slash, `>` or the end of the text (which is
 * how an HTML tokenizer ends it). A `<iframe` that is not followed by one of
 * those is some other tag.
 *
 * It matches inside comments, scripts and strings too, on purpose: a scan that
 * understood where a tag really was would have to be a second HTML parser, and
 * any place it disagreed with the browser's would be a way round it. A document
 * that merely mentions `<iframe>` in a string is refused as well; the cost is
 * a rewrite, the gain is that nothing is parsed twice.
 */
export const NESTED_FRAME_TAG_SOURCE = `<(?:${NESTED_FRAME_TAG_NAMES.join("|")})(?=[\\s/>]|$)`;

/**
 * The beginning of one of those tags as it can end a `document.write`: `<` and
 * every prefix of every name, up to and including the whole name, at the end of
 * the text. A parser puts the written text in front of the rest of the
 * document, so a tag begun by a write is finished by the next write, or by the
 * markup after the script; no string of its own ever holds the whole tag, and
 * the only way to refuse every way of splitting one is to refuse the beginning.
 * Generated from the names, so the two lists cannot disagree.
 */
export const NESTED_FRAME_TAG_BEGUN_SOURCE = `<(?:${[
	...new Set(
		NESTED_FRAME_TAG_NAMES.flatMap((name) =>
			Array.from({ length: name.length }, (_, i) => name.slice(0, i + 1)),
		),
	),
]
	.sort((a, b) => b.length - a.length)
	.join("|")})?$`;

const NESTED_FRAME_TAG = new RegExp(NESTED_FRAME_TAG_SOURCE, "i");

/** True when the document's own text carries a tag that makes a nested document. */
export function hasNestedFrameMarkup(html: string): boolean {
	return NESTED_FRAME_TAG.test(html);
}

const CREATES_FRAME =
	/createElement(?:NS)?\s*\([^)]{0,120}?["'`](iframe|frameset|frame|object|embed)["'`]/gi;

/**
 * The ways a SCRIPT names a frame, for the audit's second layer (the model's
 * retry message names what it found): `createElement("iframe")` and its
 * relatives, the `srcdoc` property or attribute, and `XSLTProcessor`, which
 * builds elements and attributes with no string passing through a sink. Names
 * joined, escaped or decoded are folded first. The bare word `srcdoc` is
 * flagged wherever it appears; that is the one false positive this accepts.
 */
export function nestedFrameApiUses(text: string): string[] {
	const folded = foldScriptText(text);
	const found = new Set<string>();
	for (const match of folded.matchAll(CREATES_FRAME)) {
		found.add(`createElement(${match[1].toLowerCase()})`);
	}
	if (/\bsrcdoc\b/i.test(folded)) found.add("srcdoc");
	if (/\bXSLTProcessor\b/.test(folded)) found.add("XSLTProcessor");
	return [...found];
}
