import { render, waitFor } from "@testing-library/svelte";
import { createRawSnippet, tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import FocusTrapHarness from "./FocusTrapHarness.test.svelte";
import {
	createFocusTrapStack,
	focusTrap,
	getFocusableElements,
	trapTabKey,
} from "./focus-trap";

function pressTab(target: EventTarget, shiftKey = false) {
	target.dispatchEvent(
		new KeyboardEvent("keydown", {
			key: "Tab",
			shiftKey,
			bubbles: true,
			cancelable: true,
		}),
	);
}

function pressEscape(target: EventTarget) {
	target.dispatchEvent(
		new KeyboardEvent("keydown", {
			key: "Escape",
			bubbles: true,
			cancelable: true,
		}),
	);
}

function twoButtons(): {
	container: HTMLElement;
	first: HTMLElement;
	last: HTMLElement;
} {
	const container = document.createElement("div");
	container.setAttribute("tabindex", "-1");
	const first = document.createElement("button");
	first.textContent = "First";
	const last = document.createElement("button");
	last.textContent = "Last";
	container.append(first, last);
	document.body.appendChild(container);
	return { container, first, last };
}

describe("getFocusableElements", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("returns focusable descendants in DOM order", () => {
		const { container, first, last } = twoButtons();
		expect(getFocusableElements(container)).toEqual([first, last]);
	});

	it("filters out a non-rendered focusable that matches the selector", () => {
		// The hidden upload-proxy pattern (e.g. ImportChatGPTModal): a
		// display:none <input type="file"> matches the selector by attribute
		// alone but must not count as a real tab stop.
		const { container, first, last } = twoButtons();
		const hidden = document.createElement("input");
		hidden.type = "file";
		hidden.style.display = "none";
		container.appendChild(hidden);

		expect(getFocusableElements(container)).toEqual([first, last]);
	});

	it("filters out visibility:hidden and [hidden] elements too", () => {
		const { container, first, last } = twoButtons();
		const visibilityHidden = document.createElement("button");
		visibilityHidden.style.visibility = "hidden";
		const hiddenAttr = document.createElement("button");
		hiddenAttr.hidden = true;
		container.append(visibilityHidden, hiddenAttr);

		expect(getFocusableElements(container)).toEqual([first, last]);
	});

	it("excludes disabled controls and tabindex=-1 elements", () => {
		const { container, first, last } = twoButtons();
		const disabled = document.createElement("button");
		disabled.disabled = true;
		const negativeTabindex = document.createElement("div");
		negativeTabindex.tabIndex = -1;
		container.append(disabled, negativeTabindex);

		expect(getFocusableElements(container)).toEqual([first, last]);
	});

	it("returns an empty array for a null or empty container", () => {
		expect(getFocusableElements(null)).toEqual([]);
		const empty = document.createElement("div");
		expect(getFocusableElements(empty)).toEqual([]);
	});

	it("honours a custom selector", () => {
		const container = document.createElement("div");
		const link = document.createElement("a");
		link.href = "#";
		const button = document.createElement("button");
		container.append(link, button);
		document.body.appendChild(container);

		expect(getFocusableElements(container, "button")).toEqual([button]);
	});
});

describe("trapTabKey", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("wraps forward from the last focusable to the first", () => {
		const { container, first, last } = twoButtons();
		last.focus();
		const event = new KeyboardEvent("keydown", {
			key: "Tab",
			cancelable: true,
		});
		trapTabKey(container, event);
		expect(document.activeElement).toBe(first);
		expect(event.defaultPrevented).toBe(true);
	});

	it("wraps backward from the first focusable to the last on Shift+Tab", () => {
		const { container, first, last } = twoButtons();
		first.focus();
		const event = new KeyboardEvent("keydown", {
			key: "Tab",
			shiftKey: true,
			cancelable: true,
		});
		trapTabKey(container, event);
		expect(document.activeElement).toBe(last);
		expect(event.defaultPrevented).toBe(true);
	});

	it("does nothing when Tab is pressed from a middle element", () => {
		const container = document.createElement("div");
		const a = document.createElement("button");
		const b = document.createElement("button");
		const c = document.createElement("button");
		container.append(a, b, c);
		document.body.appendChild(container);
		b.focus();

		const event = new KeyboardEvent("keydown", {
			key: "Tab",
			cancelable: true,
		});
		trapTabKey(container, event);

		expect(document.activeElement).toBe(b);
		expect(event.defaultPrevented).toBe(false);
	});

	it("pulls focus that is outside the container back to the first element", () => {
		const { container, first } = twoButtons();
		const stray = document.createElement("button");
		document.body.appendChild(stray);
		stray.focus();

		const event = new KeyboardEvent("keydown", {
			key: "Tab",
			cancelable: true,
		});
		trapTabKey(container, event);

		expect(document.activeElement).toBe(first);
		expect(event.defaultPrevented).toBe(true);
	});

	it("falls back to focusing the container when nothing is focusable", () => {
		const container = document.createElement("div");
		container.setAttribute("tabindex", "-1");
		document.body.appendChild(container);

		const event = new KeyboardEvent("keydown", {
			key: "Tab",
			cancelable: true,
		});
		trapTabKey(container, event);

		expect(document.activeElement).toBe(container);
		expect(event.defaultPrevented).toBe(true);
	});

	it("wraps past a non-rendered trailing focusable back to the first visible element", () => {
		const { container, first, last } = twoButtons();
		const hidden = document.createElement("input");
		hidden.type = "file";
		hidden.style.display = "none";
		container.appendChild(hidden);

		last.focus();
		const event = new KeyboardEvent("keydown", {
			key: "Tab",
			cancelable: true,
		});
		trapTabKey(container, event);

		expect(document.activeElement).toBe(first);
	});
});

