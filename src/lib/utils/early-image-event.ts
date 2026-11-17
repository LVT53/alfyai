/**
 * An element the server drew can finish loading, or fail, before the page's code
 * runs. Svelte remembers that event with an inline `onload="this.__e=event"` (or
 * `onerror`) attribute and replays it when the page wakes up, but the policy the
 * boxes enforce (CSP_MODE=enforce: a nonce for scripts, no inline handlers) refuses
 * the attribute, so the event is never heard. A picture that failed kept the
 * broken-picture glyph where its fallback belongs: an avatar's initial, a model's
 * initial, a hidden favicon or thumbnail. Dev and the e2e servers only report the
 * policy, so it never showed there.
 *
 * Put on such an `<img>` (`use:replayEarlyImageEvent`), this hands it the event it
 * missed when its element appears, as Svelte's replay would: `load` for a picture
 * the browser holds, `error` for one that came back broken, dispatched on the
 * element so that its own handler hears it with `currentTarget` set. A picture still
 * on its way is left alone: its own events will come.
 *
 * The real event can still come as well (Svelte's replay where the policy is only
 * reported, or the browser's own for a picture it made from its cache), so a handler
 * on such an element must not mind hearing the same outcome twice: set a flag, hide
 * the picture. `tests/integration/server-drawn-image-events.test.ts` holds that
 * every element the server can draw and that waits for its load or error carries it.
 */
export function replayEarlyImageEvent(
	img: HTMLImageElement,
): { destroy(): void } | undefined {
	if (!img.complete) return;
	const address = img.currentSrc || img.src;
	let live = true;
	const tell = (type: "load" | "error") => {
		if (!live || !img.isConnected) return;
		// A picture given another address since has events of its own.
		if ((img.currentSrc || img.src) !== address) return;
		img.dispatchEvent(new Event(type));
	};
	if (img.naturalWidth > 0) {
		queueMicrotask(() => tell("load"));
	} else if (typeof img.decode === "function") {
		// No natural width: broken, or an SVG with no size of its own (a model's icon
		// and a favicon can be one). Decoding tells them apart.
		img.decode().then(
			() => tell("load"),
			() => tell("error"),
		);
	} else {
		queueMicrotask(() => tell("error"));
	}
	return {
		destroy() {
			live = false;
		},
	};
}
