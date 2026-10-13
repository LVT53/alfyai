// The App's one privileged capability, and the browser-side half of its WebRTC
// guard, injected server-side (Feature 2 · Artifacts, Slice 2; ADR-0068). The
// served routes (`+server.ts`) put this constant at the very start of the
// artifact's stored HTML — never built from the artifact's own content, no
// interpolation, no template — so it runs BEFORE any of the app's own code and
// the app can never see it built from anything it could have influenced.
//
// It does three things and nothing else:
//
//   1. It takes away what leaves the browser without a request the CSP can
//      see. Chromium's CSP does not govern WebRTC, so an App that builds a peer
//      connection can send what it holds to a STUN or TURN server of its
//      choosing the moment ICE gathering starts (no click, nothing a policy
//      asks about). `RTCPeerConnection`, its prefixed names and `RTCDataChannel`
//      become `undefined`, and cannot be written, redefined or deleted.
//      `XSLTProcessor` goes with them: it is the one DOM API that builds
//      elements and attributes, a frame with a script in it among them, with no
//      string passing through a sink. So does `documentPictureInPicture`.
//   2. It keeps a frame the app makes ITSELF from existing, because a frame has
//      globals of its own (a fresh `RTCPeerConnection`) and runs the script it
//      is given: the document is served with Trusted Types required for
//      scripts, and this installs the default policy, which refuses every
//      string that would make a frame (`nested-frames.ts` says why this, and why
//      the CSP's own `webrtc 'block'` is not used: Chromium 147 ignores it).
//   3. It turns `window.alfy.storage.get/set` into a `postMessage` call to the
//      parent, and listens for the parent's reply to resolve or reject that
//      call's promise.
//
// `postMessage(..., "*")` is deliberate and safe here — the frame this script
// runs in is opaque-origin (`<iframe sandbox="allow-scripts allow-forms">`,
// ruling 58; still no `allow-same-origin`), so it HAS no origin to name as
// the target, and the parent is where every trust decision is made
// (AppFrame.svelte's message listener).
import {
	NESTED_FRAME_TAG_BEGUN_SOURCE,
	NESTED_FRAME_TAG_SOURCE,
} from "./nested-frames";

/**
 * What the app's window loses. The first four are WebRTC (the prefixed names
 * are what older code and older engines use); `XSLTProcessor` is the way round
 * the frame policy below; `documentPictureInPicture` is the one other way a
 * script gets a window of its own (a click opens a document whose constructors
 * are the browser's own). Chromium refuses it from a frame, so it is closed
 * there, and this closes it where the App is opened on its own too. Each is made
 * `undefined` even where the browser has no such name, so that nothing can
 * define it later.
 */
export const APP_REMOVED_GLOBALS = [
	"RTCPeerConnection",
	"webkitRTCPeerConnection",
	"mozRTCPeerConnection",
	"RTCDataChannel",
	"XSLTProcessor",
	"documentPictureInPicture",
] as const;

function buildBootstrapScript(setSource: string): string {
	return `(function () {
  var removed = ${JSON.stringify(APP_REMOVED_GLOBALS)};
  for (var i = 0; i < removed.length; i += 1) {
    try {
      Object.defineProperty(window, removed[i], { value: undefined, writable: false, configurable: false, enumerable: false });
    } catch (e) {
      try { window[removed[i]] = undefined; } catch (e2) {}
    }
  }
  try {
    var tt = window.trustedTypes;
    if (tt && typeof tt.createPolicy === "function") {
      var frameTag = new RegExp(${JSON.stringify(NESTED_FRAME_TAG_SOURCE)}, "i");
      var frameTagBegun = new RegExp(${JSON.stringify(NESTED_FRAME_TAG_BEGUN_SOURCE)}, "i");
      tt.createPolicy("default", {
        createHTML: function (html, type, sink) {
          if (sink === "HTMLIFrameElement srcdoc") throw new TypeError("An app cannot put a document in a frame.");
          if (frameTag.test(html)) throw new TypeError("An app cannot make a frame, an object or an embed.");
          if ((sink === "Document write" || sink === "Document writeln") && frameTagBegun.test(html)) throw new TypeError("An app cannot write the beginning of a frame.");
          return html;
        },
        createScript: function (script) { return script; },
        createScriptURL: function (url) { return url; }
      });
    }
  } catch (e) {}
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
    // Ruling 58 (hardening, RV-2A open question 4): unreachable today (this
    // App's own sandbox lets it open no popup and no nested frame), but the
    // listener should not depend on that alone. Every real reply comes FROM
    // the parent, so a message from anything else is never this protocol's,
    // no matter how well it forges v/kind/id.
    if (event.source !== window.parent) return;
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
        set: ${setSource}
      }
    },
    writable: false,
    configurable: false,
    enumerable: true
  });
})();`;
}

