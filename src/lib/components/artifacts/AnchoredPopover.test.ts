import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AnchoredPopover from "./AnchoredPopover.svelte";

const children = createRawSnippet(() => ({
	render: () => `<p data-testid="popover-content">Hello</p>`,
}));

type Box = { left: number; top: number; right: number; bottom: number };

function asRect(box: Box): DOMRect {
	return {
		...box,
		x: box.left,
		y: box.top,
		width: box.right - box.left,
		height: box.bottom - box.top,
		toJSON: () => box,
	} as DOMRect;
}

/**
 * jsdom has no layout, so the trigger and the panel around it report the
 * geometry a real header would: the button inside a `.workspace-shell`.
 */
function mountTrigger(params: { button: Box; panel: Box }) {
	const shell = document.createElement("div");
	shell.className = "workspace-shell";
	shell.getBoundingClientRect = () => asRect(params.panel);
	const trigger = document.createElement("button");
	trigger.setAttribute("data-testid", "artifact-version-pill");
	trigger.textContent = "v3";
	trigger.getBoundingClientRect = () => asRect(params.button);
	trigger.getClientRects = () =>
		[asRect(params.button)] as unknown as DOMRectList;
	shell.append(trigger);
	document.body.append(shell);
	return { trigger, shell };
}

function renderPopover(onClose = vi.fn()) {
	return {
		onClose,
		...render(AnchoredPopover, {
			title: "Versions",
			anchorTestId: "artifact-version-pill",
			popoverTestId: "the-popover",
			closeLabel: "Close",
			onClose,
			children,
		}),
	};
}

describe("AnchoredPopover", () => {
	beforeEach(() => {
		window.innerWidth = 1024;
		window.innerHeight = 768;
	});

	afterEach(() => {
		cleanup();
		document.body.innerHTML = "";
	});

	it("opens under its button, left edges aligned, inside the panel", async () => {
		mountTrigger({
			button: { left: 600, top: 88, right: 644, bottom: 110 },
			panel: { left: 300, top: 0, right: 1000, bottom: 768 },
		});
		renderPopover();

		const popover = await screen.findByTestId("the-popover");
		await waitFor(() => {
			expect(popover.style.left).toBe("600px");
		});
		expect(popover.style.top).toBe("118px");
		expect(popover.style.width).toBe("340px");
	});

	it("never leaves the panel: near its right edge it shifts left, near its left edge it stays right of it", async () => {
		mountTrigger({
			button: { left: 950, top: 88, right: 994, bottom: 110 },
			panel: { left: 300, top: 0, right: 1000, bottom: 768 },
		});
		const first = renderPopover();
		const popover = await screen.findByTestId("the-popover");
		// 1000 (panel right) - 12 (margin) - 340 (width)
		await waitFor(() => expect(popover.style.left).toBe("648px"));
		first.unmount();
		document.body.innerHTML = "";

		mountTrigger({
			button: { left: 280, top: 88, right: 324, bottom: 110 },
			panel: { left: 300, top: 0, right: 1000, bottom: 768 },
		});
		renderPopover();
		const second = await screen.findByTestId("the-popover");
		// 300 (panel left) + 12 (margin): never over the chat column beside it.
		await waitFor(() => expect(second.style.left).toBe("312px"));
	});

	it("narrows to fit a panel narrower than itself", async () => {
		mountTrigger({
			button: { left: 620, top: 88, right: 664, bottom: 110 },
			panel: { left: 600, top: 0, right: 900, bottom: 768 },
		});
		renderPopover();

		const popover = await screen.findByTestId("the-popover");
		await waitFor(() => expect(popover.style.width).toBe("276px"));
		expect(popover.style.left).toBe("612px");
	});

	it("marks its button expanded while it is open, and only then", async () => {
		const { trigger } = mountTrigger({
			button: { left: 600, top: 88, right: 644, bottom: 110 },
			panel: { left: 300, top: 0, right: 1000, bottom: 768 },
		});
		expect(trigger).not.toHaveAttribute("aria-expanded");

		const { unmount } = renderPopover();
		await screen.findByTestId("the-popover");
		expect(trigger).toHaveAttribute("aria-expanded", "true");

		unmount();
		expect(trigger).not.toHaveAttribute("aria-expanded");
	});

	it("closes on Escape, and hands focus back to its button when it goes", async () => {
		const { trigger } = mountTrigger({
			button: { left: 600, top: 88, right: 644, bottom: 110 },
			panel: { left: 300, top: 0, right: 1000, bottom: 768 },
		});
		trigger.focus();
		const onClose = vi.fn();
		const view = renderPopover(onClose);
		const popover = await screen.findByTestId("the-popover");
		await waitFor(() =>
			expect(popover.contains(document.activeElement)).toBe(true),
		);

		await fireEvent.keyDown(window, { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);

		view.unmount();
		expect(document.activeElement).toBe(trigger);
	});

	it("traps Tab inside itself", async () => {
		mountTrigger({
			button: { left: 600, top: 88, right: 644, bottom: 110 },
			panel: { left: 300, top: 0, right: 1000, bottom: 768 },
		});
		renderPopover();
		const popover = await screen.findByTestId("the-popover");
		await waitFor(() =>
			expect(popover.contains(document.activeElement)).toBe(true),
		);

		// Only the close button is tabbable in here: Tab from it wraps to itself.
		const close = screen.getByRole("button", { name: "Close" });
		close.focus();
		await fireEvent.keyDown(close, { key: "Tab" });
		expect(document.activeElement).toBe(close);
	});

	it("closes on a press outside, but not on a press inside it or on its own button", async () => {
		const { trigger } = mountTrigger({
			button: { left: 600, top: 88, right: 644, bottom: 110 },
			panel: { left: 300, top: 0, right: 1000, bottom: 768 },
		});
		const outside = document.createElement("div");
		document.body.append(outside);
		const onClose = vi.fn();
		renderPopover(onClose);
		await screen.findByTestId("the-popover");

		await fireEvent.mouseDown(screen.getByTestId("popover-content"));
		await fireEvent.mouseDown(trigger);
		expect(onClose).not.toHaveBeenCalled();

		await fireEvent.mouseDown(outside);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("is an accessible dialog named by its title, with a labelled close button", async () => {
		mountTrigger({
			button: { left: 600, top: 88, right: 644, bottom: 110 },
			panel: { left: 300, top: 0, right: 1000, bottom: 768 },
		});
		const onClose = vi.fn();
		renderPopover(onClose);

		const dialog = await screen.findByRole("dialog", { name: "Versions" });
		expect(dialog).toHaveAttribute("aria-modal", "true");
		await fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(onClose).toHaveBeenCalled();
	});

	it("is a bottom sheet on a phone, not a popover", async () => {
		window.innerWidth = 390;
		mountTrigger({
			button: { left: 100, top: 88, right: 144, bottom: 110 },
			panel: { left: 0, top: 0, right: 390, bottom: 844 },
		});
		renderPopover();

		expect(await screen.findByTestId("popover-content")).toBeInTheDocument();
		expect(screen.queryByTestId("the-popover")).not.toBeInTheDocument();
		expect(
			screen.getByRole("dialog", { name: "Versions" }),
		).toBeInTheDocument();
	});
});
