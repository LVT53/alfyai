import { render, waitFor } from "@testing-library/svelte";
import { createRawSnippet, tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import DialogShell, {
	backdropFade,
	deregisterDialog,
	isTopmostDialog,
	panelScale,
	panelSlide,
	registerDialog,
} from "./DialogShell.svelte";

function stubMatchMedia(matches: boolean) {
	vi.stubGlobal(
		"matchMedia",
		vi.fn((query: string) => ({
			matches,
			media: query,
			onchange: null,
			addListener: () => undefined,
			removeListener: () => undefined,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
			dispatchEvent: () => false,
		})),
	);
}

function childrenWith(html: string) {
	return createRawSnippet(() => ({
		render: () => html,
	}));
}

const focusableChildren = childrenWith(
	'<button type="button" data-testid="inner-action">Inner action</button>',
);

const inertChildren = childrenWith(
	'<p data-testid="inert">Nothing focusable</p>',
);

function twoButtonChildren(prefix: string) {
	// createRawSnippet requires a single root element, so wrap the two buttons.
	return childrenWith(
		`<div>` +
			`<button type="button" data-testid="${prefix}-first">First</button>` +
			`<button type="button" data-testid="${prefix}-last">Last</button>` +
			`</div>`,
	);
}

function pressEscape() {
	window.dispatchEvent(
		new KeyboardEvent("keydown", {
			key: "Escape",
			bubbles: true,
			cancelable: true,
		}),
	);
}

function pressTab(shiftKey = false) {
	window.dispatchEvent(
		new KeyboardEvent("keydown", {
			key: "Tab",
			shiftKey,
			bubbles: true,
			cancelable: true,
		}),
	);
}

describe("DialogShell focus management", () => {
	it("moves focus to the first focusable child on open", async () => {
		render(DialogShell, {
			props: {
				title: "Focusable dialog",
				onClose: vi.fn(),
				children: focusableChildren,
			},
		});

		await waitFor(() => {
			const innerButton = document.querySelector<HTMLElement>(
				'[data-testid="inner-action"]',
			);
			expect(document.activeElement).toBe(innerButton);
		});
	});

	it("falls back to the dialog container when no child is focusable", async () => {
		render(DialogShell, {
			props: {
				title: "Inert dialog",
				onClose: vi.fn(),
				children: inertChildren,
			},
		});

		await waitFor(() => {
			const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
			expect(document.activeElement).toBe(dialog);
		});
	});
});

describe("DialogShell Escape scoping", () => {
	it("closes only the topmost dialog when nested dialogs are open", async () => {
		const parentOnClose = vi.fn();
		const nestedOnClose = vi.fn();

		// Parent mounts first (registers first); the nested dialog mounts second
		// and is therefore the topmost layer — mirrors ConnectionDetailModal
		// rendering a DialogShell then a sibling ConfirmDialog.
		render(DialogShell, {
			props: {
				title: "Parent",
				onClose: parentOnClose,
				children: inertChildren,
			},
		});
		render(DialogShell, {
			props: {
				title: "Nested",
				onClose: nestedOnClose,
				children: inertChildren,
			},
		});
		await tick();

		pressEscape();

		expect(nestedOnClose).toHaveBeenCalledOnce();
		expect(parentOnClose).not.toHaveBeenCalled();
	});

	it("closes a single open dialog on Escape", async () => {
		const onClose = vi.fn();
		render(DialogShell, {
			props: { title: "Solo", onClose, children: inertChildren },
		});
		await tick();

		pressEscape();

		expect(onClose).toHaveBeenCalledOnce();
	});
});

describe("DialogShell topmost mount-order stack", () => {
	const registered: symbol[] = [];

	function track(label: string): symbol {
		const id = Symbol(label);
		registered.push(id);
		registerDialog(id);
		return id;
	}

	function drop(id: symbol) {
		deregisterDialog(id);
		const index = registered.indexOf(id);
		if (index !== -1) registered.splice(index, 1);
	}

	afterEach(() => {
		while (registered.length > 0) {
			const id = registered.pop();
			if (id) deregisterDialog(id);
		}
	});

	it("treats the last registered dialog as topmost", () => {
		const a = track("a");
		expect(isTopmostDialog(a)).toBe(true);

		const b = track("b");
		expect(isTopmostDialog(b)).toBe(true);
		expect(isTopmostDialog(a)).toBe(false);
	});

	it("restores the previous dialog as topmost after the top deregisters", () => {
		const a = track("a");
		const b = track("b");

		drop(b);

		expect(isTopmostDialog(a)).toBe(true);
		expect(isTopmostDialog(b)).toBe(false);
	});

	it("handles out-of-order deregistration without corrupting the stack", () => {
		const a = track("a");
		track("b");
		const c = track("c");

		// The middle dialog unmounts first (out of order).
		const b = registered[registered.length - 2];
		drop(b);

		expect(isTopmostDialog(c)).toBe(true);
		expect(isTopmostDialog(b)).toBe(false);

		drop(c);
		expect(isTopmostDialog(a)).toBe(true);
	});

	it("ignores deregistration of an unknown id", () => {
		const a = track("a");
		expect(() => deregisterDialog(Symbol("ghost"))).not.toThrow();
		expect(isTopmostDialog(a)).toBe(true);
	});
});

describe("DialogShell body-scroll lock", () => {
	afterEach(() => {
		// Safety net: never leak a lock into a sibling test if an assertion throws.
		document.body.style.overflow = "";
	});

	it("keeps the page locked while a parent stays open after a nested dialog closes", async () => {
		// Parent mounts first (locks the page); the nested dialog mounts second
		// while the page is already locked — mirrors ConnectionDetailModal rendering
		// a DialogShell then a sibling ConfirmDialog.
		const parent = render(DialogShell, {
			props: { title: "Parent", onClose: vi.fn(), children: inertChildren },
		});
		const nested = render(DialogShell, {
			props: { title: "Nested", onClose: vi.fn(), children: inertChildren },
		});
		await tick();

		expect(document.body.style.overflow).toBe("hidden");

		// The nested dialog closes while the parent is still open. Its onDestroy
		// must NOT unlock the page — the parent modal is still covering it.
		nested.unmount();
		await tick();
		expect(document.body.style.overflow).toBe("hidden");

		// Only once the last dialog closes is the lock released.
		parent.unmount();
		await tick();
		expect(document.body.style.overflow).toBe("");
	});
});

describe("DialogShell Tab focus trap", () => {
	const appended: HTMLElement[] = [];

	afterEach(() => {
		while (appended.length > 0) {
			appended.pop()?.remove();
		}
	});

	it("pulls stray focus outside the dialog back to the first focusable element on Tab", async () => {
		render(DialogShell, {
			props: {
				title: "Trap",
				onClose: vi.fn(),
				children: twoButtonChildren("solo"),
			},
		});

		// Wait for focus-on-open to settle so its deferred setTimeout doesn't race
		// (and undo) the stray focus we set below.
		await waitFor(() => {
			expect(document.activeElement).toBe(
				document.querySelector('[data-testid="solo-first"]'),
			);
		});

		// Simulate focus escaping the dialog (e.g. onto the trigger behind the
		// backdrop) — a sibling element outside the dialog subtree.
		const stray = document.createElement("button");
		stray.setAttribute("data-testid", "stray");
		document.body.appendChild(stray);
		appended.push(stray);
		stray.focus();
		expect(document.activeElement).toBe(stray);

		pressTab();

		// The trap yanks focus back to the dialog's first focusable element.
		expect(document.activeElement).toBe(
			document.querySelector('[data-testid="solo-first"]'),
		);
	});

	it("does not let a parent dialog hijack Tab inside a nested dialog", async () => {
		// Parent mounts first (registers first); the nested dialog mounts second
		// and is the topmost layer — mirrors a modal rendering a DialogShell plus a
		// sibling ConfirmDialog. Before the topmost gate, BOTH dialogs trapped Tab
		// and fought over focus.
		render(DialogShell, {
			props: {
				title: "Parent",
				onClose: vi.fn(),
				children: twoButtonChildren("parent"),
			},
		});
		render(DialogShell, {
			props: {
				title: "Nested",
				onClose: vi.fn(),
				children: twoButtonChildren("nested"),
			},
		});

		const nestedFirst = () =>
			document.querySelector<HTMLElement>('[data-testid="nested-first"]');
		const nestedLast = () =>
			document.querySelector<HTMLElement>('[data-testid="nested-last"]');

		// Let focus-on-open settle; the nested (topmost) dialog ends up focused.
		await waitFor(() => {
			expect(document.activeElement).toBe(nestedFirst());
		});

		const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
		const parentDialog = dialogs[0];
		const nestedDialog = dialogs[1];

		// Fires if focus ever lands on any element inside the parent dialog. Capture
		// phase catches the non-bubbling focus event from a descendant.
		const parentFocusSpy = vi.fn();
		parentDialog.addEventListener("focus", parentFocusSpy, true);

		// Focus the nested dialog's LAST element and Tab forward: it must wrap to
		// the nested dialog's FIRST element, and the parent must never grab focus.
		nestedLast()?.focus();
		expect(document.activeElement).toBe(nestedLast());

		pressTab();

		expect(parentFocusSpy).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(nestedFirst());
		expect(nestedDialog.contains(document.activeElement)).toBe(true);
	});

	it("wraps Tab past a non-rendered trailing focusable back to the first visible element", async () => {
		// The last element in the DOM is a display:none <input type="file"> — the
		// hidden upload proxy pattern (e.g. ImportChatGPTModal). It matches the
		// focusable selector but is not actually rendered, so it must NOT anchor the
		// Tab-wrap logic as the "last" element; otherwise Tab from the last VISIBLE
		// control escapes the dialog for one press.
		render(DialogShell, {
			props: {
				title: "Hidden trailing focusable",
				onClose: vi.fn(),
				children: childrenWith(
					`<div>` +
						`<button type="button" data-testid="wrap-first">First</button>` +
						`<button type="button" data-testid="wrap-last">Last</button>` +
						`<input type="file" data-testid="wrap-hidden" style="display: none" />` +
						`</div>`,
				),
			},
		});

		const first = () =>
			document.querySelector<HTMLElement>('[data-testid="wrap-first"]');
		const lastVisible = () =>
			document.querySelector<HTMLElement>('[data-testid="wrap-last"]');

		// Let focus-on-open settle on the first visible control.
		await waitFor(() => {
			expect(document.activeElement).toBe(first());
		});

		// From the last VISIBLE control, Tab forward must wrap to the first visible
		// control — the hidden input is filtered out of the focus trap.
		lastVisible()?.focus();
		expect(document.activeElement).toBe(lastVisible());

		pressTab();

		expect(document.activeElement).toBe(first());
	});
});

describe("DialogShell reduced-motion transitions", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("collapses the backdrop and panel transitions to instant under prefers-reduced-motion", () => {
		stubMatchMedia(true);

		const backdropConfig = backdropFade(document.createElement("div"), {
			duration: 150,
		});
		const panelConfig = panelScale(document.createElement("div"), {
			duration: 150,
			start: 0.95,
		});

		expect(backdropConfig).toEqual({ duration: 0 });
		expect(panelConfig).toEqual({ duration: 0 });
	});

	// The sheet is the path that actually flies 360px up the screen, and it
	// was the one transition here nothing asserted.
	it("collapses the sheet's slide to instant under prefers-reduced-motion", () => {
		stubMatchMedia(true);

		const sheetConfig = panelSlide(document.createElement("div"), {
			duration: 250,
			y: 360,
			opacity: 1,
		});

		expect(sheetConfig).toEqual({ duration: 0 });
	});

	it("keeps the sheet sliding when reduced motion is not requested", () => {
		stubMatchMedia(false);

		const sheetConfig = panelSlide(document.createElement("div"), {
			duration: 250,
			y: 360,
			opacity: 1,
		});

		expect(sheetConfig.duration).toBe(250);
		expect(typeof sheetConfig.css).toBe("function");
	});

	it("retains the full fade/scale motion when reduced motion is not requested", () => {
		stubMatchMedia(false);

		const backdropConfig = backdropFade(document.createElement("div"), {
			duration: 150,
		});
		const panelConfig = panelScale(document.createElement("div"), {
			duration: 150,
			start: 0.95,
		});

		// Real svelte/transition configs, not the reduced-motion shortcut.
		expect(backdropConfig.duration).toBe(150);
		expect(typeof backdropConfig.css).toBe("function");
		expect(panelConfig.duration).toBe(150);
		expect(typeof panelConfig.css).toBe("function");
	});
});