/** The writing bridge: what the App's own served document gets. */
export const APP_BOOTSTRAP_SCRIPT = buildBootstrapScript(
	`function (k, v) { return call("set", [String(k), v]); }`,
);

/**
 * The same bridge for a SAVED VERSION shown in History (ruling 76, Q7): `get`
 * still asks the parent for today's value, `set` rejects at once and sends
 * nothing, so an App written to save as it goes runs, shows its data, and
 * leaves it alone. This is the cooperative half: a document can always post a
 * raw message to its parent whatever the bridge says, so the parent that
 * answers (AppFrame, in its read-only preview mode) refuses `set` itself too.
 *
 * The refusal is a CODE, not a sentence: an App that shows the error it caught
 * shows it to a reader in whatever language they read, and this document cannot
 * know it (no parameter varies the response), so an English sentence would reach a
 * Hungarian reader as one.
 */
export const APP_READONLY_BOOTSTRAP_SCRIPT = buildBootstrapScript(
	`function () { return Promise.reject(new Error("ALFY_STORAGE_READ_ONLY")); }`,
);

const APP_BOOTSTRAP_TAG = `<script>${APP_BOOTSTRAP_SCRIPT}</script>`;
const APP_READONLY_BOOTSTRAP_TAG = `<script>${APP_READONLY_BOOTSTRAP_SCRIPT}</script>`;

/** HTML's whitespace, which a parser skips before a doctype; not everything `\s` is. */
const HTML_WHITESPACE = new Set([" ", "\t", "\n", "\f", "\r"]);

/** A doctype is a few dozen characters; one longer than this is not copied. */
const MAX_DOCTYPE_LENGTH = 1_024;

/**
 * Where the comment that opens at `start` (`<!--`) ends, by the tokenizer's own
 * rules, or null when it never does. `<!-->` and `<!--->` are whole comments, a
 * comment ends at `--` and any number of dashes followed by `>`, and `--!>`
 * ends one too. A reader that only looked for `-->` would find the end of a
 * LATER comment, and take everything between for a comment, a script included.
 * Linear: every step moves on past what it has seen.
 */
function commentEnd(html: string, start: number): number | null {
	let at = start + 4;
	if (html[at] === ">") return at + 1;
	if (html.startsWith("->", at)) return at + 2;
	for (;;) {
		const dashes = html.indexOf("--", at);
		if (dashes === -1) return null;
		let end = dashes + 2;
		while (html[end] === "-") end += 1;
		if (html[end] === ">") return end + 1;
		if (html[end] === "!" && html[end + 1] === ">") return end + 2;
		at = end;
	}
}

/**
 * The text of a leading doctype, or null when the document does not open with
 * one. Whitespace and comments may come first; anything else before a doctype
 * (a spliced <script> included) makes the parser drop it and render the app in
 * quirks mode. Walked by hand, never by a pattern: a comment matcher that can
 * extend over the next comment backtracks exponentially.
 *
 * The text runs to the first `>`, which ends a doctype token in every state the
 * tokenizer can be in, so the copy is one inert token whatever it holds.
 */
function leadingDoctype(html: string): string | null {
	let at = 0;
	for (;;) {
		while (at < html.length && HTML_WHITESPACE.has(html[at])) at += 1;
		if (!html.startsWith("<!--", at)) break;
		const end = commentEnd(html, at);
		if (end === null) return null;
		at = end;
	}
	if (html.slice(at, at + 9).toLowerCase() !== "<!doctype") return null;
	const close = html.indexOf(">", at);
	if (close === -1 || close + 1 - at > MAX_DOCTYPE_LENGTH) return null;
	return html.slice(at, close + 1);
}

/**
 * Puts the bootstrap first. First means FIRST: not after the first `<head`
 * anywhere in the text, which a `<head>` in a comment, a string or an unclosed
 * tag moves to after the app's own scripts, and not after a doctype found by
 * a reader that understands comments differently from the browser's tokenizer.
 * The bootstrap is the first thing in the text, with one exception: a copy of
 * the document's leading doctype stands in front of it (a doctype that follows a
 * script is ignored, and the app would render in quirks mode), and the
 * document's own doctype, now after a script, is ignored in its turn. The copy
 * is one doctype token to the first `>`, so it holds nothing that runs.
 *
 * Nothing the document wrote is moved, changed or removed. Pure string work,
 * linear in the document: this function never parses or executes the
 * artifact's HTML, and it never reads anything OUT of `html` into the
 * bootstrap itself.
 */
function spliceBootstrap(html: string, tag: string): string {
	return (leadingDoctype(html) ?? "") + tag + html;
}

export function injectAppBootstrap(html: string): string {
	return spliceBootstrap(html, APP_BOOTSTRAP_TAG);
}

/** `injectAppBootstrap` with the read-only bridge: a saved version shown in History. */
export function injectReadOnlyAppBootstrap(html: string): string {
	return spliceBootstrap(html, APP_READONLY_BOOTSTRAP_TAG);
}
