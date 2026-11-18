/**
 * Ruling 58's tripwire (RV-2A open question 2), for every frame the page loads by
 * address: an App (`AppFrame.svelte`) and a standard report's preview
 * (`DocumentPreviewRenderer.svelte`).
 *
 * No policy can stop a sandboxed frame from navigating ITSELF: no
 * `allow-top-navigation` is needed for that, only for navigating the TOP page, and
 * the page's `frame-src 'self'` still lets it go to one of this app's own pages. So
 * a hostile document could swap itself for a fake "sign in again" form drawn inside
 * the panel. The page cannot tell a load apart from the network response alone, but
 * it knows exactly which loads IT asked for: the first `src`, a reload, and a remount
 * (`{#key}`) are all one event from the DOM's point of view, a fresh iframe element
 * being inserted, so "has THIS element's first load already happened" covers all of
 * them. Any load after that first one, in the SAME browsing context, was not asked
 * for: the document navigated itself. It acts after the fact (the document already
 * ran once), but it ends a phishing flow before the fake form can be used for long.
 *
 * The page can also cause a load on an element that is not new: taking the element
 * out of the page and putting it back (a Canvas block whose wrapper a keyed list
 * moves, RV-3 I1). A browser destroys the frame's browsing context on removal and
 * makes a new one on insertion, which loads `src` again and fires `load` on the SAME
 * element, but with a NEW window, while a document that navigates itself stays in
 * the window it has (a frame's WindowProxy outlives every navigation of it, cross
 * origin too). So what arms the tripwire is the window: the first load, or the first
 * load in a window the element did not have before, is the page's own; only a
 * further load in the SAME window is uncalled for. A framed document cannot make its
 * own element leave the page and come back: it has no reach into the page.
 *
 * Use: `<iframe use:frameLoadTripwire={() => (tripped = true)} …>`, and on a trip
 * tear the element down (the runaway document ends with it) and offer a reload,
 * which mounts a new element with its own first load.
 */
export function frameLoadTripwire(
	node: HTMLIFrameElement,
	onUncalledLoad: () => void,
): { update(next: () => void): void; destroy(): void } {
	let tripped = onUncalledLoad;
	let armedWindow: Window | null = null;
	function onLoad(): void {
		const current = node.contentWindow;
		// No window: the element is not in a page, so no document of its own can be
		// the one that just loaded.
		if (!current) return;
		if (armedWindow === null || current !== armedWindow) {
			armedWindow = current;
			return;
		}
		tripped();
	}
	node.addEventListener("load", onLoad);
	return {
		update(next: () => void): void {
			tripped = next;
		},
		destroy(): void {
			node.removeEventListener("load", onLoad);
		},
	};
}
