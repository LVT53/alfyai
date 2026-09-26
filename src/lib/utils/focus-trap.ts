import type { Attachment } from "svelte/attachments";

/**
 * The set of elements the focus trap treats as tab stops. This is the
 * selector DialogShell has always used: interactive elements, minus disabled
 * ones, minus anything explicitly pulled out of tab order with
 * `tabindex="-1"`, plus any element that opts in with a `tabindex`. Module-
 * private: every caller either uses this default or supplies its own
 * selector string, so there is nothing to import it for.
 */
const FOCUSABLE_SELECTOR =
	'a[href]:not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])';

/**
 * A focusable element counts for the trap only if it is actually rendered.
 * The selector matches by attribute alone, so a display:none focusable — e.g.
 * ImportChatGPTModal's hidden `<input type="file">` upload proxy — would be
 * counted as the "last" element the Tab-wrap keys on, letting focus escape
 * the container for one press. getClientRects() is the ideal browser signal
 * (empty for display:none / detached elements), but jsdom has no layout
 * engine and reports an empty list for *every* element, so fall back to a
 * computed-style check there: it flags display:none / visibility:hidden (and
 * the [hidden] attribute) in both real browsers and jsdom.
 *
 * Module-private: only getFocusableElements needs it directly; exercised by
 * this file's tests through that function rather than in isolation.
 */
function isRendered(el: HTMLElement): boolean {
	if (el.getClientRects().length > 0) return true;
	const style = getComputedStyle(el);
	return style.display !== "none" && style.visibility !== "hidden";
}

/** Rendered, tab-reachable descendants of `container`, in DOM order. */
export function getFocusableElements(
	container: HTMLElement | null | undefined,
	selector: string = FOCUSABLE_SELECTOR,
): HTMLElement[] {
	return Array.from(
		container?.querySelectorAll<HTMLElement>(selector) ?? [],
	).filter(isRendered);
}

export interface TrapTabKeyOptions {
	selector?: string;
}

/**
 * Implements Tab / Shift+Tab wrapping for `container`, plus the "focus is
 * outside the container -> pull it back to the first element" rule
 * DialogShell established. Call from a keydown handler once
 * `event.key === "Tab"` is known; mutates focus and calls
 * `event.preventDefault()` as needed.
 */
export function trapTabKey(
	container: HTMLElement | null | undefined,
	event: KeyboardEvent,
	options: TrapTabKeyOptions = {},
): void {
	const focusable = getFocusableElements(container, options.selector);
	if (focusable.length === 0) {
		event.preventDefault();
		container?.focus();
		return;
	}

	const first = focusable[0];
	const last = focusable[focusable.length - 1];
	const activeElement = document.activeElement;

	// Focus has escaped the container (e.g. it was on the trigger behind the
	// backdrop, or nowhere) — pull it back to the first focusable element.
	if (!(activeElement instanceof Node) || !container?.contains(activeElement)) {
		event.preventDefault();
		first.focus();
		return;
	}

	if (event.shiftKey && activeElement === first) {
		event.preventDefault();
		last.focus();
		return;
	}

	if (!event.shiftKey && activeElement === last) {
		event.preventDefault();
		first.focus();
	}
}

/**
 * A mount-order "topmost" stack. Each independently-nesting group of traps
 * shares one of these so that when several are open at once, only the
 * most-recently-registered one reacts to Tab/Escape — otherwise a parent and
 * a nested trap would both fire and fight over focus. DialogShell owns the
 * one app-wide instance (see DialogShell.svelte's module script); a trap that
 * never nests with anything else has no need for a stack at all.
 */
export interface FocusTrapStack {
	register(id: symbol): void;
	deregister(id: symbol): void;
	isTopmost(id: symbol): boolean;
	/** How many ids are currently registered. */
	size(): number;
}

export function createFocusTrapStack(): FocusTrapStack {
	const stack: symbol[] = [];
	return {
		register(id) {
			stack.push(id);
		},
		deregister(id) {
			const index = stack.indexOf(id);
			if (index !== -1) stack.splice(index, 1);
		},
		isTopmost(id) {
			return stack.length > 0 && stack[stack.length - 1] === id;
		},
		size() {
			return stack.length;
		},
	};
}

