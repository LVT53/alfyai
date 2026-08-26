import { render, waitFor } from "@testing-library/svelte";
import { createRawSnippet, tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import DialogShell, {
	backdropFade,
	deregisterDialog,
	isTopmostDialog,
	panelScale,
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