// ── Phone presentation (everyday redesign) ───────────────────────────
//
// Below 640px an opted-in dialog stops being a centred panel and becomes a
// bottom sheet. These cover the selection itself (which presentation a
// requested mode resolves to at a given width), the grabber that is one of
// the sheet's three dismissals, and the footer chassis that puts the negative
// button on the left and the positive one on the right.
describe("DialogShell phone presentation", () => {
	// The presentation follows the viewport width, so these drive innerWidth
	// rather than a media query — the same signal viewportTier() reads.
	function setViewportWidth(width: number) {
		vi.stubGlobal("innerWidth", width);
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("stays a centred panel on a phone when nothing opted in", () => {
		setViewportWidth(390);
		const { getByRole, queryByTestId } = render(DialogShell, {
			props: { title: "Centred", children: focusableChildren },
		});
		expect(getByRole("dialog").className).not.toContain("dialog-sheet");
		expect(queryByTestId("dialog-sheet-grabber")).toBeNull();
	});

	it("renders as a bottom sheet on a phone once opted in", () => {
		setViewportWidth(390);
		const { getByRole, getByTestId } = render(DialogShell, {
			props: {
				title: "Sheet",
				phonePresentation: "sheet",
				children: focusableChildren,
			},
		});
		const dialog = getByRole("dialog");
		expect(dialog.className).toContain("dialog-sheet");
		expect(dialog.className).not.toContain("dialog-sheet--full");
		expect(getByTestId("dialog-sheet-grabber")).toBeTruthy();
	});

	it("keeps the centred panel above the breakpoint even when a sheet is requested", () => {
		setViewportWidth(1200);
		const { getByRole, queryByTestId } = render(DialogShell, {
			props: {
				title: "Sheet",
				phonePresentation: "sheet",
				children: focusableChildren,
			},
		});
		expect(getByRole("dialog").className).not.toContain("dialog-sheet");
		expect(queryByTestId("dialog-sheet-grabber")).toBeNull();
	});

	it("marks the full-screen picker variant so its list gets the whole screen", () => {
		setViewportWidth(390);
		const { getByRole } = render(DialogShell, {
			props: {
				title: "Picker",
				phonePresentation: "fullSheet",
				children: focusableChildren,
			},
		});
		expect(getByRole("dialog").className).toContain("dialog-sheet--full");
	});

	it("closes from the grabber — the sheet's first dismissal", async () => {
		setViewportWidth(390);
		const onClose = vi.fn();
		const { getByTestId } = render(DialogShell, {
			props: {
				title: "Sheet",
				phonePresentation: "sheet",
				onClose,
				children: focusableChildren,
			},
		});
		getByTestId("dialog-sheet-grabber").click();
		await tick();
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("renders the footer below a hairline, negative first", () => {
		setViewportWidth(390);
		const { getByTestId } = render(DialogShell, {
			props: {
				title: "Sheet",
				phonePresentation: "sheet",
				children: focusableChildren,
				footer: twoButtonChildren("footer"),
			},
		});
		const footer = getByTestId("dialog-shell-footer");
		const buttons = footer.querySelectorAll("button");
		expect(buttons).toHaveLength(2);
		expect(buttons[0]).toHaveAttribute("data-testid", "footer-first");
		expect(buttons[1]).toHaveAttribute("data-testid", "footer-last");
	});

	it("omits the footer chassis entirely when no footer is given", () => {
		setViewportWidth(390);
		const { queryByTestId } = render(DialogShell, {
			props: {
				title: "Sheet",
				phonePresentation: "sheet",
				children: focusableChildren,
			},
		});
		expect(queryByTestId("dialog-shell-footer")).toBeNull();
	});
});
