/**
 * Whether `element` has the focus and the browser shows it the way it shows
 * keyboard focus (`:focus-visible`). A mouse press leaves a button focused in
 * Chromium and Firefox without that (and in Safari does not focus it at all), so
 * this is how code that moves focus on after an action tells a person on the
 * keyboard, who needs the focus put somewhere, from one with a mouse, whose page
 * would only be scrolled to a ring nobody asked for.
 *
 * An engine that cannot evaluate the selector throws, and answers "no": moving
 * focus is the thing that scrolls, so when it is not known that the keyboard is
 * in use, it is not moved.
 */
export function isKeyboardFocused(
	element: Element | null | undefined,
): boolean {
	if (!element) return false;
	try {
		return element.matches(":focus-visible");
	} catch {
		return false;
	}
}
