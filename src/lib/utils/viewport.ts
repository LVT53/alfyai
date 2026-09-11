/**
 * Phone-viewport detection, in one place.
 *
 * The redesign gives phones their own presentation for anything that would
 * otherwise be a centred dialog or an anchored popover: below 640px a dialog
 * becomes a bottom sheet and a menu becomes a sheet without a footer. CSS can
 * carry the layout, but the *transition* has to change too — a panel that
 * scales into the middle of the screen and a sheet that slides up from the
 * bottom edge are different animations, and Svelte transitions are chosen in
 * JavaScript. So the breakpoint has to exist on both sides, and it is stated
 * once here rather than being retyped next to every `matchMedia` call.
 */

/** The one breakpoint. Matches the `640px` the sheet CSS uses. */
export const PHONE_MAX_WIDTH_PX = 639;

export const PHONE_MEDIA_QUERY = `(max-width: ${PHONE_MAX_WIDTH_PX}px)`;

/**
 * True when the viewport is phone-sized. SSR-safe, and safe in jsdom (which
 * has no `matchMedia` unless a test installs one) — both answer "no", so
 * server-rendered markup and unit tests get the desktop presentation unless a
 * test deliberately asks for the phone one.
 */
export function isPhoneViewport(): boolean {
	return (
		typeof window !== "undefined" &&
		typeof window.matchMedia === "function" &&
		window.matchMedia(PHONE_MEDIA_QUERY).matches
	);
}

/**
 * Calls `onChange` whenever the viewport crosses the phone breakpoint, and
 * returns a teardown. Used by components that must re-pick a transition (or a
 * whole presentation) when the window is resized mid-session — a rotation, or
 * a desktop window dragged narrow.
 *
 * Returns a no-op teardown where `matchMedia` is unavailable rather than
 * throwing, so callers can register unconditionally in `onMount`.
 */
export function watchPhoneViewport(
	onChange: (isPhone: boolean) => void,
): () => void {
	if (
		typeof window === "undefined" ||
		typeof window.matchMedia !== "function"
	) {
		return () => {};
	}
	const query = window.matchMedia(PHONE_MEDIA_QUERY);
	const handler = (event: MediaQueryListEvent) => onChange(event.matches);
	// addEventListener is the modern API; Safari < 14 only has addListener.
	if (typeof query.addEventListener === "function") {
		query.addEventListener("change", handler);
		return () => query.removeEventListener("change", handler);
	}
	if (typeof query.addListener === "function") {
		query.addListener(handler);
		return () => query.removeListener(handler);
	}
	return () => {};
}

/**
 * Which presentation a dialog should use right now.
 *
 * `requested` is what the owning surface asked for; the viewport decides
 * whether it actually applies. Kept pure (the viewport width is passed in) so
 * the selection is unit-testable without a DOM — the component calls it with
 * `isPhoneViewport()`.
 */
export type DialogPresentation = "centered" | "sheet" | "fullSheet";

export function resolveDialogPresentation(
	requested: DialogPresentation,
	isPhone: boolean,
): DialogPresentation {
	// The sheet presentations are a phone treatment only: on a wide screen a
	// bottom sheet is a panel stuck to the bottom edge of a 1440px window,
	// which is worse than the centred dialog it replaced.
	if (!isPhone) return "centered";
	return requested;
}