describe("createFocusTrapStack", () => {
	it("treats the last registered id as topmost", () => {
		const stack = createFocusTrapStack();
		const a = Symbol("a");
		const b = Symbol("b");

		stack.register(a);
		expect(stack.isTopmost(a)).toBe(true);

		stack.register(b);
		expect(stack.isTopmost(b)).toBe(true);
		expect(stack.isTopmost(a)).toBe(false);
		expect(stack.size()).toBe(2);
	});

	it("restores the previous id as topmost once the top deregisters", () => {
		const stack = createFocusTrapStack();
		const a = Symbol("a");
		const b = Symbol("b");
		stack.register(a);
		stack.register(b);

		stack.deregister(b);

		expect(stack.isTopmost(a)).toBe(true);
		expect(stack.size()).toBe(1);
	});

	it("handles out-of-order deregistration without corrupting the stack", () => {
		const stack = createFocusTrapStack();
		const a = Symbol("a");
		const b = Symbol("b");
		const c = Symbol("c");
		stack.register(a);
		stack.register(b);
		stack.register(c);

		stack.deregister(b);

		expect(stack.isTopmost(c)).toBe(true);
		stack.deregister(c);
		expect(stack.isTopmost(a)).toBe(true);
		expect(stack.size()).toBe(1);
	});

	it("ignores deregistration of an unknown id", () => {
		const stack = createFocusTrapStack();
		const a = Symbol("a");
		stack.register(a);
		expect(() => stack.deregister(Symbol("ghost"))).not.toThrow();
		expect(stack.isTopmost(a)).toBe(true);
		expect(stack.size()).toBe(1);
	});

	it("reports isTopmost false and size 0 for an empty stack", () => {
		const stack = createFocusTrapStack();
		expect(stack.isTopmost(Symbol("anything"))).toBe(false);
		expect(stack.size()).toBe(0);
	});
});

