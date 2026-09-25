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

/**
 * Splices the bootstrap immediately after `<head>` — before any
 * model-authored `<script>`, since the model's own scripts appear later in
 * the document by construction. A document with no `<head>` gets it
 * prepended to `<body>` instead; a document with neither gets it prepended
 * outright. Pure string work: this function never parses or executes the
 * artifact's HTML, and it never reads anything OUT of `html` to build the
 * bootstrap itself.
 */
export function injectAppBootstrap(html: string): string {
	const headMatch = /<head[^>]*>/i.exec(html);
	if (headMatch) {
		const insertAt = headMatch.index + headMatch[0].length;
		return html.slice(0, insertAt) + APP_BOOTSTRAP_TAG + html.slice(insertAt);
	}
	const bodyMatch = /<body[^>]*>/i.exec(html);
	if (bodyMatch) {
		const insertAt = bodyMatch.index + bodyMatch[0].length;
		return html.slice(0, insertAt) + APP_BOOTSTRAP_TAG + html.slice(insertAt);
	}
	return APP_BOOTSTRAP_TAG + html;
}
