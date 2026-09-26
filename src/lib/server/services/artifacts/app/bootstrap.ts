// The App's one privileged capability, injected server-side (Feature 2 ·
// Artifacts, Slice 2). The served route (`+server.ts`) splices this constant
// into the artifact's stored HTML immediately after `<head>` — never built
// from the artifact's own content, no interpolation, no template — so the
// app's own scripts always run AFTER the bridge exists and can never see it
// built from anything they could have influenced.
//
// The bootstrap does two things and nothing else: turns
// `window.alfy.storage.get/set` into a `postMessage` call to the parent, and
// listens for the parent's reply to resolve or reject that call's promise.
// `postMessage(..., "*")` is deliberate and safe here — the frame this script
// runs in is opaque-origin (`<iframe sandbox="allow-scripts">`, no
// `allow-same-origin`), so it HAS no origin to name as the target, and the
// parent is where every trust decision is made (AppFrame.svelte's message
// listener).
export const APP_BOOTSTRAP_SCRIPT = `(function () {
  var seq = 0, waiting = {};
  function call(method, args) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      waiting[id] = { resolve: resolve, reject: reject };
      window.parent.postMessage({ v: 1, kind: "alfy.storage", id: id, method: method, args: args }, "*");
      setTimeout(function () {
        if (waiting[id]) {
          delete waiting[id];
          reject(new Error("alfy.storage timed out"));
        }
      }, 5000);
    });
  }
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.v !== 1 || data.kind !== "alfy.storage.result") return;
    var pending = waiting[data.id];
    if (!pending) return;
    delete waiting[data.id];
    if (data.ok) {
      pending.resolve(data.value);
    } else {
      pending.reject(new Error(data.error || "alfy.storage error"));
    }
  });
  Object.defineProperty(window, "alfy", {
    value: {
      storage: {
        get: function (k) { return call("get", [String(k)]); },
        set: function (k, v) { return call("set", [String(k), v]); }
      }
    },
    writable: false,
    configurable: false,
    enumerable: true
  });
})();`;

const APP_BOOTSTRAP_TAG = `<script>${APP_BOOTSTRAP_SCRIPT}</script>`;

// The tag name must END where these match: `<header>` is not `<head>`, and
// `<head>`/`<body>` start tags are optional in HTML, so a valid document can
// carry neither. Only the tag's opening is matched here; its closing `>` is
// found with indexOf. That is what `[^>]*>` meant — the first `>` after the
// first opening — without a pattern that rescans the rest of the document
// for every opening with no `>` after it (quadratic in model-authored text,
// on every request for the App).
const HEAD_TAG_OPENING = /<head(?=[\s/>])/i;
const BODY_TAG_OPENING = /<body(?=[\s/>])/i;

/** Just past the first start tag the pattern opens, or null when there is none. */
function startTagEnd(html: string, opening: RegExp): number | null {
	const match = opening.exec(html);
	if (!match) return null;
	const close = html.indexOf(">", match.index);
	return close === -1 ? null : close + 1;
}

/**
 * Just past a leading doctype, or null when there is none. A doctype may
 * follow only whitespace and comments; anything else before it (a spliced
 * <script> included) makes the parser drop it and render the app in quirks
 * mode. Walked by hand, never by a pattern: a comment matcher that can
 * extend over the next comment backtracks exponentially.
 */
function leadingDoctypeEnd(html: string): number | null {
	let at = 0;
	for (;;) {
		while (at < html.length && /\s/.test(html[at])) at += 1;
		if (!html.startsWith("<!--", at)) break;
		const commentEnd = html.indexOf("-->", at + 4);
		if (commentEnd === -1) return null;
		at = commentEnd + 3;
	}
	if (html.slice(at, at + 9).toLowerCase() !== "<!doctype") return null;
	const close = html.indexOf(">", at);
	return close === -1 ? null : close + 1;
}

/**
 * Splices the bootstrap immediately after `<head>` — before any
 * model-authored `<script>`, since the model's own scripts appear later in
 * the document by construction. A document with no `<head>` start tag gets
 * it right after `<body>`; one with neither gets it right after its doctype,
 * or prepended outright when there is none. Pure string work, linear in the
 * document: this function never parses or executes the artifact's HTML, and
 * it never reads anything OUT of `html` to build the bootstrap itself.
 */
export function injectAppBootstrap(html: string): string {
	const insertAt =
		startTagEnd(html, HEAD_TAG_OPENING) ??
		startTagEnd(html, BODY_TAG_OPENING) ??
		leadingDoctypeEnd(html) ??
		0;
	return html.slice(0, insertAt) + APP_BOOTSTRAP_TAG + html.slice(insertAt);
}