describe("focusTrap (attachment, called directly)", () => {
	afterEach(() => {
		document.body.innerHTML = "";
		vi.useRealTimers();
	});

	it("installs a Tab trap that wraps within the node", () => {
		const { container, first, last } = twoButtons();
		const cleanup = focusTrap()(container);

		last.focus();
		pressTab(window);
		expect(document.activeElement).toBe(first);

		cleanup?.();
	});

	it("removes its keydown listener on cleanup", () => {
		const { container, last } = twoButtons();
		const cleanup = focusTrap()(container);
		cleanup?.();

		last.focus();
		pressTab(window);
		// No trap installed any more: the browser's native Tab handling is not
		// simulated by jsdom, so focus simply stays where it was.
		expect(document.activeElement).toBe(last);
	});

	it("calls onEscape for an Escape keydown", () => {
		const { container } = twoButtons();
		const onEscape = vi.fn();
		const cleanup = focusTrap({ onEscape })(container);

		pressEscape(window);

		expect(onEscape).toHaveBeenCalledOnce();
		cleanup?.();
	});

	it("gates both Tab and Escape behind isTopmost when provided", () => {
		const { container, last } = twoButtons();
		const onEscape = vi.fn();
		let topmost = false;
		const cleanup = focusTrap({
			onEscape,
			isTopmost: () => topmost,
		})(container);

		last.focus();
		pressTab(window);
		pressEscape(window);
		expect(document.activeElement).toBe(last);
		expect(onEscape).not.toHaveBeenCalled();

		topmost = true;
		pressEscape(window);
		expect(onEscape).toHaveBeenCalledOnce();

		cleanup?.();
	});

	it("focuses the explicit target once, deferred by default", async () => {
		const { container } = twoButtons();
		const target = document.createElement("button");
		container.appendChild(target);

		const cleanup = focusTrap({ focus: { target: () => target } })(container);

		// Deferred: not yet focused synchronously.
		expect(document.activeElement).not.toBe(target);
		await waitFor(() => expect(document.activeElement).toBe(target));
		cleanup?.();
	});

	it("focuses synchronously when defer is false", () => {
		const { container } = twoButtons();
		const target = document.createElement("button");
		container.appendChild(target);

		const cleanup = focusTrap({
			focus: { target: () => target, defer: false },
		})(container);

		expect(document.activeElement).toBe(target);
		cleanup?.();
	});

	it("falls back to the first focusable element when no target is given", async () => {
		const { container, first } = twoButtons();
		const cleanup = focusTrap({ focus: {} })(container);
		await waitFor(() => expect(document.activeElement).toBe(first));
		cleanup?.();
	});

	it("falls back to the container when nothing is focusable", async () => {
		const container = document.createElement("div");
		container.setAttribute("tabindex", "-1");
		document.body.appendChild(container);

		const cleanup = focusTrap({ focus: {} })(container);
		await waitFor(() => expect(document.activeElement).toBe(container));
		cleanup?.();
	});

	it("skips moving focus when it already landed inside and skipIfAlreadyInside is set", async () => {
		const { container, first, last } = twoButtons();
		const cleanup = focusTrap({
			focus: { target: () => first, skipIfAlreadyInside: true },
		})(container);

		// Something inside the container (e.g. a child's own effect) claims
		// focus before the deferred callback runs.
		last.focus();

		await tick();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(document.activeElement).toBe(last);
		cleanup?.();
	});

	it("restores the previously focused element on cleanup when asked", () => {
		const outside = document.createElement("button");
		document.body.appendChild(outside);
		outside.focus();

		const { container, first } = twoButtons();
		const cleanup = focusTrap({ restoreFocusOnCleanup: true })(container);
		first.focus();

		cleanup?.();
		expect(document.activeElement).toBe(outside);
	});

	it("does not touch focus on cleanup when restoreFocusOnCleanup is not set", () => {
		const outside = document.createElement("button");
		document.body.appendChild(outside);
		outside.focus();

		const { container, first } = twoButtons();
		const cleanup = focusTrap()(container);
		first.focus();

		cleanup?.();
		expect(document.activeElement).toBe(first);
	});
});

describe("focusTrap (rendered through {@attach})", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	const twoButtonChildren = createRawSnippet(() => ({
		render: () =>
			`<div><button type="button" data-testid="harness-first">First</button><button type="button" data-testid="harness-last">Last</button></div>`,
	}));

	it("installs the trap on mount and tears it down on unmount", async () => {
		const outside = document.createElement("button");
		document.body.appendChild(outside);
		outside.focus();

		const onEscape = vi.fn();
		const { unmount } = render(FocusTrapHarness, {
			props: {
				options: { onEscape, focus: {}, restoreFocusOnCleanup: true },
				children: twoButtonChildren,
			},
		});

		const first = () =>
			document.querySelector<HTMLElement>('[data-testid="harness-first"]');
		const last = () =>
			document.querySelector<HTMLElement>('[data-testid="harness-last"]');

		await waitFor(() => expect(document.activeElement).toBe(first()));

		last()?.focus();
		pressTab(window);
		expect(document.activeElement).toBe(first());

		pressEscape(window);
		expect(onEscape).toHaveBeenCalledOnce();

		unmount();
		await tick();
		expect(document.activeElement).toBe(outside);
	});

	it("stops reacting to Tab/Escape once its container unmounts", async () => {
		const onEscape = vi.fn();
		const { rerender } = render(FocusTrapHarness, {
			props: {
				options: { onEscape },
				show: true,
				children: twoButtonChildren,
			},
		});
		await tick();

		await rerender({
			options: { onEscape },
			show: false,
			children: twoButtonChildren,
		});
		await tick();

		pressEscape(window);
		expect(onEscape).not.toHaveBeenCalled();
	});
});