export interface FocusTrapFocusOptions {
	/**
	 * Resolves the element to focus once the trap installs. Falls back to the
	 * container's first focusable element, then the container itself, when
	 * this is omitted or returns nullish.
	 */
	target?: () => HTMLElement | null | undefined;
	/**
	 * Defer moving focus to a `setTimeout(0)` so content mounted alongside the
	 * container (e.g. a snippet's own focusable children, or a child
	 * component's own mount effect) has settled first. Default true, which
	 * matches every current call site except ConversationJumpRail's
	 * synchronous mobile-sheet focus.
	 */
	defer?: boolean;
	/**
	 * Skip moving focus if it has already landed inside the container by the
	 * time the (possibly deferred) callback runs — DialogShell's guard for a
	 * child (e.g. ConfirmDialog) that focuses its own content. Default false.
	 */
	skipIfAlreadyInside?: boolean;
}

export interface FocusTrapOptions {
	selector?: string;
	/**
	 * When provided, Tab and Escape are ignored unless this returns true — the
	 * topmost-only gate. Leave unset for a trap that should always be active
	 * while its container is mounted (every migrated trap except DialogShell
	 * today).
	 */
	isTopmost?: () => boolean;
	/** Called for an Escape keydown that passes the topmost gate. */
	onEscape?: (event: KeyboardEvent) => void;
	/** Focus management on install. Omit to leave focus untouched on mount. */
	focus?: FocusTrapFocusOptions;
	/**
	 * Restore focus to whatever was focused immediately before the trap
	 * installed, once it is removed. Only set this where the component being
	 * migrated already restores focus on close — do not add it where one
	 * deliberately does not.
	 */
	restoreFocusOnCleanup?: boolean;
	/**
	 * Overrides the default Tab/Shift+Tab handling (`trapTabKey`) for a trap
	 * whose wrap rule genuinely differs from DialogShell's. The one case
	 * today: ConversationJumpRail's mobile sheet focuses its own container
	 * (not a child) on open, so it also has to treat Shift+Tab pressed while
	 * the container itself is focused as "wrap to the last focusable
	 * element" — a state DialogShell's algorithm never has to consider,
	 * because it always prefers a focusable child over the container. Leave
	 * this unset to get the shared `trapTabKey` behavior.
	 */
	onTab?: (event: KeyboardEvent, node: HTMLElement) => void;
}

/**
 * Installs a focus trap on the attached element: Tab/Shift+Tab wrapping, an
 * optional Escape callback, optional initial focus, and optional focus
 * restore on removal — the shared shape behind DialogShell's dialog and
 * every hand-rolled trap migrated onto it. Use as
 * `<div {@attach focusTrap({...})}>`.
 */
export function focusTrap(
	options: FocusTrapOptions = {},
): Attachment<HTMLElement> {
	return (node) => {
		const previousFocus = options.restoreFocusOnCleanup
			? (document.activeElement as HTMLElement | null)
			: null;

		let focusTimer: ReturnType<typeof setTimeout> | null = null;
		if (options.focus) {
			const {
				target,
				defer = true,
				skipIfAlreadyInside = false,
			} = options.focus;
			const applyFocus = () => {
				if (skipIfAlreadyInside && node.contains(document.activeElement)) {
					return;
				}
				const resolved = target?.();
				const fallback =
					resolved ?? getFocusableElements(node, options.selector)[0] ?? node;
				fallback?.focus();
			};
			if (defer) {
				focusTimer = setTimeout(applyFocus, 0);
			} else {
				applyFocus();
			}
		}

		function onKeydown(event: KeyboardEvent) {
			if (options.isTopmost && !options.isTopmost()) return;
			if (event.key === "Escape") {
				options.onEscape?.(event);
				return;
			}
			if (event.key === "Tab") {
				if (options.onTab) {
					options.onTab(event, node);
				} else {
					trapTabKey(node, event, { selector: options.selector });
				}
			}
		}
		window.addEventListener("keydown", onKeydown);

		return () => {
			window.removeEventListener("keydown", onKeydown);
			if (focusTimer !== null) clearTimeout(focusTimer);
			if (options.restoreFocusOnCleanup) previousFocus?.focus();
		};
	};
}
