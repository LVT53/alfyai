// Layout measurements a screenshot cannot make on its own: whether a control,
// or the icon inside it, is drawn wholly inside the boxes that clip it.
//
// Used by the Vivaldi smoke spec at fractional device pixel ratios, where a
// box sized in device pixels can round a fraction of a pixel short of what
// sits in it. Everything is measured in CSS pixels from bounding boxes.
import type { Page } from "@playwright/test";

export type Clipping = {
	/** What was measured: tag, test id or accessible name, enough to find it. */
	what: string;
	/** What clips it: "viewport", "control" (an icon's own button) or an ancestor. */
	by: string;
	/** How far it is drawn outside, in CSS pixels, per side. */
	overflow: { left: number; top: number; right: number; bottom: number };
};

/**
 * Every visible control (button, link, input, select, textarea, tab) under
 * `root`, and every icon inside one, that is drawn partly outside a box that
 * clips it: an ancestor with `overflow` other than `visible`, the control the
 * icon belongs to, the `root` region itself (whatever is laid out next to it
 * paints over what spills out), or the viewport. A control scrolled out of a
 * scroller's view is not clipped, nor is one a vertical scroller cuts at its
 * top or bottom; one a scroller cuts sideways is. Past a vertical scroller,
 * only the part of the control it shows is measured: the box that holds the
 * scroller (the Knowledge page's own `overflow: hidden` frame round its
 * `overflow-y: auto` column) cuts a row below the fold at the same edge, and
 * that is still scrolling, not a control drawn outside its box.
 *
 * `tolerance` absorbs float noise in the layout (CSS pixels).
 */
export async function findClippedControls(
	page: Page,
	root: string,
	tolerance = 0.05,
): Promise<Clipping[]> {
	return page.evaluate(
		({ root, tolerance }) => {
			const found: Clipping[] = [];
			const scope = document.querySelector(root);
			if (!scope) throw new Error(`no ${root} on the page`);
			const describe = (element: Element): string => {
				const id = element.getAttribute("data-testid");
				const label =
					element.getAttribute("aria-label") ??
					element.getAttribute("placeholder") ??
					element.getAttribute("title") ??
					(element.textContent ?? "").trim().slice(0, 30);
				return `${element.tagName.toLowerCase()}${id ? `[${id}]` : ""}${label ? ` "${label}"` : ""}`;
			};
			const visible = (element: Element): boolean => {
				const box = element.getBoundingClientRect();
				if (box.width === 0 || box.height === 0) return false;
				const style = getComputedStyle(element);
				return style.visibility !== "hidden" && style.display !== "none";
			};
			const outside = (inner: DOMRect, outer: DOMRect) => ({
				left: Math.max(0, outer.left - inner.left),
				top: Math.max(0, outer.top - inner.top),
				right: Math.max(0, inner.right - outer.right),
				bottom: Math.max(0, inner.bottom - outer.bottom),
			});
			const cut = (inner: DOMRect, outer: DOMRect) => {
				const sides = outside(inner, outer);
				return Object.values(sides).some((side) => side > tolerance)
					? sides
					: null;
			};
			// Wholly outside a scroller's view is scrolled away, not clipped.
			const disjoint = (a: DOMRect, b: DOMRect) =>
				a.right <= b.left ||
				a.left >= b.right ||
				a.bottom <= b.top ||
				a.top >= b.bottom;
			const viewport = new DOMRect(0, 0, innerWidth, innerHeight);

			const check = (element: Element, owner: Element | null) => {
				// What can be drawn of the element: narrowed, past each vertical
				// scroller, to the band that scroller shows.
				let box = element.getBoundingClientRect();
				const what = owner ? `icon in ${describe(owner)}` : describe(element);
				if (owner) {
					const sides = cut(box, owner.getBoundingClientRect());
					if (sides) found.push({ what, by: "control", overflow: sides });
				}
				for (
					let ancestor = element.parentElement;
					ancestor && ancestor !== document.body;
					ancestor = ancestor.parentElement
				) {
					const style = getComputedStyle(ancestor);
					const clipsX = style.overflowX !== "visible";
					const clipsY = style.overflowY !== "visible";
					if (!clipsX && !clipsY) continue;
					const frame = ancestor.getBoundingClientRect();
					// The padding box clips; borders are outside it.
					const clip = new DOMRect(
						clipsX ? frame.left + ancestor.clientLeft : -1e9,
						clipsY ? frame.top + ancestor.clientTop : -1e9,
						clipsX ? ancestor.clientWidth : 2e9,
						clipsY ? ancestor.clientHeight : 2e9,
					);
					const scrollsY = /auto|scroll/.test(style.overflowY);
					const scrollsX = /auto|scroll/.test(style.overflowX);
					if ((scrollsX || scrollsY) && disjoint(box, clip)) return;
					const sides = cut(box, clip);
					// Rows cut by a scroller's top or bottom edge are what
					// scrolling is; a scroller that hides part of a control
					// sideways is the overflow this probe exists to catch.
					if (sides && scrollsY) {
						sides.top = 0;
						sides.bottom = 0;
					}
					if (sides && Object.values(sides).some((side) => side > tolerance)) {
						found.push({ what, by: describe(ancestor), overflow: sides });
						return;
					}
					if (scrollsY) {
						const top = Math.max(box.top, clip.top);
						const bottom = Math.min(box.bottom, clip.bottom);
						box = new DOMRect(box.left, top, box.width, bottom - top);
					}
				}
				// The region itself: a control drawn past its edge is painted
				// over by the next region (the main column over the sidebar).
				const region = cut(box, scope.getBoundingClientRect());
				if (region) {
					found.push({ what, by: `region ${root}`, overflow: region });
					return;
				}
				const sides = cut(box, viewport);
				if (sides && !disjoint(box, viewport))
					found.push({ what, by: "viewport", overflow: sides });
			};

			const controls = scope.querySelectorAll(
				'button, a[href], input:not([type="hidden"]), select, textarea, [role="tab"]',
			);
			for (const control of controls) {
				if (!visible(control)) continue;
				// A file input is drawn by the label or button that opens it.
				if (control instanceof HTMLInputElement && control.type === "file")
					continue;
				check(control, null);
				for (const icon of control.querySelectorAll("svg")) {
					if (visible(icon)) check(icon, control);
				}
			}
			return found;
		},
		{ root, tolerance },
	);
}
