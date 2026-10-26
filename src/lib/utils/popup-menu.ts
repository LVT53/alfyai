/**
 * Shared popup menu utilities.
 *
 * Provides portal, positioning, and background helpers for dropdown menus
 * in Header, ProjectItem, and ConversationItem components.
 */

/**
 * Svelte action that portals an element to document.body.
 * Use: `<div use:portal>` — the element is moved to body and cleaned up on destroy.
 */
export function portal(node: HTMLElement): { destroy: () => void } {
	document.body.appendChild(node);
	return {
		destroy() {
			if (node.parentNode) {
				node.parentNode.removeChild(node);
			}
		},
	};
}

/**
 * Sets the menu background color based on the current dark/light mode.
 * Call this before calculating position to ensure the correct background is applied.
 */
export function setMenuBaseBackground(): string {
	if (typeof document === "undefined") return "";
	const isDark = document.documentElement.classList.contains("dark");
	return isDark ? "rgb(33 35 38 / 1)" : "rgb(241 239 235 / 1)";
}

// A menu that opens above its trigger scrolls instead of growing past this
// when there is hardly any room above.
const MIN_MENU_HEIGHT_ABOVE = 96;

/**
 * Updates menu position relative to a trigger element.
 *
 * @param triggerRef - The trigger button element
 * @param setPositionStyle - Callback to set the menu position CSS string
 * @param menuWidth - Width of the menu in pixels (default: 190)
 * @param verticalOffset - Gap between the trigger and the menu (default: 8)
 * @param placement - `"below"` (default) hangs the menu under the trigger. `"above"`
 *   anchors it by its bottom edge, so a short menu hugs the trigger, and caps
 *   its height at the room above the trigger (it scrolls inside that).
 */
export function updateMenuPosition(
	triggerRef: HTMLElement | null,
	setPositionStyle: (style: string) => void,
	menuWidth = 190,
	verticalOffset = 8,
	placement: "below" | "above" = "below",
): void {
	if (!triggerRef) return;
	const _background = setMenuBaseBackground();
	const rect = triggerRef.getBoundingClientRect();
	const viewportPadding = 12;
	const left = Math.min(
		window.innerWidth - menuWidth - viewportPadding,
		Math.max(viewportPadding, rect.right - menuWidth),
	);
	if (placement === "above") {
		const bottom = window.innerHeight - rect.top + verticalOffset;
		const maxHeight = Math.max(
			MIN_MENU_HEIGHT_ABOVE,
			rect.top - verticalOffset - viewportPadding,
		);
		setPositionStyle(
			`position: fixed; bottom: ${bottom}px; left: ${left}px; width: ${menuWidth}px; max-height: ${maxHeight}px;`,
		);
		return;
	}
	const top = Math.min(
		window.innerHeight - viewportPadding,
		rect.bottom + verticalOffset,
	);
	setPositionStyle(
		`position: fixed; top: ${top}px; left: ${left}px; width: ${menuWidth}px;`,
	);
}

/**
 * Sets up resize and scroll listeners that call updatePosition when the menu is open.
 * Call in onMount, return the cleanup function.
 */
export function setupMenuSync(
	isMenuOpen: () => boolean,
	updatePosition: () => void,
): () => void {
	const sync = () => {
		if (isMenuOpen()) updatePosition();
	};
	window.addEventListener("resize", sync);
	window.addEventListener("scroll", sync, true);
	return () => {
		window.removeEventListener("resize", sync);
		window.removeEventListener("scroll", sync, true);
	};
}
